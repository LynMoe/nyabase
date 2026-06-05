# Implementation

## Durable Outbox Envelope Command Kind Fix

### Files Changed

- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `toEnvelope()` no longer assigns persisted `command.commandKind` directly into `AgentCommandEnvelope`; it validates against `AgentCommandKind` and returns an `AgentCommandKind` value for the typed envelope.
2. Durable outbox delivery now represents the command kind as `AgentCommandKind` at the final backend envelope boundary. Invalid persisted text fails before any gateway send instead of weakening the common envelope type.
3. `toEnvelope()` now rejects `null` or `undefined` payloads with a clear error before marking the command sent or sending it, keeping the required envelope payload explicit.
4. No old command-name fallback or compatibility mapping was added; only current `AgentCommandKind` enum values are accepted.
5. This implementation record documents files changed, AC coverage, risks, and visual impact.

### Notable Decisions

- Built the envelope before `markCommandSent()` so invalid durable command records fail before the worker marks them sent or calls the gateway.
- Kept validation local to the outbox delivery boundary because the dispatch write scope did not include broader producer interface retagging.

### Risks

- Tests, builds, lint, typecheck, installs, and dev servers were not run because this developer dispatch forbids them.
- `ReadLints` is not available in this runtime, so plausibility was checked by direct source inspection.
- Git metadata is not present in this workspace, so diff/status verification used direct file inspection rather than `git diff`.

### Visual Impact

None. Backend-only durable command envelope validation; no frontend source files, routes, components, or rendered pixels changed.

## Container Read Model DockerId Lookup Removal

### Files Changed

- `packages/backend/src/containers/container-read-model.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Removed the unused production `ContainerReadModelService.getByDockerId(serverId, dockerId)` method.
2. Left `getByContainerId`, `list`, `composeView`, and desired/observation composition behavior unchanged.
3. Production-only grep found no callers outside the removed declaration before the edit, so no production call sites were broken or expanded.
4. This implementation record documents files changed, AC coverage, risks, and visual impact.

### Notable Decisions

- Kept `dockerId` fields in the read-model view and private composition paths because they remain observed bindings/import hints.
- Did not alter private legacy observation fallback for desired rows, since the dispatch only targeted the unused old public lookup method.

### Risks

- Tests, builds, lint, typecheck, installs, and dev servers were not run because this developer dispatch forbids them.
- `ReadLints` is not available in this runtime, so plausibility was checked by direct source inspection and production-only symbol grep.

### Visual Impact

None. Backend-only read-model API surface cleanup; no frontend source files, routes, components, or rendered pixels changed.

## UpdateContainerMounts Mount Mapping Cleanup

### Files Changed

- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Source Inspected

- `packages/backend/src/containers/containers.service.ts`

### Acceptance Criteria Mapping

1. `ContainersService.updateContainerMounts` was inspected at the `mounts.map` payload passed to `setExpectedMounts`; the current object literal contains a single `createIfMissing` key.
2. The existing `createIfMissing: m.createIfMissing ?? false` default is preserved unchanged.
3. No backend behavior, protocol shape, frontend behavior, routes, tests, package metadata, lockfiles, or unrelated source files were changed.
4. This implementation record documents the cleanup result, risk, and visual impact.

### Self-Check

- Checked the same mapping block for obvious compile hazards: object-literal keys are unique, every `MountInput` field expected by `setExpectedMounts` is supplied, and the `ContainerMountInputDto` optional `createIfMissing` field matches the preserved defaulting expression.
- Source was already in the corrected state when this dispatch ran, so no product source edit was required.

### Risks

- Tests, builds, typecheck, lint, formatting, package-manager commands, and dev servers were not run because this developer dispatch forbids them.
- `ReadLints` is not available in this runtime, so the edited documentation file and inspected method were checked by direct source inspection only.

### Visual Impact

None. Backend method inspection and session documentation only; no frontend source files, routes, components, or rendered pixels changed.

## Agent Command Envelope Required Payload Type Fix

### Files Changed

- `packages/common/src/protocol/agent-messages.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `zAgentCommandEnvelope.parse(...)` now returns the exported `AgentCommandEnvelope` interface with a required `payload`, so `CommandDispatcher.handleAgentCommand` can receive the parsed envelope without an optional-payload type mismatch.
2. `zAgentCommandEnvelope` keeps `payload` in the object schema and adds an object-level own-property check, so messages missing the `payload` key are rejected at runtime.
3. The exported `AgentCommandEnvelope` interface is the schema transform output type, keeping the public command envelope type aligned with parse results without unsafe broad `any` at the dispatcher call site.
4. No agent command routing, direct-command rejection, ack/progress emission, Docker/client execution, or dispatcher behavior was changed.
5. Visual impact is none because this is a common protocol type/schema fix used by agent command dispatch only.

### Notable Decisions

- Fixed the boundary in common rather than casting inside the agent dispatcher, because the protocol requires `payload` to be present for every durable agent command.
- Used an own-property validation check so an absent JSON key is rejected while preserving `unknown` payload typing for command-specific parsers.

### Risks

- Tests, builds, lint, and typecheck were not run because this developer dispatch forbids them. DevOps should rerun `bash scripts/check.sh --with-visual`.

### Visual Impact

None. Common protocol type/schema only; no frontend routes, components, or rendered output changed.

## Nullable Result Typecheck Fix

### Files Changed

- `packages/backend/src/operations/operation-orchestrator.service.ts`
- `packages/backend/src/operations/reconcile-task-worker.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Replaced result-bearing terminal `manager.update`/`tasksRepo.update` calls for `OperationEntity`, `OperationStepEntity`, and `ReconcileTaskEntity` with entity mutation plus `save`, avoiding TypeORM update-partial JSON/null typing while keeping durable persistence.
2. `markCommandSucceeded` still marks the command succeeded, marks the operation succeeded, marks the optional step succeeded when present, and marks reconcile tasks with the matching `operationId` succeeded. It still normalizes only `undefined` to `null` and persists explicit `null` unchanged.
3. `markTaskSucceeded` and `markTaskNotApplicable` still persist the supplied result value exactly, clear `lastError`, update terminal status, and refresh `nextAttemptAt`.
4. Lease/retry routing, domain success/failure hooks, command outbox terminal update behavior, and reconcile task dispatch paths were not changed.
5. Visual impact is none because this is a backend-only TypeORM persistence typing fix.

### Notable Decisions

- Kept non-result status-only update calls unchanged because the reported backend typecheck failures were limited to nullable JSON/result assignments.
- Loaded optional operation steps before saving so a missing step remains a no-op, matching the prior `update` behavior.
- Loaded all reconcile tasks for the operation and saved the mutated rows so the prior "all matching operationId" terminal update behavior remains intact.

### Risks

- Tests, builds, lint, and typecheck were not run because this developer dispatch forbids them. DevOps should rerun `bash scripts/check.sh --with-visual`.
- Git metadata is not present in this workspace, so diff/status verification used direct file inspection rather than `git diff`.

### Visual Impact

None. Backend-only persistence/type fix; no frontend routes, components, or rendered output changed.

## Consolidated Completion Pass

### Files Changed

- `packages/common/src/constants.ts`
- `packages/common/src/enums.ts`
- `packages/common/src/protocol/agent-messages.ts`
- `packages/common/src/protocol/rest.ts`
- `packages/common/src/protocol/ws.ts`
- `packages/backend/src/containers/container-mounts.service.ts`
- `packages/backend/src/containers/container-read-model.service.ts`
- `packages/backend/src/containers/container-ssh-enablements.service.ts`
- `packages/backend/src/containers/container-ssh-sync.service.ts`
- `packages/backend/src/containers/containers.module.ts`
- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/containers/resource-quota.policy.ts`
- `packages/backend/src/datadirs/data-dir-reconciler.service.ts`
- `packages/backend/src/datadirs/datadirs.controller.ts`
- `packages/backend/src/datadirs/datadirs.module.ts`
- `packages/backend/src/datadirs/datadirs.service.ts`
- `packages/backend/src/gateway/agent-gateway.module.ts`
- `packages/backend/src/gateway/agent-gateway.ts`
- `packages/backend/src/gateway/agent-session.ts`
- `packages/backend/src/gateway/container-runtime-observation-writer.service.ts`
- `packages/backend/src/groups/groups.module.ts`
- `packages/backend/src/groups/groups.service.ts`
- `packages/backend/src/images/images.module.ts`
- `packages/backend/src/images/images.service.ts`
- `packages/backend/src/metrics/metrics.controller.ts`
- `packages/backend/src/metrics/metrics.module.ts`
- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`
- `packages/backend/src/operations/lifecycle-hook-registry.service.ts`
- `packages/backend/src/operations/operation-orchestrator.service.ts`
- `packages/backend/src/operations/operation-retry-policy.ts`
- `packages/backend/src/operations/operations.module.ts`
- `packages/backend/src/operations/operations.service.ts`
- `packages/backend/src/operations/reconcile-task-worker.service.ts`
- `packages/backend/src/operations/resource-lock.service.ts`
- `packages/backend/src/quota/quota-dispatch.service.ts`
- `packages/backend/src/quota/quota.module.ts`
- `packages/backend/src/remote-fs/remote-fs-mounts.controller.ts`
- `packages/backend/src/remote-fs/remote-fs-mounts.module.ts`
- `packages/backend/src/remote-fs/remote-fs-mounts.service.ts`
- `packages/backend/src/servers/servers.controller.ts`
- `packages/backend/src/servers/servers.module.ts`
- `packages/backend/src/servers/servers.service.ts`
- `packages/backend/src/users/users.module.ts`
- `packages/backend/src/users/users.service.ts`
- `packages/agent/src/app.ts`
- `packages/agent/src/commands/dispatcher.ts`
- `packages/agent/src/docker/docker-client.ts`
- `packages/frontend/src/components/containers/container-row.tsx`
- `packages/frontend/src/components/containers/create-container-dialog.tsx`
- `packages/frontend/src/components/containers/mounts-card.tsx`
- `packages/frontend/src/hooks/use-container-actions.ts`
- `packages/frontend/src/pages/container-detail-page.tsx`
- `packages/frontend/src/pages/data-dirs-page.tsx`
- `packages/frontend/src/pages/manage-remote-fs-page.tsx`
- `packages/frontend/src/pages/server-detail-page.tsx`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Durable records before host delivery: container lifecycle, data-dir create/delete, disk apply/remove, remote-FS apply/remove, quota, image pull, mount and SSH reconcile now enter operations/reconcile/outbox before agent delivery.
2. Direct lifecycle/hook RPC removal: backend grep is clean for lifecycle/hook `agentGateway.rpc/notify`; remaining direct calls are explicit stats, exec stream/console I/O, disk `checkDisk`/`selfCheck` preflight, and admin daemon reconcile.
3. Gateway callbacks removed: `AgentGateway` no longer owns domain callback arrays or `setImmediate` hook execution; report/progress ingestion enqueues registry tasks.
4. Durable envelope: outbox delivery uses `AgentCommandEnvelope` over `agentCommand`; old command names are payload command kinds inside the envelope path, and direct lifecycle/hook WebSocket command union members are no longer accepted outside allowed transient/admin commands.
5. Agent progress: agent emits `operationProgress` correlated by durable `operationId` and `commandId`; backend records terminal and intermediate progress.
6. Worker/leases/locks: outbox worker has command leases, stale lease recovery, DB resource locks, retry/backoff, terminal updates, and deterministic `processOne/processBatch`; reconcile worker is sequential by default.
7. Durable hooks: mount, SSH, data-dir, remote-FS, data-disk, quota, reconnect/full-report/container-running/data-dir report/user SSH key/grant/default triggers all produce durable reconcile/operation state.
8. Create lifecycle: create persists desired container state before delivery, sends backend `containerId`, binds observed `dockerId` on success, and marks failed desired state on failure.
9. Delete lifecycle: delete marks desired tombstone before delivery and only cleans mount/SSH/runtime state after agent success.
10. Persisted reads/guards: container list/detail, quota/GPU admission, data-dir delete guards, mount/SSH decisions, disk/quota/status reads now use DB desired/observed/operation state rather than `StateCache`.
11. Side-effect-free reads/backfill removal: container read paths no longer fall back to cache-only containers; SSH label backfill on reads was removed.
12. Docker label scope: new containers write identity/generation labels only; legacy full-spec labels remain import/discovery hints.
13. Report persistence/reconcile: state, data-dir, remote-FS, disk, quota, and stats observations are persisted; full/reconnect/data-dir report paths enqueue reconcile tasks, including visible not-applicable tasks for desired containers whose runtime is stopped or missing.
14. Frontend operation visibility: container rows/detail, create/actions, data-dir, disk, remote-FS, and mount workflows show queued/pending/failure signals from operation/read-model responses and polling.
15. Existing data import: full report import preserves legacy labeled containers as desired rows with deterministic backend IDs when no new `container_id` label exists.
16. Regression gate: not run by developer per dispatch; source was prepared for tester/devops to run root and visual gates.

### Notable Decisions

- `StateCache` remains inside `AgentGateway` only as a transport-local scratchpad for session/report handling and pull-progress helpers; services/controllers no longer read it for lifecycle decisions.
- The agent dispatcher rejects direct lifecycle/hook mutation messages unless they arrive through the durable `agentCommand` envelope; direct transport remains only for exec, explicit stats, disk/self-check preflight, report reconcile request, and admin Docker daemon reconcile.
- Image pull was moved through durable operations even though it was outside the original lifecycle blocker list, to avoid leaving an avoidable direct host mutation.
- Disk `checkDisk` and `selfCheck` remain transient preflight/admin checks as allowed by the design.
- Remote-FS and disk APIs keep existing primary resource shapes but now include operation id metadata where host reconcile is queued.
- GPU inventory lacks a persisted host-info entity in the current schema; server GPU routes no longer read `StateCache` and currently return DB/read-model-safe data only.

### Risks

- Tests/builds/lint/typecheck were not run because this developer dispatch forbids them.
- The change is cross-cutting and existing tests that asserted direct RPC/cache behavior will need tester updates.
- Some operation visibility is via current resource read-model polling and queued operation ids, not a dedicated live event stream.
- Docker daemon status persistence remains a no-op because there is no daemon observation entity yet; the admin daemon reconcile path remains an allowed transient exception.
- GPU inventory display may be less rich until a persisted GPU observation model exists.

### Visual Impact

- `/containers` and container row components can show operation badges and disable controls while backend operations are active after refresh.
- `/containers/:serverId/:dockerId` can show an operation status panel and queued SSH reconcile messages.
- Create container dialog success copy now shows queued operation ids.
- Data-dir page create/delete toasts now show queued operation ids.
- Server detail disk add/update/remove toasts now show queued operation ids; GPU inventory may render fewer static details because it no longer reads transport cache.
- Remote-FS management page create/update/delete/remount/assignment toasts now show queued operation ids.
- Mounts card copy now says reconcile is queued/saved rather than synchronous immediate application.

## Files Changed

- `packages/common/src/enums.ts`
- `packages/common/src/protocol/rest.ts`
- `packages/backend/src/entities/entity-transformers.ts`
- `packages/backend/src/entities/container.entity.ts`
- `packages/backend/src/entities/container-runtime-observation.entity.ts`
- `packages/backend/src/entities/container-mount-runtime.entity.ts`
- `packages/backend/src/entities/operation.entity.ts`
- `packages/backend/src/entities/operation-step.entity.ts`
- `packages/backend/src/entities/agent-command-outbox.entity.ts`
- `packages/backend/src/entities/resource-lock.entity.ts`
- `packages/backend/src/entities/reconcile-task.entity.ts`
- `packages/backend/src/entities/data-dir-runtime-observation.entity.ts`
- `packages/backend/src/entities/remote-fs-runtime-observation.entity.ts`
- `packages/backend/src/entities/data-disk-runtime-observation.entity.ts`
- `packages/backend/src/entities/quota-desired.entity.ts`
- `packages/backend/src/entities/quota-runtime-observation.entity.ts`
- `packages/backend/src/database/db-entities.ts`
- `packages/backend/src/database/migrations/1780458695007-ContainerLifecycleControlPlane.ts`
- `packages/backend/src/containers/container-read-model.service.ts`
- `packages/backend/src/containers/containers.module.ts`

## Acceptance Criteria Mapping

1. New durable control-plane entities compile as TypeORM entities and are registered in `DB_ENTITIES`.
   - Added desired container, runtime observation, mount runtime, operation, operation step, outbox, lock, reconcile task, data dir, remote FS, disk, quota desired, and quota runtime entity classes.
   - Registered all new entity classes in `packages/backend/src/database/db-entities.ts`.
2. Migration creates all new Phase 1 tables without dropping old tables or requiring data backfill yet.
   - Added `1780458695007-ContainerLifecycleControlPlane.ts` using hand-written `Table`, `TableIndex`, and `TableUnique`.
   - `up` only creates new tables/indexes/uniques. Existing tables such as `container_mounts` and `container_ssh_enablements` are untouched.
3. Existing container endpoints/services keep their current behavior; Phase 1 adds skeletons only.
   - Did not edit controllers or existing `ContainersService` lifecycle methods.
   - `ContainersModule` change only registers additional repositories/provider for the read-model skeleton.
4. Common enum/type exports are available from `@nyabase/common` and do not break existing imports.
   - Added lifecycle, power intent, operation, outbox, hook, and drift enums to `enums.ts`.
   - Added optional operation/stale/staleness/drift/lifecycle DTO helpers to existing REST DTOs; existing fields remain unchanged.
5. New read-model skeleton is injectable and does not perform read-path writes.
   - Added `ContainerReadModelService` under `packages/backend/src/containers/`.
   - Service composes desired rows plus latest observations, latest operation, hook summaries, stale flag, and basic drift in read-only repository calls.
6. No generated artifacts are added under `packages/common/src/**`.
   - Verified with `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) | sort`; no output.

## Decisions

- Kept this phase additive: no old read/write path was redirected to the new schema.
- Left existing `container_mounts` and `container_ssh_enablements` intact because Phase 1 is foundation only and the dispatch forbids behavior switching.
- Used text-backed numeric transformers for bigint-sensitive byte fields to match existing SQLite-safe backend patterns.
- Avoided foreign keys in the skeleton migration, matching the current service-layer ownership style and reducing rollout coupling before import/backfill exists.
- Read model currently centers desired rows for list and can compose observed-only rows by Docker lookup; broader observed-only admin listing can be added when report ingestion exists.

## Risks

- Build/typecheck/lint were not run because this dispatch explicitly forbids tests/builds/dev servers; devops/tester should run the standard checks next.
- Backend TypeScript imports new common enums through `@nyabase/common`; `scripts/check.sh` builds common first, but a backend-only typecheck against stale `packages/common/dist` would not see the new exports until common is rebuilt.
- The migration has no data import/backfill by design for Phase 1, so new tables start empty and current REST behavior remains sourced from existing paths.

## Visual Impact

None. No frontend files, routes, or rendered components were changed.

## Durable Power/Delete Dispatch Slice

### Files Changed

- `packages/backend/src/app.module.ts`
- `packages/backend/src/containers/containers.controller.ts`
- `packages/backend/src/containers/containers.module.ts`
- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/operations/operations.controller.ts`
- `packages/backend/src/operations/operations.module.ts`
- `packages/backend/src/operations/operations.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `ContainersService.startContainer`, `stopContainer`, `restartContainer`, and `deleteContainer` now call `OperationsService.dispatchAgentCommand`, which creates one `OperationEntity` row and one `AgentCommandOutboxEntity` row before invoking the existing agent RPC.
2. RPC success updates the operation to `OperationStatus.Succeeded`, the outbox command to `AgentCommandStatus.Succeeded`, and writes `completedAt` timestamps.
3. RPC failure updates the operation to `OperationStatus.Failed`, the outbox command to `AgentCommandStatus.Failed`, records `lastError`, and rethrows the same mapped exception path used by callers today.
4. Existing access checks, online checks, audit logs, delete mount cleanup, delete SSH cleanup, and `rpcWithErrorMapping` calls remain in the same lifecycle methods. Delete still performs mount/SSH cleanup and audit only after the agent delete RPC succeeds.
5. The four controller routes now return the service `OperationRefResponse` shape: `{ ok: true, operationId, status }` on success.
6. Added `OperationsModule`, `OperationsService`, and `OperationsController`, wired through Nest module imports and TypeORM repositories for operations, operation steps, and outbox commands.
7. No frontend files were changed.

### Notable Decisions

- This slice tracks the currently dispatched agent RPC result only. It does not introduce the future agent command envelope, retry worker, DB-backed locks, desired-row transitions, hook tasks, or frontend polling.
- Preflight failures before dispatch, including access denial, missing container, and offline agent checks, keep the current exception behavior and do not create operation/outbox rows. Agent RPC failures after dispatch are durable failures.
- Outbox rows are marked `sent` immediately because this dispatch still executes the existing synchronous RPC inline rather than handing the row to a separate worker.
- Delete cleanup failures after a successful agent delete can still fail the caller as before, but the durable operation/outbox record reflects the agent delete command result as required for this slice.
- Added a local `GET /operations/:operationId` endpoint that returns operation, step, and outbox command visibility. The endpoint allows the requester or a user with `ManageContainersAny`.

### Risks

- Tests/builds/lint were not run because this developer dispatch forbids running tests, builds, dev servers, and package installs. Existing tests that manually instantiate `ContainersService` will need tester updates for the new `OperationsService` constructor dependency.
- This is still synchronous dispatch with durable status updates, not the final durable worker/retry model from the architecture design.
- The operation read DTO is currently backend-local and not added to `@nyabase/common`; this avoided common package changes for a narrow backend-only visibility endpoint.

### Visual Impact

None. No frontend files, routes, or rendered components were changed; response JSON for backend lifecycle routes changed only for the four requested operations.

## Backend Typecheck Fix

### Files Changed

- `packages/backend/src/operations/operations.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Replaced the success-path `manager.update(OperationEntity, ..., { result: storedResult })` call with `manager.save(OperationEntity, manager.create(...))` so nullable `OperationEntity.result` uses the entity field type instead of TypeORM's stricter update-partial type.
2. Failure-path updates are unchanged and still mark the operation and outbox command failed with `lastError` plus `completedAt`.
3. Success behavior remains unchanged: the operation is marked `OperationStatus.Succeeded`, stores the RPC result or `null` for `undefined`, clears `lastError`, records `completedAt`, and the outbox command is marked `AgentCommandStatus.Succeeded`.
4. This implementation record now documents the DevOps backend typecheck fix.

### Risks

- Typecheck was not rerun because this developer dispatch forbids running tests, builds, dev servers, and package installs. DevOps should rerun `bash scripts/check.sh`.

### Visual Impact

None. Backend-only type fix; no frontend files or rendered output changed.

## Persisted Runtime Observations Slice

### Files Changed

- `packages/backend/src/gateway/container-runtime-observation-writer.service.ts`
- `packages/backend/src/gateway/agent-gateway.ts`
- `packages/backend/src/gateway/agent-gateway.module.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Added `ContainerRuntimeObservationWriter`, which persists one `ContainerRuntimeObservationEntity` row per reported Docker container with a server-local `reportSeq` computed as the latest persisted sequence for that server plus one.
2. Full non-incremental reports now mark all previously latest observations on the same server as `stale=true`; absent Docker IDs also get `missingSince`, preserving historical rows.
3. `AgentGateway.onStateReport` still performs the existing `StateCache` updates, metrics-adjacent report handling, and callback scheduling. Container REST read paths were not changed.
4. Observation persistence is wrapped in a local `try/catch` in `AgentGateway`; failures are logged and do not throw out of the state report handler after the cache update flow.
5. `AgentGatewayModule` now registers `ContainerRuntimeObservationWriter` and includes `ContainerRuntimeObservationEntity` in its TypeORM feature repositories.
6. The writer stores `serverId`, `dockerId`, label-derived `containerId` when labels are valid, `status`, `stats`, `sshServer`, `labels`, `labelsValid`, parsed `specGenerationSeen`, `firstSeenAt`, `lastSeenAt`, `missingSince`, and `stale`. Because current `ContainerSnapshot` does not expose labels, current rows will usually store `labels=null`, `labelsValid=false`, and fall back to numeric legacy `spec.specVersion`.
7. No frontend files were changed.

### Notable Decisions

- Kept persistence in a gateway-local service so `AgentGateway` only calls one writer and keeps its current cache/read behavior.
- Serialized observation writes per server in memory to avoid duplicate `reportSeq` assignment when multiple reports from the same connection are handled concurrently.
- Reused previous latest `firstSeenAt` for repeated reports of the same Docker ID; new report rows always get fresh `lastSeenAt`, `missingSince=null`, and `stale=false`.
- De-duplicated repeated Docker IDs within a single report with last snapshot winning, matching the existing `StateCache` map behavior and avoiding the unique `(serverId, dockerId, reportSeq)` constraint collision.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester/DevOps should run the standard gates.
- Raw Docker labels remain unavailable in the current agent payload and zod schema, so label-derived `containerId` cannot be populated until a later protocol/agent slice exposes labels.
- Latest-observation lookup currently scans observations for the server and reduces by Docker ID. This is simple and type-safe for the slice but may need a query-level optimization if observation history grows large.

### Visual Impact

None. Backend-only persistence change; no frontend files, routes, or rendered components changed.

## Full-Report Stale Semantics Fix

### Files Changed

- `packages/backend/src/gateway/container-runtime-observation-writer.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Full non-incremental reports now mark every previously latest observation for the server as `stale=true`, including Docker IDs still present in the new report.
2. Previous latest observations absent from the new report set `missingSince` only when it was not already set; present Docker IDs do not receive a new `missingSince`.
3. Incremental report behavior remains unchanged because superseded/missing handling still runs only when `payload.incremental` is false.
4. Newly inserted observations remain `stale=false` because the superseded pass only updates rows loaded before inserting the current report.
5. This implementation record documents the stale semantics fix.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester should rerun the focused Phase 3 coverage.

### Visual Impact

None. Backend-only persistence logic changed; no frontend files, routes, or rendered components changed.

## Full-Report Desired Container Import Slice

### Files Changed

- `packages/backend/src/gateway/container-runtime-observation-writer.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Full non-incremental `stateReport` snapshots now run a desired-container import pass after the existing runtime-observation persistence transaction.
2. Import candidates are de-duplicated by the existing report de-dupe, prefiltered against current `containers` rows by `{ serverId, dockerId }`, and inserted with `orIgnore()` so repeated reports and concurrent inserts do not create duplicate rows or overwrite existing rows.
3. Existing desired rows for the same `{ serverId, dockerId }` are left untouched; the importer only inserts missing rows.
4. Incremental reports do not call the desired-container importer.
5. Specs missing required identity fields (`dockerId`, `ownerId`, `name`, `imageId`, `serverId`) or whose snapshot `serverId` does not match the authenticated report server are skipped and logged.
6. Imported rows set stable IDs from valid `nyabase.container_id` labels when present, otherwise from a deterministic `legacy-<sha256(serverId,dockerId)>` value. They also set desired server/docker/owner/name/image/resource/IP/SSH fields, `powerIntent`, `lifecyclePhase=active`, spec/mount/SSH generations, created/deleted metadata, and parsed/fallback `createdAt`.
7. Runtime observation persistence, stale/missing handling, `StateCache`, gateway callbacks, and REST read behavior remain unchanged. Import failures are logged inside the writer and do not roll back already-persisted runtime observations.
8. No frontend files or REST read paths were changed.

### Notable Decisions

- Kept the importer inside `ContainerRuntimeObservationWriter` as a local full-report helper, but separated it into its own transaction after the observation write so import issues do not regress Phase 3 observation persistence.
- `imageDockerRef` uses the current `ImageEntity.dockerImage` when the image row is registered and found. Legacy snapshots only guarantee `imageId`, so the fallback is `imageId`; this is a compatibility limitation until agent reports or desired create flows carry the Docker ref directly.
- `imageDefaultUid` uses the current image row when available and falls back to `0`.
- Snapshot `serverId` must match the connection/report server before import to avoid authenticated cross-server pollution from malformed reports.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester/DevOps should run the focused writer coverage and standard gates next.
- Existing direct unit tests that instantiate `ContainerRuntimeObservationWriter` with only observation metadata will skip desired imports; new import coverage should register `ContainerEntity` and optionally `ImageEntity`.

### Visual Impact

None. Backend-only persistence logic changed; no frontend files, routes, rendered components, or REST read paths changed.

## Desired Import ImageEntity Collection Fix

### Files Changed

- `packages/backend/src/gateway/container-runtime-observation-writer.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Removed the runtime `ImageEntity` import from `ContainerRuntimeObservationWriter`; the writer no longer evaluates the legacy image entity during Vitest suite collection.
2. Desired import still runs when only `ContainerEntity` and `ContainerRuntimeObservationEntity` are registered because image enrichment now returns an empty map unless `images` metadata is registered.
3. Image enrichment is preserved when `images` metadata is registered by querying the `images` table for `id`, `dockerImage`, and `defaultUid` through a string table-name path instead of the entity class.
4. Existing Phase 3 observation persistence is unchanged; only optional desired-import image lookup changed.
5. This implementation record documents the fix and the image lookup behavior.

### Notable Decisions

- Kept the desired-import fallback behavior unchanged: when no image row is available, imported desired rows use `spec.imageId` as `imageDockerRef` and `0` as `imageDefaultUid`.
- Derived image-table column names from registered metadata and escaped identifiers through the active TypeORM driver, without importing the image entity class.
- Used raw row coercion for `dockerImage` and `defaultUid` so unexpected image-table values cannot break desired imports.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester should rerun the focused Phase 4 writer coverage.

### Visual Impact

None. Backend-only persistence logic changed; no frontend files, routes, rendered components, or REST read paths changed.

## Durable Container Read Path Slice

### Files Changed

- `packages/backend/src/containers/container-read-model.service.ts`
- `packages/backend/src/containers/containers.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `ContainersService.listContainers` now maps `ContainerControlPlaneView` rows into legacy-compatible `ContainerSnapshot`/`ContainerDto` objects and includes read-model metadata: `operation`, `observedAt`, `stale`, `staleness`, `drift`, `lifecycle`, and `hooks`.
2. Non-admin and admin `ownOnly` filtering is applied to durable rows by desired/read-model owner before list enrichment; cache fallback still uses the existing `stateCache.getContainers(ownerId)` filtering.
3. List enrichment still resolves `serverName` from server rows and admin `ownerName` from user rows, with cache hostname fallback preserved for cache-backed rows.
4. When durable list views are empty or incomplete, cache-only rows are appended through the existing state-cache source path, keeping legacy snapshot fields such as `spec.dataDirs`.
5. `getContainer(dockerId, serverId)` now calls `ContainerReadModelService.getByDockerId` first and falls back to stateCache only when no durable view exists; it still throws `NotFoundException` when neither source has the container.
6. List duplicate suppression uses all durable `{serverId,dockerId}` keys before owner filtering, so cache duplicates are hidden and the durable read-model row wins.
7. Durable DTOs keep `spec.ownerId`, `spec.name`, status, SSH state, and the legacy `spec` shape required by `assertOwnerOrManageAny`, mount updates, stats, and other existing callers.
8. List/get no longer call the write-capable SSH overlay helpers; they use read-only SSH enablement lookups and do not backfill rows on the read path.
9. No frontend files were changed.

### Notable Decisions

- `ContainerReadModelService` now resolves latest observations for desired rows by container ID first and by legacy `{serverId,dockerId}` second. This lets rows imported from legacy state reports join observations even when reports do not yet carry valid container labels.
- Latest operation lookup also falls back from container ID to Docker ID because the earlier durable operation dispatch slice still records container operations with Docker ID resource IDs.
- Durable desired rows use persisted observations for runtime `status`, `stats`, and `sshServer`; cache runtime fields are used only for cache-only rows or observed-only durable views that lack desired spec fields.
- Desired rows do not currently store mount details, so durable DTOs return `spec.dataDirs` from the matching cache snapshot when available and `[]` otherwise to preserve the required legacy field.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester/DevOps should run the focused read-path coverage and standard gates next.
- Direct unit tests that manually instantiate `ContainersService` may need tester updates for the optional read-model dependency or the new read-only SSH overlay call shape.

### Visual Impact

None. Backend-only REST read-path logic changed; no frontend files, routes, or rendered components changed.

## Phase 6 Durable Create Write Path

### Files Changed

- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/containers/containers.controller.ts`
- `packages/backend/src/operations/operations.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `ContainersService.createContainer` now returns `Promise<OperationRefResponse>`, and `ContainersController.create` returns that service response directly.
2. After existing preflight validation and before the legacy `createContainer` RPC, create allocates a backend UUID `containerId` and persists a `ContainerEntity` desired row with `dockerId=null`, owner/server/name/image/resource/SSH intent fields, `powerIntent=running`, `lifecyclePhase=creating`, generations initialized to `1`, and image snapshots.
3. Extended `OperationsService.dispatchAgentCommand` with optional transaction callbacks so the create path persists the desired row, `OperationEntity`, and `AgentCommandOutboxEntity` together before the RPC. The create operation uses `OperationKind.ContainerCreate`, command kind `createContainer`, and resource id `containerId`.
4. The legacy create RPC payload keeps all existing fields and adds backend identity hints: `containerId` and `specGeneration`.
5. On RPC success with `dockerId`, the success callback binds the desired row to `dockerId` and marks `lifecyclePhase=active`; it also records `ip` if a future agent result supplies one. Quota notify, expected mount rows, SSH enable+strict reconcile, and audit logging remain after the create RPC. The returned response is `{ ok: true, operationId, status }` from the dispatch result.
6. RPC failures use the existing `OperationsService` failure path and mark the desired row `failed`. Post-RPC quota/mount/SSH/audit failures mark the operation failed through `OperationsService.markOperationFailed` and mark the desired row `failed`; the existing SSH-enabled cleanup path still deletes the created Docker container and adjacent mount/SSH rows when the mount/SSH block fails.
7. Server/image/access/quota/GPU/mount-source/numeric-id preflight checks still happen before dispatch, so those failures do not create desired rows, operations, or outbox commands.
8. No frontend files were changed and no common source artifacts were introduced by this slice.

### Notable Decisions

- Kept the slice on the current synchronous legacy RPC model. The outbox row is still marked sent before the inline RPC, matching the previous durable start/stop/restart/delete dispatch slice.
- Did not add a `ContainersService` repository dependency; operation transaction callbacks keep desired-row writes tied to the existing operation/outbox persistence point.
- The current REST create request and agent response do not expose a backend-allocated IP. The desired row therefore starts with `ip=''` and can bind an optional returned `ip` if a later agent slice supplies it.
- Post-RPC setup failures now turn the overall create operation from succeeded to failed while leaving the create command outbox row succeeded. This distinguishes a successful Docker create command from a failed create workflow.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester/DevOps should run the assigned gates.
- Existing tests that manually instantiate `OperationsService.dispatchAgentCommand` may need to account for the optional callback surface, though existing call sites remain source-compatible.
- Until the agent consumes `containerId`/`specGeneration` and reports labels/IP back, durable reads may show creating/active desired rows with empty IP until observations fill in runtime details.

### Visual Impact

None. Backend-only service/controller/operation changes; no frontend routes, components, or rendered pixels changed.

## Phase 7 Durable Mount Reconcile Task Entry Points

### Files Changed

- `packages/backend/src/containers/container-mounts.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `setExpectedMounts` still performs duplicate validation, full transactional replacement, audit logging, and an immediate mount reconcile before returning. The reconcile now starts from a persisted `ReconcileTaskEntity` with `hook=HookKind.Mounts`, `resourceType='container'`, `serverId`, a durable container ID when available with Docker ID fallback, and final status/result/error from the attempt.
2. Full state-report running-container reconciliation and container-start reconciliation now call the durable mount task wrapper instead of the raw `reconcile(...)` entry point. `reconcileAllRunning` still only considers running cache snapshots, and container-start still best-efforts failures through the gateway callback path.
3. Immediate processing records `succeeded` with `dockerId`, expected count, and removed paths after successful `reconcileContainerMounts`; `waiting_agent` with an offline reason when the agent is offline; `not_applicable` with missing/stopped reason when no running container is available; and `failed` plus `lastError` when host-path resolution or the RPC fails. User-triggered mount updates rethrow reconcile failures after recording the failed task.
4. Public method signatures and controller response behavior are unchanged; `PATCH /mounts` still succeeds with the existing caller shape when the immediate reconcile path succeeds or is skipped as before.
5. The existing `reconcile(serverId, dockerId, toRemove?)` method remains available as the manual/legacy primitive and still computes expected mounts and calls `reconcileContainerMounts` only for online running containers.
6. No frontend files were changed and no common source files or generated common artifacts were introduced.

### Notable Decisions

- Used `DataSource.getRepository(ReconcileTaskEntity)` and `DataSource.getRepository(ContainerEntity)` inside `ContainerMountsService` instead of adding constructor dependencies, keeping existing manual service instantiation source-compatible.
- Created immediate tasks directly in `running` state with `attempts=1` before the RPC, then finalized them to the terminal or waiting/not-applicable status from the same attempt.
- Kept `addMount` and `removeMount` on their existing fast-path RPC behavior; only the specified full-reconcile entry points were redirected through durable tasks.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester/DevOps should run the assigned backend gates.
- Task rows fall back to Docker ID when no durable `ContainerEntity` is available yet, so some early migration-era task rows may require direct task-table inspection unless the read model later adds hook lookup fallback by Docker ID.

### Visual Impact

None. Backend-only reconcile/task persistence logic changed; no frontend files, routes, components, or rendered pixels changed.

## Phase 8 Durable SSH Auto-Reconcile Task Entry Points

### Files Changed

- `packages/backend/src/containers/container-ssh-sync.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Full state-report SSH reconciliation still scans the cached server snapshot, unions persisted SSH enablement rows with label-enabled snapshots, skips disabled and non-running snapshots before enqueueing, and now creates a `ReconcileTaskEntity` with `hook=HookKind.Ssh` for each running enabled target it attempts.
2. Container-start callbacks now call the durable SSH task wrapper instead of the raw primitive. The task is persisted immediately with `attempts=1`, then processed inline; online, running, enabled containers still promptly call `reconcileContainerSsh`.
3. User SSH key-change callbacks still build the same DB-enabled plus cached label-enabled owned target set and fire-and-forget per target. Each target now records an SSH task and immediate outcome; successful RPC processing fetches fresh user public keys and sends the same `dockerId`, `publicKeys`, and `expectedKeyHash` payload.
4. SSH task outcomes now record inspectable statuses and results: success stores `dockerId`, owner/user context, expected key hash, key count, source, and reason; offline stores `HookStatus.WaitingAgent` with `agent_offline`; missing, stopped, and disabled store `HookStatus.NotApplicable` with the matching reason; key-fetch or RPC failure stores `HookStatus.Failed` and `lastError`.
5. Existing public method signatures remain source-compatible. `reconcileContainer(serverId, dockerId, opts)` remains the manual/primitive path and still preserves strict/manual behavior and return semantics.
6. No frontend files were changed, no tests were edited, no common source files were changed, and the common source artifact guard check was performed with no generated files found.

### Notable Decisions

- Kept `reconcileContainer` as the legacy/manual primitive and factored the shared RPC body into `pushExpectedSshKeys` so manual and durable auto paths use the same fresh key lookup and hash computation.
- Mirrored the Phase 7 mount-task style: create tasks in `running` with `attempts=1`, process immediately on the existing per-container in-memory queue, then finalize to terminal/waiting/not-applicable status.
- Added `DataSource` as an optional constructor parameter so existing direct manual-path instantiations remain source-compatible, while normal Nest runtime injection provides repositories for durable auto task creation.
- Used durable `ContainerEntity.id` and `sshGeneration` when available, with Docker ID and `desiredGeneration=null` fallback for legacy/import-era rows.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester/DevOps should run the assigned backend gates.
- Existing direct unit tests that exercise automatic SSH callbacks without a `DataSource` will need tester updates or a repository-backed service construction, because auto callbacks now persist tasks before processing.
- User SSH key-change tasks are now recorded for the same discovered target set even when the previous callback would have skipped missing/stopped/offline targets before RPC. Those cases remain no-RPC/no-rollback behavior but now leave durable waiting/not-applicable task rows for inspection.

### Visual Impact

None. Backend-only SSH task persistence and reconcile orchestration changed; no frontend files, routes, components, or rendered pixels changed.

## Phase 9 Durable Data Directory Operation Visibility

### Files Changed

- `packages/backend/src/datadirs/datadirs.service.ts`
- `packages/backend/src/datadirs/datadirs.module.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `createDir` keeps the existing online requirement, source validation, DB insert-before-RPC ordering, duplicate DB conflict mapping, numeric user ID lookup, rollback-on-RPC-failure behavior, audit payload, and returned DTO shape.
2. Create now dispatches through `OperationsService.dispatchAgentCommand` before the `createDataDir` RPC with `OperationKind.DataDirCreate`, command kind `createDataDir`, `resourceType='datadir'`, `resourceId=<DataDirectoryEntity.id>`, `serverId`, `requestedBy=actorId`, and the existing `{ diskId, name, uid, numericUserId }` payload object.
3. `deleteDir` keeps the existing online requirement, row lookup, mounted-by-running-container guard, agent-first delete ordering, DB row delete and audit only after RPC success, and unchanged controller behavior.
4. Delete now dispatches through `OperationsService.dispatchAgentCommand` before the `deleteDataDir` RPC with `OperationKind.DataDirDelete`, command kind `deleteDataDir`, `resourceType='datadir'`, `resourceId=<existing row.id>`, `serverId`, `requestedBy=actorId`, and the existing `{ diskId, name }` payload object.
5. RPC failures go through `OperationsService.dispatchAgentCommand` failure marking and rethrow the existing mapped exception. Create rolls back the data directory DB row after the dispatch failure path completes when the filesystem command did not succeed; delete leaves the row intact on dispatch/RPC failure.
6. Post-RPC create audit/DTO host-path failures and delete DB-delete/audit failures call `OperationsService.markOperationFailed` and rethrow the original failure.
7. `DataDirsModule` imports `OperationsModule` so normal Nest runtime injects `OperationsService`. The constructor dependency is optional and last-positioned to keep existing direct service instantiations source-compatible.
8. No frontend files were changed. No common source files were changed, and no generated common source artifacts were introduced.

### Notable Decisions

- Kept this slice on the current synchronous legacy RPC model. The outbox row is persisted and marked sent before the inline RPC, matching the existing operation dispatch helper behavior.
- Used one shared data-dir dispatch wrapper so create/delete operation metadata is consistent while preserving the old direct-RPC fallback for manually constructed services without `OperationsService`.
- Tracked create command success separately from dispatch failure so a filesystem command that already succeeded is not followed by DB-row rollback if a later durable status update throws.
- Left data-dir runtime observations, desired state/generation columns, and hook/task migration out of scope for this slice.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester/DevOps should run the assigned backend gates.
- Existing tests that want to assert durable data-dir operation rows will need to construct `DataDirsService` with an `OperationsService` or use Nest module wiring; legacy direct construction without the optional dependency intentionally exercises the old inline-RPC path only.
- If durable success-status persistence fails after a delete RPC succeeds, `OperationsService` marks the operation failed and rethrows before this service performs the legacy DB-row delete/audit; this leaves the desired row intact for inspection instead of hiding a command-state failure.

### Visual Impact

None. Backend-only operation/outbox persistence changed; no frontend files, routes, components, or rendered pixels changed.

## Phase 9 Data Directory Duplicate Conflict Fix

### Files Changed

- `packages/backend/src/datadirs/datadirs.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Duplicate data-directory insert failures now map through a narrow DB-error classifier that recognizes TypeORM/better-sqlite3 unique failures (`SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_CONSTRAINT` with unique/duplicate message text, and SQLite extended errno `2067`) plus common duplicate codes from PostgreSQL, MySQL/MariaDB, and SQL Server.
2. The classifier only treats explicit duplicate/unique constraint codes as conflicts, or generic SQLite constraint errors when the error text contains a unique/duplicate indicator, so unrelated DB errors still rethrow unchanged.
3. The mapping remains inside the `dataDirRepo.save(entity)` catch before numeric-user lookup and `dispatchDataDirAgentCommand`, so duplicate failures still happen before any operation or outbox dispatch.
4. This section documents the tester-reported failure where a better-sqlite3/TypeORM duplicate insert surfaced as a raw `QueryFailedError` instead of the existing `ConflictException`.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester should rerun the focused data-dir durable operation tests.

### Visual Impact

None. Backend-only duplicate error mapping changed; no frontend files, routes, components, or rendered pixels changed.

## Phase 10 Durable Remote FS Apply Operation Visibility

### Files Changed

- `packages/backend/src/remote-fs/remote-fs-mounts.service.ts`
- `packages/backend/src/remote-fs/remote-fs-mounts.module.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `dispatchMount` now wraps `applyRemoteFsMount` through `OperationsService.dispatchAgentCommand` when available, creating operation/outbox rows before the existing RPC with `OperationKind.RemoteFsApply`, command kind `applyRemoteFsMount`, `resourceType='remote_fs_mount'`, `resourceId=<mount.id>`, `serverId`, caller `requestedBy` or `null` for reconnect dispatch, and the existing payload object.
2. Critical `update`, `remount`, `assignServer`, `create` with `serverIds` through `assignServer`, and reconnect `dispatchAll` still funnel through `dispatchMount(...).catch(() => {})`, so apply attempts and no-rollback best-effort behavior are preserved.
3. RPC success/failure status updates are delegated to `OperationsService.dispatchAgentCommand`; failures still rethrow from `dispatchMount`, allowing the existing call-site `.catch(() => {})` behavior to remain unchanged.
4. `RemoteFsMountsModule` imports `OperationsModule` so Nest runtime injects `OperationsService`. The constructor dependency is optional and last-positioned so direct service instantiation remains source-compatible.
5. Remove and unassign code paths still call `agentGateway.rpc(serverId, 'removeRemoteFsMount', ...)` directly with their existing best-effort catches.
6. No frontend files were changed. No common source files were changed, and the common source artifact guard check was performed with no generated files found.

### Notable Decisions

- Kept this slice on the existing synchronous RPC path; the operation/outbox row is persisted and marked sent by the shared operation helper before the inline RPC.
- Passed `actorId` to `dispatchMount` from user-triggered apply paths and `null` from reconnect `dispatchAll` to distinguish system dispatches.
- Preserved the previous direct-RPC fallback when `OperationsService` is absent, matching the data-dir compatibility pattern for manually constructed services.
- Left remote-FS remove/unassign durable operation coverage, retry worker behavior, generations, and hook task migration out of scope.

### Risks

- Tests, builds, lint, and dev servers were not run because this developer dispatch forbids them. Tester/DevOps should run the assigned backend gates.
- Manual tests that instantiate `RemoteFsMountsService` without the optional `OperationsService` will continue to exercise the legacy direct-RPC path; durable operation assertions should use Nest wiring or provide an operations-service mock.

### Visual Impact

None. Backend-only operation/outbox persistence changed; no frontend files, routes, components, or rendered pixels changed.

## Phase 11 Durable Data Disk Apply Operation Visibility

### Files Changed

- `packages/backend/src/servers/servers.service.ts`
- `packages/backend/src/servers/servers.module.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `ServersService` now imports Nest `@Optional()` and accepts an optional last constructor dependency for `OperationsService`, preserving direct construction compatibility with the legacy direct-RPC path when the dependency is absent.
2. `ServersModule` imports `OperationsModule` so normal Nest runtime wiring can inject `OperationsService`.
3. `addDisk` keeps the existing preflight order: `findById`, online guard, `checkDisk` through `rpcWithErrorMapping`, existence/XFS validation, and existing-disk lookup before any durable operation dispatch.
4. The existing mount-point idempotent branch now routes the `applyDataDisk` call through `OperationsService.dispatchAgentCommand` when available with `OperationKind.DiskApply`, command kind `applyDataDisk`, `resourceType='data_disk'`, `resourceId=<existing.id>`, `serverId`, `requestedBy=null`, and payload `{ diskId, mountPoint, label? }`. Without `OperationsService`, it uses the previous `rpcWithErrorMapping` direct-RPC behavior.
5. The new disk branch still saves the `DataDiskEntity` before applying it on the agent. The apply call uses the same durable dispatch metadata and direct-RPC fallback as the idempotent branch, and no rollback was added.
6. `updateDisk` still saves the label first and returns the saved disk. When the agent is online, it routes apply through durable dispatch if available; failures, including dispatch persistence failures, are swallowed to preserve best-effort semantics. Without `OperationsService`, it uses the previous direct `agentGateway.rpc` path.
7. Reconnect `dispatchDisks` applies every known disk and swallows failures per disk. Durable reconnect dispatch runs sequentially to avoid concurrent operation/outbox transactions on the same SQLite connection, while the legacy no-`OperationsService` fallback keeps its previous parallel direct-RPC behavior.
8. `checkDisk`, `selfCheck`, server default quota notify, and data-disk remove behavior were left unchanged.
9. No common source files were changed, and the common source artifact guard check was performed with no generated files found.

### Notable Decisions

- Added one shared `dispatchDataDiskApply` helper so add/update/reconnect paths use the same operation metadata and payload shape while preserving their existing error-mapping differences.
- Kept `requestedBy=null` for data-disk apply operations because the existing server disk methods do not carry an actor ID.
- Kept this slice on the current synchronous RPC path; the operation/outbox row is persisted by the shared operation helper before the inline RPC.

### Risks

- Tests, builds, lint, package-manager commands, and dev servers were not run because this developer dispatch forbids them. Tester/DevOps should run the assigned backend gates.
- ReadLints is not available in this runtime, so edited files were checked by direct inspection only.
- The workspace at `/root/nyabase` does not expose a `.git` repository, so repository status/diff inspection was unavailable.

### Visual Impact

None. Backend-only operation/outbox visibility changed; no frontend files, routes, components, or rendered pixels changed.

## Phase 11 Reconnect Durable Data Disk Dispatch Transaction Fix

### Files Changed

- `packages/backend/src/servers/servers.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Failure Cause

- Reconnect `dispatchDisks` used `Promise.all` for every disk apply.
- When `OperationsService` is available, each apply opens a `dataSource.transaction(...)` before the inline `applyDataDisk` RPC.
- In the real better-sqlite3 repository setup, those concurrent durable dispatches race on the same SQLite connection. Some dispatches can fail before the RPC is invoked, and one operation/outbox row can be left in an intermediate `waiting_agent`/`sent` state even though no agent command ran.

### Acceptance Criteria Mapping

1. Durable reconnect dispatch now creates and executes one disk apply at a time, so each disk gets its own operation/outbox attempt and reaches the `applyDataDisk` RPC path.
2. The reconnect loop catches each disk failure and continues, preserving best-effort semantics and resolving `dispatchDisks`.
3. `addDisk` and `updateDisk` still call the shared `dispatchDataDiskApply` helper directly; their durable operation behavior and error mapping/catching are unchanged.
4. The no-`OperationsService` fallback remains the previous parallel direct-RPC path, preserving legacy construction behavior.
5. This implementation record documents the SQLite transaction race and local sequential reconnect fix.
6. No common source files were changed, and the common source artifact guard check was performed with no generated files found.

### Notable Decisions

- Kept the fix local to `ServersService` instead of changing `OperationsService`.
- Sequenced only durable reconnect dispatch because the transaction race comes from overlapping operation/outbox persistence, not from the legacy direct RPC fallback.

### Risks

- Tests, builds, package-manager commands, and dev servers were not run because this developer dispatch forbids them.
- ReadLints is not available in this runtime, so edited files were checked by direct inspection only.

### Visual Impact

None. Backend-only reconnect dispatch logic changed; no frontend files, routes, components, or rendered pixels changed.

## Phase 12 Durable Quota Apply Operation Visibility

### Files Changed

- `packages/backend/src/quota/quota-dispatch.service.ts`
- `packages/backend/src/quota/quota.module.ts`
- `packages/backend/src/groups/groups.service.ts`
- `packages/backend/src/groups/groups.module.ts`
- `packages/backend/src/servers/servers.service.ts`
- `packages/backend/src/servers/servers.module.ts`
- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/containers/containers.module.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Added `QuotaDispatchService` and `QuotaModule`. The service accepts `serverId`, `userId`, `numericUserId`, `diskBytes`, and `requestedBy`, and durable dispatch uses `OperationKind.QuotaApply`, command kind `updateUserQuota`, `resourceType='quota'`, `resourceId=<userId>`, `serverId`, `requestedBy`, and payload `{ numericUserId, diskBytes }`.
2. Durable quota dispatch calls `OperationsService.dispatchAgentCommand` and executes the existing `AgentGateway.rpc(serverId, 'updateUserQuota', payload)` path so `commandAck` drives success/failure status through the shared operation helper.
3. `QuotaDispatchService` serializes durable quota dispatches through an internal promise queue. Rejected commands are caught on the stored queue tail so later quota dispatches still run.
4. When `QuotaDispatchService` is absent from direct legacy service construction, `GroupsService`, `ServersService`, and `ContainersService` fall back to the previous `agentGateway.notify(serverId, 'updateUserQuota', payload)` path and create no durable rows. `QuotaDispatchService` also falls back to `notify` if directly constructed without `OperationsService`.
5. `GroupsModule`, `ServersModule`, and `ContainersModule` import `QuotaModule` for normal Nest runtime injection.
6. `GroupsService.syncUserQuota` resolves access and numeric user ID before dispatch, still returns without action when either is missing, routes through `QuotaDispatchService` when present, and swallows only quota dispatch/transport failures after durable failure marking.
7. Reconnect quota fan-out and group/member/grant mutation paths still sync the same user/server pairs as before. User-triggered mutations pass `actorId ?? null`; reconnect/system paths pass `null`.
8. `ServersService.updateDefaults` still saves defaults, invalidates users, resolves numeric IDs and grants, and applies quotas for the same users when `defaultDiskBytes` changes. Quota failures are swallowed and `requestedBy` is `null`.
9. `ContainersService.createContainer` still attempts quota apply after successful container create and before mount/SSH/audit follow-up. Quota failures are isolated from the create failure path, durable quota operations use `requestedBy=requesterId`, and the fallback remains legacy `notify`.
10. Data-disk, remote-fs, data-dir, mount, SSH, `checkDisk`, `selfCheck`, server defaults other than quota notify, and remove behavior were left unchanged.
11. Optional quota dependencies were added as last constructor parameters. `ContainersService` keeps `containerReadModel` in its existing position and adds the quota dependency after it.
12. This implementation record documents files changed, AC mapping, decisions, risks, and visual impact.
13. No common source files were changed, and the common source artifact guard check was performed with no generated files found.

### Notable Decisions

- Kept quota apply as a best-effort follow-up in existing workflows; operation visibility improves durable mode without making quota failures user-visible.
- Centralized only quota command dispatch. Grant/access resolution remains in the existing services so repository/access failures before dispatch keep their prior behavior.
- Serialized durable dispatches in the quota service rather than changing `OperationsService`, matching the narrow Phase 12 scope and avoiding the SQLite transaction race seen in Phase 11 fan-out.
- Left legacy direct `notify` fallback at the call sites for compatibility with manually constructed services that do not receive the new helper.

### Risks

- Tests, builds, package-manager commands, and dev servers were not run because this developer dispatch forbids them.
- ReadLints is not available in this runtime, so edited files were checked by direct inspection only.
- The workspace at `/root/nyabase` does not expose a `.git` repository, so repository status/diff inspection was unavailable.

### Visual Impact

None. Backend-only quota operation/outbox visibility changed; no frontend files, routes, components, or rendered pixels changed.

## Phase 13 Container Lifecycle Closeout

### Files Changed

- Deleted `packages/backend/src/entities/container-ssh-enable.entity.ts`
- Deleted `packages/backend/src/containers/container-ssh-enablements.service.ts`
- Deleted `packages/backend/src/containers/__tests__/container-ssh-rework.test.ts`
- `packages/backend/src/operations/__tests__/operations.service.test.ts`
- `packages/backend/src/entities/container-mount.entity.ts`
- `packages/backend/src/database/migrations/1780458696000-ContainerDesiredSpecBackfill.ts`
- `packages/backend/src/remote-fs/remote-fs-mounts.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. Removed the obsolete container SSH enablement production entity/service. Historical migration `1780388302000-ContainerSshEnablements.ts` was left intact.
2. Removed the dedicated side-table/overlay test and updated operations tests so they no longer import or assert `ContainerSshEnablementEntity`; SSH create coverage now checks `containers.sshEnabled` and the current SSH hook path.
3. Added migration `1780458696000-ContainerDesiredSpecBackfill` to add `container_mounts.containerId`, backfill it from `containers(serverId,dockerId)` with a legacy fallback, drop old dockerId-keyed mount uniques, add containerId-keyed uniques, and reverse those changes in `down`.
4. Kept the `container_mounts` table name to avoid a table rename migration and documented in the entity that it is a legacy table name for containerId-keyed desired mount specs.
5. The new migration adds `desiredState`, `generation`, and `lastOperationId` plus desired-state indexes to `data_directories`, `data_disks`, `remote_fs_mounts`, and `remote_fs_server_assignments`; `down` drops those columns/indexes.
6. Confirmed by source inspection that `AgentCommandKind` is exported from `packages/common/src/enums.ts` through `index.ts`, and `agent-messages.ts` imports it from `../enums.js`; `ws.ts` re-exports the envelope type and does not need a direct value import.
7. Confirmed by source inspection that `ContainerDto` includes both `id` and `containerId`, and SSH response operation IDs remain optional to match current backend returns.
8. Replaced remote-fs remove assignment updates that used function-expression partials for `generation` with load/mutate/save updates.
9. Verified with `find packages/common/src ...` that no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` artifacts exist under `packages/common/src`.

### Notable Decisions

- Did not rename `container_mounts` to `container_mount_specs`; the migration already changes the keying semantics, and avoiding a physical table rename reduces production migration risk.
- The `containerId` backfill falls back to `dockerId` or row `id` only for orphaned legacy rows that cannot be matched to a current desired container.
- Kept `EnableContainerSshResponse.operationId` and `ReconcileContainerSshResponse.operationId` optional because the current service still returns `task.operationId ?? undefined`.

### Risks

- Tests, typecheck, build, package-manager commands, and dev servers were not run per dispatch constraint.
- Migration behavior still needs devops validation on SQLite and Postgres, especially uniqueness replacement on databases with TypeORM-generated legacy unique names.
- The workspace at `/root/nyabase` does not expose a `.git` repository, so git diff/status inspection was unavailable.

### Visual Impact

None. Backend schema/runtime cleanup and test maintenance only; no frontend source files, routes, components, or rendered pixels changed.

## Agent Version Build-Time Fallback

### Files Changed

- `packages/agent/src/config.ts`
- `scripts/build-agent-binary.sh`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `loadAgentConfig()` still resolves `agentVersion` from `@nyabase/agent` package.json first when the source-mode or compiled-install package file is present.
2. If package.json cannot be read, `loadAgentConfig()` now falls back to `process.env.NYABASE_AGENT_VERSION`; official standalone builds replace that expression with a bundled string literal during esbuild.
3. The final fallback is now the explicitly named `DEVELOPMENT_AGENT_VERSION_FALLBACK` value `0.0.0-dev`, so normal official builds should not silently report the old `0.0.0` value.
4. `scripts/build-agent-binary.sh` reads the current version from `packages/agent/package.json`, JSON-quotes it, and injects it into the bundle with `--define:process.env.NYABASE_AGENT_VERSION=...`.
5. This implementation record documents files changed, AC mapping, risks, and visual impact.

### Notable Decisions

- Kept package.json authoritative over injected/runtime environment values so source-mode behavior remains unchanged when the package file is available.
- Used an esbuild env define rather than embedding package.json as a pkg asset, because the running binary only needs the version string and should not depend on package layout at runtime.

### Risks

- Tests, builds, lint, typecheck, package-manager commands, and dev servers were not run because this developer dispatch forbids them.
- `ReadLints` is not available in this runtime, so edited files were checked by direct source inspection only.
- The workspace at `/root/nyabase` does not expose a `.git` repository, so git status/diff verification was unavailable.

### Visual Impact

None. Agent config and binary build script only; no frontend files, routes, components, or rendered pixels changed.

## StateReport Cross-Observation ReportSeq Fix

### Files Changed

- `packages/backend/src/gateway/container-runtime-observation-writer.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Acceptance Criteria Mapping

1. `persistStateReportNow()` now calls `nextStateReportSeq()`, which selects `MAX(reportSeq) + 1` across container runtime, data disk runtime, remote-FS runtime, and quota runtime observation tables for the same server.
2. `persistHello()`, `persistDataDirReport()`, and `persistRemoteFsMountStatus()` still use `nextGenericReportSeq()` for their existing table-specific sequences.
3. A server with disk observations but no container observations now gets a state-report sequence above the disk table max before inserting state-report disk rows, avoiding reuse of an existing `(serverId, diskId, reportSeq)`.
4. The existing `persistStateReport()` per-server promise chain and `runSerializedTransaction()` transaction boundary remain unchanged; only sequence selection inside the state-report transaction changed.
5. This implementation record documents files changed, acceptance-criteria coverage, risks, and visual impact.

### Notable Decisions

- Kept the fix code-level and schema-free because the four observation tables already share the `reportSeq` field needed to choose a non-colliding state-report sequence.
- Factored a shared `maxGenericReportSeq()` helper so one-off report writers keep their table-local behavior while state reports can compare table maxima.

### Risks

- Tests, builds, lint, typecheck, installs, and dev servers were not run because this developer dispatch forbids them.
- `ReadLints` is not available in this runtime, so plausibility was checked by direct source inspection.
- Git metadata is not present in this workspace, so diff/status verification used direct file inspection rather than `git diff`.

### Visual Impact

None. Backend-only observation persistence sequence fix; no frontend source files, routes, components, or rendered pixels changed.

## Full-Report Legacy Desired Import Identity-Label Skip

### Files Changed

- `packages/backend/src/gateway/container-runtime-observation-writer.service.ts`
- `.codex/skills/harness/docs/container-lifecycle-architecture/20260603T032521Z/implementation.md`

### Rationale

- New Docker labels are identity/discovery hints only. A valid `nyabase.container_id` means the snapshot belongs to the new desired-state model and must not be treated as a legacy full-spec source.
- Legacy desired-row import now filters to snapshots without a valid `nyabase.container_id` and with the required legacy desired labels (`owner_id`, `container_name`, `image_id`, and `server_id`) before calling the full-spec row builder.
- Legacy imported rows now always use deterministic `legacy-*` IDs, matching the migration/import path for old Docker-label containers without backend container IDs.

### Acceptance Criteria Mapping

1. Valid identity-labeled containers are filtered out before `toDesiredImportRow()`, so missing `ownerId`, `name`, or `imageId` from new identity-only labels no longer emits the legacy import warning.
2. Legacy containers without `nyabase.container_id` and with required old full-spec labels still reach `toDesiredImportRow()` and are inserted with `legacyContainerId(serverId, dockerId)`.
3. Observation persistence is unchanged: `persistStateReportNow()` still stores `containerId` from valid labels, plus `dockerId`, `status`, `stats`, `labels`, and `specGenerationSeen` as before.
4. Report persistence, report sequencing, quota/disk/remote-FS observation writes, and lifecycle hook enqueueing were not changed.
5. This implementation record documents changed files, rationale, risks, and visual impact.

### Risks

- Tests, builds, lint, typecheck, package-manager commands, dev servers, runtime DBs, and remote hosts were not touched because this developer dispatch forbids them.
- `ReadLints` is not available in this runtime, so edited files were checked by direct source inspection only.
- The workspace at `/root/nyabase` does not expose a `.git` repository, so git status/diff verification was unavailable.

### Visual Impact

None. Backend-only import filtering; no frontend source files, routes, components, or rendered pixels changed.
