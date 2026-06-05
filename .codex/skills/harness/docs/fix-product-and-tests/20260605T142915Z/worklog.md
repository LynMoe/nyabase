# Worklog

Implemented product fix for agent exec pre-ready input/resize/close buffering.
Adjusted live fixtures to set explicit long-running runtimeOverrides for test images.
Adjusted frontend visual tests/snapshots to match current product UI/API contract.

Validation:
- pnpm --filter @nyabase/agent test -- dispatcher.test.ts: passed, 37 tests.
- pnpm --filter @nyabase/agent typecheck: passed.
- pnpm --filter @nyabase/frontend typecheck: passed.
- pnpm --filter @nyabase/common typecheck: passed.
- pnpm --filter @nyabase/backend typecheck: passed.
- Targeted frontend visual specs: 23 passed.
- Local live reset/smoke/register/deploy/admin-setup: passed.
- Mount live suite: passed.
- Dropbear live suite: passed.
- packages/common/src artifact check: empty.

Changed files:
- packages/agent/src/commands/dispatcher.ts
- packages/agent/src/commands/dispatcher.test.ts
- test/specs/live/multi-user-redteam-admin-setup.spec.ts
- test/specs/live/dropbear-live-runtime.spec.ts
- test/scripts/create-mount-fixture.mjs
- packages/frontend/e2e/container-canonical-visibility.spec.ts
- packages/frontend/e2e/gpu-metrics.spec.ts
- packages/frontend/e2e/operation-states.spec.ts
- packages/frontend/e2e/persona-routes.spec.ts
- packages/frontend/e2e/ssh-ux.spec.ts
- frontend screenshot baselines under packages/frontend/e2e/__screenshots__/chromium/**
