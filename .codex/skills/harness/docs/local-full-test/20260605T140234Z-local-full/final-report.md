# Nyabase Local Full Test Report

Date: 2026-06-05
Environment: shared local test instance (`http://localhost:5173`, `http://localhost:3001/api`, SQLite `test/runtime/db/nyabase-test.db`).

## Summary

- Local backend/frontend/VictoriaMetrics started successfully.
- CPU and GPU agents registered, deployed, and reported online.
- Admin fixture created 5 persona users with different server/image grants and per-user quotas.
- Persona subagents ran alpha/beta/gamma/delta/epsilon flows; all persona specs passed.
- Functional API gate and unit/static gate passed.
- Mount-source runtime matrix failed twice at console websocket timeout, but report shows cleanup succeeded and final residuals were zero.
- Dropbear SSH live runtime failed at container create/start operation (`Container ... is not running`) and performed cleanup.
- Visual gate failed: 13 passed, 22 failed; failures include stale/fixture-dependent UI expectations and screenshot diffs.
- `packages/common/src` compiled artifact check returned empty.

## Evidence

Commands/results:
- `bash test/scripts/reset-local.sh`: success; backend/frontend started.
- `bash test/scripts/run-live-suite.sh smoke`: success; admin login OK.
- `node test/scripts/register-agents.mjs && bash test/scripts/deploy-agents.sh`: success; CPU/GPU online.
- `bash test/scripts/run-live-suite.sh admin-setup`: 1 passed.
- `bash test/scripts/run-live-suite.sh continuation`: 1 passed.
- Persona subagent specs:
  - alpha: 1 passed.
  - beta: 1 passed.
  - gamma: 1 passed.
  - delta + gamma/delta attack: 2 passed.
  - epsilon: 1 passed.
- `pnpm test:functional`: 25 passed, 0 failed.
- `bash scripts/check.sh`: typecheck/lint/unit passed; lint warnings only; common 54 tests, backend 111 tests, agent 79 tests passed.
- `node test/scripts/create-mount-fixture.mjs && bash test/scripts/run-live-suite.sh mounts`: failed twice at console websocket timeout.
- `bash test/scripts/run-live-suite.sh dropbear`: failed product operation because container was not running.
- `bash scripts/check-visual.sh`: 13 passed, 22 failed.
- `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`: empty.

Artifacts:
- Multi-user state: `test/runtime/murt/current.env`, `test/runtime/murt/20260605t140308z-c6b544/state.json`.
- Mount failure report: `test/runtime/mount/20260605t140400z-78b1d3/mount-runtime-report.md` and `.json`.
- Dropbear failure report: `test/runtime/dropbear/20260605t140545z-b153f5/dropbear-live-report.redacted.md` and `.json`.
- Visual traces/screenshots: `packages/frontend/e2e/.test-results/`.
- Alpha subagent log: `.codex/skills/harness/docs/alpha-live-flow/2026-06-05/alpha-vitest.log`.

## Persona fixture

From `test/runtime/murt/20260605t140308z-c6b544/state.json`:
- alpha: CPU server only; 500m CPU, 256MiB RAM, 64MiB disk, no GPU; CPU image A.
- beta: CPU server only; 1000m CPU, 512MiB RAM, 128MiB disk, no GPU; CPU image B.
- gamma: GPU server; 1000m CPU, 1GiB RAM, 256MiB disk, GPU index 0; GPU image A.
- delta: CPU + GPU server; CPU grant 1500m/1GiB/256MiB no GPU; GPU grant 1000m/1GiB/256MiB GPU index 1.
- epsilon: no server grant; only inactive image grant, expected no-access behavior.

## Open failures

1. Mount-source live matrix: `fail-infra`, console websocket timed out with empty output. Report indicates mount source visibility/authorization/data-dir/container creation steps reached expected statuses before timeout; cleanup deleted containers/data-dir and final residuals were zero.
2. Dropbear live runtime: `fail-product`, create/start operation failed because container was not running. Redacted report shows disposable users, grants, SSH key cleanup, image/user/grant cleanup.
3. Visual gate: 22 Playwright failures. Some are screenshot diffs, others missing fixture-dependent text/widgets (GPU metrics, operation states, SSH UX, data directory labels).

