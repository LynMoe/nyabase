# Mount And SSH Live Tester Subagent Report

Scope: mount fixture/runtime suite and Dropbear SSH runtime suite on the already-started shared live instance. Product files were not edited.

## Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `node test/scripts/create-mount-fixture.mjs` | pass | `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/mount-ssh-subagent-create-mount-fixture-20260605T053331Z.log` |
| `bash test/scripts/run-live-suite.sh mounts` | pass | `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/mount-ssh-subagent-mounts-20260605T053346Z.log` |
| `bash test/scripts/run-live-suite.sh dropbear` | pass | `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/mount-ssh-subagent-dropbear-20260605T053423Z.log` |
| `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print \| sort` | pass, empty output | command output in subagent transcript |

## Mount Runtime Result

- Run prefix: `mount-20260605t053331z-1d1805`.
- Runtime report: `test/runtime/mount/20260605t053331z-1d1805/mount-runtime-report.md`.
- Runtime JSON: `test/runtime/mount/20260605t053331z-1d1805/mount-runtime-report.json`.
- Fixture state: `test/runtime/mount/20260605t053331z-1d1805/state.json`.
- Suite result: 1 test file passed, 1 test passed, duration 31.62s.

Coverage observed from the report:

- Ordinary users `alpha-local`, `beta-remote`, and `delta-both` logged in successfully with no management capabilities.
- Source visibility matched grants: alpha saw local only, beta saw remote only, delta saw both.
- Unauthorized cross-source actions were denied: alpha remote data-dir/container mount creation returned 403; beta local data-dir/container mount creation returned 403.
- Mounted containers were created for local and remote sources, exec sessions were opened, and marker write/read checks succeeded over mounted paths.
- Same-owner shared local mount readback worked across two alpha containers.
- In-use data-dir delete was guarded with 409 while the mounted container stayed visible and healthy.
- Cross-user guessed deletes against alpha/beta data dirs returned 404 before and after cleanup.
- Dynamic mount patch add/readback/remove/readback was exercised on a delta container.

Cleanup and residual status:

- Created 6 containers and 5 data dirs; all were deleted by suite cleanup.
- Final residuals: alpha-local `containers=0 dataDirs=0`, beta-remote `containers=0 dataDirs=0`, delta-both `containers=0 dataDirs=0`.
- Reported failures: none.

## Dropbear SSH Runtime Result

- Run prefix: `dropbear-live-20260605t053423z-6f61d4`.
- Runtime report: `test/runtime/dropbear/20260605t053423z-6f61d4/dropbear-live-report.redacted.md`.
- Runtime JSON: `test/runtime/dropbear/20260605t053423z-6f61d4/dropbear-live-report.redacted.json`.
- Suite result: 1 test file passed, 1 test passed, duration 105.81s.

Coverage observed from the report:

- Non-admin users `user-a` and `user-b` were created with no management capabilities.
- Public-key SSH succeeded against Dropbear-managed containers on `10.8.109.3` and `10.8.109.4`.
- Password login was rejected with `Permission denied (publickey)`.
- Key sync behavior was exercised: first key accepted, second key accepted after sync, first key rejected after deletion, second key continued to work.
- User B isolation checks were denied: container read/stats/start/stop/restart/enable-ssh/reconcile-ssh returned 403 and delete returned 404.
- Lifecycle and repair/reconcile behavior completed inside the live suite.

Cleanup and residual status:

- Product-level cleanup removed image/server grants, image row, user rows, temp known_hosts, and generated SSH key files.
- Prior Dropbear prefixes listed in the report had zero scanned residuals.
- Product containers residual: none.
- Reported failures: none.
- Residual gap: the report explicitly notes that CPU managed Docker exact-prefix host-level residual scan was not run in this tester lane; devops host-level verification remains a cleanup verification gap if required.

## Notes

- Did not run `reset-local` or `admin-setup`, per instruction.
- Did not edit product files.
- Allowed writes were limited to `test/runtime/**` and `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/**`.
