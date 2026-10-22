import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  GRANT_EXPIRY_GRACE_DAYS,
  Capability,
  type AdministrationActionsDto,
  type EffectiveServerAccessDto,
  type EffectiveSharedBackendAccessDto,
  type GroupSummaryDto,
} from '@nyabase/common';
import { numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import {
  assertActorHolds,
  assertActorMayAdminister,
  assertNotLastAdministrator,
  loadAdministrationActions,
  loadCapabilities,
} from './administration.js';
import {
  listServerAccess,
  listSharedBackendAccess,
  resolvePoolAccess,
  resolveServerAccess,
  resolveSharedBackendAccess,
  type ServerAccess,
} from './effective-access.js';

export type IamTransaction = Transaction<NyabaseDatabase>;

const GRACE_MS = GRANT_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000;

function transactionOf(value: unknown): IamTransaction {
  if (
    !value
    || typeof value !== 'object'
    || typeof (value as { selectFrom?: unknown }).selectFrom !== 'function'
  ) {
    throw new Error('Authorization work requires a PostgreSQL transaction');
  }
  return value as IamTransaction;
}

/**
 * Thin query layer over the effective-access views and the administration
 * rules. It holds no state: every call reads PostgreSQL, so a committed change
 * is visible to the next request on any replica.
 */
@Injectable()
export class AccessResolverService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
  ) {}

  userCapabilities(userId: string): Promise<Set<Capability>> {
    return loadCapabilities(this.database, userId, true);
  }

  assertActorCapabilitiesInTransaction(
    executor: unknown,
    actorId: string,
    required: Iterable<Capability>,
  ): Promise<Set<Capability>> {
    return assertActorHolds(transactionOf(executor), actorId, required);
  }

  assertActorMayAdministerUserInTransaction(
    executor: unknown,
    actorId: string,
    targetUserId: string,
  ): Promise<void> {
    return assertActorMayAdminister(transactionOf(executor), actorId, targetUserId);
  }

  assertNotFinalActiveAdministratorInTransaction(
    executor: unknown,
    userId: string,
  ): Promise<void> {
    return assertNotLastAdministrator(transactionOf(executor), userId);
  }

  administrationActions(actorId: string): Promise<AdministrationActionsDto> {
    return this.transactions.run((transaction) => loadAdministrationActions(transaction, actorId));
  }

  async runWithActorCapabilities<T>(
    actorId: string,
    required: Iterable<Capability>,
    work: (transaction: IamTransaction) => Promise<T>,
  ): Promise<T> {
    return this.transactions.run(async (transaction) => {
      await assertActorHolds(transaction, actorId, required);
      return work(transaction);
    });
  }

  /** Current server coverage of one user, or null when absent or expired. */
  resolveServer(userId: string, serverId: string): Promise<ServerAccess | null> {
    return resolveServerAccess(this.database, userId, serverId);
  }

  resolveServerInTransaction(
    executor: unknown,
    userId: string,
    serverId: string,
  ): Promise<ServerAccess | null> {
    return resolveServerAccess(transactionOf(executor), userId, serverId);
  }

  /** Server coverage plus whether the image is active on that server (R8). */
  async resolveContainerCreateAccessInTransaction(
    executor: unknown,
    userId: string,
    serverId: string,
    imageId: string,
  ): Promise<{ grant: ServerAccess; imageAvailable: boolean } | null> {
    const transaction = transactionOf(executor);
    const grant = await resolveServerAccess(transaction, userId, serverId);
    if (!grant) return null;
    const image = await transaction.selectFrom('infra.image_server_assignments as assignment')
      .innerJoin('infra.images as image', 'image.id', 'assignment.image_id')
      .select('assignment.id')
      .where('assignment.image_id', '=', imageId)
      .where('assignment.server_id', '=', serverId)
      .where('assignment.lifecycle_phase', '=', 'active')
      .where('assignment.needs_attention', '=', false)
      .where('image.is_active', '=', true)
      .where('image.deleting', '=', false)
      .executeTakeFirst();
    return { grant, imageAvailable: Boolean(image) };
  }

  /**
   * Starting a container mounts its volumes: the owner needs current coverage of
   * every storage pool or shared backend those volumes live on.
   */
  async assertAttachedStorageCoveredInTransaction(
    executor: unknown,
    ownerId: string,
    containerId: string,
  ): Promise<void> {
    const transaction = transactionOf(executor);
    const volumes = await transaction.selectFrom('control.volume_attachments as attachment')
      .innerJoin('control.volumes as volume', 'volume.id', 'attachment.volume_id')
      .select(['volume.pool_id', 'volume.shared_backend_id'])
      .where('attachment.container_id', '=', containerId)
      .execute();
    for (const volume of volumes) {
      const covered = volume.shared_backend_id
        ? await resolveSharedBackendAccess(transaction, ownerId, volume.shared_backend_id)
        : volume.pool_id
          ? await resolvePoolAccess(transaction, ownerId, volume.pool_id)
          : null;
      if (!covered) throw new ForbiddenException('Storage access was revoked');
    }
  }

  /** R8: an image is visible while it is active on a server the user currently covers. */
  async isImageAccessible(userId: string, imageId: string): Promise<boolean> {
    const row = await this.database.selectFrom('infra.image_server_assignments as assignment')
      .innerJoin('infra.images as image', 'image.id', 'assignment.image_id')
      .innerJoin('iam.effective_server_access as access', 'access.server_id', 'assignment.server_id')
      .select('assignment.id')
      .where('access.user_id', '=', userId)
      .where(sql<boolean>`(access.expires_at IS NULL OR access.expires_at > now())`)
      .where('assignment.image_id', '=', imageId)
      .where('assignment.lifecycle_phase', '=', 'active')
      .where('assignment.needs_attention', '=', false)
      .where('image.is_active', '=', true)
      .where('image.deleting', '=', false)
      .executeTakeFirst();
    return row !== undefined;
  }

  async listAccessibleServers(userId: string): Promise<string[]> {
    return (await listServerAccess(this.database, userId)).map((access) => access.serverId);
  }

  async getUserGroupSummaries(userId: string): Promise<GroupSummaryDto[]> {
    const rows = await this.database.selectFrom('iam.group_members as member')
      .innerJoin('iam.groups as group', 'group.id', 'member.group_id')
      .innerJoin('iam.users as user', 'user.id', 'member.user_id')
      .select(['group.id', 'group.name', 'group.is_system'])
      .where('member.user_id', '=', userId)
      .where('user.status', '=', 'active')
      .orderBy('group.name')
      .orderBy('group.id')
      .execute();
    return rows.map((row) => ({ id: row.id, name: row.name, isSystem: row.is_system }));
  }

  /**
   * Servers the user is covered on (`live`) plus servers on which coverage
   * lapsed and the 14-day grace has not ended (`grace`, read from the lapse
   * ledger; quotas are only known while an expired grant still exists).
   */
  async getEffectiveAccess(userId: string): Promise<EffectiveServerAccessDto[]> {
    const live = await listServerAccess(this.database, userId);
    const liveIds = new Set(live.map((access) => access.serverId));
    const lapses = (await this.database.selectFrom('control.access_lapses')
      .select(['resource_id', 'lapsed_at'])
      .where('user_id', '=', userId)
      .where('resource_kind', '=', 'server')
      .where('purged_at', 'is', null)
      .execute()).filter((lapse) => !liveIds.has(lapse.resource_id));
    const expired = lapses.length === 0
      ? []
      : await this.database.selectFrom('iam.effective_server_access')
        .select(['server_id', 'cpu_cores', 'mem_bytes', 'disk_bytes', 'gpu_pci_addresses'])
        .where('user_id', '=', userId)
        .where('server_id', 'in', lapses.map((lapse) => lapse.resource_id))
        .execute();
    const expiredByServer = new Map(expired.map((row) => [row.server_id, row]));

    const serverIds = [...liveIds, ...lapses.map((lapse) => lapse.resource_id)];
    const imageRows = serverIds.length === 0
      ? []
      : await this.database.selectFrom('infra.image_server_assignments as assignment')
        .innerJoin('infra.images as image', 'image.id', 'assignment.image_id')
        .select(['assignment.image_id', 'assignment.server_id'])
        .where('assignment.server_id', 'in', serverIds)
        .where('assignment.lifecycle_phase', '=', 'active')
        .where('assignment.needs_attention', '=', false)
        .where('image.is_active', '=', true)
        .where('image.deleting', '=', false)
        .execute();
    const imagesByServer = new Map<string, string[]>();
    for (const row of imageRows) {
      const list = imagesByServer.get(row.server_id) ?? [];
      list.push(row.image_id);
      imagesByServer.set(row.server_id, list);
    }

    return [
      ...live.map((access): EffectiveServerAccessDto => ({
        serverId: access.serverId,
        cpuCores: access.cpuCores,
        memBytes: access.memBytes,
        diskBytes: access.diskBytes,
        gpuPciAddresses: access.gpuPciAddresses,
        expiresAt: access.expiresAt?.toISOString() ?? null,
        purgeAt: null,
        accessPhase: 'live',
        allowedImageIds: imagesByServer.get(access.serverId) ?? [],
      })),
      ...lapses.map((lapse): EffectiveServerAccessDto => {
        const quotas = expiredByServer.get(lapse.resource_id);
        return {
          serverId: lapse.resource_id,
          cpuCores: quotas?.cpu_cores ?? null,
          memBytes: quotas?.mem_bytes === undefined || quotas.mem_bytes === null
            ? null
            : numberValue(quotas.mem_bytes),
          diskBytes: quotas?.disk_bytes === undefined || quotas.disk_bytes === null
            ? null
            : numberValue(quotas.disk_bytes),
          gpuPciAddresses: quotas?.gpu_pci_addresses ?? [],
          expiresAt: lapse.lapsed_at.toISOString(),
          purgeAt: new Date(lapse.lapsed_at.getTime() + GRACE_MS).toISOString(),
          accessPhase: 'grace',
          allowedImageIds: [],
        };
      }),
    ];
  }

  /** Current shared-backend coverage with booked usage; grace backends are omitted. */
  async getEffectiveSharedAccess(userId: string): Promise<EffectiveSharedBackendAccessDto[]> {
    const live = await listSharedBackendAccess(this.database, userId);
    if (live.length === 0) return [];
    const usedRows = await this.database.selectFrom('control.volumes')
      .select([
        'shared_backend_id',
        sql<string>`coalesce(sum(size_bytes), 0)`.as('used'),
      ])
      .where('owner_id', '=', userId)
      .where('shared_backend_id', 'in', live.map((access) => access.sharedBackendId))
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .groupBy('shared_backend_id')
      .execute();
    const usedByBackend = new Map(usedRows.flatMap((row) => (
      row.shared_backend_id ? [[row.shared_backend_id, numberValue(row.used)] as const] : []
    )));
    return live.map((access) => ({
      sharedBackendId: access.sharedBackendId,
      limitBytes: access.limitBytes,
      usedBytes: usedByBackend.get(access.sharedBackendId) ?? 0,
      expiresAt: access.expiresAt?.toISOString() ?? null,
    }));
  }
}

/**
 * In-process signal that IAM state which decides who is covered (membership,
 * grants, user status) changed. IAM writers fire it through `afterCommit`, so
 * a listener never looks before the commit; the access-lapse processor listens
 * and scans out of its regular schedule. A missed signal only costs latency:
 * the processor also runs periodically.
 */
@Injectable()
export class AccessChangeNotifier {
  private readonly listeners = new Set<() => void>();

  notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener failure must not fail the committed IAM write.
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
