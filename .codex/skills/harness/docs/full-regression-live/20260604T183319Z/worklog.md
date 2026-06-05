# Worklog — Full regression live flow

Session: .codex/skills/harness/docs/full-regression-live/20260604T183319Z
Started: 2026-06-05T02:33:19+08:00

## Notes
- lead as devops/integrator.
- Repository has no .git directory in /root/nyabase; use filesystem state as authoritative.
- Read harness SKILL.md, workflow.md, roles/pm.md, root AGENTS.md.

## Runtime preflight
- Local backend/frontend/VM reachable; backend PID 2996829 uses fixed DB via open FD; frontend Vite PID 2996864; two server agents online.
- Remote CPU/GPU agent service hashes match local `dist/nyabase-agent`.
- Saved fingerprint at `artifacts/runtime-fingerprint.md`.

## Baseline gates started
- `bash scripts/check.sh` completed: common build, typecheck, lint (warnings only), unit tests passed.
- `pnpm test:functional` completed: 25 checks passed, 0 failed.
- `bash scripts/check-control-plane-redesign-conformance.sh` completed: all static conformance assertions passed.

## Implementer frontend slice — 2026-06-05
- lead as implementer for focused frontend regressions.
- Added reusable route capability deny wrapper and applied it to users/images/groups/group detail/audit/servers/server detail/manage containers/manage remote-fs routes.
- Added frontend container action path mapper so camelCase actions post to backend kebab-case paths.
- Updated `persona-routes.spec.ts` fixture to current V2 `ContainerView` shape and added focused assertions for direct admin-route denial plus `reconcile-ssh` request path.
- Verification:
  - `pnpm --filter @nyabase/frontend typecheck` passed.
  - `pnpm --filter @nyabase/frontend exec playwright test persona-routes.spec.ts --reporter=line` passed: 9/9.
  - common-source artifact guard returned no files.
- Visual review: opened existing `normal-users-access-denied.png`; new guarded routes reuse the same deny component/copy.

## Implementer Playwright V2 fixture slice — 2026-06-05
- lead as implementer for requested lane; scope limited to focused frontend E2E specs/ROUTES.md.
- Updated focused specs to use `/api/v2/containers`, `/api/v2/containers/:containerId`, `/api/v2/containers/:containerId/actions/start`, current top-level `ContainerView` fields (`id`, `name`, `runtime`, `activeOperation`, `resources`, `ssh`, `mounts`, `actions`).
- Updated ROUTES.md focused entries from legacy server/container path language to current `/containers/:containerId` and V2 API notes.
- Verification: focused Playwright command executed; all non-visual assertions reached, but 5 screenshot assertions failed due expected-baseline drift after logical fixture update. Actual screenshots inspected and show correct V2 UI/content. Remaining 3 tests passed.
- Verification: focused grep for legacy `/api/containers`/`/containers/srv`/old DTO markers in the two specs produced no hits; common-source artifact guard clean.
## 2026-06-05T20:43:38Z lead as implementer/devops
- Investigated remaining Dropbear live failure with read-only sidecar Noether.
- Root cause: agent state report emitted empty spec.ip from labels-only parse, and backend state report upsert overwrote create-result runtime IP with null; V2 wait required ssh running plus runtime.ip.
- Patched agent Docker state-report spec IP extraction from Docker network info; patched backend RuntimeObservationService to preserve known runtime IP and owner when reports omit non-label fields; added focused tests; added Dropbear live timeout diagnostics.
- Focused checks passed: backend runtime-observation test (3/3), agent docker-client test (9/9), backend typecheck, agent typecheck, common-source artifact guard clean.
## 2026-06-05T20:46:36Z live rerun after IP fix
- Restarted backend/frontend after backend build: logs/50-start-local-after-ip-fix.log.
- Rebuilt and redeployed CPU/GPU agent binaries after agent IP fix: logs/51-deploy-agents-after-ip-fix.log.
- Live smoke passed: logs/52-live-smoke-after-ip-fix.log.
- Dropbear live advanced past original create-time SSH/IP failure; first container SSH login and password rejection passed. New failure was test-bug:convergence-timing — createContainer helper did not wait for create operation terminal before posting disabled-container reconcile; product correctly returned operation_in_progress 403. Patched helper to wait for operation terminal.
- Cleaned exact-prefix residual container from failed run; DB rows for prefix dropbear-live-20260604t204432z-5ff785 are deleted.
## 2026-06-05T20:58:32Z final live/regression gates
- Dropbear rerun after create-operation wait reached key-sync phase and exposed product gap: user SSH key add/delete hook was a no-op for V2 already-running SSH-enabled containers.
- Implemented V2 SSH key sync in LifecycleHookRegistryService: enqueues durable container.reconcile_ssh/runtime.container.ssh.apply operations for active, running, SSH-enabled owner containers; added focused unit test.
- Backend/frontend restarted after backend build: logs/56-start-local-after-ssh-key-sync-fix.log. Agent redeploy not required after backend-only key-sync fix; previously deployed agent remains online.
- Live smoke passed: logs/57-live-smoke-after-ssh-key-sync-fix.log.
- Dropbear live passed: logs/58-live-dropbear-after-ssh-key-sync-fix.log (2 containers created/deleted, 8 SSH attempts, failures none).
- Full check passed with lint warnings only: logs/59-check-after-ssh-key-sync-fix.log.
- Functional checks passed 25/25: logs/60-functional-after-ssh-key-sync-fix.log.
- Control-plane conformance passed: logs/61-control-plane-conformance-after-ssh-key-sync-fix.log.
- Final common-source artifact guard clean: logs/62-common-artifact-guard-final.log.
- CPU host exact-prefix Docker scan for final Dropbear prefix produced no rows: logs/63-dropbear-host-prefix-cleanup-final.log.
## 2026-06-05T21:03:36Z independent review
- Sidecar Noether final read-only release/high-risk review PASS. No blocking correctness/auth/lifecycle/type/lint/artifact issues found.
- Non-blocking follow-ups noted: SSH key sync operations can temporarily block actions while Updating if agent stalls; admin-triggered key sync operations are attributed to target user; existing lint warnings remain warnings only.
- Additional targeted final backend checks passed: logs/64-targeted-final-after-review-wait.log.

## 2026-06-05T21:39:00Z mount live/regression closure
- lead as implementer/devops for remaining mount-source live gap.
- Repaired `test/specs/live/multi-user-redteam-mount-sources.spec.ts` for current V2 APIs: operation-ref create/delete, `/exec-sessions` + `/ws/console`, `POST /actions/update-mounts`, current top-level `ContainerView`/`mounts`, data-dir create/delete operation waits, and V2 cleanup.
- Provisioned scoped NFS precondition on CPU host `10.8.96.91`: installed/enabled `nfs-kernel-server`, created/exported `/data/nyabase-test-nfs-export` to `10.8.96.0/24`; evidence logs/69-70.
- Fixed mount fixture quality in `test/scripts/create-mount-fixture.mjs`: fixture user grants now avoid artificial disk quota exhaustion (`diskBytes: 0`) and fixture creation waits until the Alpine image is pulled/present on the CPU agent.
- Initial post-autopull rerun exposed product race: data-dir in-use delete could enqueue delete before runtime observation caught up, despite live mounted running containers. Patched `DataDirsService` to also guard against non-stale running `runtime_containers`; added focused unit coverage and registered `RuntimeContainerEntity` in `DataDirsModule`.
- Restarted backend/frontend after backend guard patch: logs/102; live smoke passed: logs/103.
- Mount live suite passed after datadir guard: logs/107 (1/1, ~52s). Final runtime report in `test/runtime/mount/20260604t213521z-74a393/mount-runtime-report.md` shows status pass, no raw secrets, final residuals zero for alpha/beta/delta.
- Reviewed current focused Playwright actuals; promoted V2 operation-state screenshots and reran focused specs green: logs/108 (8/8). Evidence copied to `artifacts/playwright-visual-after-mount-fix/`.
- Final gates after datadir guard/baselines: `bash scripts/check.sh` passed with warnings only (logs/109); functional passed 25/25 (logs/110); control-plane conformance passed (logs/111); live smoke passed (logs/112); common-source artifact guard clean (logs/113).
- Cleaned final mount fixture resources for prefix `mount-20260604t213521z-74a393`: removed generated users/image/remote mount and exact-prefix host dirs. Cleanup proof logs/114-115 show no active DB containers, no data dirs, no remote mounts/images/users, no host Docker/local/NFS/mountpoint residuals; `test/runtime/mount/current.env` absent. Smoke after cleanup passed logs/116; final artifact guard clean logs/117.
- Independent reviewer Mendel first flagged stale worklog and visual drift; follow-up review requested after logs/102-117.
- Follow-up independent reviewer Mendel PASS after logs/102-117: no blockers; residual warnings only.
- Removed leftover mount credential `.env` files under `test/runtime/mount/*/` and kept `test/runtime/mount/current.env` absent; logs/118. Final common-source artifact guard after secret cleanup remained clean: logs/119.
