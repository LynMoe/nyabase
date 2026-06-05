# Nyabase Container Control Plane Redesign

Status: implementation directive. Compatibility with the current container API,
DB schema, agent command names, frontend routes, and live-test flow is explicitly
not required. Developers must remove the old chain rather than wrapping it.

## 1. Objective

Replace the current mixed desired/runtime/operation container model with a new
four-plane architecture:

1. **Control Plane**: desired container records, lifecycle phase, action policy.
2. **Operation Plane**: every mutation is an operation with explicit steps and
   terminal state.
3. **Runtime Plane**: agent observations, inventory, metrics, and orphans.
4. **Presentation Plane**: `ContainerView` with backend-derived action
   availability consumed by frontend and tests.

The end state must eliminate ambiguity between "visible", "bound to runtime",
"running", "busy", and "actionable".

## 2. Non-negotiable Requirements

- No compatibility layer for old `/containers/:serverId/:containerId` routes.
- No public use of Docker ID as canonical container identity.
- No frontend-side business inference of action availability.
- No tests that proceed after only "container appears in list".
- DB data does not need to be preserved; old migrations may be replaced by a
  new initial schema.
- Old lifecycle/outbox/read-model chain must be removed or rewritten, not kept
  as a hidden fallback.
- All generated artifacts remain outside `packages/common/src/**`.

## 3. Old Chain To Remove

Remove these semantics completely:

- Public container route identity as `{serverId, containerId}`.
- `ContainerDto.spec.dockerId` as a required operational field for clients.
- Lifecycle phases `creating/updating/deleting` used independently by frontend
  and tests as ad-hoc busy flags.
- Runtime observation as a direct substitute for desired/control state.
- Direct action endpoints:
  - `POST /containers/:serverId/:containerId/start`
  - `POST /containers/:serverId/:containerId/stop`
  - `POST /containers/:serverId/:containerId/restart`
  - `DELETE /containers/:serverId/:containerId`
  - `GET /containers/:serverId/:containerId/stats`
  - `POST /containers/:serverId/:containerId/exec`
- Agent command kinds that encode the old lifecycle chain:
  - `container.applySpec`
  - `container.setPower`
  - `container.delete`
  - `container.applyMounts`
  - `container.reconcileSsh`
- Backend services must be rewritten or removed:
  - `container-read-model.service.ts`
  - old `containers.service.ts` action methods
  - old `container-mounts.service.ts` command coupling
  - old `container-ssh-sync.service.ts` lifecycle hook coupling
  - `reconcile-task`/hook usage for container lifecycle actions
- Tests must not accept old endpoints, old route params, or old waiting helpers.

A conformance check must fail if old public routes or agent command names remain.

## 4. New Domain Model

### 4.1 Container Phase

Replace `ContainerLifecyclePhase` with:

```ts
export enum ContainerPhase {
  Provisioning = 'provisioning', // desired exists, runtime binding pending
  Active = 'active',             // no active operation; runtime-bound if needed
  Updating = 'updating',         // mutation operation in progress
  Deleting = 'deleting',         // delete operation in progress
  Deleted = 'deleted',           // tombstone, hidden from normal users
  Failed = 'failed',             // terminal failure that needs retry/delete
  Orphaned = 'orphaned',         // runtime exists without valid desired owner
}
```

### 4.2 Canonical IDs

- `containerId` is the only public container identity.
- `runtimeId` is Docker/container-runtime identity and is never a route param.
- Agent labels must include `nyabase.containerId` for managed containers.
- Runtime rows with missing/unknown labels become runtime orphans.

### 4.3 New Tables

Use a new initial schema. Old rows do not need migration.

```text
containers
  id text primary key
  server_id text not null
  owner_id text not null
  name text not null
  image_id text not null
  created_by text not null
  created_at datetime not null
  deleted_at datetime null

container_desired_specs
  id text primary key
  container_id text unique not null
  generation int not null
  image_ref text not null
  image_default_uid int not null
  cpu_millis int not null
  mem_bytes text not null
  disk_bytes text not null
  gpu_mode text not null
  gpu_indices text not null
  mounts_json text not null
  ssh_enabled boolean not null
  power_intent text not null -- running|stopped
  entrypoint_json text null
  cmd_json text null
  created_at datetime not null
  updated_at datetime not null

container_lifecycle
  container_id text primary key
  phase text not null
  bound_runtime_id text null
  active_operation_id text null
  last_transition_at datetime not null
  failure_reason text null
  failure_code text null

runtime_containers
  id text primary key
  server_id text not null
  runtime_id text not null
  container_id text null
  owner_id text null
  owner_numeric_id int null
  status text not null
  spec_generation_seen int null
  ip text null
  labels_json text not null
  first_seen_at datetime not null
  last_seen_at datetime not null
  stale boolean not null
  unique(server_id, runtime_id)

runtime_container_stats
  runtime_container_id text primary key
  stats_json text not null
  observed_at datetime not null

runtime_gpu_inventory
  server_id text not null
  gpu_index int not null
  uuid text not null
  model text not null
  total_mem_mib int not null
  observed_at datetime not null
  primary key(server_id, gpu_index)

gpu_allocations
  container_id text primary key
  server_id text not null
  gpu_indices_json text not null
  allocated_at datetime not null

runtime_orphans
  id text primary key
  server_id text not null
  runtime_id text not null
  reason text not null -- missing_label|desired_missing|unknown_owner|stale_generation
  labels_json text not null
  observed_at datetime not null
  cleanup_hint_json text not null
  unique(server_id, runtime_id)
```

Existing auth/users/groups/servers/images/grants/audit tables may remain if they
do not preserve old container route semantics. Existing container-related tables
may be dropped and recreated.

## 5. Operation Plane

All mutations go through operations. API handlers only validate permissions,
create operations, and return operation references.

```ts
export enum OperationStatus {
  Queued = 'queued',
  Validating = 'validating',
  Dispatching = 'dispatching',
  WaitingAgent = 'waiting_agent',
  WaitingRuntime = 'waiting_runtime',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Cancelled = 'cancelled',
  Compensating = 'compensating',
}
```

Operation tables:

```text
operations
  id, kind, resource_type, resource_id, server_id, requested_by,
  status, request_json, result_json, last_error, last_error_code,
  created_at, started_at, completed_at

operation_steps
  id, operation_id, seq, kind, status, request_json, result_json,
  last_error, started_at, completed_at

operation_commands
  id, operation_id, step_id, server_id, command_kind, idempotency_key,
  payload_json, status, attempts, lease_expires_at, result_json, last_error,
  created_at, sent_at, completed_at

operation_locks
  resource_key primary key, operation_id, expires_at, fencing_token
```

Rules:

- Exactly one active operation per container.
- `container_lifecycle.active_operation_id` is the source of busy state.
- Operation terminal transition must update lifecycle in the same transaction.
- Repair jobs may recover drift, but normal success path must not rely on repair.

## 6. Runtime Plane

Agent state is observation only.

- State reports update `runtime_*` tables and `runtime_orphans`.
- State reports never directly set `container_lifecycle.phase=active`.
- Runtime can satisfy `WaitingRuntime` when it confirms expected generation and
  runtime identity.
- Unknown owner/numeric IDs create or update `runtime_orphans`; they must not
  enter ordinary user container lists or quota accounting.

## 7. Agent Protocol V2

Replace old command names with V2 names:

```ts
export enum AgentCommandKindV2 {
  RuntimeContainerCreate = 'runtime.container.create',
  RuntimeContainerPower = 'runtime.container.power',
  RuntimeContainerDelete = 'runtime.container.delete',
  RuntimeContainerExecOpen = 'runtime.container.exec.open',
  RuntimeContainerStatsFetch = 'runtime.container.stats.fetch',
  RuntimeContainerMountsApply = 'runtime.container.mounts.apply',
  RuntimeContainerSshApply = 'runtime.container.ssh.apply',
  RuntimeImagePull = 'runtime.image.pull',
  RuntimeDiskApply = 'runtime.disk.apply',
  RuntimeRemoteFsApply = 'runtime.remote_fs.apply',
}
```

Command envelope:

```ts
interface AgentCommandEnvelopeV2<T = unknown> {
  protocolVersion: 2;
  commandId: string;
  operationId: string;
  stepId: string;
  serverId: string;
  resourceId: string;
  desiredGeneration?: number;
  idempotencyKey: string;
  commandKind: AgentCommandKindV2;
  payload: T;
}
```

Managed runtime labels are mandatory:

```text
nyabase.managed=true
nyabase.containerId=<container id>
nyabase.ownerId=<uuid>
nyabase.specGeneration=<int>
nyabase.operationId=<create operation id>
```

Create ack must include `{ containerId, runtimeId, ip, specGeneration }`.

## 8. API V2

### 8.1 Container APIs

```http
GET    /api/v2/containers
POST   /api/v2/containers
GET    /api/v2/containers/:containerId
POST   /api/v2/containers/:containerId/actions/start
POST   /api/v2/containers/:containerId/actions/stop
POST   /api/v2/containers/:containerId/actions/restart
POST   /api/v2/containers/:containerId/actions/delete
POST   /api/v2/containers/:containerId/actions/update-mounts
POST   /api/v2/containers/:containerId/actions/enable-ssh
POST   /api/v2/containers/:containerId/actions/reconcile-ssh
GET    /api/v2/containers/:containerId/stats
POST   /api/v2/containers/:containerId/exec-sessions
```

Old `/api/containers/:serverId/:containerId/*` routes must be deleted.

### 8.2 Operation APIs

```http
GET /api/v2/operations/:operationId
GET /api/v2/operations?resourceType=container&resourceId=...
```

Every mutation returns:

```ts
interface OperationRefResponseV2 {
  operationId: string;
  status: OperationStatus;
}
```

### 8.3 Structured Errors

```ts
interface ApiErrorV2 {
  statusCode: number;
  code: string;
  reason: ActionBlockedReason | string;
  action?: ContainerAction;
  resourceType?: string;
  resourceId?: string;
  phase?: ContainerPhase;
  activeOperationId?: string | null;
  message: string;
}
```

409 examples: `container_unbound`, `operation_in_progress`,
`runtime_stale`, `agent_offline`, `insufficient_gpu_capacity`.

## 9. Presentation Plane

`ContainerView` is the only frontend/test DTO for containers.

```ts
interface ContainerView {
  id: string;
  serverId: string;
  serverName: string;
  ownerId: string;
  ownerName?: string;
  name: string;
  imageId: string;
  phase: ContainerPhase;
  powerIntent: 'running' | 'stopped';
  runtime: {
    bound: boolean;
    runtimeId: string | null;
    status: ContainerStatus | null;
    observedAt: string | null;
    stale: boolean;
    drift: RuntimeDrift[];
  };
  activeOperation: OperationSummary | null;
  resources: { cpuMillis: number; memBytes: number; diskBytes: number; gpuIndices: number[] };
  ssh: ContainerSshView;
  mounts: ContainerMountView[];
  actions: Record<ContainerAction, ActionAvailability>;
}
```

`ActionAvailability`:

```ts
interface ActionAvailability {
  enabled: boolean;
  reason?: ActionBlockedReason;
  message?: string;
  operationId?: string;
}
```

Frontend must disable/hide controls based only on `actions` and show `reason`.

## 10. Action Policy

Create `ContainerActionPolicyService` as the only source of action availability.

Base rules:

- `stats`, `console`, `stop`, `restart` require:
  - owner or `manage_containers_any`
  - `phase=active`
  - no active operation
  - bound runtime ID
  - agent online
  - runtime status running for stats/console/stop/restart
- `start` requires:
  - owner or manage any
  - `phase=active`
  - no active operation
  - bound runtime ID
  - agent online
  - runtime status not running
- `delete` requires:
  - owner or manage any
  - `phase in active|failed`
  - no active operation
- `update-mounts`, `enable-ssh`, `reconcile-ssh` require action-specific grants
  plus active/bound/no-active-operation unless explicitly designed otherwise.

API handlers must call the same policy; frontend must not reimplement it.

## 11. GPU Model

Separate inventory, grant, and allocation.

- Inventory comes from agent hello/state report into `runtime_gpu_inventory`.
- Grants remain user/group/server scoped.
- Allocation is written after create operation reserves GPUs.
- Delete releases allocation in the same lifecycle terminal transaction.

Error contract:

- 403 `gpu_not_permitted`: user lacks GPU grant.
- 400 `invalid_gpu_request`: malformed/duplicate/conflicting request.
- 409 `gpu_inventory_unavailable`: agent has no current inventory.
- 409 `insufficient_gpu_capacity`: grant/inventory cannot satisfy count.

## 12. Frontend Requirements

- Replace container routes with `/containers/:containerId`.
- Remove all serverId+containerId route params.
- Mutations call V2 action endpoints and track returned operation IDs.
- Add `useOperationTracker(operationId)` and invalidate affected views only after
  terminal state or explicit progress update.
- Container row/detail buttons read `container.actions[action].enabled` only.
- Stats query enabled only when `container.actions.stats.enabled`.
- Console connect enabled only when `container.actions.console.enabled`.
- UI badges display `phase`, `runtime.status`, and `activeOperation.status` as
  distinct concepts.

## 13. Backend Implementation Plan

1. Replace common enums/DTOs/schemas with V2 types.
2. Replace DB schema/migrations with a new initial schema; remove old container
   migrations and old container-related tables.
3. Implement repositories/services:
   - `ContainerControlService`
   - `ContainerOperationService`
   - `ContainerActionPolicyService`
   - `RuntimeInventoryService`
   - `RuntimeObservationService`
   - `RuntimeOrphanService`
4. Rewrite container controller to V2 routes only.
5. Rewrite operation orchestrator to own lifecycle transitions.
6. Rewrite agent gateway to parse protocol V2 and persist runtime observations.
7. Rewrite agent dispatcher to execute V2 commands and enforce mandatory labels.
8. Rewrite frontend to consume `ContainerView` and operation tracker.
9. Rewrite live tests and frontend e2e helpers around operation/phase waits.
10. Delete or fail-search old public route/agent command names.

## 14. Test And Regression Strategy

### 14.1 Design Conformance Tests

Add tests or scripts that fail if old chain remains:

- No source match for `/containers/:serverId/:containerId` public routes.
- No source match for old direct action routes under serverId+containerId.
- No source match for old agent command string literals:
  `container.applySpec`, `container.setPower`, `container.applyMounts`,
  `container.reconcileSsh`.
- Frontend container routes do not contain `$serverId.$containerId`.
- Container buttons do not compute business availability from raw status.

### 14.2 Backend Unit Tests

- Creating container sets phase `provisioning`, active operation, no runtime bind.
- Create success binds runtime ID, writes spec generation, phase `active`.
- Create failure sets phase `failed` and structured error.
- Runtime observation without desired row creates orphan.
- Unknown numeric owner creates orphan and is hidden from user lists.
- Start/stop/restart/delete require policy-enabled action.
- Updating/deleting blocks conflicting operations with structured 409.
- GPU inventory/grant/allocation error contract.
- Operation terminal transition updates lifecycle atomically.

### 14.3 Agent Tests

- V2 create command labels all containers correctly.
- V2 power/delete commands are idempotent by idempotency key.
- State report includes managed labels and detects unmanaged runtime.
- Ack/progress correlation uses commandId and operationId.

### 14.4 Frontend Tests

- `ContainerRow` uses `actions` to enable/disable controls.
- Provisioning/updating/deleting/failed states render distinct badges.
- Mutation tracks operation ID and waits for terminal state before re-enabling.
- Stats/console disabled unless action availability says enabled.

### 14.5 Live Tests

Replace sleeps/list-visibility waits with helpers:

```ts
await waitOperationSucceeded(operationId);
await waitContainerPhase(containerId, 'active');
await waitActionEnabled(containerId, 'stats');
```

Live suites must prove:

- Admin creates users/images/grants/servers.
- User creates container, waits active/bound, stats/exec works, stop/start/restart
  operations terminal, delete hides from user list.
- Conflict tests assert structured reasons.
- Orphan cleanup handles remote leftovers.
- GPU count/index behavior follows 400/403/409 contract.

### 14.6 Full Regression Gates

Minimum completion gates:

```bash
pnpm typecheck
pnpm test:unit
pnpm test:functional
bash scripts/check.sh
bash test/scripts/reset-local.sh
node test/scripts/register-agents.mjs
bash test/scripts/deploy-agents.sh
bash test/scripts/run-live-suite.sh smoke
bash test/scripts/run-live-suite.sh admin-setup
bash test/scripts/run-live-suite.sh personas
bash test/scripts/run-live-suite.sh continuation
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```

If frontend pixels/routes change materially, also run visual checks and inspect
fresh screenshots.

## 15. Cleanup And Live Environment

- Every live run has `runId` and prefix.
- Every created DB row and runtime ID is recorded in a cleanup ledger.
- Reset may drop DB, but remote Docker roots must be cleaned by exact prefix.
- Runtime orphans are not failures by themselves; unclassified orphans that match
  the current run prefix are failures until cleaned.
- Live preflight must compare agent config server IDs/tokens to DB rows before
  tests.


## 16. One-shot Developer Execution Checklist

Development must be done as a single cohesive refactor branch, not as a
compatibility-preserving incremental patch. A developer is expected to finish all
items below before requesting regression:

1. **Common contract first**
   - Replace old lifecycle/action/agent command enums with the V2 contract.
   - Add `ContainerView`, `ActionAvailability`, `ApiErrorV2`, V2 operation DTOs,
     and V2 agent envelopes.
   - Remove old DTO fields that expose Docker ID as canonical identity.

2. **Database reset**
   - Delete old container-related migrations or replace them with a new initial
     migration/schema.
   - Drop/recreate local test DBs; no old data migration is required.
   - Ensure all container runtime/orphan/inventory/allocation tables exist.

3. **Backend rewrite**
   - Remove old serverId+containerId controller routes.
   - Implement V2 container, operation, runtime, orphan, and policy services.
   - Ensure mutation handlers create operations and never execute direct runtime
     mutations without an operation.
   - Ensure operation terminal transitions atomically update lifecycle.

4. **Agent rewrite**
   - Remove old command dispatch cases and tests.
   - Implement V2 command envelope parsing and mandatory managed labels.
   - Ensure create/power/delete/mount/ssh commands are idempotent.

5. **Frontend rewrite**
   - Remove old container route file and generated route references.
   - Use `/containers/:containerId` only.
   - Replace every raw status/busy/action inference with backend `actions`.
   - Track operation IDs after every mutation.

6. **Tests rewrite**
   - Replace live helpers that wait for list visibility.
   - Add operation/phase/action wait helpers.
   - Add design conformance tests/script and make it part of check gates.

7. **Runtime cleanup**
   - Add exact-prefix remote runtime cleanup for live tests.
   - Add orphan classification tests and admin cleanup APIs.

Forbidden partial end states:

- V2 API exists while old public routes still work.
- Frontend uses V2 list but old detail route.
- Agent supports both old and V2 command names.
- Tests pass by accepting both old and new error semantics.
- Runtime orphans are merely hidden by frontend instead of classified by backend.
- Operation IDs are returned but frontend/e2e does not wait for terminal state.

## 16. Acceptance Criteria

The refactor is not complete until all are true:

1. Old public container routes and old agent command names are absent from source.
2. New DB schema has no dependency on preserving old container data.
3. All container mutations return operation IDs.
4. Frontend uses backend `actions` for all runtime/action controls.
5. Tests wait on operation terminal state and container phase/action availability.
6. Runtime orphan handling prevents unknown remote containers from user views and
   quota decisions.
7. GPU inventory endpoint returns observed inventory and GPU error semantics match
   this document.
8. Full regression gates in section 14.6 pass, or any failure is explicitly
   classified with evidence and fixed before claiming completion.
9. The design conformance tests pass.
10. Common source artifact guard has no output.
