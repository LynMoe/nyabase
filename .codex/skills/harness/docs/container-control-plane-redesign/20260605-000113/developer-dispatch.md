# Developer Dispatch — Container Control Plane V2 hard cutover

Lead decision: stop incremental patching in the main thread. The implementation worker must perform an incompatible hard cutover from the design doc, deleting old chains instead of wrapping them.

Authoritative design document:
- `docs/container-control-plane-redesign.md`

Hard requirements:
1. No compatibility with old container API/routes/DB/container DTO/agent commands/live helpers.
2. `containerId` is the only public container identity; Docker/runtime ID may exist only as runtime-plane data and never as route identity or frontend/test canonical identity.
3. All container mutations return operation refs and complete via the operation plane.
4. Frontend and tests consume backend `ContainerView.actions`; no frontend business inference.
5. Database container data preservation is not required; reset/recreate container-control-plane schema if useful.
6. Old lifecycle/outbox/read-model/reconcile hook chain must be deleted or rewritten, not left as fallback.
7. Do not leave generated `.js/.js.map/.d.ts/.d.ts.map` under `packages/common/src/**`.

Current evidence requiring hard removal/rewrite:
- Backend live logs showed old field access after V2 partial cutover:
  - `UsersService` still tries to enqueue SSH hooks by querying `ContainerEntity.sshEnabled`.
  - `AgentGateway` `containerEvent` path still queries `ContainerEntity.dockerId`.
- Source scan shows old container lifecycle hook/reconcile files still reference old `dockerId`, `sshEnabled`, and lifecycle semantics:
  - `packages/backend/src/operations/lifecycle-hook-registry.service.ts`
  - `packages/backend/src/operations/reconcile-task-worker.service.ts` container lifecycle sections
  - `packages/backend/src/gateway/agent-gateway.ts` container event paths
  - `packages/backend/src/gateway/container-runtime-observation-writer.service.ts` if still treating `spec.dockerId` as control identity
  - `packages/backend/src/metrics/metrics.controller.ts` container dockerId map should use runtime plane/ContainerView rules
- Live specs still contain V2 mismatch/old direct action semantics and need replacement, not piecemeal compatibility:
  - no direct `DELETE /v2/containers/:id`, `/start`, `/stop`, `/restart`, `/exec`, `/mounts` unless design explicitly allows it;
  - use `/v2/containers/:id/actions/*`, `/v2/containers/:id/exec-sessions` if implemented, and operation polling.

Implementation mandate for subagent:
- Work directly in product/test code; main lead will not do architecture edits.
- Delete obsolete files where possible. If a file supports non-container domains, surgically remove container old-chain sections and prove no old public/API/DTO semantics remain.
- Strengthen `scripts/check-control-plane-redesign-conformance.sh` so the current old residues cannot return unnoticed.
- After implementation, run focused checks, then full gates, then live reset/register/deploy/smoke/admin/personas/continuation.

Required proof before lead can mark the goal complete:
- `pnpm typecheck`
- `pnpm test:unit`
- `pnpm test:functional`
- `bash scripts/check.sh`
- `pnpm run check:control-plane-redesign`
- common-source artifact guard
- live suites: smoke, admin-setup, personas, continuation
- final test report documenting exact commands and outcomes.
