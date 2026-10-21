import {
  readAfterTimeout,
  requestAndWait,
  IncusError,
  type IncusClientPort,
} from '../incus/index.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import type { ReconcileOutcome, ReconcileRunContext } from '../reconcile/managed-reconciler.js';
import { ensureSharedCatalogOnServer } from './shared-catalog.js';
import type { VolumeReconcileDeps } from './volume-reconcile-deps.js';
import {
  auditIncusMutate,
  destroyRetry,
  destroyRetryFromError,
  isNotFound,
  type CatalogGetStatus,
  type CatalogRow,
  type VolumeRecord,
} from './volume-reconcile-support.js';

type Executor = { server_id: string; pool_name: string };

async function clientFor(
  deps: VolumeReconcileDeps,
  serverId: string,
  context: ReconcileRunContext,
): Promise<IncusClientPort | undefined> {
  if (context.client && context.intent.serverId === serverId) return context.client;
  return deps.clients.get(serverId);
}

async function classifyCatalogGet(
  client: IncusClientPort,
  poolName: string,
  incusName: string,
  signal?: AbortSignal,
): Promise<CatalogGetStatus> {
  try {
    await client.getStorageVolume(poolName, 'custom', incusName, signal ? { signal } : undefined);
    return 'present';
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    return 'error';
  }
}

async function verifyAbsent(
  client: IncusClientPort,
  poolName: string,
  incusName: string,
): Promise<void> {
  try {
    await client.getStorageVolume(poolName, 'custom', incusName);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
    reason: 'volume_still_present',
  });
}

async function deleteCatalog(
  deps: VolumeReconcileDeps,
  client: IncusClientPort,
  intent: IntentRecord,
  poolName: string,
  incusName: string,
): Promise<void> {
  await auditIncusMutate(deps.audit, intent, {
    method: 'DELETE',
    path: `/1.0/storage-pools/${poolName}/volumes/custom/${incusName}`,
    instanceName: incusName,
  });
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.deleteStorageVolume(poolName, 'custom', incusName, options),
    ),
    async () => {
      try {
        await client.getStorageVolume(poolName, 'custom', incusName);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      throw new Error('VOLUME_DELETE_NOT_CONFIRMED');
    },
  );
  await verifyAbsent(client, poolName, incusName);
}

/**
 * RemoveAll deletes backing data on one executor. Sticky catalogs on other
 * daemons stay as Incus metadata until purged; leftover inventory treats
 * those as run-owned volumes.
 */
async function purgeStaleCatalogs(
  deps: VolumeReconcileDeps,
  volume: VolumeRecord,
  catalogs: CatalogRow[],
  context: ReconcileRunContext,
): Promise<ReconcileOutcome | null> {
  for (const catalog of catalogs) {
    if (catalog.server_status !== 'online') {
      deps.logger.warn(
        `volume=${volume.id} skip catalog purge on ${catalog.server_id} `
        + `status=${catalog.server_status}`,
      );
      continue;
    }
    let client: IncusClientPort | undefined;
    try {
      client = await clientFor(deps, catalog.server_id, context);
    } catch (error) {
      return destroyRetryFromError(error, catalog.server_id);
    }
    if (!client) {
      return destroyRetry(
        'SERVER_UNREACHABLE',
        'Destroy cannot reach a catalog Incus',
        { serverId: catalog.server_id },
      );
    }
    const status = await classifyCatalogGet(
      client,
      catalog.pool_name,
      volume.incus_name,
      context.signal,
    );
    if (status === 'error') {
      return destroyRetry(
        'VOLUME_DESTROY_RETRY',
        'Destroy catalog purge GET failed',
        { serverId: catalog.server_id },
      );
    }
    if (status === 'missing') continue;
    try {
      await deleteCatalog(deps, client, context.intent, catalog.pool_name, volume.incus_name);
    } catch {
      return destroyRetry(
        'VOLUME_DESTROY_RETRY',
        'Destroy catalog purge was not confirmed with GET 404',
        { serverId: catalog.server_id },
      );
    }
  }
  return null;
}

type ExecutorChoice =
  | { kind: 'retry'; outcome: ReconcileOutcome }
  | { kind: 'executor'; executor: Executor }
  | { kind: 'nothing-to-remove' };

/**
 * A volume that never became a directory is only deleted from a server that
 * actually holds a catalog entry for it: probe every online catalog first.
 */
async function pickExecutorFromCatalogs(
  deps: VolumeReconcileDeps,
  context: ReconcileRunContext,
  volume: VolumeRecord,
  catalogs: CatalogRow[],
): Promise<ExecutorChoice> {
  const present: CatalogRow[] = [];
  for (const catalog of catalogs.filter((item) => item.server_status === 'online')) {
    let client: IncusClientPort | undefined;
    try {
      client = await clientFor(deps, catalog.server_id, context);
    } catch (error) {
      return { kind: 'retry', outcome: destroyRetryFromError(error, catalog.server_id) };
    }
    if (!client) {
      return {
        kind: 'retry',
        outcome: destroyRetry(
          'SERVER_UNREACHABLE',
          'Destroy cannot reach a catalog Incus',
          { serverId: catalog.server_id },
        ),
      };
    }
    const status = await classifyCatalogGet(
      client,
      catalog.pool_name,
      volume.incus_name,
      context.signal,
    );
    if (status === 'error') {
      return {
        kind: 'retry',
        outcome: destroyRetry(
          'VOLUME_DESTROY_RETRY',
          'Destroy tracking GET did not complete with only 200/404',
          { serverId: catalog.server_id },
        ),
      };
    }
    if (status === 'present') present.push(catalog);
  }
  if (present.length === 0) return { kind: 'nothing-to-remove' };
  present.sort((left, right) => left.server_id.localeCompare(right.server_id));
  return { kind: 'executor', executor: present[0]! };
}

async function chooseExecutor(
  deps: VolumeReconcileDeps,
  context: ReconcileRunContext,
  volume: VolumeRecord,
  catalogs: CatalogRow[],
  eligible: Executor[],
): Promise<ExecutorChoice> {
  const pin = volume.remove_all_server_id;
  if (pin) {
    const pinned = eligible.find((item) => item.server_id === pin);
    if (pinned) return { kind: 'executor', executor: pinned };
    return {
      kind: 'retry',
      outcome: destroyRetry(
        'VOLUME_DESTROY_RETRY',
        'Pinned destroy executor is unreachable',
        { serverId: pin },
      ),
    };
  }
  if (!volume.dir_ensured && catalogs.length > 0) {
    const choice = await pickExecutorFromCatalogs(deps, context, volume, catalogs);
    if (choice.kind === 'executor') {
      await deps.store.pinRemoveAllServer(volume.id, choice.executor.server_id);
    }
    return choice;
  }
  const executor = eligible[0]!;
  await deps.store.pinRemoveAllServer(volume.id, executor.server_id);
  return { kind: 'executor', executor };
}

/** RemoveAll on the executor, confirmed by a GET 404; null once the choice is committed. */
async function removeAllOnExecutor(
  deps: VolumeReconcileDeps,
  context: ReconcileRunContext,
  volume: VolumeRecord,
  executor: Executor,
  eligibleCount: number,
): Promise<ReconcileOutcome | null> {
  let client: IncusClientPort | undefined;
  try {
    client = await clientFor(deps, executor.server_id, context);
  } catch (error) {
    return destroyRetryFromError(error, executor.server_id);
  }
  if (!client) {
    return destroyRetry(
      'SERVER_UNREACHABLE',
      'Destroy cannot reach the pinned executor',
      { serverId: executor.server_id },
    );
  }
  const status = await classifyCatalogGet(
    client,
    executor.pool_name,
    volume.incus_name,
    context.signal,
  );
  if (status === 'error') {
    return destroyRetry(
      'VOLUME_DESTROY_RETRY',
      'Destroy executor GET failed',
      { serverId: executor.server_id },
    );
  }
  if (status === 'missing' && volume.dir_ensured && volume.shared_backend_id) {
    const adopted = await ensureSharedCatalogOnServer(client, {
      poolName: executor.pool_name,
      incusName: volume.incus_name,
      sizeBytes: volume.size_bytes,
    });
    if (adopted === 'missing') {
      return destroyRetry(
        'VOLUME_DESTROY_RETRY',
        'Destroy adopt did not create a catalog',
        { serverId: executor.server_id },
      );
    }
  } else if (status === 'missing' && !volume.dir_ensured) {
    return destroyRetry(
      'VOLUME_DESTROY_RETRY',
      'Destroy must not commit from a single executor 404',
      { serverId: executor.server_id },
    );
  }
  if (status === 'present' || (status === 'missing' && volume.dir_ensured)) {
    try {
      await deleteCatalog(deps, client, context.intent, executor.pool_name, volume.incus_name);
    } catch {
      return destroyRetry(
        'VOLUME_DESTROY_RETRY',
        'Destroy RemoveAll was not confirmed with GET 404',
        { serverId: executor.server_id },
      );
    }
  }
  context.lease?.assertOwned();
  await deps.store.markRemoveAllCommitted(volume.id, executor.server_id);
  deps.logger.log(
    `volume=${volume.id} destroy pin=${executor.server_id} committed=true `
    + `eligible=${eligibleCount} dir_ensured=${volume.dir_ensured}`,
  );
  return null;
}

/** Run the RemoveAll commit protocol once; a returned outcome means "retry later". */
async function commitRemoveAll(
  deps: VolumeReconcileDeps,
  context: ReconcileRunContext,
  volume: VolumeRecord,
  catalogs: CatalogRow[],
  eligible: Executor[],
): Promise<ReconcileOutcome | null> {
  const choice = await chooseExecutor(deps, context, volume, catalogs, eligible);
  if (choice.kind === 'retry') return choice.outcome;
  if (choice.kind === 'nothing-to-remove') {
    context.lease?.assertOwned();
    await deps.store.markRemoveAllCommitted(volume.id, null);
    return null;
  }
  return removeAllOnExecutor(deps, context, volume, choice.executor, eligible.length);
}

export async function reconcileDestroy(
  deps: VolumeReconcileDeps,
  context: ReconcileRunContext,
): Promise<ReconcileOutcome> {
  const { store } = deps;
  const volume = await store.readVolumeRow(context.intent.resourceId);
  if (!volume) {
    return { outcome: 'succeeded', observedRevision: context.intent.targetRevision };
  }
  if (volume.lifecycle_phase !== 'deleting') {
    return { outcome: 'succeeded', observedRevision: volume.revision };
  }
  if (await store.hasAnyAttachments(volume.id)) {
    return destroyRetry(
      'VOLUME_REQUIRES_UNBIND',
      'The volume cannot be deleted while attachments remain',
      { volumeId: volume.id },
    );
  }
  await store.lockVolumeQuota(volume);

  const catalogs = await store.listCatalogs(volume.id);
  if (!volume.dir_ensured && catalogs.length === 0) {
    await store.finishEmptyTracking(volume.id, 'never_mounted');
    return { outcome: 'succeeded', observedRevision: volume.revision };
  }

  const eligible = await store.listDestroyExecutors(volume);
  if (eligible.length === 0) {
    await store.dropAllPlacements(volume.id);
    await store.finishEmptyTracking(volume.id, 'destroy_executor_gone');
    return { outcome: 'succeeded', observedRevision: volume.revision };
  }

  if (!volume.remove_all_committed) {
    const retry = await commitRemoveAll(deps, context, volume, catalogs, eligible);
    if (retry) return retry;
  }

  const stale = await purgeStaleCatalogs(deps, volume, catalogs, context);
  if (stale) return stale;
  await store.dropAllPlacements(volume.id);
  await store.finishEmptyTracking(volume.id);
  return { outcome: 'succeeded', observedRevision: volume.revision };
}
