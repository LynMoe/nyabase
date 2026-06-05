# Implementation Record

Session: `multi-user-redteam/20260602T035546Z`
Role: developer
Timestamp: `2026-06-02T04:45:52Z`

## Root Cause

`GET /api/metrics/servers/:id/users` checked that the requester could access the server, but then queried VictoriaMetrics user-scoped series for every `user_id` on that server. Normal users without `Capability.ViewMetricsAll` could therefore receive other users' metric labels, including numeric `nyabase_user_disk_used_bytes` labels.

The sibling `GET /api/metrics/servers/:id/containers` endpoint already applied a `user_id="<requesterId>"` selector unless the requester had `Capability.ViewMetricsAll`; the users endpoint did not.

## Files Changed

- `packages/backend/src/metrics/metrics.controller.ts`

## Behavior Before

- Any user with access to a server could call `/metrics/servers/:id/users`.
- The endpoint queried all `user_id` labels for container CPU, memory, GPU process memory, container I/O, container network, and user disk usage metrics on that server.
- The response included every non-empty/non-`__unknown__` `user_id` returned by VictoriaMetrics, even for normal users.

## Behavior After

- The existing server access check is unchanged and still runs before metrics are returned.
- Users with `Capability.ViewMetricsAll` retain the previous all-user metric query and response behavior.
- Normal users query user-scoped metrics with `user_id="<requesterId>"` added to each selector.
- Normal user responses build the user id set from the requester id only, preventing non-requester labels from appearing even if a backing metrics query unexpectedly returns extra labels.

## Acceptance Criteria Mapping

- AC #1: `userMetrics` now computes `viewAll` with `Capability.ViewMetricsAll`; without it, all container/user-scoped selectors include `user_id="<requesterId>"`.
- AC #2: Normal-user response ids are constrained to `new Set([user.id])`, excluding non-requester ids such as numeric disk quota labels.
- AC #3: `viewAll` users keep an empty owner filter and aggregate ids from all returned series, preserving all-user behavior.
- AC #4: `ensureAccess(user.id, serverId)` remains the first operation in the endpoint.
- AC #5: This record documents root cause, changed files, before/after behavior, and retest expectation.

## Notable Decisions

- Kept the endpoint shape unchanged.
- Applied both query-level filtering and response-level id restriction for normal users so the endpoint does not rely solely on the metrics backend selector behavior for isolation.
- Did not broaden changes to raw PromQL handling; that path is separately handled by the existing injection helper and was out of scope for this dispatch.

## Risks

- Normal users with no current samples will now still receive their own user entry with empty series; this is consistent with the requirement that normal users receive only their own `user.id` series.
- No build or test command was run by this developer dispatch per role constraints; tester/devops should run the focused metrics rerun and standard checks.

## Visual Impact

None. Backend-only metrics access-control change.

## Retest Expectation

Rerun the focused gamma metrics check against `GET /api/metrics/servers/:gpuId/users`. Gamma should receive only `69d7f149-356f-481d-a936-fe5b3aca5335` in `userMetricIds`; numeric labels such as `12`, `13`, `5`, `7`, and `8` should be absent. A user with `Capability.ViewMetricsAll` should still see all users for the same server.

## Data-Dir Delete In-Use Guard

Timestamp: `2026-06-02T05:38:57Z`

### Root Cause

`DataDirsService.deleteDir()` verified that the data-directory row existed, then immediately called the agent `deleteDataDir` RPC and removed the DB row. It did not check `container_mounts`, so a directory actively mounted by a running container could be deleted through the data-dir API.

### Files Changed

- `packages/backend/src/datadirs/datadirs.service.ts`
- `packages/backend/src/datadirs/datadirs.module.ts`

### Behavior After

- `deleteDir()` now checks for `ContainerMountEntity` rows matching the requested runtime `serverId`, `sourceKind`, `sourceId`, `userId`, and `dirName` before the agent delete RPC.
- Matching mount rows block deletion only when their `dockerId` resolves in `AgentGateway.stateCache` to a container with `status === 'running'`.
- Missing containers, null docker ids, and non-running container snapshots remain non-blocking, preserving stale-row and stopped-container cleanup behavior.

### Acceptance Criteria Mapping

- AC #1: Running local and remote mounts now throw `ConflictException` before the agent RPC or DB row deletion.
- AC #2: Unmounted dirs and dirs referenced only by missing/non-running mount rows still continue through the existing agent-first delete path.
- AC #3: The guard uses `ContainerMountEntity.serverId` as the runtime server discriminator and matches exact `sourceKind`, `sourceId`, `userId`, and `dirName`; this keeps remote data dirs with null `DataDirectoryEntity.serverId` scoped to the server where the mount is running.
- AC #4: Uses existing NestJS `ConflictException`, TypeORM repository injection, and the existing `AgentGateway.stateCache.getContainer()` running-state pattern.

### Notable Decisions

- Added `ContainerMountEntity` to `DataDirsModule` TypeORM feature injection instead of introducing a cross-service dependency from data dirs into containers.
- Kept the data-directory row lookup unchanged and scoped the new runtime in-use check to the mount rows because remote data-directory rows intentionally have no server id.

### Risks

- This is a state-cache guard, so it relies on current agent container status. Stale mount rows are intentionally ignored unless the matching container is currently reported running.
- No tests, builds, installs, or dev servers were run by this developer dispatch per role/task constraints.

### Visual Impact

None. Backend-only data-dir deletion guard.

### Retest Expectation

Rerun `NYABASE_MOUNT_STATE=/tmp/nyabase-mount-20260602t052140z-1f28fd/state.json pnpm exec vitest run test/multi-user-redteam-mount-sources.spec.ts --reporter=verbose`. The in-use delete attempt should return a conflict/bad-request class response and leave the agent directory and data-directory DB row intact; post-container cleanup delete should still succeed.

## Local XFS Mount Source Verification

Timestamp: `2026-06-02T06:09:41Z`

### Root Cause

`CommandDispatcher.verifyContainerMountSource()` treated every non-exact mount-helper source mismatch as a remote/NFS canonical-source proof. For local data dirs under an XFS data disk, mount-helper `list` can report the container bind source as the containing mount's backing device (for example `/dev/sdb`) instead of the subdirectory host path (for example `/data/<dir>`). That valid local runtime shape was rejected because `/data` is XFS, not NFS/NFS4.

### Files Changed

- `packages/agent/src/commands/dispatcher.ts`

### Behavior After

- Exact `actualSource === expectedHostPath` still succeeds before any filesystem proof.
- `ContainerMountSpec.sourceKind` is now passed into mount-source verification.
- Remote mounts continue through the existing strict NFS/NFS4 branch: the containing host mount must be NFS/NFS4, the mount source must be a provable NFS source, and the expected host path suffix must match the canonical NFS source reported by mount-helper.
- Local mounts now use a separate proof branch after exact mismatch. The containing host mount must be XFS, and mount-helper's actual source must match the containing mount's backing source, either exactly or by canonical absolute path realpath.
- Wrong local sources and local paths on non-XFS containing mounts remain rejected with proof-specific error messages.

### Acceptance Criteria Mapping

- AC #1: `verifyContainerMountSource()` still returns success immediately when `actualSource === expectedHostPath`.
- AC #2: The non-local branch preserves the previous NFS/NFS4 filesystem check, provable NFS source check, relative-suffix containment check, and canonical source comparison.
- AC #3: Local specs whose expected host path resolves under an XFS mount such as `/data` now accept actual sources matching that mount's backing source such as `/dev/sdb`.
- AC #4: Local specs reject non-XFS containing mounts and reject actual sources that do not match the containing mount source or its canonical realpath.
- AC #5: Failure reasons now distinguish local non-XFS mounts, wrong local backing sources with canonical comparison details, NFS type failures, NFS source proof failures, and NFS canonical-source mismatches.

### Notable Decisions

- Kept the source-kind branch inside the existing verification helper so `reconcileContainerMounts` and `applySingleMount` share identical proof behavior.
- Added canonical realpath matching only for absolute local source paths. Non-path local sources still require exact equality, avoiding broad string heuristics.
- Did not alter mount-helper execution or backend mount spec shapes.

### Risks

- No tests, builds, installs, dev servers, or lint commands were run by this developer dispatch per role/task constraints.
- The local branch intentionally accepts a bind-mounted subdirectory being reported as the containing XFS mount's backing device. It does not prove the subdirectory suffix in that mount-helper output because the helper does not expose it in the observed local runtime shape.

### Visual Impact

None. Agent runtime-only mount verification change; no frontend routes or components can render differently from this patch.

### Retest Expectation

Rerun the focused mount-source runtime matrix. The alpha local container create with a granted local data dir under XFS should return `201`/`200` instead of `500`, and wrong-source/non-XFS local mismatch cases should still fail during agent mount verification.
