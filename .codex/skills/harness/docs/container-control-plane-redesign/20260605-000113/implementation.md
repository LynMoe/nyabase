# Implementation Progress

## Completed in first cutover

- Added V2 design conformance script and package script.
- Changed common public enum names away from forbidden old agent command strings.
- Added V2 container view/action DTOs.
- Replaced backend container controller public surface with `/v2/containers` and canonical `containerId` routes.
- Removed frontend `$serverId.$containerId` route file and added `$containerId` route file.
- Added skeleton V2 services:
  - `container-action-policy.service.ts`
  - `container-control.service.ts`
  - `container-operation.service.ts`
  - `runtime/runtime-observation.service.ts`
  - `runtime/runtime-orphan.service.ts`
- Added frontend `use-operation-tracker.ts`.

## Current known incomplete areas

- Old backend implementation chain is still present and imported:
  - `container-read-model.service.ts`
  - `container-mounts.service.ts`
  - `container-ssh-sync.service.ts`
  - direct methods in `containers.service.ts` such as `startContainer`, `stopContainer`, `restartContainer`, `deleteContainer`.
- Live specs still contain old list-visibility/delete helper semantics.
- V2 services are skeletons, not production implementations.
- DB schema has not yet been reset to the new design.
- Runtime orphan/inventory/allocation tables are not implemented yet.

## Verification

- `pnpm typecheck`: passed after first cutover.
- Focused backend/agent/common tests passed.
- Stricter `pnpm run check:control-plane-redesign`: fails as expected until hidden old chain and old live helpers are removed.

## Latest implementation delta

- Added new V2 container schema entities and registration:
  - `ContainerDesiredSpecEntity`, `ContainerLifecycleEntity`, `RuntimeContainerEntity`, `RuntimeContainerStatEntity`, `RuntimeGpuInventoryEntity`, `GpuAllocationEntity`, `RuntimeOrphanEntity`.
- Added `1780600000000-ContainerControlPlaneTables` migration to recreate the container control-plane tables without preserving old container data.
- Reworked `ContainerControlService` to create/list/read `ContainerView` and derive actions via backend policy.
- Reworked `ContainerOperationService` to create durable operation/step/command rows and update lifecycle active operation in one transaction.
- Reworked frontend container row/detail/actions to use `ContainerView.actions` and `/v2/containers` endpoints.
- Tightened conformance script to reject old REST container paths and Docker-ID identity in live tests.
- Removed legacy operation/reconcile/read-model tests that validated the deleted chain; added focused V2 action policy and operation enqueue tests.

Known incomplete implementation areas:
- Runtime observation/orphan services are still skeletal beyond entity/table setup.
- Console exec and stats V2 runtime adapters are intentionally disabled in presentation until implemented.
- Some legacy non-container operation infrastructure remains for non-container resources; container lifecycle usage has been blocked by conformance but production cleanup can continue.
