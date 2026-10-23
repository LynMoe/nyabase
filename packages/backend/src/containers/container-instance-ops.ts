import {
  applyManagedFields,
  buildDesiredInstanceSpec,
  compareManagedFields,
  CORE_MANAGED_FIELD_OWNERSHIP,
  IncusError,
  isMissingCustomVolumeError,
  mergeInstanceSpecContributions,
  readAfterTimeout,
  requestAndWait,
  type ContainerRuntimeLimits,
  type DesiredInstanceSpec,
  type IncusClientPort,
  type IncusSchema,
  type InstanceSpecAttachmentInput,
  type ManagedFieldOwnership,
  type ManagedInstanceDocument,
} from '../incus/index.js';
import { gpuInstanceSpec } from '../gpu/instance-spec.js';
import type { ContainerAttachment, ContainerRow } from './container-reconcile.store.js';

/*
 * Plain functions over one Incus instance: observation helpers, the desired
 * spec, and the mutations the container reconciler performs. Auditing,
 * logging and SQL stay in the reconciler; these take `client` and explicit values.
 */

export type InstanceFull = IncusSchema<'InstanceFull'>;
export type InstanceState = IncusSchema<'InstanceState'>;

export interface ActualInstance {
  readonly name: string;
  readonly document: InstanceFull;
}

/** The platform owns the whole instance document except Incus-maintained config. */
export const MANAGED_FIELD_OWNERSHIP: ManagedFieldOwnership = CORE_MANAGED_FIELD_OWNERSHIP;

/** What the spec needs beyond the container row: its CPU pinning and the platform limits. */
export interface ContainerSpecRuntime {
  readonly cpus: readonly number[];
  readonly limits: ContainerRuntimeLimits;
}

const MANAGED_KEY = 'user.nyabase.managed';
const CONTAINER_ID_KEY = 'user.nyabase.container_id';
const SERVER_ID_KEY = 'user.nyabase.server_id';

export function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

export function normalized(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('-', '').toLowerCase() : '';
}

export function managedContainerIdentity(document: InstanceFull): {
  readonly managed: boolean;
  readonly containerId: string;
  readonly serverId: string;
} {
  const config = document.config ?? {};
  return {
    managed: config[MANAGED_KEY] === 'true',
    containerId: normalized(config[CONTAINER_ID_KEY]),
    serverId: normalized(config[SERVER_ID_KEY]),
  };
}

export function running(state: InstanceState | undefined): boolean {
  return state?.status?.toLowerCase() === 'running';
}

export function powerTransition(
  currentStatus: string | undefined,
  desired: 'running' | 'stopped',
): 'start' | 'stop' | 'none' {
  const current = currentStatus?.toLowerCase();
  if (desired === 'running') return current === 'running' ? 'none' : 'start';
  return current === 'running' ? 'stop' : 'none';
}

export function restartTransition(
  currentStartedAt: string | null | undefined,
  baselineStartedAt: string | null | undefined,
  currentStatus: string | undefined,
): 'restart' | 'proven' {
  if (
    currentStatus?.toLowerCase() === 'running'
    && currentStartedAt !== baselineStartedAt
  ) {
    return 'proven';
  }
  return 'restart';
}

export function observedDiskUsageBytes(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

// --- desired spec -------------------------------------------------------------

export function toSpecAttachments(
  attachments: readonly ContainerAttachment[],
): InstanceSpecAttachmentInput[] {
  return attachments.map<InstanceSpecAttachmentInput>((attachment) => ({
    id: attachment.id,
    containerPath: attachment.container_path,
    readOnly: attachment.read_only,
    volume: {
      id: attachment.volume_id,
      incusName: attachment.incus_name,
      poolName: attachment.pool_name,
      // Shared volumes live on CephFS, which has no block device to throttle.
      throttled: !attachment.shared,
    },
  }));
}

/** The Incus instance document the platform wants for this container. */
export function buildContainerSpec(
  row: ContainerRow,
  attachments: readonly InstanceSpecAttachmentInput[],
  runtime: ContainerSpecRuntime,
): DesiredInstanceSpec {
  const base = buildDesiredInstanceSpec({
    container: {
      id: row.id,
      serverId: row.server_id,
      revision: row.revision,
      imageFingerprint: row.image_fingerprint,
      cpus: runtime.cpus,
      memBytes: row.mem_bytes,
      nesting: row.nesting,
      syscallIntercept: row.syscall_intercept,
      rootPool: row.root_pool_name,
      rootSizeBytes: row.root_size_bytes,
      routedIp: row.routed_ip ?? '',
    },
    server: {
      id: row.server_id,
      parentInterface: row.parent_interface ?? '',
    },
    attachments,
    limits: runtime.limits,
  });
  // GPU contributes only while the server has it enabled.
  const contributions = row.gpu_enabled ? [gpuInstanceSpec(row.gpu_state)] : [];
  return mergeInstanceSpecContributions(base, contributions);
}

// --- reading ------------------------------------------------------------------

export async function readRequired(client: IncusClientPort, name: string): Promise<ActualInstance> {
  return { name, document: (await client.getInstanceFull(name)).metadata };
}

export async function readState(client: IncusClientPort, name: string): Promise<InstanceState> {
  // Always refresh from /state. InstanceFull.state can lag behind power transitions
  // (create starts stopped; reconcilePower then starts), and reusing it marks SSH as
  // container_stopped while the instance is already Running.
  return (await client.getInstanceState(name)).metadata;
}

/** Root filesystem usage from the instance state, falling back to the instance volume. */
export async function observeRootUsage(
  client: IncusClientPort,
  poolName: string,
  instanceName: string,
  state: InstanceState,
): Promise<bigint | null> {
  const fromState = observedDiskUsageBytes(state.disk?.root?.usage);
  if (fromState !== null && fromState > 0n) return fromState;
  try {
    const volumeState = await client.getStorageVolumeState(poolName, 'container', instanceName);
    const fromVolume = observedDiskUsageBytes(volumeState.metadata.usage?.used);
    if (fromVolume !== null && fromVolume > 0n) return fromVolume;
  } catch {
    // Best-effort: missing instance-volume usage still blocks quota-online shrink.
  }
  return fromState;
}

export async function verifyAbsent(client: IncusClientPort, name: string): Promise<void> {
  try {
    await client.getInstanceFull(name);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
    reason: 'instance_still_present',
    name,
  });
}

/**
 * The instance under its expected name, or (renamed / moved) the one carrying
 * the container's identity. `foreignServer` flags an identity match that
 * belongs to another server, which callers must never modify.
 */
export async function findExpectedOrIdentity(
  client: IncusClientPort,
  expectedName: string,
  container: { readonly id: string; readonly server_id: string },
): Promise<{ actual: ActualInstance | undefined; foreignServer: boolean }> {
  try {
    const document = (await client.getInstanceFull(expectedName)).metadata;
    return { actual: { name: expectedName, document }, foreignServer: false };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const listed = await client.listInstances(2);
  for (const item of listed.metadata as InstanceFull[]) {
    const identity = managedContainerIdentity(item);
    if (!identity.managed || identity.containerId !== normalized(container.id)) continue;
    return {
      actual: { name: item.name ?? expectedName, document: item },
      foreignServer: identity.serverId !== normalized(container.server_id),
    };
  }
  return { actual: undefined, foreignServer: false };
}

/** Managed instances of this server whose container id is not in `knownContainerIds`. */
export function orphanInstances(
  documents: readonly InstanceFull[],
  serverId: string,
  knownContainerIds: ReadonlySet<string>,
): InstanceFull[] {
  return documents.filter((document) => {
    const identity = managedContainerIdentity(document);
    return identity.managed
      && identity.serverId === normalized(serverId)
      && !knownContainerIds.has(identity.containerId)
      && Boolean(document.name);
  });
}

// --- mutations ----------------------------------------------------------------

export async function createInstance(
  client: IncusClientPort,
  desired: DesiredInstanceSpec,
  expectedName: string,
): Promise<void> {
  const create = async (): Promise<void> => {
    try {
      await requestAndWait(
        client,
        (options) => client.createInstance({
          ...desired,
          name: expectedName,
          start: false,
        }, options),
      );
    } catch (error) {
      if (isMissingCustomVolumeError(error)) {
        throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
          reason: 'create_missing_volume',
        });
      }
      throw error;
    }
  };
  await readAfterTimeout(
    create,
    async () => {
      await client.getInstanceFull(expectedName);
    },
  );
}

export async function renameInstance(
  client: IncusClientPort,
  actualName: string,
  expectedName: string,
): Promise<void> {
  if (actualName === expectedName) return;
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.renameInstance(actualName, { name: expectedName }, options),
    ),
    async () => {
      await client.getInstanceFull(expectedName);
      return undefined;
    },
  );
}

/** Stop (if running) and delete one instance, confirmed by a GET 404. */
/** Force-stop the instance if it runs; true when it had to be stopped. */
export async function stopPhysicalInstance(client: IncusClientPort, name: string): Promise<boolean> {
  const state = await readState(client, name);
  if (!running(state)) return false;
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.updateInstanceState(name, { action: 'stop', force: true }, options),
    ),
    async () => {
      const after = await client.getInstanceState(name);
      if (!running(after.metadata)) return undefined;
      throw new Error('INSTANCE_STOP_NOT_CONFIRMED');
    },
  );
  return true;
}

export async function deletePhysicalInstance(client: IncusClientPort, name: string): Promise<void> {
  if (!name) return;
  await stopPhysicalInstance(client, name);
  await readAfterTimeout(
    () => requestAndWait(client, (options) => client.deleteInstance(name, options)),
    async () => {
      try {
        await client.getInstanceFull(name);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      throw new Error('INSTANCE_DELETE_NOT_CONFIRMED');
    },
  );
  await verifyAbsent(client, name);
}

/** PUT the managed fields onto the instance and wait until the comparator sees no difference. */
export async function putManagedFields(
  client: IncusClientPort,
  expectedName: string,
  desired: DesiredInstanceSpec,
  hasAttachments: boolean,
): Promise<void> {
  try {
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.readModifyWriteInstance(
          expectedName,
          (document) => {
            const merged = applyManagedFields(
              document as ManagedInstanceDocument,
              desired,
              MANAGED_FIELD_OWNERSHIP,
            );
            document.config = merged.config;
            document.devices = merged.devices;
            document.profiles = [];
            return document;
          },
          options,
        ),
      ),
      async () => {
        const after = await readRequired(client, expectedName);
        const afterDiff = compareManagedFields(after.document, desired, MANAGED_FIELD_OWNERSHIP);
        if (afterDiff.kind !== 'empty') {
          throw new Error('INSTANCE_UPDATE_NOT_CONFIRMED');
        }
        return undefined;
      },
    );
  } catch (error) {
    if (isMissingCustomVolumeError(error) && hasAttachments) {
      throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
        reason: 'put_toctou',
      });
    }
    throw error;
  }
}

/** Start or stop the instance and wait until the state is confirmed. */
export async function setPowerState(
  client: IncusClientPort,
  name: string,
  transition: 'start' | 'stop',
): Promise<void> {
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.updateInstanceState(
        name,
        { action: transition, force: transition === 'stop' },
        options,
      ),
    ),
    async () => {
      const afterRunning = running((await client.getInstanceState(name)).metadata);
      if ((transition === 'start' && afterRunning) || (transition === 'stop' && !afterRunning)) {
        return undefined;
      }
      throw new Error('INSTANCE_POWER_NOT_CONFIRMED');
    },
  );
}

/** Force-restart and require a `started_at` newer than the baseline as proof. */
export async function restartWithProof(
  client: IncusClientPort,
  name: string,
  baselineStartedAt: string | null,
): Promise<void> {
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.updateInstanceState(
        name,
        { action: 'restart', force: true },
        options,
      ),
    ),
    async () => {
      const after = (await client.getInstanceState(name)).metadata;
      if (
        running(after)
        && after.started_at
        && after.started_at !== baselineStartedAt
      ) {
        return undefined;
      }
      throw new Error('INSTANCE_RESTART_NOT_CONFIRMED');
    },
  );
  const verified = await client.getInstanceState(name);
  const nextStartedAt = verified.metadata.started_at ?? null;
  if (
    !running(verified.metadata)
    || nextStartedAt === null
    || nextStartedAt === baselineStartedAt
  ) {
    throw new IncusError('RESTART_PROOF_MISSING', 'managed_failure', {
      baselineStartedAt: baselineStartedAt ?? '',
      observedStartedAt: nextStartedAt ?? '',
    });
  }
}
