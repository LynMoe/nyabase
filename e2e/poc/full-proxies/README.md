# Full proxy isolation PoC

This fixture proves the production Rust SSH and HTTP proxy binaries outside the
shared E2E provider. It deliberately owns a separate Docker network, dynamic
loopback ports, run labels, and a private per-run directory.

The control fixture is a minimal WSS protocol peer. It authenticates the proxy
token, sends the same snapshot envelopes as Backend, records ACK/status frames,
and can contract both route snapshots. The data plane is not mocked:

- the current-worktree `nyabase-ssh-proxy` release binary fronts a real OpenSSH
  server and is exercised by real `ssh` and `sftp` clients;
- the current-worktree `nyabase-http-proxy` release binary fronts a separate
  HTTP/WebSocket workload and is exercised by curl and the repository's real
  `ws` client;
- snapshot contraction must terminate already-established SSH and WebSocket
  sessions and reject new routes.

Proxy containers run as uid/gid 65532 with a read-only root filesystem, all
capabilities dropped, `no-new-privileges`, bounded CPU/memory/PID limits, a
0600 token file, and an explicit private CA for `wss://control:8443`.

Run the complete PoC:

```bash
bash e2e/poc/full-proxies/run.sh
```

Prerequisites are Docker, Cargo, Node.js, OpenSSL, curl, and OpenSSH clients.
Cargo is resolved from `PATH`; an absolute override can be supplied with
`NYABASE_FULL_PROXY_POC_CARGO`.

The lifecycle is also callable independently by the main provider:

```bash
export NYABASE_FULL_PROXY_POC_RUN_ID=full-proxy-poc-example
bash e2e/poc/full-proxies/up.sh
bash e2e/poc/full-proxies/probe.sh
bash e2e/poc/full-proxies/down.sh
```

Sanitized evidence is written below
`e2e/.runtime/<run-id>/full-proxies/`. Secret material lives only in its
`private/` child and is deleted by `down.sh`. Cleanup is label-scoped and also
removes the derived images and network.

This PoC does **not** replace the Full profile against the production Backend.
It closes the binary/container/protocol feasibility risk; the Full suite must
still prove Backend-generated snapshots, public proxy APIs, status DTOs, TLS
domain pools, and all authorization personas.
