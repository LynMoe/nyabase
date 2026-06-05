# Full System Test Report

## Outcome

Most backend/control-plane/runtime checks passed. Two release blockers remain:

1. Frontend Playwright visual suite is red due to stale container route/API fixtures and one small baseline drift.
2. Live GPU persona matrix is red due to macvlan IP allocation returning an address Docker reports as already in use.

No auth bypass, cross-user container mutation, SSH key leak, operation-state deadlock, or common-source artifact issue was observed.

## Commands

- `bash scripts/check.sh --with-visual`: static/unit pass, visual failed 7/35.
- `bash scripts/check.sh`: pass.
- `pnpm build:frontend`: pass.
- `bash test/scripts/reset-local.sh`: pass.
- `node test/scripts/register-agents.mjs`: pass, 2 agents.
- `bash test/scripts/deploy-agents.sh`: pass, CPU/GPU online.
- `pnpm test:functional`: pass, 25/25.
- `bash test/scripts/run-live-suite.sh smoke`: pass.
- `bash test/scripts/run-live-suite.sh admin-setup`: pass, 1/1.
- `bash test/scripts/run-live-suite.sh continuation`: pass, 1/1.
- `bash test/scripts/run-live-suite.sh personas`: failed, 5/6 pass.
- `node test/scripts/create-mount-fixture.mjs`: pass.
- `bash test/scripts/run-live-suite.sh mounts`: pass, 1/1.
- `bash test/scripts/run-live-suite.sh dropbear`: pass, 1/1.
- Supplemental boundary probes: pass, 30/30.
- `bash scripts/check-control-plane-redesign-conformance.sh`: pass.

## Key findings

- Visual failures are largely stale tests/docs still using old `/containers/:serverId/:containerId` and old non-V2 mock DTO shapes.
- GPU live failure: operation failed cleanly and transitioned container to failed/deletable; cleanup deletion succeeded. Root risk is IPAM/network cleanup, not operation-state deadlock.
- Mount/SSH live reports show user isolation and cleanup for runtime containers/data dirs.
