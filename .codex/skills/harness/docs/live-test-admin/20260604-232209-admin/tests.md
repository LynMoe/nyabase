# Admin Live-Test Report

## Scope

Administrator-side live-test lane: local service preflight, admin login, agent/server registration/deployment, administrator fixture setup (users/images/grants), admin UI smoke screenshots, and issue classification. Product code was not edited.

## Commands Executed

| Step | Command | Result | Log |
| --- | --- | --- | --- |
| Runtime fingerprint | manual `ps`/`ss`/`curl`/artifact guard probes | captured | `artifacts/preflight-fingerprint.txt`, `artifacts/preflight-http.txt` |
| Smoke | `bash test/scripts/run-live-suite.sh smoke` | passed: `/auth/me` allowed 401, frontend HTML, VM health OK, admin login OK | `artifacts/smoke.log` |
| Register agents | `node test/scripts/register-agents.mjs` | passed: CPU/GPU server rows created | `artifacts/register-agents.log` |
| Deploy agents | `bash test/scripts/deploy-agents.sh` | passed: both product server rows online; script logged remote `mv` warnings | `artifacts/deploy-agents.log` |
| Admin setup | `NYABASE_MURT_RUN_ID=adminlane-20260604t152325z bash test/scripts/run-live-suite.sh admin-setup` | Vitest passed 1/1; users/images/grants created; state manifest written | `artifacts/admin-setup.log`, `artifacts/state.json` |
| API post-check | admin API summary and image status probes | passed API reads; image presence false on both servers | `artifacts/admin-post-summary.txt`, `artifacts/image-status.log` |
| UI smoke | `node artifacts/admin-ui-probe.cjs` | passed login and `/users`, `/images` render | `artifacts/admin-ui-probe.log`, `artifacts/ui/*.png` |
| Final guard | common generated-artifact guard + backend/frontend log tails | no generated artifacts found under `packages/common/src` | `artifacts/final-guards-and-logtails.txt` |

## Runtime Fingerprint

- Backend API: `http://localhost:3001/api`
- Frontend: `http://localhost:5173`
- VictoriaMetrics: `http://127.0.0.1:8428` (`OK`)
- SQLite DB: `test/runtime/db/nyabase-test.db`
- Backend PID: `2934288`, argv `node -r tsconfig-paths/register dist/main.js`
- Frontend PID: `2934372` launcher / Vite listener PID `2934387`
- Admin account used: `admin` / configured `ADMIN_INIT_PASSWORD` from `test/config/local.env` (password not recorded in artifacts except env/runbook context)
- Common source artifact guard: empty output.

## Created / Verified Resources

### Servers

| Key | Server ID | Name | Status |
| --- | --- | --- | --- |
| CPU | `1b9c08fa-32e1-4943-8dc5-d83772cd52f9` | `nyabase-test-cpu` | online |
| GPU | `343488f6-2689-488a-8bf8-8c02caf25989` | `nyabase-test-gpu` | online |

Agent metadata/secrets:
- Non-secret metadata: `test/runtime/agents/servers.json`
- Secret token/config files: `test/runtime/agents/agent-secrets.json`, `test/runtime/agents/configs/*.yaml`

### Admin fixture

- Run ID: `adminlane-20260604t152325z`
- Run prefix: `murt-adminlane-20260604t152325z`
- State manifest: `test/runtime/murt/adminlane-20260604t152325z/state.json`
- Credential env files: `test/runtime/murt/adminlane-20260604t152325z/{alpha,beta,gamma,delta,epsilon}.env`

Users:

| Persona | User ID | Username | Effective access |
| --- | --- | --- | --- |
| alpha | `a93b9b4c-04d9-4a37-9424-b8f6d0f2ba40` | `murt-adminlane-20260604t152325z-alpha` | CPU + cpuA |
| beta | `c8c5c54c-d90f-4f8b-b148-2a5b936796b0` | `murt-adminlane-20260604t152325z-beta` | CPU + cpuB |
| gamma | `1a522967-1864-415d-8cbc-34c8f21bb35d` | `murt-adminlane-20260604t152325z-gamma` | GPU index 0 + gpuA |
| delta | `1b35bc0d-a3f7-4e4d-99fe-645f28127bc2` | `murt-adminlane-20260604t152325z-delta` | CPU + cpuA; GPU index 1 + gpuA |
| epsilon | `d8a22bcc-0b49-4218-b657-cf13e9a55d53` | `murt-adminlane-20260604t152325z-epsilon` | no servers; inactive image grant only |

Images:

| Label | Image ID | Name | Active | Docker image |
| --- | --- | --- | --- | --- |
| cpuA | `1108d8a3-dfb0-48fa-8d6a-4411d3040723` | `murt-adminlane-20260604t152325z-cpu-a` | true | `ubuntu:24.04` |
| cpuB | `088e0e01-188e-43f8-8248-15ca1c707ccc` | `murt-adminlane-20260604t152325z-cpu-b-same-ref` | true | `ubuntu:24.04` |
| inactive | `cd581249-b745-49f1-8dc6-3f9e8154f2e2` | `murt-adminlane-20260604t152325z-inactive` | false | `ubuntu:24.04` |
| gpuA | `175e174d-ff66-4976-98cf-e442d71472bf` | `murt-adminlane-20260604t152325z-gpu-a` | true | `ubuntu:24.04` |

## UI Evidence

Screenshots inspected:

- `artifacts/ui/admin-dashboard.png`
- `artifacts/ui/admin-users.png`
- `artifacts/ui/admin-images.png`

Objective notes:

- Login successfully authenticated to admin shell.
- `/users` displayed user management inventory and action buttons.
- `/images` displayed image management inventory and action buttons.
- Screenshot `admin-dashboard.png` captured while still visually on the login form despite side-nav showing authenticated state; see issue LT-ADMIN-UI-001.

## Failures / Gaps / Classifications

1. `env-drift:test-fixture-mount-sources-missing`
   - Evidence: admin setup state reports no local data disk source and no remote FS mount assigned to CPU server; mount-source grants for alpha/beta/delta were skipped.
   - Impact: administrator user/image/grant flow passed, but mount-source admin setup is partial; mount-source persona tests may be blocked or less meaningful until data disks/remote mounts are configured.
   - Evidence files: `artifacts/admin-post-summary.txt`, `artifacts/state.json`.

2. `env-drift:image-not-present-on-agents`
   - Evidence: `GET /api/images/:id/status` returned `present:false` for all fixture images on both online servers.
   - Impact: admin image row creation works, but user container creation with these images may depend on pull-on-create behavior or later explicit image pull. If user flow expects pre-pulled images, run image pull first.
   - Evidence file: `artifacts/image-status.log`.

3. `infra/script-warning:deploy-agents-remote-mv`
   - Evidence: `deploy-agents.sh` logged `mv: cannot stat '/tmp/nyabase-agent'` and related warnings on both hosts, but services ended active and product rows came online.
   - Impact: likely harmless due shell/stdin/heredoc sequencing or stale command behavior, but confusing and may hide real deployment-copy failures.
   - Evidence file: `artifacts/deploy-agents.log`.

4. `product-or-test-bug:admin-ui-login-route-transition`
   - Evidence: UI probe waited for URL not ending `/login`; screenshot shows authenticated side-nav but central login form still visible/focused. Later `/users` and `/images` rendered correctly.
   - Impact: possible root-route/auth redirect or screenshot timing issue; investigate with frontend route state and auth layout.
   - Evidence files: `artifacts/admin-ui-probe.log`, `artifacts/ui/admin-dashboard.png`.

5. `test-artifact-noise:prior-fixtures-present`
   - Evidence: `/users` count 17 and `/images` count 10; previous `murt-*` and `murtc-*` resources are present in the shared DB.
   - Impact: This lane used an exact run prefix and did not broad-clean. User/admin UI lists include old fixtures, so screenshots are not isolated.

## Recommended Repair Work

- Architect/devops: define desired mount-source baseline for live tests (local pquota disk and remote FS mount) and add preflight assertions/auto-provisioning or clear blocked status before admin setup.
- Developer: inspect `test/scripts/deploy-agents.sh` SSH/heredoc sequence and make remote copy/move failures fail loudly or eliminate benign `mv` warnings.
- Developer/tester: investigate frontend authenticated root route after login; ensure URL transition and rendered content agree before screenshots/tests assert success.
- Devops/tester: decide whether admin setup should explicitly pull images for later user container flows, or document that user flow performs pull/create lazily.
- Tester: add exact-prefix cleanup/reporting for shared DB fixture noise, or reset local DB before full live-test orchestration when isolation is required.

## Cleanup Ledger

No cleanup was performed because created resources are intended for downstream user-side tests. Use exact prefix `murt-adminlane-20260604t152325z` and state manifest `test/runtime/murt/adminlane-20260604t152325z/state.json` for later cleanup.
