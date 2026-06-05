# Implementation Record

Session: `test-deploy-local-agents/20260601T162323Z`
Role: developer
Restored during the `2026-06-02` local session.

This file was recreated after accidental deletion. Source was inspected only for the scoped XFS quota files named in the restoration dispatch. No tests, builds, servers, package installs, commits, or pushes were run during this restoration, and no source files were edited by this restoration.

## GPU Clock Metrics and Container GPU Memory

### Changed Files

- `packages/agent/src/gpu/gpu-monitor.ts`
- `packages/agent/src/docker/docker-client.ts`
- `packages/agent/src/app.ts`
- `packages/agent/src/commands/dispatcher.ts`
- `packages/common/src/protocol/rest.ts`
- `packages/backend/src/metrics/metrics.controller.ts`
- `packages/frontend/src/components/dashboard/metrics-charts.tsx`
- `packages/frontend/src/pages/container-detail-page.tsx`

### Summary

- Extended GPU stat collection to query `clocks.gr` from `nvidia-smi` and parse supported non-negative numeric values into optional `graphicsClockMHz`.
- Added emission of `nyabase_gpu_clock_graphics_mhz{server,gpu_index}` while preserving existing GPU metric names and labels.
- Added live per-container GPU memory attribution by mapping `nvidia-smi --query-compute-apps=pid,used_memory,gpu_uuid` process rows through `/proc/<pid>/cgroup` to Docker container IDs, accepting both full and short Docker IDs, and summing MiB by GPU UUID.
- Kept GPU-memory stats fail-soft: CPU-only agents, disabled GPU collection, missing `nvidia-smi`, missing process attribution, or unsupported memory values return `{}` instead of failing container stats.
- Added `DockerClient.fetchContainerStatsWithGpuMem()` so Docker stats remain focused on CPU/memory/network/block IO while an optional provider supplies GPU memory.
- Wired the GPU memory provider through agent state reports, metrics collection, and `fetchContainerStats` RPC handling.
- Added `graphicsClockMHz` to the shared `GpuMetrics` DTO and backend GPU metrics API response.
- Updated the backend GPU metrics endpoint to query the new clock series, include clock-only GPU indices in the merged index set, and return `emptySeries(step)` when no clock samples exist.
- Added frontend rendering for the GPU graphics clock chart and non-empty container detail GPU memory rows.

### Acceptance Criteria Mapping

- GPU AC 1: `GpuMonitor.getGpuStats()` queries `clocks.gr` and stores finite supported values as `graphicsClockMHz`.
- GPU AC 2: `GpuMonitor.buildMetrics()` emits `nyabase_gpu_clock_graphics_mhz` only for finite non-negative clock values.
- GPU AC 3: Existing util, memory, temperature, power, and per-process GPU memory metric names and labels remain unchanged.
- GPU AC 4: `GET /api/metrics/servers/:id/gpus` returns `graphicsClockMHz` for every GPU item and uses an empty series when samples are absent.
- GPU AC 5: Container stats `gpuMemUsedMiB` is keyed by GPU UUID and sums matching processes for the requested Docker ID.
- GPU AC 6: GPU memory collection failures fall back to `{}` and do not fail the stats RPC.
- GPU AC 7: CPU-only agents and non-GPU containers keep `gpuMemUsedMiB: {}` behavior.
- GPU AC 8: Frontend dashboard GPU charts include graphics clock, and container detail shows GPU memory only when non-empty.

### Notable Decisions

- Host GPU metrics continue using `gpu_index` to preserve the existing VictoriaMetrics label shape.
- Container GPU memory uses GPU UUID keys because process metrics already report `gpu_uuid` and UUIDs are stable when indices reorder.
- Container detail stats use live agent-side `nvidia-smi` attribution instead of querying VictoriaMetrics, avoiding ingestion lag for the `/stats` RPC.
- Unsupported NVIDIA values such as `N/A`, empty strings, non-finite numbers, negative numbers, and unknown/error strings are omitted rather than coerced to zero.

### Risks

- `clocks.gr` is NVIDIA-specific and depends on the installed driver supporting that query field.
- Process-to-container attribution depends on cgroup path formats; unsupported runtime/cgroup layouts can still produce `{}`.
- Frontend visual output changes on authenticated GPU dashboard and container detail views.

### Visual Impact

- `packages/frontend/src/components/dashboard/metrics-charts.tsx`: authenticated dashboard/server GPU metrics sections can render one additional chart per GPU, `graphicsClockMHz`, labeled as graphics clock in MHz.
- `packages/frontend/src/pages/container-detail-page.tsx`: container detail overview can render GPU memory rows when live stats contain non-empty `gpuMemUsedMiB`.

## XFS Project Quota Fail-Closed Enforcement

### Changed Files

- `packages/agent/src/quota/xfs-quota.ts`
- `packages/agent/src/commands/dispatcher.ts`
- `packages/agent/src/datadirs/data-dirs.ts`

### Summary

- Changed XFS quota operations that are required for enforcement to fail closed instead of logging warning-only success.
- Added project quota capability checks using `xfs_quota state -p`, requiring both accounting and enforcement to be active.
- Added command error formatting that includes executable, arguments, exit code, stdout, and stderr context for failed `xfs_quota` and `xfs_io` operations.
- Made user quota limit application verify the reported hard limit for the deterministic project ID after `limit -p`.
- Made local data disk application require XFS plus proven project quota accounting and enforcement before registering a quota-enabled source.
- Made local data-dir creation assign the created path to the user's XFS project before returning success.
- Made container creation assign local `createDirs` host paths and Docker graph-driver `upperDir` and `workDir` paths to the owner project before returning success.
- Made missing Docker writable-layer paths a clear error because quota cannot be enforced without those paths.
- Added path assignment verification using `xfs_io stat` project ID and project inheritance flags, plus quota report visibility for the expected project.
- Kept `removePathFromProject()` best-effort because it is compensation/cleanup and should not mask the original failure.
- Preserved the single-layer shared data-dir layout and remote-source `quotaEnabled=false` behavior.

### Acceptance Criteria Mapping

- XFS AC 1: `applyDataDisk` rejects non-XFS paths and rejects XFS mounts unless project quota accounting and enforcement are proven; `DataDirsManager.getDiskInfo()` reports `pquotaEnabled` from the registered source capability.
- XFS AC 2: `initProject()`, path assignment, quota state checks, and limit setting throw on required failures instead of silently passing.
- XFS AC 3: `setLimit()` applies the deterministic project limit and verifies the hard limit from `report -N -p -b -n`.
- XFS AC 4: `createDataDir` assigns the created local quota-enabled path to the user's project before acknowledgement.
- XFS AC 5: `createContainer` assigns local `createDirs` paths plus Docker `upperDir` and `workDir` to the owner project before success.
- XFS AC 6: If required path/project assignment fails, `createContainer` throws and existing compensation removes the created container and best-effort project entries.
- XFS AC 7: Same-owner sharing is preserved because data-dir paths remain `{source.root}/{dirName}` and are shared host paths mounted by multiple containers.
- XFS AC 8: Live below-limit/above-limit enforcement still requires deployment verification on an XFS mount with project quota enabled; implementation now fails closed when enforcement cannot be proven.

### Notable Decisions

- Project IDs remain deterministic: `projectId = numericUserId + 10000`.
- The implementation rejects quota-backed container creation when Docker writable-layer paths are unavailable, because allowing success would permit unbounded writes.
- Remote filesystem sources remain outside XFS project quota enforcement.
- Cleanup of `/etc/projects` entries stays best-effort, while setup and verification paths throw.

### Risks

- Hosts that are XFS but mounted without project quota enforcement now fail disk registration or quota-backed container/data-dir operations.
- Docker storage-driver behavior can vary; drivers that do not expose assignable writable-layer paths need a separate design.
- Existing backend quota sync behavior may still be operationally asynchronous; this implementation makes the agent-side enforcement operation stricter but does not add a new durable quota status model.
- Live enforcement of below-limit and above-limit writes was not re-run in this restoration dispatch.

### Visual Impact

None from the XFS quota fix. It touches agent-side quota, data-dir, and command-dispatch logic only.

## Source Inspection During Restoration

- Inspected `packages/agent/src/quota/xfs-quota.ts`, `packages/agent/src/commands/dispatcher.ts`, and `packages/agent/src/datadirs/data-dirs.ts` for obvious syntax/import issues.
- No clear syntax/import issue was found, so no source was changed during restoration.

## GPU Process Typing Follow-up

### Changed Files

- `packages/agent/src/gpu/gpu-monitor.ts`

### Summary

- Reworked `GpuMonitor.getGpuProcesses()` so the nullable process rows are awaited into a local `Array<GpuProcessInfo | null>` before filtering with the existing type predicate.
- Kept runtime behavior unchanged: invalid process rows still return `null` and are filtered out, while valid rows still include `pid`, `usedMemoryMiB`, `gpuUuid`, and the resolved `containerId`.

### Acceptance Criteria Mapping

- Follow-up AC 1: `getGpuProcesses()` returns a narrowed `GpuProcessInfo[]` after filtering nullable rows.
- Follow-up AC 2: Invalid rows are skipped and valid rows keep the same process fields.
- Follow-up AC 3: This section records the GPU typing follow-up.

### Risks

- None identified by inspection.

### Visual Impact

None. This changes agent-side TypeScript typing only.

## XFS Project Quota Mount Target Follow-up

### Changed Files

- `packages/agent/src/quota/xfs-quota.ts`

### Summary

- Added mount target resolution from `/proc/self/mountinfo` so quota commands that inspect filesystem-level state or reports use the containing mount point for a path.
- Changed `checkProjectQuotaEnforcement('/data/<subdir>')` to run `xfs_quota state -p` against the containing mount, such as `/data`, instead of the arbitrary subdirectory.
- Changed data-dir and container path assignment to keep the actual project path in `/etc/projects`, `project -s -p <actual-path>`, and `xfs_io stat <actual-path>`, while running `xfs_quota` state/report operations against the containing mount.
- Changed configured-manager operations such as project initialization, limit application, usage reports, and post-limit verification to resolve the configured path to its containing mount before invoking `xfs_quota`.
- Preserved fail-closed behavior for missing quota tools, disabled accounting/enforcement, failed command execution, project ID mismatch, missing inheritance flag, and missing project report rows.

### Acceptance Criteria Mapping

- Live follow-up AC 1: `checkProjectQuotaEnforcement('/data/<subdir>')` resolves `/data/<subdir>` through mountinfo and checks project quota state on the containing mount.
- Live follow-up AC 2: `addPathToProject()` still writes and verifies the actual project directory, while `state -p` and `report -N -p -b -n` use the containing mount target.
- Live follow-up AC 3: `setLimit()` still verifies the hard limit from the quota report after resolving the configured quota path to its containing mount.
- Live follow-up AC 4: Required quota operations still throw on missing tools, disabled pquota, command failures, project metadata mismatch, missing inheritance flag, or a missing report row.
- Live follow-up AC 5: This implementation record documents the live `/data/<subdir>` mount-target failure and follow-up fix.

### Notable Decisions

- The final `xfs_quota` target is now the containing mount for project setup as well, while the project path remains the actual directory in the `project -s -p` command.
- Mount resolution reads mountinfo at call time rather than caching so newly applied local data disks are handled without agent restart.

### Risks

- Existing unit tests that mock `fs.readFileSync` for `/etc/projects` may need mountinfo fixtures before they can exercise this path.
- Hosts with unusual bind mounts can resolve to the nearest visible mount target; live verification should confirm that target is accepted by `xfs_quota` on the deployment host.

### Visual Impact

None. This changes agent-side quota command targeting only.

## Dynamic Container Mount Post-Apply Verification

### Changed Files

- `packages/agent/src/commands/dispatcher.ts`

### Summary

- Added agent-side verification after dynamic container mount application.
- `applySingleMount()` now re-lists the running container's mount namespace after `mount-helper mount` and throws if the requested destination is absent or mounted from a different source.
- `reconcileContainerMounts()` now re-lists after mount-helper reconciliation and verifies every expected `{ hostPath, containerPath }` pair before returning success.
- Kept stopped or non-running container behavior unchanged: apply, reconcile, and remove still return without mount-helper operations when Docker reports no running PID.
- Kept removal behavior unchanged: `removeSingleMount()` still only invokes `mount-helper umount` for running containers and does not perform expected-mount verification.
- Verification errors include the operation, Docker ID, PID, expected source, destination, and actual source for mismatches so backend/API acknowledgements fail with actionable context.

### Acceptance Criteria Mapping

- NFS mount verification AC 1: `applySingleMount()` throws when the requested `containerPath` is absent after `mount-helper mount`.
- NFS mount verification AC 2: `applySingleMount()` throws when the requested `containerPath` is mounted from a different source.
- NFS mount verification AC 3: `reconcileContainerMounts()` throws when any expected mount remains absent or source-mismatched after reconciliation.
- NFS mount verification AC 4: Existing removal and no-running-container behavior is preserved by leaving early returns and `removeSingleMount()` semantics unchanged.
- NFS mount verification AC 5: Verification error messages include Docker ID, PID, source, destination, and actual source on mismatch.
- NFS mount verification AC 6: This implementation record documents the NFS container mount verification fix.

### Notable Decisions

- Verification uses the existing `mount-helper list` output and exact source-path comparison to avoid reporting success unless the requested host path is visible at the requested container path.
- `listContainerMounts()` remains fail-soft internally, but post-apply verification converts an empty or missing list result into an explicit mount verification failure for expected mounts.

### Risks

- If `mount-helper list` normalizes source paths differently than the requested host path, verification can now fail even when a semantically equivalent mount exists. Live testing should confirm the helper's list output source format.
- No tests or builds were run by dispatch instruction; verification is by inspection only in this developer pass.

### Visual Impact

None. This changes agent-side mount command handling only.

## NFS-Backed Dynamic Container Mount Source Verification Follow-up

### Changed Files

- `packages/agent/src/commands/dispatcher.ts`
- `packages/agent/src/fs/proc-mounts.ts`

### Summary

- Replaced direct non-exact source rejection with a shared async source verifier used by both `applySingleMount()` post-apply checks and `reconcileContainerMounts()`.
- Preserved exact source success when `mount-helper list` reports `actual.src === spec.hostPath`.
- For non-exact sources, the agent now resolves the expected host path, fresh-reads current host `/proc/mounts`, decodes proc mount escapes, finds the longest containing mountpoint on a path boundary, and appends the relative suffix to the containing NFS mount source.
- The live CPU NFS shape is now provable: expected `/mnt/nfs-live-.../rw-...` under host mount source `10.8.96.92:/srv/nfs-live-...` matches helper source `10.8.96.92:/srv/nfs-live-.../rw-...`.
- `reconcileContainerMounts()` now uses the same equivalence verifier before deciding to unmount/remount an existing destination, so an already equivalent NFS-backed mount is treated as satisfied.
- Verification errors still fail closed and now include Docker ID, PID, expected source, actual source, destination, and a proof-failure reason.
- Added a fresh `/proc/mounts` reader while preserving the existing cached reader for current observation callers.

### Acceptance Criteria Mapping

- AC 1: Missing expected destinations still fail verification with destination, Docker ID, PID, expected source, missing actual source, and proof-failure context.
- AC 2: Exact source matches return success before host path resolution or `/proc/mounts` proof logic.
- AC 3: Non-exact source verification resolves the expected host path, fresh-reads/parses `/proc/mounts`, uses longest containing mountpoint matching, appends the relative suffix, and requires exact equality with the helper source.
- AC 4: NFS subdirectory mounts are accepted when host NFS source plus relative suffix equals the helper-reported canonical source.
- AC 5: Missing host paths, realpath failures, absent containing mounts, non-NFS containing mounts, unprovable NFS source grammar, and different canonical NFS sources all fail closed.
- AC 6: `reconcileContainerMounts()` calls the same verifier before replacing an existing destination.
- AC 7: `applySingleMount()` and `reconcileContainerMounts()` await post-apply verification and keep actionable mismatch errors.
- AC 8: `readProcMountsCached()` remains unchanged for existing callers; mount verification uses new `readProcMountsFresh()` to bypass stale cache.
- AC 9: No REST, protocol, schema, backend, common, frontend, or mount-helper changes were introduced.
- AC 10: This implementation record documents files changed, acceptance mapping, risks, and visual impact.

### Notable Decisions

- Non-exact equivalence is restricted to host `/proc/mounts` entries with `nfs` or `nfs4` filesystem type and a source shaped like an NFS export. Local bind/source mismatches remain failures.
- Mountpoint containment uses decoded proc fields and path-boundary matching to avoid accepting sibling paths with a shared prefix.
- Host mountpoints are realpath-normalized when possible before containment checks, matching the required resolved expected host path behavior while falling back to the raw mountpoint if the mountpoint itself cannot be resolved.

### Risks

- The proof depends on `mount-helper list` and `/proc/mounts` using the same canonical NFS source string. If the helper reports a different but semantically equivalent NFS string, verification will still fail closed.
- Existing tests may need fixture updates for the new proof-failure details and focused coverage for the fresh `/proc/mounts` parser/verifier behavior.
- No tests, builds, installs, dev servers, Docker, SSH, or API mutations were run in this developer dispatch by instruction.

### Visual Impact

None. This changes agent-side mount verification logic only.

## Tests and Builds

None run during restoration, the GPU typing follow-up, this XFS mount-target follow-up, the NFS container mount verification fix, or the backend stale mount cleanup by instruction.

## Backend Stale Mount Cleanup on Container Delete

### Changed Files

- `packages/backend/src/containers/container-mounts.service.ts`
- `packages/backend/src/containers/containers.service.ts`

### Summary

- Added `ContainerMountsService.deleteAllForContainer(serverId, dockerId)` to delete persisted expected mount rows matching the exact container identity and return the affected row count, with `0` as a successful idempotent result.
- Updated `ContainersService.deleteContainer()` to run stale mount cleanup only after the agent `deleteContainer` RPC succeeds and before writing the delete audit entry.
- Kept cleanup database-only; no mount reconcile, unmount RPC, public REST/protocol, entity, schema, or DTO changes were introduced.

### Acceptance Criteria Mapping

- Backend cleanup AC 1: `deleteAllForContainer(serverId, dockerId)` deletes only rows matching the exact `{ serverId, dockerId }` filter and returns `result.affected ?? 0`.
- Backend cleanup AC 2: `deleteContainer()` still calls the agent `deleteContainer` RPC before mount cleanup.
- Backend cleanup AC 3: Because cleanup is sequenced after `rpcWithErrorMapping(...)`, a failed agent delete skips both mount cleanup and delete audit.
- Backend cleanup AC 4: On successful agent delete, mount cleanup runs before `AuditAction.DeleteContainer` is logged.
- Backend cleanup AC 5: No public REST, protocol, entity, schema, or DTO changes were made.

### Notable Decisions

- The cleanup method uses the TypeORM repository delete filter `{ serverId, dockerId }`, so it removes both local and remote rows for the deleted container while preserving rows for other servers, other containers, and nullable Docker IDs.
- The returned affected count is not used by `deleteContainer()` because zero deleted rows is an accepted success case.

### Risks

- No tests or builds were run by dispatch instruction; verification is by inspection only in this developer pass.

### Visual Impact

None. This is a backend-only cleanup change with no frontend-rendered output changes.
