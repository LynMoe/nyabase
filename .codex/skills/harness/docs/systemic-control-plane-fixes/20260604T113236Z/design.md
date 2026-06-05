# Systemic Control Plane Fixes Design

## Goal

Fix the live control-plane regressions so container rows only show "operating/queued" for real active operations, and GPU allocation never invents indices outside the server's actual GPU inventory while preserving shared/load-balanced auto allocation.

## Interfaces

- REST `ContainerDto.operation`
  - Before: mapped from `ContainerControlPlaneView.latestOperation`, which is the newest operation row by `createdAt` for the container resource, regardless of status.
  - After: populated only from `ContainerControlPlaneView.activeOperation`, the newest non-terminal operation for the container resource. If no active operation exists, `operation` is omitted. Terminal historical rows must not drive frontend busy badges or disabled actions.
  - No public REST schema change is required for the minimal fix. If product later needs terminal history in the container row, add a separate field such as `latestOperation`, but do not reuse `operation` for both active locking and history display.

- Backend read model `ContainerControlPlaneView`
  - Before: `latestOperation: OperationEntity | null`.
  - After: add/use `activeOperation: OperationEntity | null` for row/action state. Keep `latestOperation` only if needed internally for history, but `ContainersService.mapControlPlaneView()` must map DTO `operation` from `activeOperation`.

- GPU allocation request handling
  - Before: `ContainersService.pickFreeGpuIndices()` scans hard-coded `0..15` and excludes desired-state used indices, which can produce `[4,5]` on a 4-GPU host.
  - After: auto allocation is bounded to actual `AgentGateway.stateCache` server GPU inventory. For `GpuGrantMode.All`, pick from actual GPU indices using `StateCache.pickGpuIndices(serverId, count)` load-balancing semantics. For `GpuGrantMode.Indices`, restrict candidates to the intersection of granted indices and actual inventory, sorted by current load, and pick the least-loaded permitted indices.
  - Explicit `gpuIndices` must be unique, permitted by grant, and present in actual server inventory. Reject out-of-inventory indices with `BadRequestException` or `ConflictException`; do not silently clamp or invent indices.

## Data Model Changes

- No schema migration.
- No new persisted GPU inventory table in this minimal repair. Use the in-memory `StateCache` populated by agent `hello` as the source of actual GPU indices.
- If a GPU request is made while actual inventory is unavailable or empty, fail the request with a clear error instead of falling back to `0..15`.

## File-Level Change List

- `packages/backend/src/containers/container-read-model.service.ts`
  - Modify `ContainerControlPlaneView` to expose an active operation separately from historical latest operation.
  - Add a terminal status set for `OperationStatus.Succeeded`, `OperationStatus.Failed`, and `OperationStatus.Cancelled`.
  - Change active lookup to query only non-terminal statuses for `resourceType='container'` and `resourceId` matching the desired container id, falling back to docker id only when the container id path has no active row.
  - Keep historical latest lookup only if downstream code still needs it; do not use historical latest for row busy state.

- `packages/backend/src/containers/containers.service.ts`
  - Map `ContainerDto.operation` from `view.activeOperation`, not from terminal/historical `latestOperation`.
  - Replace/remove `pickFreeGpuIndices()` hard-coded `0..15` behavior.
  - Add helpers to read actual GPU inventory from `this.agentGateway.stateCache.get(serverId)?.gpus`, normalize/sort unique indices, and compute least-loaded candidate order from `stateCache.getGpuLoadMap(serverId)`.
  - In `resolveGpuIndicesFromDesired()`:
    - `GpuGrantMode.None`: unchanged rejection for any GPU request.
    - `GpuGrantMode.All`: explicit indices must exist in actual inventory; auto `gpuCount` uses `stateCache.pickGpuIndices(serverId, count)` and verifies returned length and inventory membership.
    - `GpuGrantMode.Indices`: explicit indices must be both granted and in inventory; auto `gpuCount` chooses least-loaded indices from `grant.gpuIndices ∩ actualInventory`.
  - Do not use desired-state `usedGpuIndices()` to make auto allocation exclusive. Existing containers may share GPUs; load determines preferred ordering.

- `packages/backend/src/gateway/state-cache.ts`
  - Keep current `pickGpuIndices(serverId, count)` sharing/load-balancing semantics.
  - Optional small hardening: ensure returned indices are only from `snap.gpus` and return fewer than `count` when inventory is insufficient, leaving `ContainersService` to reject.

- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`
  - Bounded status-progression check/fix: on startup/batch recovery, reconcile any outbox command in terminal status whose operation is still non-terminal by updating the operation to the matching terminal status and `completedAt`.
  - Also ensure `recoverExpiredLeases()` updates the associated operation from stuck `queued`/`waiting_agent`/`running` to `retrying` when a sent/running command lease expires. This prevents durable rows from remaining indefinitely `queued` after worker restarts or async delivery interruptions.
  - Do not add broad cleanup or mutate unrelated live operations outside command/operation pairs with a clear outbox status relationship.

- `packages/frontend/src/components/containers/container-row.tsx`
  - No required behavior change if backend `operation` becomes active-only.
  - Optional defensive hardening: keep terminal-status guard so malformed/legacy payloads cannot show `操作中`.

- `packages/frontend/src/pages/container-detail-page.tsx`
  - No required behavior change if backend `operation` becomes active-only.
  - Optional defensive hardening only; no new UI required for this fix.

## Tests

- `packages/backend/src/containers/__tests__/container-read-model.service.test.ts`
  - Add test: latest operation is terminal but an older/absent active operation exists; `activeOperation` is `null`, so DTO `operation` would be omitted.
  - Add test: active operation lookup chooses newest non-terminal operation over newer terminal history only for active state.
  - Add test: container-id active operation wins; docker-id fallback is used only when no active row exists for the desired container id.

- `packages/backend/src/containers/__tests__/container-create-durable.test.ts` or a new focused `containers.service.gpu-allocation.test.ts`
  - Add test: on inventory `[0,1,2,3]` with an existing 4-GPU container using `[0,1,2,3]`, a new auto `gpuCount: 2` request returns two actual indices from `[0,1,2,3]`, never `[4,5]`.
  - Add test: load balancing shares least-loaded GPUs using `StateCache.pickGpuIndices` semantics.
  - Add test: explicit `[4,5]` on inventory `[0,1,2,3]` is rejected even for `GpuGrantMode.All`.
  - Add test: `GpuGrantMode.Indices` auto-pick only chooses from `grant.gpuIndices ∩ inventory`, and explicit granted-but-not-in-inventory index is rejected.
  - Add test: GPU request with missing/empty inventory fails clearly instead of falling back to hard-coded indices.

- `packages/backend/src/gateway/__tests__/state-cache.test.ts`
  - Add/keep test documenting that `pickGpuIndices()` only returns actual `snap.gpus` indices and balances by container count.

- `packages/backend/src/operations/__tests__/operations.service.test.ts`
  - Add bounded worker test: a terminal outbox row with a non-terminal operation is repaired to matching terminal operation status.
  - Add worker lease recovery assertion, if not already covered, that expired sent/running commands move both command and operation out of stuck non-terminal state.

## Risks and Trade-Offs

- Using only in-memory `StateCache` means GPU requests require the agent to have sent `hello` in this backend process. This is acceptable for the minimal repair because inventing indices is worse than failing clearly; a persisted inventory table can be a separate enhancement.
- Removing terminal history from `ContainerDto.operation` may hide the existing row-level "operation failed" badge. That is preferable to using the same field for both active locks and historical display. If failure history is required, introduce a separate terminal-history DTO field later.
- Shared GPU allocation may oversubscribe GPU memory. This matches the user's reported expectation that GPUs should not become exclusive by selecting non-existent indices. Capacity-aware scheduling can be added later with memory-aware policy, but must still be bounded by actual inventory.
- Worker status repair must be narrowly scoped to outbox/operation pairs to avoid rewriting legitimate long-running operations.

## Acceptance Criteria

- Container list/detail DTOs omit `operation` when the latest or historical operation is terminal, so terminal history cannot make `ContainerRow` show `操作中` or disable actions.
- If a real non-terminal operation exists for a container, the read model exposes the newest relevant active operation and the frontend continues to show `操作中`.
- Existing stuck outbox/operation status drift is boundedly repaired when there is a clear command/operation relationship, preventing commands in terminal outbox states from leaving operations forever `queued`/active.
- GPU auto-pick never returns an index outside actual server inventory from agent `hello`/`StateCache`.
- On a 4-GPU host with inventory `[0,1,2,3]`, no create/restart/create-like path can produce `gpuIndices: [4,5]`.
- Auto GPU allocation allows sharing/reuse of real GPU indices and load-balances by current container count instead of treating desired-state usage as exclusive.
- Explicit GPU indices are rejected when duplicated, outside the grant, or outside actual server inventory.
- Targeted read-model, GPU allocation, `StateCache`, and bounded outbox status-repair tests pass.

## Out of Scope

- Manual live database cleanup or destructive mutation of current containers/operations.
- New persisted GPU inventory schema or migration.
- Full scheduler rewrite, memory-aware GPU capacity planning, or exclusive GPU reservation mode.
- Frontend redesign beyond consuming active-only `operation` semantics.
- Product source/test edits in this architect step.
