# Container Lifecycle Architecture Redesign

## Goal

Preserve the current container, data directory, remote filesystem, SSH, quota, audit, stats, and exec feature set while replacing the loosely coupled lifecycle flows with one durable control-plane architecture.

## Core Architecture

The redesigned system has four explicitly separate state planes:

1. Desired spec state: backend database rows that define what nyabase wants to exist.
2. Observed runtime state: persisted agent reports that describe what Docker and the host currently show.
3. Command state: durable operations, outbox commands, retries, leases, results, and user-visible progress.
4. Hook/reconcile state: durable per-domain tasks that converge mounts, SSH, data dirs, remote FS, quota, audit, grants, and frontend observations after desired or observed state changes.

Docker labels stop being the source of truth. New labels are only identity and discovery hints:

```ts
nyabase.container_id
nyabase.server_id
nyabase.spec_generation
nyabase.owner_id        // metric/report hint only
nyabase.container_name  // metric/report hint only
nyabase.managed=true
```

All container specs, SSH enablement, mount expectations, and lifecycle intent live in the backend database. Agent reports are never treated as desired spec, and read endpoints never write backfill rows.

## Ownership Boundaries

- `AgentGateway`: transport only. It accepts hello/report/progress messages, persists observations, resolves pending command acknowledgements, and exposes online/session status. It does not call domain hooks directly.
- `ContainerLifecycleService`: public API facade for container actions. It validates access and creates durable operations.
- `OperationOrchestrator`: owns operation state machine, outbox enqueueing, distributed locks, retries, compensation, and operation result visibility.
- `LifecycleHookRegistry`: computes hook tasks from desired/observed deltas. Hooks do not call each other directly.
- Agent `CommandDispatcher`: executes idempotent host/Docker primitives and emits progress. It does not decide desired policy.
- Frontend: observes containers plus durable operation status. Local pending state is only an optimistic hint.

## Lifecycle Model

### Desired Container Model

Each container has a backend-assigned `containerId` before Docker creation. `dockerId` is an observed binding that may be null until the agent creates the Docker container.

```ts
type ContainerLifecyclePhase =
  | 'creating'
  | 'active'
  | 'updating'
  | 'deleting'
  | 'deleted'
  | 'failed';

type ContainerPowerIntent = 'running' | 'stopped';

interface ContainerDesired {
  id: string;                 // backend containerId
  serverId: string;
  dockerId: string | null;     // observed binding after create/import
  ownerId: string;
  name: string;
  imageId: string;
  imageDockerRef: string;      // snapshot used by agent
  imageDefaultUid: number;     // snapshot for createIfMissing ownership
  cpuMillis: number;
  memBytes: number;
  gpuIndices: number[];
  ip: string;
  sshEnabled: boolean;
  powerIntent: ContainerPowerIntent;
  lifecyclePhase: ContainerLifecyclePhase;
  specGeneration: number;
  mountGeneration: number;
  sshGeneration: number;
  createdBy: string;
  deletedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
```

Desired CPU, memory, GPU, image, IP, name, owner, SSH enablement, and mount generation are authoritative. Runtime reports can expose drift but cannot mutate desired spec.

### Observed Runtime Model

Observed state is persisted per report sequence:

```ts
interface ContainerRuntimeObservation {
  serverId: string;
  containerId: string | null;
  dockerId: string;
  reportSeq: number;
  status: ContainerStatus;
  stats: ContainerStatsSummary | null;
  sshServer: ContainerSshServerState;
  labels: Record<string, string>;
  labelsValid: boolean;
  specGenerationSeen: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  missingSince: Date | null;
  stale: boolean;
}
```

Read DTOs are built by joining desired state and the latest observation:

- Desired exists, observed exists: normal container.
- Desired exists, observed missing: show pending/stale/drift depending on operation status.
- Observed exists, desired missing: unmanaged/import-needed drift row for admins only until migration/import handles it.
- Desired deleting: show deleting until delete operation succeeds, then hide by default.

`StateCache` may remain as an in-process optimization, but all list/get/quota decisions must use persisted desired/observed rows or transaction-local operation reservations.

### Command State

Every mutating user action creates an `operations` row. Every agent command is persisted in `agent_command_outbox`.

```ts
type OperationStatus =
  | 'queued'
  | 'running'
  | 'waiting_agent'
  | 'waiting_observed'
  | 'blocked'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'compensating'
  | 'cancelled';

interface Operation {
  id: string;
  idempotencyKey: string;
  kind:
    | 'container.create'
    | 'container.start'
    | 'container.stop'
    | 'container.restart'
    | 'container.delete'
    | 'container.update_mounts'
    | 'container.enable_ssh'
    | 'container.reconcile_ssh'
    | 'datadir.create'
    | 'datadir.delete'
    | 'disk.apply'
    | 'remote_fs.apply'
    | 'quota.apply';
  resourceType: string;
  resourceId: string;
  serverId: string;
  requestedBy: string | null;
  status: OperationStatus;
  request: unknown;
  result: unknown | null;
  lastError: string | null;
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
```

Commands use absolute desired state and generations, not imperative deltas when possible. Examples: `applyContainerMounts` sends the full expected mount set; quota sends an absolute limit; SSH sends the full expected public key set and key hash.

### Hook/Reconcile State

Hooks are durable operation steps, not `setImmediate` callbacks.

```ts
type HookStatus =
  | 'pending'
  | 'running'
  | 'waiting_agent'
  | 'waiting_observed'
  | 'not_applicable'
  | 'succeeded'
  | 'failed'
  | 'retrying';

interface ReconcileTask {
  id: string;
  operationId: string | null;
  hook: 'mounts' | 'ssh' | 'data_dirs' | 'remote_fs' | 'data_disks' | 'quota' | 'audit' | 'grants';
  resourceType: string;
  resourceId: string;
  serverId: string;
  desiredGeneration: number | null;
  status: HookStatus;
  priority: number;
  nextAttemptAt: Date;
  attempts: number;
  lastError: string | null;
  result: unknown | null;
  createdAt: Date;
  updatedAt: Date;
}
```

Agent reconnect, full reports, container start events, user SSH key changes, grant changes, disk changes, and remote FS assignment changes enqueue tasks transactionally. They do not directly execute agent RPCs.

## Interfaces

### REST Before

- `POST /containers` validates and synchronously calls `createContainer`; response `{ ok: true }`.
- `POST /containers/:serverId/:dockerId/start|stop|restart` synchronously RPCs the agent; response `{ ok: true }`.
- `DELETE /containers/:serverId/:dockerId` synchronously RPCs the agent and then deletes adjacent DB rows.
- `PATCH /containers/:serverId/:dockerId/mounts` writes mount rows and best-effort reconciles.
- `POST /containers/:serverId/:dockerId/ssh/enable` writes overlay row and maybe reconciles.
- `POST /containers/:serverId/:dockerId/ssh/reconcile` manually calls the SSH sync service.
- `GET /containers` and `GET /containers/:serverId/:dockerId` read `AgentGateway.stateCache` with SSH overlay and read-path backfill.
- `GET /containers/:serverId/:dockerId/stats` transient RPCs `fetchContainerStats`.
- `POST /containers/:serverId/:dockerId/exec` creates a transient exec stream session.

### REST After

Existing routes remain functionally available. Mutating routes return operation metadata:

```ts
interface OperationRefResponse {
  ok: true;
  operationId: string;
  status: OperationStatus;
}
```

Recommended route changes:

- `POST /containers` returns `OperationRefResponse` and creates a desired row immediately.
- `POST /containers/:serverId/:containerId/start|stop|restart` accepts `containerId`; a compatibility lookup by `dockerId` can exist during migration only.
- `DELETE /containers/:serverId/:containerId` marks desired state `deleting` and returns `OperationRefResponse`.
- `PATCH /containers/:serverId/:containerId/mounts` replaces desired mount specs and returns `OperationRefResponse`.
- `POST /containers/:serverId/:containerId/ssh/enable` sets `sshEnabled=true`, returns `{ ok: true, enabled: true, operationId, reconciled }`.
- `POST /containers/:serverId/:containerId/ssh/reconcile` creates a manual SSH reconcile operation.
- `GET /operations/:operationId` returns operation, steps, attempts, last error, and result.
- `GET /containers` and `GET /containers/:serverId/:containerId` return the existing `ContainerDto` shape plus optional `operation`, `observedAt`, `stale`, and `drift` fields.
- `GET /containers/:serverId/:containerId/stats` keeps the current feature, but writes the fetched result into observations and returns `lastObservedAt`.
- `POST /containers/:serverId/:containerId/exec` remains a transient stream workflow; it requires a running latest observation.

The frontend can keep polling current container endpoints, but should also poll `GET /operations/:id` for action progress. An SSE endpoint such as `GET /operations/events?resourceId=...` is optional in a later phase.

### Agent RPC Before

The protocol has many direct message kinds: `createContainer`, `startContainer`, `stopContainer`, `deleteContainer`, `reconcileContainerMounts`, `applyContainerMount`, `removeContainerMount`, `reconcileContainerSsh`, `applyRemoteFsMount`, `updateUserQuota`, `stateReport`, `commandAck`, and ad hoc events.

`commandAck` is transient and tied to a WebSocket RPC id. State report specs are parsed from Docker labels.

### Agent RPC After

Use one command envelope with typed payloads:

```ts
interface AgentCommandEnvelope<K extends string, P> {
  id: string;                  // commandId
  ts: number;
  kind: 'agentCommand';
  payload: {
    operationId: string;
    commandId: string;
    commandKind: K;
    idempotencyKey: string;
    resourceKey: string;
    desiredGeneration: number | null;
    payload: P;
  };
}
```

Command kinds:

- `container.applySpec`: create container if missing, bind `containerId`, set labels, start if requested, attach quota paths, return `dockerId`.
- `container.setPower`: start/stop/restart by `containerId` or `dockerId`; already-in-target-state is success.
- `container.delete`: remove if present; absent is success.
- `container.applyMounts`: reconcile the full expected mount set for a running container; stopped is `not_applicable`.
- `container.reconcileSsh`: reconcile Dropbear binary, authorized keys, and process for a running SSH-enabled container.
- `datadir.apply` and `datadir.delete`: create/delete absolute desired directories.
- `disk.apply` and `disk.remove`: configure data disk sources.
- `remote_fs.apply` and `remote_fs.remove`: mount/unmount assigned remote FS.
- `quota.apply`: set absolute project quota.
- `stats.fetch`: transient query command, not part of durable lifecycle operations.
- `exec.start|input|resize|close`: stream commands, not lifecycle operations.

Agent progress replaces bare `commandAck`:

```ts
interface OperationProgressPayload {
  serverId: string;
  operationId: string;
  commandId: string;
  idempotencyKey: string;
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'not_applicable';
  step: string;
  desiredGeneration?: number;
  data?: unknown;
  error?: string;
  ts: number;
}
```

Reports become observed facts:

```ts
interface RuntimeReportPayload {
  serverId: string;
  reportSeq: number;
  full: boolean;
  observedAt: number;
  containers: RuntimeContainerObservation[];
  xfsProjects: XfsProjectUsage[];
  disks: DiskInfo[];
  dataDirs: DataDirEntry[];
  remoteFsMounts: RemoteFsMountStatus[];
  localImages: LocalImageInfo[];
  dockerDaemon: DockerDaemonStatus | null;
}
```

Container events remain hints. On event receipt the backend updates a provisional observation and enqueues a focused report request. Final read state is reconciled by `RuntimeReportPayload` with monotonic `reportSeq`.

### Idempotency Semantics

- Backend command retry uses the same `operationId`, `commandId` for the same outbox row, and `idempotencyKey`.
- Agent command effects are idempotent by resource identity and generation.
- `container.applySpec` first searches for an existing Docker container with `nyabase.container_id=<containerId>`; legacy imports can also map by persisted `dockerId`.
- `container.delete` succeeds if the container is already absent.
- `container.setPower` succeeds if the target state already matches.
- `container.applyMounts`, `container.reconcileSsh`, `disk.apply`, `remote_fs.apply`, and `quota.apply` send full desired state and may be retried safely.
- Agent may keep a bounded recent command result cache, but correctness must not depend on it surviving agent restart.

## Data Model Changes

Create these entities and tables:

- `containers`: durable desired container spec and lifecycle intent.
- `container_runtime_observations`: latest and optionally historical observed Docker/container state.
- `container_mount_specs`: desired container mounts keyed by `containerId` and `containerPath`.
- `container_mount_runtime`: last reconcile status for each desired mount path and observed extra/missing mounts.
- `operations`: durable user/system operations.
- `operation_steps`: ordered lifecycle phases and hook steps.
- `agent_command_outbox`: durable commands to be delivered to agents.
- `resource_locks`: DB-backed locks with holder, fencing token, and lease expiration.
- `reconcile_tasks`: durable hook work queue.
- `data_dir_runtime_observations`: reported data directory presence and orphan/missing status.
- `remote_fs_runtime_observations`: reported remote mount status per server.
- `data_disk_runtime_observations`: reported disk capacity/quota enforcement per server.
- `quota_desired`: absolute per-user per-server quota target derived from grants/defaults.
- `quota_runtime_observations`: reported XFS project usage.

Modify these existing tables:

- `container_mounts` becomes `container_mount_specs` or is migrated into it; references `containerId` instead of nullable `dockerId`.
- `container_ssh_enablements` is folded into `containers.sshEnabled` and `containers.sshGeneration`.
- `data_directories` keeps desired directory metadata but gains `desiredState`, `generation`, `lastOperationId`, and explicit ownership notes.
- `data_disks` gains `generation` and desired remove/apply state.
- `remote_fs_mounts` and `remote_fs_server_assignments` gain generation fields and desired assignment state.
- `servers` can keep `status` and `lastSeenAt`, but live host details should come from persisted observations.

### Mount Ownership Rule

The old `ContainerMountEntity.userId` is ambiguous because it can mean actor, container owner, or data directory owner. The new rule is:

- `container_mount_specs.dataDirId` points to `data_directories.id` whenever the directory is known.
- `mountOwnerUserId` is the owner of that `data_directories` row.
- `createdBy` and `updatedBy` record the actor separately.
- `createIfMissing=true` creates a `data_directories` desired row owned by the container owner unless the request explicitly references an existing directory owned by another authorized user.
- Access checks use grants/mount-source grants; runtime host paths use source + directory name, not actor id.

This removes read-time inference and keeps current directory-sharing behavior visible and auditable.

### Migration and Backfill

Compatibility can be broken after migration, but existing data must be imported:

1. Add new schema with old tables still present.
2. On first full runtime report after migration, import every Docker container with old nyabase labels into `containers` if no desired row exists.
3. Backfill desired spec from old labels: owner, name, imageId, cpuMillis, memBytes, gpuIndices, ip, createdAt, serverId, and `sshServerEnabled`.
4. Backfill `dockerId` binding from the report.
5. Set `powerIntent` from observed status: running containers become `running`, stopped/exited containers become `stopped`.
6. Backfill SSH enablement from either `container_ssh_enablements` or old label `sshServerEnabled=true`. Do this only in migration/import, never in read paths.
7. Backfill mount specs from `container_mounts`. Resolve `dataDirId` by `(sourceKind, sourceId, dirName)`. If a row exists, use its `userId` as `mountOwnerUserId`; otherwise keep old `userId`, set `dataDirId=null`, and mark `ownershipSource='legacy_unresolved'` for admin repair.
8. Preserve `data_disks`, `remote_fs_mounts`, `remote_fs_server_assignments`, `data_directories`, grants, users, images, and audit logs.
9. Import latest observed data dirs, remote FS statuses, disk info, docker daemon status, and quota usage from the first full report.
10. New containers use `nyabase.container_id` labels. Existing Docker labels may remain immutable; the backend relies on imported DB rows and persisted `dockerId` bindings for legacy containers.
11. After import, disable old read-path SSH backfill and old `StateCache`-only reads.

## Backend Orchestration Flows

### Create Container

1. API validates server, image, access, image grants, mount-source grants, quota, GPU policy, and name/IP uniqueness.
2. In one DB transaction:
   - allocate `containerId` and IP;
   - insert `containers` desired row with `lifecyclePhase='creating'`, `powerIntent='running'`, generations set to `1`;
   - insert desired mount specs;
   - insert/resolve any `createIfMissing` data directory rows;
   - set `sshEnabled` from the request;
   - create `container.create` operation and initial steps;
   - enqueue required hook tasks and first outbox command.
3. Worker claims DB lock `server:<serverId>:container:<containerId>` with a fencing token.
4. Data dir and quota prepare hooks run first.
5. `container.applySpec` is delivered to the agent. Agent creates or finds the container, starts it, labels it with `containerId`, attaches quota paths, and returns `dockerId`.
6. Backend persists `dockerId`, then enqueues mount and SSH reconcile tasks if applicable.
7. Mount reconcile is required when mounts were requested and the container is running.
8. SSH reconcile is required when `sshEnabled=true` and the container is running.
9. Operation succeeds only after required create steps are succeeded or explicitly `not_applicable` by policy.
10. If a required step fails after retry budget, operation enters `compensating`; backend enqueues `container.delete`. User-created or pre-existing data directories are not deleted automatically.

### Start

1. API validates access and desired row not deleted.
2. Transaction sets `powerIntent='running'`, creates `container.start` operation, and enqueues `container.setPower`.
3. Agent start is idempotent.
4. On success or running observation, enqueue mount and SSH hooks.
5. UI shows starting/running from operation plus observation.

### Stop

1. API validates access.
2. Transaction sets `powerIntent='stopped'`, creates `container.stop`, and enqueues `container.setPower`.
3. Agent stop is idempotent; already stopped succeeds.
4. Running-only hooks become `not_applicable` until the next start.

### Restart

1. API validates access.
2. Transaction keeps `powerIntent='running'`, creates `container.restart`, and enqueues `container.setPower`.
3. On success, enqueue mount and SSH hooks because namespace mounts and Dropbear state may need repair.

### Delete

1. API validates access.
2. Transaction sets `lifecyclePhase='deleting'`, creates `container.delete`, and keeps desired mount/SSH rows until agent deletion succeeds.
3. Worker sends `container.delete`; absent Docker container is success.
4. After success, transaction marks `containers.deletedAt`, removes or tombstones mount specs, clears SSH desired state, clears runtime observations, and writes audit.
5. Disk/remote-FS removal checks continue to treat pending-delete containers as in-use until delete succeeds or runtime observation proves absence.

### Update Mounts

1. API validates access and mount-source grants.
2. Backend resolves each mount to a data directory and explicit owner. Duplicate source and duplicate container path checks run against the full desired set.
3. Transaction replaces `container_mount_specs`, increments `mountGeneration`, and creates `container.update_mounts`.
4. If latest observation is running and agent online, enqueue `container.applyMounts`.
5. If stopped/offline, task remains `not_applicable` or `waiting_agent` and is retried on start/reconnect/full report.
6. Agent receives the full expected set and reconciles current mounts to match it.

### Enable SSH

1. API validates access.
2. Transaction sets `containers.sshEnabled=true`, increments `sshGeneration`, creates `container.enable_ssh`, and enqueues SSH hook.
3. If stopped, operation can complete with `reconciled=false` and hook task `not_applicable_until_running`.
4. If running, worker sends `container.reconcileSsh` with full public key set and expected hash.
5. User SSH key changes enqueue SSH hook tasks for all desired SSH-enabled containers owned by the user.

### Reconcile SSH

1. API validates access and `sshEnabled=true`.
2. Creates `container.reconcile_ssh` manual operation.
3. Running/offline/stopped status is represented in operation and hook result instead of hidden logs.

### Stats

1. List/detail use latest persisted stats from runtime observations.
2. Explicit `GET /stats` sends a short-timeout transient `stats.fetch` if the agent is online.
3. The fetched stats update observations and return `{ dockerId, stats, ts, lastObservedAt }`.
4. If the agent is offline, preserve current failure semantics for explicit stats fetch, while list/detail can still show stale observed values with `stale=true`.

### Exec

1. Exec remains ephemeral and stream-oriented.
2. API validates access and latest observation is running.
3. Backend creates an exec session record with TTL, sends `exec.start`, and registers console ownership.
4. Console WebSocket continues to proxy input/resize/close.
5. Exec commands are not durable lifecycle operations, but orphan cleanup remains required.

## Agent Responsibilities

- Treat backend commands as desired-generation applications.
- Emit `OperationProgressPayload` for accepted, running, succeeded, failed, and not-applicable states.
- Emit full `RuntimeReportPayload` on connect, after lifecycle commands, after data dir changes, and periodically.
- Emit focused incremental reports or event hints after Docker events, but tolerate event loss because full reports converge state.
- Implement idempotency by inspecting Docker/host state before mutating.
- Create new Docker containers with `containerId` and generation labels.
- Continue reporting old-label containers during migration/import.
- Keep Docker, mount helper, Dropbear, data dir, remote FS, and quota code as primitives behind the new command envelope.

## Hook Architecture

### Mount Hook

Desired input: `container_mount_specs` plus source definitions.

Triggers:

- container create with mounts;
- `PATCH /mounts`;
- container running observation;
- agent reconnect/full report;
- remote FS/data disk source generation change.

Output:

- `container.applyMounts` with full expected host path to container path mapping.
- persisted mount reconcile status and drift.

### SSH Hook

Desired input: `containers.sshEnabled`, owner public keys, Dropbear asset version.

Triggers:

- create with SSH;
- enable SSH;
- manual reconcile;
- container running observation;
- user SSH key add/delete;
- agent reconnect/full report.

Output:

- `container.reconcileSsh` with normalized public keys and expected hash.
- persisted SSH status/error from operation progress and runtime report.

### Data Directory Hook

Desired input: `data_directories`.

Triggers:

- explicit create/delete data dir;
- create container with `createIfMissing`;
- data dir runtime report.

Output:

- `datadir.apply` or `datadir.delete`;
- persisted orphan/missing observations.

### Remote FS Hook

Desired input: `remote_fs_mounts` and server assignments.

Triggers:

- create/update/remove remote FS;
- assign/unassign server;
- agent reconnect/full report.

Output:

- `remote_fs.apply` and `remote_fs.remove`;
- persisted per-server mount status.

### Data Disk Hook

Desired input: `data_disks`.

Triggers:

- add/update/remove disk;
- agent reconnect/full report.

Output:

- `disk.apply` and `disk.remove`;
- persisted disk capacity/quota enforcement observations.

### Quota Hook

Desired input: grants/defaults plus user numeric IDs.

Triggers:

- server defaults/grants change;
- user gains/loses server access;
- container create/delete;
- data dir create/delete;
- agent reconnect/full report.

Output:

- absolute `quota.apply` commands;
- persisted XFS project usage.

### Audit Hook

Audit writes should be transactionally attached to operations:

- `requested` when the operation row is created;
- `succeeded` or `failed` when operation completes;
- payload includes operationId, actor, resource, request, and result/error.

### Grants Hook

Grants remain preflight access policy. Runtime side effects from grant/default changes, such as quota updates, are represented as quota desired changes and operations.

### Frontend Observation Hook

Frontend state is derived from:

- container desired + observed DTO;
- current operation for the resource;
- hook status summaries.

This replaces local-only pending action state after refresh or backend restart.

## Distributed Locking, Retry, and Outbox

Use DB-backed resource locks instead of `OperationLockService` in-process locks:

- `resource_locks.resourceKey` is unique.
- `holderId` identifies backend worker instance.
- `fencingToken` increments on every acquisition.
- `expiresAt` allows recovery from crashed workers.
- Workers refresh leases while running.

Outbox processing:

1. Worker selects due outbox rows with `status in ('pending','retrying')`.
2. Worker acquires the resource lock.
3. If agent offline, row becomes `waiting_agent` with `nextAttemptAt`.
4. If delivered, row becomes `sent`.
5. Agent progress `succeeded` marks outbox and operation step succeeded.
6. Failure records error and either retries with exponential backoff or fails the operation.
7. Stale `sent` rows whose lease/timeout expired are retried with the same idempotency key.

Retry policy:

- Transient agent offline, WebSocket disconnect, timeout, and Docker daemon unavailable: retry/backoff.
- Validation/policy errors: fail immediately.
- Create required hook failures: retry, then compensate if exhausted.
- Manual reconcile failures: fail operation but keep desired state.

## Preservation of Current Features

| Current feature | New architecture |
| --- | --- |
| Create container | Desired row + `container.create` operation + idempotent `container.applySpec` |
| List/get containers | Desired/observed read model, same `ContainerDto` fields plus optional operation/stale/drift |
| Start/stop/restart/delete | Durable operations and idempotent `container.setPower`/`container.delete` |
| Container stats | Persisted observed stats plus transient `stats.fetch` endpoint |
| Exec console | Same browser console flow, still transient, with DB TTL session cleanup |
| Data directory mounts | Desired mount specs and durable mount reconcile tasks |
| Local data disks | Desired disk rows and durable disk apply/remove hook |
| Remote FS | Desired remote FS assignments and durable apply/remove hook with status visibility |
| Dropbear SSH enable | `containers.sshEnabled` desired state and SSH hook |
| SSH manual repair | Manual `container.reconcile_ssh` operation |
| SSH key sync | User key changes enqueue SSH hook tasks |
| Grants/access checks | Same preflight policy; quota side effects become durable operations |
| Quota enforcement | Absolute desired quota tasks and persisted usage observations |
| Audit logs | Operation-attached requested/succeeded/failed audit records |
| Agent reconnect state reporting | Full report import/observation persistence plus hook task enqueueing |

## Known Risk Resolution

- Create/delete compensation gaps: create has explicit phases and compensation; delete keeps tombstone until agent success.
- Single-process locks: replaced by DB `resource_locks` leases and fencing.
- Stale state windows: read path uses persisted observations with report sequence, `lastSeenAt`, and operation status.
- Read-path SSH backfill: removed; only migration/import creates SSH desired state from labels/old rows.
- Mount `userId` ambiguity: mount owner is data directory owner; actor is separate audit metadata.
- Best-effort hooks: hooks are durable tasks with retries, status, and errors.
- Scattered command/reconcile flows: all mutations enter `OperationOrchestrator`; `AgentGateway` becomes transport/report ingestion.

## File-Level Change List

### Common

- `packages/common/src/constants.ts`: modify Docker labels to identity/generation labels; deprecate full spec label contract.
- `packages/common/src/protocol/agent-messages.ts`: replace direct command schemas with agent command envelope, operation progress, runtime report, desired-generation payloads.
- `packages/common/src/protocol/ws.ts`: update message unions for `agentCommand`, `operationProgress`, and `runtimeReport`.
- `packages/common/src/protocol/rest-schema.ts`: add operation query schemas and containerId-based params where shared schemas are used.
- `packages/common/src/protocol/rest.ts`: add operation DTOs, container operation summaries, stale/drift fields, hook status DTOs.

### Backend Entities and Database

- `packages/backend/src/entities/container.entity.ts`: create desired container entity.
- `packages/backend/src/entities/container-runtime-observation.entity.ts`: create latest observed runtime entity.
- `packages/backend/src/entities/container-mount.entity.ts`: migrate or replace with desired mount spec entity keyed by `containerId`.
- `packages/backend/src/entities/container-mount-runtime.entity.ts`: create mount reconcile status entity.
- `packages/backend/src/entities/operation.entity.ts`: create durable operation entity.
- `packages/backend/src/entities/operation-step.entity.ts`: create operation step entity.
- `packages/backend/src/entities/agent-command-outbox.entity.ts`: create durable agent outbox entity.
- `packages/backend/src/entities/resource-lock.entity.ts`: create DB lock entity.
- `packages/backend/src/entities/reconcile-task.entity.ts`: create hook task entity.
- `packages/backend/src/entities/data-dir-runtime-observation.entity.ts`: create data dir observation/issue entity.
- `packages/backend/src/entities/remote-fs-runtime-observation.entity.ts`: create remote FS status entity.
- `packages/backend/src/entities/data-disk-runtime-observation.entity.ts`: create disk observation entity.
- `packages/backend/src/entities/quota-desired.entity.ts`: create absolute desired quota entity.
- `packages/backend/src/entities/quota-runtime-observation.entity.ts`: create quota usage observation entity.
- `packages/backend/src/database/db-entities.ts`: register all new entities and remove obsolete SSH enablement entity after migration.
- `packages/backend/src/database/migrations/<timestamp>-ContainerLifecycleControlPlane.ts`: add schema and migration/backfill scaffolding.

### Backend Services

- `packages/backend/src/common/locks/operation-lock.service.ts`: replace single-process lock with DB lock implementation or move to new `resource-locks` service.
- `packages/backend/src/gateway/agent-gateway.ts`: remove domain callback registration; persist hello/report/progress; route command progress to outbox/operations.
- `packages/backend/src/gateway/state-cache.ts`: deprecate as authority; either delete or convert to read-through cache backed by persisted observations.
- `packages/backend/src/gateway/agent-session.ts`: send `agentCommand` envelopes and handle progress correlation.
- `packages/backend/src/containers/containers.service.ts`: refactor into API facade that creates operations and reads desired/observed model.
- `packages/backend/src/containers/container-lifecycle-orchestrator.service.ts`: create operation state machine and lifecycle flows.
- `packages/backend/src/containers/container-read-model.service.ts`: create container list/get DTO builder from desired + observed + operations.
- `packages/backend/src/containers/container-mounts.service.ts`: refactor into mount desired service and hook task producer.
- `packages/backend/src/containers/container-ssh-enablements.service.ts`: delete or migrate into container desired SSH fields.
- `packages/backend/src/containers/container-ssh-sync.service.ts`: refactor into SSH hook producer/executor.
- `packages/backend/src/containers/containers.controller.ts`: return operation metadata; use `containerId` as canonical id.
- `packages/backend/src/datadirs/datadirs.service.ts`: create/delete desired data dir operations instead of immediate rollback RPC.
- `packages/backend/src/datadirs/data-dir-reconciler.service.ts`: replace cache-only issue computation with persisted observations and hook tasks.
- `packages/backend/src/remote-fs/remote-fs-mounts.service.ts`: enqueue remote FS hook tasks instead of best-effort dispatch.
- `packages/backend/src/servers/servers.service.ts`: enqueue disk/quota operations instead of direct reconnect callbacks and fire-and-forget quota notify.
- `packages/backend/src/users/users.service.ts`: replace in-memory SSH key callbacks with durable SSH hook task enqueueing.
- `packages/backend/src/containers/resource-quota.policy.ts`: calculate requested allocations from desired rows plus pending operation reservations, not `StateCache`.

### Agent

- `packages/agent/src/app.ts`: emit `RuntimeReportPayload` with report sequence and observed facts; stop reporting desired spec as authoritative.
- `packages/agent/src/commands/dispatcher.ts`: dispatch typed `agentCommand` payloads, emit operation progress, implement idempotent full-state commands.
- `packages/agent/src/docker/docker-client.ts`: create containers with `containerId`/generation labels; find existing containers by `containerId`; continue legacy discovery during migration.
- `packages/agent/src/dropbear/dropbear-manager.ts`: keep primitive but report reconcile progress and result in operation progress.
- `packages/agent/src/datadirs/data-dirs.ts`: support absolute desired data dir apply/delete and observed reports.
- `packages/agent/src/fs/remote-fs-mounter.ts`: keep primitive, make apply/remove idempotent by desired generation.
- `packages/agent/src/quota/xfs-quota.ts`: keep primitive, expose absolute quota apply result.

### Frontend

- `packages/frontend/src/hooks/use-container-actions.ts`: store operation ids, poll operation state, and derive pending state from backend.
- `packages/frontend/src/pages/container-detail-page.tsx`: display operation/stale/hook status for lifecycle, SSH, mounts, and stats without changing workflows.
- `packages/frontend/src/components/containers/container-row.tsx`: show durable pending/deleting/failed status from read model.
- `packages/frontend/src/components/containers/create-container-dialog.tsx`: handle create operation id and continue existing form behavior.
- `packages/frontend/src/components/containers/mounts-card.tsx`: show desired mount status and reconcile errors from backend.

### Tests

- `packages/backend/src/containers/__tests__/**`: replace state-cache expectations with desired/observed/operation tests.
- `packages/backend/src/gateway/__tests__/**`: add report ingestion, progress correlation, stale report sequence tests.
- `packages/agent/src/commands/dispatcher.test.ts`: add idempotency and progress tests for new command envelope.
- `packages/agent/src/docker/docker-client.test.ts`: add `containerId` label discovery and legacy import cases.
- `packages/frontend/e2e/**`: update snapshots only for operation/status visibility changes.

## Staged Implementation Plan

### Phase 1: Schema and Read Model

- Add desired, observed, operation, outbox, lock, and hook entities.
- Add migration/import service.
- Build read model from desired + observed rows.
- Keep old RPC paths temporarily but stop using read-path SSH backfill.

### Phase 2: Agent Protocol Cutover

- Add `agentCommand`, `operationProgress`, and `runtimeReport`.
- Agent supports both legacy reports and new reports during migration.
- Backend persists reports and command progress.

### Phase 3: Operation Orchestrator and Locks

- Implement DB locks, outbox worker, retry/backoff, operation steps, and status endpoints.
- Convert start/stop/restart/delete first because they have simple idempotency.

### Phase 4: Create and Delete Compensation

- Convert create to desired row + operation phases.
- Add Docker `containerId` label creation and legacy import binding.
- Add durable compensation for failed create.
- Convert delete cleanup to tombstone-after-agent-success.

### Phase 5: Hooks

- Convert mounts to full desired reconcile.
- Convert SSH enable/reconcile/key-change sync to durable hook tasks.
- Convert data dirs, remote FS, data disks, and quota to hook tasks.
- Attach audit status to operations.

### Phase 6: Frontend Observation

- Add operation polling and status display.
- Keep existing workflows: create dialog, row actions, detail page, mounts card, SSH buttons, stats, and exec.

### Phase 7: Remove Old Sources

- Remove `container_ssh_enablements` read overlay.
- Remove `StateCache` authority from list/get/quota.
- Remove direct gateway callback hooks.
- Remove full spec dependency on Docker labels.

## Acceptance Criteria

- Desired spec, observed runtime, command state, and hook state are represented by separate persisted models.
- Docker labels are not used as authoritative container spec after migration/import.
- Container create/start/stop/restart/delete/updateMounts/enableSSH/reconcileSSH/stats/exec preserve current user-facing workflows.
- All mutating lifecycle actions create durable operation records with visible status, attempts, result, and error.
- Agent commands are idempotent by operation/resource/generation and safe to retry after disconnects.
- Agent reports are monotonic observed facts and read paths expose stale/drift status instead of silently trusting memory.
- Mount ownership is explicit and no longer conflates actor id with data directory owner.
- SSH enablement is desired state, not a read-path overlay/backfill.
- Mounts, SSH, data dirs, remote FS, disks, quota, audit, and grant side effects use durable hook tasks with retry/status.
- Distributed locks work across backend processes with lease recovery.
- Migration/backfill imports current Docker labels, current DB mounts, SSH enablement rows, data dirs, disks, remote FS assignments, and quota observations.
- Tests cover operation retries, agent reconnects, create compensation, delete cleanup, stale observations, mount ownership, SSH key changes, remote FS/disk hooks, quota updates, and frontend operation visibility.

## Test Strategy

- Unit test operation state transitions, retry/backoff, DB lock fencing, and outbox timeout recovery.
- Unit test read model combinations: desired-only, observed-only, desired+observed, deleting, failed, stale, and drift.
- Unit test quota allocation from desired rows plus pending reservations.
- Unit test mount owner resolution from data directory rows and legacy unresolved imports.
- Unit test SSH migration from old labels/enablement rows and verify no read endpoint writes SSH rows.
- Integration test create success, create SSH failure compensation, create mount failure compensation policy, and delete cleanup.
- Integration test agent disconnect during sent command, backend restart with pending outbox, and retry after reconnect.
- Agent unit test each command idempotency case: already created, already running, already stopped, absent delete, repeated full mount reconcile, repeated SSH reconcile, repeated quota apply.
- Frontend tests verify action buttons survive refresh with operation status and existing workflows remain available.
- Visual tests are required only when frontend status UI changes are implemented.

## Risks and Trade-offs

- More schema and orchestration complexity: accepted because it replaces hidden timing assumptions with observable state.
- Asynchronous operations may expose intermediate states users did not previously see: mitigated by keeping current workflows and adding clear pending/result status.
- Legacy Docker labels are immutable: migration imports them once and then relies on DB desired state and dockerId binding.
- DB-backed locks depend on correct lease handling: use fencing tokens and conservative timeouts.
- Operation backlog can grow during long outages: add retention/cleanup policies after completed operations age out.
- Full mount reconcile is safer than single mount deltas but may do more work: accepted for idempotency and convergence.

Alternatives considered:

- Keep Docker labels as source of truth and patch callbacks: rejected because it preserves the core split-brain problem.
- Use only in-memory locks plus better callbacks: rejected because multi-process and restart gaps remain.
- Add Redis/queue as required infrastructure: rejected for first implementation; DB outbox and locks are sufficient and match current stack.
- Keep read-path SSH backfill: rejected because reads must be side-effect free.

## Out of Scope

- Adding new container features beyond the current feature set.
- Redesigning the UI beyond operation/status visibility needed for existing workflows.
- Requiring Redis, Kafka, or another external queue for the first implementation.
- Recreating existing Docker containers solely to rewrite immutable labels.
- Preserving internal schema, REST response, or agent RPC compatibility where it conflicts with the new architecture.

## Phase 13 (2026-06-03): Recoverable Outbox Worker and Resource Locks

### Goal

Make agent command rows recoverable through a leased outbox worker and DB-backed per-resource locks while preserving all current synchronous lifecycle call behavior.

### Interfaces Before/After

Before:

- `OperationsService.dispatchAgentCommand(input, execute)` creates `operations` and `agent_command_outbox` rows, writes the outbox row as `sent`, calls the supplied executor inline, then marks operation/outbox `succeeded` or `failed` before the caller returns.
- Existing callers depend on the inline executor and callback closures, including `beforePersist`, `onCommandSucceeded`, and `onCommandFailed`.
- `OperationsModule` exports only `OperationsService`.
- `AgentGateway.rpc(serverId, commandKind, payload, timeoutMs?)` is the direct transport API and generates its own transient WebSocket RPC id.
- `resource_locks` exists but is not used.

After for this slice:

- Keep `dispatchAgentCommand(input, execute)` behavior unchanged. Existing tests and return shapes continue to expect synchronous completion and `OperationStatus.Succeeded` on success.
- Add an opt-in enqueue-only API:

```ts
type EnqueueAgentCommandInput = Omit<
  DispatchAgentCommandInput,
  'onCommandSucceeded' | 'onCommandFailed'
>;

interface QueuedOperationResult {
  operationId: string;
  commandId: string;
  status: OperationStatus.Queued;
}

OperationsService.enqueueAgentCommand(
  input: EnqueueAgentCommandInput,
): Promise<QueuedOperationResult>;
```

- `enqueueAgentCommand` runs `beforePersist` inside the creation transaction, creates the operation as `queued` with `attempts=0`, creates the outbox row as `pending` with `attempts=0`, and does not call `AgentGateway.rpc`.
- The enqueue-only API intentionally does not accept ephemeral success/failure callbacks. A future phase can add durable domain completion handlers before migrating create/delete flows that must persist returned resource fields.
- Add `AgentCommandOutboxWorkerService`:

```ts
interface ProcessOneOptions {
  now?: Date;
}

interface ProcessBatchOptions extends ProcessOneOptions {
  limit?: number;
}

interface OutboxProcessResult {
  commandId: string;
  operationId: string;
  status: AgentCommandStatus;
  attemptedRpc: boolean;
  error?: string;
}

class AgentCommandOutboxWorkerService {
  processOne(options?: ProcessOneOptions): Promise<OutboxProcessResult | null>;
  processBatch(options?: ProcessBatchOptions): Promise<OutboxProcessResult[]>;
  start(): void;
  stop(): void;
}
```

- Add `ResourceLockService`:

```ts
interface ResourceLockLease {
  resourceKey: string;
  holderId: string;
  fencingToken: number;
  expiresAt: Date;
}

class ResourceLockService {
  tryAcquire(resourceKey: string, holderId: string, ttlMs: number, now: Date): Promise<ResourceLockLease | null>;
  refresh(lease: ResourceLockLease, ttlMs: number, now: Date): Promise<boolean>;
  release(lease: ResourceLockLease): Promise<void>;
}
```

- `AgentGateway.rpc` remains unchanged. The worker sends `command.commandKind` and `command.payload` through the existing RPC/`commandAck` path. No agent command envelope, protocol idempotency key, or progress protocol change is part of this slice.
- `GET /operations/:operationId` remains shape-compatible. It should continue to surface operation and command status/result/error fields from the existing read model.

### Data Model Changes

No schema or migration change is required in Phase 13.

The existing columns are sufficient:

- `agent_command_outbox.status`, `attempts`, `lastError`, `nextAttemptAt`, `leaseHolderId`, `leaseExpiresAt`, `sentAt`, `completedAt`
- `operations.status`, `attempts`, `result`, `lastError`, `startedAt`, `completedAt`
- `resource_locks.resourceKey`, `holderId`, `fencingToken`, `expiresAt`

Do not add enum values in this phase. Use the existing `AgentCommandStatus.Pending`, `WaitingAgent`, `Sent`, `Running`, `Retrying`, `Succeeded`, `Failed` and `OperationStatus.Queued`, `Running`, `WaitingAgent`, `Retrying`, `Succeeded`, `Failed`.

### File-Level Change List

- `packages/backend/src/operations/operations.service.ts`: modify to factor operation/outbox creation into shared helpers; keep `dispatchAgentCommand` semantics unchanged; add `enqueueAgentCommand` that creates queued operation and pending outbox rows without executing RPC.
- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`: create worker service with `processOne`, `processBatch`, optional interval `start/stop`, sequential processing, lease claim, RPC send, success/failure/retry persistence.
- `packages/backend/src/operations/resource-lock.service.ts`: create DB-backed lock service over `ResourceLockEntity` with acquire/refresh/release and fencing-token increment on acquisition.
- `packages/backend/src/operations/operation-retry-policy.ts`: create small retry helper for bounded exponential backoff and retryable RPC error classification.
- `packages/backend/src/operations/operations-worker.options.ts`: create worker options token/defaults for `workerId`, `autoStart`, `intervalMs`, `batchSize`, `leaseMs`, `resourceLockTtlMs`, `rpcTimeoutMs`, `maxAttempts`, `retryBaseMs`, and `retryMaxMs`.
- `packages/backend/src/operations/operations.module.ts`: modify to register `ResourceLockEntity`, import `AgentGatewayModule`, provide `ResourceLockService` and `AgentCommandOutboxWorkerService`, and export the worker service for focused tests/manual invocations.
- `packages/backend/src/operations/__tests__/operations.service.test.ts`: modify only by adding enqueue-only coverage and asserting existing `dispatchAgentCommand` tests still exercise inline `sent`/`succeeded` behavior.
- `packages/backend/src/operations/__tests__/agent-command-outbox-worker.service.test.ts`: create focused worker tests for success, offline waiting, retry scheduling, max-attempt failure, expired-lease recovery, resource-lock contention, and sequential batch processing.

### Worker State Transitions and Retry/Lease Rules

Initial enqueue:

1. `operations.status = queued`, `operations.attempts = 0`, `startedAt = null`, `completedAt = null`.
2. `agent_command_outbox.status = pending`, `attempts = 0`, `sentAt = null`, `completedAt = null`, `nextAttemptAt = null`, no lease.

Candidate selection:

- `processOne` selects the oldest due command with `completedAt IS NULL`.
- Eligible normal statuses are `pending`, `retrying`, and `waiting_agent` where `nextAttemptAt IS NULL OR nextAttemptAt <= now`.
- Eligible recovery statuses are `sent` or `running` only when `leaseHolderId IS NOT NULL` and `leaseExpiresAt <= now`.
- Ignore unleased `sent`/`running` rows. Existing synchronous inline dispatch creates such rows, and they are ambiguous after a crash.

Outbox lease claim:

1. Claim with a conditional update by command id and eligibility predicates. Set `leaseHolderId=<workerId>`, `leaseExpiresAt=now+leaseMs`, and `status=running`.
2. If the conditional update affects zero rows, another worker won the race; return `null` or continue to the next candidate in `processBatch`.
3. Do not hold a DB transaction while calling the agent.

Resource lock:

1. After claiming the outbox row, acquire `resource_locks` for `command.resourceKey`.
2. If no row exists, insert one with `fencingToken=1`.
3. If an existing row is expired, update it to the new holder and increment `fencingToken`.
4. If the existing row is unexpired, release the outbox lease, set command/operation to `retrying`, set a short `nextAttemptAt`, and do not count an RPC attempt.
5. Release the resource lock after success/failure/retry state is persisted. Release must be conditional on holder/fencing token so one worker cannot release another worker's renewed lock.

Agent offline:

1. If `AgentGateway.isOnline(serverId)` is false before RPC, set command `waiting_agent`, operation `waiting_agent`, clear leases, set capped `nextAttemptAt`, and release the resource lock.
2. Do not call `AgentGateway.rpc`.
3. Do not increment `attempts` for pre-send offline waits.

RPC attempt:

1. Before calling `AgentGateway.rpc`, update command `status=sent`, increment command and operation `attempts`, set `sentAt=now`, and set operation `status=waiting_agent` with `startedAt` if null.
2. Call `AgentGateway.rpc(command.serverId, command.commandKind, command.payload, rpcTimeoutMs)`.
3. Keep processing sequential by default. `processBatch` loops; it must not run multiple transactions or RPCs concurrently unless a later phase explicitly raises concurrency after SQLite coverage.

Success:

1. In one transaction, set command `succeeded`, clear command lease fields, clear `lastError`, set `completedAt`.
2. Set operation `succeeded`, store RPC result in `operations.result` with `undefined` normalized to `null`, clear `lastError`, set `completedAt`.
3. Release the resource lock after the success transaction.

Retryable failure:

1. For RPC timeout, disconnect, replaced session, transient transport errors, and generic agent RPC failures before `maxAttempts`, set command `retrying`, operation `retrying`, clear command lease fields, set `lastError`, and set `nextAttemptAt = now + boundedBackoff(attempts)`.
2. Backoff must be deterministic for tests: no jitter in Phase 13. Use exponential growth capped by `retryMaxMs`.
3. Release the resource lock after the retry transaction.

Terminal failure:

1. If attempts reach `maxAttempts`, set command `failed`, operation `failed`, clear command lease fields, set `lastError`, and set both `completedAt` values.
2. Release the resource lock after the failure transaction.
3. Do not run domain-specific `onCommandFailed` callback logic for queued commands in Phase 13.

Automatic startup:

- The worker may implement `OnModuleInit`, but interval processing must be controlled by an options provider.
- Tests must be able to disable timers with `autoStart=false` and call `processOne`/`processBatch` directly with a fixed `now`.
- Default concurrency is one to respect TypeORM + SQLite constraints observed in Phase 11.

### Resource Lock Decision

Include DB-backed resource lock usage in Phase 13, but scope it to the new outbox worker only.

Rationale:

- `resource_locks` already exists and every outbox row already has `resourceKey`, so the worker can serialize durable queued commands per resource without another schema slice.
- The implementation remains narrow because it does not replace `OperationLockService` in synchronous container routes.
- Replacing `OperationLockService` across current request paths is a separate behavioral migration because those paths currently use immediate 409 conflict semantics and inline RPC completion.

Alternative considered:

- Defer resource locks entirely and only add outbox leases. Rejected for Phase 13 because two due commands for the same resource could still execute concurrently after backend restart, which undermines the recoverable worker's primary safety property.

### Risks and Trade-offs

- Existing synchronous inline rows are not retroactively recoverable. This is intentional because current `sent` rows have no worker lease and may represent an RPC that was already delivered.
- Queued commands have no durable domain completion callbacks in this slice. Only operation/outbox status and operation result are updated; migrating create/delete or any command that must persist returned resource fields needs a follow-up handler design.
- Existing agent RPC payloads do not carry the durable outbox command id or idempotency key. Only commands whose current payload/effect is safe to retry should opt into `enqueueAgentCommand` before the protocol envelope phase.
- A resource lock TTL shorter than the RPC timeout can allow duplicate execution after lease expiry. Worker defaults should validate `resourceLockTtlMs > rpcTimeoutMs` with margin.
- SQLite lacks `SKIP LOCKED`; conditional updates and sequential default processing are required to keep tests deterministic and avoid concurrent transaction failures.
- Automatic interval startup can make tests flaky if not disabled. The options token and direct process methods are part of the acceptance criteria.

### Acceptance Criteria

- Existing `OperationsService.dispatchAgentCommand` tests continue to pass without changed expectations for inline executor timing, row statuses during executor execution, returned `OperationStatus.Succeeded`, success hooks, or failure hooks.
- `OperationsService.enqueueAgentCommand` creates an operation with `queued` status and a command with `pending` status, returns `operationId` and `commandId`, runs `beforePersist`, and never calls `AgentGateway.rpc`.
- `AgentCommandOutboxWorkerService.processOne({ now })` processes one due pending command through lease claim, resource lock acquisition, existing `AgentGateway.rpc`, and persisted operation/outbox success.
- When the agent is offline before send, the worker marks command and operation `waiting_agent`, sets a due retry time, releases all leases/locks, does not increment attempts, and does not call RPC.
- Retryable RPC failure increments attempts, records `lastError`, schedules deterministic capped exponential backoff, clears leases, releases the resource lock, and leaves the operation visible as `retrying`.
- A command whose attempts reach `maxAttempts` is marked `failed` with `completedAt`, and its operation is also marked `failed` with matching `lastError`.
- Expired leased `sent` or `running` rows are eligible for retry, but unleased `sent` or `running` rows from current synchronous dispatch are ignored by the worker.
- Two queued commands with the same `resourceKey` do not execute concurrently; resource-lock contention reschedules the loser without counting an RPC attempt.
- `processBatch` processes commands sequentially by default and is testable without real timers by passing fixed `now` and `autoStart=false`.
- The operation visibility endpoint shape remains compatible and can display queued/running/waiting/retrying/succeeded/failed command state from existing operation/outbox rows.

### Out of Scope

- Migrating existing container, data dir, data disk, remote FS, or quota call sites from inline `dispatchAgentCommand` to `enqueueAgentCommand`.
- Changing agent protocol, adding durable command envelopes, or sending outbox `commandId`/`idempotencyKey` to the agent.
- Adding durable domain completion handler registries for queued command success/failure.
- Replacing `OperationLockService` in current synchronous routes or changing their 409 conflict behavior.
- Implementing worker concurrency greater than one.
- Adding cleanup/retention jobs for old operations, old outbox rows, or expired resource lock rows beyond opportunistic expired-lock takeover.
- Running tests/builds in the architect phase.

## Consolidated Completion Plan

This section supersedes the narrow Phase 13 worker-only slice above. The remaining work should be delivered as a complete architecture replacement in at most two development rounds, followed by test/regression rounds. Do not continue with small per-module durable patches.

### Goal

Complete the container lifecycle architecture by replacing the old direct RPC/cache/callback paths with one durable desired/observed/command/reconcile control plane while keeping the same user-facing workflows available.

### Final Architecture Boundary

#### Desired State

- The backend database is the only authority for desired lifecycle state.
- Desired state includes containers, container power intent, lifecycle phase, container mount specs, SSH desired enablement and generations, data directories, remote filesystem assignments, data disks, quota desired limits, grants-derived quota targets, and any operation reservations needed for admission checks.
- Mutating API handlers validate policy and then write desired-state changes plus operation/reconcile work in one transaction. They do not call the agent directly.
- Docker `dockerId` is an observed binding, not the resource identity. Backend APIs and frontend state should use backend `containerId` as the canonical container id after completion.

#### Observed State

- Agent reports are persisted observed facts: runtime containers, stats, data dirs, disks, remote FS mount status, Docker daemon state, SSH runtime state, and quota usage.
- Observations are monotonic by report sequence or observed timestamp where available.
- `StateCache` is not an authority for reads, quota, GPU allocation, mount decisions, SSH decisions, or delete guards. It may be deleted or retained only as a transport-local optimization whose data is also persisted before use.
- Read models join desired rows, latest observations, and latest operation state. Read endpoints are side-effect free.

#### Command State

- Every lifecycle or hook side effect is represented by `operations`, optional `operation_steps`, and `agent_command_outbox` rows.
- `OperationOrchestrator` owns operation creation, step creation, command enqueue, operation completion, compensation, retry policy, and operation read visibility.
- `AgentCommandOutboxWorker` owns command leasing, DB resource-lock acquisition, agent delivery, progress/ack handling, retries, stale lease recovery, and terminal success/failure updates.
- `resource_locks` serializes execution by `resourceKey` across backend processes. The old in-process lock can be removed after request paths no longer execute inline RPCs.
- Operation state is durable enough that backend restart, agent disconnect, and worker crash leave inspectable queued/waiting/retrying state and recover through the worker.

#### Hook/Reconcile State

- `LifecycleHookRegistry` is the single producer/router for reconcile work.
- Hook work is represented by durable `reconcile_tasks` and operation steps, not by `setImmediate` callbacks or best-effort service calls.
- Hook triggers are desired-state writes, full runtime reports, agent reconnects, container running observations, user SSH key changes, grant/default changes, disk changes, remote FS assignment changes, data dir reports, and manual reconcile requests.
- Hook executors produce agent commands through the same orchestrator/outbox path as user operations.
- Hooks are idempotent and send absolute desired state whenever possible: full mount set, full SSH key set/hash, absolute quota, full disk apply, full remote FS apply, and desired data dir create/delete.

#### Agent Transport and Envelope

- `AgentGateway` is transport plus report/progress ingestion only.
- Backend-to-agent lifecycle commands use one durable command envelope:

```ts
interface AgentCommandEnvelope<K extends string = string, P = unknown> {
  operationId: string;
  commandId: string;
  commandKind: K;
  idempotencyKey: string;
  resourceKey: string;
  desiredGeneration: number | null;
  payload: P;
}
```

- Agent-to-backend progress uses one operation progress payload:

```ts
interface OperationProgressPayload {
  operationId: string;
  commandId: string;
  status: 'accepted' | 'running' | 'waiting_observed' | 'succeeded' | 'failed' | 'not_applicable';
  step: string;
  data?: unknown;
  error?: string;
  ts: number;
}
```

- Final command acknowledgement may be represented as the terminal progress event or by a compatibility `commandAck` bridge during Round 1. By completion, lifecycle correctness must not depend on the old direct WebSocket command ids.
- Agent command implementations remain the primitive Docker/host operations, but they are reached through the envelope dispatcher and must be idempotent by resource identity, generation, and desired payload.

#### Frontend Operation Visibility

- Mutating workflows remain available: create, start, stop, restart, delete, update mounts, enable/reconcile SSH, data dir create/delete, remote FS create/update/delete/remount/assignment, disk apply/remove, quota side effects, stats, exec, and audit visibility.
- Mutating responses may change identifiers or internals, but must return enough operation metadata for the frontend to show pending/progress/failure after refresh.
- Frontend pending state is derived from backend operation/read-model state, not local-only mutation state.
- Existing explicit transient workflows remain allowed outside durable lifecycle command state: exec stream and direct stats fetch. Their list/detail side effects still persist observations when they fetch runtime facts.

### Legacy Paths To Remove Or Replace

Replace these paths with orchestrator/reconcile/outbox flows:

- Direct lifecycle `agentGateway.rpc` from `packages/backend/src/containers/containers.service.ts` for create/start/stop/restart/delete and create compensation delete.
- Direct mount RPCs from `packages/backend/src/containers/container-mounts.service.ts`: `applyContainerMount`, `removeContainerMount`, and `reconcileContainerMounts`.
- Direct SSH RPCs from `packages/backend/src/containers/container-ssh-sync.service.ts`: `reconcileContainerSsh`.
- Direct data directory RPCs from `packages/backend/src/datadirs/datadirs.service.ts`: `createDataDir` and `deleteDataDir`.
- Direct remote FS RPCs from `packages/backend/src/remote-fs/remote-fs-mounts.service.ts`: `applyRemoteFsMount` and `removeRemoteFsMount`.
- Direct disk RPCs from `packages/backend/src/servers/servers.service.ts`: `applyDataDisk` and `removeDataDisk`.
- Direct quota `agentGateway.notify`/`rpc` paths from `packages/backend/src/containers/containers.service.ts`, `packages/backend/src/servers/servers.service.ts`, `packages/backend/src/groups/groups.service.ts`, and `packages/backend/src/quota/quota-dispatch.service.ts`.
- AgentGateway callback registration and `setImmediate` hook execution: `registerOnConnect`, `registerOnStateReport`, `registerOnContainerStart`, `registerOnDataDirReport`, and their callback arrays in `packages/backend/src/gateway/agent-gateway.ts`.
- `setImmediate` SSH key change callbacks from `packages/backend/src/users/users.service.ts`.
- Read-path `stateCache` authority/fallback in container list/detail, quota/GPU admission, data-dir delete guards, mount reconcile decisions, SSH reconcile decisions, and hostname/runtime fallback.
- Read-path SSH enablement label backfill in `packages/backend/src/containers/container-ssh-enablements.service.ts`.
- Docker-label source-of-truth behavior in common constants, agent create payloads, backend observation import, and read models. Labels are limited to identity/discovery/import hints after completion.
- Optional `operationsService` fallbacks that revert to direct notify/RPC when the service is absent. After completion, lifecycle/hook services require the orchestrator.

Allowed direct transport exceptions after completion:

- Exec stream input/resize/close remains transient.
- Explicit stats fetch may use a short RPC and persist the fetched observation.
- Admin-only Docker daemon reconcile can remain transient unless product requirements later require operation visibility for it.

### Compatibility Stance

- Backward compatibility with old internal command paths, old WebSocket command unions, old Docker-label spec fields, old `dockerId`-first route internals, and old response internals is not required.
- Public product functionality must remain available. Users must still be able to perform the same workflows from the UI/API, with operation status replacing hidden synchronous timing assumptions.
- Existing data must be migrated or imported. The replacement may change canonical identifiers to `containerId`, but current containers, mounts, SSH desired state, data dirs, disks, remote FS assignments, grants, quota settings, audit history, and runtime observations must remain usable.
- Compatibility shims may exist inside Round 1 only to keep development coherent. Round 2 must remove fallback execution through the old lifecycle path.

### Development Rounds

#### Round 1: Core Command Orchestration Replacement

Deliver one coherent control-plane replacement that all lifecycle/hook commands use.

- Implement `OperationOrchestrator`, `AgentCommandOutboxWorker`, `ResourceLockService`, retry policy, stale lease recovery, command completion handlers, compensation handlers, and operation step transitions.
- Implement common/backend/agent command envelope and operation progress protocol. The agent dispatcher routes envelope `commandKind` values to existing Docker/host primitives and emits durable progress/final result.
- Convert all lifecycle and hook side effects to create operations/reconcile tasks/outbox commands instead of direct `agentGateway.rpc/notify`.
- Convert container create/start/stop/restart/delete to desired-state writes plus orchestrator commands. Create persists desired state before delivery; success binds observed `dockerId`/IP; failure uses durable compensation. Delete keeps desired tombstone until command success and then performs DB cleanup.
- Convert mounts, SSH, data dirs, remote FS, data disks, and quota to hook/reconcile commands sent through the same outbox worker.
- Replace best-effort quota/disk/remote-fs/data-dir/SSH apply paths and reconnect callbacks with durable tasks.
- Keep read endpoints functional during the round, but do not add new old-path dependencies. Any temporary adapter must feed the new operation/outbox state.
- Keep worker processing sequential by default for SQLite, with deterministic `processOne`/`processBatch` methods for tests and an app-level interval/trigger for runtime.

Round 1 is complete only when a grep of backend lifecycle/hook services shows no direct `agentGateway.rpc/notify` for lifecycle or hook commands outside the allowed transient exceptions.

#### Round 2: Full Reconcile, Read, And Write Cleanup

Remove the old authority paths and complete convergence.

- Remove `StateCache` as read authority and remove durable-read fallbacks to cache-only containers. Container list/detail, quota/GPU admission, delete guards, mount decisions, and SSH decisions use persisted desired/observed state.
- Complete full-report import and observation persistence for containers, data dirs, disks, remote FS, Docker daemon state, SSH runtime state, quota usage, and legacy Docker-label containers.
- Remove read-path SSH label backfill and fold SSH desired state into container desired fields.
- Make `LifecycleHookRegistry` the only trigger path for reconnect/full report/container running/user key/grant/default/disk/remote-FS/data-dir changes.
- Remove old AgentGateway callback arrays and `setImmediate` hook execution.
- Remove old direct WebSocket lifecycle command unions and old Docker-label spec constants after the envelope dispatcher and import path are stable.
- Update frontend actions and routes to consume operation ids/status from backend read models. If canonical route identifiers change from `dockerId` to `containerId`, update route params and navigation in the same round.
- Remove optional orchestrator fallbacks and any temporary Round 1 compatibility adapters.
- Update operation visibility so frontend and API clients can inspect current operation, steps, commands, attempts, next retry time, last error, stale/drift state, and final result.

Round 2 is complete only when the old lifecycle path cannot execute a host mutation even if called accidentally.

### Implementation Sequencing Instructions

- Dispatch the next developer subagent with this consolidated plan as the active design, not the superseded Phase 13 slice.
- The preferred implementation shape is one developer subagent that performs all Development Round 1 and Development Round 2 source changes in one coordinated pass, then hands off to tester/devops for regression.
- If one pass is too large for a single developer turn, split only by disjoint write ownership and integration boundaries, for example backend/common/agent orchestration first and frontend operation visibility second. Do not split into module-sized feature drips such as "quota only", "remote FS only", or "SSH only".
- Any split must still preserve the architecture invariant that old direct lifecycle/hook host mutation paths are removed before the work is considered complete.
- Tester/devops should run regression only after the consolidated source change lands, not after each small domain migration.

### File-Level Change List By Subsystem

#### Common Protocol And Types

- `packages/common/src/enums.ts`: modify only if status/kind gaps remain after consolidating operation/hook command kinds.
- `packages/common/src/constants.ts`: replace full desired-spec Docker labels with identity/discovery labels and legacy import constants.
- `packages/common/src/protocol/agent-messages.ts`: create envelope, progress, runtime report, and desired absolute command payload schemas; remove or deprecate old direct lifecycle command payloads by Round 2.
- `packages/common/src/protocol/ws.ts`: change backend-to-agent lifecycle messages to the command envelope and agent-to-backend progress/report messages.
- `packages/common/src/protocol/rest.ts`: define canonical operation DTOs, container read-model operation summaries, stale/drift fields, and containerId-based operation refs.
- `packages/common/src/protocol/rest-schema.ts`: update route schemas for operation refs, containerId params where used, and operation visibility payloads.

#### Backend Orchestration And Locks

- `packages/backend/src/operations/operation-orchestrator.service.ts`: create operation/step/task/command orchestration API and domain completion/compensation hooks.
- `packages/backend/src/operations/agent-command-outbox-worker.service.ts`: create leased outbox worker with resource locks, retries, progress/ack completion, and deterministic process methods.
- `packages/backend/src/operations/resource-lock.service.ts`: create DB-backed resource lock implementation over `resource_locks`.
- `packages/backend/src/operations/reconcile-task-worker.service.ts`: create durable hook task worker that invokes hook handlers and enqueues outbox commands.
- `packages/backend/src/operations/operation-retry-policy.ts`: create bounded retry classification/backoff shared by command and reconcile workers.
- `packages/backend/src/operations/operations.service.ts`: refactor existing helper into orchestrator-facing operation read/query support or remove inline dispatch after callers migrate.
- `packages/backend/src/operations/operations.controller.ts`: ensure operation detail endpoint exposes steps, commands, retry timing, result, and errors.
- `packages/backend/src/operations/operations.module.ts`: register orchestrator, workers, locks, entities, and gateway transport dependency.
- `packages/backend/src/common/locks/operation-lock.service.ts`: delete or limit to non-lifecycle diagnostics after DB resource locks replace request-path serialization.

#### Backend Gateway And Observed State

- `packages/backend/src/gateway/agent-gateway.ts`: remove domain callback registration/execution; persist hello/report/progress; deliver envelopes; keep direct transport exceptions isolated.
- `packages/backend/src/gateway/agent-session.ts`: support durable command envelope send/correlation and final progress/ack handling without old direct lifecycle ids.
- `packages/backend/src/gateway/state-cache.ts`: delete or demote to transport cache that is never read as authority.
- `packages/backend/src/gateway/container-runtime-observation-writer.service.ts`: complete observed import, legacy label import, stale/missing detection, and desired row import rules.
- `packages/backend/src/gateway/agent-gateway.module.ts`: export only transport/observation/progress services needed by orchestration.

#### Backend Containers And Read Model

- `packages/backend/src/containers/containers.service.ts`: convert public mutating methods to desired-state transactions plus orchestrator operations; remove direct RPC/notify, stateCache authority, docker-label spec dependence, and inline compensation.
- `packages/backend/src/containers/containers.controller.ts`: use canonical operation refs and containerId route semantics where required; keep user workflows available.
- `packages/backend/src/containers/container-read-model.service.ts`: make desired+observed+operation the only source for list/detail/status/stale/drift.
- `packages/backend/src/containers/container-mounts.service.ts`: become desired mount spec writer and hook producer; remove direct agent mount RPCs.
- `packages/backend/src/containers/container-ssh-sync.service.ts`: become SSH hook handler/command payload builder; remove direct agent RPCs and callback registration.
- `packages/backend/src/containers/container-ssh-enablements.service.ts`: delete or migrate into container desired SSH fields; remove read-path label backfill.
- `packages/backend/src/containers/resource-quota.policy.ts`: calculate usage/admission from desired rows, observations, and pending operation reservations, not stateCache.
- `packages/backend/src/containers/container-reconcile-task.service.ts`: merge into or adapt behind `LifecycleHookRegistry`.

#### Backend Data Dirs, Remote FS, Disks, Quota, Grants, Users

- `packages/backend/src/datadirs/datadirs.service.ts`: write desired data-dir state and operation/reconcile tasks; remove direct create/delete RPC.
- `packages/backend/src/datadirs/data-dir-reconciler.service.ts`: persist observations/issues and produce hook tasks through registry.
- `packages/backend/src/remote-fs/remote-fs-mounts.service.ts`: write desired remote FS/assignment state and hook tasks; remove direct apply/remove RPC.
- `packages/backend/src/servers/servers.service.ts`: convert disk apply/remove and server-triggered quota work to operations/tasks; remove direct disk RPC and quota notify.
- `packages/backend/src/quota/quota-dispatch.service.ts`: become quota desired/task producer or hook handler; remove optional direct notify/RPC fallback.
- `packages/backend/src/groups/groups.service.ts`: replace grant/default quota notify with quota desired recompute and hook task enqueue.
- `packages/backend/src/users/users.service.ts`: replace SSH key `setImmediate` callbacks with SSH hook task enqueue.

#### Backend Database And Entities

- `packages/backend/src/entities/reconcile-task.entity.ts`: finalize durable reconcile task fields if current skeleton is insufficient.
- `packages/backend/src/entities/operation.entity.ts`, `operation-step.entity.ts`, `agent-command-outbox.entity.ts`, `resource-lock.entity.ts`: adjust only if orchestration needs missing fields; otherwise keep existing schema.
- `packages/backend/src/entities/container.entity.ts` and runtime observation entities: ensure desired/observed fields cover all read-model and import needs.
- `packages/backend/src/database/db-entities.ts`: register final entity set and remove obsolete entities after migration.
- `packages/backend/src/database/migrations/*`: add any migration needed for final fields, one-time import markers, obsolete table cleanup, and canonical identifier transition.

#### Agent

- `packages/agent/src/app.ts`: emit final runtime report payloads and operation progress; route envelope messages to dispatcher.
- `packages/agent/src/commands/dispatcher.ts`: implement envelope command dispatcher, idempotency, progress, and final result handling.
- `packages/agent/src/docker/docker-client.ts`: create/find/delete containers by backend `containerId` labels and desired payload; stop treating full spec labels as desired state.
- `packages/agent/src/dropbear/dropbear-manager.ts`: expose idempotent SSH reconcile primitive with progress/result.
- `packages/agent/src/datadirs/data-dirs.ts`: expose idempotent absolute data-dir apply/delete and observations.
- `packages/agent/src/fs/remote-fs-mounter.ts`: expose idempotent remote FS apply/remove and observations.
- `packages/agent/src/quota/xfs-quota.ts`: expose absolute quota apply and usage observation.

#### Frontend

- `packages/frontend/src/hooks/use-container-actions.ts`: derive pending/progress/failure from operation state returned by backend instead of local-only pending sets.
- `packages/frontend/src/routes/containers/index.tsx`: render operation-aware rows and use canonical ids.
- `packages/frontend/src/routes/containers/$serverId.$dockerId.tsx` or replacement route: migrate detail route if canonical id changes.
- `packages/frontend/src/components/containers/create-container-dialog.tsx`: handle create operation refs and desired/observed pending states.
- `packages/frontend/src/components/containers/mounts-card.tsx`: show desired mount state and reconcile errors from backend read model.
- `packages/frontend/src/pages/manage-remote-fs-page.tsx`, `data-dirs-page.tsx`, `servers-page.tsx`, groups/users/grants pages as needed: trigger durable operations/tasks and display operation/reconcile status where workflows currently assume immediate side effects.

#### Tests And Regression

- `packages/backend/src/**/__tests__/**` and focused `*.test.ts`: replace direct-RPC/cache/backfill expectations with desired/observed/operation/reconcile assertions.
- `packages/backend/src/gateway/__tests__/**`: cover envelope delivery, progress persistence, full report import, reconnect triggers, and absence of domain callbacks.
- `packages/agent/src/**/*.test.ts`: cover envelope dispatch and idempotent command primitives.
- `packages/frontend/e2e/**`: update only if frontend operation visibility or route identifiers change rendered output.
- `scripts/check.sh` and visual check are run by tester/devops after implementation, not by architect.

### Architecture-Complete Acceptance Criteria

- All lifecycle and hook host mutations create durable operation/reconcile/outbox records before agent delivery.
- Backend lifecycle/hook services contain no direct `agentGateway.rpc/notify` host mutations outside allowed exec/stats/admin transient exceptions.
- `AgentGateway` no longer owns domain callback arrays or `setImmediate` hook execution.
- All backend-to-agent lifecycle/hook commands use the durable command envelope and outbox worker.
- Agent emits operation progress/final results correlated by durable `operationId` and `commandId`.
- Outbox worker uses command leases and DB resource locks, retries transient failures, recovers expired leased commands, and records terminal operation/command result or error.
- Reconcile hooks for mounts, SSH, data dirs, remote FS, data disks, quota, grants, and user SSH key changes are durable tasks with visible status and retry behavior.
- Container create persists desired state first, binds observed `dockerId` on success, and performs durable compensation on required-step failure.
- Container delete keeps desired tombstone until agent success and only then performs mount/SSH/runtime cleanup.
- Container list/detail, quota/GPU admission, delete guards, mount decisions, and SSH decisions use persisted desired/observed/operation state, not `StateCache`.
- Read endpoints are side-effect free and perform no SSH or Docker-label backfill.
- Docker labels are used only for identity/discovery/import hints; desired spec is never sourced from labels after import.
- Full runtime reports persist observations and enqueue reconcile work for drift, reconnect, missing runtime, and legacy import cases.
- Frontend mutating workflows remain available and show operation pending/progress/failure after page refresh.
- Existing data is migrated/imported so current containers, mounts, SSH desired state, data dirs, disks, remote FS assignments, grants, quota, audit, and observations remain usable.
- Root regression gate is green after implementation, including frontend visual checks if rendered output changes.

### Deliberately Out Of Scope After Completion

- Making exec stream durable. Exec remains a transient console workflow with orphan cleanup.
- Requiring Redis, Kafka, or another external queue. DB outbox/locks remain the implementation boundary.
- Preserving old external API/agent protocol compatibility for clients that bypass the frontend.
- Recreating existing Docker containers solely to rewrite immutable labels.
- Large UI redesign beyond operation visibility and identifier/route adjustments required to keep workflows usable.
- Long-term operation retention/archival policy beyond what is needed for correctness and tests.

### Risks And Rollback Strategy

Risks:

- The change is cross-cutting and will invalidate many tests that currently assert direct RPC/cache behavior.
- Data migration/import mistakes can orphan existing containers or lose SSH/mount desired state.
- Agent/backend protocol mismatch can stall all lifecycle commands until both sides are deployed together.
- Retry without correct idempotency can duplicate host side effects for non-absolute commands.
- Removing `StateCache` authority can expose missing observation fields that old reads silently filled from memory.
- Canonical identifier changes can break frontend routes or external clients even though product workflows remain available.

Rollback strategy:

- Do not keep a long-lived runtime fallback to the old lifecycle path; that would preserve the architecture split.
- Before migration, take a database backup and capture a full agent runtime report for each server.
- Round 1 may keep temporary internal adapters only to complete the architectural sweep, but Round 2 must delete them before declaring completion.
- If Round 1 fails before schema/data migration is applied, revert code to the previous green root gate.
- If Round 1 or Round 2 fails after migration/import, rollback requires restoring the database backup and deploying the previous backend/agent/frontend together.
- Keep operation/outbox/reconcile records inspectable during rollout so failed commands can be diagnosed and replayed after a fix instead of manually mutating host state.
