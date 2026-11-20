import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  FailureCode,
  type ListScope,
  type PatchStoragePoolRequest,
  type StoragePoolDiscoverResult,
  type StoragePoolDto,
  Role,
  RootPlacement,
} from '@nyabase/common';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { InfrastructureStoragePoolTable } from '../platform/persistence-pg/infrastructure-database.types.js';
import { listPoolAccess, listServerAccess } from '../iam/effective-access.js';
import { assertListScope, hasRole, type Actor, requireUserId } from '../iam/actor.js';
import type { IncusClientPort } from '../incus/index.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { AuditService } from '../iam/audit.service.js';
import { isLocalPoolDto, isLocalPoolRow } from './storage-pool-capability.js';
import { afterCommit } from '../platform/post-commit.js';
import { assertMountPathFree, assertPoolMountable, DiskChangeNotifier } from './disk-mounts.js';
import { StoragePoolDiscoveryService } from './storage-pool-discovery.service.js';
import { optionalByteCount } from './storage-pool-discovery.service.js';
import { toAdminPoolDto, toUserPoolDto } from './storage-pool-dtos.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';

/** Local (per-server) storage pools: listing, discovery, registration and observed usage. */
@Injectable()
export class StoragePoolsService {
  constructor(
    private readonly repository: StoragePoolsRepository,
    private readonly transactions: PgTransactionManager,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly discovery: StoragePoolDiscoveryService,
    private readonly audit: AuditService,
    private readonly diskChanges: DiskChangeNotifier,
  ) {}

  /** Records observed used/total bytes for every registered pool of one server. */
  async refreshObservedUsage(
    serverId: string,
    client: IncusClientPort,
    signal: AbortSignal,
  ): Promise<void> {
    const pools = await this.repository.list(serverId);
    for (const pool of pools) {
      if (signal.aborted) return;
      const poolResources = await client.getStoragePoolResources(pool.incus_name, { signal });
      await this.repository.recordObservedSpace(pool.id, {
        usedBytes: optionalByteCount(poolResources.metadata.space?.used),
        totalBytes: optionalByteCount(poolResources.metadata.space?.total),
      });
    }
  }

  /**
   * `scope=mine`: pools the caller may use, as user DTOs. `scope=all`: every
   * pool of the server; admins see unregistered ones and the admin DTO, user
   * admins the registered ones as user DTOs (enough to grant them).
   */
  async listForServer(actor: Actor, serverId: string, scope: ListScope): Promise<StoragePoolDto[]> {
    assertListScope(actor, scope, Role.UserAdmin);
    if (scope === 'mine') return this.listVisible(requireUserId(actor), serverId);
    if (hasRole(actor, Role.Admin)) return this.list(serverId, true);
    const rows = await this.repository.list(serverId);
    return rows.map((row) => toUserPoolDto(row)).filter(isLocalPoolDto);
  }

  async list(serverId?: string, includeUnregistered = false): Promise<StoragePoolDto[]> {
    const rows = await this.repository.list(serverId, includeUnregistered);
    const rootDisks = await this.repository.rootDiskSummary(rows.map((row) => row.id));
    return rows.map((row) => toAdminPoolDto(row, rootDisks)).filter(isLocalPoolDto);
  }

  /** Pools the user may use: granted servers' pools, or individually granted pools. */
  async listVisible(userId: string, serverId?: string): Promise<StoragePoolDto[]> {
    const rows = await this.repository.list(serverId);
    const [servers, pools] = await Promise.all([
      listServerAccess(this.database, userId),
      listPoolAccess(this.database, userId),
    ]);
    const serverIds = new Set(servers.map((access) => access.serverId));
    const poolIds = new Set(pools.map((access) => access.poolId));
    return rows
      .filter((row) => serverIds.has(row.server_id) && poolIds.has(row.id))
      .map((row) => toUserPoolDto(row))
      .filter(isLocalPoolDto);
  }

  async get(id: string, includeUnregistered = false): Promise<StoragePoolDto> {
    const row = await this.repository.findById(id);
    if (!row || (!includeUnregistered && !row.registered) || !isLocalPoolRow(row)) {
      throw new NotFoundException('Storage pool not found');
    }
    return toAdminPoolDto(row, await this.repository.rootDiskSummary([row.id]));
  }

  async getVisible(
    id: string,
    userId: string,
    serverId?: string,
  ): Promise<StoragePoolDto> {
    const row = await this.repository.findById(id);
    if (
      !row
      || !row.registered
      || !isLocalPoolRow(row)
      || (serverId !== undefined && row.server_id !== serverId)
    ) {
      throw new NotFoundException('Storage pool not found');
    }
    const visible = (await this.listVisible(userId, row.server_id))
      .some((pool) => pool.id === id);
    if (!visible) throw new NotFoundException('Storage pool not found');
    return toUserPoolDto(row);
  }

  async discover(actorId: string, serverId: string): Promise<StoragePoolDiscoverResult> {
    const result = await this.discovery.discover(serverId);
    await this.audit.log(actorId, AuditAction.DiscoverStoragePools, serverId, 'server', {
      pools: result.pools.length,
      identityConflicts: result.identityConflicts.length,
    });
    return result;
  }

  async patch(
    actorId: string,
    id: string,
    input: PatchStoragePoolRequest,
    serverId?: string,
  ): Promise<StoragePoolDto> {
    const result = await this.transactions.run(
      async (transaction) => {
        const observed = await this.repository.findById(id, transaction);
        if (
          !observed
          || !isLocalPoolRow(observed)
          || (serverId !== undefined && observed.server_id !== serverId)
        ) {
          throw new NotFoundException('Storage pool not found');
        }
        await this.repository.lockCapacityScope(id, observed.server_id, [], transaction);
        const current = await this.repository.findByIdForUpdate(id, transaction);
        if (!current || !isLocalPoolRow(current)) {
          throw new NotFoundException('Storage pool not found');
        }
        if (Number(current.revision) !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        const system = await this.systemDiskChange(transaction, current, input);
        if (input.registered === false && current.registered) {
          // The pool's own system role counts as it stands after this PATCH.
          if (system.next || await this.repository.hasDependencies(id, transaction, { ignoreSystemRole: true })) {
            throw new ConflictException({
              code: FailureCode.StoragePoolInUse,
              message: 'Storage pool registration or backend mapping cannot change while referenced',
            });
          }
        }
        const registered = input.registered ?? current.registered;
        // An unregistered pool is no data disk any more.
        const mountPath = registered ? input.mountPath : null;
        if (mountPath) {
          assertPoolMountable({ ...current, registered });
          await assertMountPathFree(transaction, mountPath, { kind: 'pool', id, serverId: current.server_id });
        }
        const mountChanged = mountPath !== undefined && mountPath !== current.mount_path;
        const maintenanceChanged = input.maintenance !== undefined && input.maintenance !== current.maintenance;
        const updated = await this.repository.patch(id, input.expectedRevision, {
          shareable: false,
          ...(input.registered === undefined ? {} : { registered: input.registered }),
          ...(input.displayName === undefined
            ? {}
            : { display_name: input.displayName?.trim() ? input.displayName.trim() : null }),
          ...(mountChanged ? { mount_path: mountPath } : {}),
          ...(maintenanceChanged ? { maintenance: input.maintenance } : {}),
          ...system.values,
        }, transaction);
        if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
        const replaced = system.next && system.single
          ? await this.repository.dropOtherSystemPools(current.server_id, id, transaction)
          : [];
        for (const replacedId of replaced) {
          await this.audit.append(transaction, actorId, AuditAction.UpdateStoragePool, replacedId, 'storage_pool', {
            serverId: current.server_id,
            systemDisk: null,
            systemDiskMovedTo: id,
          });
        }
        await this.audit.append(
          transaction,
          actorId,
          input.registered === true && !current.registered
            ? AuditAction.RegisterStoragePool
            : AuditAction.UpdateStoragePool,
          id,
          'storage_pool',
          {
            serverId: current.server_id,
            ...(input.registered === undefined ? {} : { registered: input.registered }),
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(mountChanged ? { mountPath, previousMountPath: current.mount_path } : {}),
            ...(maintenanceChanged ? { maintenance: input.maintenance } : {}),
            ...(system.change === undefined ? {} : {
              systemDisk: system.change,
              previousSystemDisk: current.system_disk
                ? { weight: current.system_weight, maxUsedPercent: current.system_max_used_percent }
                : null,
              ...(replaced.length > 0 ? { replacedSystemPoolIds: replaced } : {}),
            }),
          },
        );
        if (mountChanged || maintenanceChanged) {
          afterCommit(transaction, () => this.diskChanges.notify({
            disk: { kind: 'pool', id, serverId: current.server_id },
            maintenanceChanged,
          }));
        }
        return updated;
      },
      { isolationLevel: 'serializable', maxAttempts: 5 },
    );
    return toAdminPoolDto(result, await this.repository.rootDiskSummary([result.id]));
  }

  /**
   * The system disk role a PATCH asks for (AGENTS.md, 存储池用途与系统盘分配):
   * only a registered, root-capable local pool can take it; turning it off
   * resets its parameters. Under single placement, turning it on moves the role
   * here from the server's other pool (the caller holds the server row lock).
   */
  private async systemDiskChange(
    transaction: Transaction<NyabaseDatabase>,
    current: Selectable<InfrastructureStoragePoolTable>,
    input: PatchStoragePoolRequest,
  ): Promise<{
    change: PatchStoragePoolRequest['systemDisk'];
    next: boolean;
    single: boolean;
    values: { system_disk?: boolean; system_weight?: number; system_max_used_percent?: number | null };
  }> {
    const change = input.systemDisk;
    if (change === undefined) return { change, next: current.system_disk, single: false, values: {} };
    if (change === null) {
      return {
        change,
        next: false,
        single: false,
        values: { system_disk: false, system_weight: 1, system_max_used_percent: null },
      };
    }
    const registered = input.registered ?? current.registered;
    if (!registered || !current.root_disk_capable || current.shareable || current.shared_backend_id !== null) {
      throw new ConflictException({
        code: FailureCode.SystemDiskUnsupported,
        message: 'Only a registered, root-capable local pool can be a system disk',
        details: { poolId: current.id },
      });
    }
    const server = await transaction.selectFrom('infra.servers')
      .select('root_placement')
      .where('id', '=', current.server_id)
      .executeTakeFirstOrThrow();
    return {
      change,
      next: true,
      single: server.root_placement === RootPlacement.Single,
      values: { system_disk: true, system_weight: change.weight, system_max_used_percent: change.maxUsedPercent },
    };
  }
}
