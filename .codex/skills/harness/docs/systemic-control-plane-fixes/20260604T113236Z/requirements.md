# Systemic Control Plane Fixes

## Original request

现在 5173 端口上，管理员的两台机器上的每个容器都显示有操作中 queue。还多了个新问题，gpu 现在变成独占了，我有一个四卡容器，又创建一个两卡重启，结果第二个容器的 index 是 4,5。这台机器只有四张显卡。系统性修复。

## User confirmation

- CONFIRM_REQ: confirmed by user.
- Additional instruction: after confirmation, proceed directly into development flow with minimal ceremony.

## Live symptoms reported by user

1. On the service currently running at port `5173`, administrator view shows every container on two machines as having an operation in `queue` / queued state.
2. GPU allocation semantics regressed: on a 4-GPU machine, after one 4-card container exists, creating/restarting another 2-card container resulted in GPU indices `4,5`, even though valid indices are only `0..3`.
3. User asks for systemic repair, not a narrow UI-only suppression.

## Relationship to prior fix session

Prior session: `.codex/skills/harness/docs/multi-user-functional-fixes/20260604T100001Z/`

Potentially related changes:

- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`
- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/containers/resource-quota.policy.ts`
- Tests added/updated in prior session may need adjustment or extension.

## Initial scope

### Included

- Diagnose why all containers in admin view show queued/in-progress operations after the previous outbox changes.
- Fix operation/read-model semantics so stale queued operations do not make every container appear actively operating unless a real active operation exists.
- Diagnose and fix GPU allocation semantics on finite-GPU servers:
  - Do not generate GPU indices outside observed/server GPU capacity.
  - Respect intended sharing vs exclusive allocation policy as defined by grants and container lifecycle.
  - Avoid treating a full-card existing container as permission to allocate non-existent indices.
- Add deterministic tests for:
  - latest/active operation selection shown to container read models.
  - GPU auto-selection bounded by actual server GPU inventory.
  - GPU allocation behavior with existing containers and restart/create paths.
- Verify against `5173` live state if needed through safe read-only API checks.

### Excluded

- Manual destructive cleanup of live containers/operations unless explicitly approved.
- Broad rewrite of operations architecture unless architect identifies it as necessary.
- Changing user-facing GPU policy without design confirmation.

## Draft acceptance criteria

1. Admin container list/detail no longer shows every container as queued solely because stale or unrelated operation rows exist.
2. Operation display/read model selects only relevant latest active/pending operation for each container, with completed/terminal historical operations excluded from active badges.
3. GPU auto-allocation never returns indices outside the server's actual GPU inventory.
4. For a 4-GPU server, no create/restart path can produce `gpuIndices: [4,5]`.
5. Tests cover multi-container GPU allocation and operation read-model behavior.
6. Required checks pass after implementation.

## Open questions / risks

- Need to confirm whether the intended GPU policy is exclusive allocation or allow-sharing. The user says “gpu 现在变成独占了,” implying sharing may be expected, but the current code may have exclusive `usedGpuIndices` behavior. Architect must resolve from existing product semantics and prior tests.
- The queue display symptom may be product state/read-model logic, outbox worker state transitions, or live leftover rows from the previous test. The fix should distinguish display/read-model correctness from operational cleanup.

## PM intake notes

- Container queue badge likely originates from `packages/frontend/src/components/containers/container-row.tsx`:
  - `operationActive = c.operation ? !TERMINAL_OPERATION_STATUSES.has(c.operation.status) : false`
  - any non-terminal `c.operation.status` disables actions and shows `操作中`.
- `c.operation` is mapped in `packages/backend/src/containers/containers.service.ts::mapOperation()`.
- Container read model source is `packages/backend/src/containers/container-read-model.service.ts`:
  - `findLatestOperationForResource()` returns the latest operation by `createdAt DESC` for `resourceType='container'` and `resourceId`.
  - It currently does not distinguish active/non-terminal operations from completed historical operations, and does not expose an active-only operation separately.
  - If live rows are stuck `queued`, UI may accurately show active state; if historical rows are terminal but still selected as active, read model is wrong.
- Prior outbox change in `packages/backend/src/operations/agent-command-outbox-worker.service.ts` made delivery asynchronous. Architect should check whether `processBatch(1)` plus in-flight resource filtering leaves due rows behind longer than intended, and whether operation statuses transition from `queued` to `waiting_agent/running/succeeded`.
- GPU issue code path:
  - `packages/backend/src/containers/containers.service.ts::resolveGpuIndicesFromDesired()`
  - `GpuGrantMode.All` calls `pickFreeGpuIndices()`.
  - `pickFreeGpuIndices()` loops `index < 16`, using only desired container occupancy from `usedGpuIndices()`. It does not use actual server GPU inventory from agent hello/state cache.
  - This directly permits selecting `[4,5]` on a 4-GPU server when indices `0..3` are marked used.
- Existing generic GPU helper `packages/backend/src/containers/resource-quota.policy.ts::resolveGpuIndices()` is tested, but `ContainersService` has a separate duplicate implementation and currently bypasses actual server GPU inventory.
- Agent/state cache already has GPU inventory:
  - `packages/backend/src/gateway/state-cache.ts` stores `snap.gpus` and has `pickGpuIndices(serverId, count)` based on actual `GpuInfo.index`.
  - `AgentGateway.onHello()` loads `payload.gpus` into state cache.
  - Need architecture decision on injecting/using live inventory vs persisted observations/defaults for offline/unknown cases.
