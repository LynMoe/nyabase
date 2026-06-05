# Design: Dropbear SSH Rework

Status: PENDING_USER_REVIEW
Session: 20260602T081822Z

## Goal

Replace nyabase's one-shot SSH key injection with an opt-in, Dropbear-managed, public-key-only root SSH subsystem that is reconciled through container lifecycle and user key changes.

## Current Legacy Behavior To Remove

- `CreateContainerRequest.sshUser` and `CreateContainerRequest.sshUid`.
- `CreateContainerPayload.sshUser`, `CreateContainerPayload.sshUid`, and `CreateContainerPayload.sshPubKeys`.
- `ContainerSpec.sshUser` and `ContainerSpec.sshUid`.
- Docker labels `nyabase.ssh_user` and `nyabase.ssh_uid` as parsed/written nyabase spec fields.
- Agent `injectSshKeys`, `SAFE_USERNAME_RE`, and the `/home/<sshUser>/.ssh/authorized_keys` flow.
- Backend create-time user key fetch that only sends keys once inside `createContainer`.
- Frontend wording and display that imply legacy user/UID SSH access.

Legacy labels may remain on already-created Docker containers as inert historical data, but new code must not depend on them or report them as SSH state.

## Architecture Overview

SSH becomes a per-container runtime service controlled by a durable one-way enablement state:

- The container create API accepts `sshServerEnabled?: boolean`, defaulting to `false`.
- Containers created with SSH disabled can later transition to enabled through a dedicated REST operation.
- Once enabled, there is no disable API, UI, RPC, or agent command.
- SSH-enabled containers expose a manual repair/reconcile operation that re-applies keys, binary, permissions, and Dropbear process state.
- Manual reconcile is not an enable/toggle operation; disabled containers must use the one-way enable operation first.
- The backend persists effective SSH enablement in a database table keyed by `(serverId, dockerId)`.
- Docker labels remain a creation-time hint and compatibility fallback, not the durable source of truth.
- Backend REST responses overlay the durable DB state onto label-derived agent snapshots before exposing `ContainerSpec.sshServerEnabled`.
- The backend database remains the source of truth for user public keys.
- A backend `ContainerSshSyncService` pushes the current public-key set to running SSH-enabled containers:
  - immediately after an SSH-enabled container is created;
  - immediately after SSH is enabled post-create for a running container;
  - when a user manually reconciles an enabled container;
  - after user SSH key add/delete;
  - after container start/restart events;
  - after the first full state report on agent connect/reconnect.
- The agent owns all in-container Dropbear work through a new `DropbearManager`:
  - copy or update the static Dropbear binary;
  - write `/root/.ssh/authorized_keys`;
  - ensure root-only permissions;
  - start Dropbear if missing;
  - avoid restarting Dropbear for key-only changes.

This intentionally separates two previously coupled concerns:

- SSH service enablement, runtime setup, and key sync use Dropbear-specific contracts.
- Data directory ownership uses the selected image UID through a non-SSH contract.

## Interfaces

### REST API

`packages/common/src/protocol/rest-schema.ts`

Before:

```ts
zCreateContainerRequest = z.object({
  ...
  sshUser: z.string().regex(LINUX_USER_RE).optional(),
  sshUid: z.number().int().min(1000).optional(),
});
```

After:

```ts
zCreateContainerRequest = z.object({
  ...
  sshServerEnabled: z.boolean().optional(),
});
```

Rules:

- `sshServerEnabled` defaults to `false` in backend service logic.
- No REST create request may accept a UID for SSH or data-directory ownership.
- Add a one-way enable operation:

```http
POST /containers/:serverId/:dockerId/ssh/enable
```

```ts
type EnableContainerSshResponse = {
  ok: true;
  enabled: true;
  reconciled: boolean;
  error?: string;
};
```

- The enable operation uses the same owner-or-`ManageContainersAny` authorization as start/stop/delete.
- The request body is empty.
- Repeated calls are idempotent: they keep the row enabled and retry reconciliation if the container is running.
- If the container is stopped, the endpoint persists enablement and returns `reconciled: false`; reconciliation runs on the next start/full state report.
- If the container is running and setup fails, enablement remains persisted; the endpoint returns `ok: true`, `enabled: true`, `reconciled: false`, and an error message for UI/status display. Future lifecycle/key-change sync retries.
- No disable endpoint exists.
- Add a manual reconcile operation for enabled containers:

```http
POST /containers/:serverId/:dockerId/ssh/reconcile
```

```ts
type ReconcileContainerSshResponse = {
  ok: true;
  enabled: true;
  reconciled: boolean;
  status: 'reconciled' | 'container_stopped' | 'agent_offline' | 'failed';
  error?: string;
};
```

- The reconcile operation uses the same owner-or-`ManageContainersAny` authorization as start/stop/delete.
- The request body is empty.
- The operation is available only when effective SSH state is enabled. If disabled, return HTTP 409 Conflict with a message such as `SSH is not enabled for this container`; do not create an enablement row.
- If the container is stopped, return `200` with `status: 'container_stopped'` and `reconciled: false`; no in-container work is attempted, and normal start/full-state-report reconciliation remains responsible for the next repair.
- If the agent is offline, return `200` with `status: 'agent_offline'` and `reconciled: false`; no durable state changes are made.
- If the container is running and the agent is online, fetch current public keys and call `reconcileContainerSsh`.
- If reconciliation succeeds, return `status: 'reconciled'` and `reconciled: true`.
- If reconciliation fails, keep SSH enabled and return `status: 'failed'`, `reconciled: false`, and `error`; future lifecycle/key-change/manual sync can retry.
- User SSH key CRUD routes keep the same URL and body shapes, but successful add/delete becomes a synchronization trigger.

`ContainerDto` continues to extend `ContainerSnapshot`; backend controllers must return an effective snapshot where `ContainerSpec.sshServerEnabled` is overlaid from durable DB state plus any creation-time label hint, and `ContainerSnapshot.sshServer` reflects the effective enabled state.

### Agent Protocol

`packages/common/src/protocol/agent-messages.ts`

Container spec before:

```ts
zContainerSpec = z.object({
  ...
  sshUser: z.string(),
  sshUid: z.number().int(),
  ...
});
```

Container spec after:

```ts
zContainerSpec = z.object({
  ...
  sshServerEnabled: z.boolean(),
  ...
});
```

Add runtime SSH state to snapshots:

```ts
const zContainerSshServerStatus = z.enum([
  'disabled',
  'container_stopped',
  'running',
  'error',
  'unknown',
]);

const zContainerSshServerState = z.object({
  enabled: z.boolean(),
  status: zContainerSshServerStatus,
  user: z.literal('root'),
  port: z.literal(22),
  pid: z.number().int().positive().optional(),
  keyHash: z.string().optional(),
  lastReconciledAt: z.number().optional(),
  lastError: z.string().optional(),
});

zContainerSnapshot = z.object({
  spec: zContainerSpec,
  status: zContainerStatus,
  stats: zContainerStatsSummary.nullable(),
  sshServer: zContainerSshServerState,
});
```

Create payload before:

```ts
zCreateContainerPayload = z.object({
  ...
  createDirs: z.array(z.object({
    sourceKind: z.enum(['local', 'remote']),
    sourceId: z.string(),
    dirName: z.string(),
    createIfMissing: z.boolean(),
  })).default([]),
  sshUser: z.string(),
  sshUid: z.number().int(),
  sshPubKeys: z.array(z.string()),
  ...
});
```

Create payload after:

```ts
zCreateContainerPayload = z.object({
  ...
  createDirs: z.array(z.object({
    sourceKind: z.enum(['local', 'remote']),
    sourceId: z.string(),
    dirName: z.string(),
    createIfMissing: z.boolean(),
    ownerUid: z.number().int().nonnegative(),
  })).default([]),
  sshServerEnabled: z.boolean().default(false),
  ...
});
```

Add backend-to-agent command:

```ts
zReconcileContainerSshPayload = z.object({
  dockerId: z.string(),
  publicKeys: z.array(z.string()),
  expectedKeyHash: z.string().optional(),
});
```

Add to `BackendToAgentMessage`:

```ts
| Envelope<'reconcileContainerSsh', ReconcileContainerSshPayload>
```

Notes:

- The key array is intentionally named `publicKeys`, not `sshPubKeys`, to avoid carrying the legacy create-time injection contract forward.
- `expectedKeyHash` is optional. It lets the backend and tests assert the exact key generation being applied, but the agent can compute its own hash from `publicKeys`.
- `startContainer` and `restartContainer` payloads do not include keys. Reconciliation is a separate lifecycle command.

### Docker Labels And Spec Version

`packages/common/src/constants.ts`

Before:

```ts
SSH_USER: 'nyabase.ssh_user',
SSH_UID: 'nyabase.ssh_uid',
SPEC_VERSION = '1',
```

After:

```ts
SSH_SERVER_ENABLED: 'nyabase.ssh_server_enabled',
SPEC_VERSION = '2',
```

Rules:

- New containers write `nyabase.ssh_server_enabled` as `'true'` or `'false'` at creation time.
- The label is immutable after Docker container creation and is not the authoritative state once the backend DB is available.
- The backend also writes a durable enablement row for every container created with SSH enabled.
- Post-create enablement writes only the durable DB row; it does not attempt to mutate Docker labels.
- Effective enabled state is:

```ts
effectiveSshEnabled =
  container_ssh_enablements row exists
  || label nyabase.ssh_server_enabled === 'true'
```

- If a label says enabled but no DB row exists, the backend should treat the container as enabled and may backfill the DB row opportunistically during list/get/reconcile to converge storage.
- The agent parser defaults missing `nyabase.ssh_server_enabled` to `false`.
- The parser ignores old `nyabase.ssh_user` and `nyabase.ssh_uid` labels.
- Existing v1 containers default to disabled but can be enabled later through `POST /containers/:serverId/:dockerId/ssh/enable`.
- `ContainerSpec.sshServerEnabled` in raw agent reports is only the agent-visible hint. Backend REST responses must overlay the durable DB state before returning containers to clients.

### Data Directory Ownership

The create-container data-dir contract changes from "use `sshUid`" to "use the selected image UID".

Backend mapping:

```ts
createDirs: dataDirs.map((d) => ({
  sourceKind: d.sourceKind,
  sourceId: d.sourceId,
  dirName: d.dirName,
  createIfMissing: d.createIfMissing ?? true,
  ownerUid: image.defaultUid,
}))
```

Agent behavior:

```ts
await this.dataDirs.createDir(d.sourceId, d.dirName, d.ownerUid);
```

This preserves current data directory ownership behavior without exposing a per-container UID override and without naming it as an SSH concept. XFS quota continues to use `numericOwnerId`.

## Backend Design

### Container SSH Enablement Store

Add `packages/backend/src/entities/container-ssh-enable.entity.ts`.

Suggested entity:

```ts
@Entity('container_ssh_enablements')
@Unique(['serverId', 'dockerId'])
export class ContainerSshEnablementEntity {
  @PrimaryColumn('text')
  id: string;

  @Index()
  @Column('text')
  serverId: string;

  @Index()
  @Column('text')
  dockerId: string;

  @Index()
  @Column('text')
  ownerId: string;

  @Column('text')
  containerName: string;

  @Column('text', { nullable: true })
  enabledBy: string | null;

  @Column('datetime')
  enabledAt: Date;

  @Column({ default: false })
  createdWithSsh: boolean;
}
```

Storage rules:

- A row means SSH is enabled permanently for that container.
- No row means disabled unless the Docker label `nyabase.ssh_server_enabled=true` exists.
- There is no `disabledAt` column and no update path that removes the row during normal lifecycle.
- `deleteContainer` removes the row as container cleanup, because the container no longer exists; this is not "disabling SSH".
- Production needs a TypeORM migration adding `container_ssh_enablements` and a unique index on `(serverId, dockerId)`.

Add `packages/backend/src/containers/container-ssh-enablements.service.ts`.

Responsibilities:

- `isEnabled(serverId, dockerId, labelEnabled?: boolean): Promise<boolean>`
- `enable(serverId, dockerId, ownerId, containerName, enabledBy, createdWithSsh): Promise<{ inserted: boolean }>`
- `deleteForContainer(serverId, dockerId): Promise<void>`
- `listEnabledOnServer(serverId): Promise<Set<string>>`
- `listEnabledForUser(userId): Promise<Array<{ serverId: string; dockerId: string }>>`
- `overlaySnapshot(snapshot): ContainerSnapshot`
- `overlaySnapshots(snapshots): ContainerSnapshot[]`

Overlay behavior:

- `spec.sshServerEnabled` in API DTOs is `dbRowExists || raw.spec.sshServerEnabled`.
- If effective enabled is true and the raw agent `sshServer.enabled` is false, synthesize an SSH state:
  - stopped container: `{ enabled: true, status: 'container_stopped', user: 'root', port: 22 }`
  - running container: `{ enabled: true, status: 'unknown', user: 'root', port: 22 }`
- If raw agent state already reports enabled/running/error, preserve its runtime details.

### Container Creation

`packages/backend/src/containers/containers.service.ts`

Create flow after the rework:

1. Validate server, image, permissions, quotas, GPU selection, and data-dir source grants as today.
2. Do not fetch SSH keys for the `createContainer` payload.
3. Resolve `sshServerEnabled = req.sshServerEnabled ?? false`.
4. Send `createContainer` with:
   - `sshServerEnabled`;
   - `createDirs[].ownerUid = image.defaultUid`;
   - no `sshUser`, no `sshUid`, no `sshPubKeys`.
5. After the agent returns `dockerId`, persist expected mounts as today.
6. If `sshServerEnabled` is true, insert `ContainerSshEnablementEntity` before attempting Dropbear setup.
7. If `sshServerEnabled` is true, call `ContainerSshSyncService.reconcileContainer(serverId, dockerId, { strict: true })`.
8. If enablement persistence or strict SSH setup fails during SSH-enabled creation:
   - attempt `deleteContainer` on the agent with `force: true`;
   - delete any expected mount rows for the created container;
   - delete the SSH enablement row if one was created;
   - leave created data directories in place, matching existing non-compensated data-dir behavior;
   - throw the Dropbear setup error to the REST caller.
9. Audit the create request with `sshServerEnabled` and without legacy SSH fields.

Rationale: users who explicitly request SSH should not get a silently degraded new container on the happy path. Later lifecycle/key-change reconciliation is best-effort because the container already exists.

### Post-Create SSH Enable Operation

Add a route to `packages/backend/src/containers/containers.controller.ts`:

```ts
@Post(':serverId/:dockerId/ssh/enable')
async enableSsh(...) {
  return this.containersService.enableContainerSsh(user.id, serverId, dockerId);
}
```

`ContainersService.enableContainerSsh` flow:

1. Load the container snapshot from state cache and authorize with `assertOwnerOrManageAny`.
2. Insert the enablement row with `enabledBy = requesterId`; if it already exists, treat it as success.
3. If the raw label already says enabled but no row exists, backfill the row and continue.
4. If the container is not running, return `{ ok: true, enabled: true, reconciled: false }`.
5. If the agent is offline, return `{ ok: true, enabled: true, reconciled: false, error: 'Agent offline' }`.
6. If running and online, call `ContainerSshSyncService.reconcileContainer(serverId, dockerId, { strict: false, forceEnabled: true })`.
7. Return `{ ok: true, enabled: true, reconciled: true }` on success.
8. If reconcile fails, keep the row and return `{ ok: true, enabled: true, reconciled: false, error }`; subsequent lifecycle/key-change sync retries.

This operation is one-way and idempotent. It must not expose any disable counterpart, and implementation must not remove the row in response to user action.

### Manual SSH Reconcile Operation

Add a route to `packages/backend/src/containers/containers.controller.ts`:

```ts
@Post(':serverId/:dockerId/ssh/reconcile')
async reconcileSsh(...) {
  return this.containersService.reconcileContainerSsh(user.id, serverId, dockerId);
}
```

`ContainersService.reconcileContainerSsh` flow:

1. Load the container snapshot from state cache and authorize with `assertOwnerOrManageAny`.
2. Compute effective SSH enablement from the DB row or creation label.
3. If SSH is not enabled, throw `ConflictException('SSH is not enabled for this container')`; this endpoint must not enable SSH.
4. If the container is not running, return `{ ok: true, enabled: true, reconciled: false, status: 'container_stopped' }`.
5. If the agent is offline, return `{ ok: true, enabled: true, reconciled: false, status: 'agent_offline' }`.
6. Call `ContainerSshSyncService.reconcileContainer(serverId, dockerId, { strict: false, forceEnabled: true, manual: true })`.
7. On success, return `{ ok: true, enabled: true, reconciled: true, status: 'reconciled' }`.
8. On failure, keep SSH enabled and return `{ ok: true, enabled: true, reconciled: false, status: 'failed', error }`.

The manual operation does not mutate enablement state, does not touch disabled containers, and does not terminate existing SSH sessions. Its purpose is to force the same idempotent agent repair path used by lifecycle reconciliation. If the in-container Dropbear process was killed, the agent process check fails and Dropbear is started again.

### Container SSH Synchronization Service

Add `packages/backend/src/containers/container-ssh-sync.service.ts`.

Responsibilities:

- Register with `AgentGateway.registerOnStateReport`:
  - on a full state report, reconcile every running container whose effective enabled state is true by DB row or creation label.
- Register with `AgentGateway.registerOnContainerStart`:
  - reconcile the specific started container if effectively enabled.
- Register with `UsersService.registerOnSshKeysChanged`:
  - reconcile all running SSH-enabled containers owned by the affected user after add/delete.
- Provide explicit methods used by `ContainersService`:
  - `reconcileContainer(serverId, dockerId, opts?: { strict?: boolean; forceEnabled?: boolean; manual?: boolean }): Promise<{ reconciled: boolean; error?: string }>`;
  - `reconcileAllRunning(serverId)`;
  - `reconcileUserRunningContainers(userId)`.

Reconcile algorithm:

1. Return immediately if the agent is offline.
2. Read the container snapshot from `AgentGateway.stateCache`.
3. Compute effective enabled state from `forceEnabled`, the enablement DB row, or the creation label.
4. Return if no snapshot, container is not running, or effective enabled state is false.
5. Fetch fresh public keys with `UsersService.getUserSshKeyTexts(snapshot.spec.ownerId)`.
6. Send RPC:

```ts
await agentGateway.rpc(serverId, 'reconcileContainerSsh', {
  dockerId,
  publicKeys,
  expectedKeyHash: sha256(publicKeys.map(trim).filter(Boolean).join('\n') + '\n'),
});
```

7. In strict mode, propagate the RPC error.
8. In lifecycle/key-change/post-enable/manual mode, log a warning or return the error to the caller and rely on the next state report, key change, or manual retry.

Synchronization should be serialized per `serverId:dockerId` in this service or by relying on the agent's per-container mutex. Backend-side serialization is preferable for clearer logs and fewer duplicate RPCs during key-change storms.

### User Key Change Trigger

`packages/backend/src/users/users.service.ts`

Add a small callback registry instead of importing the containers module into `UsersModule`:

```ts
type SshKeysChangedCallback = (userId: string) => Promise<void>;

registerOnSshKeysChanged(fn: SshKeysChangedCallback): void;
```

After `addSshKey` saves and after `deleteSshKey` removes, schedule callbacks for the target user. Callback failures are logged and must not roll back the key CRUD operation.

Rationale: `ContainersModule` already imports `UsersModule`; this avoids a Nest module cycle while still giving key CRUD real-time side effects.

### Agent Gateway Hooks

`AgentGateway` already has the required lifecycle hooks:

- `registerOnStateReport`
- `registerOnContainerStart`
- `notify`
- `rpc`

No new gateway hook is required. `BackendToAgentMessage` must include `reconcileContainerSsh` so `rpc` can type-check the new command. `reconcileContainerSsh` should not be added to `CONTAINER_OPS`; it does not change the container list and does not need an automatic full state reconcile after each key sync.

## Agent Design

### Static Dropbear Asset And Build Path

Use the existing mount-helper packaging pattern, but make the Dropbear artifact reproducible from repository-owned scripts instead of requiring an untrusted prebuilt binary.

Add authored build inputs under `scripts/**`:

- `scripts/dropbear/Dockerfile`
- `scripts/dropbear/build.sh`
- `packages/agent/src/dropbear/dropbear-embed.ts`
- `packages/agent/src/dropbear/dropbear-manager.ts`

Generated outputs:

- `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64`
- `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64.sha256`

The two files under `packages/agent/assets/dropbear/` are generated artifacts. They are not manually authored source for the developer role. A release/devops flow may commit them only after provenance and checksum review; otherwise source-mode users generate them locally with `scripts/dropbear/build.sh` or provide a trusted override.

Docker build design:

- `scripts/dropbear/Dockerfile` builds a static Linux x64 Dropbear server binary from an official Dropbear source release tarball.
- The default source URL is `https://matt.ucc.asn.au/dropbear/releases/dropbear-${NYABASE_DROPBEAR_VERSION}.tar.bz2`; do not use a floating `latest` URL.
- The Dockerfile must download source only from the configured official release URL and must not install or copy a prebuilt Dropbear package as the final artifact.
- The implementation must pin one default source release in `scripts/dropbear/build.sh` with a non-empty `NYABASE_DROPBEAR_VERSION` and matching `NYABASE_DROPBEAR_TARBALL_SHA256` taken from official Dropbear release checksum/signature material.
- Prefer the latest stable official Dropbear release available at implementation time unless the reviewer records a compatibility/security reason to pin an older release.
- Updating the default Dropbear version is allowed only when the helper script also updates the pinned tarball checksum from the official release checksum/signature material and the reviewer verifies the pair.
- The Docker build must verify the downloaded tarball checksum before extraction.
- Build for `linux/amd64` by default and produce one server binary, renamed to `nyabase-dropbear-linux-x64`.
- The Dockerfile must fail if the resulting binary is not static, cannot run a help/version command, or does not produce the expected output file.
- The Dockerfile writes `/out/nyabase-dropbear-linux-x64` and `/out/nyabase-dropbear-linux-x64.sha256`; the helper copies those files to the generated output directory.

`scripts/dropbear/build.sh` responsibilities:

- Resolve the repository root and default output directory `packages/agent/assets/dropbear`.
- Create the output directory if missing.
- Pass build args into `scripts/dropbear/Dockerfile`:
  - `DROPBEAR_VERSION`
  - `DROPBEAR_SOURCE_URL`
  - `DROPBEAR_TARBALL_SHA256`
- Expose environment knobs:
  - `NYABASE_DROPBEAR_VERSION`
  - `NYABASE_DROPBEAR_SOURCE_URL`
  - `NYABASE_DROPBEAR_TARBALL_SHA256`
  - `NYABASE_DROPBEAR_OUTPUT_DIR`
  - `NYABASE_DROPBEAR_DOCKER`
  - `NYABASE_DROPBEAR_PLATFORM`
  - `NYABASE_DROPBEAR_FORCE`
  - `NYABASE_DROPBEAR_BUILD_DRY_RUN`
- Skip rebuilding when both output files exist and the sidecar hash matches the binary, unless `NYABASE_DROPBEAR_FORCE=1`.
- In normal mode, require Docker and fail clearly if Docker is missing or the daemon is unavailable.
- In dry-run mode, print the Dockerfile path, source URL, pinned checksum, output paths, and planned Docker command without downloading source or invoking Docker. This gives tester/devops a smoke/path test when Docker is unavailable.
- After copying outputs, `chmod 755 packages/agent/assets/dropbear/nyabase-dropbear-linux-x64` and rewrite the `.sha256` sidecar with the generated artifact hash.

Runtime lookup:

1. If `NYABASE_DROPBEAR_PATH` is set, use it. If `NYABASE_DROPBEAR_SHA256_PATH` is set, verify against that sidecar; otherwise verify against `${NYABASE_DROPBEAR_PATH}.sha256` when present. This is for local development, CI, and emergency override only, not a product API.
2. In source/dev mode, use `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64` and its `.sha256` sidecar. If missing, self-check output must point to `scripts/dropbear/build.sh` and the override environment variables.
3. In pkg binary mode, read bundled asset `nyabase-dropbear` and `nyabase-dropbear.sha256` next to the bundle entry and extract the binary to `/var/lib/nyabase-agent/nyabase-dropbear`, just like `mountHelperEmbed.ts`.

Build packaging:

- `scripts/build-agent-binary.sh` should resolve Dropbear in this order:
  1. `NYABASE_DROPBEAR_PATH` plus `NYABASE_DROPBEAR_SHA256_PATH` or adjacent `.sha256`;
  2. generated default asset `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64`;
  3. auto-build by invoking `bash scripts/dropbear/build.sh` when `NYABASE_DROPBEAR_AUTOBUILD` is unset or truthy.
- `NYABASE_DROPBEAR_AUTOBUILD=0` disables the auto-build and makes missing generated assets a clear packaging error.
- After resolution, `scripts/build-agent-binary.sh` must verify the sidecar hash before copying the binary into the bundle dir as `nyabase-dropbear`.
- The generated `pkg.config.json` should include `nyabase-mount-helper`, `nyabase-dropbear`, and `nyabase-dropbear.sha256`.
- Add a `--dropbear-smoke` mode or equivalent no-build internal path test that exercises Dropbear resolution/autobuild decision logic without running the mount-helper build, common package build, esbuild, or pkg. With `NYABASE_DROPBEAR_BUILD_DRY_RUN=1`, this smoke path must verify that build-agent would call `scripts/dropbear/build.sh` and consume the expected generated paths.

Self-check:

- Add a `dropbear_binary` self-check item that verifies the resolved binary exists, is executable, matches the resolved sha256 sidecar when available, is static when the platform can check it, and can run `-h` or an equivalent help/version command.
- Add a `dropbear_options` self-check item that reports whether the selected binary supports `-a`.

### Container Paths

Inside each SSH-enabled container:

- Binary: `/usr/local/bin/nyabase-dropbear`
- Binary hash marker: `/usr/local/bin/nyabase-dropbear.sha256`
- Host keys: `/etc/dropbear/*`
- PID file: `/run/nyabase-dropbear.pid`
- Root SSH directory: `/root/.ssh`
- Authorized keys: `/root/.ssh/authorized_keys`

Permissions:

- `/usr/local/bin/nyabase-dropbear`: `0755`, `root:root`
- `/etc/dropbear`: `0700`, `root:root`
- `/root/.ssh`: `0700`, `root:root`
- `/root/.ssh/authorized_keys`: `0600`, `root:root`

No path under `/home/<sshUser>` is created or modified by the new SSH subsystem.

### Dropbear Command

Start Dropbear in daemon/background mode, not foreground mode:

```sh
/usr/local/bin/nyabase-dropbear \
  -R \
  -s \
  -p 0.0.0.0:22 \
  -P /run/nyabase-dropbear.pid \
  [-a]
```

Option rules:

- Use `-s` to disable password logins for all accounts.
- Do not use `-w`; root public-key login must remain enabled.
- Do not use `-j` or `-k`; nyabase must not disable local or remote port forwarding.
- Use `-a` when the bundled Dropbear build supports it, so remote hosts may connect to remotely forwarded ports.
- Do not add `no-port-forwarding`, `no-agent-forwarding`, forced-command, or similar nyabase-imposed options to `authorized_keys`.
- Agent forwarding is not disabled by nyabase. Support depends on the selected Dropbear build and client use.

### Reconcile Algorithm

`DropbearManager.reconcileContainerSsh(payload)`:

1. Acquire the existing per-container mutex.
2. Inspect the Docker container.
3. Treat the `reconcileContainerSsh` command itself as the authority that SSH is enabled. Do not return early just because the Docker label is missing or false.
4. Fail if the container is not running. Backend normally avoids this, but strict create should surface the error.
5. Normalize keys:
   - trim each key line;
   - drop blank lines;
   - join with `\n`;
   - always end with one final newline, even for an empty key set.
6. Ensure root SSH files:
   - create `/root/.ssh`;
   - atomically write `/root/.ssh/authorized_keys.tmp`;
   - `chmod 600`, `chown root:root`;
   - move into place as `authorized_keys`.
7. Ensure binary:
   - compute host-side Dropbear sha256;
   - read `/usr/local/bin/nyabase-dropbear.sha256` if present;
   - if hashes match, skip copy;
   - if hashes differ or files are missing, copy the binary to a temp path, `chmod 755`, move into place, and update the marker.
8. Ensure host-key directory exists. Let Dropbear `-R` create host keys if missing.
9. Check if Dropbear is running:
   - if pid file exists and `kill -0 $(cat pidfile)` succeeds inside the container, treat it as running;
   - if binary was replaced, restart Dropbear to pick up the new binary;
   - if only keys changed, do not restart.
10. If not running, start Dropbear with the command above.
11. Verify pid file/process after startup.
12. Return status data for tests and logging.

Key deletion behavior:

- Rewriting `authorized_keys` prevents new logins with deleted keys.
- Existing SSH sessions are not intentionally terminated.
- Dropbear is not restarted for key-only changes.

Empty key set behavior:

- SSH-enabled containers still run Dropbear public-key-only.
- `authorized_keys` is empty.
- No one can authenticate until the user adds a key, at which point real-time sync populates the file.

### Agent State Reporting

`packages/agent/src/app.ts`

When building `ContainerSnapshot`, call `DropbearManager.inspectContainerSshState(dockerId, spec.sshServerEnabled, status)`.

Expected state mapping:

- no creation label and no runtime Dropbear marker/process visible to the agent: `{ enabled: false, status: 'disabled', user: 'root', port: 22 }`
- creation label enabled or runtime Dropbear marker/process visible to the agent: effective agent-local enabled state is true
- container not running: `{ enabled: true, status: 'container_stopped', user: 'root', port: 22 }`
- pid file/process valid: `{ enabled: true, status: 'running', user: 'root', port: 22, pid, keyHash, lastReconciledAt }`
- inspection/setup error: `{ enabled: true, status: 'error', user: 'root', port: 22, lastError }`
- transient inspection gap: `{ enabled: true, status: 'unknown', user: 'root', port: 22 }`

The state is ephemeral and reported from the agent. Backend REST responses overlay durable DB enablement on top of this raw runtime state, so a stopped v1 container that was enabled post-create still appears enabled even when the agent cannot infer that from labels.

## Frontend Design

`packages/frontend/src/components/containers/create-container-dialog.tsx`

- Add an opt-in SSH server toggle, default off.
- Submit `sshServerEnabled: true` only when the toggle is on.
- Replace "SSH public keys will be automatically injected" wording with neutral Dropbear/root wording.
- If the current user has no public keys available in the user center, the UI may still allow creation. The real-time sync path will populate keys after one is added.

`packages/frontend/src/pages/container-detail-page.tsx`

- Remove `SSH 用户` and `SSH UID` rows.
- Show an SSH section when `c.spec.sshServerEnabled` is true.
- Connection hint: `ssh root@<container-ip>`.
- Show runtime status from `c.sshServer.status`:
  - running: available;
  - container stopped: unavailable until start;
  - error/unknown: display error/status text;
  - disabled: omit the section.
- When `c.spec.sshServerEnabled` is false, show an "Enable SSH" action for users who own the container or have `ManageContainersAny`.
- The enable action calls `POST /containers/:serverId/:dockerId/ssh/enable`.
- After a successful enable response, invalidate/refetch the container detail/list queries so the one-way enabled state appears immediately.
- When `c.spec.sshServerEnabled` is true, show a manual repair action such as `修复 SSH` / `Reconcile SSH`.
- The repair action calls `POST /containers/:serverId/:dockerId/ssh/reconcile`.
- The repair action must be visually and behaviorally distinct from enablement: it is not a toggle, does not disable SSH, and is hidden for disabled containers.
- Surface the response status:
  - `reconciled`: success toast and refresh container detail;
  - `container_stopped`: informational toast that SSH will reconcile when the container starts;
  - `agent_offline`: warning toast;
  - `failed`: error toast with returned message and refresh status.
- Do not render any disable action, toggle-off control, or wording that implies SSH can be turned off after enablement.
- The existing browser exec console remains separate from Dropbear SSH. Its toolbar should not use `c.spec.sshUser`; use container IP or omit the SSH-style user hint.

Visual impact is expected in create-container dialog and container detail pages, so Playwright visual coverage and user screenshot acceptance are required later.

## Data Model And Migration Notes

- Add `container_ssh_enablements` as the durable source for post-create SSH enablement.
- Schema:
  - `id text primary key`
  - `serverId text not null`
  - `dockerId text not null`
  - `ownerId text not null`
  - `containerName text not null`
  - `enabledBy text null`
  - `enabledAt datetime/timestamp not null`
  - `createdWithSsh boolean not null default false`
  - unique index on `(serverId, dockerId)`
  - indexes on `serverId`, `dockerId`, and `ownerId`
- Existing `ssh_public_keys` remains the public-key source of truth.
- User key CRUD body and storage schema remain unchanged.
- A TypeORM migration is required in production for `container_ssh_enablements`.
- Docker spec version bumps from `1` to `2`.
- Existing v1 containers:
  - old `ssh_user`/`ssh_uid` labels are ignored by new code;
  - `sshServerEnabled` defaults to false when there is no enablement row;
  - they can be enabled later through the new REST operation;
  - no Dropbear process is installed or started automatically until enablement/reconciliation.
- New containers created with SSH enabled get both the creation label and the DB row.
- New containers created with SSH disabled get the false/missing creation label and no DB row until post-create enablement.
- The enablement row is removed only as part of container deletion cleanup.
- Runtime files placed inside containers are reconciled copies, not durable backend state.
- Deleting a public key updates future authentication only; existing SSH sessions may continue.

## File-Level Change List

- `packages/common/src/protocol/rest-schema.ts`: modify; remove create request `sshUser`/`sshUid`, add `sshServerEnabled`.
- `packages/common/src/protocol/rest.ts`: modify; add `EnableContainerSshResponse` and `ReconcileContainerSshResponse`; update DTO comments/types that expose effective SSH state.
- `packages/common/src/protocol/agent-messages.ts`: modify; remove legacy SSH fields, add `sshServerEnabled`, `createDirs[].ownerUid`, `ContainerSshServerState`, and `ReconcileContainerSshPayload`.
- `packages/common/src/protocol/ws.ts`: modify; add `reconcileContainerSsh` to `BackendToAgentMessage`.
- `packages/common/src/constants.ts`: modify; remove `SSH_USER`/`SSH_UID`, add `SSH_SERVER_ENABLED`, bump `SPEC_VERSION` to `2`.
- `packages/common/src/__tests__/protocol.test.ts`: modify; assert legacy fields are rejected/absent and new fields validate.
- `packages/backend/src/entities/container-ssh-enable.entity.ts`: add; durable one-way SSH enablement row keyed by `(serverId, dockerId)`.
- `packages/backend/src/database/db-entities.ts`: modify; include `ContainerSshEnablementEntity`.
- `packages/backend/src/database/migrations/<timestamp>-ContainerSshEnablements.ts`: add; create enablement table and indexes.
- `packages/backend/src/containers/containers.service.ts`: modify; remove create-time key fetch and `sshUid`; map `image.defaultUid` into `createDirs[].ownerUid`; call strict SSH reconcile after creating SSH-enabled containers; add post-create enable and manual SSH reconcile methods.
- `packages/backend/src/containers/containers.controller.ts`: modify; add `POST /containers/:serverId/:dockerId/ssh/enable` and `POST /containers/:serverId/:dockerId/ssh/reconcile`.
- `packages/backend/src/containers/container-ssh-sync.service.ts`: add; lifecycle/key-change/manual synchronization service with result reporting.
- `packages/backend/src/containers/container-ssh-enablements.service.ts`: add; persistence, idempotent enable, cleanup, and snapshot overlay helpers.
- `packages/backend/src/containers/containers.module.ts`: modify; provide/export `ContainerSshSyncService` and `ContainerSshEnablementsService`; include the new entity in `TypeOrmModule.forFeature`.
- `packages/backend/src/users/users.service.ts`: modify; add SSH-key-change callback registry and trigger it after add/delete.
- `packages/backend/src/users/users.controller.ts`: verify or minimally modify; route shapes remain unchanged, but key CRUD must use service methods that trigger sync.
- `packages/backend/src/gateway/agent-gateway.ts`: modify only as needed for typing/imports; existing hooks are sufficient.
- `packages/backend/src/gateway/state-cache.ts`: modify tests/types if the raw snapshot shape requires explicit `sshServer` handling; keep durable SSH overlay outside raw cache or document any cache mutation clearly.
- `packages/backend/src/gateway/__tests__/state-cache.test.ts`: modify; remove `sshUser`/`sshUid`, include `sshServerEnabled` and `sshServer`.
- `packages/backend/src/containers/__tests__/**` or new tests: add/modify; cover create payload mapping, enablement row persistence, idempotent post-create enable, manual reconcile, disabled-container conflict, stopped/offline status responses, overlay behavior, cleanup on delete, and strict SSH reconcile.
- `packages/backend/src/users/__tests__/**` or new tests: add; cover key add/delete sync trigger.
- `packages/agent/src/dropbear/dropbear-manager.ts`: add; own Dropbear reconcile, inspect, process, permissions, and failure handling.
- `packages/agent/src/dropbear/dropbear-embed.ts`: add; resolve/extract bundled Dropbear asset.
- `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64`: generated by `scripts/dropbear/build.sh`; static Linux x64 Dropbear artifact for source-mode runtime.
- `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64.sha256`: generated by `scripts/dropbear/build.sh`; sha256 sidecar for source-mode runtime and packaging verification.
- `packages/agent/src/commands/dispatcher.ts`: modify; remove `injectSshKeys`; handle `reconcileContainerSsh`; pass `ownerUid` to data-dir creation; pass `sshServerEnabled` to Docker create.
- `packages/agent/src/docker/docker-client.ts`: modify; remove legacy SSH label params/parsing; write/parse `SSH_SERVER_ENABLED`; add helper methods needed by `DropbearManager` for file writes, exec capture, and process checks.
- `packages/agent/src/app.ts`: modify; instantiate `DropbearManager` and include SSH runtime state in state reports.
- `packages/agent/src/commands/dispatcher.test.ts`: modify; remove injection tests; add Dropbear reconcile dispatch and data-dir owner UID tests.
- `packages/agent/src/docker/docker-client.test.ts`: modify; label/spec parse tests for spec version 2 and old-label default disabled behavior.
- `packages/agent/src/dropbear/dropbear-manager.test.ts`: add; unit-test idempotency, key-only updates, binary hash updates, empty keys, false/missing labels on command-authoritative reconcile, killed-process restart, and failure paths.
- `packages/frontend/src/components/containers/create-container-dialog.tsx`: modify; add SSH server opt-in control and payload field; remove legacy injection wording.
- `packages/frontend/src/pages/container-detail-page.tsx`: modify; remove SSH user/UID display; show Dropbear root connection state, one-way enable action for disabled containers, and manual repair/reconcile action for enabled containers.
- `packages/frontend/e2e/**`: modify/add visual tests or snapshots for changed create/detail UI.
- `scripts/dropbear/Dockerfile`: add; Dockerized reproducible static Linux x64 Dropbear build from official release source with tarball checksum verification.
- `scripts/dropbear/build.sh`: add; helper that owns output paths, environment knobs, dry-run smoke mode, Docker invocation, sidecar generation, and skip/rebuild logic.
- `scripts/build-agent-binary.sh`: modify in a devops lane; preserve `NYABASE_DROPBEAR_PATH`/sha override, consume generated Dropbear asset, auto-build it through `scripts/dropbear/build.sh` in normal workflow, and embed Dropbear plus sidecar next to mount-helper in standalone agent builds.

## Tests And Verification Plan

Common/protocol:

- `zCreateContainerRequest` accepts `sshServerEnabled` and rejects/strips legacy `sshUser` and `sshUid` according to the repository's object strictness conventions.
- REST type exports include `EnableContainerSshResponse` and `ReconcileContainerSshResponse`.
- `zCreateContainerPayload` requires `createDirs[].ownerUid` and has no `sshUser`, `sshUid`, or `sshPubKeys`.
- `zContainerSpec` and `zContainerSnapshot` include `sshServerEnabled` and `sshServer`.
- `BackendToAgentMessage` accepts `reconcileContainerSsh`.

Backend:

- Container creation sends `sshServerEnabled` and `ownerUid: image.defaultUid`.
- Container creation does not call `getUserSshKeyTexts` before `createContainer`.
- SSH-enabled creation inserts a `container_ssh_enablements` row before Dropbear setup.
- SSH-disabled creation does not insert a row.
- SSH-enabled creation calls strict `reconcileContainerSsh` after the Docker container exists.
- Strict SSH setup failure attempts cleanup and surfaces an error.
- `POST /containers/:serverId/:dockerId/ssh/enable` authorizes owner/manage-any, inserts the row, is idempotent, and exposes no disable counterpart.
- Enabling a running container attempts immediate reconciliation and keeps the row even if setup fails.
- Enabling a stopped container persists the row and reconciles on the next start/full state report.
- `POST /containers/:serverId/:dockerId/ssh/reconcile` authorizes owner/manage-any and is available only for effectively enabled containers.
- Manual reconcile on a disabled container returns HTTP 409 and does not create an enablement row.
- Manual reconcile on a running enabled container fetches fresh public keys and calls `reconcileContainerSsh`.
- Manual reconcile on a stopped enabled container returns `status: 'container_stopped'` and does not call the agent.
- Manual reconcile while the agent is offline returns `status: 'agent_offline'` and does not mutate durable state.
- Manual reconcile failure returns `status: 'failed'` with an error while keeping SSH enabled.
- Existing v1/missing-label containers default disabled but can be enabled through the endpoint.
- Container list/detail responses overlay DB enablement onto raw state-cache snapshots.
- Deleting a container removes its SSH enablement row.
- Key add/delete triggers reconciliation for all running SSH-enabled containers owned by the target user.
- Disabled/stopped/offline containers are skipped.
- Full state report and start event callbacks reconcile the expected containers.

Agent:

- `scripts/dropbear/build.sh` dry-run mode prints the exact Dockerfile path, source URL, pinned checksum, output paths, and Docker command without invoking Docker or downloading source.
- `scripts/dropbear/build.sh` normal mode verifies the official source tarball checksum, produces `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64`, produces the `.sha256` sidecar, and makes the binary executable.
- If Docker is unavailable, tester/devops still run the dry-run smoke check and document that the normal Docker build was skipped for environment reasons.
- `scripts/build-agent-binary.sh` Dropbear smoke/path mode preserves `NYABASE_DROPBEAR_PATH` and `NYABASE_DROPBEAR_SHA256_PATH`, verifies the sidecar hash for overrides, and does not attempt an auto-build when a valid override is supplied.
- `scripts/build-agent-binary.sh` Dropbear smoke/path mode consumes `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64` and sidecar when they exist and match.
- `scripts/build-agent-binary.sh` Dropbear smoke/path mode invokes or plans `scripts/dropbear/build.sh` when the default generated asset is missing and `NYABASE_DROPBEAR_AUTOBUILD` is not disabled.
- `NYABASE_DROPBEAR_AUTOBUILD=0` makes missing default generated assets a clear failure in `scripts/build-agent-binary.sh`.
- `createContainer` no longer calls any SSH injection path.
- Data-dir creation uses `createDirs[].ownerUid`.
- Docker labels write/parse `sshServerEnabled`.
- `reconcileContainerSsh` writes root `authorized_keys` with correct permissions.
- Key-only reconcile does not restart a running Dropbear process.
- Binary hash change copies the new binary and restarts Dropbear.
- Manual reconcile restarts Dropbear when the pid file/process check shows it was killed.
- Empty key list leaves an empty `authorized_keys` and public-key-only Dropbear running.
- Backend skips disabled containers; if the agent receives `reconcileContainerSsh`, it treats the command as enablement authority and performs setup even when the creation label is false/missing.
- Dropbear startup failures produce command ack errors and state `lastError`.

Frontend:

- Create dialog sends `sshServerEnabled` only from the opt-in toggle.
- Legacy auto-injection wording is gone.
- Detail page omits SSH user/UID.
- Detail page shows `ssh root@<ip>` and runtime status only for SSH-enabled containers.
- Detail page shows a one-way "Enable SSH" action only for disabled containers the user can manage.
- Detail page shows a "Reconcile SSH"/"修复 SSH" action only for enabled containers the user can manage and surfaces each reconcile response status.
- There is no UI control that disables SSH or suggests the state can be toggled off.
- Browser console UI no longer shows `sshUser@ip`.

Visual:

- Because rendered frontend output changes, run the frontend Playwright visual suite later via `packages/frontend/playwright.config.ts`.
- Fresh screenshots must be shown for user visual acceptance before review, especially create-container dialog and container detail overview/console states.

Repository guard:

- `bash scripts/check.sh` must pass later.
- No generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` files may be left under `packages/common/src/**`.
- A Docker-capable devops environment must run the normal Dropbear build at least once before release packaging; a non-Docker environment may satisfy only the smoke/path test gate and must report the skipped Docker build.

## Risks And Trade-Offs

- Root SSH access is intentionally broad. This matches the confirmed decision, but any compromised key gives root inside the container.
- Open forwarding is intentionally permissive. This matches the confirmed decision, but forwarded services may expose more than users expect.
- Port 22 may already be used by an image's own SSH daemon. The design treats that as a Dropbear startup error instead of adding dynamic port selection.
- Static binary compatibility is a deployment risk. The checked-in binary must match target Linux architecture and be truly static.
- Minimal images without `/bin/sh`, `/root`, or normal root account files may fail reconciliation. Existing agent exec flows already assume `/bin/sh`.
- Key sync is best-effort outside strict creation. Offline agents catch up on reconnect/full state report; running containers may briefly have stale keys.
- Post-create enablement can succeed durably while immediate Dropbear setup fails. The UI must surface runtime error/unknown state clearly because there is no rollback/disable path.
- Manual reconcile can overlap with automatic lifecycle/key-change reconciliation. Per-container serialization is required so repeated clicks cannot corrupt key files or start duplicate Dropbear processes.
- Manual reconcile on stopped/offline containers cannot repair anything immediately. The UI must communicate `container_stopped` and `agent_offline` as non-reconciled outcomes rather than success.
- Backend REST output now overlays DB state onto raw agent snapshots. Bugs in overlay logic could show stale SSH state even when raw state reports are correct.
- The enablement table is keyed by Docker ID. If Docker containers are recreated outside nyabase, stale rows must be cleaned up by normal container deletion/reconciliation paths.
- Runtime SSH status is ephemeral. Backend restarts lose last error/status until the next state report.
- Docker may be unavailable on developer/tester machines. The design requires a dry-run/path smoke test for those environments and a real Docker build in devops/release environments.
- Official Dropbear source checksum drift should not happen for immutable release tarballs. If the checksum changes, treat it as a supply-chain blocker until the version/checksum pair is manually reviewed.
- The first supported generated artifact is Linux x64 only. Other architectures need separate output names, checksums, packaging rules, and runtime resolution logic.
- Generated Dropbear artifacts under `packages/agent/assets/dropbear/` may or may not be committed. Source-mode runtime and packaging must work when they are generated locally, and packaging must fail clearly when neither generated artifacts nor trusted overrides are available.
- Embedding Dropbear in standalone agent builds requires a devops-script change and a Docker artifact build path in addition to source changes.

Alternatives considered:

- Keep `sshUid` under a new meaning: rejected because it preserves an SSH-named per-container UID override and violates the confirmed removal.
- Continue passing keys inside `createContainer`: rejected because it preserves the one-shot create-time key delivery pattern.
- Use only Docker labels for SSH enablement: rejected because labels cannot be mutated after container creation, so they cannot support disabled-to-enabled transitions.
- Mutate/recreate Docker containers to update labels: rejected because enabling SSH should not recreate or replace user containers.
- Store SSH enablement in a backend DB table: accepted because it supports one-way post-create enablement across backend/agent restarts; labels remain a fallback hint.
- Let manual reconcile enable disabled containers: rejected because it would blur repair and one-way enablement semantics; disabled containers should use the explicit enable endpoint.
- Return HTTP success and enable a disabled container from the repair button: rejected because the UI must not present repair as a toggle or hidden enable path.
- Disable forwarding by default: rejected because the confirmed decision is open forwarding unless Dropbear itself lacks support.
- Use non-root image users for SSH: rejected because the confirmed decision is root login for all SSH-enabled containers.
- Store the Dockerfile under `scripts/dropbear/`: accepted because `scripts/**` is inside the developer/devops write scope and keeps native artifact build logic out of `packages/agent/assets/**`.
- Store the Dockerfile under `packages/agent/assets/dropbear/`: rejected because that path is generated artifact output, not an authored-source path in the current dispatch.
- Commit an opaque prebuilt Dropbear binary without a build path: rejected because it leaves provenance unverifiable and repeats the reviewer blocker in a different form.
- Require only `NYABASE_DROPBEAR_PATH`: rejected for normal workflow because the repository should be able to produce a bundled agent without external overrides.

## Acceptance Criteria

1. REST, RPC, state, labels, frontend display, and tests no longer use `sshUser`, `sshUid`, or `sshPubKeys`.
2. Agent code no longer creates or writes `/home/<sshUser>/.ssh/authorized_keys`, and `injectSshKeys` is removed.
3. Creating a container with `sshServerEnabled` false does not copy Dropbear, start Dropbear, write root authorized keys, or create a DB SSH enablement row.
4. Creating a container with `sshServerEnabled` true uses `image.defaultUid` through `createDirs[].ownerUid` for data-dir creation, independent of SSH.
5. Creating a container with `sshServerEnabled` true creates a durable SSH enablement row and reconciles current user public keys into `/root/.ssh/authorized_keys`.
6. `POST /containers/:serverId/:dockerId/ssh/enable` lets an authorized owner or `ManageContainersAny` user enable SSH for a previously disabled container.
7. Repeated enable calls are idempotent and do not create duplicate rows.
8. There is no REST route, RPC, service method, or frontend control that disables SSH after it has been enabled.
9. Enabling SSH on a running container immediately attempts key reconciliation and Dropbear startup.
10. Enabling SSH on a stopped or offline container persists the enabled state and reconciles on the next start/full state report.
11. Existing v1 or missing-label containers default to disabled but can be enabled later through the new endpoint.
12. Backend list/detail responses overlay durable DB enablement onto raw label-derived snapshots.
13. `POST /containers/:serverId/:dockerId/ssh/reconcile` lets an authorized owner or `ManageContainersAny` user manually repair an SSH-enabled container.
14. Manual SSH reconcile returns HTTP 409 for disabled containers and does not create an enablement row.
15. Manual SSH reconcile on a running enabled container fetches current user keys and calls the agent to ensure binary, keys, permissions, and Dropbear process state.
16. Manual SSH reconcile restarts Dropbear if the in-container process was killed.
17. Manual SSH reconcile on stopped/offline enabled containers returns a clear non-reconciled status without changing enablement.
18. Dropbear-managed SSH accepts root public-key login and disables password login.
19. Nyabase does not disable port forwarding or agent forwarding; it omits `-j`/`-k`, adds no restrictive authorized_keys options, and uses `-a` when supported by the bundled Dropbear.
20. Adding a user public key reconciles all running SSH-enabled containers owned by that user without requiring restart.
21. Deleting a user public key rewrites affected `authorized_keys` files without intentionally terminating existing SSH sessions.
22. Starting or restarting an SSH-enabled container reconciles keys and ensures Dropbear is running.
23. Agent reconnect or first full state report reconciles every running SSH-enabled container on that server using DB rows plus enabled labels.
24. Dropbear binary copy/start is idempotent: key-only sync does not restart Dropbear, while binary hash changes update and restart it.
25. Agent/backend state exposed to clients includes SSH runtime status and last error for visibility.
26. Strict SSH setup failure during SSH-enabled container creation surfaces an error and attempts container/mount/enablement-row cleanup.
27. `scripts/dropbear/Dockerfile` exists and builds Dropbear from an official pinned source release tarball rather than from a third-party prebuilt binary.
28. `scripts/dropbear/build.sh` exists and documents/supports `NYABASE_DROPBEAR_VERSION`, `NYABASE_DROPBEAR_SOURCE_URL`, `NYABASE_DROPBEAR_TARBALL_SHA256`, `NYABASE_DROPBEAR_OUTPUT_DIR`, `NYABASE_DROPBEAR_DOCKER`, `NYABASE_DROPBEAR_PLATFORM`, `NYABASE_DROPBEAR_FORCE`, and `NYABASE_DROPBEAR_BUILD_DRY_RUN`.
29. The Dropbear Docker build verifies the source tarball checksum before extraction and fails on checksum mismatch.
30. A successful Dropbear Docker build writes `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64` and `packages/agent/assets/dropbear/nyabase-dropbear-linux-x64.sha256`, with the sidecar matching the generated binary.
31. `scripts/build-agent-binary.sh` preserves `NYABASE_DROPBEAR_PATH` and `NYABASE_DROPBEAR_SHA256_PATH` for trusted external artifacts and verifies the resolved binary against the resolved sidecar.
32. In the normal workflow, `scripts/build-agent-binary.sh` consumes the generated default Dropbear artifact when present or auto-builds it by invoking `scripts/dropbear/build.sh` when `NYABASE_DROPBEAR_AUTOBUILD` is unset or truthy.
33. `NYABASE_DROPBEAR_AUTOBUILD=0` makes missing generated Dropbear artifacts a clear packaging failure rather than a network download or silent skip.
34. Standalone agent packaging embeds both `nyabase-dropbear` and `nyabase-dropbear.sha256` alongside `nyabase-mount-helper`.
35. A no-Docker smoke/path test exists for the Dropbear build-agent path, using dry-run behavior to prove the expected Dockerfile, output paths, checksum, and autobuild decision without running Docker, installs, full builds, or downloads.
36. Focused common, backend, and agent tests cover protocol removal, data-dir owner UID mapping, durable enablement, one-way/idempotent enable, manual SSH reconcile, key-change sync, lifecycle sync, and Dropbear manager behavior.
37. Frontend tests or Playwright visual coverage reflect the create dialog, detail-page SSH enable action, detail-page SSH repair action, and enabled-state SSH UX, with fresh screenshots presented for user visual acceptance.
38. Later full verification passes `bash scripts/check.sh` and leaves no generated artifacts under `packages/common/src/**`.

## Out Of Scope

- Building Dropbear outside the Dockerized Linux x64 artifact path described in this design.
- Trusting or downloading third-party prebuilt Dropbear binaries.
- Multi-architecture Dropbear artifacts beyond `nyabase-dropbear-linux-x64`.
- Host firewall, NAT, public internet exposure, or Docker port publishing changes.
- Dynamic SSH port allocation or conflict resolution.
- Disabling SSH after it has been enabled.
- Migrating existing legacy SSH-injected containers to Dropbear automatically.
- Killing existing SSH sessions after a key is deleted.
- Per-key forwarding policies, forced commands, or admin policy controls.
- Password login, PAM integration, SFTP subsystem setup, or non-root account provisioning.
- Changing the browser exec console transport.

## References

- Requirements: `.codex/skills/harness/docs/dropbear-ssh-rework/20260602T081822Z/requirements.md`
- Dropbear options reference: https://manpages.debian.org/testing/dropbear-bin/dropbear.8.en.html
