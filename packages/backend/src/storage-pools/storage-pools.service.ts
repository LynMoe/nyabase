import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  FailureCode,
  type ListScope,
  type PatchStoragePoolRequest,
  type StoragePoolDiscoverResult,
  type StoragePoolDto,
  Role,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { listPoolAccess, listServerAccess } from '../iam/effective-access.js';
import { assertListScope, type Actor, requireUserId } from '../iam/actor.js';
import type { IncusClientPort } from '../incus/index.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { AuditService } from '../iam/audit.service.js';
import { isLocalPoolDto, isLocalPoolRow } from './storage-pool-capability.js';
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
   * pool of the server including unregistered ones (operator).
   */
  async listForServer(actor: Actor, serverId: string, scope: ListScope): Promise<StoragePoolDto[]> {
    assertListScope(actor, scope, Role.Operator);
    return scope === 'all'
      ? this.list(serverId, true)
      : this.listVisible(requireUserId(actor), serverId);
  }

  async list(serverId?: string, includeUnregistered = false): Promise<StoragePoolDto[]> {
    const rows = await this.repository.list(serverId, includeUnregistered);
    return rows.map((row) => toAdminPoolDto(row)).filter(isLocalPoolDto);
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
    return toAdminPoolDto(row);
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
        if (input.registered === false && current.registered) {
          if (await this.repository.hasDependencies(id, transaction)) {
            throw new ConflictException({
              code: FailureCode.StoragePoolInUse,
              message: 'Storage pool registration or backend mapping cannot change while referenced',
            });
          }
        }
        const updated = await this.repository.patch(id, input.expectedRevision, {
          shareable: false,
          ...(input.registered === undefined ? {} : { registered: input.registered }),
          ...(input.displayName === undefined
            ? {}
            : { display_name: input.displayName?.trim() ? input.displayName.trim() : null }),
        }, transaction);
        if (!updated) throw new ConflictException({ code: FailureCode.RevisionConflict });
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
          },
        );
        return updated;
      },
      { isolationLevel: 'serializable', maxAttempts: 5 },
    );
    return toAdminPoolDto(result);
  }
}
