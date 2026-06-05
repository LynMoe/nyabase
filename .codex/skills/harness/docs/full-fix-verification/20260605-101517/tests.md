# Verification Summary

## Static / Unit / Visual / Build

- `pnpm --filter @nyabase/backend test -- src/containers/__tests__/resource-quota.policy.test.ts src/containers/__tests__/container-control-actions-v2.test.ts src/containers/__tests__/container-control-create-v2.test.ts`
  - Result: passed, 3 files / 41 tests.
- `bash scripts/check.sh --with-visual`
  - Result: passed.
  - Typecheck: common/backend/agent/frontend passed.
  - Lint: 0 errors, 10 warnings.
  - Unit: common 49, backend 121, agent 73 passed.
  - Playwright visual: 35 passed.
- `pnpm test:functional`
  - Result: passed, 25 passed / 0 failed / 0 skipped.
- `pnpm build`
  - Result: passed.
- `pnpm build:frontend`
  - Result: passed.
- `bash scripts/check-control-plane-redesign-conformance.sh`
  - Result: passed.
- Common artifact guard:
  - `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort`
  - Result: empty output.

## Live Runtime

- `bash test/scripts/run-live-suite.sh smoke`
  - Result: passed.
- `bash test/scripts/run-live-suite.sh admin-setup`
  - Result: passed.
  - Fixture: `test/runtime/murt/20260605t033259z-f1426d/state.json`.
- `bash test/scripts/run-live-suite.sh continuation`
  - Result: passed.
- `bash test/scripts/run-live-suite.sh personas`
  - Result: passed, 6/6 persona specs.
- `node test/scripts/create-mount-fixture.mjs && bash test/scripts/run-live-suite.sh mounts`
  - Result: passed.
  - Report: `test/runtime/mount/20260605t033401z-2ca04d/mount-runtime-report.md`.
- `bash test/scripts/run-live-suite.sh dropbear`
  - Result: passed.
  - Report: `test/runtime/dropbear/20260605t033502z-50c94e/dropbear-live-report.redacted.md`.
- Custom live probe: `set -a; source test/config/local.env; set +a; node test/runtime/nyabase-live-probe.mjs`
  - Result: passed.
  - Prefix: `codex-20260605t033717-f2a107`.
  - Covered: admin login; CPU/GPU servers online; docker daemon persisted readback; ordinary user denial/grants; two live GPU containers sharing GPU `[0]`; real console WebSocket exec; stats endpoint; bad GPU / CPU GPU boundary denials; SSH disabled conflict and enable operation; exact-prefix product cleanup.

## Visual Evidence

Reviewed baselines include:

- `packages/frontend/e2e/__screenshots__/chromium/ssh-ux.spec.ts/container-console-toolbar-ip.png`
- `packages/frontend/e2e/__screenshots__/chromium/gpu-metrics.spec.ts/container-gpu-memory.png`
- `packages/frontend/e2e/__screenshots__/chromium/management-routes.spec.ts/containers-own.png`

## Residual Notes

- Lint warnings remain at 10 existing warnings and 0 errors.
- Custom stats probe proved endpoint availability; immediate `stats.stats` may be null until runtime metrics arrive.
- Dropbear report notes host-level Docker exact-prefix scan gap, while product-level cleanup in dropbear and custom probe was clean.
