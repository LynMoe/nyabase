import {
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  Capability,
  SystemGroupKey,
  UserStatus,
  type AdministrationActionsDto,
  type EffectiveServerAccessDto,
  type EffectiveSharedBackendAccessDto,
  type GroupSummaryDto,
} from '@nyabase/common';
import { asJsonObject } from '../server-card-extensions/json.js';
import { numberValue } from '../domain/domain-utils.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { projectAdministrationActions } from './administration-availability.js';
import {
  classifyGrantExpiry,
  grantPurgeAt,
  selectLiveGrantCandidate,
  selectWinningGrantCandidate,
  type GrantExpiryCandidate,
  type GrantWinnerCandidate,
} from './grant-expiry.js';

export type IamTransaction = Transaction<NyabaseDatabase>;
export type AccessExecutor = Kysely<NyabaseDatabase> | IamTransaction;

export interface ResolvedServerGrant {
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  extensionGrants: Record<string, unknown>;
  expiresAt: Date | null;
  purgeAt: Date | null;
  accessPhase: 'live' | 'grace';
}

export interface IamGroup {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  isSystem: boolean;
  systemKey: SystemGroupKey | null;
  capabilities: Capability[];
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

interface GrantCandidate extends GrantExpiryCandidate {
  user_id: string | null;
  group_id: string | null;
  server_id: string;
}

const CACHE_TTL_MS = 30_000;
const CACHE_FILL_MAX_RETRIES = 3;

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

function integer(value: string | number | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('Authorization grant exceeds the safe integer range');
  }
  return result;
}

@Injectable()
export class AccessResolverService {
  private readonly cache = new Map<string, {
    epoch: number;
    fetchedAt: number;
    capabilities: Set<Capability>;
    groups: IamGroup[];
    servers: Map<string, ResolvedServerGrant>;
    imageAssignments: Map<string, Set<string>>;
  }>();

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly cacheEpoch: AccessCacheEpochService,
  ) {}

  invalidateUser(userId: string): void {
    this.cacheEpoch.bump();
    this.cache.delete(userId);
  }

  invalidateAll(): void {
    this.cacheEpoch.bump();
    this.cache.clear();
  }

  async authorizationCommitted(userIds?: Iterable<string>): Promise<void> {
    await this.cacheEpoch.refreshAndPublish();
    if (userIds) {
      for (const id of userIds) this.cache.delete(id);
    } else {
      this.cache.clear();
    }
  }

  async userCapabilities(userId: string): Promise<Set<Capability>> {
    return (await this.userCache(userId)).capabilities;
  }

  async userCapabilitiesCurrent(userId: string): Promise<Set<Capability>> {
    return this.transactions.run((transaction) =>
      this.userCapabilitiesInTransaction(transaction, userId, true));
  }

  async userCapabilitiesInTransaction(
    executor: unknown,
    userId: string,
    requireActive = true,
  ): Promise<Set<Capability>> {
    const transaction = transactionOf(executor);
    const user = await transaction.selectFrom('iam.users')
      .select(['id', 'status'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || (requireActive && user.status !== UserStatus.Active)) return new Set();
    const groups = await transaction.selectFrom('iam.group_members as member')
      .innerJoin('iam.groups as group', 'group.id', 'member.group_id')
      .select('group.capabilities')
      .where('member.user_id', '=', userId)
      .execute();
    return new Set(groups.flatMap((group) => group.capabilities as Capability[]));
  }

  async assertActorCapabilitiesInTransaction(
    executor: unknown,
    actorId: string,
    required: Iterable<Capability>,
  ): Promise<Set<Capability>> {
    await this.lockPolicyStateInTransaction(executor);
    const capabilities = await this.userCapabilitiesInTransaction(executor, actorId, true);
    const missing = [...new Set(required)].filter((capability) => !capabilities.has(capability));
    if (missing.length > 0) {
      throw new ForbiddenException({
        code: 'PRIVILEGE_ESCALATION_DENIED',
        message: 'The actor does not hold the required capabilities',
        missingCapabilities: missing,
      });
    }
    return capabilities;
  }

  /**
   * Serialize a mutating authorization decision with membership and grant
   * changes. The database trigger also takes this lock at write time; taking
   * it before reading the actor closes the stale-capability race.
   */
  async lockPolicyStateInTransaction(executor: unknown): Promise<void> {
    const transaction = transactionOf(executor);
    await transaction.selectFrom('iam.policy_state')
      .select('policy_epoch')
      .where('singleton', '=', true)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  async assertActorMayAdministerUserInTransaction(
    executor: unknown,
    actorId: string,
    targetUserId: string,
  ): Promise<void> {
    const transaction = transactionOf(executor);
    await this.lockPolicyStateInTransaction(transaction);
    await this.assertActorCapabilitiesInTransaction(
      transaction,
      actorId,
      [Capability.ManageUsers],
    );
    const targetCapabilities = await this.userCapabilitiesInTransaction(
      transaction,
      targetUserId,
      false,
    );
    await this.assertActorCapabilitiesInTransaction(transaction, actorId, targetCapabilities);
    const memberships = await transaction.selectFrom('iam.group_members')
      .select('group_id')
      .where('user_id', '=', targetUserId)
      .execute();
    const groupIds = memberships.map((row) => row.group_id);
    const resources = await Promise.all([
      this.hasGrant(transaction, 'iam.server_grants', targetUserId, groupIds),
      this.hasGrant(transaction, 'iam.storage_pool_grants', targetUserId, groupIds),
      this.hasGrant(transaction, 'iam.shared_backend_grants', targetUserId, groupIds),
    ]);
    if (resources.some(Boolean)) {
      await this.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageGrants],
      );
    }
  }

  async assertNotFinalActiveAdministratorInTransaction(
    executor: unknown,
    userId: string,
  ): Promise<void> {
    const transaction = transactionOf(executor);
    await transaction.selectFrom('iam.policy_state')
      .select('policy_epoch')
      .where('singleton', '=', true)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const administrators = await transaction.selectFrom('iam.groups')
      .select('id')
      .where('system_key', '=', SystemGroupKey.Administrators)
      .where('is_system', '=', true)
      .executeTakeFirst();
    if (!administrators) return;
    const alternative = await transaction.selectFrom('iam.group_members as member')
      .innerJoin('iam.users as user', 'user.id', 'member.user_id')
      .select('user.id')
      .where('member.group_id', '=', administrators.id)
      .where('member.user_id', '!=', userId)
      .where('user.status', '=', UserStatus.Active)
      .executeTakeFirst();
    if (!alternative) {
      throw new ForbiddenException({
        code: 'LAST_ACTIVE_ADMINISTRATOR',
        message: 'The final active administrator cannot be removed',
      });
    }
  }

  async resolveServer(userId: string, serverId: string): Promise<ResolvedServerGrant | null> {
    return (await this.userCache(userId)).servers.get(serverId) ?? null;
  }

  async resolveServerInTransaction(
    executor: unknown,
    userId: string,
    serverId: string,
  ): Promise<ResolvedServerGrant | null> {
    const transaction = transactionOf(executor);
    const candidates = await this.grantCandidates(transaction, userId, serverId);
    return this.winner(candidates);
  }

  async resolveServerPairsInTransaction(
    executor: unknown,
    pairs: readonly { userId: string; serverId: string }[],
  ): Promise<Map<string, ResolvedServerGrant>> {
    const result = new Map<string, ResolvedServerGrant>();
    const unique = [...new Map(pairs.map((pair) => [
      `${pair.userId}\0${pair.serverId}`,
      pair,
    ])).values()];
    for (const pair of unique) {
      const grant = await this.resolveServerInTransaction(
        executor,
        pair.userId,
        pair.serverId,
      );
      if (grant) result.set(`${pair.userId}\0${pair.serverId}`, grant);
    }
    return result;
  }

  async resolveAllowedImages(userId: string, serverId: string): Promise<Set<string>> {
    const cache = await this.userCache(userId);
    if (!cache.servers.has(serverId)) return new Set();
    return cache.imageAssignments.get(serverId) ?? new Set();
  }

  async isImageAccessibleForUser(userId: string, imageId: string): Promise<boolean> {
    const cache = await this.userCache(userId);
    for (const [serverId, imageIds] of cache.imageAssignments) {
      if (cache.servers.has(serverId) && imageIds.has(imageId)) return true;
    }
    return false;
  }

  async listAccessibleServers(userId: string): Promise<string[]> {
    return [...(await this.userCache(userId)).servers.keys()];
  }

  async getUsersWithServerAccess(serverId: string): Promise<string[]> {
    const rows = await this.database.selectFrom('iam.server_grants as grant')
      .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
      .select(['grant.user_id', 'member.user_id as member_user_id'])
      .where('grant.server_id', '=', serverId)
      .execute();
    const users = [...new Set(rows.flatMap((row) => [
      ...(row.user_id ? [row.user_id] : []),
      ...(row.member_user_id ? [row.member_user_id] : []),
    ]))];
    if (users.length === 0) return [];
    const grants = await this.database.selectFrom('iam.server_grants as grant')
      .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
      .select(['grant.user_id', 'member.user_id as member_user_id', 'grant.expires_at'])
      .where('grant.server_id', '=', serverId)
      .execute();
    const accessible = new Set<string>();
    for (const grant of grants) {
      if (classifyGrantExpiry(grant.expires_at) === 'lost') continue;
      if (grant.user_id) accessible.add(grant.user_id);
      if (grant.member_user_id) accessible.add(grant.member_user_id);
    }
    return users.filter((userId) => accessible.has(userId));
  }

  async resolveContainerCreateAccessInTransaction(
    executor: unknown,
    userId: string,
    serverId: string,
    imageId: string,
  ): Promise<{ grant: ResolvedServerGrant; imageAvailable: boolean } | null> {
    const transaction = transactionOf(executor);
    if (!await this.isActiveUser(transaction, userId)) return null;
    const grant = await this.resolveServerInTransaction(transaction, userId, serverId);
    if (!grant || grant.accessPhase !== 'live') return null;
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

  async getUserGroupSummaries(userId: string): Promise<GroupSummaryDto[]> {
    return (await this.userCache(userId)).groups.map((group) => ({
      id: group.id,
      name: group.name,
      priority: group.priority,
      isSystem: group.isSystem,
    }));
  }

  async getEffectiveAccess(userId: string): Promise<EffectiveServerAccessDto[]> {
    const cache = await this.userCache(userId);
    return [...cache.servers].map(([serverId, grant]) => ({
      serverId,
      cpuMillis: grant.cpuMillis,
      memBytes: grant.memBytes,
      diskBytes: grant.diskBytes,
      extensionGrants: grant.extensionGrants,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      purgeAt: grant.purgeAt?.toISOString() ?? null,
      accessPhase: grant.accessPhase,
      allowedImageIds: [...(cache.imageAssignments.get(serverId) ?? [])],
    }));
  }

  async getEffectiveSharedAccess(userId: string): Promise<EffectiveSharedBackendAccessDto[]> {
    const user = await this.database.selectFrom('iam.users')
      .select('status')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || user.status !== UserStatus.Active) return [];

    const rows = await this.database.selectFrom('iam.shared_backend_grants as grant')
      .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
      .leftJoin('iam.groups as group', 'group.id', 'grant.group_id')
      .select([
        'grant.shared_backend_id',
        'grant.limit_bytes',
        'grant.expires_at',
        'grant.user_id',
        'grant.id',
        'group.priority',
      ])
      .where((expression) => expression.or([
        expression('grant.user_id', '=', userId),
        expression('member.user_id', '=', userId),
      ]))
      .execute();

    const byBackend = new Map<string, Array<GrantWinnerCandidate & {
      sharedBackendId: string;
      limit_bytes: string | number | bigint;
    }>>();
    for (const row of rows) {
      const candidate = {
        sharedBackendId: row.shared_backend_id,
        limit_bytes: row.limit_bytes,
        expiresAt: row.expires_at,
        scopeRank: row.user_id ? 0 : 1,
        priority: row.priority ?? 0,
        tieBreaker: row.id,
      };
      const list = byBackend.get(row.shared_backend_id) ?? [];
      list.push(candidate);
      byBackend.set(row.shared_backend_id, list);
    }

    const winners: EffectiveSharedBackendAccessDto[] = [];
    for (const [sharedBackendId, candidates] of byBackend) {
      const winner = selectLiveGrantCandidate(candidates);
      if (!winner) continue;
      const limit = numberValue(winner.limit_bytes);
      winners.push({
        sharedBackendId,
        limitBytes: limit === 0 ? null : limit,
        usedBytes: 0,
        expiresAt: winner.expiresAt ? new Date(winner.expiresAt).toISOString() : null,
      });
    }
    if (winners.length === 0) return [];

    const usedRows = await this.database.selectFrom('control.volumes')
      .select([
        'shared_backend_id',
        sql<string>`coalesce(sum(size_bytes), 0)`.as('used'),
      ])
      .where('owner_id', '=', userId)
      .where('shared_backend_id', 'in', winners.map((row) => row.sharedBackendId))
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .groupBy('shared_backend_id')
      .execute();
    const usedByBackend = new Map(usedRows.flatMap((row) => (
      row.shared_backend_id
        ? [[row.shared_backend_id, numberValue(row.used)] as const]
        : []
    )));
    return winners.map((row) => ({
      ...row,
      usedBytes: usedByBackend.get(row.sharedBackendId) ?? 0,
    }));
  }

  async administrationActionsCurrent(actorId: string): Promise<AdministrationActionsDto> {
    return this.transactions.run(async (transaction) => {
      await this.lockPolicyStateInTransaction(transaction);
      const [
        actorCapabilities,
        users,
        groupRows,
        memberships,
        serverGrants,
        storagePoolGrants,
        sharedBackendGrants,
      ] = await Promise.all([
        this.userCapabilitiesInTransaction(transaction, actorId, true),
        transaction.selectFrom('iam.users')
          .select(['id', 'status'])
          .where('status', '!=', UserStatus.Deleted)
          .execute(),
        transaction.selectFrom('iam.groups').selectAll().execute(),
        transaction.selectFrom('iam.group_members')
          .select(['group_id', 'user_id'])
          .execute(),
        transaction.selectFrom('iam.server_grants')
          .select(['user_id', 'group_id'])
          .execute(),
        transaction.selectFrom('iam.storage_pool_grants')
          .select(['user_id', 'group_id'])
          .execute(),
        transaction.selectFrom('iam.shared_backend_grants')
          .select(['user_id', 'group_id'])
          .execute(),
      ]);
      const groups = groupRows.map((row) => this.toGroup(row));
      const allGrants = [
        ...serverGrants,
        ...storagePoolGrants,
        ...sharedBackendGrants,
      ];
      const grantedUsers = new Set(allGrants.flatMap((grant) =>
        grant.user_id ? [grant.user_id] : []));
      const grantedGroups = new Set(allGrants.flatMap((grant) =>
        grant.group_id ? [grant.group_id] : []));
      const groupIdsByUser = new Map<string, string[]>();
      for (const membership of memberships) {
        const ids = groupIdsByUser.get(membership.user_id) ?? [];
        ids.push(membership.group_id);
        groupIdsByUser.set(membership.user_id, ids);
      }
      return projectAdministrationActions({
        actorId,
        actorCapabilities,
        users: users.map((user) => ({
          id: user.id,
          status: user.status as UserStatus,
          groupIds: groupIdsByUser.get(user.id) ?? [],
          hasDirectResourceGrants: grantedUsers.has(user.id),
        })),
        groups: groups.map((group) => ({
          id: group.id,
          isSystem: group.isSystem,
          systemKey: group.systemKey,
          capabilities: group.capabilities,
          hasResourceGrants: grantedGroups.has(group.id),
        })),
      });
    });
  }

  async runWithActorCapabilities<T>(
    actorId: string,
    required: Iterable<Capability>,
    work: (transaction: IamTransaction) => Promise<T>,
  ): Promise<T> {
    return this.transactions.run(async (transaction) => {
      await this.assertActorCapabilitiesInTransaction(transaction, actorId, required);
      return work(transaction);
    });
  }

  async startExternalWithActorCapabilities<T>(
    actorId: string,
    required: Iterable<Capability>,
    start: () => Promise<T>,
  ): Promise<{ completion: Promise<T> }> {
    await this.transactions.run((transaction) =>
      this.assertActorCapabilitiesInTransaction(transaction, actorId, required));
    return { completion: start() };
  }

  async runWithActiveServerAccess<T>(
    userId: string,
    serverId: string,
    work: (transaction: IamTransaction) => Promise<T>,
  ): Promise<T> {
    return this.transactions.run(async (transaction) => {
      if (!await this.isActiveUser(transaction, userId)
        || !await this.resolveServerInTransaction(transaction, userId, serverId)) {
        throw new ForbiddenException('Server access was revoked');
      }
      return work(transaction);
    });
  }

  async startExternalWithActiveServerAccess<T>(
    userId: string,
    serverId: string,
    start: () => Promise<T>,
  ): Promise<{ completion: Promise<T> }> {
    await this.transactions.run(async (transaction) => {
      if (!await this.isActiveUser(transaction, userId)
        || !await this.resolveServerInTransaction(transaction, userId, serverId)) {
        throw new ForbiddenException('Server access was revoked');
      }
    });
    return { completion: start() };
  }

  async hasCapability(userId: string, capability: Capability): Promise<boolean> {
    return (await this.userCapabilities(userId)).has(capability);
  }

  private async userCache(userId: string, retryCount = 0): Promise<{
    epoch: number;
    fetchedAt: number;
    capabilities: Set<Capability>;
    groups: IamGroup[];
    servers: Map<string, ResolvedServerGrant>;
    imageAssignments: Map<string, Set<string>>;
  }> {
    const epoch = await this.cacheEpoch.refresh();
    const cached = this.cache.get(userId);
    if (cached && cached.epoch === epoch && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached;
    }
    const resolved = await this.transactions.run(async (transaction) => {
      const user = await transaction.selectFrom('iam.users')
        .select('status')
        .where('id', '=', userId)
        .executeTakeFirst();
      if (!user || user.status !== UserStatus.Active) {
        return {
          capabilities: new Set<Capability>(),
          groups: [],
          servers: new Map<string, ResolvedServerGrant>(),
          imageAssignments: new Map<string, Set<string>>(),
        };
      }
      const groups = (await transaction.selectFrom('iam.group_members as member')
        .innerJoin('iam.groups as group', 'group.id', 'member.group_id')
        .selectAll('group')
        .where('member.user_id', '=', userId)
        .execute()).map((row) => this.toGroup(row));
      const serverRows = await transaction.selectFrom('iam.server_grants as grant')
        .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
        .leftJoin('iam.groups as group', 'group.id', 'grant.group_id')
        .select([
          'grant.user_id',
          'grant.group_id',
          'grant.server_id',
          'grant.cpu_millis',
          'grant.mem_bytes',
          'grant.disk_bytes',
          'grant.extension_grants',
          'grant.expires_at',
          'grant.id',
          'group.priority',
          'member.user_id as member_user_id',
        ])
        .where((expression) => expression.or([
          expression('grant.user_id', '=', userId),
          expression('member.user_id', '=', userId),
        ]))
        .execute();
      const byServer = new Map<string, GrantCandidate[]>();
      for (const row of serverRows) {
        const candidate: GrantCandidate = {
          user_id: row.user_id,
          group_id: row.group_id,
          server_id: row.server_id,
          cpu_millis: row.cpu_millis,
          mem_bytes: row.mem_bytes,
          disk_bytes: row.disk_bytes,
          extension_grants: row.extension_grants,
          expiresAt: row.expires_at,
          scopeRank: row.user_id ? 0 : 1,
          priority: row.priority ?? 0,
          tieBreaker: row.id,
        };
        const list = byServer.get(row.server_id) ?? [];
        list.push(candidate);
        byServer.set(row.server_id, list);
      }
      const servers = new Map<string, ResolvedServerGrant>();
      for (const [serverId, candidates] of byServer) {
        const grant = this.winner(candidates);
        if (grant) servers.set(serverId, grant);
      }
      const assignments = await transaction.selectFrom('infra.image_server_assignments as assignment')
        .innerJoin('infra.images as image', 'image.id', 'assignment.image_id')
        .select(['assignment.image_id', 'assignment.server_id'])
        .where('lifecycle_phase', '=', 'active')
        .where('needs_attention', '=', false)
        .where('image.is_active', '=', true)
        .where('image.deleting', '=', false)
        .execute();
      const imageAssignments = new Map<string, Set<string>>();
      for (const assignment of assignments) {
        const set = imageAssignments.get(assignment.server_id) ?? new Set<string>();
        set.add(assignment.image_id);
        imageAssignments.set(assignment.server_id, set);
      }
      return {
        capabilities: new Set(groups.flatMap((group) => group.capabilities)),
        groups,
        servers,
        imageAssignments,
      };
    });
    const currentEpoch = await this.cacheEpoch.refresh();
    if (currentEpoch !== epoch) {
      if (retryCount >= CACHE_FILL_MAX_RETRIES) {
        throw new Error('Authorization changed repeatedly while resolving access');
      }
      return this.userCache(userId, retryCount + 1);
    }
    const result = { ...resolved, epoch: currentEpoch, fetchedAt: Date.now() };
    this.cache.set(userId, result);
    return result;
  }

  private async grantCandidates(
    transaction: IamTransaction,
    userId: string,
    serverId: string,
  ): Promise<GrantCandidate[]> {
    const rows = await transaction.selectFrom('iam.server_grants as grant')
      .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
      .leftJoin('iam.groups as group', 'group.id', 'grant.group_id')
      .select([
        'grant.user_id',
        'grant.group_id',
        'grant.server_id',
        'grant.cpu_millis',
        'grant.mem_bytes',
        'grant.disk_bytes',
        'grant.extension_grants',
        'grant.expires_at',
        'grant.id',
        'group.priority',
        'member.user_id as member_user_id',
      ])
      .where('grant.server_id', '=', serverId)
      .where((expression) => expression.or([
        expression('grant.user_id', '=', userId),
        expression('member.user_id', '=', userId),
      ]))
      .execute();
    return rows.map((row) => ({
      user_id: row.user_id,
      group_id: row.group_id,
      server_id: row.server_id,
      cpu_millis: row.cpu_millis,
      mem_bytes: row.mem_bytes,
      disk_bytes: row.disk_bytes,
      extension_grants: row.extension_grants,
      expiresAt: row.expires_at,
      scopeRank: row.user_id ? 0 : 1,
      priority: row.priority ?? 0,
      tieBreaker: row.id,
    }));
  }

  private winner(
    candidates: readonly GrantCandidate[],
    now: Date = new Date(),
  ): ResolvedServerGrant | null {
    const winning = selectWinningGrantCandidate(candidates, now);
    if (!winning) return null;
    const selected = winning.candidate;
    return {
      cpuMillis: selected.cpu_millis,
      memBytes: integer(selected.mem_bytes),
      diskBytes: integer(selected.disk_bytes),
      extensionGrants: asJsonObject(selected.extension_grants),
      expiresAt: selected.expiresAt ? new Date(selected.expiresAt) : null,
      purgeAt: grantPurgeAt(selected.expiresAt),
      accessPhase: winning.phase,
    };
  }

  private async isActiveUser(transaction: IamTransaction, userId: string): Promise<boolean> {
    return Boolean(await transaction.selectFrom('iam.users')
      .select('id')
      .where('id', '=', userId)
      .where('status', '=', UserStatus.Active)
      .executeTakeFirst());
  }

  private async hasGrant(
    transaction: IamTransaction,
    table: 'iam.server_grants' | 'iam.storage_pool_grants' | 'iam.shared_backend_grants',
    userId: string,
    groupIds: readonly string[],
  ): Promise<boolean> {
    const direct = await transaction.selectFrom(table)
      .select('id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (direct) return true;
    if (groupIds.length === 0) return false;
    return Boolean(await transaction.selectFrom(table)
      .select('id')
      .where('group_id', 'in', groupIds)
      .executeTakeFirst());
  }

  private toGroup(row: {
    id: string;
    name: string;
    description: string | null;
    priority: number;
    is_system: boolean;
    system_key: string | null;
    capabilities: string[];
    revision: string | number;
    created_at: Date;
    updated_at: Date;
  }): IamGroup {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      priority: row.priority,
      isSystem: row.is_system,
      systemKey: row.system_key as SystemGroupKey | null,
      capabilities: row.capabilities as Capability[],
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

}
