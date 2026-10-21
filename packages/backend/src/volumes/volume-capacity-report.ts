import { StoragePoolResizeFamily, type StorageCapacityDto } from '@nyabase/common';
import { numberValue } from '../platform/domain-utils.js';
import { isLocalPoolRow, storagePoolCapability } from '../storage-pools/storage-pool-capability.js';
import {
  committedPoolBytes,
  ownerServerCommittedBytes,
  serverCommittedBytes,
  serverOvercommit,
} from './volume-capacity.js';
import { requireServerAccess } from './volume-grants.js';
import type { VolumeDeps } from './volume-read-model.js';

type PoolCapacityDto = StorageCapacityDto['pools'][number];

async function poolCapacities(deps: VolumeDeps, serverId: string): Promise<PoolCapacityDto[]> {
  const pools = (await deps.pools.list(serverId)).filter(isLocalPoolRow);
  const overcommitRatio = await serverOvercommit(deps, serverId);
  const result: PoolCapacityDto[] = [];
  for (const pool of pools) {
    const committed = await committedPoolBytes(deps, pool.id);
    result.push({
      poolId: pool.id,
      displayName: pool.display_name,
      driver: pool.driver as PoolCapacityDto['driver'],
      shareable: pool.shareable,
      totalBytes: pool.total_bytes === null ? null : numberValue(pool.total_bytes),
      committedBytes: committed,
      availableBytes: pool.total_bytes === null
        ? null
        : Math.max(0, numberValue(pool.total_bytes) * overcommitRatio - committed),
      quotaEffective: pool.quota_effective,
      overcommitRatio,
      capability: storagePoolCapability(
        pool.resize_family as StoragePoolResizeFamily,
        pool.quota_effective,
        pool.block_filesystem,
      ),
    });
  }
  return result;
}

/** `scope=mine`: the caller's own storage on a server they hold a grant for. */
export async function ownerCapacity(
  deps: VolumeDeps,
  ownerId: string,
  serverId: string,
): Promise<StorageCapacityDto> {
  const grant = await requireServerAccess(deps.database, ownerId, serverId);
  const pools = await poolCapacities(deps, serverId);
  const sums = await ownerServerCommittedBytes(deps, ownerId, serverId);
  const limit = grant.diskBytes;
  return {
    grantLimitBytes: limit,
    usedByRootDisksBytes: sums.root,
    usedByLocalVolumesBytes: sums.local,
    availableBytes: limit === null ? null : Math.max(0, limit - sums.root - sums.local),
    pools,
  };
}

/** `scope=all`: the server-wide view for `ManageServers`. */
export async function serverWideCapacity(
  deps: VolumeDeps,
  serverId: string,
): Promise<StorageCapacityDto> {
  const pools = await poolCapacities(deps, serverId);
  const sums = await serverCommittedBytes(deps, serverId);
  return {
    grantLimitBytes: null,
    usedByRootDisksBytes: sums.root,
    usedByLocalVolumesBytes: sums.local,
    availableBytes: null,
    pools,
  };
}
