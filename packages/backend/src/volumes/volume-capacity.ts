import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { FailureCode } from '@nyabase/common';
import { sql, type Transaction } from 'kysely';
import { numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { effectiveSharedGrant, requireServerAccess } from './volume-grants.js';
import type { VolumeDeps } from './volume-read-model.js';
import type { VolumeExecutor } from './volumes.repository.js';

type Tx = Transaction<NyabaseDatabase>;

/** Serialises quota changes of one volume's capacity scope (server pool, or shared backend). */
export async function lockVolumeQuota(
  pools: StoragePoolsRepository,
  volume: { server_id: string | null; pool_id: string | null; shared_backend_id: string | null },
  transaction: Tx,
): Promise<void> {
  if (volume.server_id !== null) {
    if (!volume.pool_id) throw new ConflictException({ code: FailureCode.InvalidInput });
    await pools.lockCapacityScope(volume.pool_id, volume.server_id, [], transaction);
    return;
  }
  await pools.lockSharedBackends([volume.shared_backend_id], transaction);
}

/** Root-disk bytes committed by live containers (a pending resize counts at its larger size). */
async function committedRootBytes(
  executor: VolumeExecutor,
  filter: { ownerId?: string; serverId?: string; poolId?: string },
): Promise<number> {
  let query = executor.selectFrom('control.containers').select(sql<string>`coalesce(sum(
      case when root_size_pending_bytes is null
        then root_size_bytes
        else greatest(root_size_bytes, root_size_pending_bytes)
      end
    ), 0)`.as('bytes'))
    .where('lifecycle_phase', 'not in', ['failed', 'deleting']);
  if (filter.ownerId !== undefined) query = query.where('owner_id', '=', filter.ownerId);
  if (filter.serverId !== undefined) query = query.where('server_id', '=', filter.serverId);
  if (filter.poolId !== undefined) query = query.where('root_pool_id', '=', filter.poolId);
  const row = await query.executeTakeFirstOrThrow();
  return numberValue(row.bytes);
}

export async function committedPoolBytes(
  deps: VolumeDeps,
  poolId: string,
  executor: VolumeExecutor = deps.database,
): Promise<number> {
  const [volumes, roots] = await Promise.all([
    deps.repository.sumLiveSizeBytes({ kind: 'local', poolId }, executor),
    committedRootBytes(executor, { poolId }),
  ]);
  return volumes + roots;
}

export async function ownerServerCommittedBytes(
  deps: VolumeDeps,
  ownerId: string,
  serverId: string,
  executor: VolumeExecutor = deps.database,
): Promise<{ root: number; local: number }> {
  const [root, local] = await Promise.all([
    committedRootBytes(executor, { ownerId, serverId }),
    deps.repository.sumLiveSizeBytes({ kind: 'local', ownerId, serverId }, executor),
  ]);
  return { root, local };
}

export async function serverCommittedBytes(
  deps: VolumeDeps,
  serverId: string,
  executor: VolumeExecutor = deps.database,
): Promise<{ root: number; local: number }> {
  const [root, local] = await Promise.all([
    committedRootBytes(executor, { serverId }),
    deps.repository.sumLiveSizeBytes({ kind: 'local', serverId }, executor),
  ]);
  return { root, local };
}

export async function serverOvercommit(
  deps: VolumeDeps,
  serverId: string,
  executor: VolumeExecutor = deps.database,
): Promise<number> {
  const server = await executor.selectFrom('infra.servers')
    .select('storage_overcommit_ratio')
    .where('id', '=', serverId)
    .executeTakeFirst();
  return server ? numberValue(server.storage_overcommit_ratio) : 1;
}

async function assertSharedBackendPhysicalCapacity(
  deps: VolumeDeps,
  backend: { total_bytes: string | number | null; overcommit_ratio: string | number },
  sharedBackendId: string,
  delta: number,
  transaction: Tx,
): Promise<void> {
  const committed = await deps.repository.sumLiveSizeBytes(
    { kind: 'shared', sharedBackendId },
    transaction,
  );
  if (
    backend.total_bytes !== null
    && committed + delta
      > numberValue(backend.total_bytes) * numberValue(backend.overcommit_ratio)
  ) {
    throw new ConflictException({
      code: FailureCode.SharedBackendQuotaExceeded,
      message: 'Shared backend capacity exhausted',
      details: {
        sharedBackendId,
        requestedBytes: delta,
        availableBytes: Math.max(
          0,
          numberValue(backend.total_bytes) * numberValue(backend.overcommit_ratio) - committed,
        ),
        overcommitRatio: numberValue(backend.overcommit_ratio),
      },
    });
  }
}

async function assertLocalPoolPhysicalCapacity(
  deps: VolumeDeps,
  pool: { total_bytes: string | number | null },
  poolId: string,
  serverId: string,
  delta: number,
  transaction: Tx,
): Promise<void> {
  const committed = await committedPoolBytes(deps, poolId, transaction);
  const total = pool.total_bytes === null ? null : numberValue(pool.total_bytes);
  const ratio = await serverOvercommit(deps, serverId, transaction);
  if (total !== null && committed + delta > total * ratio) {
    throw new ConflictException({
      code: FailureCode.StoragePoolExhausted,
      message: 'Storage pool overcommit capacity exceeded',
      details: {
        poolId,
        requestedBytes: delta,
        availableBytes: Math.max(0, total * ratio - committed),
        overcommitRatio: ratio,
      },
    });
  }
}

function loadBackend(transaction: Tx, sharedBackendId: string) {
  return transaction.selectFrom('infra.shared_backends')
    .selectAll().where('id', '=', sharedBackendId).executeTakeFirstOrThrow();
}

/** Grant quota and physical capacity of a shared backend, with the backend scope already locked. */
async function assertSharedBackendCapacityWithinGrants(
  deps: VolumeDeps,
  transaction: Tx,
  ownerId: string,
  sharedBackendId: string,
  delta: number,
): Promise<void> {
  const backend = await loadBackend(transaction, sharedBackendId);
  const grant = await effectiveSharedGrant(transaction, ownerId, sharedBackendId);
  if (grant === undefined) {
    throw new ForbiddenException('Shared backend access is not granted');
  }
  const userUsed = await deps.repository.sumLiveSizeBytes(
    { kind: 'shared', ownerId, sharedBackendId },
    transaction,
  );
  if (grant !== null && grant > 0 && userUsed + delta > grant) {
    throw new ConflictException({
      code: FailureCode.SharedBackendQuotaExceeded,
      message: 'Shared backend grant quota exceeded',
      details: {
        sharedBackendId,
        requestedBytes: delta,
        availableBytes: Math.max(0, grant - userUsed),
        grantLimitBytes: grant,
      },
    });
  }
  await assertSharedBackendPhysicalCapacity(deps, backend, sharedBackendId, delta, transaction);
}

export async function assertSharedCapacityWithinGrants(
  deps: VolumeDeps,
  transaction: Tx,
  ownerId: string,
  sharedBackendId: string,
  delta: number,
): Promise<void> {
  if (delta <= 0) return;
  await deps.pools.lockSharedBackends([sharedBackendId], transaction);
  await assertSharedBackendCapacityWithinGrants(deps, transaction, ownerId, sharedBackendId, delta);
}

export async function assertSharedCapacityPhysical(
  deps: VolumeDeps,
  transaction: Tx,
  sharedBackendId: string,
  delta: number,
): Promise<void> {
  if (delta <= 0) return;
  await deps.pools.lockSharedBackends([sharedBackendId], transaction);
  const backend = await loadBackend(transaction, sharedBackendId);
  await assertSharedBackendPhysicalCapacity(deps, backend, sharedBackendId, delta, transaction);
}

/** Grant limits plus physical capacity for growing a volume (owner rules). */
export async function assertCapacityWithinGrants(
  deps: VolumeDeps,
  transaction: Tx,
  ownerId: string,
  serverId: string | null,
  poolId: string,
  sharedBackendId: string | null,
  delta: number,
): Promise<void> {
  if (delta <= 0) return;
  await deps.pools.lockCapacityScope(poolId, serverId, [sharedBackendId], transaction);
  if (sharedBackendId) {
    await assertSharedBackendCapacityWithinGrants(
      deps,
      transaction,
      ownerId,
      sharedBackendId,
      delta,
    );
    return;
  }
  if (!serverId) throw new BadRequestException('Local capacity requires a server');
  const pool = await transaction.selectFrom('infra.storage_pools')
    .selectAll().where('id', '=', poolId).executeTakeFirstOrThrow();
  const grant = await requireServerAccess(transaction, ownerId, serverId);
  const sums = await ownerServerCommittedBytes(deps, ownerId, serverId, transaction);
  if (grant.diskBytes !== null && sums.root + sums.local + delta > grant.diskBytes) {
    throw new ConflictException({
      code: FailureCode.StorageGrantExceeded,
      message: 'Server storage grant exceeded',
      details: {
        requestedBytes: delta,
        availableBytes: Math.max(0, grant.diskBytes - sums.root - sums.local),
        grantLimitBytes: grant.diskBytes,
      },
    });
  }
  await assertLocalPoolPhysicalCapacity(deps, pool, poolId, serverId, delta, transaction);
}

/** Physical capacity only, for administrators who bypass per-user grant limits. */
export async function assertCapacityPhysical(
  deps: VolumeDeps,
  transaction: Tx,
  serverId: string | null,
  poolId: string,
  sharedBackendId: string | null,
  delta: number,
): Promise<void> {
  if (delta <= 0) return;
  await deps.pools.lockCapacityScope(poolId, serverId, [sharedBackendId], transaction);
  if (sharedBackendId) {
    const backend = await loadBackend(transaction, sharedBackendId);
    await assertSharedBackendPhysicalCapacity(deps, backend, sharedBackendId, delta, transaction);
    return;
  }
  if (!serverId) throw new BadRequestException('Local capacity requires a server');
  const pool = await transaction.selectFrom('infra.storage_pools')
    .selectAll().where('id', '=', poolId).executeTakeFirstOrThrow();
  await assertLocalPoolPhysicalCapacity(deps, pool, poolId, serverId, delta, transaction);
}

/** A shared volume can only be created once some server has a quota-capable CephFS pool for the backend. */
export async function assertSharedCreateHealth(
  deps: VolumeDeps,
  sharedBackendId: string,
  transaction: Tx,
): Promise<void> {
  const pools = await deps.pools.listRegisteredSharedPools(
    { backendIds: [sharedBackendId] },
    transaction,
  );
  if (pools.length === 0) {
    throw new ConflictException({
      code: FailureCode.InvalidInput,
      message: '该共享后端尚未在任何服务器上登记可写配额的 CephFS 池',
      details: { sharedBackendId },
    });
  }
  if (!pools.some((pool) => pool.quota_effective === true)) {
    throw new ConflictException({
      code: FailureCode.StoragePoolQuotaIneffective,
      message: 'This shared CephFS pool cannot enforce custom volume quotas',
      details: { sharedBackendId },
    });
  }
}
