# Nyabase production data services

The default deployment uses PostgreSQL as the only authoritative database,
Redis for disposable acceleration plus addressed split-role RPC, and
VictoriaMetrics Single behind vmagent's bounded persistent queue.

## Prepare

Run these commands from `deploy/`:

```bash
cp .env.example .env
cp config.example.yaml config.yaml
chmod 0600 .env
sudo chown 10001:10001 config.yaml
sudo chmod 0400 config.yaml
```

Replace every `CHANGE_ME` value. `POSTGRES_PASSWORD` must match the password in
`DATABASE_URL`; `REDIS_PASSWORD` must match the password in `REDIS_URL`.
Percent-encode reserved URI characters in connection URLs.
The Backend runs as UID/GID `10001:10001`; a root-owned mode-0600 bind-mounted
configuration is unreadable to it. Keep the file owned by `10001:10001` with
mode 0400, or use a deployment secret mechanism that presents the file
read-only to that identity.

Validate before starting:

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

The application remains available on port `3001`. VictoriaMetrics keeps its
existing loopback-only endpoint on `127.0.0.1:8428`. PostgreSQL, Redis and
vmagent have no host-published ports.

The default `runtime.role=all` Backend starts after healthy PostgreSQL and
treats Redis as optional acceleration. Split `api` and `gateway` processes
report unready while Redis is unavailable because interactive cross-role Agent
RPC depends on it. Redis, VictoriaMetrics and vmagent retain service
healthchecks; vmagent starts independently of
VictoriaMetrics so its bounded disk queue can accept samples while the remote
store is unavailable.

Useful probes:

```bash
curl --fail http://127.0.0.1:3001/api/health/live
curl --fail http://127.0.0.1:3001/api/health/ready
curl --fail http://127.0.0.1:8428/health
docker compose --env-file .env exec vmagent \
  wget --spider --quiet http://127.0.0.1:8429/health
```

`/api/health/live` proves only that the Backend process is alive.
`/api/health/ready` also proves exact PostgreSQL schema readiness. For split
`api`/`gateway` roles it additionally proves Redis connectivity. VictoriaMetrics
failure must not make the Backend unready; metric queries degrade independently.
Readiness is held closed until role-specific WebSocket gateways are attached
and is closed again before dependency shutdown. Authenticated administrators
with `ViewMetricsAll` can query `/api/admin/metrics/runtime` for aggregate
PostgreSQL pool pressure, Redis readiness, and bounded telemetry queue health;
the response intentionally contains no SQL, keys, identities, or raw errors.

## Data ownership and failure behavior

- PostgreSQL is the sole source of truth. A PostgreSQL outage must stop new
  control mutations and task dispatch instead of falling back to Redis.
- Redis persistence is intentionally disabled. Keys are bounded and
  reconstructable; durable Agent socket ownership remains in PostgreSQL.
  Redis loss must not change authorization or task outcomes, but it makes split
  API/Gateway interactive Agent RPC unavailable until Redis recovers.
- Redis uses `noeviction`: memory pressure fails writes instead of silently
  evicting live login-limit windows. The process-local limiter remains active
  as defense in depth. Alert on `used_memory/maxmemory`, rejected commands and
  readiness before reaching the configured bound.
- vmagent stores unsent metrics in `vmagent-data`, up to
  `VMAGENT_MAX_DISK_USAGE_PER_URL`. It drops the oldest buffered metrics after
  the bound is reached.
- VictoriaMetrics data lives in `vm-data`. Its outage must not block Agent
  sessions or control-plane writes.

After Redis loss, flush, or restart, validate local login limiting and durable
task convergence through PostgreSQL polling. In split roles, readiness and
interactive RPC must fail closed during the outage and recover afterward.
During a VictoriaMetrics outage, monitor
`vm_persistentqueue_bytes_pending` on vmagent: it should grow and then decrease
after VictoriaMetrics returns. During a vmagent outage, PostgreSQL control
mutations and Agent task dispatch must remain responsive; metric ingestion is
bounded and lossy until vmagent returns.

Do not place PostgreSQL, VictoriaMetrics and vmagent data in the same host
filesystem quota. PostgreSQL needs low-latency durable storage; VictoriaMetrics
needs sustained sequential I/O; vmagent needs enough space for the chosen
outage window.

## Capacity

Start with a representative seven-day measurement rather than treating the
example limits as universal:

```text
samples_per_second =
  servers * average_active_series_per_server / collection_interval_seconds

vmagent_queue_bytes =
  measured_compressed_write_bytes_per_second * outage_window_seconds * 1.5
```

Keep at least 20% of the VictoriaMetrics filesystem free. Increase the
vmagent queue only after verifying that replay traffic will not overload
VictoriaMetrics. Prefer vertical scaling of VictoriaMetrics Single; move to a
cluster only when a single instance cannot meet measured capacity or the
metrics availability SLO requires instance-level failover.

Budget PostgreSQL connections per Backend process. Every process uses its
configured `database.poolMax` business pool, and every process serving the
Gateway role reserves up to four additional connections for Agent session
advisory locks. Keep
`sum(database.poolMax) + 4 * gateway_processes + migration/operations headroom`
below PostgreSQL `max_connections`. This extra pool is intentional: a slow
session fence must not exhaust the business transaction pool.

Compose sets CPU, memory and PID ceilings for every service. Treat the example
values as safety bounds, not reservations or sizing claims. Override them from
the measured workload and verify the rendered result before rollout:

```bash
docker compose --env-file .env config --format json > rendered-compose.json
node scripts/http-load-gate.mjs \
  http://127.0.0.1:3001/api/health/ready 1000 32
```

The load gate requires every bounded request to return the expected status and
prints p50/p95/p99/max latency. `HTTP_LOAD_REQUEST_TIMEOUT_MS` is a hard
per-request ceiling; a release latency threshold must still come from the
product SLO and stored baseline. Set `REDIS_MEMORY_LIMIT` above
`REDIS_MAXMEMORY` so allocator/client overhead cannot make the container OOM
before Redis's explicit no-eviction boundary.

## Backup and restore contract

Compose volumes are not backups. Store backups in a different failure domain.
The repository ships `deploy/postgres-ops.sh` as the fail-closed local
primitive for logical backups, physical base backups, verification, restores,
and upgrade preflight. It reads connection strings from named environment
variables so they are not copied into shell history. For production, keep
passwords out of the URL too: use a least-privilege PostgreSQL service identity
and a mode-0600 `PGPASSFILE` or equivalent secret injection. PostgreSQL client
tools necessarily receive the connection target while running, so restrict
process inspection on the operations host.

Before every release and at the chosen logical-backup interval:

```bash
umask 077
export NYABASE_PG_SOURCE_URL='postgresql://...'
backup_file="/explicit/off-host-staging/nyabase-$(date -u +%Y%m%dT%H%M%SZ).dump"
deploy/postgres-ops.sh logical-backup --output "$backup_file"
deploy/postgres-ops.sh verify-logical --input "$backup_file"
```

The command refuses to overwrite an existing target, creates a SHA-256
sidecar, and validates the custom archive with `pg_restore --list`. Transfer
both files to immutable/off-host storage only after this succeeds.

For a physical base backup suitable for PITR, the source role needs
`REPLICATION` plus an appropriate `pg_hba.conf` entry:

```bash
base_dir="/explicit/off-host-staging/base-$(date -u +%Y%m%dT%H%M%SZ)"
deploy/postgres-ops.sh base-backup --output-dir "$base_dir"
deploy/postgres-ops.sh verify-base --input-dir "$base_dir"
```

`base-backup` streams WAL and runs `pg_verifybackup` before success. A
production PITR policy must additionally archive every WAL segment
continuously to a separate failure domain. Alert on archive failure and on WAL
archive age exceeding the declared RPO. Retain at least one verified base
backup older than the RPO window. Storage-specific archive transport and
retention belong to the deployment platform; do not pretend a local Compose
volume provides either.

After configuring the platform-specific archive command/library, prove the
chain instead of checking configuration text alone:

```bash
probe_file="/explicit/change-record/pitr-probe-$(date -u +%Y%m%dT%H%M%SZ).txt"
deploy/postgres-ops.sh pitr-archive-probe \
  --output "$probe_file" \
  --timeout-seconds 60
```

The probe requires archiving to be enabled, records the current archiver
failure boundary, forces one WAL switch, and waits until `last_archived_wal`
reaches that segment on the same timeline. Ordering uses the configured WAL
segment size, including the 16 MiB log/segment wrap; a timeline change or any
new archiver failure fails closed. The proof records the target/observed WAL,
historical/final failure counts and last failed segment without the archive
command or credentials. Run it from a monitored schedule at an interval
shorter than the declared RPO.

Restore drills always use a new, explicitly named database. Never point a
drill at production:

```bash
export NYABASE_PG_TARGET_URL='postgresql://.../nyabase_restore_drill'
deploy/postgres-ops.sh restore-logical \
  --input "$backup_file" \
  --confirm-database nyabase_restore_drill
```

The restore refuses PostgreSQL maintenance databases, checks the exact
database name, and refuses every non-empty target without modifying it. There
is no in-script replace mode. Provisioning or replacing a target database is a
separate operator-owned workflow that must first verify its own backup,
database owner, encoding, locale provider/collation/ctype, tablespace,
connection limit, database ACL, comments, and `ALTER DATABASE` settings. Only
after that workflow has produced and independently confirmed an empty database
should `restore-logical` be invoked. The logical archive and this helper do not
claim to preserve database-level ACL, comments, or settings.

For physical PITR, provision a new empty cluster using the same PostgreSQL
major, verify the base backup, copy it into that stopped cluster's `PGDATA`,
configure `restore_command` for the off-host WAL archive and set the required
`recovery_target_time`, then start it isolated from application traffic.
Promote only after schema compatibility, row-count/application invariants, and
the desired recovery timestamp are verified.

Record drill evidence instead of claiming an unmeasured RPO/RTO:

```text
backup_started_at_utc=
last_archived_wal_at_utc=
restore_started_at_utc=
readiness_verified_at_utc=
measured_rpo_seconds=
measured_rto_seconds=
backup_artifact_sha256=
operator=
```

VictoriaMetrics backup must use `vmbackup` against an instant snapshot and copy
it to object storage or another host. `vmrestore` is an offline operation:
stop VictoriaMetrics, restore into its data path, start it, then allow vmagent
to replay its pending queue.

Redis has no backup. After replacement, validate cache rebuilding, shared
limiting, addressed RPC and PostgreSQL-driven worker convergence.

## Upgrades

- Pin PostgreSQL to the current PostgreSQL 18 minor after staging its release
  notes and restore test.
- Keep VictoriaMetrics and vmagent on exactly the same explicit release.
- Upgrade one data service at a time. Take and verify backups before PostgreSQL
  or VictoriaMetrics changes.
- Production and CI images are pinned as readable tags plus immutable
  `sha256` manifests. Refresh a pin only after reviewing the upstream release,
  scanning/staging that exact digest, and rerunning the full Compose smoke;
  never update a tag while retaining an unrelated old digest.
- Never lower VictoriaMetrics retention or queue disk limits without checking
  current disk use and the resulting data-loss window.

Run the read-only PostgreSQL preflight before a major upgrade:

```bash
export NYABASE_PG_SOURCE_URL='postgresql://.../nyabase'
deploy/postgres-ops.sh upgrade-preflight \
  --target-major 19 \
  --output "/explicit/change-record/pg19-preflight.txt"
```

It verifies client/server compatibility, performs a schema-only dump, and
fails on invalid indexes or prepared transactions. Then create and verify a
logical backup, restore it into a new target-major cluster, run migrations and
application readiness against the isolated target, and preserve the old
cluster unchanged as the rollback point. Switch application traffic only after
those checks. Rollback means reconnecting to the untouched old cluster before
any writes are admitted on the new cluster; after new-cluster writes begin,
restore/reconciliation is required rather than a blind version rollback.

## Measured performance gates

Do not call the deployment “optimal” without workload-specific measurements.
CI provides bounded regression gates, not a synthetic capacity claim:

- Backend tests run with at most four Vitest workers against PostgreSQL 18 and
  a real Redis 8.2 service.
- A catalog test rejects foreign keys without a valid, non-partial leading
  index.
- Heartbeat tests prove high socket-heartbeat volume is coalesced into one
  durable write per approximately 30-second window while fencing remains
  generation-bound.
- CI builds the production image and verifies its non-root `10001:10001`
  runtime identity.
- The production Compose smoke sends a fixed-concurrency readiness workload
  through the built image and rejects any timeout or non-200 response.

For release sizing, capture representative `EXPLAIN (ANALYZE, BUFFERS)` output,
pool wait time, transaction latency, WAL bytes/second, Redis command latency,
and end-to-end request percentiles at the expected concurrency. Store the raw
plans and workload description with the release record; thresholds must come
from the product SLO and measured baseline, not from this example deployment.

## Security

- Nest 10 remains on the current major during this migration. Its moderate SSE
  injection advisory is unreachable only while the Backend has no Nest `Sse`
  decorator/API, `SseStream`, or `text/event-stream` response surface.
  `scripts/check-nest-sse-advisory.sh` enforces that condition offline in local
  checks and CI, with multi-pattern bypass self-tests. Keep this gate until
  Nest is upgraded to at least 11.1.18 and the major upgrade is staged and
  verified. The remaining low esbuild advisory is limited to its Windows
  development server path and is not reachable in the Linux production image.
- Only the Backend joins both the control-plane and telemetry networks.
- The Backend image runs as the dedicated unprivileged `10001:10001` identity.
  Writable mounts and temporary files must be owned by that identity; do not
  grant root merely to fix a mount-permission error.
- Its root filesystem is read-only, every Linux capability is dropped,
  `no-new-privileges` is enabled, and `/tmp` is a bounded `noexec` tmpfs owned
  by `10001:10001`. The configuration bind mount must remain readable without
  weakening those controls.
- Never publish PostgreSQL, Redis or vmagent ports.
- Compose disables Redis's default user and grants the `nyabase` ACL user only
  the configured key/channel prefix and required command categories.
- Rotate `.env` and `config.yaml` credentials through the deployment secret
  mechanism used by the target environment; do not commit either file.
- Keep PostgreSQL TLS policy out of `DATABASE_URL`: URL-level `ssl`,
  `sslmode`, certificate and key parameters are rejected because
  `node-postgres` would otherwise let them override the fail-closed pool
  policy. Use `PG_SSL_MODE=verify-full` on routed production networks. For a
  private CA, mount its PEM bundle read-only into the Backend and set
  `PG_SSL_CA_FILE`. `PG_SSL_SERVERNAME` optionally selects the certificate
  identity checked against that CA; PostgreSQL TLS SNI remains the hostname in
  `DATABASE_URL`, so that hostname must still be accepted by the endpoint's TLS
  router. `PG_SSL_MODE=require` encrypts without authenticating the server and
  is reserved for explicitly trusted networks.
- If Redis moves across hosts, terminate TLS at Redis/its managed endpoint and
  use a `rediss://nyabase:...` URL. For a private CA, mount its PEM bundle
  read-only into the Backend and set `REDIS_TLS_CA_FILE`; set
  `REDIS_TLS_SERVERNAME` when endpoint discovery uses a name different from the
  certificate identity. Verification is always enabled; there is no insecure
  skip-verify option. Do not downgrade to plaintext on a routed network.
- The Compose Redis is single-node and is not HA. Split-role production
  deployments must use a managed HA endpoint or tested Sentinel/failover setup,
  with reconnect/readiness alarms and a failover drill. Add a VictoriaMetrics
  auth proxy only when telemetry endpoints cross a trust boundary.
