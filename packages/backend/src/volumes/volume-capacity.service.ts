import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  FailureCode,
  StoragePoolResizeFamily,
  type LocalVolumeScope,
  type StorageCapacityDto,
} from '@nyabase/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { isLocalPoolRow, storagePoolCapability } from '../storage-pools/storage-pool-capability.js';
import {
  assertPoolGrant,
  effectiveSharedGrant,
  requireServerAccess,
  type VolumeExecutor,
  type VolumesRepository,
} from './volumes.repository.js';

type Tx = Transaction<NyabaseDatabase>;

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

function loadBackend(transaction: Tx, sharedBackendId: string) {
  return transaction.selectFrom('infra.shared_backends')
    .selectAll().where('id', '=', sharedBackendId).executeTakeFirstOrThrow();
}

type PoolCapacityDto = StorageCapacityDto['pools'][number];

/**
 * Capacity rules for volumes: committed bytes per pool/server/backend, the grant
 * and physical-capacity admission checks, the capacity reports, and resolving a
 * local volume's scope. Locks the capacity scope so concurrent admissions serialise.
 */
export class VolumeCapacityService {
  constructor(
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly repository: VolumesRepository,
    private readonly pools: StoragePoolsRepository,
  ) {}

  /** Serialises quota changes of one volume's capacity scope (server pool, or shared backend). */
  async lockVolumeQuota(
    volume: { server_id: string | null; pool_id: string | null; shared_backend_id: string | null },
    transaction: Tx,
  ): Promise<void> {
    if (volume.server_id !== null) {
      if (!volume.pool_id) throw new ConflictException({ code: FailureCode.InvalidInput });
      await this.pools.lockCapacityScope(volume.pool_id, volume.server_id, [], transaction);
      return;
    }
    await this.pools.lockSharedBackends([volume.shared_backend_id], transaction);
  }

  async committedPoolBytes(
    poolId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<number> {
    const [volumes, roots] = await Promise.all([
      this.repository.sumLiveSizeBytes({ kind: 'local', poolId }, executor),
      committedRootBytes(executor, { poolId }),
    ]);
    return volumes + roots;
  }

  async ownerServerCommittedBytes(
    ownerId: string,
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<{ root: number; local: number }> {
    const [root, local] = await Promise.all([
      committedRootBytes(executor, { ownerId, serverId }),
      this.repository.sumLiveSizeBytes({ kind: 'local', ownerId, serverId }, executor),
    ]);
    return { root, local };
  }

  async serverCommittedBytes(
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<{ root: number; local: number }> {
    const [root, local] = await Promise.all([
      committedRootBytes(executor, { serverId }),
      this.repository.sumLiveSizeBytes({ kind: 'local', serverId }, executor),
    ]);
    return { root, local };
  }

  async serverOvercommit(
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<number> {
    const server = await executor.selectFrom('infra.servers')
      .select('storage_overcommit_ratio')
      .where('id', '=', serverId)
      .executeTakeFirst();
    return server ? numberValue(server.storage_overcommit_ratio) : 1;
  }

  private async assertSharedBackendPhysicalCapacity(
    backend: { total_bytes: string | number | null; overcommit_ratio: string | number },
    sharedBackendId: string,
    delta: number,
    transaction: Tx,
  ): Promise<void> {
    const committed = await this.repository.sumLiveSizeBytes(
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

  private async assertLocalPoolPhysicalCapacity(
    pool: { total_bytes: string | number | null },
    poolId: string,
    serverId: string,
    delta: number,
    transaction: Tx,
  ): Promise<void> {
    const committed = await this.committedPoolBytes(poolId, transaction);
    const total = pool.total_bytes === null ? null : numberValue(pool.total_bytes);
    const ratio = await this.serverOvercommit(serverId, transaction);
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

  /** Grant quota and physical capacity of a shared backend, with the backend scope already locked. */
  private async assertSharedBackendCapacityWithinGrants(
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
    const userUsed = await this.repository.sumLiveSizeBytes(
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
    await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, delta, transaction);
  }

  async assertSharedCapacityWithinGrants(
    transaction: Tx,
    ownerId: string,
    sharedBackendId: string,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    await this.pools.lockSharedBackends([sharedBackendId], transaction);
    await this.assertSharedBackendCapacityWithinGrants(transaction, ownerId, sharedBackendId, delta);
  }

  async assertSharedCapacityPhysical(
    transaction: Tx,
    sharedBackendId: string,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    await this.pools.lockSharedBackends([sharedBackendId], transaction);
    const backend = await loadBackend(transaction, sharedBackendId);
    await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, delta, transaction);
  }

  /** Grant limits plus physical capacity for growing a volume (owner rules). */
  async assertCapacityWithinGrants(
    transaction: Tx,
    ownerId: string,
    serverId: string | null,
    poolId: string,
    sharedBackendId: string | null,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    await this.pools.lockCapacityScope(poolId, serverId, [sharedBackendId], transaction);
    if (sharedBackendId) {
      await this.assertSharedBackendCapacityWithinGrants(transaction,
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
    const sums = await this.ownerServerCommittedBytes(ownerId, serverId, transaction);
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
    await this.assertLocalPoolPhysicalCapacity(pool, poolId, serverId, delta, transaction);
  }

  /** Physical capacity only, for administrators who bypass per-user grant limits. */
  async assertCapacityPhysical(
    transaction: Tx,
    serverId: string | null,
    poolId: string,
    sharedBackendId: string | null,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    await this.pools.lockCapacityScope(poolId, serverId, [sharedBackendId], transaction);
    if (sharedBackendId) {
      const backend = await loadBackend(transaction, sharedBackendId);
      await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, delta, transaction);
      return;
    }
    if (!serverId) throw new BadRequestException('Local capacity requires a server');
    const pool = await transaction.selectFrom('infra.storage_pools')
      .selectAll().where('id', '=', poolId).executeTakeFirstOrThrow();
    await this.assertLocalPoolPhysicalCapacity(pool, poolId, serverId, delta, transaction);
  }

  /** A shared volume can only be created once some server has a quota-capable CephFS pool for the backend. */
  async assertSharedCreateHealth(
    sharedBackendId: string,
    transaction: Tx,
  ): Promise<void> {
    const pools = await this.pools.listRegisteredSharedPools(
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

  private async poolCapacities(
    serverId: string): Promise<PoolCapacityDto[]> {
    const pools = (await this.pools.list(serverId)).filter(isLocalPoolRow);
    const overcommitRatio = await this.serverOvercommit(serverId);
    const result: PoolCapacityDto[] = [];
    for (const pool of pools) {
      const committed = await this.committedPoolBytes(pool.id);
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
  async ownerCapacity(
    ownerId: string,
    serverId: string,
  ): Promise<StorageCapacityDto> {
    const grant = await requireServerAccess(this.database, ownerId, serverId);
    const pools = await this.poolCapacities(serverId);
    const sums = await this.ownerServerCommittedBytes(ownerId, serverId);
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
  async serverWideCapacity(
    serverId: string,
  ): Promise<StorageCapacityDto> {
    const pools = await this.poolCapacities(serverId);
    const sums = await this.serverCommittedBytes(serverId);
    return {
      grantLimitBytes: null,
      usedByRootDisksBytes: sums.root,
      usedByLocalVolumesBytes: sums.local,
      availableBytes: null,
      pools,
    };
  }

  /** Resolve and lock the pool of a local volume scope and check the owner's server and pool coverage. */
  async resolveOwnerScope(
    transaction: Transaction<NyabaseDatabase>,
    ownerId: string,
    scope: LocalVolumeScope,
  ): Promise<ResolvedLocalScope> {
    const pool = await this.pools.findById(scope.poolId, transaction);
    if (!pool || !pool.registered) throw new NotFoundException('Registered storage pool not found');
    assertPoolMatchesLocalScope(pool, scope);
    const lockedPool = await this.pools.lockCapacityScope(
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
}
