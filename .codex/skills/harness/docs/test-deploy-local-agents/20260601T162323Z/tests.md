# Test Checklist

Session: `test-deploy-local-agents/20260601T162323Z`
Role: tester
Last updated: `2026-06-01T23:49:07Z`

Status values used by this checklist are `pending`, `running`, `pass`, `fail`, and `blocked`.

## Frontend Visual Coverage Expansion and Consolidated Current Status

Prepared: `2026-06-01T23:49:07Z`
Role: tester
Scope: frontend Playwright visual coverage and session test-record cleanup only. Product source, backend/common/agent source, scripts, configs, lockfiles, runtime services, remote hosts, API/DB/runtime state, and raw secrets were not edited. API state in the new visual tests is fully mocked in Playwright fixtures.

### Files Added or Updated

- Added `packages/frontend/e2e/management-routes.spec.ts`.
- Updated `packages/frontend/e2e/ROUTES.md`.
- Added visual baselines:
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/dashboard-user-gpu-memory.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/dashboard-container-gpu-memory.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/servers-management.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/images-management.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/users-management.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/containers-own.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/data-dirs-overview.png`
  - `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/remote-fs-management.png`

### Commands and Results

| Command | Exit code | Result | Counts | Notes |
| --- | ---: | --- | --- | --- |
| `bash scripts/check-visual.sh` | `1` | expected bootstrap/test-selector failure | `4` passed / `8` failed / `0` skipped | Existing visual tests passed. New spec initially had test selector strictness issues for hidden native `option` text/repeated chart legend labels, and missing new baselines. Root cause: test/baseline. |
| `bash scripts/check-visual.sh` | `1` | expected baseline bootstrap failure | `8` passed / `4` failed / `0` skipped | After selector fixes, remaining failures were missing baselines for dashboard user/container, users, and containers screenshots. Root cause: baseline. |
| Fresh render inspection | n/a | pass | `8` new route/state screenshots inspected | At default `1366x900` shipped viewport, dashboard user/container GPU memory charts and management route renders had readable labels/statuses with no visible overlap, clipping, or illegible text. |
| `pnpm --filter @nyabase/frontend exec playwright test --update-snapshots` | `0` | pass | `12` passed / `0` failed / `0` skipped | Promoted new baselines only after fresh-render inspection. |
| `bash scripts/check-visual.sh` | `0` | pass | `12` passed / `0` failed / `0` skipped | Determinism proof after snapshot promotion. HTML report path: `packages/frontend/e2e/.html-report/index.html`. |
| `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` | `0` | pass | `0` artifacts found | Common-src artifact guard returned no output after visual/test commands. |

### Coverage of Dispatch Acceptance Criteria

| AC | Status | Evidence |
| --- | --- | --- |
| 1. Dashboard `/` shows `用户维度` and `容器维度` GPU memory charts using positive user/container `gpuMemUsed` mocked API responses. | covered | `packages/frontend/e2e/management-routes.spec.ts` :: `dashboard user dimension shows GPU memory chart`; `dashboard container dimension shows GPU memory chart`; screenshots `dashboard-user-gpu-memory.png`, `dashboard-container-gpu-memory.png`. |
| 2. Core management display routes `/servers`, `/images`, `/users`, `/containers`, `/data-dirs`, `/manage/remote-fs` have pragmatic visual coverage with stable mocked API fixtures and key label/status assertions. | covered | `packages/frontend/e2e/management-routes.spec.ts` route tests and screenshots `servers-management.png`, `images-management.png`, `users-management.png`, `containers-own.png`, `data-dirs-overview.png`, `remote-fs-management.png`. |
| 3. `packages/frontend/e2e/ROUTES.md` has rows for every new route/state and screenshot path. | covered | Route coverage ledger updated with authenticated dashboard user/container states and six management routes. |
| 4. `bash scripts/check-visual.sh` run, new baselines promoted after fresh render inspection, then rerun deterministic. | covered | Commands table above: final `bash scripts/check-visual.sh` passed `12/0/0` after `--update-snapshots`. |
| 5. No baselines promoted for visible overlap/clipping/illegible text. | covered | Fresh render inspection passed before snapshot promotion; no product visual failure found. |
| 6. Session `tests.md` includes frontend visual coverage commands, counts, screenshots, and AC mapping. | covered | This section. |
| 7. Consolidated checklist status supersedes stale historical pending rows for items now proven by later PASS sections, while preserving genuine gaps. | covered | The consolidated table below supersedes the initial historical inventory table under `## Checklist`; historical rows remain audit history, not current status. |
| 8. Common-src artifact guard remains clean after visual/test commands. | covered | Guard command returned no output after visual runs. |
| 9. Visual artifacts are listed for PM/user visual acceptance. | covered | Visual artifact list above and final report list. |

### Consolidated Current Checklist Status

This table supersedes the initial historical `## Checklist` inventory rows below. Those older rows were created before later live/API/visual evidence existed, so their `pending` cells are no longer authoritative when contradicted here.

| ID | Current status | Superseding evidence | Remaining explicit gap |
| --- | --- | --- | --- |
| ENV-001 | pass | Local VictoriaMetrics `/health` and `/api/v1/query?query=up` returned HTTP `200` in final probes and GPU proof runs. | None. |
| ENV-002 | pass | Backend unauthenticated `/api/auth/me` repeatedly returned HTTP `401`; backend accepted admin/API/agent flows. | None. |
| ENV-003 | pass-with-remediation | Frontend root returned HTTP `200` after documented Vite remediation; later final probes also returned HTTP `200`. | Monitor for recurrence only. |
| ENV-004 | pass | Common-src generated artifact guard returned `0`/no output after build, test, visual, deploy, and final proof commands, including this dispatch. | None. |
| ENV-005 | pass | `bash scripts/check.sh` passed in final automated checks: common/backend/agent/frontend typecheck, lint with warnings only, unit suites, and common-src guard. | None. |
| ENV-006 | pass | Visual suite passed `12/0/0` after this dispatch, expanding from the earlier `4/0/0` visual baseline. | None. |
| AGT-001 | pass | CPU agent deployed; `nyabase-agent` and `nyabase-docker.service` active; journal showed `[WS] Connected`; backend reported CPU online. | None. |
| AGT-002 | pass | CPU backend detail/daemon status and VM/backend host metrics were present after deployment. | None. |
| AGT-003 | pass | GPU agent deployed; `nyabase-agent` and `nyabase-docker.service` active; backend reported GPU online; managed Docker exposed NVIDIA runtime. | None. |
| AGT-004 | pass | Host `nvidia-smi` and backend `/api/servers/:gpuId/gpus` matched four NVIDIA L40 GPUs by index/UUID/model/memory. | None. |
| AGT-005 | pass | VM `nyabase_gpu_util_ratio` and backend GPU metrics returned per-GPU utilization series. | None. |
| AGT-006 | pass | VM `nyabase_gpu_mem_used_bytes` and backend GPU metrics returned per-GPU memory series. | None. |
| AGT-007 | pass | VM `nyabase_gpu_temp_celsius` and backend GPU metrics returned per-GPU temperature series. | None. |
| AGT-008 | pass | VM `nyabase_gpu_power_watts` returned four samples; later clock proof returned `nyabase_gpu_clock_graphics_mhz` in VM and non-empty backend `graphicsClockMHz.points`; visual route shows `图形时钟 (MHz)`. | None. |
| AGT-009 | pass | GPU pquota remediation proof produced positive VM `nyabase_gpu_proc_mem_used_bytes` with `container_id`, `user_id`, and `gpu_uuid`, plus backend container/user `gpuMemUsed.points`. | None. |
| AGT-010 | pass | Restricted CPU container create/delete succeeded with correct owner labels and no residual Docker/API rows. | Broader CPU lifecycle is covered under BCK-015. |
| AGT-011 | pass | After GPU Docker root pquota remediation, restricted GPU container create succeeded on GPU `0`; cleanup delete removed product/API/Docker residuals. | None for create/delete; GPU shell/force-delete remain separate workflow coverage. |
| AGT-012 | pass for CPU force-delete path | CPU shell/force-delete run deleted a still-running restricted-owned CPU container through product API; backend/API state and managed Docker no longer showed the container. | GPU force-delete not exercised in this CPU-only dispatch. |
| AGT-013 | pass for CPU shell stream | CPU console WS authenticated, streamed `whoami`, `pwd`, and run id output, emitted EOF `0`, and closed cleanly. | GPU shell attachment not exercised. |
| AGT-014 | pass for CPU XFS quota evidence | CPU `/data` pquota enforcement and restricted-owned writable-layer hard-limit proof passed; later local mounted data-dir over-limit enforcement also passed. | None for CPU evidence targeted here. |
| AGT-015 | pass for same-owner local sharing | XFS live verification recorded two same-owner containers mounting `/mnt/share`; marker written in one was read/appended by the other and read back in the first. | None for same-owner visibility. |
| AGT-016 | pending / gap | No later live evidence proves cross-user local mount isolation beyond general container permission checks. | Execute a focused cross-user local data-dir/mount isolation test if this remains required. |
| AGT-017 | pass for CPU NFS host lifecycle | NFS run `nfs-live-20260601t222329z` registered a temporary CPU export, status became mounted, and host/export read-write passed. | GPU NFS host lifecycle intentionally not touched. |
| AGT-018 | pass for CPU NFS container mount | Restricted user created remote data dir/container; product mount patch returned `200`; `/mnt/nfs` visible as `nfs4`; export/container read-write passed; cleanup residuals none. | None for CPU NFS container behavior targeted here. |
| BCK-001 | pass | Auth/API token baseline passed with unauth `401`, admin login/me/refresh, token create/use/delete, and deleted-token rejection. | None. |
| BCK-002 | pass | Admin user lifecycle create/list/get/patch/SSH key/delete passed; cleanup removed test users. | None. |
| BCK-003 | pass | Restricted user management negatives and self-update/password policy checks passed. | None. |
| BCK-004 | pass | CPU container owner detail allowed; second restricted user denied cross-owner detail. | None. |
| BCK-005 | pass | Over-CPU and disallowed GPU index requests returned `400`; CPU disk quota hard-limit proof passed; GPU positive create later passed after pquota remediation. | None for current evidence. |
| BCK-006 | pass | Grant-only user saw only granted image and ungranted image detail returned `403`. | None. |
| BCK-007 | pass | User with grants saw CPU/GPU servers; user without grants saw zero servers and CPU detail `404`. | None. |
| BCK-008 | pass for API lifecycle | Admin image create/list/get/patch active/inactive/delete passed; image pull intentionally deferred because host-local images were already present. | Optional pull/progress batch if product image-pull UX is required. |
| BCK-009 | pass | Server create/detail/defaults/self-check and disposable token regenerate/delete passed; live agents came online with masked tokens. | None. |
| BCK-010 | pass for active CPU token lifecycle | Active CPU token regeneration returned `201`; stale-token WS probe closed `4003`; restarted agent with regenerated token reconnected; GPU remained online/unchanged. | GPU active token lifecycle not rotated. |
| BCK-011 | pass | Host/GPU VM/backend series passed; later GPU pquota proof produced positive VM/backend container/user GPU memory attribution. | None. |
| BCK-012 | pass | API-backed GPU user/container metrics passed; visual coverage now shows dashboard `用户维度` and `容器维度` GPU memory charts plus server GPU clock/container memory UI. | None. |
| BCK-013 | pass | CPU/GPU local disk REST registration checks passed; non-XFS/root rejection covered; stale in-use disk blocker was cleaned and deletion succeeded after exact stale mount cleanup. | Future broader in-use negative can be repeated if desired. |
| BCK-014 | pass | CPU remote FS create/list/get/patch/remount/mounted/delete, in-use delete/unassign guards, and dynamic NFS container mount read-write passed. | None for CPU remote storage path. |
| BCK-015 | pass | CPU container create/list/detail/stats/exec/stop/start/restart/mounts/delete passed; CPU shell stream and force-delete passed; GPU create/delete and GPU memory stats passed in pquota proof. | GPU shell/force-delete not exercised. |
| BCK-016 | pass | Group capabilities, membership, server/image/mount-source grants, effective access, and restricted negative checks passed. | None. |
| BCK-017 | pass | Restricted audit request returned `403`; admin audit returned recent rows after representative actions. | None. |

## Focused Live GPU Metrics API Attribution Proof

Prepared: `2026-06-01T23:17:25Z`
Role: devops
Scope: focused live GPU container workload proof for backend `/api/metrics/servers/:gpuId/containers` and `/api/metrics/servers/:gpuId/users` GPU memory series attribution. Product source, tests, repo configs, scripts, lockfiles, visual baselines, DB rows, service configs, agent tokens, and git history were not edited. Raw auth/JWT/API/refresh/agent tokens are not recorded.

Run ID: `gpuapi-20260601t231316z`
GPU server: `db1112fe-1c55-4314-9511-6d8510c523c2`
GPU host: `lyn@10.8.1.12`

### Commands and Results

| Command/procedure | Exit/status | Result | Evidence |
| --- | ---: | --- | --- |
| `node --input-type=module <<'NODE' ... focused GPU metrics API proof harness ... NODE` | `1` | fail-env/precondition, cleaned | Preflight passed: backend unauthenticated `/api/auth/me` returned `401`; VictoriaMetrics `/health` returned `200`; admin login returned `200`; GPU server was `online`; backend reported Docker socket `/run/nyabase-agent/docker.sock`, Docker state `active`, version `29.0.2`; `/api/servers/:gpuId/gpus` returned `4` GPUs and GPU index `0` was `GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19` (`NVIDIA L40`, `46068` MiB). Remote GPU host preflight passed: `nyabase-agent` and `nyabase-docker.service` were both `active`; `nvidia-container-runtime` was `/usr/bin/nvidia-container-runtime`; managed Docker `ubuntu:22.04` image id prefix was `sha256:86f1a8d7b38e`; `docker run --rm --gpus device=0 ubuntu:22.04 nvidia-smi -L` printed `GPU 0: NVIDIA L40`. Product API created disposable restricted user `gpuapi20260601t231316z` id `09c6bfbb-99f2-434e-b5b9-d6709e1514de`, disposable image `46473fb6-8903-4afd-b228-1069a1772c13` for `ubuntu:22.04`, user GPU server grant `0538867c-1144-4142-96d9-db2c4c7bee28` with `gpuMode=indices`, `gpuIndices=[0]`, and image grant `5a3a94fe-22bd-46de-a71d-13807a4a5613`; restricted login returned `200`. Restricted `POST /api/containers` failed before any live workload with HTTP `502`: the GPU agent rejected writable-layer project quota assignment because `/data0` is mounted with `noquota` and XFS project quota accounting/enforcement are off for `/data0/nbTest/nyabase-docker`. Therefore no target product GPU container, no VM `nyabase_gpu_proc_mem_used_bytes{container_id=...}` sample, and no backend container/user `gpuMemUsed.points` proof could be produced in this run. |
| GPU host quota/root probe after failed create | `0` | blocker confirmed | `findmnt -T /data0/nbTest/nyabase-docker -o TARGET,FSTYPE,OPTIONS -n` reported `/data0 xfs rw,...,noquota`. A runtime `sudo mount -o remount,prjquota /data0` attempt completed but `findmnt` still reported `noquota`; `xfs_quota -x -c "state -p" /data0` did not report project quota accounting/enforcement on. Agent config still uses `dockerRoot: "/data0/nbTest/nyabase-docker"`. All GPU host XFS mounts inspected (`/`, `/data0`, `/data1`, `/fast0`) reported `noquota`. |
| Cleanup and residual scan for `gpuapi-20260601t231316z` | `0` | pass | Cleanup deleted the disposable image grant, server grant, image record, and restricted user through the product API. Exact Docker run-id scan on managed Docker returned `0`; `/tmp/*gpuapi-20260601t231316z*` returned `0`; exact failed overlay `/etc/projects` entries for Docker overlay id `19a704c0ebdbbdc9b81832e1803654146b4dfe5f3d618316314a5240d9e8df04` returned `0`; temporary `/etc/projects.nyabase-gpuapi-cleanup.*` backups returned `0`. Product API residual scan found users `0`, images `0`, and containers `0` for the run id. GPU `nyabase-agent` and `nyabase-docker.service` remained `active`; backend still reported GPU `online` and Docker state `active`. |
| Final service/common probes after cleanup | `0` | pass | Backend unauthenticated `/api/auth/me` returned `401`; frontend `/` returned `200`; VictoriaMetrics `/health` returned `200`; VictoriaMetrics query endpoint with `query=up` returned `200`; common-src generated artifact guard count was `0`. |

### Acceptance Criteria Impact

| Acceptance item | Status | Evidence |
| --- | --- | --- |
| 1. Backend, VM, GPU agent, managed Docker, NVIDIA runtime, and `ubuntu:22.04` image available | pass | All preflight checks passed, including `docker run --rm --gpus device=0 ubuntu:22.04 nvidia-smi -L` on managed Docker. |
| 2. Disposable restricted user/grants/image and running GPU container as that user | fail-env/precondition | User, image, GPU server grant, and image grant were created through product API, but restricted `POST /api/containers` returned `502` because the GPU Docker root is on `/data0` mounted with `noquota`; the current agent fail-closes writable-layer quota assignment. |
| 3. Container has GPU index `0` and can run workload | not reached | No product container was created. |
| 4. VM `nyabase_gpu_proc_mem_used_bytes{server,container_id}` positive sample with `user_id` and `gpu_uuid` | not reached | No target container/workload existed. |
| 5. Backend `/api/metrics/servers/:gpuId/containers?range=...` positive `gpuMemUsed.points` for target container | not reached | No target container/workload existed. |
| 6. Backend `/api/metrics/servers/:gpuId/users?range=...` positive `gpuMemUsed.points` for owner user | not reached | No target container/workload existed. |
| 7. Backend container detail/stats positive `stats.gpuMemUsedMiB` keyed by GPU UUID | not reached | No target container/workload existed. |
| 8. Cleanup residual scan | pass | API records, Docker run-id matches, helper artifacts, exact failed overlay `/etc/projects` entries, and cleanup backups all returned `0`. |
| 9. Service/common probes after cleanup | pass | Backend `401`, frontend `200`, VM health/query `200`, common-src artifact guard `0`. |

### Checklist Impact

| ID | Status | Evidence | Remaining gap |
| --- | --- | --- | --- |
| AGT-009 | fail-env/precondition for this dispatch | The exact restricted-user product API path could not create a GPU container because GPU host `/data0` is mounted with `noquota`; therefore live per-container GPU memory attribution could not be generated. | Re-run after GPU Docker root is on an XFS mount with project quota accounting/enforcement enabled, or after the runtime environment is otherwise aligned with the agent's fail-closed quota requirement. |
| Batch 9 API evidence | fail-env/precondition for live container/user GPU memory API proof | Backend/VM/GPU runtime preflight passed and disposable grants were created, but no live workload existed because product container create failed before Docker state became usable. | Need a successful restricted-owned GPU container workload, then capture non-empty `/api/metrics/servers/:gpuId/containers` and `/api/metrics/servers/:gpuId/users` `gpuMemUsed.points`. |
| BCK-011 | pass for preflight host/GPU availability; fail-env/precondition for live container/user GPU memory series | VM and backend baseline services were available; the focused container/user GPU memory series proof could not be produced because container creation failed on host quota precondition. | Same as AGT-009. |
| BCK-012/API-backed metric display evidence | fail-env/precondition for this dispatch | No backend container/user GPU memory API payload with positive series was produced, so API-backed display evidence remains missing. Visual screenshots were not in scope. | Re-run API proof after host quota precondition is fixed; UI/visual display remains a separate frontend/tester dispatch if required. |

### Verdict

GPU metrics API attribution: FAIL for this dispatch. Root cause: GPU host runtime precondition, `/data0` mounted as XFS with `noquota`, while the deployed agent fail-closes restricted product container creation when writable-layer project quota cannot be enforced. Cleanup: PASS, residuals none for `gpuapi-20260601t231316z`.

## CPU Live Shell Stream and Product Force-Delete Verification

Prepared: `2026-06-01T23:06:08Z`
Role: devops
Scope: focused CPU proof for live container shell streaming through the backend console WebSocket and product API deletion of a still-running container. Product source, tests, repo configs, scripts, lockfiles, visual baselines, DB rows, service configs, agent tokens, and git history were not edited. Raw auth/JWT/API/refresh/agent tokens are not recorded.

### Commands and Results

| Command/procedure | Exit/status | Result | Evidence |
| --- | ---: | --- | --- |
| `node --input-type=module <<'NODE' ... CPU shell/force-delete harness ... NODE` for `shellfd-20260601t230103z` | `1` | fail-procedure, cleaned | Preflight passed, then container create failed before Docker mutation because the request incorrectly sent `sshUid:0`; public schema requires `sshUid >= 1000`. Cleanup deleted the disposable image grant, server grant, image record, and restricted user. Residual scan found no matching Docker containers, API users, API images, or API containers. |
| `node --input-type=module <<'NODE' ... CPU shell/force-delete harness ... NODE` for `shellfd-20260601t230258z` | `1` | fail-procedure, cleaned | Restricted user and running container were created, Docker owner label matched, and console WS returned live shell output plus EOF/clean close. The harness assertion incorrectly rejected prompt-prefixed `pwd` output (`# /`). Cleanup deleted the container through the product API, removed exact Docker matches, and deleted the disposable image grant, server grant, image record, and restricted user. Residual scan found no matching Docker containers, API users, API images, or API containers. |
| `node --input-type=module <<'NODE' ... CPU shell/force-delete harness ... NODE` for `shellfd-20260601t230514z` | `0` | pass | Preflight proved backend unauthenticated `/api/auth/me` returned `401`, admin login worked, CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70` was reachable, CPU `nyabase-agent` and `nyabase-docker.service` were both `active`, managed Docker was `29.4.3` at `/data/nyabase-docker`, and managed Docker had `ubuntu:24.04` image id prefix `sha256:0b1ebe5dd42682bb8`. Product API created disposable image `9d2be0ca-dd6d-448b-965e-089c10dc7046`, restricted user `shellfd20260601t230514z` id `6ab74a20-c4d5-4a98-97f3-755851727dc0`, user CPU server grant `5852e639-2dd4-457c-823c-f3d3b35edb19` with `cpuMillis=500`, `memBytes=268435456`, `diskBytes=104857600`, `gpuMode=none`, and image grant `d9f5a5a5-d00a-4241-95d3-0674409ace52`. Restricted login succeeded; token not recorded. Restricted user created running CPU container `e8b438c1a74211b2a3f2be0626170f586b420c9a478e8daeca6510c9f568a4e1`; product API reported owner id `6ab74a20-c4d5-4a98-97f3-755851727dc0` and state `running`; remote managed Docker reported state `running`, name `/nyabase-6ab74a20-shellfd-20260601t230514z-ctr`, and `nyabase.owner_id=6ab74a20-c4d5-4a98-97f3-755851727dc0`. `POST /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/e8b438c1a74211b2a3f2be0626170f586b420c9a478e8daeca6510c9f568a4e1/exec` returned session `5035dc45-2fe6-43f4-a397-806e53935087`. Console WS `/ws/console?sessionId=...` authenticated with the restricted user's JWT in the first frame, sent `whoami`, `pwd`, `echo shellfd-20260601t230514z`, and `exit`, received data frames showing `root`, `/`, and the run id, then received `{type:"eof",exitCode:0}` and closed with code `1000` reason `Session ended`. While Docker still reported the container `running`, product API `DELETE /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/e8b438c1a74211b2a3f2be0626170f586b420c9a478e8daeca6510c9f568a4e1` returned HTTP `200` body `{"ok":true}`. This is the product force-delete path because `ContainersService.deleteContainer()` sends agent `deleteContainer` with `force:true`. After delete, product API list no longer contained the container, product detail returned `404`, and remote managed Docker `ps -a --filter id=...` returned no rows. Cleanup removed exact Docker matches if any, image grant, server grant, image record, and restricted user. |
| Independent residual/service scan for `shellfd-20260601*` | `0` | pass | Managed Docker `ps -a --filter name=shellfd-20260601` returned no rows. Product API scan found API users `0`, images `0`, and containers `0` for the run prefix. Backend unauthenticated `/api/auth/me` returned `401`; frontend `/` returned `200`; VictoriaMetrics `/health` returned `200`; common-src generated artifact count was `0`. |

### Checklist Impact

| ID | Status | Evidence | Remaining gap |
| --- | --- | --- | --- |
| AGT-012 | pass for CPU product force-delete path | Run `shellfd-20260601t230514z` deleted a still-running restricted-owned CPU container through `DELETE /api/containers/:serverId/:dockerId`; the backend service path sends agent `deleteContainer` with `force:true`; API returned `200`, product list/detail no longer showed the container, and remote managed Docker no longer showed the Docker id. | GPU force-delete remains outside this CPU-only dispatch. |
| AGT-013 | pass for CPU shell attachment and live stream | `POST /api/containers/:serverId/:dockerId/exec` returned a session id; console WS authenticated with the restricted user's JWT as the first frame, streamed output for `whoami`, `pwd`, and `echo shellfd-20260601t230514z`, emitted EOF exit code `0`, and closed cleanly with code `1000`. | GPU shell attachment remains outside this CPU-only dispatch. |
| BCK-015 | pass for CPU shell plus force-delete subset | Restricted user created a CPU container with explicit server/image grants, API and Docker both showed owner/running state, exec shell stream passed, and product force-delete removed the running container from both backend/API state and managed Docker. Cleanup residuals: none. | Full GPU positive lifecycle remains optional/future; CPU start/stop/restart/stats already have earlier REST evidence. |

### Verdict

CPU shell-stream: PASS. CPU force-delete: PASS. Cleanup: PASS, residuals none.

## Final Automated Checks and Service Probes

Prepared: `2026-06-01T22:47:07Z`
Role: devops
Scope: final DoD automated checks and read-only service/common probes after live NFS, BCK-010 token lifecycle, and restricted-user XFS writable-layer quota evidence passed. Product source, tests, repo configs, scripts, lockfiles, runtime service configs, visual baselines, API data, DB rows, remote hosts, and git history were not edited. Raw tokens/secrets are not recorded.

### `scripts/check.sh` Summary

Command: `bash scripts/check.sh`
Exit code: `0`
Backend typecheck: pass
Backend lint: pass with warnings
Backend tests: `73/0/0`
Frontend typecheck: pass
Frontend lint: pass with warnings
Frontend tests: skipped by `scripts/check.sh`; this workspace script runs common/backend/agent unit suites
Frontend visual: skipped
Failing output tail: none
Status: GREEN

Additional `scripts/check.sh` evidence:

- Workspace typecheck passed for common, backend, agent, and frontend.
- ESLint exited `0` with `12` warnings and `0` errors.
- Unit tests passed: common `36/0/0`, backend `73/0/0`, agent `53/0/0`.

### `scripts/check-visual.sh` Summary

Command: `bash scripts/check-visual.sh`
Exit code: `0`
Frontend visual: pass
Report path: `packages/frontend/e2e/.html-report/index.html`
Diff artifacts: none
Status: GREEN

Visual evidence: Playwright passed `4/0/0` on Chromium:

- `e2e/gpu-metrics.spec.ts`: server GPU metrics graphics clock chart.
- `e2e/gpu-metrics.spec.ts`: container detail positive GPU memory rows.
- `e2e/login.spec.ts`: login page visual baseline.
- `e2e/login.spec.ts`: unauthenticated home redirects to login.

### Final Service and Common Probes

| Probe | Expected | Actual | Status |
| --- | ---: | ---: | --- |
| Backend `GET /api/auth/me` unauthenticated | `401` | `401` | pass |
| Frontend `GET /` | `200` | `200` | pass |
| VictoriaMetrics `GET /health` | `200` | `200` | pass |
| VictoriaMetrics `GET /api/v1/query?query=up` | `200` | `200` | pass |
| Common-src generated artifact guard | `0` | `0` | pass |

### Verdict

Final automated checks: GREEN. Visual suite: GREEN. Service probes: PASS. Common-src guard: PASS.

## Restricted CPU Writable-Layer XFS Quota Verification

Prepared: `2026-06-01T22:43:58Z`
Role: devops
Scope: focused live CPU proof that a container created as a restricted/non-admin user has its Docker writable layer charged to the intended XFS project quota. Product source, tests, repo configs, scripts, lockfiles, visual baselines, DB rows, agent tokens, and git history were not edited. Raw auth/JWT/API tokens are not recorded.

### Commands and Results

| Command/procedure | Exit/status | Result | Evidence |
| --- | ---: | --- | --- |
| `node --input-type=module <<'NODE' ... restricted CPU XFS writable-layer harness ... NODE` for `xfswl-20260601t223747z` | `1` | fail-procedure, cleaned | Preflight passed and the restricted-owned container reached `running`, but the harness parsed the container DTO incorrectly and did not extract `spec.dockerId`. Cleanup then deleted the exact container, image grant, server grant, image record, and user. Follow-up residual scan for this run found zero matching Docker containers, paths, project/projid lines, API users, API images, and API containers. |
| `node --input-type=module <<'NODE' ... restricted CPU XFS writable-layer harness ... NODE` for `xfswl-20260601t224104z` | `1` | fail-procedure, cleaned | Correctly extracted Docker ID and inspected upper/work dirs, but the harness asserted the wrong Docker label key (`nyabase.ownerId` instead of `nyabase.owner_id`). Cleanup deleted the exact container, exact XFS project path lines, image grant, server grant, image record, and user. Follow-up residual scan for this run found zero matching Docker containers, paths, project/projid lines, API users, API images, and API containers. |
| `node --input-type=module <<'NODE' ... restricted CPU XFS writable-layer harness ... NODE` for `xfswl-20260601t224307z` | `0` | pass | Preflight proved CPU `/data` is `xfs` with `prjquota`, project quota Accounting `ON` and Enforcement `ON`; CPU `nyabase-agent` and `nyabase-docker.service` were `active`; managed Docker had `ubuntu:24.04`; backend reported CPU `online`. Product API created disposable active image `d1acb7e3-271d-4680-9166-8d57be843bb6` for `ubuntu:24.04` with `sleep 3600`, restricted user `xfswl260601t224307z` id `7b504445-848b-4d34-b26c-2a255a00b2e2`, user-scoped CPU server grant `1f83a4f3-bb14-4a23-959c-b0fface3af5a` with `diskBytes=20971520`, `gpuMode=none`, and image grant `1bd256fa-3342-4d31-bb7b-24253e6094e2`. Restricted login succeeded; token not recorded. Restricted user created running CPU container `3fb129295be26590d408f493212ab4e794b68aefe16b3f4c9856a32315362a92`; API owner id and Docker `nyabase.owner_id` label both matched the restricted user. Docker upper dir `/data/nyabase-docker/overlay2/9591c762a5a64192036b2331ae516eabc4d052b005f549360cfab8e1f8a2561b/diff` and work dir `/data/nyabase-docker/overlay2/9591c762a5a64192036b2331ae516eabc4d052b005f549360cfab8e1f8a2561b/work` both reported `fsxattr.projid = 10005` and project inheritance flag `P`; quota report showed `#10005 ... bhard 20480` KiB. In-container writable-layer 5 MiB write to `/root/writable-below.bin` succeeded with size `5242880`. In-container 40 MiB write to `/root/writable-over.bin` failed with `No space left on device`, `dd` rc `1`, and resulting size `15663104`, below the requested `41943040`. Final quota line for project `10005` showed used `20424` KiB, hard `20480` KiB. Cleanup deleted the container, exact Docker matches, exact XFS project path lines, image grant, server grant, image record, restricted user, and matching run-id paths. |
| Independent residual/service scan after all three runs | `0` | pass | For `xfswl-20260601t223747z`, `xfswl-20260601t224104z`, and `xfswl-20260601t224307z`: managed Docker containers `0`, matching `/data` or `/data/nyabase-docker` run paths `0`, matching `/etc/projects` lines `0`, matching `/etc/projid` lines `0`, matching API users `0`, images `0`, and containers `0`. Final run exact upper/work project lines were `0` and paths no longer existed. CPU backend status remained `online`; CPU services remained `active`/`active`; backend unauthenticated `/api/auth/me` returned `401`; frontend `/` returned `200`; VictoriaMetrics `/health` returned `200`; common-src generated artifact count was `0`. |

### Checklist Impact

| ID | Status | Evidence | Remaining gap |
| --- | --- | --- | --- |
| AGT-010 | pass for CPU restricted-user create/delete path | Run `xfswl-20260601t224307z` created a CPU container through the product API as a restricted user, verified it was running with the restricted owner id, then deleted it through cleanup with no residual Docker/API rows. | Broader lifecycle operations remain for AGT-010 if start/stop/restart are required separately. |
| AGT-014 | pass for CPU writable-layer XFS quota enforcement | Restricted-owned container upper/work dirs were assigned to XFS project `10005` with project inheritance and a 20 MiB hard limit; below-limit writable-layer write succeeded; over-limit writable-layer write failed with `No space left on device` and truncated below 40 MiB. | Mounted local data-dir sharing/quota remains separate if required; this dispatch targeted the previously inconclusive writable-layer path. |
| BCK-005 | pass for CPU disk quota enforcement on restricted-owned writable layer | User-scoped CPU grant had `diskBytes=20971520`; container was created as the restricted user; writable-layer over-limit write failed under that user's project quota. | CPU/memory/GPU over-quota cases remain outside this focused dispatch. |
| BCK-015 | pass for CPU restricted-user create/delete subset | Product API created the restricted user's running CPU container and cleanup deleted it; backend/agent state had no residual container row. | Full container lifecycle, shell, stats, restart/stop/start, and GPU coverage remain outside this focused dispatch. |

### Verdict

Writable-layer XFS quota: PASS for the focused restricted/non-admin CPU owner proof. Cleanup: PASS, residuals none.

## Active CPU Agent Token Lifecycle Verification

Prepared: `2026-06-01T22:33:35Z`
Role: devops
Scope: regenerated the existing active CPU server agent token through the product API, proved the stale token no longer authenticates a new agent WebSocket connection, reconfigured the CPU agent with the regenerated token, restarted the CPU service, and verified recovery. Product source, tests, repo configs, scripts, lockfiles, visual baselines, GPU token, DB rows, and git history were not edited. Raw auth/JWT/agent tokens are not recorded.

### Commands and Results

| Command/procedure | Exit/status | Result | Evidence |
| --- | ---: | --- | --- |
| `node --input-type=module <<'NODE' ... BCK-010 active CPU token lifecycle harness ... NODE` | `1` | no-op preflight failure | Initial run failed before token rotation because the root workspace could not resolve package `ws`; no API mutation or remote config write occurred. |
| `node --input-type=module <<'NODE' ... BCK-010 active CPU token lifecycle harness ... NODE` | `1` | no-op preflight failure | Second run failed before token rotation because remote Python was passed with unsafe SSH quoting; no API mutation or remote config write occurred. |
| `node --input-type=module <<'NODE' ... BCK-010 active CPU token lifecycle harness ... NODE` using backend package `ws` resolution and safe SSH quoting | `0` | pass | Captured current CPU token from `/etc/nyabase/agent.yaml` only in process memory; token was present, length `64`, and not logged. Admin login succeeded; pre-check reported CPU `online` and GPU `online`. `POST /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/regenerate-token` returned HTTP `201`; response token was present, length `64`, and differed from the old token. A direct new WebSocket probe to `/ws/agent` using the stale token opened then closed with code `4003` and reason `Invalid token`. The regenerated token was written to CPU `/etc/nyabase/agent.yaml`; readback matched the regenerated token by in-process comparison only. `systemctl restart nyabase-agent` succeeded; CPU `nyabase-agent` and `nyabase-docker.service` were `active`; recent CPU journal included `[WS] Connected`; backend reported CPU `online`; backend also reported GPU `online`. Backend unauthenticated `/api/auth/me` returned `401`; frontend `/` returned `200`; VictoriaMetrics `/health` returned `200`; common-src generated artifact count was `0`. |
| `ssh lyn@10.8.1.12 'systemctl is-active nyabase-agent nyabase-docker.service'` | `0` | pass | GPU host services remained `active` / `active`; GPU token was not regenerated or reconfigured. |

### Checklist Impact

| ID | Status | Evidence | Remaining gap |
| --- | --- | --- | --- |
| BCK-010 | pass for active CPU agent token lifecycle | Existing active CPU token was captured from remote config only in process memory; CPU token regeneration returned HTTP `201` with a present new token; a new WS auth attempt with the stale token closed with `4003 Invalid token`; CPU agent was reconfigured with the regenerated token, restarted, emitted `[WS] Connected`, and backend reported CPU `online`; `nyabase-docker.service` remained active; GPU remained online/unchanged. | None for the active CPU agent lifecycle targeted by this dispatch. |

### Verdict

BCK-010 active token lifecycle: PASS. Residuals/recovery: CPU online with regenerated token; GPU online/unchanged; no raw token values recorded.

## Agent Redeploy and Restricted CPU Live NFS Verification After Source Equivalence Fix

Prepared: `2026-06-01T22:24:26Z`
Role: devops
Scope: rebuilt the current standalone agent binary after the NFS source-equivalence fix, redeployed it to the existing CPU/GPU hosts, then reran the authoritative CPU live NFS remote filesystem/container-mount verification using a restricted non-admin user with product API grants. Product source, tests, configs, scripts, lockfiles, visual baselines, DB rows, and git history were not edited. Raw auth/JWT/agent tokens are not recorded.

### Build and Deployment Evidence

| Item | Status | Evidence |
| --- | --- | --- |
| Common-src guard before/after build | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no output; final guard count was `0`. |
| Agent binary build | pass | `bash scripts/build-agent-binary.sh` exited `0`; built `dist/nyabase-agent`, size `75987874` bytes, SHA-256 `234aaa8ac9a11afe93ab8e730c3be52d47372e3ebcb4eea97e18c21200f781f5`. |
| CPU deploy | pass | `root@10.8.96.91:/usr/local/bin/nyabase-agent` SHA-256 matched `234aaa8ac9a11afe93ab8e730c3be52d47372e3ebcb4eea97e18c21200f781f5`; `nyabase-agent` and `nyabase-docker.service` active; journal showed `[WS] Connected`; backend reported CPU server `online`, Docker `29.4.3`, root `/data/nyabase-docker`. |
| GPU deploy | pass | `lyn@10.8.1.12:/usr/local/bin/nyabase-agent` SHA-256 matched `234aaa8ac9a11afe93ab8e730c3be52d47372e3ebcb4eea97e18c21200f781f5`; `nyabase-agent` and `nyabase-docker.service` active; journal showed `[WS] Connected`; backend reported GPU server `online`, Docker `29.0.2`, root `/data0/nbTest/nyabase-docker`. |

### CPU NFS Live Verification

Run ID: `nfs-live-20260601t222329z`

| Acceptance item | Status | Evidence |
| --- | --- | --- |
| Temporary NFS export and remote FS lifecycle | pass | Local export `/srv/nfs-live-20260601t222329z` was exported to CPU host `10.8.96.91`; product API created remote FS `5a05d626-2863-4e38-931d-929459fa93ed`, list/get succeeded, metadata patch returned HTTP `200`, remount returned HTTP `204`, and CPU status became `mounted` at `/mnt/nfs-live-20260601t222329z`. |
| Host/export read-write | pass | CPU host wrote `host-to-export nfs-live-20260601t222329z` and the local export read it back; local export wrote `export-to-host nfs-live-20260601t222329z` and CPU host read it back. `findmnt` showed source `10.8.96.92:/srv/nfs-live-20260601t222329z`, `nfs4`, `vers=4.2`, `rw`. |
| Restricted user setup | pass | Admin API created disposable restricted user `nfsuser01t222329z` id `81178557-d587-415b-aeb7-1e7f29d78075`, image `31662e47-f2e9-4a65-a0da-f03745a6ad15` for `ubuntu:24.04`, CPU server grant `0fc4b046-12fc-4eee-be53-46ce58abb89c`, image grant `8d2a0b73-c178-4db2-931d-f805bf2d1335`, and remote mount-source grant `c6f7c9d2-29ed-4212-ba8d-d8b9cfcdf4e4`. Restricted login returned HTTP `200`; token not recorded. |
| Restricted data dir and container | pass | Restricted user created data dir `047fafd8-f1e8-4620-804f-6eab83a6eea3` with host path `/mnt/nfs-live-20260601t222329z/rw-nfslive20260601t222329z`; export directory appeared locally. Restricted user created running CPU container `af9ee7e404fe66b4fa77792daf8c080e151646138f42810225f499a0a680be5b` named `nfs-live-20260601t222329z-ctr`. |
| Product dynamic mount patch | pass | Restricted user `PATCH /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/af9ee7e404fe66b4fa77792daf8c080e151646138f42810225f499a0a680be5b/mounts` returned HTTP `200` with body `{"ok":true}`. |
| Container mount visibility | pass | `mount-helper list` for PID `2170574` reported `{"dst":"/mnt/nfs","src":"10.8.96.92:/srv/nfs-live-20260601t222329z/rw-nfslive20260601t222329z","fsType":"nfs4","options":"rw,relatime"}`. Inside the container, `/mnt/nfs` existed and `findmnt`/`mount` showed the same NFS4 source with `vers=4.2`, `rw`. |
| Container/export read-write | pass | Export-to-container read passed through `/mnt/nfs/export-to-container.txt`; container-to-export and container-to-host read-back passed through `/mnt/nfs/container-to-export.txt`. |
| In-use guards | pass | While the container mount row existed, remote FS delete returned HTTP `409` and CPU server unassign returned HTTP `409`. |
| Cleanup | pass | Removed container mount row, container, remote Docker exact matches, data dir, mount-source grant, image grant, server grant, image record, remote FS record, restricted user, CPU mount path, and local export. |
| Final probes | pass | Backend unauthenticated `/api/auth/me` returned `401`; frontend `/` returned `200`; VictoriaMetrics `/health` returned `200`; VictoriaMetrics `/api/v1/query?query=up` returned `200`; common-src guard count was `0`. |
| Residual scan | pass | Exact scan for `nfs-live-20260601t222329z` found no local exportfs entries, no `/etc/exports` lines, no `/srv/<run>` dir, no CPU mount or mountpoint dir, no matching managed Docker container, and no matching API remote FS/container/image/data-dir/user/grant rows. |

### Checklist Impact

| ID | Status | Evidence | Remaining gap |
| --- | --- | --- | --- |
| AGT-017 | pass for CPU remote NFS host lifecycle | Run `nfs-live-20260601t222329z` registered a temporary export through product API, assigned it to CPU, status became `mounted`, and host/export bidirectional read-write passed. | GPU NFS host lifecycle remains outside this CPU-only dispatch. |
| AGT-018 | pass for CPU remote NFS container mount | Restricted user with explicit grants created the remote data dir and running container; product mount patch returned HTTP `200`; `/mnt/nfs` was visible inside the container as `nfs4`; export-to-container and container-to-export/host read-write passed; cleanup left no residuals. | None for the CPU NFS container behavior targeted by this dispatch. |
| BCK-014 | pass for CPU remote storage lifecycle, in-use guards, and dynamic mount update | Remote FS create/list/get/patch/remount/mounted/delete lifecycle passed; in-use delete/unassign returned HTTP `409`; dynamic container mount update returned HTTP `200` and produced usable NFS IO. | None for CPU NFS remote storage path in this dispatch. |

### Verdict

Deployment: PASS. NFS live verification: PASS. Cleanup: PASS, residuals none.

## NFS-Backed Dynamic Container Mount Source Verification Follow-up

Prepared: `2026-06-01T22:17:06Z`
Role: tester
Scope: focused agent unit tests for NFS-backed dynamic container mount source verification. Only `packages/agent/src/commands/dispatcher.test.ts` and this test record were edited. Product source, backend/common/frontend source, scripts, configs, manifests, lockfiles, deploys, dev servers, Docker, SSH, API mutations, and visual snapshots were not touched.
Visual artifacts: n/a, agent logic only.

### Commands and Results

| Command | Result | Counts | Notes |
| --- | --- | --- | --- |
| `pnpm --filter @nyabase/agent exec vitest run src/commands/dispatcher.test.ts` | pass | 28 passed / 0 failed / 0 skipped; 1 test file passed | Focused dispatcher suite, including exact-source success, NFS canonical equivalence success/failure, unresolved host path failure, non-NFS mismatch failure, reconcile no-op equivalence, and fail-closed `proofFailure` assertions. |
| `pnpm --filter @nyabase/agent typecheck` | pass | 0 TypeScript errors | Agent typecheck exited 0. |
| `pnpm --filter @nyabase/agent test` | pass | 53 passed / 0 failed / 0 skipped; 4 test files passed | Full agent unit suite. |
| `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` | pass | 0 artifacts found | Common source artifact guard returned no output. |

### Added/Updated Test Coverage

| Acceptance criterion | Coverage |
| --- | --- |
| AC #1: Existing exact-source success for `applyContainerMount` still passes. | `packages/agent/src/commands/dispatcher.test.ts` :: `verifies applyContainerMount after mount-helper mount and acks success when destination and source match` now also asserts exact matches do not invoke host `realpath` or `/proc/mounts` proof logic. |
| AC #2: `applyContainerMount` succeeds when helper reports an NFS canonical source equivalent to a host NFS mount subpath. | `packages/agent/src/commands/dispatcher.test.ts` :: `acks applyContainerMount when an NFS canonical source matches the host mount plus suffix` uses mocked `realpath` and fresh `/proc/mounts` content for the live shape `/mnt/nfs-live-20260601t214626z/rw-nfslive20260601t214626z` versus `10.8.96.92:/srv/nfs-live-20260601t214626z/rw-nfslive20260601t214626z`. |
| AC #3: `applyContainerMount` fails when helper reports a different NFS server/export/suffix. | `packages/agent/src/commands/dispatcher.test.ts` :: `returns failed ack when an NFS canonical source has a different server or export suffix`. |
| AC #4: `applyContainerMount` fails when expected destination is absent. | `packages/agent/src/commands/dispatcher.test.ts` :: `returns failed ack when applyContainerMount verification cannot find the destination after mount-helper mount`, updated to assert `proofFailure=destination not present in mount-helper list`. |
| AC #5: `applyContainerMount` fails when expected host path cannot be resolved. | `packages/agent/src/commands/dispatcher.test.ts` :: `returns failed ack when the expected host path cannot be resolved`, and it asserts `/proc/mounts` is not read after `realpath` failure. |
| AC #6: `applyContainerMount` fails for non-exact local/non-NFS mismatch that cannot be proven equivalent. | `packages/agent/src/commands/dispatcher.test.ts` :: `returns failed ack for non-exact local sources backed by a non-NFS host mount`. |
| AC #7: `reconcileContainerMounts` treats an already mounted equivalent NFS-backed destination as satisfied. | `packages/agent/src/commands/dispatcher.test.ts` :: `treats an existing equivalent NFS-backed mount as reconciled without umount or mount` asserts the only helper calls are `list` operations and the ack succeeds. |
| AC #8: Existing dynamic mount fail-closed tests remain meaningful with new `proofFailure` context. | `packages/agent/src/commands/dispatcher.test.ts` :: `returns failed ack when applyContainerMount verification finds the destination with the wrong source` and `returns failed ack when reconcileContainerMounts verification still sees absent and mismatched mounts`, both updated to assert `proofFailure` details. |
| AC #9: Required agent verification commands and common-src guard run and pass. | All four commands in Commands and Results passed. |
| AC #10: Visual artifacts are n/a. | Visual artifacts: n/a, agent logic only. |

### Root Cause Classification

Verdict: PASS. Focused dispatcher coverage now verifies exact source preservation, NFS canonical source equivalence, NFS mismatch fail-closed behavior, unresolved host-path fail-closed behavior, non-NFS mismatch rejection, reconciliation no-op behavior for already equivalent NFS-backed mounts, and retained `proofFailure` context. No failing tests remain.

## Agent Redeploy and CPU Live NFS Container Verification After Dynamic Mount Fix

Prepared: `2026-06-01T21:47:33Z`
Role: devops
Scope: rebuilt current standalone agent binary, redeployed it to the existing CPU/GPU hosts, then reran CPU live NFS remote filesystem verification with container-level mount and read/write probes. Product source, tests, DB rows, and git history were not edited. API/auth tokens are not recorded.

### Build and Deployment Evidence

| Item | Status | Evidence |
| --- | --- | --- |
| Common-src guard before/after build | pass | `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no output; final guard count was `0`. |
| Agent binary build | pass | `bash scripts/build-agent-binary.sh` exited `0`; built `dist/nyabase-agent`, size `75983612` bytes, SHA-256 `3fc03f6a717df693f285da82ec0cc265c27b89777a94121ac69ce70c736179ba`. |
| CPU deploy | pass | `root@10.8.96.91:/usr/local/bin/nyabase-agent` SHA-256 matched `3fc03f6a717df693f285da82ec0cc265c27b89777a94121ac69ce70c736179ba`; `nyabase-agent` and `nyabase-docker.service` active; journal showed `[WS] Connected`; backend reported CPU server `online`, Docker `29.4.3`, root `/data/nyabase-docker`. |
| GPU deploy | pass | `lyn@10.8.1.12:/usr/local/bin/nyabase-agent` SHA-256 matched `3fc03f6a717df693f285da82ec0cc265c27b89777a94121ac69ce70c736179ba`; `nyabase-agent` and `nyabase-docker.service` active; journal showed `[WS] Connected`; backend reported GPU server `online`, Docker `29.0.2`, root `/data0/nbTest/nyabase-docker`. |

### CPU NFS Live Verification Runs

| Run | Exit code | Result | Evidence |
| --- | ---: | --- | --- |
| `nfs-live-20260601t214205z` | `1` | fail-closed | Product remote FS create/list/get/patch/remount succeeded and status became `mounted`; host/export bidirectional read-write passed. Product-created container `73b66dac1441a6fabe6bb704e17eeb23a563dc9913710728831fd69e1ff6dd9a` reached `running`, but `PATCH /api/containers/:serverId/:dockerId/mounts` returned HTTP `500`. CPU agent journal reported `Container mount verification failed after reconcileContainerMounts` with source mismatch: expected host path `/mnt/nfs-live-20260601t214205z/rw-nfslive20260601t214205z`, actual source `10.8.96.92:/srv/nfs-live-20260601t214205z/rw-nfslive20260601t214205z`, destination `/mnt/nfs`. Cleanup residuals: none. |
| `nfs-live-20260601t214435z` | `1` | procedure probe failed, cleanup pass | Same remote FS host lifecycle and HTTP `500` mount patch behavior reproduced. Follow-up direct mount probe was invalid because the shell snippet expanded `awk $5` under `set -u`; no authoritative container read/write evidence from this run. Cleanup residuals: none. |
| `nfs-live-20260601t214626z` | `1` | partial/fail-product | Product remote FS create/list/get/patch/remount succeeded and CPU status became `mounted`; host/export bidirectional read-write passed. Product-created data dir `rw-nfslive20260601t214626z` appeared on export/host; container `5b6cf72cc99918f365eabe98c1e571c77443740719504cdce9935dcd45a5c286` reached `running`. `PATCH /api/containers/:serverId/:dockerId/mounts` returned HTTP `500` because verification expected host path `/mnt/nfs-live-20260601t214626z/rw-nfslive20260601t214626z`, while `mount-helper list` reported source `10.8.96.92:/srv/nfs-live-20260601t214626z/rw-nfslive20260601t214626z`. Direct container inspection showed `/mnt/nfs` present as `nfs4`; export-to-container and container-to-export/host read-write both passed. In-use guards passed while the container mount row existed: remote FS delete HTTP `409`, server unassign HTTP `409`. Cleanup residuals: none. |

### Final Probes and Residuals

| Check | Result | Evidence |
| --- | --- | --- |
| Service probes | pass | Backend unauthenticated `/api/auth/me` returned `401`; frontend root returned `200`; VictoriaMetrics `/health` returned `200`. |
| Exact residual scan | pass | For run IDs `nfs-live-20260601t214205z`, `nfs-live-20260601t214435z`, and `nfs-live-20260601t214626z`: no local exportfs entries, no `/etc/exports` lines, no `/srv/<run>` dirs, no CPU mounts or mountpoint dirs, no matching managed Docker containers, and no matching API remote FS/container/image/data-dir rows. |
| Common-src guard | pass | Final guard count `0`; no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` files under `packages/common/src/**`. |

### Checklist Impact

| ID | Status | Evidence | Remaining gap |
| --- | --- | --- | --- |
| AGT-017 | pass for CPU remote NFS host lifecycle | Latest run `nfs-live-20260601t214626z` registered temporary export `/srv/nfs-live-20260601t214626z`, assigned remote FS `880fe903-eba1-4669-8ccd-3defdc2e320b` to CPU, status became `mounted` at `/mnt/nfs-live-20260601t214626z`, and host/export bidirectional read-write passed. | GPU host intentionally not touched for NFS in this narrow dispatch. |
| AGT-018 | fail for product dynamic container mount success semantics; pass for actual CPU container NFS visibility/read-write | New agent failed closed instead of returning false success: API patch returned HTTP `500` with agent/backend evidence of source mismatch. Direct inspection in the same run proved `/mnt/nfs` existed inside the container as `nfs4` with source `10.8.96.92:/srv/nfs-live-20260601t214626z/rw-nfslive20260601t214626z`; export-to-container and container-to-export/host writes passed. | Route to developer: verification compares requested host path to mount-helper's normalized NFS source, causing an otherwise usable NFS container mount to fail the product API response. |
| BCK-014 | partial/fail for dynamic mount response; pass for remote FS lifecycle and in-use guards | Remote FS create/list/get/metadata patch/remount/delete lifecycle passed; mounted status passed; in-use delete/unassign returned HTTP `409` while the container mount row existed. Dynamic container mount update endpoint returned HTTP `500` because agent verification reported source mismatch. | Fix or normalize container mount source verification for NFS bind/move mounts, then rerun expecting product `PATCH` success plus container read/write. |

### Verdict

Deployment: PASS. NFS live verification: FAIL-PRODUCT for API success semantics, with confirmed container-level NFS visibility/read-write and fail-closed source mismatch evidence. Cleanup: PASS, residuals none.

## Agent Dynamic Container Mount Post-Apply Verification

Prepared: `2026-06-01T21:26:43Z`
Scope: focused agent tests for `CommandDispatcher` dynamic container mount post-apply verification. Only `packages/agent/src/commands/dispatcher.test.ts` and this test record were edited. Product source, backend/common/frontend source, scripts, configs, manifests, lockfiles, deploys, dev servers, package installs, and visual snapshots were not touched.
Visual artifacts: n/a, agent logic only.

### Commands and Results

| Command | Result | Counts | Notes |
| --- | --- | --- | --- |
| `pnpm --filter @nyabase/agent exec vitest run src/commands/dispatcher.test.ts` | pass | 23 passed / 0 failed / 0 skipped; 1 test file passed | Focused dispatcher suite, including new dynamic container mount verification coverage. |
| `pnpm --filter @nyabase/agent typecheck` | pass | 0 TypeScript errors | Agent typecheck exited 0. |
| `pnpm --filter @nyabase/agent test` | pass | 48 passed / 0 failed / 0 skipped; 4 test files passed | Full agent unit suite. |
| `find packages/common/src -type f \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -print \| sort` | pass | 0 artifacts found | Common source artifact guard returned no output. |

### Added/Updated Test Coverage

| Acceptance criterion | Coverage |
| --- | --- |
| AC #1: `applyContainerMount` success path verifies list after mount and acks success when destination/source match. | `packages/agent/src/commands/dispatcher.test.ts` :: `verifies applyContainerMount after mount-helper mount and acks success when destination and source match`. |
| AC #2: `applyContainerMount` returns failed ack when destination is absent after mount-helper mount. | `packages/agent/src/commands/dispatcher.test.ts` :: `returns failed ack when applyContainerMount verification cannot find the destination after mount-helper mount`. |
| AC #3: `applyContainerMount` returns failed ack when destination source mismatches. | `packages/agent/src/commands/dispatcher.test.ts` :: `returns failed ack when applyContainerMount verification finds the destination with the wrong source`. |
| AC #4: `reconcileContainerMounts` returns failed ack when expected mount remains absent/mismatched after reconciliation. | `packages/agent/src/commands/dispatcher.test.ts` :: `returns failed ack when reconcileContainerMounts verification still sees absent and mismatched mounts`. |
| AC #5: Existing remove/no-running-container behavior remains covered or unaffected. | `packages/agent/src/commands/dispatcher.test.ts` :: `acks removeContainerMount without invoking mount-helper when the container is not running`; full dispatcher and agent suites passed. |
| AC #6: Agent typecheck exits 0; focused dispatcher tests pass; full agent tests pass; common-src guard clean. | All four commands in Commands and Results passed. |
| AC #7: `tests.md` records commands/results. | This section records commands, results, counts, AC coverage, and visual artifact status. |

### Root Cause Classification

Verdict: PASS. Focused dispatcher coverage now verifies post-mount list checks for success, missing destination, source mismatch, reconciliation verification failure, and no-op removal when a container is not running. No failing tests remain.

## CPU Live NFS Remote FS Verification

Prepared: `2026-06-01T21:08:31Z`
Scope: CPU-only live NFS verification using temporary local NFS exports and product API records. Product source/tests were not edited. GPU host and unrelated remote-fs paths were not touched.
Runs:
- `nfs-live-20260601T205811Z`: remote FS `b6d3764e-4c9e-4873-88b4-19e057d778db`, export `/srv/nyabase-nfs-live-20260601T205811Z`, CPU mount `/mnt/nyabase-nfs-live-20260601T205811Z`.
- `nfs-live-20260601T210336Z`: remote FS `9e6b37f3-672d-49bb-a2eb-c30f1074c498`, export `/srv/nyabase-nfs-live-20260601T210336Z`, CPU mount `/mnt/nyabase-nfs-live-20260601T210336Z`.

### Commands and Results

| Command | Exit code | Result | Evidence |
| --- | ---: | --- | --- |
| `node --input-type=module <<'NODE' ... NFS live API/SSH harness ... NODE` for `nfs-live-20260601T205811Z` | `1` | partial | Created temporary export for CPU host `10.8.96.91`, registered remote FS via `POST /api/system/remote-fs-mounts`, and product reported status `mounted` at `/mnt/nyabase-nfs-live-20260601T205811Z`. Host/export bidirectional writes passed: host wrote `host-to-export nfs-live-20260601T205811Z`, and export wrote `export-to-host nfs-live-20260601T205811Z`. Temporary data dir/container were created, but container mount polling timed out. Agent log showed mount-helper failed after cleanup ordering removed the host path: `open_tree(.../rw-nfslive20260601t205811z): No such file or directory`. |
| Corrective cleanup for `nfs-live-20260601T205811Z` | `0` | pass | Removed container `897fac60144cdc635cc9dca677c3242573ce00d7992aeed51a28416e595b70bf`, data dir/API artifacts, remote FS record, CPU mount path, local export dir, and exportfs state. |
| `node --input-type=module <<'NODE' ... corrected NFS live API/SSH harness ... NODE` for `nfs-live-20260601T210336Z` | `1` | partial | Created temporary export for CPU host `10.8.96.91`, registered remote FS `9e6b37f3-672d-49bb-a2eb-c30f1074c498`, and product reported status `mounted` at `/mnt/nyabase-nfs-live-20260601T210336Z` with NFS source `10.8.96.92:/srv/nyabase-nfs-live-20260601T210336Z`, `nfs4`, `vers=4.2`, `rw`. Host/export bidirectional writes passed: host wrote `host-to-export nfs-live-20260601T210336Z`, and export wrote `export-to-host nfs-live-20260601T210336Z`. API-created remote data dir `rw-nfslive20260601t210336z` appeared on the export/host mount. Product-created container `7524665636a6f3c1932e086d6e3cf37fa803918fe1f8ea65aed63d09a28adac8` reached `running`; explicit `PATCH /api/containers/:serverId/:dockerId/mounts` returned success; polling inside the container for `/mnt/nfs` timed out, so container read/write over NFS was not proven. |
| Ordered cleanup for `nfs-live-20260601T210336Z` plus final exact-artifact cleanup | `0` | pass | Removed API records/grants/container/data-dir/image/user for both run IDs where present; unmounted/removed CPU mount paths; restored `/etc/exports`; removed exportfs entries; removed local export dirs and backup files. Final residual scan reported `residuals=none`. |
| Service/common probes after cleanup | `0` | pass | Backend unauthenticated `/api/auth/me` returned `401`; frontend root returned `200`; VictoriaMetrics health returned `200`; common-src artifact guard returned no output. |

### Checklist Impact

| ID | Status | Evidence | Remaining gap |
| --- | --- | --- | --- |
| AGT-017 | pass for CPU remote NFS host lifecycle | Temporary export was reachable; product API remote FS records assigned to CPU reported `mounted`; CPU host mount existed and read/write to/from export succeeded. | GPU host intentionally not touched in this dispatch. |
| AGT-018 | fail for container-mounted NFS read/write | Restricted user grants, API data dir, running CPU container, and explicit container mount patch were created successfully, but `/mnt/nfs` did not become visible in the container before timeout. No container-side NFS read/write evidence exists. | Route to developer/tester for dynamic container mount reconciliation/mount-helper investigation. |
| BCK-014 | pass for CPU remote FS API mounted lifecycle; fail for container in-use/read-write path | Create/list/get-mounted/remount/update-style assignment path was exercised by create/remount status polling; in-use deletion guard was attempted only after container mount setup but second run did not reach the guard assertion because container mount timed out. Cleanup deleted remote records. | In-use deletion/unassignment blocking still needs a successful container mount or a separate focused API state setup. |

### Residual Status

Verdict: PARTIAL/FAIL-PRODUCT for AGT-018 container mount. No residual artifacts remain for the two run IDs above: no exportfs entries, no `/etc/exports` lines/backups, no local export dirs, no CPU mount paths, no matching Docker containers, no matching remote FS/image/user API records, no matching data-dir/list entries, and no common-src generated artifacts.

## Exact Historical Stale Mount Cleanup

Prepared: `2026-06-01T20:37:14Z`
Scope: one-time cleanup of the known historical residual for server `05cea385-d6ca-490a-a126-e00d0ae23b70`, disk `48e710c1-5e35-449b-bb04-9d085295a577`, path `/data`, label `xfs quota live xfsq-20260601t200755z`. Product source, tests, remote host state, and unrelated DB rows were not modified.
DB: `/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`
Backup: `/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db.pre-stale-mount-cleanup-20260601T203618Z.bak`

### Commands and Results

| Command | Exit code | Result | Evidence |
| --- | ---: | --- | --- |
| `sqlite3 ... "SELECT id,serverId,dockerId,containerName,sourceKind,sourceId,userId,dirName,containerPath,createIfMissing,createdAt,updatedAt FROM container_mounts WHERE serverId='05cea385-d6ca-490a-a126-e00d0ae23b70' AND sourceKind='local' AND sourceId='48e710c1-5e35-449b-bb04-9d085295a577' ORDER BY id;"` | `0` | pass | Found exactly 2 stale rows: `193cccb7-8914-40da-8a9d-47a4b8948e9c` for docker `bf30f7018a34f57ab65c20c1e5a7119f2c6715ce2a29066ccc2be0de95a7ec9f` / container `xfsq-20260601t200755z-c1`, and `92241fae-7565-47b1-94c9-41982c2ace76` for docker `8bf5513444ca8a45dc435a92d3cedd79fb2fdf77cea13e62a7c55ddde3c0c4ae` / container `xfsq-20260601t200755z-c2`. Both rows matched `sourceKind=local`, `sourceId=48e710c1-5e35-449b-bb04-9d085295a577`, `dirName=xfsq-20260601t200755z`, `containerPath=/mnt/share`, user `75f36ff6-307d-4bec-a0da-dc476ff7b462`. |
| `POST http://127.0.0.1:3001/api/auth/login` with `admin/admin123` | `0` | pass | HTTP `200`; token used only for product API verification/deletion. |
| `GET /api/containers?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70` | `0` | pass | HTTP `200`; `totalContainersOnServer=0`, `staleMatches=[]`. |
| `GET /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/<staleDockerId>` for both stale docker IDs | `0` | pass | Both product API lookups returned HTTP `404` `Container not found`. |
| `ssh root@10.8.96.91 'DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker ps -a --no-trunc --filter id=<staleDockerId> ...; docker ps -a --filter name=xfsq-20260601t200755z ...'` | `0` | pass | Managed Docker socket returned no rows for either stale docker ID and no rows for run-name filter `xfsq-20260601t200755z`. This was read-only verification. |
| `GET /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks` | `0` | pass | HTTP `200`; target disk was present before cleanup with `mountPoint=/data`, label `xfs quota live xfsq-20260601t200755z`, `pquotaEnabled=true`. |
| `sqlite3 nyabase.db ".backup '<backup>'"` | `0` | pass | Created DB backup before mutation: `nyabase.db.pre-stale-mount-cleanup-20260601T203618Z.bak`. |
| `BEGIN IMMEDIATE; DELETE FROM container_mounts WHERE serverId='05cea385-d6ca-490a-a126-e00d0ae23b70' AND sourceKind='local' AND sourceId='48e710c1-5e35-449b-bb04-9d085295a577' AND id IN (...) AND dockerId IN (...) AND containerName IN (...); SELECT changes(); COMMIT;` | `0` | pass | Deleted exactly `2` rows. Predicate included the specified server/disk/source filters plus the two exact row IDs, docker IDs, and container names. |
| `DELETE /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks/48e710c1-5e35-449b-bb04-9d085295a577` | `0` | pass | Product API returned HTTP `204`. |
| `sqlite3 ... "SELECT COUNT(*) FROM container_mounts ...; SELECT COUNT(*) FROM data_disks ...;"` | `0` | pass | Post-cleanup counts were `0` matching `container_mounts` rows and `0` matching `data_disks` rows. |
| `GET /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks` after deletion | `0` | pass | HTTP `200`; target disk count `0`, disk list empty. |
| `GET /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70` | `0` | pass | HTTP `200`; server status `online`; docker daemon state `active`, socket `/run/nyabase-agent/docker.sock`, version `29.4.3`, storage driver `overlay2`. |
| `curl http://127.0.0.1:3001/api/auth/me; curl http://127.0.0.1:5173/; curl http://127.0.0.1:8428/health` | `0` | pass | Backend reachable with expected unauthenticated HTTP `401`; frontend root HTTP `200`; VictoriaMetrics health HTTP `200`. |
| `ssh root@10.8.96.91 'test -S /run/nyabase-agent/docker.sock && docker info --format "{{.ServerVersion}} {{.Driver}}"'` | `0` | pass | CPU VM reachable; managed socket present; Docker info returned `29.4.3 overlay2`. |
| `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -print \| sort` | `0` | pass | Common source artifact guard returned no output after cleanup. |

### Residual Status

Verdict: PASS. No matching residual `container_mounts` rows remain for disk `48e710c1-5e35-449b-bb04-9d085295a577`, and the disk is absent from both product API and `data_disks`. No unrelated DB cleanup was performed.

## Backend Stale Mount Cleanup on Container Delete

Prepared: `2026-06-01T20:23:20Z`
Scope: focused backend tests for stale `container_mounts` cleanup after successful product API container deletion. Product source, agent/common/frontend source, scripts, configs, manifests, lockfiles, installs, builds, deploys, dev servers, and visual snapshots were not touched.
Visual artifacts: n/a, backend logic only.

### Commands and Results

| Command | Result | Counts | Notes |
| --- | --- | --- | --- |
| `pnpm --filter @nyabase/backend exec vitest run src/containers/__tests__/container-delete-mount-cleanup.test.ts` | pass | 6 passed / 0 failed / 0 skipped; 1 test file passed | Focused stale mount cleanup tests. |
| `pnpm --filter @nyabase/backend test` | pass | 73 passed / 0 failed / 0 skipped; 9 test files passed | Full backend unit suite. |
| `pnpm --filter @nyabase/backend typecheck` | pass | 0 TypeScript errors | Backend typecheck exited 0. |
| `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -print \| sort` | pass | 0 artifacts found | Common source artifact guard returned no output. |

### Added Test Coverage

| Acceptance criterion | Coverage |
| --- | --- |
| AC #1: `ContainerMountsService.deleteAllForContainer()` deletes only exact `{serverId, dockerId}` rows, preserving other server/container/null rows, returns affected count, and is idempotent. | `packages/backend/src/containers/__tests__/container-delete-mount-cleanup.test.ts` :: `deletes only exact server and docker rows and returns an idempotent affected count`. |
| AC #2: `ContainersService.deleteContainer()` successful path calls agent RPC before mount cleanup and mount cleanup before delete audit. | `packages/backend/src/containers/__tests__/container-delete-mount-cleanup.test.ts` :: `calls the agent before mount cleanup and audits only after cleanup succeeds`. |
| AC #3: `ContainersService.deleteContainer()` failing agent RPC does not call mount cleanup or audit. | `packages/backend/src/containers/__tests__/container-delete-mount-cleanup.test.ts` :: `does not clean up mounts or audit when the agent delete RPC fails`. |
| AC #4: Disk deletion guard regression is covered: after deleting the matching container mount row, disk removal is no longer blocked if no other rows reference the disk; control row still blocks. | `packages/backend/src/containers/__tests__/container-delete-mount-cleanup.test.ts` :: `allows disk removal after container delete cleans the only matching local mount row`; `keeps disk removal blocked when another container still references the same disk`. |
| AC #5: Focused backend tests pass. | Focused Vitest command passed 6 / 0 / 0. |
| AC #6: Backend typecheck or relevant test command output is recorded if feasible. | Backend typecheck passed with 0 TypeScript errors; focused and full backend test outputs are recorded above. |
| AC #7: Common-src artifact guard remains clean. | Guard command returned no output and found 0 generated source artifacts. |

### Root Cause Classification

Verdict: PASS. Focused backend coverage verifies exact stale mount cleanup, container delete ordering/failure semantics, idempotent no-mount cleanup, and the disk deletion guard regression. No failing tests remain.

## XFS Quota Mount Resolver Regression

Prepared: `2026-06-01T19:51:57Z`
Scope: focused tester update for XFS quota mount/path handling after the live `/data/<dir>` failure. Product source, backend/common/frontend source, scripts, configs, manifests, lockfiles, installs, builds, deploys, dev servers, and visual snapshots were not touched.
Visual artifacts: n/a, agent logic only.

### Commands and Results

| Command | Result | Counts | Notes |
| --- | --- | --- | --- |
| `pnpm --filter @nyabase/agent typecheck` | pass | 0 TypeScript errors | Agent typecheck exited 0. |
| `pnpm --filter @nyabase/agent exec vitest run src/quota/xfs-quota.test.ts src/commands/dispatcher.test.ts src/gpu/gpu-monitor.test.ts src/docker/docker-client.test.ts` | pass | 43 passed / 0 failed / 0 skipped; 4 test files passed | Focused agent tests for quota, dispatcher, GPU monitor, and Docker client. |
| `pnpm --filter @nyabase/agent test` | pass | 43 passed / 0 failed / 0 skipped; 4 test files passed | Full agent unit suite. |
| `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -print \| sort` | pass | 0 artifacts found | Common source artifact guard returned no output. |

### Added/Updated Test Coverage

| Acceptance criterion | Coverage |
| --- | --- |
| AC #1: Subdirectory paths resolve to their containing mount for quota state/report commands. | `packages/agent/src/quota/xfs-quota.test.ts` :: `runs quota state checks for a subdirectory against the containing mount`; `runs quota reports for a subdirectory-backed manager against the containing mount`; updated `calls project -s -p and verifies project id, inheritance flag, and report presence` to expect `report -N -p -b -n` against `/data`. |
| AC #2: `addPathToProject` still registers/assigns/verifies the actual subdirectory path. | `packages/agent/src/quota/xfs-quota.test.ts` :: `calls project -s -p and verifies project id, inheritance flag, and report presence` asserts `/etc/projects` receives `10007:/data/users/alice`, `project -s -p` includes `/data/users/alice`, and `xfs_io stat` verifies `/data/users/alice`, while `xfs_quota` targets `/data`. |
| AC #3: Agent typecheck exits 0. | `pnpm --filter @nyabase/agent typecheck` passed. |
| AC #4: Focused agent tests for quota/dispatcher/GPU/docker pass. | Focused Vitest command passed 43 / 0 / 0 across the requested four files. |
| AC #5: Full `pnpm --filter @nyabase/agent test` passes. | Full agent Vitest command passed 43 / 0 / 0 across 4 files. |
| AC #6: Common-src artifact guard remains clean. | Guard command returned no output and found 0 generated source artifacts. |
| AC #7: `tests.md` records commands/results. | This section records commands, results, counts, AC coverage, and visual artifact status. |

### Root Cause Classification

Verdict: PASS. The regression coverage now exercises `/proc/self/mountinfo`-based containing-mount resolution and preserves subdirectory registration/stat behavior. No failing tests remain.

Note: this workspace has no `.git` directory available, so git status/diff could not be used for local change inspection in this dispatch.

## CPU Live XFS Quota Verification

Prepared: `2026-06-01T19:40:03Z`
Scope: CPU-only live verification for the deployed agent binary SHA `cd4647aa19677b4e73e2308b9ef8a19ce4ea165b027884022d4b974929c97588`. No rebuild, deploy, service restart, GPU host, product source, or product tests were touched.
Run ID: `xfsq-20260601t193958z-98f5eb`

### Commands and Results

| Command | Exit code | Result | Notes |
| --- | ---: | --- | --- |
| `ssh -o BatchMode=yes -o ConnectTimeout=8 root@10.8.96.91 'hostname; findmnt -no TARGET,FSTYPE,OPTIONS /data; DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker image inspect ubuntu:24.04 >/dev/null && echo image_present || echo image_absent; ...'` | `0` | pass | CPU host reachable; `/data` is `xfs` with `prjquota`; `ubuntu:24.04` exists on the managed Docker socket. |
| `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -print \| sort` | `0` | pass | Common source artifact guard returned no output before and after the live run. |
| `node <<'NODE' ... live CPU XFS quota API/SSH harness ... NODE` | `1` | fail | The harness logged in as admin, registered `/data`, created a disposable image record/user/grants, then failed at `POST /api/data-dirs`. Cleanup completed and residual scans found no test artifacts. |

### Evidence

| Acceptance item | Status | Evidence |
| --- | --- | --- |
| `/data` registration/check reports pquota enabled | pass | Host `xfs_quota -x -c 'state -p' /data` reported `Accounting: ON` and `Enforcement: ON`. `GET /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks` after registration returned disk `6cb4df27-1b61-4901-a1cb-6163ce09cd6c`, `mountPoint=/data`, `pquotaEnabled=true`, `totalBytes=34292629504`, `usedBytes=3400380416`. The disposable disk registration was removed during cleanup. |
| Below-limit write under 20 MiB grant | fail | Not reached. `POST /api/data-dirs` failed before containers could be created. |
| Same-owner cross-container visibility | fail | Not reached. No test containers were created because data-dir creation failed. |
| 40 MiB shared data-dir over-limit write | fail | Not reached. No shared data directory was created through the API. |
| Writable-layer 40 MiB over-limit write | fail | Not reached. Container creation was not attempted after the data-dir API failure. |
| Cleanup | pass | Deleted disposable mount-source grant, image grant, server grant, user, image record, created disk registration, and remote fallback path/container matches for run ID `xfsq-20260601t193958z-98f5eb`. Residual scans found no API user/image/disk, no matching Docker containers, no host data dir, and no common-src artifacts. |

### Failure Classification

Verdict: FAIL-PRODUCT.

The deployed agent/backend path fails while creating a local data dir on a quota-enabled `/data` mount. The API response tail was:

```text
HTTP 502 POST /data-dirs: {"message":"Agent error: [XFS] Project quota is not enforcing on /data/xfsq-20260601t193958z-98f5eb (accounting=off, enforcement=off): xfs_quota: cannot setup path for mount /data/xfsq-20260601t193958z-98f5eb: No such device or address","error":"Bad Gateway","statusCode":502}
```

Observed contrast: the same live run verified `/data` itself has project quota accounting and enforcement enabled, and the API disk registration/check reported `pquotaEnabled=true`. The failure occurs when the agent checks project quota enforcement for the newly created subdirectory path during data-dir project assignment.

## GPU Monitor Test Mock Typing Verification

Prepared: `2026-06-01T19:12:18Z`
Scope: narrow tester fix for the `execFile` mock callback typing in `packages/agent/src/gpu/gpu-monitor.test.ts`. Product source was not edited.
Visual artifacts: n/a, agent test typing only.

### Commands and Results

| Command | Result | Counts | Notes |
| --- | --- | --- | --- |
| `pnpm --filter @nyabase/agent exec tsc --noEmit --pretty false --skipLibCheck true` | pass | 0 TypeScript errors | Verifies the GPU monitor test mock callback no longer triggers `TS2349`/`TS2723`; product-source GPU typing had already been fixed by developer. |
| `pnpm --filter @nyabase/agent exec vitest run src/gpu/gpu-monitor.test.ts src/quota/xfs-quota.test.ts src/commands/dispatcher.test.ts src/docker/docker-client.test.ts` | pass | 41 passed / 0 failed / 0 skipped; 4 test files passed | Focused agent tests for GPU monitor, XFS quota, dispatcher, and docker client. |
| `pnpm --filter @nyabase/agent test` | pass | 41 passed / 0 failed / 0 skipped; 4 test files passed | Full agent unit suite. |
| `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -print \| sort` | pass | 0 artifacts found | Common source artifact guard returned no output. |

### Acceptance Criteria Coverage

| Acceptance criterion | Coverage |
| --- | --- |
| AC #1: Agent typecheck command exits 0. | `pnpm --filter @nyabase/agent exec tsc --noEmit --pretty false --skipLibCheck true` passed with 0 TypeScript errors. |
| AC #2: Focused agent tests for GPU monitor, XFS quota, dispatcher, and docker client pass. | Focused Vitest command passed `packages/agent/src/gpu/gpu-monitor.test.ts`, `packages/agent/src/quota/xfs-quota.test.ts`, `packages/agent/src/commands/dispatcher.test.ts`, and `packages/agent/src/docker/docker-client.test.ts`. |
| AC #3: Full `pnpm --filter @nyabase/agent test` passes. | Full agent Vitest command passed 41 / 0 / 0 across 4 files. |
| AC #4: Common-src artifact guard remains clean. | Guard command returned no output and found 0 generated source artifacts. |
| AC #5: `tests.md` records commands, counts, and any failures. | This section records every command, counts, and failure status. |

### Root Cause Classification

Verdict: PASS. The remaining failure was a test typing issue in `packages/agent/src/gpu/gpu-monitor.test.ts`: the mocked `execFile` callback was read from an overloaded optional parameter position without narrowing. The test now narrows the callback before invoking it. No failing tests remain.

## Focused Automated Regression Run: XFS Quota Fail-Closed

Prepared: `2026-06-01T18:59:45Z`
Scope: focused backend/agent logic tests for the live TEST_DEPLOY failure where same-user local XFS sharing worked but disk quota enforcement did not fail closed.
Visual artifacts: n/a, agent/backend logic only.

### Commands and Results

| Command | Result | Counts | Notes |
| --- | --- | --- | --- |
| `pnpm --filter @nyabase/agent exec vitest run src/quota/xfs-quota.test.ts src/commands/dispatcher.test.ts src/gpu/gpu-monitor.test.ts` | pass | 34 passed / 0 failed / 0 skipped; 3 test files passed | Focused XFS quota, dispatcher, and affected GPU-focused tests. |
| `pnpm --filter @nyabase/agent test` | pass | 41 passed / 0 failed / 0 skipped; 4 test files passed | Full agent unit suite. |
| `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -print \| sort` | pass | 0 artifacts found | Common source artifact guard returned no output. |

Additional note: `pnpm --filter @nyabase/agent exec tsc --noEmit --pretty false --skipLibCheck true` was attempted after the required test commands and failed on existing GPU typing errors in `packages/agent/src/gpu/gpu-monitor.ts` and `packages/agent/src/gpu/gpu-monitor.test.ts`. This command was not part of the focused XFS test acceptance gate; no product source was edited.

## Agent TypeScript Check: GPU Typing Errors

Prepared: `2026-06-01T19:04:30Z`
Scope: devops reproduction of the previously noted non-gate agent TypeScript failure only. No product source or tests were edited.

### Command and Result

| Command | Exit code | Result | Notes |
| --- | --- | --- | --- |
| `pnpm --filter @nyabase/agent exec tsc --noEmit --pretty false --skipLibCheck true` | `1` (`pnpm` reported inner `tsc` exit code `2`) | fail | Fails on GPU typing errors in `packages/agent/src/gpu/gpu-monitor.test.ts` and `packages/agent/src/gpu/gpu-monitor.ts`. |

### Stderr Tail

```text
src/gpu/gpu-monitor.test.ts(21,5): error TS2349: This expression is not callable.
  Not all constituents of type 'ExecFileOptionsWithBufferEncoding | ExecFileOptions | ExecFileOptionsWithStringEncoding | ((error: ExecFileException | null, stdout: string, stderr: string) => void) | ((error: ExecFileException | null, stdout: NonSharedBuffer, stderr: NonSharedBuffer) => void) | ((error: ExecFileException | null, stdout: string, st...' are callable.
    Type 'ExecFileOptionsWithBufferEncoding' has no call signatures.
src/gpu/gpu-monitor.test.ts(21,5): error TS2723: Cannot invoke an object which is possibly 'null' or 'undefined'.
src/gpu/gpu-monitor.test.ts(27,5): error TS2349: This expression is not callable.
  Not all constituents of type 'ExecFileOptionsWithBufferEncoding | ExecFileOptions | ExecFileOptionsWithStringEncoding | ((error: ExecFileException | null, stdout: string, stderr: string) => void) | ((error: ExecFileException | null, stdout: NonSharedBuffer, stderr: NonSharedBuffer) => void) | ((error: ExecFileException | null, stdout: string, st...' are callable.
    Type 'ExecFileOptionsWithBufferEncoding' has no call signatures.
src/gpu/gpu-monitor.test.ts(27,5): error TS2723: Cannot invoke an object which is possibly 'null' or 'undefined'.
src/gpu/gpu-monitor.ts(119,7): error TS2322: Type 'GpuProcessInfo[] | ({ pid: number; usedMemoryMiB: number; gpuUuid: string; containerId: string | undefined; } | null)[]' is not assignable to type 'GpuProcessInfo[]'.
  Type '({ pid: number; usedMemoryMiB: number; gpuUuid: string; containerId: string | undefined; } | null)[]' is not assignable to type 'GpuProcessInfo[]'.
    Type '{ pid: number; usedMemoryMiB: number; gpuUuid: string; containerId: string | undefined; } | null' is not assignable to type 'GpuProcessInfo'.
      Type 'null' is not assignable to type 'GpuProcessInfo'.
src/gpu/gpu-monitor.ts(128,56): error TS2677: A type predicate's type must be assignable to its parameter's type.
  Type 'GpuProcessInfo' is not assignable to type '{ pid: number; usedMemoryMiB: number; gpuUuid: string; containerId: string | undefined; }'.
    Property 'containerId' is optional in type 'GpuProcessInfo' but required in type '{ pid: number; usedMemoryMiB: number; gpuUuid: string; containerId: string | undefined; }'.
undefined
/root/nyabase/packages/agent:
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command failed with exit code 2: tsc --noEmit --pretty false --skipLibCheck true
```

### Added/Updated Test Coverage

| Acceptance criterion | Coverage |
| --- | --- |
| AC #1: XFS quota command failures reject instead of warning-only success. | `packages/agent/src/quota/xfs-quota.test.ts` :: `rejects when xfs_quota command execution fails`; `rejects when xfs_io verification fails after project assignment`. |
| AC #2: `checkProjectQuotaEnforcement` parses accounting/enforcement and `handleApplyDataDisk` rejects non-enforcing mounts. | `packages/agent/src/quota/xfs-quota.test.ts` :: `parses Accounting=%s and Enforcement=%s from xfs_quota state`; `packages/agent/src/commands/dispatcher.test.ts` :: `rejects applyDataDisk when XFS project quota enforcement is off`; `adds a local data source when applyDataDisk verifies accounting and enforcement`. |
| AC #3: `setLimit` rejects missing/mismatched hard limits and passes on correct report. | `packages/agent/src/quota/xfs-quota.test.ts` :: `passes when report -N -p -b -n shows the expected hard limit`; `rejects when the project is missing from the post-limit report`; `rejects when the post-limit report hard limit does not match`. |
| AC #4: `createDataDir` assigns local quota-enabled paths and does not assign remote/no-quota paths. | `packages/agent/src/commands/dispatcher.test.ts` :: `assigns created local quota-enabled data dirs to the owner project`; `does not assign remote or local no-quota data dirs to XFS projects`. |
| AC #5: `createContainer` assigns local quota-enabled createDirs plus Docker upper/work dirs; assignment failure fails ack and triggers compensation. | `packages/agent/src/commands/dispatcher.test.ts` :: `assigns local quota-enabled createDirs plus Docker upper/work dirs to the owner project`; `fails ack and compensates container when Docker writable layer quota assignment fails`; `fails ack before container creation when local createDir quota assignment fails`. |
| AC #6: GPU focused tests still pass or focused command does not regress dispatcher tests. | `packages/agent/src/gpu/gpu-monitor.test.ts` included in focused command; full `@nyabase/agent` suite passed. |
| AC #7: Common-src artifact guard remains clean. | Guard command returned no output. |

### Root Cause Classification

Verdict: PASS. No failing tests. Root cause classification for this tester dispatch: product fix verified by focused automated coverage; no current product/test/baseline/infra failure found.

## Checklist

| ID | Area | Procedure | Expected evidence | Current status | Evidence path/output | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| ENV-001 | Local VictoriaMetrics | Start or reuse `nyabase-vm` from `TEST_DEPLOY.md`; query `http://127.0.0.1:8428/api/v1/query?query=up` or VM health endpoint. | HTTP 200 from VictoriaMetrics and query response body saved. | pending | n/a | Devops runs local VM check during deployment batch. |
| ENV-002 | Backend startup | Build backend as documented, start with `test/.env`, then request `GET http://localhost:3001/api/auth/me` unauthenticated. | HTTP status `401`; backend log has no startup error. | pending | n/a | Devops starts backend and records curl output plus process log. |
| ENV-003 | Frontend startup | Start frontend per `TEST_DEPLOY.md`; request `GET http://localhost:5173/`. | HTTP 200 HTML containing frontend root/app markup. | pending | n/a | Devops starts frontend and records curl output. |
| ENV-004 | Common source artifact guard | Run `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print`. | No output. | pending | Guard also exists in `scripts/check.sh`. | Run before and after any build/test batch. |
| ENV-005 | Full automated baseline | Run `bash scripts/check.sh` after any code changes. | Typecheck, lint, unit tests, and common-src artifact guard all green. | pending | n/a | Run only in allowed test/devops execution batch. |
| ENV-006 | Visual baseline | Run `bash scripts/check-visual.sh` if rendered frontend output changed. | Playwright visual suite green; screenshots/diffs recorded if applicable. | pending | `packages/frontend/e2e/login.spec.ts`; `packages/frontend/e2e/ROUTES.md`. | Run only if frontend rendered output changes. |
| AGT-001 | CPU agent deployment | Build `dist/nyabase-agent`, install to `root@10.8.96.91`, configure `/etc/nyabase/agent.yaml` with new server token/id, start `nyabase-agent`. | `journalctl -u nyabase-agent` shows `[WS] Connected`; backend server list shows CPU server online. | pending | n/a | Devops executes deployment after server token is generated. |
| AGT-002 | CPU agent baseline report | After CPU agent connects, inspect backend server detail/API/state cache for hostname, kernel, CPU cores, memory, disks, docker daemon status, local images, and heartbeat freshness. | API/UI evidence showing non-empty CPU host inventory and fresh `lastUpdated`/online state. | pending | Supporting tests: `packages/common/src/__tests__/protocol.test.ts` validates hello payload basics; `packages/backend/src/gateway/__tests__/state-cache.test.ts` validates cache storage helpers. | Verify on live CPU agent. |
| AGT-003 | GPU agent deployment | Build `dist/nyabase-agent`, install to `lyn@10.8.1.12` using sudo, configure `/etc/nyabase/agent.yaml` with `isGpuServer: true`, start `nyabase-agent`. | `journalctl -u nyabase-agent` shows `[WS] Connected`; `nyabase-docker.service` active; backend server list shows GPU server online. | pending | n/a | Devops executes deployment after GPU server token is generated. |
| AGT-004 | GPU inventory report | On GPU server, compare `nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv,noheader,nounits` with backend `GET /api/servers/:id/gpus` or UI. | Four NVIDIA L40 GPUs, UUID/index/model/total memory match or unsupported fields recorded. | pending | Supporting source: `packages/agent/src/gpu/gpu-monitor.ts`; backend endpoint in `packages/backend/src/servers/servers.controller.ts`. | Verify on live GPU agent. |
| AGT-005 | GPU utilization metric | Generate or observe GPU workload; query `GET /api/metrics/servers/:id/gpus?range=...` and VictoriaMetrics for `nyabase_gpu_util_ratio`. | Non-empty time series per GPU index; values are ratios from `nvidia-smi utilization.gpu`. | pending | Supporting source: `packages/agent/src/gpu/gpu-monitor.ts`; `packages/backend/src/metrics/metrics.controller.ts`. | Verify after GPU metrics interval. |
| AGT-006 | GPU memory metric | Query backend/VM for `nyabase_gpu_mem_used_bytes` and compare with `nvidia-smi memory.used`. | Per-GPU memory used time series present and approximately matches `nvidia-smi`. | pending | Supporting source: `packages/agent/src/gpu/gpu-monitor.ts`; `packages/backend/src/metrics/metrics.controller.ts`. | Verify after GPU metrics interval. |
| AGT-007 | GPU temperature metric | Query backend/VM for `nyabase_gpu_temp_celsius` and compare with `nvidia-smi temperature.gpu`. | Per-GPU temperature time series present where supported. | pending | Supporting source: `packages/agent/src/gpu/gpu-monitor.ts`; `packages/backend/src/metrics/metrics.controller.ts`. | Verify after GPU metrics interval. |
| AGT-008 | GPU power/frequency metrics | Query backend/VM for `nyabase_gpu_power_watts`; compare with `nvidia-smi power.draw`. Separately check whether frequency/clock metrics are emitted by product. | Power time series present where supported; frequency/clock support explicitly `pass` if available or `fail`/gap if absent despite requirement. | pending | Supporting source currently shows power metric only in `packages/agent/src/gpu/gpu-monitor.ts`; no frequency metric found in inspected metric controller/source. | Verify live power; if frequency absent, route product gap. |
| AGT-009 | Per-container GPU memory attribution | Run GPU workload inside a managed container; query `nyabase_gpu_proc_mem_used_bytes` via VM/backend container metrics and compare labels to container/user. | Metric includes `container_id`, `user_id`, `gpu_uuid`, and memory bytes attributed to the target container. | pending | Supporting source: `GpuMonitor.buildMetrics` in `packages/agent/src/gpu/gpu-monitor.ts`; backend queries in `packages/backend/src/metrics/metrics.controller.ts`. | Verify with real GPU container process. |
| AGT-010 | CPU server container create/delete | Create a container on the CPU server via API/UI with permitted image/quota, confirm running, then delete normally. | API/UI shows create success, state report lists container, delete removes it; agent journal has successful command ack. | pass for CPU restricted-user create/delete subset | See `Restricted CPU Writable-Layer XFS Quota Verification`: run `xfswl-20260601t224307z` created a CPU container as a restricted user, verified it was running and owner-labeled correctly, then deleted it with no residual Docker/API rows. | Broader start/stop/restart lifecycle remains separate if required. |
| AGT-011 | GPU server container create/delete | Create a GPU container on GPU server using GPU quota/indices, confirm GPU assignment, then delete normally. | API/UI shows create success with `gpuIndices`; delete removes it; GPU metrics reflect workload if used. | pending | Supporting tests: `packages/backend/src/containers/__tests__/resource-quota.policy.test.ts`; `packages/backend/src/gateway/__tests__/state-cache.test.ts`. | Execute on live GPU server after image/grants ready. |
| AGT-012 | Force delete container | Create or identify a stopped/unresponsive test container, invoke force delete path through UI/API/agent command where supported. | Container removed from agent dockerd and backend state; command ack/log evidence saved. | pending | Supporting tests: dispatcher compensation uses `removeContainer(..., true)` in `packages/agent/src/commands/dispatcher.test.ts`; no full API force-delete route confirmed in inspected `containers.controller.ts`. | Verify available product path; route gap if no force-delete API/UI exists. |
| AGT-013 | Shell attachment | For a running container, call `POST /api/containers/:serverId/:dockerId/exec` with `bash` or `sh`, open console WS, run `whoami` and `pwd`. | Session id returned, console receives command output, EOF/close behavior clean. | pending | Supporting tests: `packages/backend/src/gateway/__tests__/log-chunk-tracker.test.ts`; shell API in `packages/backend/src/containers/containers.controller.ts`. | Execute live shell test on CPU and at least one GPU container if applicable. |
| AGT-014 | Local mount XFS quota | Register local XFS disk, create data directory/quota for user, mount into container, write past quota with `dd` or `fallocate`. | Disk registration reports `pquotaEnabled=true`; writes up to quota succeed; write beyond quota fails; `/api/servers/:id/quota` updates. | pass for CPU writable-layer XFS quota enforcement | See `Restricted CPU Writable-Layer XFS Quota Verification`: `/data` had `prjquota` with Accounting/Enforcement `ON`; restricted-owned container upper/work dirs were project `10005` with 20 MiB hard limit; 5 MiB write succeeded; 40 MiB writable-layer write failed with `No space left on device` and truncated below requested size. | Mounted local data-dir sharing/quota remains separate if required; this closes the prior writable-layer procedure gap. |
| AGT-015 | Local mount same-user cross-container | Create two containers for the same user mounting the same local source/directory; write a file in one and read/update from the other. | File content and ownership are visible across same-user containers; UID/GID semantics recorded. | pending | No automated coverage found. | Execute live with two same-user containers. |
| AGT-016 | Local mount cross-user isolation | Create or attempt mount access for a different user without grant; verify unauthorized access is rejected or isolated according to product policy. | API denies missing grant or container cannot access another user's ungranted data. | pending | Supporting backend grant source inspected in `groups.controller.ts` and `mount-sources` modules; no automated integration test found. | Execute after user/grant setup. |
| AGT-017 | Remote NFS mount lifecycle | Install/configure local NFS server or use available NFS export; create `system/remote-fs-mounts` NFS record assigned to CPU/GPU server; wait for agent mount status. | API/UI shows remote mount `mounted`; agent journal shows applyRemoteFsMount success; host mount point exists. | pass for CPU NFS host mount | See `Agent Redeploy and Restricted CPU Live NFS Verification After Source Equivalence Fix`: run `nfs-live-20260601t222329z` registered a temporary CPU export through product API, status became `mounted`, host mount path existed, and host/export read-write passed. | GPU host intentionally not touched; no next action for this CPU-only dispatch. |
| AGT-018 | Remote NFS container mount | Grant remote mount source to user/group; create data directory/container mount backed by NFS; read/write from container and host/export side. | Data written in container appears on NFS export; unmount/delete cleans up without stale assignment. | pass for CPU NFS container mount | See `Agent Redeploy and Restricted CPU Live NFS Verification After Source Equivalence Fix`: restricted user with grants created the remote data dir and running container; product `PATCH /api/containers/:serverId/:dockerId/mounts` returned HTTP `200`; `/mnt/nfs` was visible inside the container as `nfs4`; export-to-container and container-to-export/host read-write passed; cleanup residuals: none. | None for the CPU NFS container behavior targeted by this dispatch. |
| BCK-001 | Auth/admin login prerequisite | Log in as initial admin using `ADMIN_INIT_PASSWORD=admin123`; capture token for API flow. | `POST /api/auth/login` returns access token and admin user DTO. | pending | Supporting schema test: `zLoginRequest rejects empty fields` in `packages/common/src/__tests__/protocol.test.ts`. | Execute once backend is running. |
| BCK-002 | User management lifecycle | As admin, create test user, list users, update display/status/password as supported, add/list/delete SSH key, delete test user. | HTTP statuses and response bodies for create/list/update/key/delete; deleted user absent. | pending | No controller/service integration tests found; endpoints in `packages/backend/src/users/users.controller.ts`. | Execute via API and record request/response excerpts. |
| BCK-003 | User permission enforcement | Attempt user management as non-admin/no `ManageUsers`; attempt self update with and without current password. | Unauthorized/forbidden cases return expected `401/403/400`; self update allowed only as policy permits. | pending | No integration tests found. | Execute after creating restricted user. |
| BCK-004 | Container permission enforcement | With restricted user, verify own container list/detail/actions work and another user's container requires `ManageContainersAny`. | Own actions allowed; cross-user action denied unless capability granted. | pending | Supporting source: `assertOwnerOrManageAny` paths in container controller/service; no integration test found. | Execute with two users and at least two containers. |
| BCK-005 | Quota enforcement including GPU | Assign CPU/memory/disk/GPU grants, create containers within quota, then exceed each quota including GPU index/count. | Within-quota create succeeds; over-quota create returns expected 4xx and no leaked container. | pass for CPU disk quota enforcement on restricted writable layer | See `Restricted CPU Writable-Layer XFS Quota Verification`: user-scoped CPU grant used `diskBytes=20971520`; restricted-owned container writable layer was assigned to project `10005`; over-limit write failed with `No space left on device`. | CPU/memory/GPU over-quota cases remain outside this focused dispatch. |
| BCK-006 | Image permission enforcement | Create image and image grants; restricted user sees/uses only granted active images; ungranted image detail/create container is denied. | API/UI confirms image filtering and forbidden ungranted image. | pending | No integration tests found; endpoints in `packages/backend/src/images/images.controller.ts`; state-cache image matching unit tests exist. | Execute with restricted user and granted/ungranted images. |
| BCK-007 | Server permission enforcement | Create server grant for restricted user/group; verify server list/detail/metrics visibility is limited to granted servers. | Restricted user sees only granted server and cannot access ungranted server APIs. | pending | Supporting tests: grant default utility in `packages/backend/src/access/__tests__/access-resolver.test.ts`; no endpoint integration test found. | Execute after CPU/GPU server registration. |
| BCK-008 | Image management lifecycle | As admin, create image record, list, get detail/status, update metadata/active flag, optionally pull to CPU/GPU servers, delete. | API/UI response bodies and pull progress/status evidence; deleted image absent. | pending | Supporting tests: `packages/backend/src/gateway/__tests__/pull-progress-tracker.test.ts`; no image controller integration test found. | Execute via API/UI. |
| BCK-009 | Server management lifecycle | As admin, create CPU and GPU server records, capture one-time agent tokens, list/get/update/defaults, regenerate token, self-check, delete disposable server record if created. | Server API responses, token only visible on create/regenerate, old token rejected or unusable, updated defaults visible. | pending | Supporting schema test: `zCreateServerRequest validates CIDR and IP`; endpoints in `packages/backend/src/servers/servers.controller.ts`. | Execute before agent deployment and during cleanup. |
| BCK-010 | Agent token lifecycle | Register server, connect agent with initial token, regenerate token, verify existing/old token behavior and new token connection on restart/reconfigure. | Old token no longer authenticates new connection; new token connects; online state correct. | pass for active CPU agent token lifecycle | See `Active CPU Agent Token Lifecycle Verification`: CPU token regeneration returned HTTP `201`; stale-token `/ws/agent` probe closed with `4003 Invalid token`; regenerated token restored CPU agent `[WS] Connected`; backend reported CPU `online`; GPU remained online/unchanged. | None for the active CPU agent lifecycle targeted by this dispatch. |
| BCK-011 | Resource metric storage | Wait at least two `metricsIntervalMs` cycles, query VM directly for host/container/GPU metric names and query backend metrics APIs. | VM query results contain recent samples; backend APIs return non-empty series for host, user, container, GPU where applicable. | pending | Supporting code in `packages/agent/src/metrics/host-metrics.ts`, `packages/agent/src/gpu/gpu-monitor.ts`, `packages/backend/src/metrics/metrics.controller.ts`. | Execute after agents and containers are running. |
| BCK-012 | Resource metric display/UI | Open dashboard/server metrics pages and verify host, GPU, user, and container metric charts render non-empty data. | Screenshot or Playwright/video artifact plus API responses used by UI. | pending | Existing visual coverage only covers `/login`; dashboard/metrics routes are gaps in `packages/frontend/e2e/ROUTES.md`. | Execute manual/browser or add targeted e2e in a future tester dispatch if requested. |
| BCK-013 | Storage management local | Register/list/update/delete local data disk; verify non-XFS path is rejected and in-use disk cannot be removed. | Correct 2xx for valid lifecycle; 400/409-style rejection for invalid/in-use paths; disk appears with capacity/pquota fields. | pending | Supporting server disk endpoints inspected; no integration test found. | Execute on live CPU/GPU storage paths. |
| BCK-014 | Storage management remote | Create/list/get/update/remount/assign/unassign/delete remote NFS mount. Verify in-use remote mount deletion/unassignment is blocked. | API statuses and mount statuses show lifecycle and safe blocking. | pass for CPU NFS remote storage lifecycle and guards | See `Agent Redeploy and Restricted CPU Live NFS Verification After Source Equivalence Fix`: create/list/get/metadata patch/remount/mounted/delete lifecycle passed; dynamic container mount update returned HTTP `200`; while the container mount row existed, remote FS delete and server unassign returned HTTP `409`; cleanup residuals: none. | None for the CPU NFS remote storage path targeted by this dispatch. |
| BCK-015 | Container management lifecycle | Create, list, detail, stats, start, stop, restart, update mounts, shell, delete, force-delete if supported for CPU and GPU server coverage. | API/UI responses and agent state reports for every lifecycle step. | pass for CPU restricted-user create/delete subset | See `Restricted CPU Writable-Layer XFS Quota Verification`: product API created/listed a restricted-owned running CPU container and cleanup deleted it; residual scan found no Docker/API container rows. | Full lifecycle, shell, stats, restart/stop/start, and GPU coverage remain outside this focused dispatch. |
| BCK-016 | Group/capability grants lifecycle | Create group with capabilities, add/remove member, upsert/delete server grants, image grants, mount source grants; verify access resolver cache behavior by rechecking API visibility. | Group/grant APIs return expected results; restricted user permissions change after grant updates. | pending | Supporting tests: `packages/backend/src/access/__tests__/access-resolver.test.ts` covers grant default helper only. | Execute via API with restricted user. |
| BCK-017 | Audit/log evidence | For create/update/delete actions above, inspect audit UI/API where available for representative records. | Audit entries include actor/action/resource for user, group, server, image, mount, container-related changes where implemented. | pending | No automated audit test found. | Include in backend verification batch if audit route is available. |
| DOC-001 | Checklist completeness | Confirm every requirement acceptance criterion has at least one checklist row and each row has status/evidence/next action. | This `tests.md` table contains Agent, Backend, environment, evidence, and next action rows. | pass | `.codex/skills/harness/docs/test-deploy-local-agents/20260601T162323Z/tests.md` | Keep updated after each execution batch. |

## Automated Test Inventory

Existing automated tests provide supporting coverage for protocol validation and isolated policy/helper behavior. They do not replace the live deployment verification rows above.

| Test file/spec | Existing assertions | Related checklist IDs | Coverage level | Gap |
| --- | --- | --- | --- | --- |
| `packages/common/src/__tests__/utils.test.ts` | IPv4/CIDR helpers, IP allocation, byte formatting, token generation. | ENV-005, BCK-009 | unit support | No live server/network provisioning coverage. |
| `packages/common/src/__tests__/protocol.test.ts` | WS envelope validation, hello payload defaults, create container payload basics, NFS params schema, REST request schema validation. | AGT-002, AGT-017, BCK-001, BCK-009, BCK-014 | unit support | Does not verify actual backend controllers or agent/backend WS exchange. |
| `packages/agent/src/commands/dispatcher.test.ts` | Command ack behavior, validation failures, createDataDir event, reconcile event, create container rollback/compensation. | AGT-010, AGT-012, AGT-013, AGT-014, BCK-015 | unit support | No real Docker, XFS quota, remote mount, shell stream, or force-delete endpoint coverage. |
| `packages/agent/src/docker/docker-client.test.ts` | Docker timeout wrapper resolves, rejects, propagates errors, clears timers. | AGT-010, AGT-011, BCK-015 | unit support | No Docker daemon/container lifecycle integration. |
| `packages/backend/src/access/__tests__/access-resolver.test.ts` | Server defaults and GPU grant index inheritance utility. | BCK-005, BCK-016 | unit support | Does not test full capability resolution, endpoint permissions, group priority, or cache invalidation. |
| `packages/backend/src/containers/__tests__/resource-quota.policy.test.ts` | CPU/memory/disk quota checks; GPU grant modes none/all/indices; auto-pick and denied GPU requests. | AGT-011, BCK-005, BCK-015 | unit support | Does not create real containers or verify persisted grants/API behavior. |
| `packages/backend/src/gateway/__tests__/state-cache.test.ts` | Image ref matching, user usage aggregation, least-loaded GPU picking, container event status updates/removal. | AGT-002, AGT-009, AGT-011, BCK-011, BCK-015 | unit support | Does not verify live state reports from agents or metric storage. |
| `packages/backend/src/gateway/__tests__/agent-session.test.ts` | Agent RPC ack success, timeout, error, closed WS, reject-all. | AGT-010, AGT-013, BCK-015 | unit support | No end-to-end agent WS connection or command execution. |
| `packages/backend/src/gateway/__tests__/agent-errors.test.ts` | Agent RPC errors map to HTTP exceptions. | AGT-010, BCK-015 | unit support | Does not assert controller HTTP responses. |
| `packages/backend/src/gateway/__tests__/pull-progress-tracker.test.ts` | Pull progress storage, listeners, done callback, unsubscribe, clear-server. | BCK-008 | unit support | No image pull through live agent. |
| `packages/backend/src/gateway/__tests__/log-chunk-tracker.test.ts` | Console log chunk dispatch, buffering, EOF cleanup, unsubscribe, clear-server EOF. | AGT-013, BCK-015 | unit support | No browser console WebSocket or real shell session. |
| `packages/frontend/e2e/login.spec.ts` | `/login` visual baseline and unauthenticated `/` redirect. | ENV-006 | visual/e2e support | No authenticated routes, dashboards, servers, images, users, containers, storage, or metrics UI coverage. |
| `scripts/check.sh` | Common source artifact guard, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, optional visual. | ENV-004, ENV-005, ENV-006 | suite wrapper | Not run in this dispatch by instruction. |
| `scripts/check-visual.sh` | Playwright visual suite wrapper. | ENV-006, BCK-012 | suite wrapper | Only covers current frontend e2e specs. |

## Coverage Gaps To Track

- No automated backend controller/API integration suite was found for users, groups, images, servers, containers, storage, remote FS, auth token lifecycle, or metrics endpoints.
- No automated agent integration suite was found for real Docker create/delete/force-delete, XFS project quota enforcement, same-user cross-container mount sharing, NFS mounting, or shell stream against a real container.
- No automated GPU tests were found for `nvidia-smi` parsing, GPU metric emission, frequency/clock metrics, or per-container GPU process attribution.
- Existing visual coverage is limited to unauthenticated login/redirect; authenticated UI routes for user/server/image/container/storage/metrics workflows are not covered.
- The inspected GPU metric path emits utilization, memory, temperature, and power. Frequency/clock metrics were not found in the inspected sources, so AGT-008 must explicitly verify whether this requirement is unsupported and route a product gap if absent.

## Suites Run

None. This dispatch was explicitly restricted to checklist/inventory work and did not run deployment, package installs, dev servers, or broad test suites.

## Backend API/Permission Execution Procedure for BCK-001..BCK-017

Prepared: `2026-06-01T16:35:57Z`
Scope: executable procedure only. No deployment, remote commands, database resets, dev servers, or broad test suites were run while preparing this section.

### Preconditions and Live Dependencies

- Backend is already running at `API_BASE`, default `http://localhost:3001/api`.
- Admin bootstrap user exists with `ADMIN_USER`, default `admin`, and `ADMIN_PASS`, default `admin123`.
- CPU and GPU agents are being deployed separately by devops. This procedure discovers server IDs from `GET /api/servers`; it also accepts explicit `CPU_SERVER_ID` and `GPU_SERVER_ID`.
- At least one usable active image must be available or creatable through `POST /api/images`. If a live image pull is required, the CPU/GPU agents must be online.
- For storage rows, at least one local data disk ID is needed from `GET /api/servers/:id/disks` after admin registration; remote FS checks need an NFS/CephFS definition supplied by the environment:
  - `REMOTE_FS_NAME`, default generated.
  - `NFS_SERVER`, `NFS_EXPORT`, and optional `NFS_VERSION`, `REMOTE_HOST_MOUNT_POINT`.
- Container lifecycle rows require an image that exists on the target agent or that can be pulled by `POST /api/images/:id/pull`.
- Audit rows depend on `GET /api/audit` and require the admin token to include `view_audit`.
- Metrics rows depend on VictoriaMetrics receiving samples from live agents.

### Suggested Harness

Run the procedure as a single shell session after devops reports the backend and agents are ready. It uses only REST calls and local shell utilities.

```bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3001/api}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
USER_A="bck-user-a-${RUN_ID}"
USER_B="bck-user-b-${RUN_ID}"
PASS_A="${PASS_A:-BckUserA123!}"
PASS_B="${PASS_B:-BckUserB123!}"

tmpdir="$(mktemp -d)"
trap 'echo "artifacts kept in $tmpdir"' EXIT

api() {
  local method="$1"; shift
  local path="$1"; shift
  local token="${1:-}"; shift || true
  local body="${1:-}"
  local out="$tmpdir/$(echo "$method $path" | tr '/ ?&=' '_____').json"
  local headers=(-H 'Content-Type: application/json')
  if [ -n "$token" ]; then headers+=(-H "Authorization: Bearer $token"); fi
  if [ -n "$body" ]; then
    code="$(curl -sS -w '%{http_code}' -o "$out" -X "$method" "${headers[@]}" --data "$body" "$API_BASE$path")"
  else
    code="$(curl -sS -w '%{http_code}' -o "$out" -X "$method" "${headers[@]}" "$API_BASE$path")"
  fi
  printf '%s %s -> %s (%s)\n' "$method" "$path" "$code" "$out" >&2
  printf '%s %s\n' "$code" "$out"
}

expect_code() {
  local expected="$1"; shift
  local result
  result="$("$@")"
  local code="${result%% *}"
  local file="${result#* }"
  if [ "$code" != "$expected" ]; then
    echo "Expected HTTP $expected, got $code from: $*" >&2
    cat "$file" >&2
    exit 1
  fi
  echo "$file"
}

expect_code_in() {
  local csv="$1"; shift
  local result
  result="$("$@")"
  local code="${result%% *}"
  local file="${result#* }"
  case ",$csv," in
    *",$code,"*) echo "$file" ;;
    *) echo "Expected HTTP in [$csv], got $code from: $*" >&2; cat "$file" >&2; exit 1 ;;
  esac
}

jq_required() {
  jq -e "$1" "$2" >/dev/null || { echo "jq assertion failed: $1 in $2" >&2; cat "$2" >&2; exit 1; }
}

login_body="$(printf '{"username":"%s","password":"%s"}' "$ADMIN_USER" "$ADMIN_PASS")"
admin_login="$(expect_code 201 api POST /auth/login '' "$login_body")"
ADMIN_TOKEN="$(jq -r '.accessToken' "$admin_login")"
jq_required '.accessToken and .refreshToken and .user.capabilities' "$admin_login"

expect_code 401 api GET /auth/me ''
admin_me="$(expect_code 200 api GET /auth/me "$ADMIN_TOKEN")"
jq_required '.id and .username and .capabilities' "$admin_me"

servers_file="$(expect_code 200 api GET /servers "$ADMIN_TOKEN")"
CPU_SERVER_ID="${CPU_SERVER_ID:-$(jq -r '[.[] | select((.name // "" | test("cpu|CPU")) or (.isGpuServer == false))][0].id // empty' "$servers_file")}"
GPU_SERVER_ID="${GPU_SERVER_ID:-$(jq -r '[.[] | select((.name // "" | test("gpu|GPU")) or (.isGpuServer == true))][0].id // empty' "$servers_file")}"
test -n "$CPU_SERVER_ID" || { echo "CPU_SERVER_ID not discoverable from /servers; export it and re-run." >&2; exit 1; }
test -n "$GPU_SERVER_ID" || { echo "GPU_SERVER_ID not discoverable from /servers; export it and re-run." >&2; exit 1; }
```

### BCK-001 Auth and Token Baseline

Positive assertions:

- `POST /api/auth/login` with admin credentials returns `201`, `accessToken`, `refreshToken`, and admin user DTO with capability data.
- `GET /api/auth/me` with admin token returns `200` and the same admin identity.
- `POST /api/auth/refresh` with the refresh token returns `201` with a replacement access token.
- `GET /api/auth/tokens`, `POST /api/auth/tokens`, and `DELETE /api/auth/tokens/:id` return `200/201/204` for the authenticated admin.

Negative assertions:

- `GET /api/auth/me` without a token returns `401`.
- Login with an invalid password returns `401`.
- Reusing an API token after deletion returns `401`.

### BCK-002 and BCK-003 User Lifecycle and User Permission Enforcement

```bash
user_a_body="$(printf '{"username":"%s","password":"%s","displayName":"BCK User A"}' "$USER_A" "$PASS_A")"
user_a_file="$(expect_code 201 api POST /users "$ADMIN_TOKEN" "$user_a_body")"
USER_A_ID="$(jq -r '.id' "$user_a_file")"
jq_required '.username and .status' "$user_a_file"

user_b_body="$(printf '{"username":"%s","password":"%s","displayName":"BCK User B"}' "$USER_B" "$PASS_B")"
user_b_file="$(expect_code 201 api POST /users "$ADMIN_TOKEN" "$user_b_body")"
USER_B_ID="$(jq -r '.id' "$user_b_file")"

users_file="$(expect_code 200 api GET /users "$ADMIN_TOKEN")"
jq_required --arg id "$USER_A_ID" 'any(.[]; .id == $id)' "$users_file"

patch_a="$(expect_code 200 api PATCH "/users/$USER_A_ID" "$ADMIN_TOKEN" '{"displayName":"BCK User A Updated","status":"active"}')"
jq_required '.displayName == "BCK User A Updated"' "$patch_a"

ssh_key_body='{"name":"bck-key","keyText":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBckBackendPermissionTest000000000000000000000000 bck@test"}'
ssh_file="$(expect_code 201 api POST "/users/$USER_A_ID/ssh-keys" "$ADMIN_TOKEN" "$ssh_key_body")"
SSH_KEY_ID="$(jq -r '.id' "$ssh_file")"
expect_code 200 api GET "/users/$USER_A_ID/ssh-keys" "$ADMIN_TOKEN" >/dev/null
expect_code 204 api DELETE "/users/$USER_A_ID/ssh-keys/$SSH_KEY_ID" "$ADMIN_TOKEN" >/dev/null

restricted_login="$(expect_code 201 api POST /auth/login '' "$(printf '{"username":"%s","password":"%s"}' "$USER_A" "$PASS_A")")"
USER_A_TOKEN="$(jq -r '.accessToken' "$restricted_login")"
expect_code 403 api GET /users "$USER_A_TOKEN" >/dev/null
expect_code 403 api PATCH "/users/$USER_B_ID" "$USER_A_TOKEN" '{"displayName":"illegal"}' >/dev/null
expect_code 400 api PATCH "/users/$USER_A_ID" "$USER_A_TOKEN" '{"password":"MissingCurrentPassword123!"}' >/dev/null
expect_code 401 api PATCH "/users/$USER_A_ID" "$USER_A_TOKEN" '{"password":"WrongCurrentPassword123!","currentPassword":"bad"}' >/dev/null
expect_code 200 api PATCH "/users/$USER_A_ID" "$USER_A_TOKEN" '{"displayName":"Self Updated"}' >/dev/null
```

Expected evidence: admin CRUD returns `2xx`; restricted user receives `403` for cross-user management, `400/401` for invalid password-change policy, and `200` for allowed self profile update.

### BCK-016 Groups, Capabilities, and Grants

Create a restricted management group only after the negative checks above, so `USER_A_TOKEN` first proves the missing-capability behavior.

```bash
group_body='{"name":"bck-grants-'"$RUN_ID"'","description":"backend permission verification","priority":50,"capabilities":["manage_containers_any","view_metrics_all"]}'
group_file="$(expect_code 201 api POST /groups "$ADMIN_TOKEN" "$group_body")"
GROUP_ID="$(jq -r '.id' "$group_file")"
jq_required '.id and (.capabilities | index("manage_containers_any"))' "$group_file"

expect_code 200 api GET /groups "$ADMIN_TOKEN" >/dev/null
expect_code 201 api POST "/groups/$GROUP_ID/members" "$ADMIN_TOKEN" "$(printf '{"userId":"%s"}' "$USER_A_ID")" >/dev/null
expect_code 200 api GET "/groups/$GROUP_ID/members" "$ADMIN_TOKEN" >/dev/null

server_grant_cpu='{"cpuMillis":500,"memBytes":536870912,"diskBytes":1073741824,"gpuMode":"none","gpuIndices":[]}'
expect_code 201 api POST "/groups/$GROUP_ID/server-grants/$CPU_SERVER_ID" "$ADMIN_TOKEN" "$server_grant_cpu" >/dev/null

server_grant_gpu='{"cpuMillis":1000,"memBytes":1073741824,"diskBytes":2147483648,"gpuMode":"indices","gpuIndices":[0]}'
expect_code 201 api POST "/groups/$GROUP_ID/server-grants/$GPU_SERVER_ID" "$ADMIN_TOKEN" "$server_grant_gpu" >/dev/null

expect_code 200 api GET "/groups/$GROUP_ID/server-grants" "$ADMIN_TOKEN" >/dev/null
access_file="$(expect_code 200 api GET /me/access "$USER_A_TOKEN")"
jq_required --arg sid "$CPU_SERVER_ID" 'any(.servers[]; .serverId == $sid and .gpuMode == "none")' "$access_file"
jq_required --arg sid "$GPU_SERVER_ID" 'any(.servers[]; .serverId == $sid and .gpuMode == "indices")' "$access_file"

expect_code 403 api GET /groups "$USER_A_TOKEN" >/dev/null
expect_code 403 api POST "/groups/$GROUP_ID/server-grants/$CPU_SERVER_ID" "$USER_A_TOKEN" "$server_grant_cpu" >/dev/null
```

Expected evidence: admin can create/update group membership and server grants; restricted user cannot manage groups or grants unless separately granted `manage_groups`/`manage_grants`; effective access immediately reflects server grants and GPU mode.

### BCK-006 and BCK-008 Image Grants and Image Management

```bash
image_body='{"name":"bck-alpine-'"$RUN_ID"'","dockerImage":"alpine:3.20","defaultUser":"root","defaultShell":"/bin/sh","defaultUid":0,"description":"backend permission test"}'
image_file="$(expect_code 201 api POST /images "$ADMIN_TOKEN" "$image_body")"
IMAGE_ID="$(jq -r '.id' "$image_file")"
jq_required '.id and .dockerImage == "alpine:3.20"' "$image_file"

expect_code 403 api POST /images "$USER_A_TOKEN" "$image_body" >/dev/null
expect_code 403 api GET "/images/$IMAGE_ID" "$USER_A_TOKEN" >/dev/null

expect_code 201 api POST "/groups/$GROUP_ID/image-grants" "$ADMIN_TOKEN" "$(printf '{"imageId":"%s","serverId":"%s"}' "$IMAGE_ID" "$CPU_SERVER_ID")" >/dev/null
expect_code 201 api POST "/groups/$GROUP_ID/image-grants" "$ADMIN_TOKEN" "$(printf '{"imageId":"%s","serverId":"%s"}' "$IMAGE_ID" "$GPU_SERVER_ID")" >/dev/null

expect_code 200 api GET "/images/$IMAGE_ID" "$USER_A_TOKEN" >/dev/null
restricted_images="$(expect_code 200 api GET '/images?activeOnly=true' "$USER_A_TOKEN")"
jq_required --arg id "$IMAGE_ID" 'any(.[]; .id == $id)' "$restricted_images"

expect_code 200 api PATCH "/images/$IMAGE_ID" "$ADMIN_TOKEN" '{"description":"updated by BCK procedure","isActive":false}' >/dev/null
inactive_images="$(expect_code 200 api GET '/images?activeOnly=true' "$USER_A_TOKEN")"
jq -e --arg id "$IMAGE_ID" 'all(.[]; .id != $id)' "$inactive_images" >/dev/null
expect_code 200 api PATCH "/images/$IMAGE_ID" "$ADMIN_TOKEN" '{"isActive":true}' >/dev/null

# Optional live-agent pull once agents are online and Docker networking is ready:
expect_code_in 200,201,202 api POST "/images/$IMAGE_ID/pull" "$ADMIN_TOKEN" "$(printf '{"serverIds":["%s","%s"]}' "$CPU_SERVER_ID" "$GPU_SERVER_ID")" >/dev/null
expect_code 200 api GET "/images/$IMAGE_ID/status" "$ADMIN_TOKEN" >/dev/null
```

Expected evidence: restricted user sees and can use only granted active images; ungranted image detail is `403`; image management and pull/status endpoints require `manage_images`.

### BCK-007, BCK-009, and BCK-010 Server Visibility, Management, and Agent Token Lifecycle

```bash
expect_code 403 api POST /servers "$USER_A_TOKEN" '{"name":"illegal","baseUrl":"ws://invalid","parentIface":"eth0","ipCidr":"10.255.0.0/24","gateway":"10.255.0.1"}' >/dev/null

restricted_servers="$(expect_code 200 api GET /servers "$USER_A_TOKEN")"
jq_required --arg sid "$CPU_SERVER_ID" 'any(.[]; .id == $sid)' "$restricted_servers"
jq_required --arg sid "$GPU_SERVER_ID" 'any(.[]; .id == $sid)' "$restricted_servers"

expect_code 200 api GET "/servers/$CPU_SERVER_ID" "$USER_A_TOKEN" >/dev/null
expect_code 200 api GET "/servers/$GPU_SERVER_ID/gpus" "$USER_A_TOKEN" >/dev/null
expect_code 200 api GET "/servers/$CPU_SERVER_ID/disks" "$USER_A_TOKEN" >/dev/null
expect_code 403 api POST "/servers/$CPU_SERVER_ID/regenerate-token" "$USER_A_TOKEN" >/dev/null

server_patch="$(expect_code 200 api PATCH "/servers/$CPU_SERVER_ID" "$ADMIN_TOKEN" '{"description":"BCK verification touched this server"}')"
jq_required '.id' "$server_patch"
defaults_patch="$(expect_code 200 api PATCH "/servers/$CPU_SERVER_ID/defaults" "$ADMIN_TOKEN" '{"defaultCpuMillis":1000,"defaultMemBytes":1073741824,"defaultDiskBytes":2147483648,"defaultGpuMode":"none","defaultGpuIndices":[]}' )"
jq_required '.defaultCpuMillis == 1000' "$defaults_patch"

regen_file="$(expect_code 201 api POST "/servers/$CPU_SERVER_ID/regenerate-token" "$ADMIN_TOKEN")"
jq_required '.token and (.token | length > 10)' "$regen_file"
```

Expected evidence: restricted server list/detail is grant-filtered; server mutation and token regeneration are admin-only; token response body exposes a token only for create/regenerate. If agent token invalidation must be proven, coordinate with devops to restart an agent using the old token and record WS auth failure, then using the new token and record online status. Tester must not perform that deployment step.

### BCK-013, BCK-014, and Mount Source Grants

Local disk:

```bash
admin_disks="$(expect_code 200 api GET /servers/all-disks "$ADMIN_TOKEN")"
LOCAL_DISK_ID="${LOCAL_DISK_ID:-$(jq -r --arg sid "$CPU_SERVER_ID" '[.[] | select(.serverId == $sid)][0].id // .[0].id // empty' "$admin_disks")}"
if [ -n "$LOCAL_DISK_ID" ]; then
  expect_code 201 api POST "/groups/$GROUP_ID/mount-source-grants" "$ADMIN_TOKEN" "$(printf '{"sourceKind":"local","sourceId":"%s"}' "$LOCAL_DISK_ID")" >/dev/null
  mount_sources="$(expect_code 200 api GET "/mount-sources?serverId=$CPU_SERVER_ID" "$USER_A_TOKEN")"
  jq_required --arg id "$LOCAL_DISK_ID" 'any(.[]; .id == $id and .kind == "local")' "$mount_sources"
  datadir_body="$(printf '{"serverId":"%s","sourceKind":"local","sourceId":"%s","name":"bck-local-%s"}' "$CPU_SERVER_ID" "$LOCAL_DISK_ID" "$RUN_ID")"
  expect_code_in 200,201 api POST /data-dirs "$USER_A_TOKEN" "$datadir_body" >/dev/null
  expect_code 200 api GET "/data-dirs?serverId=$CPU_SERVER_ID" "$USER_A_TOKEN" >/dev/null
else
  echo "WARN: no local disk found; defer local disk grant/data-dir assertions until devops registers a disk."
fi
```

Remote FS:

```bash
if [ -n "${NFS_SERVER:-}" ] && [ -n "${NFS_EXPORT:-}" ]; then
  remote_body="$(jq -nc --arg name "${REMOTE_FS_NAME:-bck-nfs-$RUN_ID}" --arg sid "$CPU_SERVER_ID" --arg server "$NFS_SERVER" --arg exportPath "$NFS_EXPORT" --arg version "${NFS_VERSION:-4}" --arg hostMount "${REMOTE_HOST_MOUNT_POINT:-/mnt/nyabase-bck-$RUN_ID}" '{name:$name,serverIds:[$sid],hostMountPoint:$hostMount,params:{type:"nfs",nfsServer:$server,exportPath:$exportPath,version:$version}}')"
  remote_file="$(expect_code 201 api POST /system/remote-fs-mounts "$ADMIN_TOKEN" "$remote_body")"
  REMOTE_FS_ID="$(jq -r '.id' "$remote_file")"
  expect_code 200 api GET "/system/remote-fs-mounts/$REMOTE_FS_ID" "$ADMIN_TOKEN" >/dev/null
  expect_code 204 api POST "/system/remote-fs-mounts/$REMOTE_FS_ID/remount" "$ADMIN_TOKEN" >/dev/null
  expect_code 201 api POST "/groups/$GROUP_ID/mount-source-grants" "$ADMIN_TOKEN" "$(printf '{"sourceKind":"remote","sourceId":"%s"}' "$REMOTE_FS_ID")" >/dev/null
  expect_code 200 api GET "/mount-sources?serverId=$CPU_SERVER_ID" "$USER_A_TOKEN" >/dev/null
else
  echo "WARN: NFS_SERVER/NFS_EXPORT not set; remote FS lifecycle remains pending."
fi
```

Expected evidence: admin can list/register/update/delete local disks and remote mounts; restricted users see only granted mount sources. Invalid local disk paths or offline-agent disk registration should return `400`; ungranted mount source use through `/data-dirs` or container mounts should return `403`; in-use disk or remote mount removal should return a blocking `4xx` rather than silently deleting.

### BCK-004, BCK-005, and BCK-015 Container Permissions, Quota, and Lifecycle

Only execute these after `IMAGE_ID`, server grants, image grants, and agent image availability are confirmed.

```bash
container_body="$(jq -nc --arg sid "$CPU_SERVER_ID" --arg img "$IMAGE_ID" --arg name "bck-cpu-$RUN_ID" '{serverId:$sid,imageId:$img,name:$name,cpuMillis:250,memBytes:134217728,gpuIndices:[],dataDirs:[]}')"
expect_code_in 200,201 api POST /containers "$USER_A_TOKEN" "$container_body" >/dev/null
containers_a="$(expect_code 200 api GET "/containers?serverId=$CPU_SERVER_ID&ownOnly=true" "$USER_A_TOKEN")"
CPU_DOCKER_ID="$(jq -r --arg name "bck-cpu-$RUN_ID" '[.[] | select(.spec.name == $name or .name == $name)][0].dockerId // .[0].dockerId // empty' "$containers_a")"
test -n "$CPU_DOCKER_ID" || { echo "Container dockerId not visible yet; wait for agent stateReport and retry list." >&2; exit 1; }

expect_code 200 api GET "/containers/$CPU_SERVER_ID/$CPU_DOCKER_ID" "$USER_A_TOKEN" >/dev/null
expect_code 200 api POST "/containers/$CPU_SERVER_ID/$CPU_DOCKER_ID/stop" "$USER_A_TOKEN" >/dev/null
expect_code 200 api POST "/containers/$CPU_SERVER_ID/$CPU_DOCKER_ID/start" "$USER_A_TOKEN" >/dev/null
expect_code 200 api POST "/containers/$CPU_SERVER_ID/$CPU_DOCKER_ID/restart" "$USER_A_TOKEN" >/dev/null
expect_code_in 200,503 api GET "/containers/$CPU_SERVER_ID/$CPU_DOCKER_ID/stats" "$USER_A_TOKEN" >/dev/null
exec_file="$(expect_code_in 200,201 api POST "/containers/$CPU_SERVER_ID/$CPU_DOCKER_ID/exec" "$USER_A_TOKEN" '{"shell":"sh","tty":true,"cols":80,"rows":24}')"
jq_required '.sessionId' "$exec_file"

over_cpu_body="$(jq -nc --arg sid "$CPU_SERVER_ID" --arg img "$IMAGE_ID" '{serverId:$sid,imageId:$img,name:"bck-over-cpu",cpuMillis:999999999,memBytes:134217728,gpuIndices:[],dataDirs:[]}')"
expect_code_in 400,403,422 api POST /containers "$USER_A_TOKEN" "$over_cpu_body" >/dev/null

gpu_denied_body="$(jq -nc --arg sid "$CPU_SERVER_ID" --arg img "$IMAGE_ID" '{serverId:$sid,imageId:$img,name:"bck-gpu-on-cpu-grant",cpuMillis:250,memBytes:134217728,gpuIndices:[0],dataDirs:[]}')"
expect_code_in 400,403,422 api POST /containers "$USER_A_TOKEN" "$gpu_denied_body" >/dev/null

expect_code 403 api DELETE "/containers/$CPU_SERVER_ID/$CPU_DOCKER_ID" "$(jq -r '.accessToken' "$(expect_code 201 api POST /auth/login '' "$(printf '{"username":"%s","password":"%s"}' "$USER_B" "$PASS_B")")")" >/dev/null
expect_code 200 api DELETE "/containers/$CPU_SERVER_ID/$CPU_DOCKER_ID" "$USER_A_TOKEN" >/dev/null
```

For GPU coverage, repeat `POST /containers` against `GPU_SERVER_ID` using a grant with `gpuMode:"indices"` and `gpuIndices:[0]`; expected success for `[0]` and `400/403/422` for an ungranted index such as `[1]`. Record whether `DELETE /api/containers/:serverId/:dockerId` is the supported force-delete path; current controller exposes only one delete route and service/agent behavior should be verified through agent state and Docker removal evidence.

Expected evidence: own container operations return `2xx`; cross-user operations return `403` unless the actor has `manage_containers_any`; over-quota CPU/memory/GPU creates return `4xx` and no new container appears. Disk quota is enforced through granted `diskBytes` plus data directory/mount-source flows, so record disk quota evidence from data-dir/container mount attempts rather than a container `diskBytes` request field.

### BCK-011 and Metrics Access

```bash
range_param='15m'
expect_code 200 api GET "/metrics/servers/$CPU_SERVER_ID/host?range=$range_param" "$ADMIN_TOKEN" >/dev/null
expect_code 200 api GET "/metrics/servers/$CPU_SERVER_ID/users?range=$range_param" "$ADMIN_TOKEN" >/dev/null
expect_code 200 api GET "/metrics/servers/$CPU_SERVER_ID/containers?range=$range_param&all=true" "$ADMIN_TOKEN" >/dev/null
expect_code 200 api GET "/metrics/query?query=nyabase_host_cpu_usage_ratio%7Bserver%3D%22$CPU_SERVER_ID%22%7D" "$ADMIN_TOKEN" >/dev/null

expect_code 200 api GET "/metrics/servers/$CPU_SERVER_ID/host?range=$range_param" "$USER_A_TOKEN" >/dev/null
expect_code 200 api GET "/metrics/servers/$CPU_SERVER_ID/containers?range=$range_param&all=true" "$USER_A_TOKEN" >/dev/null
restricted_raw="$(expect_code 200 api GET "/metrics/query?query=nyabase_container_mem_used_bytes" "$USER_A_TOKEN")"
jq_required '.status == "success" or .data' "$restricted_raw"

expect_code 200 api GET "/metrics/servers/$GPU_SERVER_ID/gpus?range=$range_param" "$ADMIN_TOKEN" >/dev/null
```

Expected evidence: granted users can read host/server DTO metrics for granted servers; raw metric queries by restricted users are rewritten with their `user_id` filter unless they have `view_metrics_all`; GPU metrics endpoint returns a `gpus` array for the GPU server. Missing recent samples are an environment/product metrics issue to classify with VM raw query evidence.

### BCK-012 UI Metric Display Note

This dispatch is backend-only and does not run visual tests. For the backend execution batch, record API responses above as BCK-012 support only. Full UI display verification still requires a frontend/manual or Playwright dispatch because existing visual coverage only covers `/login`.

### BCK-017 Audit Checks

```bash
expect_code 403 api GET '/audit?limit=20' "$USER_A_TOKEN" >/dev/null
audit_file="$(expect_code 200 api GET '/audit?limit=100' "$ADMIN_TOKEN")"
jq_required 'type == "array"' "$audit_file"
jq_required 'any(.[]; (.action | test("group|grant|container|image|server|remote|datadir"; "i")))' "$audit_file"
```

Expected evidence: restricted user without `view_audit` receives `403`; admin receives recent audit rows with actor/action/resource details for representative user, group, grant, server, image, storage, and container operations. If specific CRUD actions above do not emit audit rows, record the missing action and route as product gap.

### Cleanup Guidance

Cleanup is optional during a live verification run because preserving evidence may be more useful. If cleanup is approved for the test environment, perform it with the admin token in reverse dependency order:

1. Delete test containers.
2. Delete data directories.
3. Revoke mount source, image, and server grants.
4. Delete remote FS test mount/assignment if created.
5. Delete image record if not needed by later agent tests.
6. Remove group membership and delete the test group.
7. Delete test users.

Do not reset the database. Record every cleanup response code in this file when executed.

## Deployment Batch 1-4 Execution: 2026-06-01T16:40:22Z

Role: devops

Scope executed: local readiness, admin login, fresh CPU/GPU server registration, agent binary build, CPU/GPU binary deployment/configuration/start, backend online/inventory checks, and baseline VictoriaMetrics/backend metrics checks. No product source or tests were edited. The backend database was not reset.

### Commands and Evidence

Local readiness:

- `curl http://127.0.0.1:8428/api/v1/query?query=up` returned HTTP `200`, JSON status `success`, result type `vector`, result count `0`.
- `curl http://localhost:3001/api/auth/me` without auth returned HTTP `401` and body `{"message":"Unauthorized","statusCode":401}`.
- Initial `curl http://localhost:5173/` returned HTTP `500` with a Vite module resolution error for missing `dep-CvfTChi5.js`. Remediation was `pnpm install` (lockfile already up to date) and restart of the documented frontend tmux pane with `npm run dev:frontend`.
- After restart, `curl http://localhost:5173/` returned HTTP `200` and HTML containing Vite/React frontend entry scripts.
- Common source artifact guard after binary build returned no output.

Admin bootstrap and registration:

- `POST /api/auth/login` with `admin` / `ADMIN_INIT_PASSWORD` succeeded. Returned user `admin` with capabilities `manage_users`, `manage_groups`, `manage_servers`, `manage_images`, `manage_grants`, `manage_containers_any`, `view_audit`, `view_metrics_all`, group `Administrators`.
- Created CPU server `nyabase-cpu-batch-20260601T163636Z`, id `05cea385-d6ca-490a-a126-e00d0ae23b70`, `parentIface=eth0`, `ipCidr=10.8.109.0/24`, `gateway=10.8.0.1`, `reservedIps=["10.8.96.91"]`, `isGpuServer=false`, initial status `unknown`, agent token present as `611ed7...125079`.
- Created GPU server `nyabase-gpu-batch-20260601T163636Z`, id `db1112fe-1c55-4314-9511-6d8510c523c2`, `parentIface=bond0`, `ipCidr=10.8.110.0/24`, `gateway=10.8.0.1`, `reservedIps=["10.8.1.12"]`, `isGpuServer=true`, initial status `unknown`, agent token present as `421785...096edd`.
- `GET /api/servers/:id` returned HTTP `200` for both created records before agent connection.

Agent build:

- `bash scripts/build-agent-binary.sh` completed successfully.
- Built artifact: `dist/nyabase-agent`, size `75973254` bytes, SHA-256 `a2fe984125ea1fb74802593d9934224d653bd5d53d16f8191bc1ba45befff68a`.
- Remote CPU and GPU copies both reported the same size and SHA-256.

CPU agent deployment:

- Host `root@10.8.96.91` reachable; hostname `nyabase-test-1`; kernel `6.12.74+deb13+1-cloud-amd64`.
- Stopped existing `nyabase-agent` and `nyabase-docker.service`, installed `/usr/local/bin/nyabase-agent`, wrote `/etc/systemd/system/nyabase-agent.service`, wrote `/etc/nyabase/agent.yaml` with `serverId=05cea385-d6ca-490a-a126-e00d0ae23b70`, `dockerRoot=/data/nyabase-docker`, `parentIface=eth0`, `macvlanCidr=10.8.0.0/16`, `macvlanGateway=10.8.0.1`, `metricsIntervalMs=10000`.
- `systemctl is-active nyabase-agent` returned `active`; `systemctl is-active nyabase-docker.service` returned `active`.
- Agent journal evidence from `2026-06-02 00:37:37 CST`: `[Agent] Reconciling nyabase-docker daemon`, `[Agent] nyabase-docker daemon is running`, `[WS] Connected`. CPU host also logs `nvidia-smi probe failed or no GPUs detected`, expected for CPU-only host.
- Managed dockerd status: active PID `2145948`, Docker `29.4.3`, storage driver `overlay2`, socket `/run/nyabase-agent/docker.sock`, data root `/data/nyabase-docker`.
- Backend evidence: CPU server status `online`, `lastSeenAt=2026-06-01T16:39:18.717Z` during first post-deploy query and later `2026-06-01T16:41:58.780Z`; `dockerRoot=/data/nyabase-docker`; `dockerSocket=/run/nyabase-agent/docker.sock`; docker daemon state `active`, `unitFileInSync=true`, `enabled=true`, `lastError=null`.
- `GET /api/servers/:cpuId/disks` returned an empty list. No data disks were registered in this batch.

GPU agent deployment:

- Host `lyn@10.8.1.12` reachable with passwordless sudo; hostname `aya-1`; kernel `5.15.0-161-generic`.
- `nvidia-smi -L` showed four NVIDIA L40 GPUs. `command -v nvidia-container-runtime` returned `/usr/bin/nvidia-container-runtime`. System Docker was active.
- Installed `/usr/local/bin/nyabase-agent`, wrote `/etc/systemd/system/nyabase-agent.service`, wrote `/etc/nyabase/agent.yaml` with `serverId=db1112fe-1c55-4314-9511-6d8510c523c2`, `dockerRoot=/data0/nbTest/nyabase-docker`, `parentIface=bond0`, `macvlanCidr=10.8.0.0/16`, `macvlanGateway=10.8.0.1`, `metricsIntervalMs=10000`, `isGpuServer=true`.
- `sudo systemctl is-active nyabase-agent` returned `active`; `sudo systemctl is-active nyabase-docker.service` returned `active`; system Docker also remained `active`.
- Agent journal evidence from `2026-06-01 16:37:23 UTC`: `[Agent] Reconciling nyabase-docker daemon`, `[Agent] nyabase-docker daemon is running`, `[WS] Connected`.
- Managed dockerd status: active PID `1886851`, Docker `29.0.2`, storage driver `overlay2`, socket `/run/nyabase-agent/docker.sock`, data root `/data0/nbTest/nyabase-docker`.
- `sudo DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker info` included `Runtimes: io.containerd.runc.v2 nvidia runc`, `Default Runtime: runc`, `Docker Root Dir: /data0/nbTest/nyabase-docker`.
- `nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv,noheader,nounits` returned four NVIDIA L40 GPUs with UUIDs `GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19`, `GPU-23d8fdac-e091-5c42-df3c-8f72f52ef5fe`, `GPU-597b76dd-7b55-577b-cad7-bc6638a43541`, and `GPU-14a856ae-d536-7446-a361-008dc8c3f4a7`; each reported `46068` MiB.
- Backend evidence: GPU server status `online`, `lastSeenAt=2026-06-01T16:39:21.453Z` during first post-deploy query and later `2026-06-01T16:42:01.626Z`; `dockerRoot=/data0/nbTest/nyabase-docker`; `dockerSocket=/run/nyabase-agent/docker.sock`; docker daemon state `active`, `unitFileInSync=true`, `enabled=true`, `lastError=null`.
- `GET /api/servers/:gpuId/gpus` returned four GPUs matching the host inventory by index, UUID, model, and `totalMemMiB=46068`.

Metrics evidence:

- Raw VM queries use the product's current label `server="<serverId>"`, not `server_id`. Earlier `server_id` queries returned zero results; `/api/v1/series?match[]=nyabase_host_cpu_usage_ratio` confirmed the `server` label.
- CPU VM instant queries: `nyabase_host_cpu_usage_ratio{server="05cea385-d6ca-490a-a126-e00d0ae23b70"}` result count `1`, sample `0.0005002501250624`; `nyabase_host_mem_used_bytes{server="05cea385-d6ca-490a-a126-e00d0ae23b70"}` result count `1`, sample `677752832`.
- GPU host VM instant queries: `nyabase_host_cpu_usage_ratio{server="db1112fe-1c55-4314-9511-6d8510c523c2"}` result count `1`, sample `0.0016190243166`; `nyabase_host_mem_used_bytes{server="db1112fe-1c55-4314-9511-6d8510c523c2"}` result count `1`, sample `21259567104`.
- GPU VM instant queries for `db1112fe-1c55-4314-9511-6d8510c523c2`: `nyabase_gpu_util_ratio`, `nyabase_gpu_mem_used_bytes`, `nyabase_gpu_temp_celsius`, and `nyabase_gpu_power_watts` each returned result count `4`.
- Backend metrics APIs: CPU host range returned HTTP `200` with `3` points for `cpu`, `memUsed`, `memTotal`, and `load1`; GPU host range returned HTTP `200` with `2` points for those same series; GPU metrics range returned HTTP `200` with four GPU entries and `util`, `memUsed`, `temp`, `power` point series.

### Checklist Status Updates

| ID | Batch status | Evidence | Next action |
| --- | --- | --- | --- |
| ENV-001 | pass | Local VictoriaMetrics HTTP `200`, JSON `success`; VM accepted and later returned nyabase host/GPU metrics. | Continue using existing `nyabase-vm`. |
| ENV-002 | pass | Backend port `3001` listening; unauthenticated `/api/auth/me` returned `401`; backend accepted admin login and agent WS connections. | Keep backend running for later batches. |
| ENV-003 | pass-with-remediation | Initial frontend returned Vite HTTP `500`; after `pnpm install` and restarting the documented frontend tmux pane, frontend root returned HTTP `200` HTML. | Monitor for recurrence of missing Vite chunk/module issue. |
| AGT-001 | pass | CPU agent and `nyabase-docker.service` active; journal shows `[WS] Connected`; backend CPU server online. | Proceed to deeper CPU lifecycle/container/storage tests. |
| AGT-002 | pass | Backend CPU server online with docker root/socket and active docker daemon; host metrics present in VM/API. `GET /api/servers/:id/disks` returned empty because no disk was registered. | Register data disk in storage batch. |
| AGT-003 | pass | GPU agent and `nyabase-docker.service` active; journal shows `[WS] Connected`; backend GPU server online; nyabase dockerd exposes `nvidia` runtime. | Proceed to GPU container/quota tests. |
| AGT-004 | pass | Host `nvidia-smi` and backend `/api/servers/:gpuId/gpus` both report four NVIDIA L40 GPUs with matching indices/UUIDs/model/memory. | Use this server for GPU workload metrics and container tests. |
| BCK-001 | pass | Admin login succeeded; returned admin user DTO with expected capabilities and tokens. | Reuse local admin token only for current shell/session; do not persist token in docs. |
| BCK-009 | pass | Fresh CPU and GPU server records created with documented network fields; one-time agent tokens captured only as masked evidence. Server records went online after agent start. | Later token lifecycle/regenerate checks remain for BCK-010. |
| BCK-011 | pass for host/GPU baseline | VM has recent host metrics for CPU/GPU servers and GPU util/mem/temp/power for GPU server. Backend host and GPU metrics APIs returned non-empty series. | Container/user metrics remain pending until managed test containers exist. |

### Blockers and Warnings

- No RED blocker for deployment batch 1-4. Both fresh agents are connected and reporting.
- Frontend readiness required remediation: a stale/broken Vite runtime served HTTP `500` until the dev pane was restarted after `pnpm install`.
- The product metrics label for server identity is `server`, while some deployment notes said `server_id`. Use `server="<id>"` for VM queries in later batches.
- Known product gaps were not fixed in this devops batch: GPU frequency/clock metrics are not implemented, and container detail GPU memory attribution remains out of scope until container workload tests.

### Checklist Coverage Map

| Checklist row | Covered by procedure section |
| --- | --- |
| BCK-001 | Auth and Token Baseline |
| BCK-002 | User Lifecycle |
| BCK-003 | User Permission Enforcement |
| BCK-004 | Container Permissions |
| BCK-005 | Quota including GPU |
| BCK-006 | Image Grants |
| BCK-007 | Server Visibility |
| BCK-008 | Image Management |
| BCK-009 | Server Management |
| BCK-010 | Agent Token Lifecycle coordination note |
| BCK-011 | Metrics Access |
| BCK-012 | UI Metric Display note; backend API support only |
| BCK-013 | Local Storage Management |
| BCK-014 | Remote Storage Management |
| BCK-015 | Container Lifecycle |
| BCK-016 | Groups, Capabilities, and Grants |
| BCK-017 | Audit Checks |

## Backend API/Permission Execution Batch: 2026-06-01T17:03:12Z

Role: tester

Scope executed: BCK-001 through BCK-017 backend REST/API and permission verification against the live local backend at `http://localhost:3001/api`. No product source was edited. No database reset was performed. No agent services were restarted or redeployed. Active CPU/GPU agent tokens were not regenerated; token regeneration was exercised only on a disposable offline server record. Raw JWTs, refresh tokens, API tokens, and agent tokens are omitted or masked.

### Procedure Corrections Applied

- `POST /api/auth/login` and `POST /api/auth/refresh` are `@HttpCode(200)`. The earlier draft that expected `201` was a test-procedure bug.
- Local `jq` is not installed (`/bin/bash: jq: command not found`). The first shell harness attempt stopped immediately because it used `jq`; that is classified as `Root cause: test`. The execution was continued with inline Node.js scripts using `fetch` and `JSON.parse`.
- Mount source grants were verified through the current global endpoints:
  - `POST /api/mount-sources/grants/:sourceKind/:sourceId` with body `{ "scope": "group" | "user", "scopeId": "..." }`.
  - `GET /api/mount-sources/grants?sourceKind=...&sourceId=...`.
  - `DELETE /api/mount-sources/grants/:sourceKind/:sourceId/:scope/:scopeId`.
- Remote FS endpoints were verified under `/api/system/remote-fs-mounts`, not `/api/remote-fs-mounts`.
- NFS params use `{ type: "nfs", nfsServer, exportPath, version }`; a prior `{ server, exportPath }` body was a test-procedure bug.
- Server `PATCH /api/servers/:id` was executed only with current accepted fields or an intentionally ignored extra `description` field; no behavior was asserted on `description`.
- Image ACL negative checks must use a grant-only user. A user with `manage_containers_any` intentionally bypasses image ACL and sees all images, so the earlier negative check with that user was a test-procedure bug.
- Container list DTO carries the Docker id at `spec.dockerId`; an earlier corrective script looked only at top-level `dockerId`, causing a false "not visible" assertion. The lifecycle pass was rerun with the corrected DTO extraction.

Representative Node harness pattern:

```bash
CPU_SERVER_ID=05cea385-d6ca-490a-a126-e00d0ae23b70 \
GPU_SERVER_ID=db1112fe-1c55-4314-9511-6d8510c523c2 \
node --input-type=module <<'NODE'
const API_BASE = 'http://localhost:3001/api';
async function request(method, path, token = '', body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, init);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body: parsed };
}
// Tokens were stored only in process memory and never written to this report.
NODE
```

### Execution Runs and Raw Outcomes

1. Initial shell harness, `20260601T165114Z`: stopped at local `jq` missing. The failure is `Root cause: test`; no product failure was recorded from this run.
2. Node API run, `20260601165604`: `86` HTTP requests, `78` expected outcomes, `7` reported failures, `3` skips. The reported failures were reclassified after correction:
   - BCK-016 CPU/GPU grant assertions used a `manage_containers_any` user, so `/me/access` correctly returned all-server/all-image access instead of the expected narrow grant DTO. `Root cause: test`.
   - BCK-006 ungranted image list/detail checks used the same `manage_containers_any` user. `Root cause: test`.
   - BCK-015/BCK-005 container/quota attempts used `busybox:latest`, which was not present in the managed dockerd and image pull was intentionally not enabled. `Root cause: test/env precondition`, corrected with preloaded Ubuntu images.
3. ACL/grant corrective run, `20260601165808`: `18` requests/assertions, `18` pass, `0` fail.
4. Container/storage corrective run, `20260601170001`: quota and disk registration checks passed, but container visibility assertion failed because the script read the wrong DTO field. `Root cause: test`. The created container appeared later in `/containers?serverId=...` and was deleted with `DELETE /api/containers/:serverId/:dockerId` returning `200`.
5. Container lifecycle corrective run, `20260601170125`: `28` requests/assertions, `22` pass, `0` fail.
6. Mount/data-dir corrective run, `20260601170312`: `20` requests/assertions, `18` pass, `0` fail.

Product-relevant final count after correcting procedure bugs: `136` pass, `0` product fail, `2` skipped/deferred:

- skipped image pull because `ATTEMPT_IMAGE_PULL` was not set and CPU/GPU managed dockerd already had the required Ubuntu images.
- skipped full remote NFS mounted-state verification because no real NFS export was provided for this batch; REST CRUD/remount API was covered.

### BCK Results

| ID | Status | Evidence | Failures / blockers | Next action |
| --- | --- | --- | --- | --- |
| BCK-001 | pass | `GET /auth/me` unauth `401`; bad login `401`; admin login `200`; `/auth/me` with admin `200`; refresh `200`; API token create `201`, token auth `200`, delete `204`, deleted token auth `401`. Tokens masked only in console evidence. | None. | Keep login/refresh expected status at `200` in future procedures. |
| BCK-002 | pass | Admin user lifecycle: create A/B `201`, list `200`, get `200`, patch display/status `200`, add SSH key `201`, list SSH keys `200`, delete SSH key `204`. Cleanup deleted test users. | Initial username used uppercase timestamp and failed Zod with `400 username: Invalid`; corrected to lowercase. Root cause: test. | Use lowercase `[a-z0-9_-]` usernames. |
| BCK-003 | pass | Restricted user login `200`; `GET /users` denied `403`; get other user `403`; patch other user `403`; self password missing current `400`; wrong current password `401`; self display update `200`. | None after username correction. | n/a |
| BCK-004 | pass | CPU container owner detail `200`; second restricted user detail denied `403`. | Required preloaded `ubuntu:24.04` image record; `busybox:latest` attempt was blocked by missing local image. | Use known host-local images or set `ATTEMPT_IMAGE_PULL=1` in an explicit pull batch. |
| BCK-005 | pass | With low CPU grant, over-CPU container request returned `400` before agent RPC. With GPU grant `gpuMode=indices`, requesting disallowed GPU index `[1]` returned `400` before agent RPC. | Earlier `busybox`/oversized Docker CPU attempts returned agent `502`; corrected with preloaded Ubuntu image and smaller denied requests. Root cause: test/env. | Add a future GPU positive container run if workload/image policy permits. |
| BCK-006 | pass | Grant-only user saw only the granted image in `/images` (`visible=1`), could get granted image detail `200`, and ungranted image detail returned `403`. | Earlier negative check used `manage_containers_any`, which intentionally sees all images. Root cause: test. | Keep image ACL negative checks grant-only. |
| BCK-007 | pass | User A with server grants listed `2` servers and CPU detail returned `200`; user B with no grants listed `0` servers and CPU detail returned `404`. | None. | n/a |
| BCK-008 | pass for API lifecycle; pull deferred | Admin image create granted/ungranted `201`; list `200`; get `200`; patch inactive `200`; patch active `200`; cleanup delete executed. | Pull skipped intentionally because required images were already present and this batch avoided extra network/docker mutation. | Separate image pull/progress batch can run with `ATTEMPT_IMAGE_PULL=1` if desired. |
| BCK-009 | pass | Existing CPU server detail `200`; extra `description` field patch returned `200` but no assertion was made on it; defaults patch `200`; self-check `200`. Disposable server create `201` with masked token, regenerate token `201`, delete `204`. Active agent tokens were not regenerated. | None. | Keep active token lifecycle for coordinated BCK-010 only. |
| BCK-010 | not in this narrow batch | Not executed against active agents by instruction; disposable offline token regeneration covered the server API shape only. | Coordinated agent restart/reconfigure required to prove old/new active token behavior. | Dispatch a dedicated token lifecycle batch if needed. |
| BCK-011 | pass | Raw instant metrics proxy `200`; CPU host metrics API `200`; GPU metrics API `200`; users metrics API `200`; containers metrics API `200`; restricted raw query with user injection `200`; ungranted user CPU host metrics denied `404`. | None. | User/container metric non-empty content depends on live workload duration; APIs are verified. |
| BCK-012 | not in backend-only scope | No frontend/visual route checks were run. | Backend-only dispatch. | Future frontend tester dispatch if UI metric display is in scope. |
| BCK-013 | pass | CPU `/servers/:id/disks` `200`; registering CPU `/data` XFS disk returned `201`; registering GPU `/data0/nbTest` XFS disk returned `201`; non-XFS/root add returned `400` in earlier run. Temporary disks created by the corrective pass were removed during cleanup. | None after PM supplied XFS prerequisites. | A future in-use disk removal negative can be run with an attached container mount. |
| BCK-014 | pass for REST API; mounted-state deferred | Corrected NFS body create under `/system/remote-fs-mounts` returned `201`; list `200`; get `200`; patch `200`; list assigned servers `200`; remount endpoint `204`; group remote mount-source grant `201`, list `200`. Cleanup removed the test mount. | No real NFS export was provided, so actual mounted-state/IO was not asserted. This is environment coverage, not product failure. | Provide NFS export and run mount status/read-write verification. |
| BCK-015 | pass | CPU Ubuntu container create `201`; container became visible by `spec.dockerId`; detail `200`; stats `200`; exec `201`; stop `201`; start `201`; restart `201`; mounts list `200`; mounts empty patch `200`; delete/force path `200`. | First visibility failure was a DTO extraction test bug; corrected run passed. | GPU positive lifecycle remains optional/future. |
| BCK-016 | pass | Restricted groups denied `403`; group create `201`; add member `201`; list members `200`; group CPU server grant `201`; group GPU grant `201`; grant-only `/me/access` returned CPU grant `{cpuMillis:500, memBytes:536870912, diskBytes:1073741824, gpuMode:"none", gpuIndices:[]}` and GPU grant `{cpuMillis:1000, memBytes:1073741824, diskBytes:2147483648, gpuMode:"indices", gpuIndices:[0]}`; effective access admin `200`; group image grant `201`; global local mount-source grant `201`, listed `200`, user mount-source visibility `200`, delete grant `204`; group remote mount grant `201`, list `200`. | None after using grant-only user for exact access assertions. | n/a |
| BCK-017 | pass | Restricted audit request `403`; admin `GET /audit?limit=20` returned `200` with `20` rows after representative create/update/delete/grant/container/storage actions. | None. | Spot-check individual audit action names in a deeper audit batch if required. |

### Container and Storage Evidence Details

- CPU server id used: `05cea385-d6ca-490a-a126-e00d0ae23b70`.
- GPU server id used: `db1112fe-1c55-4314-9511-6d8510c523c2`.
- Existing managed dockerd images from PM evidence were used:
  - CPU: `ubuntu:24.04`.
  - GPU: `ubuntu:22.04`.
- CPU container lifecycle used a temporary image record pointing to `ubuntu:24.04` with `cmd="sleep 3600"`. The created container was visible with Docker id prefix `04c2227a0939` and was deleted successfully.
- CPU `/data` and GPU `/data0/nbTest` were accepted as XFS data roots through the REST API. Temporary disk records from corrective runs were cleaned up.
- Global local mount grant test created CPU disk id `759ee121-2ac7-4748-8d6e-4b3da93ad683`, granted it to a temporary group, verified it appeared in `GET /mount-sources?serverId=:cpuId`, created/listed/deleted a local data dir, then deleted the grant and cleanup objects.

### Remaining Deferred Items

- BCK-010 active agent token lifecycle was not executed because it requires coordinated agent restart/reconfiguration and the prompt explicitly warned not to regenerate active agent tokens in this batch.
- Full NFS mounted status and read/write verification were not executed because no real NFS export was provided. Current evidence covers remote FS REST lifecycle and remount command acceptance only.
- Positive GPU container lifecycle was not executed; GPU quota denial and GPU grant indices were verified. A positive GPU workload can be a separate batch using a known GPU-capable image.
- UI metric display BCK-012 was not executed because this was backend-only and no Playwright/visual suite was applicable.

## Focused GPU Clock Metrics and Container GPU Memory Tests

Updated: `2026-06-01T17:19:20Z`
Scope: focused automated tester dispatch for the implemented GPU clock metric and live container GPU memory changes. Product source was not edited.

### Files Added or Updated

- Added `packages/agent/src/gpu/gpu-monitor.test.ts`.
- Updated `packages/agent/src/docker/docker-client.test.ts`.
- Updated `packages/agent/src/commands/dispatcher.test.ts`.
- Added `packages/backend/src/metrics/metrics.controller.test.ts`.
- Added `packages/frontend/e2e/gpu-metrics.spec.ts`.
- Updated `packages/frontend/e2e/ROUTES.md`.
- Added visual baselines:
  - `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/server-gpu-clock.png`
  - `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/container-gpu-memory.png`

### Commands and Results

1. `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`
   - Result: PASS, no output.

2. `pnpm --filter @nyabase/agent exec vitest run src/gpu/gpu-monitor.test.ts src/docker/docker-client.test.ts src/commands/dispatcher.test.ts`
   - First run: FAIL, `packages/agent/src/gpu/gpu-monitor.test.ts` had test harness issues:
     - `execFile` assertion did not account for the promisify callback.
     - ESM namespace spying on `fs.existsSync`/`fs.readFileSync` was invalid.
     - Root cause: test.
   - Corrected run: PASS.
   - Final count: `3` test files, `23` tests passed, `0` failed, `0` skipped.

3. `pnpm --filter @nyabase/backend exec vitest run src/metrics/metrics.controller.test.ts`
   - Result: PASS.
   - Count: `1` test file, `1` test passed, `0` failed, `0` skipped.

4. `bash scripts/check-visual.sh`
   - First run after adding visual spec: FAIL.
     - `authenticated GPU rendering › server GPU metrics show the graphics clock chart` asserted static text `1410 MHz`, but Recharts does not render the final tooltip value as persistent text. Root cause: test.
     - `authenticated GPU rendering › container detail shows positive GPU memory rows` passed DOM assertions and produced a missing-snapshot bootstrap. Root cause: baseline.
   - Second run after assertion correction: FAIL only because new `server-gpu-clock.png` baseline was missing. Root cause: baseline.
   - Fresh screenshot inspection:
     - `packages/frontend/e2e/.test-results/gpu-metrics-authenticated--82491-ow-the-graphics-clock-chart-chromium/server-gpu-clock-actual.png` showed the server page scrolled to host/GPU metrics, with the GPU chart row including `图形时钟 (MHz)`. No visible clipping/overlap was observed at the shipped `1366x900` viewport.
     - `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/container-gpu-memory.png` showed the container detail overview with `GPU 显存`, the GPU UUID, and `768 MiB`. Zero/NaN fixture entries were not rendered. No visible clipping/overlap was observed at the shipped `1366x900` viewport.
   - `pnpm --filter @nyabase/frontend exec playwright test --update-snapshots`
     - Result: PASS, `4` passed, new baselines written/regenerated.
   - Final rerun `bash scripts/check-visual.sh`
     - Result: PASS.
     - Count: `4` passed, `0` failed, `0` skipped.

5. Final guard rerun: `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`
   - Result: PASS, no output.

### Coverage of Acceptance Criteria

| AC | Coverage | Status |
| --- | --- | --- |
| 1 | `packages/agent/src/gpu/gpu-monitor.test.ts` — `queries and parses clocks.gr into graphicsClockMHz when supported`; `emits graphics clock metrics only for finite non-negative clock values`. | covered |
| 2 | `packages/agent/src/gpu/gpu-monitor.test.ts` — `sums MiB by GPU UUID for matching full and short Docker IDs`; `returns an empty map when disabled`; `skips bad nvidia-smi rows, unresolved cgroups, and nvidia-smi failures safely`. | covered |
| 3 | `packages/agent/src/docker/docker-client.test.ts` — `preserves parsed Docker stats and merges provider GPU memory`; `returns existing stats with an empty GPU map when the provider fails`; `packages/agent/src/commands/dispatcher.test.ts` — `acks stats from Docker stats merged with the injected GPU memory provider`. | covered |
| 4 | `packages/backend/src/metrics/metrics.controller.test.ts` — `returns graphicsClockMHz and includes clock-only GPU indices in the union`. | covered |
| 5 | `packages/frontend/e2e/gpu-metrics.spec.ts` — `server GPU metrics show the graphics clock chart`; `container detail shows positive GPU memory rows`; `packages/frontend/e2e/ROUTES.md` updated. | covered |
| 6 | Common artifact guard command returned no output before and after test/visual runs. | covered |
| 7 | All observed failures were test-harness or baseline bootstrap/correction issues; no product failures remained. Exact failing references are listed under Commands and Results. | covered |

### Visual Artifacts

- `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/server-gpu-clock.png` — new/updated baseline. Authenticated `/servers/:id` fixture, scrolled to GPU metrics, shows `图形时钟 (MHz)` chart.
- `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/container-gpu-memory.png` — new baseline. Authenticated `/containers/:serverId/:dockerId` fixture, shows positive per-GPU memory rows.
- `packages/frontend/e2e/.test-results/.last-run.json` — final Playwright result marker after green run.

### Final Focused Verdict

Verdict: PASS.
Suites run: agent focused vitest, backend focused vitest, visual (playwright), common-src artifact guard.
Counts: `28` passed, `0` failed, `0` skipped across final focused runs (`23` agent + `1` backend + `4` visual).
Failing tests: none in final runs.
Coverage gaps: no live GPU host or live Docker daemon integration was exercised in this focused unit/visual dispatch; those remain covered by the broader deployment checklist rows above.

## Local Agent Binary Redeploy and Live GPU Metrics Verification: 2026-06-01T17:32:03Z

Role: devops

Scope executed: rebuilt the standalone agent binary from the current workspace, deployed it over the existing CPU and GPU host binaries, restarted existing agent services without regenerating tokens, rebuilt/restarted the stale local backend `dist/main.js` so metrics API code matched the current workspace, verified GPU graphics clock metrics in VictoriaMetrics and backend API, ran a temporary GPU memory workload in a nyabase-managed GPU container, verified per-container GPU memory attribution, cleaned up the temporary container and host workload binary, and reran the common-src artifact guard. No product source or test source was edited.

### Commands and Results

1. Preflight and build:
   - `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`
     - Exit code `0`; no output.
   - `bash scripts/build-agent-binary.sh`
     - Exit code `0`.
     - Built `dist/nyabase-agent`, size `75974833` bytes, SHA-256 `972261d81dd27b8320f7cea69fcb7acc361ce544c211c23999aacd7fbe62a0fd`.
   - Post-build common-src guard:
     - Exit code `0`; no output.

2. CPU host deploy:
   - Host `root@10.8.96.91`, server id `05cea385-d6ca-490a-a126-e00d0ae23b70`.
   - Commands: `scp dist/nyabase-agent root@10.8.96.91:/tmp/nyabase-agent.new`; remote `systemctl stop nyabase-agent`; `systemctl stop nyabase-docker.service 2>/dev/null || true`; `install -m 0755 /tmp/nyabase-agent.new /usr/local/bin/nyabase-agent`; `systemctl daemon-reload`; `systemctl start nyabase-agent`.
   - Exit code `0`.
   - Remote `/usr/local/bin/nyabase-agent` SHA-256 `972261d81dd27b8320f7cea69fcb7acc361ce544c211c23999aacd7fbe62a0fd`.
   - `systemctl is-active nyabase-agent` -> `active`; `systemctl is-active nyabase-docker.service` -> `active`.
   - Journal tail after restart showed `[Agent] Started`, `[Agent] nyabase-docker daemon is running`, `[WS] Connected`; CPU host also logged expected `nvidia-smi probe failed or no GPUs detected`.

3. GPU host deploy:
   - Host `lyn@10.8.1.12`, server id `db1112fe-1c55-4314-9511-6d8510c523c2`.
   - Commands: `scp dist/nyabase-agent lyn@10.8.1.12:/tmp/nyabase-agent.new`; remote `sudo systemctl stop nyabase-agent`; `sudo systemctl stop nyabase-docker.service 2>/dev/null || true`; `sudo install -m 0755 /tmp/nyabase-agent.new /usr/local/bin/nyabase-agent`; `sudo systemctl daemon-reload`; `sudo systemctl start nyabase-agent`.
   - Exit code `0`.
   - Remote `/usr/local/bin/nyabase-agent` SHA-256 `972261d81dd27b8320f7cea69fcb7acc361ce544c211c23999aacd7fbe62a0fd`.
   - `sudo systemctl is-active nyabase-agent` -> `active`; `sudo systemctl is-active nyabase-docker.service` -> `active`.
   - Journal tail after restart showed `[Agent] Started`, `[Agent] nyabase-docker daemon is running`, `[WS] Connected`.
   - Managed dockerd check: `DockerRoot=/data0/nbTest/nyabase-docker`, runtimes included `nvidia`, default runtime `runc`.

4. Backend rebuild/restart:
   - Initial backend `/api/metrics/servers/:gpuId/gpus?range=15m` was missing `graphicsClockMHz` although VM already had `nyabase_gpu_clock_graphics_mhz`; `rg` showed `packages/backend/dist` was stale. Classification: procedure/build freshness, not product failure.
   - `pnpm --filter @nyabase/backend build`
     - Exit code `0`; `packages/backend/dist/metrics/metrics.controller.js` now contains `nyabase_gpu_clock_graphics_mhz` and `graphicsClockMHz`.
   - Restarted existing tmux backend pane `nyabase:dev.0` with `cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && node -r tsconfig-paths/register dist/main.js`.
   - `curl http://127.0.0.1:3001/api/auth/me` returned HTTP `401` after restart.
   - Backend log showed both agents reconnecting to `/ws/agent`.

5. Online status and GPU clock checks:
   - `GET /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70` returned HTTP `200`, status `online`, `lastSeenAt=2026-06-01T17:31:48.564Z`, `dockerRoot=/data/nyabase-docker`.
   - `GET /api/servers/db1112fe-1c55-4314-9511-6d8510c523c2` returned HTTP `200`, status `online`, `lastSeenAt=2026-06-01T17:31:51.610Z`, `dockerRoot=/data0/nbTest/nyabase-docker`.
   - VM instant query `nyabase_gpu_clock_graphics_mhz{server="db1112fe-1c55-4314-9511-6d8510c523c2"}` returned HTTP `200`, result count `4`:
     - GPU `0`: timestamp `1780335111`, value `2490`.
     - GPU `1`: timestamp `1780335111`, value `210`.
     - GPU `2`: timestamp `1780335111`, value `210`.
     - GPU `3`: timestamp `1780335111`, value `210`.
   - Backend `GET /api/metrics/servers/db1112fe-1c55-4314-9511-6d8510c523c2/gpus?range=15m` returned HTTP `200`, `4` GPU entries, each with non-empty `graphicsClockMHz.points`:
     - GPU `0`: `8` points, last `{ "t": 1780335060, "v": 2490 }`.
     - GPU `1`: `8` points, last `{ "t": 1780335060, "v": 210 }`.
     - GPU `2`: `8` points, last `{ "t": 1780335060, "v": 210 }`.
     - GPU `3`: `8` points, last `{ "t": 1780335060, "v": 210 }`.

6. Positive GPU container memory attribution:
   - Existing managed dockerd image used: `ubuntu:22.04`.
   - Verified GPU runtime can expose NVIDIA devices and `nvidia-smi` inside `ubuntu:22.04`: `docker run --rm --gpus device=0 ubuntu:22.04 ... nvidia-smi -L` printed `GPU 0: NVIDIA L40`.
   - Compiled temporary host helper `/tmp/nyabase-cuda-hold` from `/tmp/nyabase-cuda-hold.c` using `gcc -O2 -Wall -Wextra -ldl`. The helper uses CUDA Driver API through `libcuda.so.1` to allocate GPU memory and sleep.
   - Created nyabase-managed GPU container through backend:
     - `POST /api/containers` body used server `db1112fe-1c55-4314-9511-6d8510c523c2`, image `890ef43a-21bf-404d-82d8-7f4424ac3d67` (`ubuntu:22.04`), name `gpu-mem-mpvhhpup`, `cpuMillis=500`, `memBytes=1073741824`, `gpuIndices=[0]`.
     - HTTP `201`, then `/api/containers?serverId=...` showed Docker ID `52f5b3b7bc801b83c567828347a91a082bf2332123e9083c3661823ce481a645`, status `running`, owner `75f36ff6-307d-4bec-a0da-dc476ff7b462`.
   - Copied helper into the container with `sudo DOCKER_HOST=unix:///run/nyabase-agent/docker.sock docker cp /tmp/nyabase-cuda-hold <dockerId>:/tmp/nyabase-cuda-hold`, then ran `docker exec -d <dockerId> /tmp/nyabase-cuda-hold 512 180`.
   - Host `nvidia-smi --query-compute-apps=pid,used_memory,gpu_uuid,process_name --format=csv,noheader,nounits` showed the container process PID `1916679`, used memory `938` MiB, GPU UUID `GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19`, process `/tmp/nyabase-cuda-hold`.
   - `/proc/1916679/cgroup` included `0::/system.slice/docker-52f5b3b7bc801b83c567828347a91a082bf2332123e9083c3661823ce481a645.scope`.
   - VM instant query `nyabase_gpu_proc_mem_used_bytes{server="db1112fe-1c55-4314-9511-6d8510c523c2",container_id="52f5b3b7bc801b83c567828347a91a082bf2332123e9083c3661823ce481a645"}` returned HTTP `200`, result count `1`, value `983564288`, labels included `gpu_uuid="GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19"` and `user_id="75f36ff6-307d-4bec-a0da-dc476ff7b462"`.
   - Backend `GET /api/containers/db1112fe-1c55-4314-9511-6d8510c523c2/52f5b3b7bc801b83c567828347a91a082bf2332123e9083c3661823ce481a645/stats` returned HTTP `200`, `stats.gpuMemUsedMiB={"GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19":938}`.
   - Backend container detail returned status `running`, `spec.gpuIndices=[0]`, and the same non-empty `stats.gpuMemUsedMiB`.
   - Cleanup: `DELETE /api/containers/db1112fe-1c55-4314-9511-6d8510c523c2/52f5b3b7bc801b83c567828347a91a082bf2332123e9083c3661823ce481a645` returned HTTP `200`, body `{"ok":true}`. Removed remote `/tmp/nyabase-cuda-hold` and `/tmp/nyabase-cuda-hold.c`.

7. Final guard and service checks:
   - Final common-src artifact guard returned exit code `0` and no output.
   - Final local backend check: `GET /api/auth/me` without auth returned HTTP `401`.
   - Final local VM check: `GET /api/v1/query?query=up` returned HTTP `200`.
   - Final frontend check was out of scope for this dispatch; `curl http://127.0.0.1:5173/` returned HTTP `000` / connection refused, so the prior frontend dev process is not currently reachable.

### Acceptance Criteria Status

| AC | Status | Evidence |
| --- | --- | --- |
| 1 | pass | `dist/nyabase-agent` built from current workspace, size `75974833`, SHA-256 `972261d81dd27b8320f7cea69fcb7acc361ce544c211c23999aacd7fbe62a0fd`. |
| 2 | pass | CPU and GPU remote binaries both match SHA-256 `972261d81dd27b8320f7cea69fcb7acc361ce544c211c23999aacd7fbe62a0fd`; both `nyabase-agent` and `nyabase-docker.service` are `active`; backend reports both servers `online`. |
| 3 | pass | VM query `nyabase_gpu_clock_graphics_mhz{server="db1112fe-1c55-4314-9511-6d8510c523c2"}` returned `4` GPU samples in the latest scrape window. |
| 4 | pass | Backend `/api/metrics/servers/db1112fe-1c55-4314-9511-6d8510c523c2/gpus?range=15m` returned `4` GPU entries with non-empty `graphicsClockMHz.points`. |
| 5 | pass | Temporary managed GPU container produced VM `nyabase_gpu_proc_mem_used_bytes` with full `container_id`, `gpu_uuid`, and `user_id`; `/api/containers/:serverId/:dockerId/stats` returned non-empty `gpuMemUsedMiB` of `938` MiB. |
| 6 | pass | Common-src artifact guard returned no output before build, after build, and after deploy/runtime checks. |

### Warnings

- Backend `dist` was stale at the start of this dispatch; VM had the new clock metric from the updated agent, but backend metrics API did not expose `graphicsClockMHz` until `pnpm --filter @nyabase/backend build` and the tmux backend pane restart. This was classified as procedure/build freshness.
- Frontend port `5173` was connection-refused during final local service probe. No frontend runtime verification was part of this narrow deploy dispatch.

## XFS Quota Live Verification After Mount Resolver Fix

Prepared: `2026-06-01T20:21:00Z`
Role: devops
Scope: rebuild/redeploy current agent to CPU/GPU, then run CPU live XFS quota verification. This section records the interrupted run evidence available at the stop request; no product source or tests were edited.

### Build and Deploy Evidence

| Item | Status | Evidence |
| --- | --- | --- |
| Local build | pass | `bash scripts/build-agent-binary.sh` exited `0`; `dist/nyabase-agent` size `75982709` bytes; SHA-256 `9cd2604ef0775ac3b279206cf53bfaded562e3a7d805c0367d16fe9ee9cec9cd`. |
| CPU deploy | pass | `root@10.8.96.91:/usr/local/bin/nyabase-agent` SHA-256 matched `9cd2604ef0775ac3b279206cf53bfaded562e3a7d805c0367d16fe9ee9cec9cd`; `nyabase-agent` and `nyabase-docker.service` active; journal showed `[WS] Connected`; backend reported CPU `status=online`. |
| GPU deploy | pass | `lyn@10.8.1.12:/usr/local/bin/nyabase-agent` SHA-256 matched `9cd2604ef0775ac3b279206cf53bfaded562e3a7d805c0367d16fe9ee9cec9cd`; `nyabase-agent` and `nyabase-docker.service` active; journal showed `[WS] Connected`; backend reported GPU `status=online`. |
| Common-src guard | pass | `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` returned no output after build/deploy. |

### Live CPU XFS Evidence

Run id: `xfsq-20260601t200755z`

| Acceptance item | Status | Evidence |
| --- | --- | --- |
| `/data` pquota | pass | Host `findmnt` reported `/data xfs ... prjquota`; `xfs_quota -x -c 'state -p' /data` reported Accounting `ON` and Enforcement `ON`; API disk readback for disk `48e710c1-5e35-449b-bb04-9d085295a577` reported `pquotaEnabled=true`, `totalBytes=34292629504`, `usedBytes=3400380416`. |
| Data dir project quota | pass | `POST /api/data-dirs` created `/data/xfsq-20260601t200755z`; `xfs_io -c stat` reported project `10005`; quota report showed hard limit `20480` KiB (`20971520` bytes). |
| Below-limit write | pass | In container `bf30f7018a34...`, `dd` wrote `/mnt/share/below.bin` under the mounted data dir; `stat` reported `size:5242880` bytes. |
| Cross-container same-dir visibility | pass | Containers `bf30f7018a34...` and `8bf5513444ca...` both mounted `/mnt/share`; a marker written in the first was read and appended by the second, then read back as `xfsq-20260601t200755z:seen-by-c2` in the first. |
| 40 MiB shared data-dir write | pass | In container `8bf5513444ca...`, `dd if=/dev/zero of=/mnt/share/over.bin bs=1M count=40 conv=fsync` hit `No space left on device`; resulting file size was `15663104` bytes, below the requested `41943040`. |
| 40 MiB writable-layer write | fail-procedure | A 40 MiB write to `/root/writable-over.bin` in container `bf30f7018a34...` succeeded fully (`size:41943040`). This run created containers as admin, so the writable layer was charged to the admin project rather than the disposable user project. Result recorded as observed failure for this harness, not a conclusive intended-user quota result. |

### Cleanup and Residuals

Cleanup performed after PM interrupt:

- Product API no longer listed containers `8bf5513444ca...` or `bf30f7018a34...`.
- Managed Docker cleanup check reported both container IDs absent.
- Remote cleanup removed `/data/xfsq-20260601t200755z` and scrubbed matching `/etc/projects` and `/etc/projid` lines.
- Remote residual scan returned no matching containers, paths, or project lines.
- API residuals: user, image, data-dir, server grant, image grant, and mount-source grant for this run were absent.
- Remaining residual: API disk row `48e710c1-5e35-449b-bb04-9d085295a577` (`/data`, label `xfs quota live xfsq-20260601t200755z`) remains because `DELETE /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks/48e710c1-5e35-449b-bb04-9d085295a577` returned HTTP `400`: `This disk is still used by container mounts; remove those mounts first`. SQLite inspection showed two stale `container_mounts` rows referencing the deleted containers; no direct DB mutation was performed by devops.

### Classification

Verdict: FAIL-PROCEDURE for the writable-layer portion and cleanup residual. PASS for deploy, `/data` pquota registration, below-limit write, same-dir cross-container visibility, and over-limit mounted data-dir enforcement after the mount resolver fix.

## Backend Runtime Redeploy and Final Checks

Prepared: `2026-06-01T20:29:42Z`
Role: devops
Scope: rebuild/restart backend from current `packages/backend/dist/main.js`, attempt product-API cleanup of residual CPU disk row, then run full automated and visual checks. Product source, tests, DB rows, and git history were not edited.

### Commands and Results

| Command | Exit code | Result | Notes |
| --- | ---: | --- | --- |
| `curl http://127.0.0.1:5173/` | `0` | pass | Pre-restart frontend probe returned HTTP `200`. |
| `curl 'http://127.0.0.1:8428/api/v1/query?query=up'` | `0` | pass | Pre-restart VictoriaMetrics probe returned HTTP `200`. |
| `curl http://127.0.0.1:3001/api/auth/me` | `0` | pass | Pre-restart unauthenticated backend probe returned HTTP `401`. |
| `pnpm --filter @nyabase/backend build` | `0` | pass | Backend dist rebuilt successfully with `tsc -p tsconfig.json`. |
| `tmux send-keys -t nyabase:0.0 C-c`, then restart `node -r tsconfig-paths/register dist/main.js` in the same backend pane | n/a | pass | Old backend process stopped; rebuilt backend process started as PID `1732656`; backend log showed `Backend listening on port 3001`; CPU/GPU agents reconnected. |
| `curl http://127.0.0.1:3001/api/auth/me` | `0` | pass | Post-restart unauthenticated backend probe returned HTTP `401` on first poll. |
| Product API cleanup: admin login, `GET /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks`, `DELETE /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks/48e710c1-5e35-449b-bb04-9d085295a577`, then list again | `1` | blocked | Admin login returned `200`; disk was present before delete; delete returned HTTP `400` with `This disk is still used by container mounts; remove those mounts first`; disk remained present after delete. No direct DB mutation was performed. |
| `bash scripts/check.sh` | `0` | pass | Workspace typecheck passed for common/backend/agent/frontend. ESLint exited `0` with 12 warnings. Unit tests passed: common `36/0/0`, backend `73/0/0`, agent `43/0/0`. Common-src artifact guard was clean. |
| `bash scripts/check-visual.sh` | `0` | pass | Playwright visual suite passed `4/0/0`: GPU metrics specs and login specs. HTML report path: `packages/frontend/e2e/.html-report/index.html`. Diff artifacts: none. |
| Final `curl http://127.0.0.1:5173/` | `0` | pass | Frontend remained reachable with HTTP `200`. |
| Final `curl 'http://127.0.0.1:8428/api/v1/query?query=up'` | `0` | pass | VictoriaMetrics remained reachable with HTTP `200`. |
| Final `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -print \| sort` | `0` | pass | No generated common source artifacts found. |

### `scripts/check.sh` Summary

Command: `bash scripts/check.sh`
Exit code: `0`
Backend typecheck: pass
Backend lint: pass
Backend tests: `73/0/0`
Frontend typecheck: pass
Frontend lint: pass
Frontend tests: skipped by `scripts/check.sh` unit phase; this workspace script runs common/backend/agent unit suites.
Frontend visual: skipped by `scripts/check.sh` without `--with-visual`
Failing output tail: none
Status: GREEN

### `scripts/check-visual.sh` Summary

Command: `bash scripts/check-visual.sh`
Exit code: `0`
Frontend visual: pass
Report path: `packages/frontend/e2e/.html-report/index.html`
Diff artifacts: none
Failing output tail: none
Status: GREEN

### Residuals

- Residual disk row remains: `48e710c1-5e35-449b-bb04-9d085295a577` on server `05cea385-d6ca-490a-a126-e00d0ae23b70`, mount `/data`, label `xfs quota live xfsq-20260601t200755z`.
- Product API blocker: `DELETE /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks/48e710c1-5e35-449b-bb04-9d085295a577` returned HTTP `400`: `This disk is still used by container mounts; remove those mounts first`.
- Historical stale `container_mounts` rows still block deletion. Devops did not mutate SQLite rows directly, per dispatch constraints.

## Final Checks After Historical Cleanup

Prepared: `2026-06-01T20:40:55Z`
Role: devops
Scope: final automated checks and read-only service probes after historical cleanup. Product source, tests, services, DB rows, remote hosts, and git history were not mutated.

### Commands and Results

| Command | Exit code | Result | Notes |
| --- | ---: | --- | --- |
| `bash scripts/check.sh` | `0` | pass | Typecheck passed for common/backend/agent/frontend. ESLint exited `0` with 12 warnings. Unit tests passed: common `36/0/0`, backend `73/0/0`, agent `43/0/0`. Common-src artifact guard was clean. |
| `bash scripts/check-visual.sh` | `0` | pass | Playwright visual suite passed `4/0/0`: GPU metrics specs and login specs. HTML report path: `packages/frontend/e2e/.html-report/index.html`. Diff artifacts: none. |
| `curl http://127.0.0.1:3001/api/auth/me` | `0` | pass | Unauthenticated backend probe returned HTTP `401`. |
| `curl http://127.0.0.1:5173/` | `0` | pass | Frontend root returned HTTP `200`. |
| `curl http://127.0.0.1:8428/health` | `0` | pass | VictoriaMetrics health returned HTTP `200`. |
| `curl 'http://127.0.0.1:8428/api/v1/query?query=up'` | `0` | pass | VictoriaMetrics query endpoint returned HTTP `200`. |
| `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` | `0` | pass | No generated common source artifacts found. |

### `scripts/check.sh` Summary

Command: `bash scripts/check.sh`
Exit code: `0`
Backend typecheck: pass
Backend lint: pass
Backend tests: `73/0/0`
Frontend typecheck: pass
Frontend lint: pass
Frontend tests: skipped by `scripts/check.sh`; this workspace script runs common/backend/agent unit suites.
Frontend visual: skipped by `scripts/check.sh` without `--with-visual`
Failing output tail: none
Status: GREEN

### `scripts/check-visual.sh` Summary

Command: `bash scripts/check-visual.sh`
Exit code: `0`
Frontend visual: pass
Report path: `packages/frontend/e2e/.html-report/index.html`
Diff artifacts: none
Failing output tail: none
Status: GREEN

### Service Probe Summary

| Probe | Expected | Actual | Status |
| --- | ---: | ---: | --- |
| Backend `GET /api/auth/me` unauthenticated | `401` | `401` | pass |
| Frontend `GET /` | `200` | `200` | pass |
| VM `GET /health` | `200` | `200` | pass |
| VM `GET /api/v1/query?query=up` | `200` | `200` | pass |

### Residuals

- No new residuals from this final-check dispatch.
- Historical cleanup state was not re-audited in this narrow dispatch; no cleanup or DB mutation was attempted.

## GPU Docker Root XFS Project Quota Remediation and Restricted GPU Metrics API Proof

Prepared: `2026-06-01T23:36:00Z`
Role: devops
Scope: remediate the GPU test host runtime precondition by moving the managed Docker root to an XFS filesystem with project quota accounting and enforcement, then rerun the focused restricted-user GPU metrics API attribution proof. No product source, tests, repo configs, lockfiles, visual baselines, database rows, or raw tokens were edited or recorded.

Run id: `gpupquota-20260602t232450z`
GPU server: `db1112fe-1c55-4314-9511-6d8510c523c2`
GPU host: `lyn@10.8.1.12`

### Remediation Commands and Results

| Step | Result | Evidence |
| --- | --- | --- |
| Preflight backup | pass | Backed up `/etc/nyabase/agent.yaml` on the GPU host; recorded non-secret config fields: `serverId="db1112fe-1c55-4314-9511-6d8510c523c2"`, `dockerRoot="/data0/nbTest/nyabase-docker"`, `parentIface="bond0"`, `isGpuServer=true`. `nyabase-agent=active`; `nyabase-docker.service=active`. |
| Old root diagnosis | pass | `findmnt -T /data0/nbTest/nyabase-docker` reported `/data0` XFS with `noquota`; managed Docker reported `DockerRootDir=/data0/nbTest/nyabase-docker`, `Driver=overlay2`, runtimes including `nvidia`; `ubuntu:22.04` inspect succeeded. |
| Image preservation | pass | Saved `ubuntu:22.04` from old managed Docker root to a temporary tar, size `80631296` bytes, SHA-256 `71ca78af45ea02b8e7a2b03c3e82db0403ac6465658f8a86158b248661aea1f1`; tar was removed after image load and proof cleanup. |
| Quota-capable root | pass | Created sparse loopback XFS image `/data0/nbTest/nyabase-docker-pquota.img`, mounted at `/data0/nbTest/nyabase-docker-pquota` with `prjquota`, and added an `/etc/fstab` entry for the retained test environment. |
| XFS checks | pass | `findmnt -T /data0/nbTest/nyabase-docker-pquota` reported `/dev/loop3 xfs 20G 19.7G ... prjquota`; `xfs_info` reported `ftype=1`; `xfs_quota -x -c "state -p"` reported project quota Accounting `ON` and Enforcement `ON`. |
| Agent config and services | pass | Updated only GPU host runtime config `dockerRoot` to `/data0/nbTest/nyabase-docker-pquota`; restarted services. Final `systemctl is-active` reported `nyabase-agent=active` and `nyabase-docker.service=active`. Backend reported server `online`; live `dockerDaemon.dockerRoot=/data0/nbTest/nyabase-docker-pquota`, `state=active`, `unitFileInSync=true`, `lastError=null`. The server DTO top-level frozen `dockerRoot` still shows the original registration value, but live daemon status reflects the active root. |
| New-root Docker and NVIDIA | pass | Managed Docker final info: `DockerRootDir=/data0/nbTest/nyabase-docker-pquota`, `Driver=overlay2`, runtimes included `nvidia`, default runtime `runc`. Loaded saved `ubuntu:22.04`; image inspect returned `sha256:86f1a8d7b38e7a014c249cf2ca573c8ff7ce3cca128c5c06dcee758813726f90`, size `78070240`. `docker run --rm --gpus device=0 ubuntu:22.04 nvidia-smi -L` printed GPU 0 NVIDIA L40 UUID `GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19`. |

### Restricted GPU Metrics API Proof

| Step | Result | Evidence |
| --- | --- | --- |
| Disposable product records | pass | Admin API created disposable user `gpupquota-232450z` (`e62974e3-13c6-441c-9400-29133dc8561e`), disposable image record for `ubuntu:22.04` (`1eb9141b-67de-47d8-a352-446656d43699`), user server grant on GPU server with `cpuMillis=500`, `memBytes=1073741824`, `diskBytes=2147483648`, `gpuMode=indices`, `gpuIndices=[0]`, and image grant on the GPU server. |
| Restricted container create | pass | Restricted user login returned HTTP `200`; restricted `POST /api/containers` returned HTTP `201`; target container `fe3b1138d40ff02ae443496d7e5e87d063c36c57c775ae42811706431d2eb193` was running with name `gpupquota-proof`, GPU index `0`, and owner `e62974e3-13c6-441c-9400-29133dc8561e`. This proves the fail-closed writable-layer XFS project quota checks passed on the new root. |
| Positive GPU workload | pass | Temporary CUDA Driver API helper inside the container allocated GPU memory; host `nvidia-smi --query-compute-apps` showed process `/tmp/nyabase-cuda-hold` using `938` MiB on GPU UUID `GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19`. |
| VM raw attribution | pass | VM instant query `nyabase_gpu_proc_mem_used_bytes{server="db1112fe-1c55-4314-9511-6d8510c523c2",container_id="fe3b1138d40ff02ae443496d7e5e87d063c36c57c775ae42811706431d2eb193"}` returned HTTP `200`, value `983564288`, with labels `user_id="e62974e3-13c6-441c-9400-29133dc8561e"` and `gpu_uuid="GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19"`. |
| Backend container metrics | pass | Restricted user `GET /api/metrics/servers/db1112fe-1c55-4314-9511-6d8510c523c2/containers?range=15m` returned HTTP `200`; target container `gpuMemUsed.points` had positive values including `983564288` at timestamps `1780356660`, `1780356720`, and `1780356780`. |
| Backend user metrics | pass | Admin `GET /api/metrics/servers/db1112fe-1c55-4314-9511-6d8510c523c2/users?range=15m` returned HTTP `200`; owner user `e62974e3-13c6-441c-9400-29133dc8561e` / `gpupquota-232450z` had positive `gpuMemUsed.points` including `983564288` at timestamps `1780356660`, `1780356720`, and `1780356780`. |
| Backend detail stats | pass | Restricted user `GET /api/containers/db1112fe-1c55-4314-9511-6d8510c523c2/fe3b1138d40ff02ae443496d7e5e87d063c36c57c775ae42811706431d2eb193/stats` returned HTTP `200` with `stats.gpuMemUsedMiB={"GPU-8eda9023-68d2-4a5f-be51-e71bfe16ec19":938}` during workload. |

### Cleanup and Final Probes

| Item | Result | Evidence |
| --- | --- | --- |
| Product/API cleanup | pass | Deleted container via product API (`200`), deleted image grant (`204`), server grant (`204`), image record (`204`), and user (`204`). API residual scan found `userResidual=0`, `imageResidual=0`, and `containerResidual=0`. |
| Remote runtime cleanup | pass | Removed temporary CUDA helper source/binary, Docker save tar, mkfs log, and exact stale `/etc/projects` entries for old and deleted proof overlay paths. Final managed Docker residual scans by proof Docker ID and `gpupquota` name returned none; `/etc/projects` and `/etc/projid` run-id scans returned none. |
| Retained environment state | intentional | Retained `/data0/nbTest/nyabase-docker-pquota.img`, mount `/data0/nbTest/nyabase-docker-pquota`, `/etc/fstab` entry, and GPU agent `dockerRoot` pointing at this pquota root as the working test environment. Retained non-run-id rollback backup `/data0/nbTest/nyabase-runtime-backups/agent.yaml.pre-pquota-rollback.bak`. |
| Service probes | pass | Backend unauthenticated `GET /api/auth/me` returned HTTP `401`; frontend `GET /` returned HTTP `200`; VM `/health` returned HTTP `200`; VM query `up` returned HTTP `200`; common-src artifact guard count was `0`. |
| Final GPU host probes | pass | `nyabase-agent=active`; `nyabase-docker.service=active`; `findmnt` still reported XFS `prjquota`; `xfs_quota state -p` still reported Accounting `ON` and Enforcement `ON`; managed Docker still reported root `/data0/nbTest/nyabase-docker-pquota`; `ubuntu:22.04` image inspect still succeeded. |

### Acceptance Criteria Status

| AC / ticket | Status | Evidence |
| --- | --- | --- |
| GPU Docker root quota remediation | pass | New root `/data0/nbTest/nyabase-docker-pquota` is XFS on `/dev/loop3`, mounted with `prjquota`, capacity `20G`, `ftype=1`, project accounting/enforcement `ON`; services active and backend live daemon status online. |
| AGT-009 | pass | GPU agent and managed Docker active after config change; managed daemon uses pquota Docker root and exposes NVIDIA runtime; `ubuntu:22.04` GPU smoke test succeeded. |
| AGT-011 | pass | Restricted product container creation succeeded only after writable-layer quota checks could be satisfied on the pquota Docker root; no fail-open behavior was introduced. |
| Batch 9 | pass | Restricted user with GPU index grant created a running GPU container on GPU `0`; positive GPU workload produced VM and backend per-container/per-user attribution. |
| BCK-011 | pass | VM raw GPU process memory series and backend metrics APIs returned positive attributed samples for the target container and owner user. |
| BCK-012 / API-backed metric evidence | pass | Backend container/user metrics endpoints and container detail stats returned positive GPU memory data suitable for UI display; no frontend/visual suite was run in this dispatch. |

### Verdict

GPU Docker root quota remediation: PASS.
GPU metrics API attribution: PASS.
Residuals: none for disposable proof artifacts; retained pquota Docker root/mount is intentional environment state.

## Final DoD Checks After Latest Visual Specs and Runtime Remediation

Prepared: `2026-06-01T23:55:37Z`
Role: devops
Scope: fresh final automated checks and read-only service/common probes after latest frontend visual specs/baselines and GPU host runtime remediation. Product source, tests, configs, scripts, lockfiles, runtime service configs, visual baselines, API/DB state, remote hosts, and git history were not mutated by this dispatch. Only this session test record and command-generated local reports/artifacts were written.

### Commands and Results

| Command | Exit code | Result | Notes |
| --- | ---: | --- | --- |
| `bash scripts/check.sh` | `0` | pass | Common-src artifact guard passed before workspace checks. Typecheck passed for common/backend/agent/frontend. ESLint exited `0` with 12 warnings. Unit tests passed: common `36/0/0`, backend `73/0/0`, agent `53/0/0`; frontend unit tests are not run by this script. |
| `bash scripts/check-visual.sh` | `0` | pass | Expanded Playwright visual suite passed `12/0/0`. HTML report path: `packages/frontend/e2e/.html-report/index.html`. Diff artifacts: none. |
| `curl http://127.0.0.1:3001/api/auth/me` | `0` | pass | Unauthenticated backend probe returned HTTP `401`. |
| `curl http://127.0.0.1:5173/` | `0` | pass | Frontend root returned HTTP `200`. |
| `curl http://127.0.0.1:8428/health` | `0` | pass | VictoriaMetrics health returned HTTP `200`. |
| `curl 'http://127.0.0.1:8428/api/v1/query?query=up'` | `0` | pass | VictoriaMetrics query endpoint returned HTTP `200`. |
| `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` | `0` | pass | No generated common source artifacts found. |

### Package Check Summary

| Package | Typecheck | Lint | Tests |
| --- | --- | --- | --- |
| `@nyabase/common` | pass | pass via workspace ESLint | `36/0/0` |
| `@nyabase/backend` | pass | pass via workspace ESLint | `73/0/0` |
| `@nyabase/agent` | pass | pass via workspace ESLint | `53/0/0` |
| `@nyabase/frontend` | pass | pass via workspace ESLint | skipped by `scripts/check.sh` |

### `scripts/check.sh` Summary

Command: `bash scripts/check.sh`
Exit code: `0`
Backend typecheck: pass
Backend lint: pass
Backend tests: `73/0/0`
Frontend typecheck: pass
Frontend lint: pass
Frontend tests: skipped by `scripts/check.sh`
Frontend visual: skipped
Failing output tail: none
Status: GREEN

### `scripts/check-visual.sh` Summary

Command: `bash scripts/check-visual.sh`
Exit code: `0`
Frontend visual: pass
Visual tests: `12/0/0`
Report path: `packages/frontend/e2e/.html-report/index.html`
Diff artifacts: none
Failing output tail: none
Status: GREEN

### Service Probe Summary

| Probe | Expected | Actual | Status |
| --- | ---: | ---: | --- |
| Backend `GET /api/auth/me` unauthenticated | `401` | `401` | pass |
| Frontend `GET /` | `200` | `200` | pass |
| VM `GET /health` | `200` | `200` | pass |
| VM `GET /api/v1/query?query=up` | `200` | `200` | pass |

### Verdict

Final DoD checks after latest changes: GREEN.
Service probes: PASS.
Common-src guard: PASS.
Proposal: none.
