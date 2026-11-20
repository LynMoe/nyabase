import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  FailureCode,
  IntentKind,
  IntentResourceType,
  IntentStatus,
  Role,
  type IntentAcceptedDto,
  StoragePoolResizeFamily,
  systemDiskRoom,
  type DataDiskUsageDto,
  type ListScope,
  type SharedVolumeDto,
  type StorageCapacityDto,
  type VolumeDto,
} from '@nyabase/common';
import { sql, type Kysely } from 'kysely';
import { assertListScope, type Actor, requireUserId } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { listPoolAccess, resolvePoolAccess, resolveSharedBackendAccess } from '../iam/effective-access.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { acceptedIntent } from '../reconcile/accepted-intent.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { numberValue } from '../platform/domain-utils.js';
import { committedRootBytesSql } from '../platform/persistence-pg/committed-bytes.js';
import { loadServerDiskCharge } from '../platform/persistence-pg/disk-charge.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { isLocalPoolRow, storagePoolCapability } from '../storage-pools/storage-pool-capability.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { VolumeDtoAssembler } from './volume-dtos.js';
import { assertCanAccess, overcommitAvailableBytes, VOLUME_TX, type VolumeKind } from './volume-rules.js';
import {
  createVolumeIntent,
  listEligibleDestroyExecutors,
  requireServerAccess,
  type VolumeExecutor,
  VolumesRepository,
} from './volumes.repository.js';

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

type PoolCapacityDto = StorageCapacityDto['pools'][number];

/**
 * What users and administrators read about volumes: local and shared volumes
 * (list, get) and storage capacity (`scope=mine` with the caller's data-disk
 * grants, `scope=all` server-wide). Users do not create, size, mount or
 * delete volumes: the volume provisioner keeps one per covered, enabled disk,
 * mounted in all of the owner's containers, and the storage balancer sizes it.
 */
@Injectable()
export class VolumesService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly repository: VolumesRepository,
    private readonly pools: StoragePoolsRepository,
    private readonly dtos: VolumeDtoAssembler,
    private readonly transactions: PgTransactionManager,
    private readonly intents: IntentRepository,
    private readonly audit: AuditService,
  ) {}

  async list(
    actor: Actor,
    filters: { scope?: ListScope; serverId?: string } = {},
  ): Promise<VolumeDto[]> {
    const scope = filters.scope ?? 'mine';
    assertListScope(actor, scope, Role.UserAdmin);
    const rows = await this.repository.listByKind(
      'local',
      scope === 'mine' ? { ownerId: requireUserId(actor) } : { serverId: filters.serverId },
    );
    return this.dtos.toVolumeDtos(rows);
  }

  async get(actor: Actor, id: string, scope: ListScope = 'mine'): Promise<VolumeDto> {
    const { row } = assertCanAccess(actor, await this.repository.findById(id), 'local', scope);
    const [dto] = await this.dtos.toVolumeDtos([row]);
    return dto!;
  }

  async listShared(actor: Actor, filters: { scope?: ListScope } = {}): Promise<SharedVolumeDto[]> {
    const scope = filters.scope ?? 'mine';
    assertListScope(actor, scope, Role.UserAdmin);
    const rows = await this.repository.listByKind(
      'shared',
      scope === 'mine' ? { ownerId: requireUserId(actor) } : {},
    );
    return this.dtos.toSharedVolumeDtos(rows);
  }

  async getShared(actor: Actor, id: string, scope: ListScope = 'mine'): Promise<SharedVolumeDto> {
    const { row } = assertCanAccess(actor, await this.repository.findById(id), 'shared', scope);
    const [dto] = await this.dtos.toSharedVolumeDtos([row]);
    return dto!;
  }

  /**
   * Deletes a volume no grant covers any more (user admins): how a user's
   * storage goes before the lapse purge, e.g. to delete the account. A covered
   * volume would only be created again, and one still mounted cannot go
   * (revoking the grant unmounts it at once): both are refused.
   */
  async delete(actor: Actor, id: string, kind: VolumeKind): Promise<IntentAcceptedDto> {
    const actorId = requireUserId(actor);
    const intent = await this.transactions.run(async (transaction) => {
      const { row } = assertCanAccess(actor, await this.repository.findByIdForUpdate(id, transaction), kind, 'all');
      if (row.lifecycle_phase === 'deleting') {
        throw new ConflictException({ code: FailureCode.InvalidInput, message: 'Volume deletion is already in progress' });
      }
      const covered = row.shared_backend_id !== null
        ? await resolveSharedBackendAccess(transaction, row.owner_id, row.shared_backend_id)
        : await resolvePoolAccess(transaction, row.owner_id, row.pool_id!);
      if (covered) {
        throw new ConflictException({
          code: FailureCode.VolumeStillGranted,
          message: 'A grant still covers this disk: revoke it first',
        });
      }
      if (await this.repository.hasAttachments(id, transaction)) {
        throw new ConflictException({ code: FailureCode.VolumeRequiresUnbind, message: 'The volume is still mounted' });
      }
      const held = (await this.repository.listPlacements(id, transaction)).length > 0 || row.dir_ensured;
      if (held && row.shared_backend_id !== null
        && (await listEligibleDestroyExecutors(transaction, row.shared_backend_id)).length === 0) {
        throw new ConflictException({
          code: FailureCode.VolumeDeleteBackendUnreachable,
          message: 'No online server reaches the shared backend',
        });
      }
      await this.audit.append(transaction, actorId, AuditAction.DeleteVolume, id, 'volume', { ownerId: row.owner_id });
      if (held) {
        const deleting = await this.repository.updateDesired(id, row.revision, { lifecycle_phase: 'deleting' }, transaction);
        if (!deleting) throw new ConflictException({ code: FailureCode.RevisionConflict });
        return createVolumeIntent(this.intents, {
          kind: IntentKind.VolumeDestroy,
          resourceType: IntentResourceType.Volume,
          resourceId: id,
          requestedBy: actorId,
          targetRevision: deleting.revision,
          request: { operation: 'destroy', idempotencyKey: 'destroy' },
        }, transaction);
      }
      // Incus never held it: settle what was queued for it and drop the row.
      const pending = await transaction.selectFrom('control.intents').select('id')
        .where('resource_type', '=', IntentResourceType.Volume).where('resource_id', '=', id)
        .where('status', '=', IntentStatus.Pending).execute();
      for (const { id: intentId } of pending) await this.intents.settleOne(intentId, { outcome: 'succeeded' }, transaction);
      await this.repository.deleteVolumeRow(id, transaction);
      const settled = await createVolumeIntent(this.intents, {
        kind: IntentKind.VolumeDestroy,
        resourceType: IntentResourceType.Volume,
        resourceId: id,
        requestedBy: actorId,
        targetRevision: row.revision,
        request: { operation: 'destroy', idempotencyKey: 'destroy', note: 'never_held' },
      }, transaction);
      await this.intents.settleOne(settled.id, { outcome: 'succeeded' }, transaction);
      return settled;
    }, VOLUME_TX);
    return acceptedIntent(intent);
  }

  /**
   * `scope=mine`: the caller's own storage on a server they hold a grant for.
   * `scope=all`: the server-wide view for user admins.
   */
  async capacity(
    actor: Actor,
    serverId: string,
    scope: ListScope = 'mine',
  ): Promise<StorageCapacityDto> {
    assertListScope(actor, scope, Role.UserAdmin);
    return scope === 'all'
      ? this.serverWideCapacity(serverId)
      : this.ownerCapacity(requireUserId(actor), serverId);
  }

  private async committedPoolBytes(
    poolId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<number> {
    const [volumes, roots] = await Promise.all([
      this.repository.sumLiveSizeBytes({ kind: 'local', poolId }, executor),
      committedRootBytes(executor, { poolId }),
    ]);
    return volumes + roots;
  }

  private async ownerServerCommittedBytes(
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
  private async ownerPoolCommittedBytes(
    ownerId: string,
    poolId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<number> {
    return this.repository.sumLiveSizeBytes({ kind: 'local', ownerId, poolId }, executor);
  }

  private async serverCommittedBytes(
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<{ root: number; local: number }> {
    const [root, local] = await Promise.all([
      committedRootBytes(executor, { serverId }),
      this.repository.sumLiveSizeBytes({ kind: 'local', serverId }, executor),
    ]);
    return { root, local };
  }

  private async serverOvercommit(
    serverId: string,
    executor: VolumeExecutor = this.database,
  ): Promise<number> {
    const server = await executor.selectFrom('infra.servers')
      .select('storage_overcommit_ratio')
      .where('id', '=', serverId)
      .executeTakeFirst();
    return server ? numberValue(server.storage_overcommit_ratio) : 1;
  }

  /** Everything the owner commits on a pool: root disks and local volumes (unlike the data-disk quota, which counts volumes only). */
  private async ownerPoolPhysicalBytes(
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

  /** Each local pool of the server; with `owner`, also the owner's data disk on it (ceiling and data). */
  private async poolCapacities(
    serverId: string,
    owner?: { id: string; dataDisks: Map<string, DataDiskUsageDto> },
  ): Promise<PoolCapacityDto[]> {
    const ownerId = owner?.id;
    const pools = (await this.pools.list(serverId)).filter(isLocalPoolRow);
    const overcommitRatio = await this.serverOvercommit(serverId);
    const result: PoolCapacityDto[] = [];
    for (const pool of pools) {
      const committed = await this.committedPoolBytes(pool.id);
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
        mountPath: pool.mount_path,
        maintenance: pool.maintenance,
        dataDisk: owner?.dataDisks.get(pool.id) ?? null,
      });
    }
    return result;
  }

  /** `scope=mine`: the caller's own storage on a server they hold a grant for. */
  private async ownerCapacity(
    ownerId: string,
    serverId: string,
  ): Promise<StorageCapacityDto> {
    const grant = await requireServerAccess(this.database, ownerId, serverId);
    const [charge, access] = await Promise.all([
      loadServerDiskCharge(this.database, ownerId, serverId),
      listPoolAccess(this.database, ownerId),
    ]);
    const dataDisks = new Map(access
      .filter((row) => row.serverId === serverId)
      .map((row) => [row.poolId, {
        poolId: row.poolId,
        capBytes: row.capBytes,
        usedBytes: charge.dataByPool.get(row.poolId) ?? 0,
      }]));
    const pools = await this.poolCapacities(serverId, { id: ownerId, dataDisks });
    const sums = await this.ownerServerCommittedBytes(ownerId, serverId);
    return {
      diskLimitBytes: grant.diskBytes,
      rootDiskLimitBytes: grant.rootDiskBytes,
      usedByRootDisksBytes: sums.root,
      dataDiskUsedBytes: charge.dataUsedBytes,
      rootDiskAvailableBytes: systemDiskRoom({
        diskBytes: grant.diskBytes,
        rootDiskBytes: grant.rootDiskBytes,
        rootCommittedBytes: charge.rootCommittedBytes,
        dataUsedBytes: charge.dataUsedBytes,
      }),
      usedByLocalVolumesBytes: sums.local,
      pools,
    };
  }

  /** `scope=all`: the server-wide view for user admins. */
  private async serverWideCapacity(
    serverId: string,
  ): Promise<StorageCapacityDto> {
    const pools = await this.poolCapacities(serverId);
    const sums = await this.serverCommittedBytes(serverId);
    return {
      diskLimitBytes: null,
      rootDiskLimitBytes: null,
      usedByRootDisksBytes: sums.root,
      dataDiskUsedBytes: 0,
      rootDiskAvailableBytes: null,
      usedByLocalVolumesBytes: sums.local,
      pools,
    };
  }
}
