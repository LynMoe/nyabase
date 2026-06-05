# Worklog

- Classified as normal cross-package implementation with public request schema change.
- Inspected common schema/tests, backend create/quota policy/tests, and frontend create dialog.
- Updated common CreateContainerRequest schema/tests to strip legacy create resource fields.
- Updated backend create flow to derive per-container CPU/memory/GPU from resolved grants and keep disk as aggregate usage plus new reservation.
- Reworked quota policy and focused backend create/quota tests for new semantics.
- Removed CPU/memory/GPU resource controls and payload fields from the frontend create dialog.
- Verification passed:
  - pnpm --filter @nyabase/common test
  - pnpm --filter @nyabase/backend test -- container-control-create-v2 resource-quota.policy
  - pnpm --filter @nyabase/frontend typecheck
  - find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort

Follow-up full-chain GPU review:
- Spawned ordinary-user and admin subagents for read-only review.
- Ordinary-user chain confirmed create payload reaches backend/agent, but found GPU all empty-known-index and agent Docker DeviceRequests gaps.
- Admin chain confirmed same runtime gap plus GPU grant inheritance bug and users page showGpu mismatch.
- Fixed GPU all with no known indices to fail instead of silently creating a no-GPU container.
- Added Docker HostConfig.DeviceRequests for GPU containers while preserving Runtime=nvidia/env compatibility.
- Made server grant gpuMode nullable so null inherits server.defaultGpuMode, matching existing UI copy.
- Updated ResourceGrantForm and grant displays for GPU server default inheritance; users page now hides GPU controls on non-GPU servers.
- Added migration AllowServerGrantGpuModeInheritance1780683400000.
- Regenerated common dist because backend typecheck resolves @nyabase/common through common/dist.
- Verification passed:
  - pnpm --filter @nyabase/common build
  - pnpm --filter @nyabase/common test
  - pnpm --filter @nyabase/backend build
  - pnpm --filter @nyabase/backend typecheck
  - pnpm --filter @nyabase/backend test -- container-control-create-v2 resource-quota.policy access-resolver
  - pnpm --filter @nyabase/agent typecheck
  - pnpm --filter @nyabase/agent test -- docker-client dispatcher
  - pnpm --filter @nyabase/frontend typecheck
  - common src artifact guard
