# Multi-User Red-Team Continuation Implementation

Session: `multi-user-redteam-continuation/20260603T143528Z`
Role: developer

## Root Cause

The current source-level public REST schema and backend dispatch shape have already moved to `sshServerEnabled`, and `zCreateContainerPayload` strips legacy `sshUser`/`sshUid`/`sshPubKeys` fields. The live GPU create failure matches stale agent build output still using the old create path: it destructures legacy SSH fields, uses `sshUid` for data-dir ownership, passes legacy SSH fields into Docker create, and injects SSH keys during create.

The source fix makes the agent dispatcher create-path contract explicit: create payload parsing accepts the current `sshServerEnabled` payload and normalizes the default before execution. The create handler remains typed to `CreateContainerPayload`, so legacy SSH fields cannot be required by source code.

## Files Changed

- `packages/agent/src/commands/dispatcher.ts`

## Behavior Before

- Backend dispatched `createContainer` with `sshServerEnabled`.
- Common source schema accepted that shape and stripped legacy SSH fields.
- Live deployed agent behavior still rejected/used legacy `sshUser`/`sshUid`/`sshPubKeys`, indicating stale build output rather than current source behavior.

## Behavior After

- Agent-side create command parsing explicitly returns the current `CreateContainerPayload` shape with `sshServerEnabled` defaulted to `false`.
- `handleCreateContainer` consumes `CreateContainerPayload` directly and does not require or use legacy SSH fields.
- Create remains responsible for Docker container creation and quota setup only. SSH key reconciliation remains in the `reconcileContainerSsh` command path.
- Backend public REST shape is unchanged: clients use `sshServerEnabled`; legacy request fields are not reintroduced.

## Acceptance Criteria Mapping

1. Covered: agent create payload parsing accepts current `sshServerEnabled` shape without legacy SSH fields.
2. Covered: SSH-disabled defaults to `false`; SSH-enabled create records desired state through `sshServerEnabled`, while key reconciliation remains separate.
3. Covered: no backend REST schema changes.
4. Covered: no state-report parsing, Docker label constants, or legacy label parsing changes.
5. Covered: this record documents cause, files, before/after behavior, risks, and retest expectation.

## Risks

- The live failure will persist until the agent is rebuilt/redeployed from current source. Existing `packages/agent/dist/**` in this workspace still contains the old legacy SSH create implementation, but build output is outside this developer dispatch and was not edited.
- I did not run tests, builds, or services per role restrictions.

## Retest Commands Expected

- Devops: rebuild common/agent artifacts from source and redeploy/restart the GPU agent.
- Tester: rerun the focused `test/multi-user-redteam-continuation.spec.ts` gamma GPU create case using the current REST payload with `sshServerEnabled`.
- Later DoD: run `scripts/check.sh`, including the common-src artifact guard.

## Visual Impact

None. Backend/agent protocol logic only; no frontend rendered output changes.

---

## Second Root Cause: Direct Backend Create Dispatch

The focused live CPU create failure returned `Agent error: Direct command createContainer is disabled; lifecycle commands must use agentCommand`. Current source already enqueues container create through `OperationsService.dispatchAgentCommand`, but stale generated backend output under `packages/backend/dist/containers/containers.service.js` still contains the old immediate `agentGateway.rpc(server.id, 'createContainer', ...)` path. That direct message reaches the current agent dispatcher, which correctly rejects lifecycle commands unless they arrive as an `agentCommand` envelope.

This indicates the live backend/runtime is still serving stale build output or an older direct-dispatch artifact, not the current durable source path. The source fix hardens the backend gateway so future direct lifecycle calls cannot pass through the generic RPC escape hatch, while the outbox worker continues to send durable `agentCommand` envelopes.

## Files Changed In This Dispatch

- `packages/backend/src/gateway/agent-gateway.ts`
- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`
- `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/implementation.md`

## Behavior Before This Dispatch

- `packages/backend/src/containers/containers.service.ts` queued `OperationKind.ContainerCreate` with `commandKind: 'createContainer'` via `dispatchAgentCommand`.
- `AgentCommandOutboxWorkerService` sent queued commands through `AgentGateway.sendCommandEnvelope`, which uses `kind: 'agentCommand'` and durable correlation fields.
- `AgentGateway.rpc` still accepted arbitrary backend-to-agent kinds, so any stale or future source path could send `createContainer` directly.
- Stale `packages/backend/dist/**` output still showed the pre-durable direct `createContainer` RPC implementation.

## Behavior After This Dispatch

- `AgentGateway.rpc` rejects durable/lifecycle command kinds, including `createContainer`, `startContainer`, `stopContainer`, `restartContainer`, `deleteContainer`, data-dir/disk/mount/quota reconcile commands, and `pullImage`.
- Allowed direct commands such as `checkDisk`, `selfCheck`, `reconcileDockerDaemon`, `fetchContainerStats`, and `execStream` remain available through `AgentGateway.rpc`.
- `AgentCommandOutboxWorkerService.toEnvelope` explicitly constructs an `AgentCommandEnvelope` with `operationId`, `commandId`, `commandKind`, `idempotencyKey`, `resourceKey`, `desiredGeneration`, and `payload` before calling `sendCommandEnvelope`.
- Container create success semantics remain in `OperationOrchestratorService.applyContainerCreateSuccess`: `dockerId`/IP update, expected mounts task, SSH enablement task, and quota desired state are unchanged.

## Acceptance Criteria Mapping For This Dispatch

1. Covered: queued `OperationKind.ContainerCreate` / `commandKind: 'createContainer'` is sent by the outbox worker as an `agentCommand` envelope with durable correlation fields.
2. Covered: direct lifecycle/durable command kinds are blocked at the backend gateway; intentionally direct utility commands remain unchanged.
3. Covered: create completion handling for `dockerId`, mounts, SSH enablement, and quota desired state was not changed.
4. Covered: fix is scoped to backend gateway/outbox dispatch boundaries and follows the existing operations pattern.
5. Covered: this section records the second root cause, changed files, before/after behavior, risks, and retest/deploy expectation.

## Risks For This Dispatch

- The live failure will persist until devops rebuilds/redeploys backend output from current source; stale `packages/backend/dist/**` was observed but not edited because generated output is outside this developer dispatch.
- I did not run tests, builds, services, or deployment commands per role restrictions.
- If there is another runtime-only direct dispatch outside current source, the source guard will catch it after rebuild with a backend-side error instead of an agent-side rejection; devops should still ensure stale output is replaced.

## Retest Expectation For This Dispatch

- Devops: rebuild backend artifacts from source, redeploy/restart the backend, and confirm no stale direct `agentGateway.rpc(..., 'createContainer', ...)` remains in served output.
- Tester: rerun focused continuation prefix scope starting with first alpha CPU create. Expected create response is an operation reference (`ok: true`, `operationId`, queued/running status), followed by operation success after agent completion rather than a 502 direct-command rejection.
- Later DoD: run `scripts/check.sh`, including the common-src artifact guard.

---

## Third Root Cause: Missing DataDirsModule Repository Registration

Backend startup after the rebuild failed because `DataDirsService` injects `@InjectRepository(ContainerRuntimeObservationEntity)` as constructor dependency index `[3]`, but `DataDirsModule` did not register `ContainerRuntimeObservationEntity` in `TypeOrmModule.forFeature`. Nest therefore could not provide `ContainerRuntimeObservationEntityRepository` in the `DataDirsModule` context.

## Files Changed In This Dispatch

- `packages/backend/src/datadirs/datadirs.module.ts`
- `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/implementation.md`

## Behavior Before This Dispatch

- `DataDirsService` requested repositories for data directories, data disks, container mounts, container runtime observations, remote FS mounts, and remote FS assignments.
- `DataDirsModule` registered all of those entity repositories except `ContainerRuntimeObservationEntity`.
- Rebuilt backend startup failed during Nest dependency resolution for `DataDirsService`.

## Behavior After This Dispatch

- `DataDirsModule` imports `ContainerRuntimeObservationEntity`.
- `TypeOrmModule.forFeature` registers `ContainerRuntimeObservationEntity` alongside the existing data-dir, disk, mount, assignment, and runtime observation entities.
- `DataDirsService` can resolve its `observationsRepo` dependency from the module-local TypeORM providers.

## Acceptance Criteria Mapping For This Dispatch

1. Covered: `DataDirsModule` imports and registers `ContainerRuntimeObservationEntity` in `TypeOrmModule.forFeature`.
2. Covered: no unrelated module/provider changes were made.
3. Covered: this section records the startup blocker, changed files, behavior after, risks, and retest expectation.

## Risks For This Dispatch

- I did not run builds, tests, services, or restart commands per role restrictions.
- This only fixes the observed missing repository provider; devops restart may expose another independent startup blocker.

## Retest Expectation For This Dispatch

- Devops: rebuild backend artifacts from source and restart the backend. Expected result: Nest no longer fails to resolve `ContainerRuntimeObservationEntityRepository` for `DataDirsService` in `DataDirsModule`.
- Tester/devops: continue the focused backend startup and red-team continuation retest from the prior failure point.

---

## Fourth Root Cause: Duplicate Explicit GPU Indices Were Not Rejected

Focused live testing found that gamma, whose grant allowed `gpuIndices: [0]`, could create a container with explicit request `gpuIndices: [0, 0]`. The service GPU resolver only checked whether every requested index was in the allowed set, so duplicates passed the grant check and were persisted/dispatched as a two-entry GPU assignment. The shared pure policy helper had the same behavior.

## Files Changed In This Dispatch

- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/containers/resource-quota.policy.ts`
- `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/implementation.md`

## Behavior Before This Dispatch

- Explicit duplicate GPU index arrays such as `[0, 0]` were treated as valid if each element was otherwise permitted.
- In `GpuGrantMode.Indices`, a user granted index `0` could request `[0, 0]` and reach container desired-state persistence and agent dispatch.
- The pure policy helper mirrored the same duplicate-accepting behavior.

## Behavior After This Dispatch

- Both GPU resolvers reject explicit duplicate `gpuIndices` arrays before the grant-mode switch.
- The rejection uses `BadRequestException('Duplicate GPU indices requested')` because the request body is internally invalid, independent of whether the actor has GPU access or whether capacity is available.
- Valid explicit unique indices remain subject to the existing grant checks.
- `gpuCount` auto-pick behavior is unchanged because the duplicate check only applies when the client supplies `gpuIndices`.

## Acceptance Criteria Mapping For This Dispatch

1. Covered: duplicate explicit `gpuIndices` arrays are rejected before desired-state persistence or agent dispatch for all grant modes.
2. Covered: unique explicit indices continue through existing `All` and `Indices` validation.
3. Covered: `gpuCount` auto-pick paths are untouched.
4. Covered: duplicate explicit indices use `BadRequestException` as malformed request input; existing forbidden/capacity messages are unchanged.
5. Covered: this section records the fourth root cause and focused retest expectation.

## Risks For This Dispatch

- I did not run builds, tests, services, or restart commands per role restrictions.
- Existing duplicate desired-state rows, if any were created by live negative-case success, are not cleaned by this source fix. Devops should residual-scan the `murtc-20260603t151358z-d62df3` prefix as the tester warned.

## Retest Expectation For This Dispatch

- Devops: rebuild backend artifacts from source and restart the backend.
- Tester: rerun the gamma minimal reproducer `POST /api/containers` with `gpuIndices: [0, 0]` under prefix `murtc-20260603t151358z-d62df3`. Expected result: `400 Bad Request` with no container desired row, operation, agent dispatch, Docker container, or runtime residual for the rejected request.
- Tester: rerun at least one valid gamma explicit unique request such as `gpuIndices: [0]` and one `gpuCount=1` auto-pick case to confirm valid explicit and auto-pick behavior remain accepted when otherwise permitted.

---

## Fifth Root Cause: Empty GPU Indices Masked Positive GPU Count

Focused live testing under prefix `murtc-20260603t152020z-1f46a9` found that gamma, whose grant allowed only `gpuIndices: [0]`, could create a container with request body containing `gpuIndices: []` and `gpuCount: 2`. Both the service resolver and the shared policy helper computed `requestedGpuCount` from `req.gpuIndices?.length ?? req.gpuCount ?? 0`, so an explicit empty array was treated as a zero-GPU explicit-index request and masked the positive count fallback.

The same normalization gap made mixed request intent unclear. A non-empty explicit `gpuIndices` array plus a positive `gpuCount` now fails fast as an ambiguous request instead of letting one field silently win.

## Files Changed In This Dispatch

- `packages/backend/src/containers/containers.service.ts`
- `packages/backend/src/containers/resource-quota.policy.ts`
- `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/implementation.md`

## Behavior Before This Dispatch

- `gpuIndices: []` caused `requestedGpuCount` to become `0`, even when `gpuCount` was positive.
- `{ gpuIndices: [], gpuCount: 2 }` skipped the over-count validation path and could reach desired-state persistence and agent dispatch.
- A non-empty explicit index request combined with positive `gpuCount` was not rejected as ambiguous; the explicit index array implicitly won.
- The shared policy helper mirrored the service behavior.

## Behavior After This Dispatch

- Empty `gpuIndices: []` is normalized as no explicit GPU-index request.
- `{ gpuIndices: [], gpuCount: 2 }` is treated as a count request for two GPUs and is rejected when only one permitted/free GPU is available.
- `{ gpuIndices: [] }` alone remains a no-GPU request.
- Non-empty explicit `gpuIndices` arrays still reject duplicates before grant-mode checks.
- Non-empty explicit `gpuIndices` plus positive `gpuCount` now returns `400 Bad Request` with `Specify either gpuIndices or gpuCount, not both`.
- Valid `gpuCount: 1` auto-pick requests and valid unique explicit requests such as `gpuIndices: [0]` remain accepted when otherwise permitted and available.
- `ContainersService.resolveGpuIndicesFromDesired` and `resource-quota.policy.resolveGpuIndices` use the same normalization rules.

## Acceptance Criteria Mapping For This Dispatch

1. Covered: empty explicit `gpuIndices` no longer masks positive `gpuCount`; over-count goes through count validation.
2. Covered: empty `gpuIndices` without a positive `gpuCount` resolves to no GPU request.
3. Covered: duplicate non-empty explicit indices remain rejected.
4. Covered: non-empty explicit indices plus positive `gpuCount` is rejected as ambiguous; no contrary documented behavior was found in the active design.
5. Covered: valid `gpuCount=1` and valid unique explicit `gpuIndices=[0]` remain on their existing success paths.
6. Covered: shared policy helper and service resolver were updated consistently.
7. Covered: this section records the fifth root cause, retest expectation, and residual scan need for `murtc-20260603t152020z-1f46a9`.

## Risks For This Dispatch

- I did not run builds, tests, services, or restart commands per role restrictions.
- Clients that previously sent both non-empty `gpuIndices` and positive `gpuCount` must now choose one request mode. This is intentional because mixed intent is ambiguous.
- Existing unintended rows or runtime artifacts from the live negative-case success are not cleaned by this source fix.

## Retest Expectation For This Dispatch

- Devops: rebuild backend artifacts from source and restart the backend.
- Tester: rerun the gamma minimal reproducer under prefix `murtc-20260603t152020z-1f46a9` with `{ gpuIndices: [], gpuCount: 2 }`. Expected result: rejection before desired-state persistence, operation dispatch, or runtime mutation because gamma has only one permitted GPU index.
- Tester: rerun `{ gpuIndices: [] }` alone and confirm it remains a no-GPU request.
- Tester: rerun duplicate explicit `gpuIndices: [0, 0]` and confirm it remains rejected.
- Tester: rerun mixed non-empty `gpuIndices: [0]` with positive `gpuCount: 1` or `2` and confirm `400 Bad Request` for ambiguous GPU request intent.
- Tester: rerun valid gamma `gpuCount: 1` and valid explicit `gpuIndices: [0]` and confirm both still work when otherwise permitted and available.
- Devops/tester: residual-scan `murtc-20260603t152020z-1f46a9` for any product rows, operations, agent dispatches, Docker containers, or host/runtime artifacts created by the prior unexpected `201`.

---

## Sixth Root Cause: Concurrent SQLite Transactions Corrupted TypeORM Savepoints

Focused live testing under prefix `murtc-20260603t152826z-3e786d` showed repeated backend errors while handling agent `operationProgress` and while the outbox worker interval was running: `SqliteError: no such savepoint: typeorm_N`. The backend uses the `better-sqlite3` TypeORM driver in this environment, which is a single-connection SQLite driver. TypeORM represents overlapping `dataSource.transaction(...)` calls on that one connection as nested savepoints. Independent async WebSocket handlers and lifecycle workers can interleave transaction starts/commits/rollbacks, causing one handler to release or roll back a savepoint level another handler expects.

When the terminal create/delete progress transaction fails this way, the agent may already have completed the Docker operation, but durable rows and read-model updates do not converge. That matches the observed stale API rows with `status=unknown`, empty `spec.dockerId`, and delete cleanup that did not persist.

## Files Changed In This Dispatch

- `packages/backend/src/database/serialized-transaction.ts`
- `packages/backend/src/operations/operation-orchestrator.service.ts`
- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`
- `packages/backend/src/operations/resource-lock.service.ts`
- `packages/backend/src/operations/reconcile-task-worker.service.ts`
- `packages/backend/src/operations/operations.service.ts`
- `packages/backend/src/gateway/container-runtime-observation-writer.service.ts`
- `packages/backend/src/containers/container-mounts.service.ts`
- `packages/backend/src/users/users.service.ts`
- `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/implementation.md`

## Behavior Before This Dispatch

- Backend lifecycle code called `dataSource.transaction(...)` directly from operation progress handling, outbox leasing, mark-sent/mark-succeeded/mark-failed, retry release, resource locks, reconcile worker task claiming, runtime observation persistence, mount updates, and user creation.
- Under SQLite, those independent async calls could overlap on TypeORM's single SQLite connection and conflict through generated savepoints such as `typeorm_181`.
- A failed terminal progress transaction prevented `OperationOrchestratorService.applyContainerCreateSuccess` from persisting `dockerId`/status or `applyContainerDeleteSuccess` from deleting/converging durable rows, leaving API-visible stale/unknown state after successful agent work.

## Behavior After This Dispatch

- Added `runSerializedTransaction`, a backend database helper that preserves normal `dataSource.transaction(...)` behavior for non-SQLite drivers and serializes transaction callbacks for `sqlite` / `better-sqlite3`.
- Routed all non-test backend source `dataSource.transaction(...)` sites through the helper, closing the single-connection SQLite savepoint race across lifecycle progress, outbox worker work, resource locks, reconcile work, runtime observation writes, mount mutations, and user creation.
- Durable `agentCommand` envelope dispatch is unchanged: outbox worker still leases a command, marks it sent, sends `AgentGateway.sendCommandEnvelope(...)`, and terminal progress/synchronous completion still reaches `OperationOrchestratorService` domain success/failure handling.
- The earlier gateway guard against direct lifecycle RPCs remains unchanged; this dispatch does not reintroduce direct create/delete RPC paths.

## Acceptance Criteria Mapping For This Dispatch

1. Covered: operation progress handling now enters TypeORM transactions through the SQLite serializer, so concurrent progress/outbox work no longer nests conflicting SQLite savepoints.
2. Covered: outbox interval lease/retry/send/success/failure transaction paths and resource-lock acquisition now use the same serializer.
3. Covered: successful create/delete terminal handling still runs the existing domain success/failure code, but its transaction is no longer vulnerable to concurrent SQLite savepoint corruption; create can persist `dockerId`/active state and delete can remove/converge rows.
4. Covered: durable `agentCommand` envelope construction/dispatch and the gateway direct-lifecycle guard were not changed.
5. Covered: this section records root cause, changed files, behavior before/after, acceptance mapping, risks, and retest expectation.

## Risks For This Dispatch

- SQLite transaction throughput is intentionally serialized. This matches the driver limitation and should be acceptable for the current single-backend control-plane workload, but high write bursts may queue rather than overlap.
- The helper is process-local. Multiple backend processes against the same SQLite database would still require a broader deployment/database strategy; the current live failure is within one backend process.
- I did not run builds, tests, services, or deployment commands per role restrictions. I performed read-only source scans only.

## Retest Expectation For This Dispatch

- Devops: rebuild backend artifacts from source and restart the backend.
- Tester: rerun the focused continuation create/delete workload that failed under prefix `murtc-20260603t152826z-3e786d`, especially epsilon's tiny CPU/disk-runtime create after CPU/GPU quota cases.
- Expected result: backend logs no longer show `no such savepoint: typeorm_N` from `AgentGateway` operation progress handling or `AgentCommandOutboxWorkerService`; create rows reach non-empty `spec.dockerId` and active/running state after agent success; delete cleanup converges or removes API-visible rows instead of resurrecting stale unknown rows.
- Later DoD: run `scripts/check.sh`, including the common-src artifact guard.

## Visual Impact

None. Backend transaction/control-plane logic only; no frontend rendered output changes.

---

## Seventh Root Cause: Deleted Tombstone Rows Remained User-Visible

Focused live testing under prefix `murtc-20260603t160243z-2adeda` proved the disk-runtime Docker delete and durable outbox command both succeeded for docker id `7a9f8ea8b6d2`, but the durable `containers` table still retained a deleted/stopped row. `ContainersService.listContainers()` mapped every durable read-model row into user-facing API output, and `assertOwnerOrManageAny()` authorized owner GET/actions through `getContainer()` without filtering terminal tombstone lifecycle state. As a result, a successfully deleted container could remain retrievable to its owning user until some later external cleanup or owner deletion hid it.

## Files Changed In This Dispatch

- `packages/backend/src/containers/containers.service.ts`
- `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/implementation.md`

## Behavior Before This Dispatch

- Owner/user `GET /api/containers/:serverId/:dockerId` treated a durable row with `lifecyclePhase=deleted`, `powerIntent=stopped`, and `deletedAt` set as a retrievable container DTO.
- Owner/user list views included deleted/deleting/tombstone desired rows because list mapping did not distinguish user-visible containers from durable diagnostic rows.
- Admin/manager list and GET used the same durable rows, but that diagnostic visibility was implicit rather than scoped away from regular user views.

## Behavior After This Dispatch

- Added a user-visible container predicate in `ContainersService` that hides desired rows with `deletedAt` set, `lifecyclePhase=deleting`, or `lifecyclePhase=deleted`.
- Regular owner/user list views exclude those tombstones, including durable rows left behind after successful Docker delete.
- Regular owner/user GET and action authorization now load the read-model view directly and return `404 Container not found` for hidden tombstones before any usable container DTO/action path is reached.
- Admin/manager diagnostics are preserved: users with `ManageContainersAny` still bypass the owner visibility predicate for broad list and GET/action authorization. `ownOnly=true` remains user-scoped and hides tombstones.
- Delete operation dispatch and completion are unchanged: `deleteContainer` still queues durable `agentCommand` outbox work, and `OperationOrchestratorService.applyContainerDeleteSuccess` still marks the durable row `deleted`/`stopped` without requiring physical DB deletion.

## Acceptance Criteria Mapping For This Dispatch

1. Covered: after delete success marks a row deleted/stopped, owner/user GET returns `404` via authorization and list excludes the row.
2. Covered: durable tombstone rows with `deletedAt`, `deleting`, or `deleted` state are hidden from user-facing views without physical deletion.
3. Covered: manager/admin broad diagnostics retain tombstone access; `ownOnly=true` is explicitly user-scoped and hides tombstones.
4. Covered: no delete dispatch/orchestrator changes were made; durable `agentCommand` workflow remains intact and no direct lifecycle RPC was introduced.
5. Covered: this section records root cause, changed files, before/after behavior, AC mapping, risks, and retest expectation.

## Risks For This Dispatch

- During an in-flight delete, regular users will no longer see the container once the request has marked `deletedAt`/`deleting`; if the delete later fails, the existing failure handler clears `deletedAt` and returns the row to active visibility.
- Admins can still see/action tombstones through broad manager paths. This preserves cleanup/diagnostics, but future UI/API design may want an explicit `includeDeleted` query parameter instead of capability-based behavior.
- I did not run builds, tests, services, or deployment commands per role restrictions. I performed read-only source inspection only.

## Retest Expectation For This Dispatch

- Devops: rebuild backend artifacts from source and restart the backend.
- Tester: rerun the focused continuation cleanup convergence for prefix shape like `murtc-20260603t160243z-2adeda`. After `DELETE /api/containers/:serverId/:dockerId` succeeds and the durable row is marked `deleted`/`stopped`, the owning user's repeated `GET /api/containers/:serverId/:dockerId` should converge to `404` promptly and `GET /api/containers?serverId=...&ownOnly=true` should exclude that docker id even if the durable DB row remains.
- Later DoD: run `scripts/check.sh`, including the common-src artifact guard.

## Visual Impact

None. Backend API/read-model visibility logic only; no frontend rendered output changes.

---

## Eighth Root Cause: Delete-In-Progress Rows Still Consumed Create Quota

Focused live testing under prefix `murtc-20260603t162119z-4e5b35` passed B6 quota boundaries and delete visibility convergence, then failed entering B9 because alpha's tiny replacement create returned `400 CPU quota exceeded`. Devops exact-prefix diagnosis showed B9 began while alpha's B6 delete operations were still completing. The service quota aggregators excluded only `lifecyclePhase=deleted`, so rows already marked `deleting` with `deletedAt` set still consumed alpha's full CPU/memory/GPU reservations even though the same rows were no longer user-visible or usable after delete was requested.

## Files Changed In This Dispatch

- `packages/backend/src/containers/resource-quota.policy.ts`
- `packages/backend/src/containers/containers.service.ts`
- `.codex/skills/harness/docs/multi-user-redteam-continuation/20260603T143528Z/implementation.md`

## Behavior Before This Dispatch

- CPU and memory quota usage queried desired containers for the user/server and excluded only `ContainerLifecyclePhase.Deleted`.
- GPU free-index accounting queried server containers and excluded only `ContainerLifecyclePhase.Deleted`.
- Containers already delete-requested (`lifecyclePhase=deleting`, `deletedAt` set) were hidden from regular user views but still blocked new creates until final delete completion marked them `deleted`.
- Active, creating, and updating desired rows counted, as intended.

## Behavior After This Dispatch

- Added shared quota lifecycle policy exports in `resource-quota.policy.ts`: `QUOTA_EXCLUDED_LIFECYCLE_PHASES` and `shouldCountContainerForQuota(...)`.
- CPU/memory desired usage now filters out rows with `deletedAt IS NOT NULL`, `lifecyclePhase=deleting`, or `lifecyclePhase=deleted`.
- GPU used-index accounting uses the same excluded lifecycle phase list and tombstone filter, so delete-requested GPU rows no longer make indices unavailable for replacement creates.
- Active, creating, updating, and failed rows with no `deletedAt` still count against CPU/memory/GPU availability; users cannot oversubscribe live or pending creates.
- Delete workflow was not changed: `deleteContainer` still queues durable `agentCommand` outbox work and no direct lifecycle RPC was introduced.

## Acceptance Criteria Mapping For This Dispatch

1. Covered: CPU/memory/GPU quota availability excludes delete-in-progress states via `deletedAt IS NULL` plus `NOT IN (deleting, deleted)`.
2. Covered: active/running-equivalent desired rows, including `creating` and other non-delete phases, still count.
3. Covered: the service query and shared pure quota policy now use the same exported excluded lifecycle phase list, and the helper documents the pure predicate for tests/other callers.
4. Covered: delete operation workflow was not touched and remains durable `agentCommand` dispatch only.
5. Covered: this section records root cause, files changed, before/after behavior, AC mapping, risks, and retest expectation.

## Risks For This Dispatch

- A create immediately after delete request may be accepted while runtime deletion is still completing. This matches user-facing delete visibility and replacement semantics, but runtime/agent capacity still depends on the delete command completing successfully.
- `failed` desired rows continue to count unless they are explicitly deleted. That is conservative for quota safety and keeps this change scoped to delete-requested/tombstone semantics.
- I did not run builds, tests, services, or deployment commands per role restrictions. I performed read-only source inspection only.

## Retest Expectation For This Dispatch

- Devops: rebuild backend artifacts from source and restart the backend.
- Tester: rerun the focused continuation under a fresh prefix. Expected result: after B6 cleanup marks alpha rows deleting/tombstoned, B9 alpha `b9-alpha` create with `cpuMillis: 1` is accepted instead of failing with `CPU quota exceeded`; B6 active/exact quota denials still hold before delete; GPU over-count and duplicate boundaries remain unchanged.
- Later DoD: run `scripts/check.sh`, including the common-src artifact guard.

## Visual Impact

None. Backend quota accounting only; no frontend rendered output changes.
