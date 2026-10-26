# nyabase

A control plane for Incus system containers: a single Backend process (HTTP API,
WebSocket gateways and reconcile workers) over PostgreSQL, a per-host
`nyabase-agent` that dials the Backend and fronts the local Incus socket behind a
fixed policy, and Rust SSH / HTTP edge proxies.

| Path | What it is |
|---|---|
| `packages/backend` | NestJS Backend (API, reconcilers, migrations) |
| `packages/frontend` | React / Vite web console, served by the Backend |
| `packages/agent` | Host agent (`nyabase-agent`) and its Incus request policy |
| `packages/common` | Shared types, protocols and zod schemas |
| `tools/` | `ssh-proxy`, `http-proxy` and `proxy-common` (Rust) |
| `deploy/` | Compose stack, Dockerfile, systemd units, operations runbook |
| `tests/e2e` | Live lab scenarios (not run in CI) |

## Toolchain

- Node.js 22 and pnpm as pinned in `package.json#packageManager` (`corepack enable`).
- Rust as pinned in `rust-toolchain.toml` (rustup installs it on first use).
- PostgreSQL 18 for the integration suites (`NYABASE_TEST_DATABASE_URL`).

## Common commands

```bash
pnpm install --frozen-lockfile
pnpm dev:backend            # tsc -b --watch + node --watch dist/main.js
pnpm dev:frontend           # Vite dev server, proxies /api and /ws to :3001
pnpm check                  # build, typecheck, lint, tests and proxies (CI also audits and builds the image)
pnpm build:agent-bundle     # the agent tarball installed on hosts
```

## Documentation

- [`AGENTS.md`](AGENTS.md): architecture rules and invariants enforced by tests.
- [`deploy/OPERATIONS.md`](deploy/OPERATIONS.md): deploying, upgrading, backups, the host agent.
- [`tests/e2e/README.md`](tests/e2e/README.md): the live lab e2e suite.
