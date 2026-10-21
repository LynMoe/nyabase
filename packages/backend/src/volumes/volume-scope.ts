import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { FailureCode, StoragePoolResizeFamily, type LocalVolumeScope } from '@nyabase/common';
import type { Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { assertPoolGrant, requireServerAccess } from './volume-grants.js';
import type { VolumeDeps } from './volume-read-model.js';

export interface ResolvedLocalScope {
  poolId: string;
  serverId: string;
  sharedBackendId: null;
  anchorServerId: string;
}

type PoolShape = {
  id: string;
  registered: boolean;
  server_id: string;
  shared_backend_id: string | null;
  shareable: boolean;
  resize_family: string;
  quota_effective: boolean | null;
};

function assertPoolMatchesLocalScope(pool: PoolShape, scope: LocalVolumeScope): void {
  if (
    pool.server_id !== scope.serverId
    || pool.shared_backend_id !== null
    || pool.shareable
  ) {
    throw new BadRequestException('Local volume scope does not match the pool');
  }
  if (
    pool.resize_family === StoragePoolResizeFamily.QuotaOnline
    && pool.quota_effective === false
  ) {
    throw new ConflictException({
      code: FailureCode.StoragePoolQuotaIneffective,
      message: 'This storage pool cannot enforce custom volume quotas',
      details: { poolId: pool.id },
    });
  }
}

/** Resolve and lock the pool of a local volume scope and check the owner's server and pool coverage. */
export async function resolveOwnerScope(
  deps: VolumeDeps,
  transaction: Transaction<NyabaseDatabase>,
  ownerId: string,
  scope: LocalVolumeScope,
): Promise<ResolvedLocalScope> {
  const pool = await deps.pools.findById(scope.poolId, transaction);
  if (!pool || !pool.registered) throw new NotFoundException('Registered storage pool not found');
  assertPoolMatchesLocalScope(pool, scope);
  const lockedPool = await deps.pools.lockCapacityScope(
    pool.id,
    scope.serverId,
    [null],
    transaction,
  );
  if (!lockedPool.registered) {
    throw new BadRequestException('Local volume scope does not match the pool');
  }
  assertPoolMatchesLocalScope(lockedPool, scope);
  await requireServerAccess(transaction, ownerId, scope.serverId);
  await assertPoolGrant(transaction, ownerId, lockedPool.id);
  return {
    poolId: lockedPool.id,
    serverId: scope.serverId,
    sharedBackendId: null,
    anchorServerId: lockedPool.server_id,
  };
}
