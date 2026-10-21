import { requestAndWait, readAfterTimeout, type IncusClientPort } from '../incus/index.js';
import {
  asBytes,
  isNotFound,
  poolForPlacement,
  scanNeedsEnsure,
  storageVolumeName,
  type StorageVolume,
} from './volume-reconcile-support.js';
import type { VolumeReconcileDeps } from './volume-reconcile-deps.js';
import { normalizeObservedVolumeUsage, type VolumeDriver } from './volume-usage.js';

type ScanPool = Awaited<ReturnType<VolumeReconcileDeps['store']['listRegisteredPools']>>[number];
type ScanVolume = Awaited<ReturnType<VolumeReconcileDeps['store']['listScanVolumes']>>[number];
type ScanPlacement = Awaited<ReturnType<VolumeReconcileDeps['store']['listPlacementsOnServer']>>[number];

const MANAGED_VOLUME_NAME = /^nyv-[0-9a-f]{32}$/;

/** Everything one scan compares: PG volumes and placements against what Incus lists. */
interface ScanInventory {
  pools: ScanPool[];
  rows: ScanVolume[];
  knownNames: Set<string>;
  listedByPool: Map<string, readonly (StorageVolume | string)[]>;
  listedByName: Map<string, StorageVolume | string>;
  placementByVolume: Map<string, ScanPlacement>;
}

async function loadInventory(
  deps: VolumeReconcileDeps,
  serverId: string,
  client: IncusClientPort | undefined,
  signal: AbortSignal | undefined,
): Promise<ScanInventory> {
  const { store } = deps;
  const pools = await store.listRegisteredPools(serverId);
  const shareableBackendIds = [...new Set(
    pools
      .filter((pool) => pool.driver === 'cephfs' && pool.shareable && pool.shared_backend_id)
      .map((pool) => pool.shared_backend_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];
  const rows = await store.listScanVolumes(serverId, shareableBackendIds);
  const knownNames = await store.listKnownIncusNames();
  const listedByPool = new Map<string, readonly (StorageVolume | string)[]>();
  const listedByName = new Map<string, StorageVolume | string>();
  if (client) {
    for (const pool of pools) {
      const listed = await client.listStorageVolumes(pool.incus_name, 'custom', 1, { signal });
      listedByPool.set(pool.incus_name, listed.metadata);
      for (const volume of listed.metadata) {
        listedByName.set(storageVolumeName(volume), volume);
      }
    }
  }
  const placements = await store.listPlacementsOnServer(serverId);
  const placementByVolume = new Map(placements.map((row) => [row.volume_id, row]));
  return { pools, rows, knownNames, listedByPool, listedByName, placementByVolume };
}

/** Refresh `used_bytes` from the live volume state; a vanished volume is not an error. */
async function observeVolumeUsage(
  deps: VolumeReconcileDeps,
  client: IncusClientPort,
  pool: { incus_name: string; driver: string; resize_family: string } | undefined,
  row: { id: string; incus_name: string; size_bytes: string | number },
): Promise<void> {
  if (!pool) return;
  const resizeFamily = pool.resize_family === 'block_backed' ? 'block_backed' : 'quota_online';
  try {
    const state = (await client.getStorageVolumeState(pool.incus_name, 'custom', row.incus_name)).metadata;
    const used = normalizeObservedVolumeUsage({
      resizeFamily,
      driver: pool.driver as VolumeDriver,
      usedBytes: asBytes(state.usage?.used) ?? null,
      totalBytes: asBytes(state.usage?.total) ?? null,
      currentSizeBytes: asBytes(row.size_bytes) ?? 0n,
    });
    await deps.store.recordObservedUsage(row.id, used);
  } catch (error) {
    if (!isNotFound(error)) {
      deps.logger.warn(`volume=${row.id} used_bytes scan failed: ${String(error)}`);
    }
  }
}

/** Queue whatever intent each tracked volume on this server still needs. */
async function converge(
  deps: VolumeReconcileDeps,
  serverId: string,
  client: IncusClientPort | undefined,
  inventory: ScanInventory,
): Promise<void> {
  const { store, logger } = deps;
  for (const row of inventory.rows) {
    if (row.lifecycle_phase === 'deleting') {
      await store.enqueueDestroy(row);
      continue;
    }
    const placement = inventory.placementByVolume.get(row.id);
    if (!placement) continue;
    const listed = inventory.listedByName.get(row.incus_name);
    const shared = row.shared_backend_id !== null;
    if (shared && listed === undefined) {
      logger.warn(`dangling_pg volume=${row.id} server=${serverId}`);
      continue;
    }
    if (listed !== undefined && placement.catalog_state === 'present' && client) {
      await observeVolumeUsage(
        deps,
        client,
        poolForPlacement(inventory.pools, placement.pool_id),
        row,
      );
    }
    if (row.needs_attention) {
      continue;
    }
    if (shared) {
      if (listed !== undefined && scanNeedsEnsure(row, listed)) {
        await store.enqueueResize(row, serverId);
      }
      continue;
    }
    if (scanNeedsEnsure(row, listed)) {
      await store.enqueueEnsure(
        row,
        serverId,
        placement.catalog_state === 'present' ? 'ensure_attachment' : 'create',
      );
    }
  }
}

async function deleteOrphanVolume(
  client: IncusClientPort,
  poolName: string,
  volumeName: string,
  signal?: AbortSignal,
): Promise<void> {
  await readAfterTimeout(
    () => requestAndWait(
      client,
      (options) => client.deleteStorageVolume(poolName, 'custom', volumeName, {
        ...options,
        signal,
      }),
    ),
    async () => {
      try {
        await client.getStorageVolume(poolName, 'custom', volumeName, { signal });
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      throw new Error('VOLUME_ORPHAN_DELETE_NOT_CONFIRMED');
    },
  );
}

/** Delete Incus volumes that follow our naming but that no logical volume owns. */
async function deleteOrphans(
  deps: VolumeReconcileDeps,
  serverId: string,
  client: IncusClientPort,
  inventory: ScanInventory,
  signal: AbortSignal | undefined,
): Promise<void> {
  const placedNames = new Set(
    inventory.rows
      .filter((row) => inventory.placementByVolume.has(row.id))
      .map((row) => row.incus_name),
  );
  for (const pool of inventory.pools) {
    for (const volume of inventory.listedByPool.get(pool.incus_name) ?? []) {
      const name = storageVolumeName(volume);
      if (!MANAGED_VOLUME_NAME.test(name)) continue;
      if (inventory.knownNames.has(name)) {
        if (!placedNames.has(name)) {
          deps.logger.warn(
            `Listed ${name} on server ${serverId} has no catalog placement; not deleting`,
          );
        }
        continue;
      }
      if (typeof volume !== 'string' && (volume.used_by ?? []).length > 0) continue;
      await deleteOrphanVolume(client, pool.incus_name, name, signal);
    }
  }
}

export async function scanServerVolumes(
  deps: VolumeReconcileDeps,
  serverId: string,
  client?: IncusClientPort,
  signal?: AbortSignal,
): Promise<void> {
  const inventory = await loadInventory(deps, serverId, client, signal);
  await converge(deps, serverId, client, inventory);
  if (!client) return;
  await deleteOrphans(deps, serverId, client, inventory, signal);
}
