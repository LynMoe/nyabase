# Nyabase production control plane

The default deployment uses PostgreSQL as the authoritative control-plane
database, Redis for disposable acceleration and wake state, and VictoriaMetrics
Single behind vmagent's bounded persistent queue. Workloads run as Incus system
containers; Compose is only the control-plane infrastructure and smoke-test
boundary.

The Backend connects directly to each Incus server over HTTPS with mutual TLS.
Each server also exposes the read-only node-exporter metrics endpoint. The
node-exporter has no control or Incus mutation capability; durable desired state,
intents, and reconciliation claims remain in PostgreSQL.

## Prepare

Run these commands from `deploy/`:

```bash
cp .env.example .env
cp config.example.yaml config.yaml
chmod 0600 .env
sudo chown 10001:10001 config.yaml
sudo chmod 0400 config.yaml
```

Replace every `CHANGE_ME` value in `.env` (and keep matching passwords in the
YAML connection URLs). `POSTGRES_PASSWORD` must match the password in
`DATABASE_URL`; `REDIS_PASSWORD` must match the password in `REDIS_URL`.
Percent-encode reserved URI characters in connection URLs.
`config.example.yaml` does **not** use `CHANGE_ME` for boot secrets:
`auth.jwtSecret`, `ssh.keyEncryptionSecret`, `http.proxyToken`, and
`ssh.proxyToken` are empty strings. Empty values fail closed at production
boot; copy the example and fill them before `up`. See **Boot secrets, Incus
reachability, and proxies** below.
The Backend runs as UID/GID `10001:10001`; a root-owned mode-0600 bind-mounted
configuration is unreadable to it. Keep the file owned by `10001:10001` with
mode 0400, or use a deployment secret mechanism that presents the file
read-only to that identity. Production Backend boot also asserts that the
file is owned by the process uid and is not group/other-readable (mode
`0400` or `0600` with no `0o077` bits). Compose cannot chmod the host
bind-mount; set the mode on the host before `docker compose up`.

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
treats Redis as optional acceleration. Redis, VictoriaMetrics and vmagent
retain service healthchecks; vmagent starts independently of VictoriaMetrics so
its bounded disk queue can accept samples while the remote store is unavailable.

Useful probes:

```bash
curl --fail http://127.0.0.1:3001/api/health/live
curl --fail http://127.0.0.1:3001/api/health/ready
curl --fail http://127.0.0.1:8428/health
docker compose --env-file .env exec vmagent \
  wget --spider --quiet http://127.0.0.1:8429/health
```

`/api/health/live` proves only that the Backend process is alive.
`/api/health/ready` also proves exact PostgreSQL schema readiness. VictoriaMetrics
failure must not make the Backend unready; metric queries degrade independently.
Readiness is held closed until the control-plane process is accepting traffic
and is closed again before dependency shutdown. Authenticated administrators
with `ViewMetricsAll` can query `/api/admin/metrics/runtime` for aggregate
PostgreSQL pool pressure, Redis readiness, and bounded telemetry queue health;
the response intentionally contains no SQL, keys, identities, or raw errors.

## Boot secrets, Incus reachability, and proxies

### Required YAML secrets

These four fields gate production boot. They are empty in `config.example.yaml`
(not `CHANGE_ME`). Empty values fail closed. Generate four independent secrets;
do not reuse one value across fields:

```bash
openssl rand -hex 32   # auth.jwtSecret (>= 32 characters)
openssl rand -hex 32   # ssh.keyEncryptionSecret
openssl rand -hex 32   # http.proxyToken
openssl rand -hex 32   # ssh.proxyToken
```

- `auth.jwtSecret`: at least 32 characters.
- `ssh.keyEncryptionSecret`: dedicated secret; production must not fall back to
  `auth.jwtSecret`.
- `http.proxyToken` and `ssh.proxyToken`: 32–1024 character ASCII using only
  letters, digits, `_`, or `-`. `openssl rand -hex 32` is valid. The HTTP and
  SSH WebSocket handlers refuse to start with an empty token.

### Incus reachability

The Backend must inbound-reach every Incus API at `https://<host>:8443` over
mTLS. NAT'd Incus servers are unsupported unless a VPN or tunnel presents a
stable address the Backend can open. Do not use `https://127.0.0.1:8443` from a
containerized Backend unless you have proven host routing for that path.
`127.0.0.1` inside the container is the container itself. The Compose Backend
service is not host-network by default.

### SSH and HTTP proxies

SSH and HTTP proxies are independent binaries under `tools/ssh-proxy` and
`tools/http-proxy`. They are not Compose services. Prefer installing them on a
host or netns that can reach both the Backend WebSocket and the guest LAN;
do not add them to the default Compose file.

```bash
cargo build --release --locked --manifest-path tools/ssh-proxy/Cargo.toml
cargo build --release --locked --manifest-path tools/http-proxy/Cargo.toml
# binaries:
#   tools/ssh-proxy/target/release/nyabase-ssh-proxy
#   tools/http-proxy/target/release/nyabase-http-proxy
```

Listen addresses (env overrides):

- SSH: `NYABASE_SSH_LISTEN`, default `0.0.0.0:2222`
- HTTP: `NYABASE_HTTP_LISTEN`, default `0.0.0.0:8080`
- HTTPS (optional): `NYABASE_HTTPS_LISTEN` (unset means HTTPS listen is off)

`NYABASE_BACKEND_WS` must target Backend port **3001**, not 3000. The Rust
defaults of `ws://127.0.0.1:3000/ws/ssh-proxy` and
`ws://127.0.0.1:3000/ws/http-proxy` are wrong for this product:

```bash
# SSH proxy
export NYABASE_BACKEND_WS='ws://<backend-host>:3001/ws/ssh-proxy'
export SSH_PROXY_TOKEN='<same value as ssh.proxyToken>'
export NYABASE_SSH_LISTEN='0.0.0.0:2222'

# HTTP proxy
export NYABASE_BACKEND_WS='ws://<backend-host>:3001/ws/http-proxy'
export HTTP_PROXY_TOKEN='<same value as http.proxyToken>'
export NYABASE_HTTP_LISTEN='0.0.0.0:8080'
```

Product instance NICs are Incus `nictype=bridged` on an operator-owned
unmanaged Linux bridge (`vmbr0`). SSH and HTTP proxies **may run on the
Incus host** and TCP to guest `:22` / HTTP. Host IPv4 may live on `vmbr0`
or on a separate management NIC; see the two layouts below. The snapshot
field remains `routedIp`. Do not use `incus network create`.

## Operator-owned LAN bridge (`vmbr0`)

Product NICs are bridged on an **operator-owned unmanaged Linux bridge**.
nyabase never creates the bridge, enslaves `bond0`, or moves the host IP.
Preflight fail-closes and prints the missing command. Delete leftover
`nyc-*` and `nyabase-preflight-*` instances **before** starting workers on
the bridged spec (`validateEth0` will not convert leftover macvlan NICs).

Do this on console/IPMI, not over the in-band SSH address being moved. One
declarative apply. `parentInterface` in nyabase is the bridge name (`vmbr0`).

**netplan** (typical Ubuntu; `bond0` already exists as a bond):

```yaml
network:
  version: 2
  renderer: networkd
  bonds:
    bond0:
      interfaces: [eno1, eno2]
      parameters:
        mode: 802.3ad
        lacp-rate: fast
        mii-monitor-interval: 100
      dhcp4: false
      accept-ra: no
  bridges:
    vmbr0:
      interfaces: [bond0]
      addresses: [<HOST_IPV4>/<PREFIX>]
      routes:
        - to: default
          via: <GATEWAY>
      nameservers:
        addresses: [<DNS>, ...]
      parameters:
        stp: false
        forward-delay: 0
      dhcp4: false
```

Apply atomically: `netplan try` then `netplan apply`.

**systemd-networkd:** `bond0.network` with `Bridge=vmbr0` and no `Address=`;
`vmbr0.netdev` `Kind=bridge`; `vmbr0.network` holds `Address=` / `Gateway=` /
`DNS=`. `networkctl reload` (or reboot). Do not `ip addr del` on `bond0` as a
separate SSH step.

**ifupdown** (Debian/PVE style): `bond0 inet manual` with `bridge-ports` on
`vmbr0 inet static`. `ifreload -a` (ifupdown2) or a reboot.
`ifdown bond0 && ifup vmbr0` as two steps **will** drop the session.

Single-NIC: enslave `eno1` the same way; it must have no IPv4 after apply.
VLAN: `bond0.100` → `vmbr100`; set nyabase `parentInterface=vmbr100`.
Product NICs never set `vlan` / `vlan.tagged` (mutually exclusive with IP
filtering).

After apply: `ip -d link show vmbr0` is a bridge, `bridge link` shows the
uplink slave, host IPv4 is on `vmbr0`, `bond0` has none, default route is
`dev vmbr0`. `nft list table bridge incus` may be empty until a filtered
instance starts.

**Do not put the host IPv4 on `vmbr0` until all of these are true:**

1. `bridge link` shows the uplink (`eth0` / `bond0`) as `master vmbr0`.
2. `/sys/class/net/vmbr0/carrier` is `1` (`LOWER_UP`, not `NO-CARRIER`).
3. The uplink has no global IPv4.

A `NO-CARRIER` bridge with the management address is a lockout: default
route is `linkdown`, SSH dies. `netplan apply` will still do this if
systemd-networkd fails to enslave the uplink (`Failed to set master
interface: Device or resource busy`) while it happily configures
`Address=` on `vmbr0`.

Do **not** `ip link add vmbr0` and then `netplan apply`: networkd logs
`Failed to create netdev: File exists` and skips enslaving. Do **not**
copy the uplink MAC onto `vmbr0` if netplan matches the NIC by
`macaddress:` — both interfaces then match and you get `Cannot find
unique matching interface`.

`EBUSY` on `ip link set <uplink> master vmbr0` is usually one of:

- A **macvlan/macvtap child still exists**, including in another netns
  (legacy e2e `e2e-sshproxy` / `mv-sshproxy@eth0`). `ip link show type
  macvlan` in the host ns is not enough; check `ip netns exec <ns> ip
  link`. Delete leftovers before enslaving. A parent with macvlan
  children cannot join a Linux bridge.
- Some **virtio_net** NICs (observed on Debian 13 `6.12.*-cloud-amd64`
  inside a PVE VM): `br_add_if` rolls back at allmulticast even with no
  macvlan child (`entered allmulticast mode` then immediately `left`).
  Dummy devices enslave fine; macvlan on the same NIC still works. That
  NIC cannot be a guest-side `vmbr` uplink — use a NIC that can be a
  bridge port (`e1000`, a non-cloud virtio, or build `vmbr` on the
  hypervisor and pass a dedicated tap), not a nested bridge on this
  virtio.

**Dedicated container NIC** (host IP stays on the management interface):
enslave only the extra NIC (`e1000` / `eth1`) to `vmbr0` and put **no**
IPv4 on the bridge or the uplink. Host default route stays on `eth0`.
`parentInterface` is still `vmbr0`. Preflight accepts a host global IPv4
in a bound pool `cidr` on **any** host interface (typically `eth0`), not
only on the bridge. Do not move the management address onto `vmbr0` in
this layout.

```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    eth1:
      match:
        driver: e1000
      set-name: eth1
      dhcp4: false
      optional: true
  bridges:
    vmbr0:
      interfaces: [eth1]
      dhcp4: false
      optional: true
      parameters:
        stp: false
        forward-delay: 0
```

Debian **cloud** kernels often omit `e1000`. Use `linux-image-amd64` (generic)
if `modprobe e1000` says the module is missing.

If `ufw` / firewalld is active, allow in/route on `vmbr0`. nyabase does not configure host
firewall. If guest ping of the host IP fails, check ufw/firewalld **before**
rebuilding vmbr.

## Data ownership and failure behavior

- PostgreSQL is the sole source of truth. A PostgreSQL outage must stop new
  control mutations and reconciliation instead of falling back to Redis.
- Redis persistence is intentionally disabled. Keys are bounded and
  reconstructable; durable intents and reconciliation claims remain in PostgreSQL.
  Redis loss must not change authorization or intent outcomes. Disposable wake
  and acceleration state becomes unavailable until Redis recovers.
- Redis uses `noeviction`: memory pressure fails writes instead of silently
  evicting live login-limit windows. The process-local limiter remains active
  as defense in depth. Alert on `used_memory/maxmemory`, rejected commands and
  readiness before reaching the configured bound.
- vmagent stores unsent metrics in `vmagent-data`, up to
  `VMAGENT_MAX_DISK_USAGE_PER_URL`. It drops the oldest buffered metrics after
  the bound is reached.
- VictoriaMetrics data lives in `vm-data`. Its outage must not block control-plane
  writes or Incus reconciliation.

After Redis loss, flush, or restart, validate local login limiting and durable
intent convergence through PostgreSQL polling. The control plane must remain
available while disposable wake state recovers.
During a VictoriaMetrics outage, monitor
`vm_persistentqueue_bytes_pending` on vmagent: it should grow and then decrease
after VictoriaMetrics returns. During a vmagent outage, PostgreSQL control
mutations and Incus reconciliation must remain responsive; metric ingestion is
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
configured `database.poolMax` business pool. Keep the sum of those pools plus
migration and operations headroom below PostgreSQL `max_connections`.

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
separate operator-owned procedure that must first verify its own backup,
database owner, encoding, locale provider/collation/ctype, tablespace,
connection limit, database ACL, comments, and `ALTER DATABASE` settings. Only
after that procedure has produced and independently confirmed an empty database
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
- The Compose Redis is single-node and is not HA. Production deployments that
  require HA must use a managed endpoint or tested Sentinel/failover setup,
  with reconnect/readiness alarms and a failover drill. Add a VictoriaMetrics
  auth proxy only when telemetry endpoints cross a trust boundary.

## Incus 客户端证书（10 年寿命与自动轮换）

控制平面使用一张**共享**的 Incus 客户端证书，以 mTLS 调用每台 Incus。
`openssl req -x509` 签发时使用 `-days 3650`（约 10 年）。不要把这张证
书当成短期工作负载身份。

### 90 天持续告警

自 `notAfter` 剩余寿命 ≤ 90 天起，管理面**每一处**管理员布局都持续展示
告警横幅，而不是只在打开某台服务器详情时才提示。服务器详情仍显示
`notAfter`，以及暂存轮换向导状态：信任新证书 → 切换生效 → 吊销旧证书。

### 自动与手动轮换

- 自动：`runtime.role=all|worker` 约每 60 秒（带抖动）检查一次。进入 90 天窗口、没有暂存证书、也没有 pending `certificate.rotate` 意图时，以登录禁用的 `nyabase-system` 身份入队；找不到该用户则本轮跳过并记日志，不得冒充人类管理员。
- 手动：具备 `ManageCertificates` 的管理员调用
  `POST /api/admin/incus-client-certificate/rotate`（需 `expectedGeneration`）。
  当前生效证书见 `GET /api/admin/incus-client-certificate`（`ManageCertificates` 或 `ManageServers` 只读）；轮换进度见
  `GET /api/admin/incus-client-certificate/rotations/:id`。

顺序必须是：**持久化暂存证书 → 在可达服务器上信任新证书 → 切换为生效行
→ 吊销旧证书**（Incus `DELETE /1.0/certificates/{fingerprint}`）。信任行
状态包含 `pending` / `trusted` / `verified` / `revoked` / `cleanup_failed`。
Incus HTTP（信任 / 校验 / 吊销）必须在 `lockServerOnboarding` 事务之外执行，
否则会撞上 `PG_IDLE_IN_TRANSACTION_TIMEOUT_MS`（30s）。

从未上线、未知或不可达的服务器**不得**无限期阻塞整集群切换。对非在线主机
最多重试 3 次，标记 `needs_attention`，一旦**当前在线**的每台服务器都已验证候选
证书即可激活。吊销失败不回滚激活，后续调和再试，直到成功或 `cleanup_failed`。

### 控制平面被锁在外面时的恢复

在**每一台** Incus 主机上以 root 执行：

```bash
incus config trust list
incus config trust add /path/to/new-nyabase-client.crt
```

先确认新客户端证书已作为受信任的 root 客户端加入，再让控制平面用新身份
重试。不要在未把新证书加入 trust store 的情况下吊销旧指纹。

### 引导 PEM 与数据库生效行

`INCUS_CLIENT_CERT_FILE` / `INCUS_CLIENT_KEY_FILE`（以及 Compose secrets
`incus_client_cert` / `incus_client_key`）只用于**引导第 1 代**：
`DatabaseIncusClientFactory` 在库中尚无 `state=active` 行时读取这些文件，
插入 `generation=1` 的加密私钥行。第 1 代之后，运行时客户端**只**使用数据
库中的生效行；轮换不会回写引导 PEM。不要假设磁盘上的 bootstrap 文件仍与
当前客户端身份一致。

## 在每台 Incus 主机安装 node-exporter

node-exporter 是独立进程（`packages/node-exporter`），**不是** Nest
`runtime.role`。它只提供只读 HTTPS `/metrics`，没有 Incus 变更能力。仓库
单元文件为 `deploy/nyabase-node-exporter.service`（e2e 停机演练使用
`E2E_NODE_EXPORTER_UNIT`；与单元名对齐：
`E2E_NODE_EXPORTER_UNIT=nyabase-node-exporter.service`）。

### 构建与安装

```bash
pnpm --filter @nyabase/common build
pnpm --filter @nyabase/node-exporter build
sudo install -d -o nyabase-node -g nyabase-node /opt/nyabase/node-exporter
# Copy packages/node-exporter/dist and production node_modules
# (workspace package @nyabase/common must resolve).
sudo install -D -m 0644 deploy/nyabase-node-exporter.service \
  /etc/systemd/system/nyabase-node-exporter.service
```

进程用户使用 `nyabase-node`，不要用 root。CPU / PSI / sysctl 指标不需要
特权。`nvidia-smi`（GPU 显示序号）通常只需 `video` / `render` 组；若进程
跑不了 `nvidia-smi`，GPU 指标会被省略而不是崩溃。`smartctl` 权限不足时省略。
`nft list table bridge incus` 需要 `CAP_NET_ADMIN`（unit 的
`AmbientCapabilities` + `CapabilityBoundingSet`，保持 `NoNewPrivileges=true`）。
**不要写 sudoers**——与 `NoNewPrivileges` 不兼容。`CAP_NET_ADMIN` 比 `nft list`
更宽（可以改宿主机网络），bounding set 仅此一项。nft 不可用时 exporter 必须
显式输出 `nyabase_node_network_nft_available 0`，不能静默省略。

### TLS、token、监听地址

```bash
sudo useradd --system --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin nyabase-node
sudo install -d -o nyabase-node -g nyabase-node -m 0750 /etc/nyabase/node-exporter
# Issue a server certificate whose leaf fingerprint will be pinned on the
# Server object (nodeMetrics.serverCertFingerprint).
sudo openssl req -x509 -newkey rsa:3072 -nodes -days 365 \
  -subj "/CN=$(hostname -f)" \
  -keyout /etc/nyabase/node-exporter/tls.key \
  -out /etc/nyabase/node-exporter/tls.crt
sudo chmod 0400 /etc/nyabase/node-exporter/tls.key
sudo chmod 0440 /etc/nyabase/node-exporter/tls.crt
sudo chown nyabase-node:nyabase-node /etc/nyabase/node-exporter/tls.*
```

`/etc/nyabase/node-exporter.env`（mode 0600，属主 `nyabase-node`）：

```bash
NODE_EXPORTER_TOKEN=<openssl rand -base64 48，32–1024 字符且无空白>
NODE_EXPORTER_TLS_KEY=/etc/nyabase/node-exporter/tls.key
NODE_EXPORTER_TLS_CERT=/etc/nyabase/node-exporter/tls.crt
NODE_EXPORTER_HOST=0.0.0.0
NODE_EXPORTER_PORT=9109
# Optional LAN bridge name (vmbr0) used only as a fallback if
# /proc/sys/net/ipv4/conf cannot be listed. Prefer scanning all
# interfaces so bridge slaves are visible.
# NODE_EXPORTER_PARENT_INTERFACE=vmbr0
```

启动命令与软件包 `scripts.start` 相同：`node dist/main.js`（需要 Node.js 22+）。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nyabase-node-exporter.service
sudo systemctl status nyabase-node-exporter.service
```

防火墙只允许控制平面主机访问 TCP `9109`（或你设置的 `NODE_EXPORTER_PORT`）。
不要把该端口暴露到宾客 / 公网网段。若主机有独立管理地址，把
`NODE_EXPORTER_HOST` 绑到该地址。

### 控制平面如何 scrape / pull

在 Server 对象上配置（创建或 PATCH）：

- `nodeMetrics.endpoint`：固定 HTTPS URL，路径必须是 `/metrics`，例如
  `https://incus-host.example:9109/metrics`（对应库列
  `node_metrics_endpoint`）。
- `nodeMetrics.token`：与 `NODE_EXPORTER_TOKEN` 相同的 bearer；入库后加密，
  API 只回 `tokenFingerprint`。
- `nodeMetrics.serverCertFingerprint`：exporter 叶子证书指纹（TLS pin）。

`runtime.role` 为 `all` 或 `worker` 的 Backend 由 `NodeMetricsScrapeService`
每隔 15 秒（`NODE_METRICS_SCRAPE_INTERVAL_MS`）通过
`AuthenticatedNodeMetricsPullAdapter` 拉取：HTTPS Bearer + 证书钉扎，写入
VictoriaMetrics，并更新 `nodeMetrics.health`（`online` /
`unreachable` / `unknown` / `unconfigured`）。服务器预检也会拉一次同一端
点；GPU 的 nvidia-smi 序号来自这些只读样本，而不是 Incus。

e2e 停机演练：`systemctl stop/start "$E2E_NODE_EXPORTER_UNIT"`。把该变量
设为 `nyabase-node-exporter.service`。

## Workload images

`incus.imageSourceServer` 指向 Nyabase 烘焙 catalog（`ubuntu/24.04` 不是
linuxcontainers 原样盘）。添加镜像只提交 `{ alias }`；控制面写入
`loginUser=root` 与 `networkManagedExternally=true`。

开放 create 之前：

1. 控制面已部署「assignment 只留当前指纹」的 ensure 逻辑。
2. catalog 已发布烘焙 squashfs；`preflightImageFingerprint` **非空** 且等于
   该 combined squashfs 指纹。
3. 停删旧指纹容器后 `repull` / assign；`managed_fingerprint` 等于 catalog。
4. 服务器 preflight 通过。

catalog DTO 的 version 字符串是 bake serial（`v20260921_nb01`），不是项目
`version: 2`。回滚发更新日期的新 `bake.serial`，不要复用更旧的 YYYYMMDD 键。
