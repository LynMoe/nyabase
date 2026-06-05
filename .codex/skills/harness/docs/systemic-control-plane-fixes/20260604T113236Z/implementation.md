# Implementation Record

## Files Changed

- `packages/backend/src/containers/container-read-model.service.ts`
- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/gateway/state-cache.ts`
- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`

## Acceptance Criteria Mapping

1. Covered. `ContainerDto.operation` is mapped from `activeOperation`, so terminal-only historical operation rows no longer produce an operation DTO.
2. Covered. The read model queries the newest non-terminal container operation, preferring desired container id and only falling back to docker id when no active container-id row exists.
3. Covered. The outbox worker repairs linked terminal outbox/non-terminal operation drift in a bounded batch and moves expired sent/running command leases plus queued/waiting/running operations to retrying.
4. Covered. GPU auto-pick reads actual GPU inventory from `AgentGateway.stateCache` and validates returned indices against that inventory.
5. Covered. The hard-coded `0..15` fallback was removed, so a server with inventory `[0,1,2,3]` cannot auto-pick `[4,5]`.
6. Covered. Auto allocation uses `StateCache` load-balancing by current container count and permits sharing/reuse of real GPU indices.
7. Covered. Explicit GPU indices are rejected when duplicated, outside the grant, or absent from actual server inventory.
8. Covered. Missing or empty GPU inventory raises a clear conflict instead of falling back to synthetic indices.

## Notable Decisions

- Kept `latestOperation` on `ContainerControlPlaneView` for possible internal/history use, but DTO mapping now exclusively uses `activeOperation`.
- Made `activeOperation` optional in the interface so existing test fixtures and partial mocks remain type-compatible; the real read model always populates it.
- Kept GPU placement in `ContainersService` rather than reworking the older quota-policy helper, because runtime create placement already uses the service resolver and the helper is not called by product source.
- `StateCache.getGpuLoadMap()` now ignores container-reported GPU indices not present in the current agent inventory, and `isGpuFree()` returns false for unknown indices.
- Outbox drift repair only updates operation status/completion based on a linked command row. It does not replay domain success/failure handlers without a trustworthy command result.

## Risks

- GPU requests now fail when the backend has not yet received agent hello inventory for that server. This is intentional, but operators may see conflicts immediately after process restart until the agent reconnects.
- Terminal outbox repair can mark an operation succeeded/failed/cancelled, but cannot reconstruct missing domain side effects if those were skipped before the drift occurred.
- Tests and builds were not run by design for this developer dispatch.

## Verification

- Ran edited-file lint:
  `node_modules/.bin/eslint packages/backend/src/containers/container-read-model.service.ts packages/backend/src/containers/containers.service.ts packages/backend/src/gateway/state-cache.ts packages/backend/src/operations/agent-command-outbox-worker.service.ts`
- Verified no generated artifacts under `packages/common/src/**`:
  `find packages/common/src \( -name "*.js" -o -name "*.js.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) | sort`

## Visual Impact

None. No frontend source was changed; rendered pixels can change only as a backend data correction where stale terminal operation payloads are omitted.
