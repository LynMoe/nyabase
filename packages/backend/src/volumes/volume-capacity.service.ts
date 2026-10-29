import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { committedRootBytesSql } from '../platform/persistence-pg/committed-bytes.js';
import {
  FailureCode,
  StoragePoolResizeFamily,
  type LocalVolumeScope,
  type StorageCapacityDto,
} from '@nyabase/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { isLocalPoolRow, storagePoolCapability } from '../storage-pools/storage-pool-capability.js';
import {
  listPoolAccess,
  type PoolAccess,
  type ServerAccess,
} from '../iam/effective-access.js';
import {
  assertPoolGrant,
  effectiveSharedGrant,
  requireServerAccess,
  type VolumeExecutor,
  VolumesRepository,
} from './volumes.repository.js';
import { overcommitAvailableBytes } from './volume-rules.js';

type Tx = Transaction<NyabaseDatabase>;

export interface ResolvedLocalScope {
  poolId: string;
  serverId: string;
  sharedBackendId: null;
  anchorServerId: string;
}

type PoolRow = NonNullable<Awaited<ReturnType<StoragePoolsRepository['findById']>>>;

function assertPoolMatchesLocalScope(pool: PoolRow, scope: LocalVolumeScope): void {
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
  let query = executor.selectFrom('control.containers')
    .select(sql<string>`coalesce(sum(${committedRootBytesSql()}), 0)`.as('bytes'))
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
@Injectable()
export class VolumeCapacityService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
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

  /** The owner's committed local-volume bytes on one pool, as its data-disk quota counts them. */
  async ownerPoolCommittedBytes(
    ownerId: string,
    poolId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<number> {
    return this.repository.sumLiveSizeBytes({ kind: 'local', ownerId, poolId }, executor);
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

  /**
   * Overcommit lets the backend's volumes together reach total × ratio; one
   * owner's volumes on it never exceed the physical total.
   */
  private async assertSharedBackendPhysicalCapacity(
    backend: { total_bytes: string | number | null; overcommit_ratio: string | number },
    sharedBackendId: string,
    ownerId: string,
    delta: number,
    transaction: Tx,
  ): Promise<void> {
    if (backend.total_bytes === null) return;
    const [committed, ownerCommitted] = await Promise.all([
      this.repository.sumLiveSizeBytes({ kind: 'shared', sharedBackendId }, transaction),
      this.repository.sumLiveSizeBytes({ kind: 'shared', ownerId, sharedBackendId }, transaction),
    ]);
    const total = numberValue(backend.total_bytes);
    const ratio = numberValue(backend.overcommit_ratio);
    const available = overcommitAvailableBytes(total, ratio, committed, ownerCommitted);
    if (delta > available) {
      throw new ConflictException({
        code: FailureCode.SharedBackendQuotaExceeded,
        message: 'Shared backend capacity exhausted',
        details: { sharedBackendId, requestedBytes: delta, availableBytes: available, overcommitRatio: ratio },
      });
    }
  }

  /** As for shared backends: the pool's commitments together reach total × ratio, one owner's stay within total. */
  private async assertLocalPoolPhysicalCapacity(
    pool: { total_bytes: string | number | null },
    poolId: string,
    serverId: string,
    ownerId: string,
    delta: number,
    transaction: Tx,
  ): Promise<void> {
    if (pool.total_bytes === null) return;
    const [committed, ownerCommitted, ratio] = await Promise.all([
      this.committedPoolBytes(poolId, transaction),
      this.ownerPoolPhysicalBytes(ownerId, poolId, transaction),
      this.serverOvercommit(serverId, transaction),
    ]);
    const available = overcommitAvailableBytes(numberValue(pool.total_bytes), ratio, committed, ownerCommitted);
    if (delta > available) {
      throw new ConflictException({
        code: FailureCode.StoragePoolExhausted,
        message: 'Storage pool overcommit capacity exceeded',
        details: { poolId, requestedBytes: delta, availableBytes: available, overcommitRatio: ratio },
      });
    }
  }

  /** Everything the owner commits on a pool: root disks and local volumes (unlike the data-disk quota, which counts volumes only). */
  async ownerPoolPhysicalBytes(
    ownerId: string,
    poolId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<number> {
    const [volumes, roots] = await Promise.all([
      this.ownerPoolCommittedBytes(ownerId, poolId, executor),
      committedRootBytes(executor, { ownerId, poolId }),
    ]);
    return volumes + roots;
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
    if (grant !== null && userUsed + delta > grant) {
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
    await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, ownerId, delta, transaction);
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

  /**
   * The backend's per-user cap on shared volumes, for a create. Runs in the
   * create's SERIALIZABLE transaction (`VOLUME_TX`): two creates of the same
   * owner racing for the last slot read and insert the same predicate, so one
   * aborts with 40001 and its retry sees the other's volume.
   */
  async assertSharedVolumeSlot(transaction: Tx, ownerId: string, sharedBackendId: string): Promise<void> {
    const backend = await loadBackend(transaction, sharedBackendId);
    const limit = backend.max_volumes_per_user;
    if (limit === null) return;
    const owned = await this.repository.countLiveSharedVolumes(ownerId, sharedBackendId, transaction);
    if (owned >= limit) {
      throw new ConflictException({
        code: FailureCode.SharedBackendVolumeLimitReached,
        message: `At most ${limit} shared volumes per user on this backend`,
        details: { sharedBackendId, maxVolumesPerUser: limit, ownedVolumes: owned },
      });
    }
  }

  async assertSharedCapacityPhysical(
    transaction: Tx,
    ownerId: string,
    sharedBackendId: string,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    await this.pools.lockSharedBackends([sharedBackendId], transaction);
    const backend = await loadBackend(transaction, sharedBackendId);
    await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, ownerId, delta, transaction);
  }

  /**
   * Grant limits plus physical capacity for growing a volume (owner rules):
   * a local volume needs the server and the pool covered now, as on create
   * and attach, so a lapsed pool grant stops growth too.
   */
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
    const { pool: poolGrant } = await this.assertLocalCoverage(transaction, ownerId, serverId, poolId);
    const used = await this.ownerPoolCommittedBytes(ownerId, poolId, transaction);
    if (poolGrant.limitBytes !== null && used + delta > poolGrant.limitBytes) {
      throw new ConflictException({
        code: FailureCode.StorageGrantExceeded,
        message: 'Data disk grant exceeded',
        details: {
          poolId,
          requestedBytes: delta,
          availableBytes: Math.max(0, poolGrant.limitBytes - used),
          grantLimitBytes: poolGrant.limitBytes,
        },
      });
    }
    await this.assertLocalPoolPhysicalCapacity(pool, poolId, serverId, ownerId, delta, transaction);
  }

  /**
   * The owner's current server and pool coverage of a local volume, needed
   * for every grow, also one that stays within a pending shrink's
   * reservation and so commits no new bytes. Returns both grants.
   */
  async assertLocalCoverage(
    transaction: Tx,
    ownerId: string,
    serverId: string,
    poolId: string,
  ): Promise<{ server: ServerAccess; pool: PoolAccess }> {
    const server = await requireServerAccess(transaction, ownerId, serverId);
    const pool = await assertPoolGrant(transaction, ownerId, poolId);
    return { server, pool };
  }

  /** Physical capacity only (the owner's share included), for administrators who bypass per-user grant limits. */
  async assertCapacityPhysical(
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
      const backend = await loadBackend(transaction, sharedBackendId);
      await this.assertSharedBackendPhysicalCapacity(backend, sharedBackendId, ownerId, delta, transaction);
      return;
    }
    if (!serverId) throw new BadRequestException('Local capacity requires a server');
    const pool = await transaction.selectFrom('infra.storage_pools')
      .selectAll().where('id', '=', poolId).executeTakeFirstOrThrow();
    await this.assertLocalPoolPhysicalCapacity(pool, poolId, serverId, ownerId, delta, transaction);
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

  /** Each local pool of the server; with `ownerId`, also that owner's data-disk grant and usage on it. */
  private async poolCapacities(
    serverId: string,
    ownerId?: string,
  ): Promise<PoolCapacityDto[]> {
    const pools = (await this.pools.list(serverId)).filter(isLocalPoolRow);
    const overcommitRatio = await this.serverOvercommit(serverId);
    const grants = ownerId === undefined
      ? new Map<string, PoolAccess>()
      : new Map((await listPoolAccess(this.database, ownerId)).map((access) => [access.poolId, access]));
    const result: PoolCapacityDto[] = [];
    for (const pool of pools) {
      const committed = await this.committedPoolBytes(pool.id);
      const grant = grants.get(pool.id);
      const used = grant && ownerId !== undefined ? await this.ownerPoolCommittedBytes(ownerId, pool.id) : 0;
      const total = pool.total_bytes === null ? null : numberValue(pool.total_bytes);
      // The owner view also stops at the owner's physical share; the server-wide view shows the pool's.
      const ownerPhysical = ownerId === undefined ? null : await this.ownerPoolPhysicalBytes(ownerId, pool.id);
      result.push({
        poolId: pool.id,
        displayName: pool.display_name,
        driver: pool.driver as PoolCapacityDto['driver'],
        shareable: pool.shareable,
        totalBytes: pool.total_bytes === null ? null : numberValue(pool.total_bytes),
        committedBytes: committed,
        availableBytes: total === null
          ? null
          : overcommitAvailableBytes(total, overcommitRatio, committed, ownerPhysical),
        quotaEffective: pool.quota_effective,
        overcommitRatio,
        capability: storagePoolCapability(
          pool.resize_family as StoragePoolResizeFamily,
          pool.quota_effective,
          pool.block_filesystem,
        ),
        grant: grant
          ? {
              limitBytes: grant.limitBytes,
              usedBytes: used,
              availableBytes: grant.limitBytes === null ? null : Math.max(0, grant.limitBytes - used),
            }
          : null,
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
    const pools = await this.poolCapacities(serverId, ownerId);
    const sums = await this.ownerServerCommittedBytes(ownerId, serverId);
    const limit = grant.rootDiskBytes;
    return {
      rootDiskLimitBytes: limit,
      usedByRootDisksBytes: sums.root,
      rootDiskAvailableBytes: limit === null ? null : Math.max(0, limit - sums.root),
      usedByLocalVolumesBytes: sums.local,
      pools,
    };
  }

  /** `scope=all`: the server-wide view for user admins. */
  async serverWideCapacity(
    serverId: string,
  ): Promise<StorageCapacityDto> {
    const pools = await this.poolCapacities(serverId);
    const sums = await this.serverCommittedBytes(serverId);
    return {
      rootDiskLimitBytes: null,
      usedByRootDisksBytes: sums.root,
      rootDiskAvailableBytes: null,
      usedByLocalVolumesBytes: sums.local,
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
    await this.assertLocalCoverage(transaction, ownerId, scope.serverId, lockedPool.id);
    return {
      poolId: lockedPool.id,
      serverId: scope.serverId,
      sharedBackendId: null,
      anchorServerId: lockedPool.server_id,
    };
  }
}
