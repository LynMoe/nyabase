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

1. Refuses to start when another nyabase agent unit is active (or activating) on a lab
   host: the agent owns the host-wide `bridge nyabase_firewall` table, one agent per host.
   Then creates `$E2E_RUN_ROOT/<run id>/` (mode 700) and points `$E2E_RUN_ROOT/current` at it.
2. Builds `@nyabase/backend` and `@nyabase/agent` (`tsc -b`, including `@nyabase/common`) and the Rust
   proxies (`cargo build --release --locked`), then installs this package's deps.
3. Creates the database `nyabase_e2e_<run id>` on `E2E_PG_URL`.
4. Generates the JWT, key-encryption, ssh-proxy, http-proxy secrets and the admin
   password into `run.env` (mode 600).
5. Starts the built backend (`dist/main.js`, one process, clean environment,
   `NYABASE_CONFIG_FILE` pointing at a missing file so the host's own config is never
   read) and waits for `/api/health/ready`; the first boot creates `admin`.
6. Starts `nyabase-ssh-proxy` and `nyabase-http-proxy` on the configured ports.
7. `lib/bootstrap.ts servers`: logs in as admin and registers every server; each
   response carries a one-time agent enrollment token (written to `enroll.env`).
8. Starts a run-scoped agent on every lab host: the same self-contained bundle an
   operator installs (`scripts/build-agent-bundle.sh`, from what step 2 built) goes to
   `/var/tmp/nyabase-e2e-agent-<run id>-s<n>/` and runs as the transient systemd unit
   of the same name. The agent dials the
   backend; for a remote host through an ssh reverse tunnel (`ssh -R`, loopback port
   `E2E_AGENT_TUNNEL_PORT`, default 13901) so the backend can stay on loopback. It
   enrolls with its token and keeps its credential in that directory.
9. `lib/bootstrap.ts finish`: waits for every agent to connect, then per server
   discovers and registers the configured pool and makes it the system pool; creates
   one IP pool for all servers; creates the shared backend and registers its
   executors (optional); registers the catalog image and assigns it to every
   server; runs preflight on every server. Everything is written to `state.json`.

Logs and pid files are in the run directory (`backend.log`, `ssh-proxy.log`,
`http-proxy.log`). If `up` fails, read them and run `down`.

## What `down` does

Idempotent; safe after a failed or partial `up`, and safe to repeat.

1. Stops the three processes and the reverse tunnels. A pid file is only honoured
   when the process's environment carries this run's `E2E_RUN_ID`.
2. While the database still exists, saves to `resources.tsv` the run's server ids,
   container instance names and volume names.
3. On each lab host (`lib/lab-sweep.sh`, piped over ssh) it deletes only:
   instances (`nyc-*`, `nyabase-preflight-*`) whose Incus config
   `user.nyabase.server_id` is one of this run's server ids; custom volumes named
   exactly as the run's database recorded (`nyv-<32 hex>`); the run's agent unit and
   directory; and the agent's `bridge nyabase_guard` and `bridge nyabase_firewall`
   nft tables once no other nyabase agent runs on the host. Cached images and
   everything unlabelled stay.
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
| `01-auth-sessions` | login, refresh rotation, logout, no API tokens, password change, disabled user |
| `02-servers-preflight` | agent connected, enrollment token rules, agent socket auth, preflight, proxies |
| `03-images` | assignment status, user visibility, assignment removal |
| `04-container-lifecycle` | create, memory limit, root resize, power, SSH via ssh-proxy, console, delete |
| `05-local-volume` | create, attach, resize, detach, delete |
| `06-shared-volume` | one CephFS volume in uid-isolated containers on two servers (skipped without it) |
| `07-grant-bundles` | bundles per server: overrides, live bundle edits with preview, replace keeps data disks, GPU count picks cards |
| `08-lapse` | revoke = immediate grace and stop; purge after the grace; disable never purges |
| `09-http-proxy` | domain pool, binding, requests through the http-proxy |
| `10-gpu` | GPU enablement, claim, release (skipped without a GPU host) |
| `11-isolation` | another user's resources: 403 / 404 |
| `12-runtime-constraints` | per-user CPU sets, reserved CPUs, aggregate memory, uniform limits, isolated uid maps, IPv6 guard, drift revert |

The lapse purge is driven by moving `control.access_lapses.lapsed_at` 15 days into
the past in the run's database; production code has no test switch.
