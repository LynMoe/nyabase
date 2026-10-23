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
boot; copy the example and fill them before `up`. See **Boot secrets, TLS
edge, and proxies** below. `config.yaml` is listed in `.gitignore`.
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

The Backend is published only on `127.0.0.1:3001`; the public entrypoint is
the TLS edge described below. VictoriaMetrics keeps its loopback-only endpoint
on `127.0.0.1:8428`. PostgreSQL has no host-published port.

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
and is closed again before dependency shutdown. Its database check borrows a
connection from the request pool, so concurrent probes share one check and the
verdict is reused for one second. The probes are for local monitoring only;
the TLS edge example below does not expose `/api/health/` publicly.
Authenticated operators and administrators can query `/api/admin/metrics/runtime` for aggregate
PostgreSQL pool pressure and bounded telemetry queue health;
the response intentionally contains no SQL, keys, identities, or raw errors.

## Boot secrets, TLS edge, and proxies

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
- `ssh.keyEncryptionSecret`: dedicated secret of at least 32 characters that
  differs from `auth.jwtSecret` (production refuses to start otherwise). It
  encrypts the SSH proxy host key and every HTTP domain pool's TLS private key
  in the database, so it belongs to the database: back it up with every
  database backup and never rotate it in place (there is no re-encryption).
  See **Lost `ssh.keyEncryptionSecret`** under the backup contract.
- `http.proxyToken` and `ssh.proxyToken`: 32–1024 character ASCII using only
  letters, digits, `_`, or `-`. `openssl rand -hex 32` is valid. The HTTP and
  SSH WebSocket handlers refuse to start with an empty token.

`runtime.nodeEnv` (`NODE_ENV`) defaults to `production`: an unset value gets the
production checks above. The insecure development fallbacks (a built-in JWT
secret, `admin123`, key encryption reusing the JWT secret) apply only when
`NODE_ENV` is explicitly `development` or `test`; never set either in a
deployment.

With `auth.adminInitPassword` empty, the first production boot creates the
`admin` account with a random password and prints it **once**, at that first
boot only and whatever `server.logLevel` is, written straight to the Backend's
stderr after a `[nyabase] Created the administrator account "admin" with a
generated password:` line
(`docker compose --env-file .env logs backend | grep -A1 'generated password'`).
Later boots never print it again, so capture it before the log rotates. Sign in
and change it immediately, then treat the log line as a leaked secret (rotate
the log or restrict who can read it).

### TLS edge

The Backend speaks plain HTTP and must never be reachable from outside the
host. A TLS-terminating reverse proxy (nginx, Caddy, HAProxy, …) is the only
public entrypoint and forwards everything to the Backend:

- the panel (`/`) and the API (`/api/*`);
- the WebSocket paths, which need `Upgrade` forwarding and a long idle timeout:
  `/ws/agent` and `/ws/agent/stream` (host agents), `/ws/ssh-proxy` and
  `/ws/http-proxy` (proxy control links), and `/ws/console` (browser
  consoles). The Backend destroys upgrades on any other path.

Keep the Backend on loopback:

- Compose already publishes it only on `127.0.0.1:3001`; run the reverse proxy
  on the same host. Inside the container it listens on `0.0.0.0`.
- Outside Compose `server.listenAddress` (`LISTEN_ADDRESS`) defaults to
  `127.0.0.1`; listening anywhere else must be set explicitly (`0.0.0.0`).

Set `server.trustedProxies` (`TRUSTED_PROXIES`) to the address the Backend sees
the reverse proxy connect from. Without it every client appears to share the
proxy's address, so one client exhausting the per-address login limit blocks
sign-in for everyone; the Backend logs a warning the first time it sees an
`X-Forwarded-For` while no proxy is trusted. Use `loopback` for a non-Compose
Backend on the same host. Under Compose, Docker forwards the loopback publish
from the `edge` bridge's own address, not `127.0.0.1`. Compose pins that
network to `EDGE_SUBNET` (default `172.30.250.0/24`) and trusts its first
address (`172.30.250.1`) by default; if the range collides with a host network,
change `EDGE_SUBNET` and `TRUSTED_PROXIES` together in `deploy/.env`. The proxy
must overwrite, not append to, an inbound `X-Forwarded-For`.

Do not put tenant HTTP domain pools under the panel's registrable domain
(for example the panel at `panel.example.com` and tenant sites at
`*.apps.example.com`). The refresh cookie is `__Host-` scoped so a tenant page
cannot plant one for the panel, but same-site tenant pages still count as the
panel's site for `SameSite` and share every other parent-domain cookie.

Minimal nginx shape (certificate handling is the operator's):

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name nyabase.example.com;
    ssl_certificate     /etc/nginx/tls/nyabase.crt;
    ssl_certificate_key /etc/nginx/tls/nyabase.key;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    # Unauthenticated probes; readiness queries PostgreSQL. Monitoring on this
    # host uses http://127.0.0.1:3001/api/health/* directly.
    location /api/health/ {
        # allow 192.0.2.10;   # an external monitoring host, if there is one
        deny all;
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

Nothing outside the host needs the health probes: Compose, agents and proxies
never call them through the edge. The Backend also serves the bundled panel:
hashed files under `/assets/` with `Cache-Control: public, max-age=31536000,
immutable`, and `index.html` with `no-cache`, so a redeploy is picked up on the
next page load. Do not add edge caching rules that override these. A missing
`/assets/*` file is a plain 404 (never `index.html`); an open tab that hits one
after a redeploy reloads itself once.

Agents and proxies refuse to start on a plaintext Backend URL unless the
Backend host is loopback (`localhost`, `127.0.0.0/8`, `::1`):

- `nyabase-agent`: `NYABASE_BACKEND_URL` must be `https://…`.
- SSH and HTTP proxies: `NYABASE_BACKEND_WS` must be `wss://…`.

Each accepts `NYABASE_BACKEND_CA_FILE` (PEM) for a private CA, which also
requires the TLS scheme. The Rust proxies trust only that bundle when it is set
and the bundled public roots otherwise.

### SSH and HTTP proxies

SSH and HTTP proxies are independent binaries in the `tools/` cargo workspace
(`tools/ssh-proxy`, `tools/http-proxy`, shared code in `tools/proxy-common`).
They are not Compose services. Prefer installing them on a host or netns
that can reach both the Backend WebSocket and the guest LAN; do not add them
to the default Compose file.

`deploy/install-proxy.sh ssh|http` does all of the steps below for one proxy
from a checkout (as root): it builds with cargo (or installs `--binary FILE`),
installs the binary and unit, creates `/etc/nyabase/<kind>-proxy.env` from the
example only once (and then stops, so you can edit it), and on later runs
replaces the binary and unit and restarts the service, failing loudly with the
journal if it does not stay up. The manual equivalent:

```bash
cargo build --release --locked --manifest-path tools/Cargo.toml
sudo install -m 0755 tools/target/release/nyabase-ssh-proxy /usr/local/bin/
sudo install -m 0755 tools/target/release/nyabase-http-proxy /usr/local/bin/
sudo install -d -m 0755 /etc/nyabase   # the proxy user must read a CA file kept here
sudo install -m 0600 deploy/ssh-proxy.env.example /etc/nyabase/ssh-proxy.env
sudo install -m 0600 deploy/http-proxy.env.example /etc/nyabase/http-proxy.env
# edit both files: NYABASE_BACKEND_WS and the proxy tokens
sudo install -m 0644 deploy/nyabase-ssh-proxy.service deploy/nyabase-http-proxy.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nyabase-ssh-proxy nyabase-http-proxy
```

Both units run as a transient unprivileged user (`DynamicUser`) with
`LimitNOFILE=65536`, `Restart=always`, and the same filesystem hardening as
`nyabase-agent.service`. The HTTP proxy holds only `CAP_NET_BIND_SERVICE`, so it
can listen on `:80`/`:443` without root; the SSH proxy holds no capability. If
the TLS edge for the panel runs on the same host, give the two different
addresses for `:443`.

Environment (`/etc/nyabase/*.env`; defaults in parentheses, ranges are
enforced at start-up):

| Variable | Proxy | Default / range |
| --- | --- | --- |
| `NYABASE_BACKEND_WS` | both | `ws://127.0.0.1:3000/ws/{ssh,http}-proxy`; set `wss://<panel host>/ws/ssh-proxy` or `/ws/http-proxy` |
| `NYABASE_BACKEND_CA_FILE` | both | unset (bundled public roots) |
| `SSH_PROXY_TOKEN` / `SSH_PROXY_TOKEN_FILE` | SSH | required, one of the two; same value as `ssh.proxyToken` |
| `HTTP_PROXY_TOKEN` / `HTTP_PROXY_TOKEN_FILE` | HTTP | required, one of the two; same value as `http.proxyToken` |
| `NYABASE_SSH_LISTEN` | SSH | `0.0.0.0:2222` |
| `NYABASE_SSH_MAX_CONNECTIONS` | SSH | `512` (1–1024) |
| `NYABASE_SSH_MAX_CONNECTIONS_PER_IP` | SSH | `16` (1–1024), per IPv4 address / IPv6 `/64` |
| `NYABASE_SSH_MAX_CONNECTIONS_PER_IPV6_48` | SSH | `64` (1–1024), all `/64`s of one IPv6 `/48` together |
| `NYABASE_SSH_MAX_PREAUTH_CONNECTIONS` | SSH | `128` (1–`NYABASE_SSH_MAX_CONNECTIONS`), not yet authenticated |
| `NYABASE_SSH_MAX_PREAUTH_CONNECTIONS_PER_IP` | SSH | `8` (1–the smaller of the per-IP and pre-auth caps), per IPv4 address / IPv6 `/64` |
| `NYABASE_SSH_MAX_PREAUTH_CONNECTIONS_PER_IPV6_48` | SSH | `32` (1–the smaller of the per-`/48` and pre-auth caps) |
| `NYABASE_SSH_AUTH_TIMEOUT_MS` | SSH | `30000` (1000–600000), accept to successful auth |
| `NYABASE_SSH_CONTROL_HOLD_MS` | SSH | `300000` (180000–600000) |
| `NYABASE_HTTP_LISTEN` | HTTP | `0.0.0.0:8080` (the example uses `:80`) |
| `NYABASE_HTTPS_LISTEN` | HTTP | unset = HTTPS off (the example uses `:443`) |
| `NYABASE_HTTP_MAX_CONNECTIONS` | HTTP | `4096` (1–65536) |
| `NYABASE_HTTP_MAX_CONNECTIONS_PER_IP` | HTTP | `64` (1–65536), per IPv4 address / IPv6 `/64` |
| `NYABASE_HTTP_MAX_CONNECTIONS_PER_IPV6_48` | HTTP | `256` (1–65536), all `/64`s of one IPv6 `/48` together |
| `NYABASE_HTTP_MAX_PENDING_CONNECTIONS` | HTTP | `1024` (1–`NYABASE_HTTP_MAX_CONNECTIONS`), in TLS handshake or before a full request head |
| `NYABASE_HTTP_MAX_PENDING_CONNECTIONS_PER_IP` | HTTP | `16` (1–the smaller of the per-IP and pending caps), per IPv4 address / IPv6 `/64` |
| `NYABASE_HTTP_MAX_PENDING_CONNECTIONS_PER_IPV6_48` | HTTP | `64` (1–the smaller of the per-`/48` and pending caps) |
| `NYABASE_HTTP_MAX_CONNECTIONS_PER_CONTAINER` | HTTP | `512` (1–`NYABASE_HTTP_MAX_CONNECTIONS`), per upstream container, all its hostnames together, WebSockets included; over it the client gets a 503 |
| `NYABASE_HTTP_MAX_CONNECTIONS_PER_IP_PER_CONTAINER` | HTTP | `32` (1–the smaller of the per-IP and per-container caps), one IPv4 address / IPv6 `/64` to one container; over it that client gets a 503 |
| `NYABASE_HTTP_MAX_CONNECTIONS_PER_OWNER` | HTTP | `1024` (the per-container cap–`NYABASE_HTTP_MAX_CONNECTIONS`), all of one user's containers together; over it the client gets a 503 |
| `NYABASE_HTTP_BODY_DEADLINE_MS` | HTTP | `30000` (1000–3600000), whole request body |
| `NYABASE_HTTP_IDLE_TIMEOUT_MS` | HTTP | `120000` (1000–86400000), ordinary request with no bytes either way |
| `NYABASE_HTTP_RESPONSE_LIFETIME_MS` | HTTP | `1800000` (1000–86400000), whole ordinary response, counted from the end of the request body |
| `NYABASE_HTTP_UPGRADED_IDLE_MS` | HTTP | `3600000` (1000–86400000), no bytes either way |
| `NYABASE_HTTP_CONTROL_HOLD_MS` | HTTP | `300000` (0–600000; `0` clears routes immediately) |

HTTPS domain pools take a wildcard certificate whose `subjectAltName` covers
the pool's `*.domain` (the subject CN alone is not enough), as an X.509 v3
certificate with an RSA 2048–4096, ECDSA P-256/P-384, or Ed25519 key, the key
types the proxy can load. The Backend refuses anything else at upload and
stores the key re-encoded as PKCS#8.

Domain pools must be disjoint: a pool whose domain equals, contains or lies
under another pool's (`*.example.com` next to `*.a.example.com`) is refused
(`HTTP_PROXY_DOMAIN_POOL_OVERLAP`), because a user of the outer pool could
bind `a.example.com`, a parent domain of every site in the inner pool, and set
cookies they all receive. Likewise a binding hostname that is any pool's
domain or a parent of it is refused (`HTTP_PROXY_HOSTNAME_COVERS_DOMAIN_POOL`).
Tenants of one pool still share its parent domain, so for cookie isolation
between tenants list the pool's domain in the Public Suffix List or give each
tenant group its own registrable domain.

A token file must be a regular file (not a symlink) readable only by the
service user; with `DynamicUser` deliver it through a `LoadCredential=` drop-in
rather than a root-owned path. Per-IP limits bucket IPv6 clients per `/64`
and additionally cap each `/48`; IPv4-mapped addresses count as IPv4.
WebSocket and other upgraded connections count against every HTTP limit. A
connection over a limit is closed immediately. Every new connection also
takes a pre-auth (SSH: until public-key authentication succeeds) or pending
(HTTP: until the request head is read, including the TLS handshake) slot, a
smaller pool than the total, so unauthenticated sockets cannot crowd out
established sessions. That pool is shared fairly: each IPv4 address / IPv6
`/64` and each `/48` may hold only a few pending slots (the `*_PER_IP` /
`*_PER_IPV6_48` pending variables), and when the pool is full a new
connection from a source (IPv4 address or IPv6 `/48`) holding at least two
fewer pending slots than the heaviest source evicts that source's oldest
pending connection instead of being refused; the evicted connection is closed
at once. Holding the pool against fresh clients therefore takes as many
distinct sources as there are pending slots. The SSH proxy counts refusals
and evictions in `ssh_proxy_connections_total` (`rejected_preauth_limit`,
`rejected_preauth_client_limit`, `rejected_preauth_site_limit`,
`closed_preauth_evicted`). The SSH authentication deadline is independent of the
600 s session inactivity timeout. These are environment settings only, not
YAML or panel settings. A transient `accept()` failure (descriptor
exhaustion, `ECONNABORTED`, `ENOBUFS`) is logged and retried with a short
backoff (5 ms doubling to 1 s); it does not restart the proxy.

**Reaching containers by name.** The proxy authenticates by public key
alone; the jump login only labels the session. A `direct-tcpip` target is
either a container's routed IP or its name, bare (`work`) or with the host
suffix `ssh.proxyHostSuffix` (default `nya`, so `work.nya`), and a name is
looked up only among the key holder's own containers. Container names are
therefore unique per owner, ignoring case (and still per server). Each user's
profile page shows a one-time `~/.ssh/config` block (`Host *.<suffix>` with
`ProxyJump <user>@<proxy host>:<port>`) and two `known_hosts` lines: the
proxy's host key and `@cert-authority *.<suffix> <the user's host CA>`. After
that `ssh root@work.nya` works for every current and future container with
strict host key checking and no fingerprint prompt.

**Container host certificates.** Every user has their own Ed25519 host CA
(`interaction.ssh_host_authorities`, private key encrypted with
`ssh.keyEncryptionSecret`); it signs only that user's containers, so one
user's container named `work` can never present a certificate another user's
known_hosts accepts. While a container's sshd is up, the reconciler writes
`/etc/ssh/ssh_host_ed25519_key-cert.pub` (principals `<name>.<suffix>` and
`<name>`, valid forever) and `/etc/ssh/sshd_config.d/50-nyabase-host-certificate.conf`,
checks the result with `sshd -t` (removing its drop-in if sshd refuses it) and
reloads sshd. This is best effort: an image without an Ed25519 host key or
without `Include /etc/ssh/sshd_config.d/*.conf` gets no certificate and users
fall back to trust-on-first-use; the reconciler logs why. Changing the host
suffix re-signs every container and breaks the ssh_config and known_hosts
lines users already copied; rotating the proxy host key breaks the proxy line.
Choose a suffix that is not a real domain covering the proxy's own public
host: `Host *.<suffix>` would then match the jump host itself.

**Guest authorized_keys.** The platform owns only a marked block at the end of
the login user's `authorized_keys` (`# >>> nyabase: platform SSH keys …` to
`# <<< nyabase <<<`); lines the user adds outside it are kept. The block holds
the owner's current keys and is removed when they have none.

**Snapshot size.** The proxy snapshot carries only users, containers, servers
and images behind at least one routable SSH route, and has a hard cap of
4 MiB. A build that fails (over the cap, or a database error) sends nothing:
the proxies keep the previous snapshot (new containers and keys stop taking
effect) only until its lease (`ssh.proxySnapshotStaleMs`, 120–300 s) runs
out, and then fail closed: every Jump session ends and every login is
refused until a build succeeds. The Backend never re-sends the old snapshot
with a fresh lease, because that would let a revocation outlive the lease.
It retries on every change and every renewal tick (a third of the lease, at
most 60 s) and logs each failure at error level with the time the proxies
will fail closed. The admin SSH proxy page shows the last build's size
against the cap, warns from 75%, and shows the error of a failed build, a
missing public address, and proxies behind the latest generation. Because
users without a reachable container are left out, their login attempts are
audited as `public_key_rejected`, the same as an unknown key.

**SSH logins.** The SSH login must be 1–256 printable ASCII bytes; anything
else is refused before any key lookup and audited as `invalid_login` without
the login text. The proxy's journal records every attempt; the Backend log
records each successful login (`SSH proxy audit action=login ok=true
user=…`) but only one line a minute summing refused attempts by reason
(`SSH proxy refused N login attempt(s) since the last summary: …`), without
the client-chosen usernames, so internet scanning cannot rotate the capped
container log. The once-per-second status report caps its per-connection
details at 1024 entries / 512 KiB; connections beyond that are counted in
`omittedConnections` (and in `activeConnections`) but not listed. Each
`direct-tcpip` bridge is revalidated against every new snapshot on its own: a
bridge whose container route is revoked is closed, the connection and its
other bridges stay. A route bound by a jump-format login (`user.container`)
still ends the whole connection when revoked.

**HTTP request handling.** The HTTP proxy is the public edge, so it never
trusts client forwarding headers: incoming `Forwarded`, `X-Real-IP` and every
`X-Forwarded-*` header are removed, with `_` and `.` treated as `-` (so
`X_Forwarded_For`, `X.Forwarded.For` and `X-Real_IP` are removed too, as are
such spellings of `Content-Length`, `Transfer-Encoding`, `Keep-Alive`,
`Proxy-Connection` and `Sec-WebSocket-*`; other names with `_` or `.` pass
unchanged), and the upstream receives
`X-Forwarded-For` and `X-Real-IP` (the client socket address; IPv4-mapped
IPv6 shown as IPv4), `X-Forwarded-Proto` (`http` or `https` by listener) and
`X-Forwarded-Host` (the client's `Host`). Do not put another proxy in front of
it unless that hop is changed to pass the client address some other way;
behind one, every request would appear to come from it. Each connection
carries exactly one request (`Connection: close` upstream, no upstream reuse).
Request bodies are capped at 16 MiB. `Expect: 100-continue` is answered by the
proxy itself (after the route resolves and the upstream connects) and is not
forwarded; any other expectation is a 400. `Transfer-Encoding: chunked`
request bodies are accepted only as exactly `chunked` on HTTP/1.1, without
`Content-Length`, and are decoded strictly and re-chunked to the upstream
(chunk extensions and trailers dropped); malformed framing or bytes after the
final chunk get a 400 and the upstream never receives a complete body. Other
transfer codings, a coding list, duplicate `Transfer-Encoding` or
`Content-Length` headers and folded header lines are rejected. The request
head must arrive within 10 s, the body within `NYABASE_HTTP_BODY_DEADLINE_MS`,
and after that the exchange runs until it finishes, its own route is revoked
(the hostname leaves the snapshot or its binding, owner, container, instance,
address or target port changes; changes to other hostnames never interrupt
it, and a route that leaves and comes back is a new route), the snapshot
lease lapses, nothing moves for `NYABASE_HTTP_IDLE_TIMEOUT_MS` (waiting for the upstream's
first byte counts as idle), or the response has run for
`NYABASE_HTTP_RESPONSE_LIFETIME_MS` (default 30 min) since the end of the
request body. Long downloads, SSE and long-polling therefore work as long as
bytes flow at least that often and finish within that ceiling (EventSource
reconnects on its own). Upgraded tunnels (WebSocket) have no total lifetime,
only `NYABASE_HTTP_UPGRADED_IDLE_MS`. Each upstream container may hold at most
`NYABASE_HTTP_MAX_CONNECTIONS_PER_CONTAINER` connections at once across all its
hostnames, so one container cannot take the whole connection pool; one client
(IPv4 address / IPv6 `/64`) may hold at most
`NYABASE_HTTP_MAX_CONNECTIONS_PER_IP_PER_CONTAINER` of them, so a few clients
dripping request bodies or holding WebSockets cannot lock a site's other
visitors out; and all of one user's containers together may hold at most
`NYABASE_HTTP_MAX_CONNECTIONS_PER_OWNER`, so one tenant with many containers
cannot take the pool either. Unlike the listener limits, which close
silently, going over any of these is answered with a 503. A full container or
owner is logged as `HTTP proxy upstream connection limit reached; refusing
with 503` at warn level at most once a minute per container or owner
(`container_id`, `owner_id`, `binding_id`, `hostname`, `cap` =
`per_container` or `per_owner`, `limit`, and `refused` = 503s since the
previous line); one client over its per-container share is logged only at
debug level. Everything the proxy writes to the client itself (error
responses, `100 Continue`, the WebSocket 101, the closing shutdown and TLS
`close_notify`) must finish within a fixed 10 s, or the connection is reset.
When a response is cut short (idle timeout, response lifetime, route
revocation, upstream error) the proxy resets the client connection (TCP RST)
instead of closing it, so a close-delimited body cannot look complete.

**Control link liveness.** Each proxy must finish connecting to the
Backend (TCP, TLS and the WebSocket upgrade) within 10 s, pings the Backend
every 15 s, and drops the link when nothing at all (pong, ping, snapshot)
arrives for 45 s; it then starts its hold window and reconnects, so a Backend
that vanished without closing the socket is noticed in under a minute
rather than when TCP gives up. The Backend pings every admitted proxy every
15 s and terminates a link that sent nothing between two pings, so a proxy
host that disappeared frees its slot (the Backend admits at most 4 links per
proxy kind) within 30 s and cannot lock out its own reconnect.

**Backend restarts and agent outages.** After losing its control connection
the HTTP proxy keeps serving its last snapshot for `NYABASE_HTTP_CONTROL_HOLD_MS`,
but never past that snapshot's own lease (300 s), so the effective hold is
at most about five minutes. The Backend renews the snapshot every 100 s, so a
stopped or deleted container's route can linger up to that long (it answers
503); IP and hostname reuse is drained for 360 s, longer than any lease. A snapshot from a new control connection
replaces the held one at once. HTTP routes are gated on the platform's IP
claims, not on how recently an agent reported, so sites stay up while a
server's agent is disconnected; stopping or deleting the container, releasing
its address, or removing the binding still removes the route on the next
snapshot. A snapshot build that fails (over its size cap, or a database
error) likewise sends nothing: the HTTP proxies keep their last snapshot
until its 300 s lease runs out and then drop every route (404 on HTTP; on
HTTPS the certificates go too) until a build succeeds; the Backend retries on every change and every renewal and
logs each failure at error level with the time the proxies will fail closed.

Recreating only the Compose `backend` service
(`docker compose --env-file .env up -d backend`) does not drop
established `ssh -J` sessions; new Jump connections fail closed until the
Backend is ready again. If the Backend stays down longer than
`NYABASE_SSH_CONTROL_HOLD_MS`, Jump fail-closes. Replacing a proxy binary is
copy then restart: `install -m 0755` the new binary to `/usr/local/bin/`, then
`systemctl restart nyabase-ssh-proxy` (or `nyabase-http-proxy`). Restart alone
does not install the file, and restarting the SSH proxy drops every Jump
session.

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
- Login rate limits are per Backend process and reset on restart. Failed
  sign-ins are counted per (client address, username) — 10 per 5 minutes —
  and per client address — 30 per 5 minutes, IPv6 bucketed per `/64`. There is
  no account-wide lockout, so nobody can lock a user out by guessing from
  elsewhere. Wrong current-password entries by a signed-in user (password
  change, adding an SSH key) are limited to 10 per 5 minutes per user. Client
  addresses come from `server.trustedProxies` (see **TLS edge**).
- Volume destroy and purge wait while the executing server is offline (normal
  failure backoff and retry) instead of dropping the volume rows; only when the
  server or pool no longer exists is the destroy treated as having no executor.
  Deleting a server never drops a live shared volume: one placed only on that
  server stays tracked and is placed again when attached elsewhere.
- Deleting a server removes it from the control plane only and never touches
  its Incus. It is refused (`SERVER_NOT_EMPTY`) while the server still holds
  containers or local volumes, or while it is the last executor (online or
  not) of a CephFS shared backend that still has volumes
  (`details.strandedSharedVolumes`): delete those first, so the reconciler
  removes them from the host, and register another executor before removing
  the last one. `DELETE /api/servers/:id?force=true` skips the check and is
  only for a host that is gone for good or wiped; on a live host its instances
  would keep running while their addresses are handed out again. A forced
  delete of a backend's last executor keeps its live shared volumes listed
  (they cannot be attached or deleted until a new executor is registered) and
  only finishes destroys already in progress (`destroy_executor_gone`). To
  retire a CephFS backend, delete its volumes while an executor is still
  registered; volumes stranded by a forced delete can only be removed by
  registering an executor again.
- Agent streams (event stream, console, exec): the Backend waits up to 30 s
  for the agent's `incus.ws` reply and up to 35 s for the stream socket; a
  stream connecting later is closed with 1008. A stream that buffers more than
  16 MiB or 4096 frames before the Backend reads it is closed with 1009 and
  shows up as an event-stream reconnect or a failed exec.
- `POST /api/agent/enroll` allows 30 attempts per 10 minutes per client (one
  IPv4 address or one IPv6 `/64`, from `server.trustedProxies`); past 4096
  tracked clients the least recently seen are forgotten instead of refusing
  everyone.
- Browser sessions: each refresh extends a session by
  `auth.refreshTokenExpiresDays` (idle timeout) but never past login +
  `auth.sessionMaxLifetimeDays` (default 30); both are admin-only online
  settings, and a lower cap applies to existing sessions on their next refresh.
  Presenting an already-rotated refresh token revokes that session (audit
  `user.refresh_token_reuse`, warn log `Refresh token reuse: revoked session …`),
  except a lost-response retry with the same request id or a concurrent refresh
  with the immediately previous token within 15 s (401 `REFRESH_SUPERSEDED`,
  cookie kept; the browser retries once). A session remembers its newest 256
  retired tokens and may not forget one retired less than
  min(`auth.jwtExpiresIn`, 60 min) + 2 minutes ago, so it rotates at most 256
  times per that window (beyond that 429 `AUTH_RATE_LIMITED` with
  `Retry-After`, cookie kept; the browser waits and retries up to 3 times, then
  shows a transient error without signing out automatically; a cold load shows
  a wait-and-retry screen that also offers 退出登录). The window is capped at
  62 minutes so that a long lifetime (e.g. 24h, where every page load or new
  tab rotates) never throttles a session for hours. With a lifetime of up to
  60 minutes a token retired within one lifetime (+2 min) is therefore always
  recognised as reuse while the victim has a tab making requests; with a longer
  lifetime that is best effort beyond the window; older ones are merely
  invalid.
- Incus instances and custom volumes that carry this installation's labels but
  have no row (an instance `user.nyabase.server_id` of this server; a volume
  `user.nyabase.scope` of this server or of the pool's shared backend) are
  orphans. A full scan records each in `control.orphan_sightings`, force-stops
  an orphan instance at once, and deletes an orphan only after it has been seen
  for 7 days. Unlabelled `nyv-*` volumes (another installation on the same host,
  or created by hand) are never deleted.
- A server marked `unreachable` while its agent stays connected recovers on
  its own: the Backend probes Incus through the agent with backoff (15 s,
  doubling up to 5 min), restores `online` on success and wakes a full scan.
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
variables so they are not copied into shell history; keep passwords out of the
URL too and give libpq a mode-0600 `PGPASSFILE`.

The script needs PostgreSQL 18 client tools and a network path to the server.
In the shipped Compose file PostgreSQL has no published port and sits only on
the internal `control-plane` network, so do not run the script on the host.
Run it in a throwaway container from the same `postgres` image, attached to
that network, with the script, the password file and a backup directory
mounted. Compose names the network `<project>_control-plane`; the file sets
`name: nyabase`, so it is `nyabase_control-plane` unless you override the
project name (`docker network ls --filter label=com.docker.compose.network=control-plane`).

One-time setup, from `deploy/` on the Compose host, as an operator who can run
`docker`:

```bash
umask 077
ops_dir="$HOME/nyabase-ops"            # holds only the password file
backup_root=/srv/nyabase-backups       # local staging; copy off-host afterwards
mkdir -p "$ops_dir" "$backup_root"
chmod 0700 "$ops_dir" "$backup_root"

# libpq password file: host:port:database:user:password. The password is read
# from the terminal, so it is neither in shell history nor on a command line.
IFS= read -rsp 'PostgreSQL password (POSTGRES_PASSWORD): ' pg_password; echo
pg_password="${pg_password//\\/\\\\}"
pg_password="${pg_password//:/\\:}"
printf 'postgres:5432:*:%s:%s\n' nyabase "$pg_password" >"$ops_dir/pgpass"
unset pg_password
chmod 0600 "$ops_dir/pgpass"
```

Replace `nyabase` with `POSTGRES_USER` (and below, the database name with
`POSTGRES_DB`) if `.env` changes them. Then define a helper in the shell that
runs the operations (repeat this in every new shell, from `deploy/`):

```bash
ops_dir="$HOME/nyabase-ops"
backup_root=/srv/nyabase-backups
pg_network=nyabase_control-plane
pg_image="$(docker compose --env-file .env config --images | grep '^postgres:')"

pg_ops() {
  docker run --rm \
    --network "${PG_OPS_NETWORK:-$pg_network}" \
    --user "$(id -u):$(id -g)" \
    --volume "$PWD/postgres-ops.sh:/opt/nyabase/postgres-ops.sh:ro" \
    --volume "$ops_dir/pgpass:/run/nyabase/pgpass:ro" \
    --volume "$backup_root:/backups" \
    --env PGPASSFILE=/run/nyabase/pgpass \
    --env NYABASE_PG_SOURCE_URL="${NYABASE_PG_SOURCE_URL:-postgresql://nyabase@postgres:5432/nyabase}" \
    --env NYABASE_PG_TARGET_URL="${NYABASE_PG_TARGET_URL:-}" \
    "$pg_image" \
    bash /opt/nyabase/postgres-ops.sh "$@"
}
```

The container runs as your uid, so the archives in `$backup_root` belong to
you (mode 0600) and the password file stays readable only by you. Paths given
to `pg_ops` are container paths under `/backups`.

### Logical backups

Before every release and at the chosen logical-backup interval:

```bash
backup_name="nyabase-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_ops logical-backup --output "/backups/$backup_name"
pg_ops verify-logical --input "/backups/$backup_name"
```

The command refuses to overwrite an existing target, creates a SHA-256
sidecar, and validates the custom archive with `pg_restore --list`. Transfer
both files (`$backup_root/$backup_name` and `$backup_root/$backup_name.sha256`)
to immutable/off-host storage only after this succeeds. Back up `config.yaml`
with them (see **Lost `ssh.keyEncryptionSecret`**).

### Restore drills

Restore drills always use a new, explicitly named database. Never point a
drill at production. Create the empty target over the local socket inside the
`postgres` container (no password needed there), restore, inspect, drop:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U nyabase -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE nyabase_restore_drill TEMPLATE template0'
NYABASE_PG_TARGET_URL=postgresql://nyabase@postgres:5432/nyabase_restore_drill \
  pg_ops restore-logical \
    --input "/backups/$backup_name" \
    --confirm-database nyabase_restore_drill
docker compose --env-file .env exec -T postgres \
  psql -U nyabase -d nyabase_restore_drill \
  -c 'SELECT version, name, applied_at FROM system.schema_migrations'
docker compose --env-file .env exec -T postgres \
  psql -U nyabase -d postgres -c 'DROP DATABASE nyabase_restore_drill'
```

The restore refuses PostgreSQL maintenance databases, checks the exact
database name, and refuses every non-empty target without modifying it. There
is no in-script replace mode. Objects are restored without their original
owners and grants, so they belong to the restoring role (`nyabase`), which is
the role the Backend connects as. The logical archive and this helper do not
preserve database-level ACL, comments, or `ALTER DATABASE` settings; the
shipped Compose database has none.

### Restoring production

To put a backup back into service (disaster recovery, or rolling back an
upgrade), restore into a new database and swap names while the Backend is
stopped. The replaced database stays in place until you drop it:

```bash
docker compose --env-file .env stop backend
docker compose --env-file .env exec -T postgres \
  psql -U nyabase -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE nyabase_restored TEMPLATE template0'
NYABASE_PG_TARGET_URL=postgresql://nyabase@postgres:5432/nyabase_restored \
  pg_ops restore-logical \
    --input "/backups/$backup_name" \
    --confirm-database nyabase_restored
docker compose --env-file .env exec -T postgres \
  psql -U nyabase -d postgres -v ON_ERROR_STOP=1 \
  -c 'ALTER DATABASE nyabase RENAME TO nyabase_replaced' \
  -c 'ALTER DATABASE nyabase_restored RENAME TO nyabase'
# Check out / build the Backend release the backup was taken with, then:
docker compose --env-file .env up -d --build backend
```

Start the Backend release whose migrations match the backup (see **Upgrading
the Backend**); a newer one migrates the restored database forward on boot, an
older one refuses to start. Once readiness and the panel check out, drop
`nyabase_replaced`.

### Physical base backups and PITR

The shipped Compose PostgreSQL keeps the image's default `pg_hba.conf`:
replication connections are accepted only from inside the container
(`127.0.0.1`/`::1`, `trust`), not over the `control-plane` network. Run the
base backup in the `postgres` container's network namespace so it connects
over loopback (no password is used there). The `nyabase` role created by the
image is a superuser and already has `REPLICATION`:

```bash
base_name="base-$(date -u +%Y%m%dT%H%M%SZ)"
PG_OPS_NETWORK="container:$(docker compose --env-file .env ps -q postgres)" \
NYABASE_PG_SOURCE_URL=postgresql://nyabase@127.0.0.1:5432/nyabase \
  pg_ops base-backup --output-dir "/backups/$base_name"
pg_ops verify-base --input-dir "/backups/$base_name"
```

To take base backups over the network instead (from another host or a
dedicated least-privilege role with `REPLICATION`), add a
`host replication <role> <network> scram-sha-256` line to `pg_hba.conf` in the
`postgres-data` volume and reload PostgreSQL; the default Compose setup does
not do this.

`base-backup` streams WAL and runs `pg_verifybackup` before success, so the
result is a consistent standalone copy of the cluster. Point-in-time recovery
additionally needs every WAL segment archived continuously to a separate
failure domain, and the shipped Compose PostgreSQL does **not** archive WAL
(`archive_mode` is off): PITR is not available until you configure
`archive_mode` and an `archive_command`/`archive_library` for your storage.
Then alert on archive failure and on WAL archive age exceeding the declared
RPO, and retain at least one verified base backup older than the RPO window.
Storage-specific archive transport and retention belong to the deployment
platform; do not pretend a local Compose volume provides either.

After configuring archiving, prove the chain instead of checking configuration
text alone:

```bash
pg_ops pitr-archive-probe \
  --output "/backups/pitr-probe-$(date -u +%Y%m%dT%H%M%SZ).txt" \
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

For physical PITR, provision a new empty cluster using the same PostgreSQL
major, verify the base backup, copy it into that stopped cluster's `PGDATA`
(owned by the server's uid, `999` in the `postgres` image, mode 0700),
configure `restore_command` for the off-host WAL archive and set the required
`recovery_target_time`, then start it isolated from application traffic.
Promote only after schema compatibility, row-count/application invariants, and
the desired recovery timestamp are verified.

### After a restore

After restoring a database that is older than the hosts' state, every
container and volume created after the backup is an orphan: its instances are
stopped by the next full scan and everything is deleted 7 days later. Within
those 7 days, decide per orphan (recreate the row, or copy data out and let it
go); `control.orphan_sightings` lists them with `first_seen_at`.

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

### VictoriaMetrics

VictoriaMetrics backup must use `vmbackup` against an instant snapshot and copy
it to object storage or another host. `vmrestore` is an offline operation:
stop VictoriaMetrics, restore into its data path, then start it.

### Lost `ssh.keyEncryptionSecret`

Restore `config.yaml` from the same backup set as the database whenever
possible. If the secret is gone (or a restore paired the database with a new
one), nothing else breaks, but the encrypted keys are unrecoverable:

- **SSH proxy**: rotate the proxy host key from the admin SSH proxy page
  (rotation does not need the old key). Users see a new host key fingerprint.
- **Container host certificates**: the reconciler logs that a user's host CA
  cannot be decrypted and stops issuing certificates (existing ones keep
  working). Use **重置容器证书 CA** on the admin SSH proxy page: every user gets a
  new CA and every active container is queued for a new certificate. Users must
  copy the new `@cert-authority` line from their profile.
- **HTTP proxy**: snapshots skip every domain pool whose key no longer
  decrypts and log `TLS key cannot be decrypted`; its sites keep serving plain
  HTTP and fail HTTPS until the certificate and key are uploaded again.

## Upgrades

### Upgrading the Backend

The schema lives in `packages/backend/src/platform/persistence-pg/migrations/`.
With `DB_MIGRATIONS_RUN=true` (the Compose default) every Backend boot takes a
PostgreSQL advisory lock, applies the pending migrations in order (each in its
own transaction), and only then serves traffic; with `false` it refuses to
boot while any migration is pending. Every boot also checks that the applied
migrations are exactly a prefix of the ones it ships, with matching checksums.
After launch, migrations are append-only: a released migration is never
edited, and a CI test pins each released file's checksum.

1. Take and verify a logical backup (see **Logical backups**) immediately
   before the upgrade, and keep it with the release record.
2. Check out the new release, then rebuild and restart only the Backend:
   `docker compose --env-file .env up -d --build backend`.
3. Watch `docker compose --env-file .env logs -f backend` for
   `Applied N PostgreSQL migration(s)` and confirm
   `curl --fail http://127.0.0.1:3001/api/health/ready`.

There is no down-migration. A Backend from before a migration does not start
on a database that has it applied (`Applied migration … is missing from the
application`), so rolling back across a new migration means restoring the
pre-upgrade backup (see **Restoring production**) and starting the previous
release on it. Changes made between the upgrade and the restore are lost, and
hosts may hold containers or volumes created in that window (they become
orphans; see **After a restore**). A rollback within the same migration set
is just checking out and rebuilding the previous release.

A database created by a pre-launch build is not upgradable to the launch
build: before launch the single baseline migration was edited in place, so its
checksum no longer matches (`Applied migration 000001_initial no longer
matches its SQL file`). Recreate it: stop the stack, remove the
`postgres-data` volume (`docker compose --env-file .env down` then
`docker volume rm nyabase_postgres-data`), start again, and re-enroll the
servers. Incus instances and volumes created by the old database are orphans
to the new one; clean them up on the hosts.

### Data services

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

Run the read-only PostgreSQL preflight before a major upgrade (with `pg_ops`
from **Backup and restore contract**):

```bash
pg_ops upgrade-preflight \
  --target-major 19 \
  --output "/backups/pg19-preflight-$(date -u +%Y%m%dT%H%M%SZ).txt"
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
- Behind the TLS edge, set `server.trustedProxies` (`TRUSTED_PROXIES`) to the
  address the Backend sees the proxy connect from (see **TLS edge**; under
  Compose that is the `edge` network, not loopback). Without it every login
  appears to come from the proxy, so one client exhausting the per-address
  login limit blocks sign-in for everyone. Never trust a range that end users
  can send from directly. The proxy must overwrite, not append to, an
  untrusted inbound `X-Forwarded-For`.
- The panel is browser-only: there are no API tokens or API keys, and the only
  credential the HTTP API accepts is the browser session's short-lived access
  JWT (refreshed through the `HttpOnly` refresh cookie). Changing a password,
  an administrator resetting it, or disabling the user deletes their refresh
  sessions in the same transaction and invalidates outstanding access tokens.
  SSH public keys are kept across a password change; adding one requires the
  current password, and removing unknown keys is up to the user.
- Open browser consoles (`/ws/console`) are bound to the browser session that
  opened them. They close with WebSocket code `4401` when that session logs
  out (in any tab) or is revoked for refresh-token reuse, and when their user
  is disabled or deleted, changes role, or changes (or has reset) their
  password. A console never outlives its credential: before the access token
  expires the browser must re-authenticate it with a fresh token of the same
  session, otherwise it closes with `4408`.
- Login throttling is deliberately not per account, so nobody can lock a known
  user (or `admin`) out: failures are limited only per (client address,
  username) and per client address (IPv4 address or IPv6 /64, 10 and 30 per
  5 minutes), plus the global Argon2 concurrency gate shared out per IPv4
  address or IPv6 /48 (`iam/login-throttling.ts`). A distributed set of source
  addresses can therefore still make many guesses per second against a known
  username, and can saturate the gate so that legitimate logins get `429`.
  Give every admin and operator account a long random password (a password
  manager's generated secret, not a memorable one).
- SSH public keys are globally unique: adding a key that any account already
  holds fails with `409 SSH_KEY_IN_USE` without revealing the owner.
- Browser sessions keep the refresh secret in the `__Host-nyabase_refresh`
  cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`; the `__Host-`
  prefix stops sibling subdomains from overwriting it). Plain-HTTP development
  with `auth.cookieSecure=false` uses `nyabase_refresh` on `/api/auth`. The access token
  lives only in tab memory, and nothing credential-bearing is written to web
  storage. `/api/auth/login`, `/refresh`, and `/logout` require the
  `X-Nyabase-Auth: 1` header, which cross-site pages cannot send without a
  CORS preflight. Serve the SPA from the same site as the API (the bundled
  frontend does); a frontend on another site cannot use the cookie session.
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
  mechanism used by the target environment; do not commit either file. The
  exception is `ssh.keyEncryptionSecret`: it encrypts data at rest and has no
  in-place rotation (see the backup contract).
- Audit retention (`audit.retentionDays`, `audit.retentionMaxEntries`) is
  admin-only in the system settings page and cannot be set below 30 days or
  10,000 entries (0 disables that limit), so an operator cannot purge the trail.
- Each user holds at most 32 HTTP bindings and 64 active-or-draining hostnames.
  Operators can delete any user's binding from the HTTP proxy page
  (`DELETE /api/http-proxy/bindings/:id?scope=all`).
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
`iam.effective_server_access` / `iam.effective_pool_access` / `iam.effective_shared_backend_access` 按 (用户, 资源) 合并
**当前有效**（未过期）的授权，且只含 active 用户：配额逐项取最大（任一为 NULL 即不限；0 不是不限，数据库 CHECK
要求配额 `> 0`），GPU 白名单取并集，到期取最晚（任一不设期限则不过期）。所有授权判断只读这些视图，没有授权缓存。

用户失去覆盖（授权到期、删除授权、移出组、删除组、用户被禁用）后立即进入同一条 14 天宽限流程，撤销不会被拒绝：

- 台账 `control.access_lapses`（`user_id, resource_kind, resource_id, lapsed_at, stopped_at, purged_at`）记录宽限。
  `lapsed_at` 恒为检测时刻（处理器开台账行的那一刻），之后不再变化，不从原授权的 `expires_at` 倒推。
- 宽限开始即处置（`stopped_at` 记第一次处置时间）：
  - 服务器：停止该用户在其上运行中的容器；
  - 数据盘池 / 共享后端：把该用户在其上的卷从所有容器卸载（运行中的容器热拔，容器本身不停也不删）。
  若之后处置被绕过（管理员用 `scope=all` 又启动了容器或又挂上了卷），每轮都会再次处置。宽限内不能新建、启动、挂载。
- 宽限期满（清除前在 IAM 锁下复核覆盖）：清除该用户在该资源上的资源（写 `purged_at`）；服务器 = 容器 + 本地卷，
  数据盘池 = 池上的卷，共享后端 = 后端上的卷（挂载过这些卷的容器保留）。清除后该用户在该资源上已无资源，台账行即被删除。
- 宽限内覆盖恢复（重新授权或重新启用用户）：台账行被删除，宽限取消；已停机的容器不会自动启动，已卸载的卷需要用户手动重新挂载。
- 处理器每分钟运行一次，并在 IAM 写操作与用户状态变更提交后立即唤醒；每个 (用户, 资源) 用 `reconcile_claims`
  租约（`resource_type = access_lapse`）串行。
- 用户被禁用与撤销走同一条流程：其名下资源按检测时刻开宽限、立即停机，14 天后清除。删除账号仍要求其名下没有任何资源
  （`USER_HAS_RESOURCES`）。
- 管理员（仅 admin 角色，因为会删除卷）可对某用户在某服务器上的资源手动清除：
  `POST /api/users/:userId/servers/:serverId/purge-resources`。

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
4. 凭据泄露时：重新签发（`POST /api/servers/:id/agent-enrollment`，即轮换）
   只换接入令牌，**不会**吊销当前的 `nyak.…` 凭据；旧凭据一直有效，直到新令牌
   被 `POST /api/agent/enroll` 兑换成功。要立即吊销，签发新令牌后马上在该主机上
   按第 3 步用它完成接入：兑换成功的那一刻旧凭据失效、旧连接被断开。主机已不可用时
   改为删除该服务器（还有容器 / 本地卷时需要 `?force=true`，见上文删除服务器的说明）。

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
sudo install -d -m 0755 /etc/nyabase   # the proxy user must read a CA file kept here
sudo tee /etc/nyabase/agent.env >/dev/null <<ENV
NYABASE_BACKEND_URL=https://nyabase.example.com
NYABASE_AGENT_ENROLLMENT_TOKEN=<控制台显示的一次性令牌>
# NYABASE_BACKEND_CA_FILE=/etc/nyabase/backend-ca.pem   # 私有 CA 时
ENV
sudo chmod 0600 /etc/nyabase/agent.env
sudo systemctl daemon-reload
sudo systemctl enable --now nyabase-agent
```

`NYABASE_BACKEND_URL` 必须是 `https://`（经 TLS 边缘）；只有 Backend 主机为 loopback
（`localhost`、`127.0.0.0/8`、`::1`）时才接受 `http://`，否则 agent 拒绝启动。设置
`NYABASE_BACKEND_CA_FILE` 时也必须是 `https://`。

unit 以 `nyabase-agent` 用户运行，附加 `incus-admin` 组（访问 Incus socket），
只保留 `CAP_NET_ADMIN`（维护 `nyabase_guard`、读取 `bridge incus`）。需要 Node.js 20+。
`nvidia-smi` 需要 `video`/`render` 组时自行追加 `SupplementaryGroups`。

### 指标

Backend 的 `NodeMetricsScrapeService` 每 15 秒经控制连接请求一次
`metrics.collect`（主机、cgroup、GPU、nft 与 IPv6 拦截状态），写入 VictoriaMetrics
并更新服务器的 `metricsHealth`。agent 断开时服务器标记为 `unreachable`，重连后
自动恢复并刷新 CPU 拓扑、GPU 与存储池清点。agent 一直连着、但 reconcile 因 Incus 超时等把服务器标成
`unreachable` 时，Backend 经 agent 按退避（15 秒起、翻倍、最长 5 分钟）探测 Incus，成功即恢复 `online`
并触发全量扫描，不需要人工干预。

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
