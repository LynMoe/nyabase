# Live lab e2e

Scenario API tests against a real control plane and real Incus servers. Nothing
here runs in CI: CI only runs `pnpm e2e:check` (typecheck, `bash -n`, and a load
of the scenario files without executing them).

```bash
cp tests/e2e/lab.env.example tests/e2e/lab.env   # fill in the lab, see the comments
pnpm e2e:up                                      # build, start, register the lab
pnpm e2e:run                                     # all scenarios (or: pnpm e2e:run 04 lapse)
pnpm e2e:down                                    # remove everything the run created
```

Needs `psql`, `openssl`, `ssh`/`ssh-keygen`, `curl`, `node` 22, `pnpm` and `cargo`
on this machine, a PostgreSQL role with `CREATEDB`, ssh key access to the lab hosts
(as root, or a user that can run `incus`), and L3 reach from this machine to the
guest LAN (the proxies dial guests). Only one run exists at a time (fixed ports).

## What `up` does

1. Creates `$E2E_RUN_ROOT/<run id>/` (mode 700) and points `$E2E_RUN_ROOT/current` at it.
2. Builds `@nyabase/backend` and `@nyabase/node-exporter` (`tsc -b`, including `@nyabase/common`) and the Rust
   proxies (`cargo build --release --locked`), then installs this package's deps.
3. Creates the database `nyabase_e2e_<run id>` on `E2E_PG_URL`.
4. Generates the JWT, key-encryption, ssh-proxy, http-proxy secrets and the admin
   password into `run.env` (mode 600).
5. Reads each lab server's TLS certificate (`openssl s_client`), pins its sha256
   fingerprint and writes the bundle the backend uses as its Incus CA.
6. Starts a run-scoped node-exporter on every lab host (preflight reads the host
   network facts from it): the built `packages/node-exporter` plus `@nyabase/common`
   and `zod` are copied to `/var/tmp/nyabase-e2e-node-<run id>-s<n>/` and started
   as the transient systemd unit of the same name, with a fresh TLS certificate
   (pinned on the server) and token, on `E2E_NODE_EXPORTER_PORT` (default 19109).
7. Starts the built backend (`dist/main.js`, one process, clean environment,
   `NYABASE_CONFIG_FILE` pointing at a missing file so the host's own config is never
   read) and waits for `/api/health/ready`; the first boot creates `admin`.
8. Starts `nyabase-ssh-proxy` and `nyabase-http-proxy` on the configured ports.
9. `lib/bootstrap.ts`: logs in as admin, then per server registers it under its Incus `server_name`, mints a trust
   token with `incus config trust add` over ssh, connects it (`POST /servers/:id/connect`),
   discovers and registers the configured pool and makes it the system pool; creates
   one IP pool for all servers; creates the shared backend and registers its
   executors (optional); registers the catalog image and assigns it to every
   server; runs preflight on every server. Everything is written to `state.json`.

Logs and pid files are in the run directory (`backend.log`, `ssh-proxy.log`,
`http-proxy.log`). If `up` fails, read them and run `down`.

## What `down` does

Idempotent; safe after a failed or partial `up`, and safe to repeat.

1. Stops the three processes. A pid file is only honoured when the process's
   environment carries this run's `E2E_RUN_ID`.
2. While the database still exists, saves to `resources.tsv` the run's Incus client
   fingerprint, server ids, container instance names and volume names.
3. On each lab host (`lib/lab-sweep.sh`, piped over ssh) it deletes only:
   instances (`nyc-*`, `nyabase-preflight-*`) whose Incus config
   `user.nyabase.server_id` is one of this run's server ids; custom volumes named
   exactly as the run's database recorded (`nyv-<32 hex>`); the trust entry whose
   fingerprint is this run's Incus client certificate; the run's unused
   one-time trust token; and the run's node-exporter unit and directory. Cached images and everything unlabelled stay.
4. Only if every host was swept: drops the database and removes the run directory.
   Otherwise it exits non-zero and keeps both so you can re-run `down`.

## Scenarios (`scenarios/*.test.ts`)

Run by `node --test` through `tsx`, one file at a time, in order. Each creates its own
users and resources and removes them in `after`; whatever is left is swept by `down`.
`client/` holds the typed API client (`api.ts`), polling (`poll.ts`), run state,
a `psql` helper and the per-scenario `Harness` (`harness.ts`). Request and response
types come from `@nyabase/common`, so DTO drift fails `pnpm e2e:check`.

| File | Covers |
| :--- | :--- |
| `01-auth-sessions` | login, refresh rotation, logout, API tokens, password change, disabled user |
| `02-servers-preflight` | connect and preflight state, guards, proxies connected |
| `03-images` | assignment status, user visibility, assignment removal |
| `04-container-lifecycle` | create, limits, root resize, power, SSH via ssh-proxy, console, delete |
| `05-local-volume` | create, attach, resize, detach, delete |
| `06-shared-volume` | one CephFS volume in containers on two servers (skipped without it) |
| `07-authorization-merge` | user + group grants merge: max quotas, unlimited wins, GPU union |
| `08-lapse` | revoke = immediate grace and stop; purge after the grace; disable never purges |
| `09-http-proxy` | domain pool, binding, requests through the http-proxy |
| `10-gpu` | GPU enablement, claim, release (skipped without a GPU host) |
| `11-isolation` | another user's resources: 403 / 404 |

The lapse purge is driven by moving `control.access_lapses.lapsed_at` 15 days into
the past in the run's database; production code has no test switch.
