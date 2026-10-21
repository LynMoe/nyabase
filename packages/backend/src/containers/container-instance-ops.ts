import {
  IncusError,
  isMissingCustomVolumeError,
  readAfterTimeout,
  requestAndWait,
  type DesiredInstanceSpec,
  type IncusClientPort,
} from '../incus/index.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import type { ContainerReconcileDeps } from './container-reconcile-deps.js';
import {
  auditIncusMutate,
  bytes,
  isNotFound,
  managedContainerIdentity,
  normalized,
  running,
  type ActualInstance,
  type ContainerRow,
  type InstanceFull,
  type InstanceState,
} from './container-reconcile-support.js';

export async function readRequired(client: IncusClientPort, name: string): Promise<ActualInstance> {
  return { name, document: (await client.getInstanceFull(name)).metadata };
}

export async function readState(
  client: IncusClientPort,
  name: string,
): Promise<InstanceState> {
  // Always refresh from /state. InstanceFull.state can lag behind power transitions
  // (create starts stopped; reconcilePower then starts), and reusing it marks SSH as
  // container_stopped while the instance is already Running.
  return (await client.getInstanceState(name)).metadata;
}

/** Root filesystem usage from the instance state, falling back to the instance volume. */
export async function observeRootUsage(
  client: IncusClientPort | undefined,
  poolName: string,
  instanceName: string,
  state: InstanceState,
): Promise<bigint | null> {
  const fromState = bytes(state.disk?.root?.usage);
  if (fromState !== null && fromState > 0n) return fromState;
  if (!client) return fromState;
  try {
    const volumeState = await client.getStorageVolumeState(poolName, 'container', instanceName);
    const fromVolume = bytes(volumeState.metadata.usage?.used);
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

/** The instance under its expected name, or (renamed / moved) the one carrying our identity. */
export async function findExpectedOrIdentity(
  deps: ContainerReconcileDeps,
  client: IncusClientPort,
  expectedName: string,
  row: ContainerRow,
): Promise<ActualInstance | undefined> {
  try {
    return { name: expectedName, document: (await client.getInstanceFull(expectedName)).metadata };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const listed = await client.listInstances(2);
  for (const item of listed.metadata as InstanceFull[]) {
    const itemIdentity = managedContainerIdentity(item);
    if (
      itemIdentity.managed
      && itemIdentity.containerId === normalized(row.id)
      && itemIdentity.serverId === normalized(row.server_id)
    ) {
      return { name: item.name ?? expectedName, document: item };
    }
    if (
      itemIdentity.managed
      && itemIdentity.containerId === normalized(row.id)
      && itemIdentity.serverId !== normalized(row.server_id)
    ) {
      deps.logger.warn(
        `Found container ${row.id} on a different server; refusing cross-server deletion`,
      );
      return { name: item.name ?? expectedName, document: item };
    }
  }
  return undefined;
}

export async function createInstance(
  deps: ContainerReconcileDeps,
  client: IncusClientPort,
  desired: DesiredInstanceSpec,
  expectedName: string,
  row: ContainerRow,
  intent: IntentRecord,
): Promise<void> {
  await auditIncusMutate(deps.audit, intent, {
    method: 'POST',
    path: '/1.0/instances',
    instanceName: expectedName,
  });
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
  await deps.store.setInstanceName(row.id, expectedName);
}

export async function renameInstance(
  client: IncusClientPort,
  actual: ActualInstance,
  expectedName: string,
): Promise<void> {
  if (actual.name === expectedName) return;
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.renameInstance(actual.name, { name: expectedName }, options),
    ),
    async () => {
      await client.getInstanceFull(expectedName);
      return undefined;
    },
  );
}

/** Stop (if running) and delete one instance, confirmed by a GET 404. */
export async function deletePhysicalInstance(
  deps: ContainerReconcileDeps,
  client: IncusClientPort,
  name: string,
  intent?: IntentRecord,
): Promise<void> {
  if (!name) return;
  if (intent) {
    await auditIncusMutate(deps.audit, intent, {
      method: 'DELETE',
      path: `/1.0/instances/${name}`,
      instanceName: name,
    });
  }
  const state = await readState(client, name);
  if (running(state)) {
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
  }
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

/** Delete the container's own instance, but only when it is ours and on this server. */
export async function deleteDesiredInstance(
  deps: ContainerReconcileDeps,
  client: IncusClientPort,
  actual: ActualInstance | undefined,
  row: ContainerRow,
  intent: IntentRecord,
): Promise<boolean> {
  if (!actual) return false;
  const actualIdentity = managedContainerIdentity(actual.document);
  if (!actualIdentity.managed) return false;
  if (actualIdentity.serverId !== normalized(row.server_id)) {
    deps.logger.warn(`Refusing to delete cross-server instance ${actual.name}`);
    return false;
  }
  await deletePhysicalInstance(deps, client, actual.name, intent);
  return true;
}

/** Remove managed instances on the server that no live container row owns. */
export async function deleteManagedOrphans(
  deps: ContainerReconcileDeps,
  client: IncusClientPort,
  row: ContainerRow,
  intent: IntentRecord,
): Promise<void> {
  const known = new Set(
    (await deps.store.listLiveContainerIds(row.server_id)).map((id) => normalized(id)),
  );
  const instances = await client.listInstances(2);
  for (const document of instances.metadata as InstanceFull[]) {
    const itemIdentity = managedContainerIdentity(document);
    if (
      itemIdentity.managed
      && itemIdentity.serverId === normalized(row.server_id)
      && !known.has(itemIdentity.containerId)
      && document.name
    ) {
      await deletePhysicalInstance(deps, client, document.name, intent);
    }
  }
}
