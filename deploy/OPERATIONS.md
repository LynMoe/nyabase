# Nyabase production control plane

The deployment is one Backend process (HTTP API, `/ws/*` gateways and
background workers) over PostgreSQL as the authoritative control-plane database
and VictoriaMetrics Single for metrics. Short-lived state (console sessions)
lives in Backend memory and is lost on restart. Workloads run
as Incus system containers; Compose is only the control-plane infrastructure and
smoke-test boundary.

The Backend never connects to an Incus server. Each server runs `nyabase-agent`,
which dials the Backend over WebSocket, fronts the local Incus unix socket behind
a fixed policy, and supplies host metrics. Durable desired state, intents, and
reconciliation claims remain in PostgreSQL.

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
`DATABASE_URL`. Percent-encode reserved URI characters in connection URLs.
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
existing loopback-only endpoint on `127.0.0.1:8428`. PostgreSQL has no
host-published port.

The Backend starts after healthy PostgreSQL. PostgreSQL and VictoriaMetrics
retain service healthchecks; the Backend does not wait for VictoriaMetrics and
buffers unsent samples in a bounded in-memory queue.

Useful probes:

```bash
curl --fail http://127.0.0.1:3001/api/health/live
curl --fail http://127.0.0.1:3001/api/health/ready
curl --fail http://127.0.0.1:8428/health
```

`/api/health/live` proves only that the Backend process is alive.
`/api/health/ready` also proves exact PostgreSQL schema readiness. VictoriaMetrics
failure must not make the Backend unready; metric queries degrade independently.
Readiness is held closed until the control-plane process is accepting traffic
and is closed again before dependency shutdown. Authenticated administrators
with `ViewMetricsAll` can query `/api/admin/metrics/runtime` for aggregate
PostgreSQL pool pressure and bounded telemetry queue health;
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

SSH and HTTP proxies are independent binaries in the `tools/` cargo workspace
(`tools/ssh-proxy`, `tools/http-proxy`, shared code in `tools/proxy-common`).
They are not Compose services. Prefer installing them on a host or netns
that can reach both the Backend WebSocket and the guest LAN; do not add them
to the default Compose file.

```bash
cargo build --release --locked --manifest-path tools/Cargo.toml
# binaries:
#   tools/target/release/nyabase-ssh-proxy
#   tools/target/release/nyabase-http-proxy
```

Listen addresses (env overrides):

- SSH: `NYABASE_SSH_LISTEN`, default `0.0.0.0:2222`
- HTTP: `NYABASE_HTTP_LISTEN`, default `0.0.0.0:8080`
- HTTPS (optional): `NYABASE_HTTPS_LISTEN` (unset means HTTPS listen is off)

After the Jump proxy binary that keeps live sessions is installed on the
manager, `upgrade-backend` (recreate Compose `backend` only) does not drop
established `ssh -J` sessions. New Jump connections fail closed until the
Backend is ready again. Replacing the Jump binary is copy then restart:
`install -m 0755` the new `nyabase-ssh-proxy` to `/usr/local/bin/` (and the
control-plane bundle `bin/`), then `maintain.sh restart-proxies`. Restart
alone does not install the file. That one proxy restart drops Jump.
If Backend stays down longer than the proxy hold (default 300s), Jump
fail-closes. Override hold with `NYABASE_SSH_CONTROL_HOLD_MS` in
`/etc/nyabase/ssh-proxy.env` (180000–600000), then restart the proxy unit.
This is not a YAML or panel setting.

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
  (a leftover test `mv-sshproxy@eth0`). `ip link show type
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
  control mutations and reconciliation.
- Console sessions are held only in Backend memory and end with the process.
  Durable intents and reconciliation claims remain in PostgreSQL. Agents
  reconnect on their own after a Backend restart; agent enrollment tokens and
  credentials are stored (as digests) in PostgreSQL.
- Login rate limits are per Backend process and reset on restart.
- Metrics samples queue in Backend memory (bounded by point and byte limits)
  and are written directly to VictoriaMetrics. When VictoriaMetrics is down or
  the queue is full, the oldest batches are dropped and counted in the
  `droppedBatches` telemetry field; there is no on-disk buffer.
- VictoriaMetrics data lives in `vm-data`. Its outage must not block control-plane
  writes or Incus reconciliation.

After a Backend restart, validate that durable intents converge through the
worker's periodic full scan. During a VictoriaMetrics outage, PostgreSQL control
mutations and Incus reconciliation must remain responsive; metric ingestion is
bounded and lossy until VictoriaMetrics returns.

Do not place PostgreSQL and VictoriaMetrics data in the same host filesystem
quota. PostgreSQL needs low-latency durable storage; VictoriaMetrics needs
sustained sequential I/O.

## Capacity

Start with a representative seven-day measurement rather than treating the
example limits as universal:

```text
samples_per_second =
  servers * average_active_series_per_server / collection_interval_seconds
```

Keep at least 20% of the VictoriaMetrics filesystem free. Prefer vertical scaling of VictoriaMetrics Single; move to a
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
product SLO and stored baseline.

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
stop VictoriaMetrics, restore into its data path, then start it.

## Upgrades

- Pin PostgreSQL to the current PostgreSQL 18 minor after staging its release
  notes and restore test.
- Upgrade one data service at a time. Take and verify backups before PostgreSQL
  or VictoriaMetrics changes.
- Production and CI images are pinned as readable tags plus immutable
  `sha256` manifests. Refresh a pin only after reviewing the upstream release,
  scanning/staging that exact digest, and rerunning the full Compose smoke;
  never update a tag while retaining an unrelated old digest.
- Never lower VictoriaMetrics retention or disk limits without checking
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

- Backend tests run with at most four Vitest workers against PostgreSQL 18.
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
pool wait time, transaction latency, WAL bytes/second,
and end-to-end request percentiles at the expected concurrency. Store the raw
plans and workload description with the release record; thresholds must come
from the product SLO and measured baseline, not from this example deployment.

## Security

- The Backend runs NestJS 11 on Express 5. Express 5 parses query strings with
  the `simple` parser, so nested `a[b]=` query keys are not expanded; every
  query DTO is flat and `.strict()`. The remaining low esbuild advisory is
  limited to its Windows development server path and is not reachable in the
  Linux production image.
- Behind a TLS-terminating reverse proxy, set `server.trustedProxies`
  (`TRUSTED_PROXIES`) to that proxy's address or CIDR (`loopback` when it runs
  on the same host). Without it every login appears to come from the proxy,
  so one client exhausting the per-IP login limit locks out everyone. Never
  trust a range that end users can send from directly. The proxy must
  overwrite, not append to, an untrusted inbound `X-Forwarded-For`.
- Browser sessions keep the refresh secret in the `nyabase_refresh` cookie
  (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api/auth`); the access token
  lives only in tab memory, and nothing credential-bearing is written to web
  storage. `/api/auth/login`, `/refresh`, and `/logout` require the
  `X-Nyabase-Auth: 1` header, which cross-site pages cannot send without a
  CORS preflight. Serve the SPA from the same site as the API (the bundled
  frontend does); a frontend on another site cannot use the cookie session.
  Upgrading from a release that stored tokens in `localStorage` signs every
  browser out once and erases the old keys on first load.
- The Backend sends a strict Content-Security-Policy (`script-src 'self'`,
  `frame-ancestors 'none'`), `nosniff`, and related headers on every response.
  It does not send HSTS; enable HSTS at the TLS edge once every host under the
  chosen scope serves HTTPS.
- Only the Backend joins both the control-plane and telemetry networks.
- The Backend image runs as the dedicated unprivileged `10001:10001` identity.
  Writable mounts and temporary files must be owned by that identity; do not
  grant root merely to fix a mount-permission error.
- Its root filesystem is read-only, every Linux capability is dropped,
  `no-new-privileges` is enabled, and `/tmp` is a bounded `noexec` tmpfs owned
  by `10001:10001`. The configuration bind mount must remain readable without
  weakening those controls.
- Never publish the PostgreSQL port.
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
- Add a VictoriaMetrics auth proxy only when telemetry endpoints cross a trust
  boundary.

## 授权失效与 14 天宽限

资源授权（服务器、数据盘池、共享后端）可授给用户或用户组，同一用户对同一资源可同时有多条授权。数据库视图
`iam.effective_server_access` / `iam.effective_pool_access` / `iam.effective_shared_backend_access` 按 (用户, 资源) 合并：
配额逐项取最大（任一为 NULL 即不限；磁盘与共享后端额度的 0 也按不限），GPU 白名单取并集，到期取最晚（任一不设期限则不过期），
合并视图 `iam.merged_*_access` 不看用户状态（仅供失效台账判断“有无覆盖”），`iam.effective_*_access` 在其上只增加 active 用户过滤。所有授权判断只读 effective 视图，没有授权缓存。

用户失去覆盖（授权到期、删除授权、移出组、删除组）后立即进入同一条 14 天宽限流程，撤销不会被拒绝：

- 台账 `control.access_lapses`（`user_id, resource_kind, resource_id, lapsed_at, stopped_at, purged_at`）记录宽限。
  `lapsed_at` 创建时确定、之后不再变化：已过期取过去的 `expires_at`，撤销则取检测时刻。
- 宽限内：停止该用户在该资源上运行中的容器（一次，写 `stopped_at`），不能新建、启动、挂载。
- 宽限期满：清除该用户在该资源上的容器与卷（写 `purged_at`）；服务器 = 容器 + 本地卷，数据盘池 = 池上的卷及挂载它们的容器，
  共享后端 = 后端上的卷及挂载它们的容器。清除后该用户在该资源上已无资源，台账行即被删除。
- 宽限内覆盖恢复：台账行被删除，宽限取消；已停机的容器不会自动启动。
- 处理器每分钟运行一次，并在 IAM 写操作提交后立即唤醒；每个 (用户, 资源) 用 `reconcile_claims`
  租约（`resource_type = access_lapse`）串行，多副本安全。
- 用户被禁用不算失去覆盖：不开宽限、不清除，处理器只停止其运行中的容器，资源无限期保留；重新启用不会自动启动容器。
  已存在的到期/撤销台账行在用户被禁用期间照常推进并清除。删除账号仍要求其名下没有任何资源。
- 管理员仍可对某用户在某服务器上的资源手动清除：`POST /api/users/:userId/servers/:serverId/purge-resources`。

## 主机 Agent（每台 Incus 主机一个）

Backend **不直连** Incus，也不主动连接任何主机。每台 Incus 主机运行
`nyabase-agent`（`packages/agent`），由它主动连到 Backend：

- 控制连接 `wss://<backend>/ws/agent`，以 `Authorization: Bearer <凭据>` 鉴权；
  Backend 只存凭据的 sha256。backend 发来的 Incus 请求、指标采集都走这条连接。
- 每个 Incus WebSocket（事件、exec/控制台）由 agent 另开一条
  `wss://<backend>/ws/agent/stream?id=…` 回连，逐帧转发。
- agent 经本机 `/var/lib/incus/unix.socket` 访问 Incus，不开监听端口，Incus 也
  不需要开 `core.https_address`、不需要任何 trust 条目。
- agent 是安全边界：每个请求先过 `packages/agent/src/policy.ts`。只允许操作
  `nyc-*` 实例与 `nyv-*` 卷；配置白名单；禁止 `raw.*`、特权容器、宿主路径设备、
  profiles、证书/服务器配置/网络/存储池写入；`security.idmap.isolated` 必须为
  true；网卡必须开 IPv4/MAC 过滤且 `host_name` 为 `nyh*`；`volatile.*` 一律改回
  Incus 当前值。即使 Backend 被攻破，也拿不到宿主机 root。
- agent 常驻维护 nft 表 `bridge nyabase_guard`：在 `nyh*` veth 上双向丢弃所有
  IPv6 与 802.1Q/802.1ad 帧（不依赖 `br_netfilter`，与 Docker 的 iptables 规则不
  冲突），并以 `nyabase_node_ipv6_guard_present` 上报；预检要求它为 1。

### 接入（enrollment）

1. 管理员在前端添加服务器（或 `POST /api/servers`），响应里带一次性接入令牌
   `nyae.…`（24 小时有效，只显示一次，库里只存摘要）。之后可用
   `POST /api/servers/:id/agent-enrollment {expectedRevision}` 重新签发；
   重新签发不会断开正在运行的 agent。
2. agent 首次启动时用令牌调用 `POST /api/agent/enroll`，换得长期凭据 `nyak.…`，
   保存在 `/var/lib/nyabase-agent/credential`（0600）。之后令牌不再被读取。
3. 新 agent 用令牌接入成功会替换凭据并断开旧连接。若要在已接入过的主机上
   重新接入：停 agent、删 `/var/lib/nyabase-agent/credential`、写入新令牌后再启动。

### 构建与安装

```bash
pnpm --filter @nyabase/common build
pnpm --filter @nyabase/agent build
sudo useradd --system --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin nyabase-agent
sudo install -d /opt/nyabase/agent
# Copy packages/agent/dist + package.json and production node_modules
# (@nyabase/common, zod, ws must resolve).
sudo install -D -m 0644 deploy/nyabase-agent.service /etc/systemd/system/nyabase-agent.service
sudo install -d -m 0700 /etc/nyabase
sudo tee /etc/nyabase/agent.env >/dev/null <<ENV
NYABASE_BACKEND_URL=https://nyabase.example.com
NYABASE_AGENT_ENROLLMENT_TOKEN=<控制台显示的一次性令牌>
# NYABASE_BACKEND_CA_FILE=/etc/nyabase/backend-ca.pem   # 私有 CA 时
ENV
sudo chmod 0600 /etc/nyabase/agent.env
sudo systemctl daemon-reload
sudo systemctl enable --now nyabase-agent
```

unit 以 `nyabase-agent` 用户运行，附加 `incus-admin` 组（访问 Incus socket），
只保留 `CAP_NET_ADMIN`（维护 `nyabase_guard`、读取 `bridge incus`）。需要 Node.js 20+。
`nvidia-smi` 需要 `video`/`render` 组时自行追加 `SupplementaryGroups`。

### 指标

Backend 的 `NodeMetricsScrapeService` 每 15 秒经控制连接请求一次
`metrics.collect`（主机、cgroup、GPU、nft 与 IPv6 拦截状态），写入 VictoriaMetrics
并更新服务器的 `metricsHealth`。agent 断开时服务器标记为 `unreachable`，重连后
自动恢复并刷新 CPU 拓扑、GPU 与存储池清点。

### 容器资源约束

- **CPU**：授权给整数核数（`cpuCores`，NULL = 不限）。Backend 为每个（服务器, 用户）
  分配一组逻辑 CPU（`control.user_cpu_sets`：尽量不与其他用户重叠、超线程成对、
  同 NUMA），该用户在该服务器上的所有容器都绑定到这整组核（`limits.cpu` 一律为
  cpuset），合计最多用满这组核。服务器的 `reservedCpus` 永不分配给容器；修改后所有
  容器在线改绑。不限核的用户绑定全部未预留的核。
- **内存**：每个容器单独设大小，但（用户, 服务器）的总和不超过授权。
- **统一限额**（系统设置，在线生效）：`containers.processLimit`（`limits.processes`）、
  `containers.networkIngressMbit` / `networkEgressMbit`（网卡 `limits.ingress/egress`）、
  `containers.diskReadMBps` / `diskWriteMBps`（root 与本地卷 `limits.read/write`；
  CephFS 无块设备，限不了）。
- **隔离**：`security.idmap.isolated=true`（每个容器独立 uid 段，需要 `/etc/subuid`
  给 root 足够的范围），自定义卷 `security.shifted=true`，同一用户的容器共享卷时
  属主一致；`security.port_isolation=true`；IPv6 由 `nyabase_guard` 禁用。
- **漂移**：全量扫描比较实例的全部配置（只放过 `volatile.*`、`image.*`）与全部设备，
  设备键双向比较，`profiles` 必须为空；有差异就整份写回并记审计
  `container.drift_corrected`。

### GPU 直通（NVIDIA）

GPU 是平台内置功能，不是插件。管理员在服务器详情的 GPU 标签页（或
`PATCH /api/servers/:serverId/gpu`，body `{"enabled": true}`）为单台服务器
启用；`GET /api/servers/:serverId/gpu` 返回开关、预检健康
（`runtimeReady` / `nvidiaCardCount`）、占用数与本机前置条件检测（Incus 资源、NVIDIA
卡、驱动、Container Toolkit），检测不通过不会阻止启用。持有 GPU 的容器存在时无法关闭
（`GPU_OCCUPIED`）。卡清单来自 `GET /api/servers/:serverId/gpus`（默认 `scope=mine`，按服务器授权过滤）与
`GET /api/servers/:serverId/gpus?scope=all`（管理员，全部卡）；容器通过创建请求的
`gpuPciAddresses` 或 `PATCH /api/containers/:id/gpus` 绑定，改动 GPU 需先停止容器。
授权用服务器授权的 `gpuPciAddresses`（空数组表示无 GPU 权限）。

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

## Live lab e2e

`tests/e2e/` holds the live scenario tests (not run in CI; CI runs
`pnpm e2e:check`). They start their own control plane, never the production one:

- `pnpm e2e:up` builds the Backend and both proxies, creates a fresh database
  `nyabase_e2e_<run id>` on the PostgreSQL given in `tests/e2e/lab.env`, generates
  the four boot secrets and starts a single-process Backend (clean environment,
  `NYABASE_CONFIG_FILE` pointing at a missing file) plus the two Rust proxies on the
  configured ports, registers the lab servers, starts a run-scoped agent on each
  lab host (through an ssh reverse tunnel) that enrolls with the server's one-time
  token, then finishes the registration and writes `state.json` in the run directory.
- `pnpm e2e:run [word...]` runs the `scenarios/*.test.ts` files (all, or those whose
  name contains one of the words).
- `pnpm e2e:down` stops the processes and, on each lab host, deletes only instances
  labelled with the run's server ids, volumes the run's database recorded, the run's
  agent unit and the agent's nft guard table; then drops the database and
  removes the run directory. It is safe to repeat after a partial `up`.

Inputs are documented in `tests/e2e/lab.env.example`; the full description is in
`tests/e2e/README.md`.
