# Control-plane architecture review

Verdict: **FAIL for release robustness/readiness** (report-only). The static redesign conformance check passes, but source review found major product/architecture defects in V2 container actions, mount/SSH reconciliation, quota/GPU policy wiring, and operation authorization.

Risk tier: high-risk + release. Scope reviewed: backend container controller/control/operation/orchestrator/outbox/runtime services, common REST/agent protocol/enums, agent dispatcher/docker paths, frontend container action/routes/hooks, and selected live tests/static conformance script.

## Evidence

- New V2 public identity exists: frontend route is `/containers/$containerId` (`packages/frontend/src/routes/containers/$containerId.tsx:4`) and backend controller is `@Controller('v2/containers')` (`packages/backend/src/containers/containers.controller.ts:28`).
- Agent durable command names are V2 runtime names (`packages/common/src/enums.ts:67-72`), and direct lifecycle commands are blocked by the agent dispatcher (`packages/agent/src/commands/dispatcher.ts:145-159`).
- Static conformance passed, including old route/command removal and common-source artifact guard.

## Findings

1. **product-bug / major — Update-mounts and SSH actions are not executable end-to-end and can leave lifecycle stuck.**
   - Backend action enqueue uses one generic payload for all actions: `{ containerId, runtimeId, action, force, body }` (`packages/backend/src/containers/container-control.service.ts:197-225`).
   - Agent schemas require `runtime.container.mounts.apply` payload `{ runtimeId, expected, toRemove? }` with `hostPath/userId/containerPath`, and `runtime.container.ssh.apply` payload `{ runtimeId, publicKeys, expectedKeyHash? }` (`packages/common/src/protocol/agent-messages.ts:441-464`).
   - The orchestrator only applies terminal domain success for create/start/stop/restart/delete; `container.update_mounts`, `container.enable_ssh`, and `container.reconcile_ssh` fall into no-op hook success and do not clear `container_lifecycle.active_operation_id` or restore `phase=active` (`packages/backend/src/operations/operation-orchestrator.service.ts:428-457`, `648-654`).
   - Frontend detail/action hook posts camelCase paths such as `/actions/enableSsh` and `/actions/reconcileSsh` (`packages/frontend/src/pages/container-detail-page.tsx:38`, `111`; `packages/frontend/src/hooks/use-container-actions.ts:37`), while backend routes are kebab-case `/actions/enable-ssh` and `/actions/reconcile-ssh` (`packages/backend/src/containers/containers.controller.ts:73-90`).

2. **product-bug + architecture risk / major — Create stores mount/SSH desired state but does not apply it to runtime.**
   - Create persists `mountsJson` and `sshEnabled` (`packages/backend/src/containers/container-control.service.ts:126-141`) and sends `createDirs`, but strips `containerPath` and never resolves/sends `hostPath` (`packages/backend/src/containers/container-control.service.ts:167-190`; common schema at `packages/common/src/protocol/agent-messages.ts:477-510`).
   - Agent create only creates/quota-registers dirs and starts Docker, then returns `runtimeId`; it does not call mount reconciliation or Dropbear SSH reconciliation (`packages/agent/src/commands/dispatcher.ts:426-478`).
   - `DockerClient.createContainer` accepts `sshServerEnabled` but does not use it in Docker options/labels (`packages/agent/src/docker/docker-client.ts:120-169`).

3. **product-bug + security risk / major — Update-mounts lacks access revalidation, host-path resolution, desired-spec update, and audit.**
   - Controller validates body shape then discards the parsed result and passes raw body to generic action (`packages/backend/src/containers/containers.controller.ts:73-80`).
   - Create-time mount access checks exist (`packages/backend/src/containers/container-control.service.ts:104-108`), but update-time checks are absent before enqueue (`packages/backend/src/containers/container-control.service.ts:197-225`).
   - Desired `mountsJson` generation is never updated on update-mounts; the view continues reading old desired rows (`packages/backend/src/containers/container-control.service.ts:303-305`).

4. **product-bug + stale architecture / major — GPU/quota policy is present but not wired into container create.**
   - REST schema and frontend support `gpuCount` (`packages/common/src/protocol/rest-schema.ts:159-160`; `packages/frontend/src/components/containers/create-container-dialog.tsx:102-114`), but create ignores it and only uses `request.gpuIndices ?? []` (`packages/backend/src/containers/container-control.service.ts:97-103`, `116`).
   - `resource-quota.policy.ts` implements `validateResourceQuota`/`resolveGpuIndices` (`packages/backend/src/containers/resource-quota.policy.ts:47-128`), but it is not imported by `ContainerControlService`; GPU inventory/capacity and duplicate indices are not enforced. `GpuAllocationEntity` is created (`packages/backend/src/containers/container-control.service.ts:152-159`) but no delete/release path was found.

5. **security architecture risk / major — Operation visibility is over-broad and returns raw command payloads, including possible secrets.**
   - `/operations/:operationId` allows any user with `ManageContainersAny` to read any operation, regardless of `resourceType` (`packages/backend/src/operations/operations.service.ts:104-114`).
   - Response includes raw `operation.request`, `operation.result`, and each command `payload` (`packages/backend/src/operations/operations.service.ts:127-176`).
   - Remote FS command payload includes mount params (`packages/backend/src/remote-fs/remote-fs-mounts.service.ts:299-320`), and CephFS params include a `secret` field (`packages/common/src/protocol/agent-messages.ts:196-207`).

6. **product-bug / medium — Failed/unbound/stale delete is advertised but cannot satisfy agent schema.**
   - Policy enables delete for failed or stale containers (`packages/backend/src/containers/container-action-policy.service.ts:45-55`).
   - Generic action payload sends `runtimeId: lifecycle.boundRuntimeId`, which may be `null` (`packages/backend/src/containers/container-control.service.ts:222`), while delete schema requires a string runtime id (`packages/common/src/protocol/agent-messages.ts:365-368`).

7. **test-bug / env-stale — Static conformance has blind spots and stale live tests remain.**
   - Conformance passed, but stale test paths still reference unsupported `/exec` and GET/PATCH update-mounts variants via template strings (`test/specs/live/multi-user-redteam-mount-sources.spec.ts:503-506`, `521`, `545`).
   - Backend currently exposes only `POST :containerId/actions/update-mounts` (`packages/backend/src/containers/containers.controller.ts:73-80`) and `POST :containerId/exec-sessions` that throws “not implemented” (`packages/backend/src/containers/containers.controller.ts:100-109`).

## Recommended fixes

- Replace generic `ContainerControlService.action` payload construction with typed handlers per action; build payloads that match common schemas, update desired specs/generations, and add terminal success/failure handlers for mount/SSH actions that clear lifecycle state.
- Add a mount-normalization service shared by create/update: validate mount-source grants every time, resolve server-bound `hostPath`, persist desired mounts, compute `toRemove`, and enqueue `RuntimeContainerMountsApply` only with schema-valid payloads.
- Model create as a multi-step operation (create runtime -> apply mounts -> apply SSH if desired -> mark active) or explicitly document/create only runtime and disable mount/SSH UI until post-hooks exist.
- Wire `resource-quota.policy.ts` into create, implement `gpuCount` auto-selection against runtime inventory/allocations, reject duplicates/unavailable GPUs, and release `GpuAllocationEntity` on delete/failure.
- Restrict operation read authorization by resource type and actor capability; redact sensitive request/payload/result fields (especially remote FS secrets) before returning operation details.
- Split delete semantics: if no bound runtime exists, complete desired deletion locally or route to an orphan cleanup operation instead of sending `runtimeId:null` to the agent.
- Extend `scripts/check-control-plane-redesign-conformance.sh` to catch camelCase action URLs, template-literal `/exec`, GET/PATCH `/actions/update-mounts`, and frontend/backend action route mismatches.

## Verification commands/results

```bash
bash scripts/check-control-plane-redesign-conformance.sh
# Result: passed all checks, including common source artifact guard.

find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
# Result: no output.
```

No runtime services were started/stopped and no product/test/script files were edited.

## Status

Report-only audit complete. Static stale-path conformance is green, but release robustness is not ready until the product-bug/security findings above are fixed and regressed.
