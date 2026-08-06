import {
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  Capability,
  type EffectiveServerAccessDto,
  GpuGrantMode,
  type GroupSummaryDto,
  type MountSourceKind,
  type ServerAccessPhase,
  UserStatus,
  SystemGroupKey,
  type AdministrationActionsDto,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { exactLocalDisk } from '../mount-sources/utils.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { projectAdministrationActions } from './administration-availability.js';
import {
  grantPurgeAt,
  selectWinningGrantCandidate,
  type GrantExpiryCandidate,
} from './grant-expiry.js';
import { resolveGrant, type ResolvedGrantLimits } from './grant-utils.js';

export type IamTransaction = Transaction<NyabaseDatabase>;

export interface ResolvedServerGrant {
  cpuMillis: number;
  memBytes: number;
  diskBytes: number;
  gpuMode: GpuGrantMode;
  gpuIndices: number[];
  /** Winning grant expiry; null means never expires. */
  expiresAt: Date | null;
  /** expiresAt + grace window; null when the grant never expires. */
  purgeAt: Date | null;
  accessPhase: ServerAccessPhase;
}

export interface MountSourceRef {
  kind: MountSourceKind;
  id: string;
}

export interface StartedExternalWork<T> {
  completion: Promise<T>;
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

interface ServerGrantRow {
  id: string;
  user_id: string | null;
  group_id: string | null;
  server_id: string;
  cpu_millis: number | null;
  mem_bytes: string | null;
  disk_bytes: string | null;
  gpu_mode: string | null;
  gpu_indices: number[] | null;
  expires_at: Date | null;
}

interface CachedMountSourceRef extends MountSourceRef {
  sourceIdentity: string | null;
}

interface UserCache {
  capabilities: Set<Capability>;
  groups: IamGroup[];
  serverGrants: Map<string, ResolvedServerGrant>;
  imageGrants: Map<string, Set<string>>;
  mountSourceGrants: Map<string, Map<string, CachedMountSourceRef>>;
  epoch: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 512;
const CACHE_FILL_MAX_RETRIES = 2;

function requireIamTransaction(value: unknown): IamTransaction {
  if (
    !value
    || typeof value !== 'object'
    || typeof (value as { selectFrom?: unknown }).selectFrom !== 'function'
    || typeof (value as { updateTable?: unknown }).updateTable !== 'function'
  ) {
    throw new Error('Authorization work requires the caller PostgreSQL/Kysely transaction');
  }
  return value as IamTransaction;
}

@Injectable()
export class AccessResolverService {
  private readonly cache = new Map<string, UserCache>();

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly agentGateway: AgentGateway,
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
      for (const userId of userIds) this.cache.delete(userId);
    } else {
      this.cache.clear();
    }
  }

  async userCapabilities(userId: string): Promise<Set<Capability>> {
    return (await this.getUserCache(userId)).capabilities;
  }

  async userCapabilitiesCurrent(userId: string): Promise<Set<Capability>> {
    return this.transactions.run(
      (transaction) => this.userCapabilitiesInTransaction(transaction, userId, true),
    );
  }

  async administrationActionsCurrent(actorId: string): Promise<AdministrationActionsDto> {
    return this.transactions.run(async (transaction) => {
      const [actorCapabilities, users, groupRows, memberships, serverGrants, imageGrants, mountGrants] =
        await Promise.all([
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
          transaction.selectFrom('iam.image_grants')
            .select(['user_id', 'group_id'])
            .execute(),
          transaction.selectFrom('iam.mount_source_grants')
            .select(['user_id', 'group_id'])
            .execute(),
        ]);
      const groups = groupRows.map((row) => this.toGroup(row));
      const allGrants = [...serverGrants, ...imageGrants, ...mountGrants];
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
    work: (manager: any) => Promise<T>,
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
  ): Promise<StartedExternalWork<T>> {
    return this.transactions.run(async (transaction) => {
      await this.assertActorCapabilitiesInTransaction(transaction, actorId, required);
      return { completion: start() };
    });
  }

  async runWithActiveServerAccess<T>(
    userId: string,
    serverId: string,
    work: (manager: any) => Promise<T>,
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
  ): Promise<StartedExternalWork<T>> {
    return this.transactions.run(async (transaction) => {
      if (!await this.isActiveUser(transaction, userId)
        || !await this.resolveServerInTransaction(transaction, userId, serverId)) {
        throw new ForbiddenException('Server access was revoked');
      }
      return { completion: start() };
    });
  }

  async hasCapability(userId: string, capability: Capability): Promise<boolean> {
    return (await this.userCapabilities(userId)).has(capability);
  }

  async userCapabilitiesInTransaction(
    executor: unknown,
    userId: string,
    requireActive = true,
  ): Promise<Set<Capability>> {
    const transaction = requireIamTransaction(executor);
    const user = await transaction.selectFrom('iam.users')
      .select(['id', 'status'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || (requireActive && user.status !== UserStatus.Active)) return new Set();
    const groups = await transaction.selectFrom('iam.group_members as membership')
      .innerJoin('iam.groups as group', 'group.id', 'membership.group_id')
      .select('group.capabilities')
      .where('membership.user_id', '=', userId)
      .forKeyShare()
      .execute();
    return new Set(groups.flatMap((group) => group.capabilities as Capability[]));
  }

  async assertActorCapabilitiesInTransaction(
    executor: unknown,
    actorId: string,
    required: Iterable<Capability>,
  ): Promise<Set<Capability>> {
    const capabilities = await this.userCapabilitiesInTransaction(executor, actorId, true);
    const missing = [...new Set(required)].filter((item) => !capabilities.has(item));
    if (missing.length > 0) {
      throw new ForbiddenException({
        code: 'PRIVILEGE_ESCALATION_DENIED',
        message: 'The actor cannot grant or administer capabilities they do not hold',
        missingCapabilities: missing,
      });
    }
    return capabilities;
  }

  async assertActorMayAdministerUserInTransaction(
    executor: unknown,
    actorId: string,
    targetUserId: string,
  ): Promise<void> {
    const transaction = requireIamTransaction(executor);
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
    const groups = await transaction.selectFrom('iam.group_members')
      .select('group_id')
      .where('user_id', '=', targetUserId)
      .execute();
    const groupIds = groups.map((group) => group.group_id);
    const counts = await Promise.all([
      this.resourceGrantCount(transaction, 'iam.server_grants', targetUserId, groupIds),
      this.resourceGrantCount(transaction, 'iam.image_grants', targetUserId, groupIds),
      this.resourceGrantCount(transaction, 'iam.mount_source_grants', targetUserId, groupIds),
    ]);
    if (counts.some((count) => count > 0)) {
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
    const transaction = requireIamTransaction(executor);
    // All last-admin checks and corresponding mutations in Users/Groups take
    // this same row lock, preventing cross-process write skew at READ COMMITTED.
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
    const membership = await transaction.selectFrom('iam.group_members')
      .select('id')
      .where('group_id', '=', administrators.id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!membership) return;
    const alternative = await transaction.selectFrom('iam.group_members as membership')
      .innerJoin('iam.users as user', 'user.id', 'membership.user_id')
      .select('user.id')
      .where('membership.group_id', '=', administrators.id)
      .where('membership.user_id', '!=', userId)
      .where('user.status', '=', UserStatus.Active)
      .executeTakeFirst();
    if (!alternative) {
      throw new ForbiddenException({
        code: 'LAST_ACTIVE_ADMINISTRATOR',
        message: 'The final active administrator cannot be disabled, deleted, or removed',
      });
    }
  }

  async getUserGroupSummaries(userId: string): Promise<GroupSummaryDto[]> {
    return (await this.getUserCache(userId)).groups.map((group) => ({
      id: group.id,
      name: group.name,
      priority: group.priority,
      isSystem: group.isSystem,
    }));
  }

  async resolveServer(userId: string, serverId: string): Promise<ResolvedServerGrant | null> {
    return (await this.getUserCache(userId)).serverGrants.get(serverId) ?? null;
  }

  async resolveServerInTransaction(
    executor: unknown,
    userId: string,
    serverId: string,
  ): Promise<ResolvedServerGrant | null> {
    const transaction = requireIamTransaction(executor);
    const direct = await transaction.selectFrom('iam.server_grants')
      .selectAll()
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .forKeyShare()
      .executeTakeFirst();
    const inherited = await transaction.selectFrom('iam.group_members as membership')
      .innerJoin('iam.groups as group', 'group.id', 'membership.group_id')
      .innerJoin('iam.server_grants as grant', 'grant.group_id', 'group.id')
      .select([
        'grant.id',
        'grant.user_id',
        'grant.group_id',
        'grant.server_id',
        'grant.cpu_millis',
        'grant.mem_bytes',
        'grant.disk_bytes',
        'grant.gpu_mode',
        'grant.gpu_indices',
        'grant.expires_at',
        'group.priority',
        'group.id as group_tie',
      ])
      .where('membership.user_id', '=', userId)
      .where('grant.server_id', '=', serverId)
      .forKeyShare()
      .execute();
    const candidates: Array<GrantExpiryCandidate & ServerGrantRow> = [];
    if (direct) {
      candidates.push({
        ...(direct as ServerGrantRow),
        scopeRank: 0,
        priority: 0,
        tieBreaker: (direct as ServerGrantRow).id,
        expiresAt: (direct as ServerGrantRow).expires_at,
      });
    }
    for (const row of inherited) {
      candidates.push({
        id: row.id,
        user_id: row.user_id,
        group_id: row.group_id,
        server_id: row.server_id,
        cpu_millis: row.cpu_millis,
        mem_bytes: row.mem_bytes,
        disk_bytes: row.disk_bytes,
        gpu_mode: row.gpu_mode,
        gpu_indices: row.gpu_indices,
        expires_at: row.expires_at,
        scopeRank: 1,
        priority: row.priority,
        tieBreaker: row.group_tie,
        expiresAt: row.expires_at,
      });
    }
    const winner = selectWinningGrantCandidate(candidates);
    return winner ? this.resolveServerGrant(winner.candidate, winner.phase) : null;
  }

  async resolveServerPairsInTransaction(
    executor: unknown,
    pairs: readonly { userId: string; serverId: string }[],
  ): Promise<Map<string, ResolvedServerGrant>> {
    const transaction = requireIamTransaction(executor);
    const unique = [...new Map(pairs.map((pair) => [
      `${pair.userId}\0${pair.serverId}`,
      pair,
    ])).values()];
    if (unique.length === 0) return new Map();
    const result = await sql<{
      user_id: string;
      server_id: string;
      cpu_millis: number | null;
      mem_bytes: string | null;
      disk_bytes: string | null;
      gpu_mode: string | null;
      gpu_indices: number[] | null;
      expires_at: Date | null;
      scope_rank: number;
      priority: number;
      tie_breaker: string;
    }>`
      WITH affected AS (
        SELECT
          (entry.value ->> 'userId')::uuid AS user_id,
          entry.value ->> 'serverId' AS server_id
        FROM jsonb_array_elements(${JSON.stringify(unique)}::jsonb) AS entry(value)
      )
      SELECT
        affected.user_id::text AS user_id,
        affected.server_id,
        candidate.cpu_millis,
        candidate.mem_bytes,
        candidate.disk_bytes,
        candidate.gpu_mode,
        candidate.gpu_indices,
        candidate.expires_at,
        candidate.scope_rank,
        candidate.priority,
        candidate.tie_breaker::text AS tie_breaker
      FROM affected
      INNER JOIN LATERAL (
        SELECT
          direct_grant.cpu_millis,
          direct_grant.mem_bytes,
          direct_grant.disk_bytes,
          direct_grant.gpu_mode,
          direct_grant.gpu_indices,
          direct_grant.expires_at,
          0 AS scope_rank,
          0 AS priority,
          direct_grant.id AS tie_breaker
        FROM iam.server_grants AS direct_grant
        WHERE direct_grant.user_id = affected.user_id
          AND direct_grant.server_id = affected.server_id
        UNION ALL
        SELECT
          inherited_grant.cpu_millis,
          inherited_grant.mem_bytes,
          inherited_grant.disk_bytes,
          inherited_grant.gpu_mode,
          inherited_grant.gpu_indices,
          inherited_grant.expires_at,
          1 AS scope_rank,
          inherited_group.priority,
          inherited_group.id AS tie_breaker
        FROM iam.group_members AS membership
        INNER JOIN iam.groups AS inherited_group
          ON inherited_group.id = membership.group_id
        INNER JOIN iam.server_grants AS inherited_grant
          ON inherited_grant.group_id = membership.group_id
        WHERE membership.user_id = affected.user_id
          AND inherited_grant.server_id = affected.server_id
      ) AS candidate ON TRUE
    `.execute(transaction);
    const byPair = new Map<string, Array<GrantExpiryCandidate & {
      cpu_millis: number | null;
      mem_bytes: string | null;
      disk_bytes: string | null;
      gpu_mode: string | null;
      gpu_indices: number[] | null;
      expires_at: Date | null;
    }>>();
    for (const row of result.rows) {
      const key = `${row.user_id}\0${row.server_id}`;
      const list = byPair.get(key) ?? [];
      list.push({
        cpu_millis: row.cpu_millis,
        mem_bytes: row.mem_bytes,
        disk_bytes: row.disk_bytes,
        gpu_mode: row.gpu_mode,
        gpu_indices: row.gpu_indices,
        expires_at: row.expires_at,
        scopeRank: row.scope_rank,
        priority: row.priority,
        tieBreaker: row.tie_breaker,
        expiresAt: row.expires_at,
      });
      byPair.set(key, list);
    }
    const resolved = new Map<string, ResolvedServerGrant>();
    for (const [key, candidates] of byPair) {
      const winner = selectWinningGrantCandidate(candidates);
      if (winner) {
        resolved.set(key, this.resolveServerGrant(winner.candidate, winner.phase));
      }
    }
    return resolved;
  }

  async listAccessibleServers(userId: string): Promise<string[]> {
    return [...(await this.getUserCache(userId)).serverGrants.keys()];
  }

  async getUsersWithServerAccess(serverId: string): Promise<string[]> {
    const [direct, inherited] = await Promise.all([
      this.database.selectFrom('iam.server_grants')
        .select('user_id')
        .where('server_id', '=', serverId)
        .where('user_id', 'is not', null)
        .execute(),
      this.database.selectFrom('iam.server_grants as grant')
        .innerJoin('iam.group_members as membership', 'membership.group_id', 'grant.group_id')
        .select('membership.user_id')
        .where('grant.server_id', '=', serverId)
        .where('grant.group_id', 'is not', null)
        .execute(),
    ]);
    return [...new Set([
      ...direct.flatMap((row) => row.user_id ? [row.user_id] : []),
      ...inherited.map((row) => row.user_id),
    ])];
  }

  async resolveAllowedImages(userId: string, serverId: string): Promise<Set<string>> {
    return (await this.getUserCache(userId)).imageGrants.get(serverId) ?? new Set();
  }

  async resolveMountSources(userId: string, serverId: string): Promise<Set<MountSourceRef>> {
    const cached = (await this.getUserCache(userId)).mountSourceGrants.get(serverId);
    const result = new Set<MountSourceRef>();
    for (const source of cached?.values() ?? []) {
      if (source.kind !== 'local') continue;
      const snapshot = this.agentGateway.stateCache.get(serverId);
      const disk = snapshot && snapshot.helloAt !== null
        ? exactLocalDisk(snapshot.disks, source.id)
        : null;
      if (disk?.sourceIdentity !== source.sourceIdentity) continue;
      result.add({ kind: source.kind, id: source.id });
    }
    const remoteIds = await this.transactions.run(async (transaction) => {
      if (!await this.isActiveUser(transaction, userId)
        || !await this.resolveServerInTransaction(transaction, userId, serverId)) return [];
      const assignments = await transaction
        .selectFrom('infra.remote_fs_server_assignments')
        .select('remote_fs_mount_id')
        .where('server_id', '=', serverId)
        .where('desired_state', '=', 'active')
        .execute();
      const assigned = assignments.map((row) => row.remote_fs_mount_id);
      if (assigned.length === 0) return [];
      const groups = await transaction.selectFrom('iam.group_members')
        .select('group_id')
        .where('user_id', '=', userId)
        .execute();
      const groupIds = groups.map((group) => group.group_id);
      const direct = await transaction.selectFrom('iam.mount_source_grants')
        .select('source_id')
        .where('user_id', '=', userId)
        .where('source_kind', '=', 'remote')
        .where('source_id', 'in', assigned)
        .execute();
      const inherited = groupIds.length === 0
        ? []
        : await transaction.selectFrom('iam.mount_source_grants')
          .select('source_id')
          .where('group_id', 'in', groupIds)
          .where('source_kind', '=', 'remote')
          .where('source_id', 'in', assigned)
          .execute();
      return [...new Set([...direct, ...inherited].map((row) => row.source_id))];
    });
    for (const id of remoteIds) result.add({ kind: 'remote', id });
    return result;
  }

  async hasMountSourceAccess(
    userId: string,
    serverId: string,
    kind: MountSourceKind,
    sourceId: string,
  ): Promise<boolean> {
    for (const source of await this.resolveMountSources(userId, serverId)) {
      if (source.kind === kind && source.id === sourceId) return true;
    }
    return false;
  }

  async hasMountSourceAccessInTransaction(
    executor: unknown,
    userId: string,
    serverId: string,
    source: MountSourceRef,
    expectedSourceIdentity?: string,
  ): Promise<boolean> {
    const transaction = requireIamTransaction(executor);
    if (!await this.isActiveUser(transaction, userId)) return false;
    if (!await this.resolveServerInTransaction(transaction, userId, serverId)) return false;
    if (source.kind === 'remote') {
      const assignment = await transaction
        .selectFrom('infra.remote_fs_server_assignments')
        .select('id')
        .where('remote_fs_mount_id', '=', source.id)
        .where('server_id', '=', serverId)
        .where('desired_state', '=', 'active')
        .forKeyShare()
        .executeTakeFirst();
      if (!assignment) return false;
      const direct = await transaction.selectFrom('iam.mount_source_grants')
        .select('id')
        .where('user_id', '=', userId)
        .where('source_kind', '=', 'remote')
        .where('source_id', '=', source.id)
        .forKeyShare()
        .executeTakeFirst();
      if (direct) return true;
      const groups = await transaction.selectFrom('iam.group_members')
        .select('group_id')
        .where('user_id', '=', userId)
        .forKeyShare()
        .execute();
      const groupIds = groups.map((group) => group.group_id);
      if (groupIds.length === 0) return false;
      return Boolean(await transaction.selectFrom('iam.mount_source_grants')
        .select('id')
        .where('group_id', 'in', groupIds)
        .where('source_kind', '=', 'remote')
        .where('source_id', '=', source.id)
        .forKeyShare()
        .executeTakeFirst());
    }
    const snapshot = this.agentGateway.stateCache.get(serverId);
    const disk = snapshot && snapshot.helloAt !== null
      ? exactLocalDisk(snapshot.disks, source.id)
      : null;
    if (!disk || (expectedSourceIdentity !== undefined
      && disk.sourceIdentity !== expectedSourceIdentity)) return false;
    const groups = await transaction.selectFrom('iam.group_members')
      .select('group_id')
      .where('user_id', '=', userId)
      .forKeyShare()
      .execute();
    const groupIds = groups.map((group) => group.group_id);
    const direct = await transaction.selectFrom('iam.mount_source_grants')
      .select('id')
      .where('user_id', '=', userId)
      .where('source_kind', '=', 'local')
      .where('source_id', '=', source.id)
      .where('server_id', '=', serverId)
      .where('source_identity', '=', disk.sourceIdentity)
      .forKeyShare()
      .executeTakeFirst();
    if (direct) return true;
    if (groupIds.length === 0) return false;
    return Boolean(await transaction.selectFrom('iam.mount_source_grants')
      .select('id')
      .where('group_id', 'in', groupIds)
      .where('source_kind', '=', 'local')
      .where('source_id', '=', source.id)
      .where('server_id', '=', serverId)
      .where('source_identity', '=', disk.sourceIdentity)
      .forKeyShare()
      .executeTakeFirst());
  }

  async isImageAccessibleForUser(userId: string, imageId: string): Promise<boolean> {
    const cache = await this.getUserCache(userId);
    for (const [serverId, images] of cache.imageGrants) {
      if (cache.serverGrants.has(serverId) && images.has(imageId)) return true;
    }
    return false;
  }

  async resolveContainerCreateAccessInTransaction(
    executor: unknown,
    userId: string,
    serverId: string,
    imageId: string,
    mountSources: readonly (MountSourceRef & { sourceIdentity?: string })[],
  ): Promise<{ grant: ResolvedServerGrant; mountSourcesAllowed: boolean } | null> {
    const transaction = requireIamTransaction(executor);
    if (!await this.isActiveUser(transaction, userId)) return null;
    const grant = await this.resolveServerInTransaction(transaction, userId, serverId);
    if (!grant || grant.accessPhase !== 'full') return null;
    const groups = await transaction.selectFrom('iam.group_members')
      .select('group_id')
      .where('user_id', '=', userId)
      .execute();
    const groupIds = groups.map((group) => group.group_id);
    const directImage = await transaction.selectFrom('iam.image_grants')
      .select('id')
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .where('image_id', '=', imageId)
      .executeTakeFirst();
    const inheritedImage = directImage || groupIds.length === 0
      ? null
      : await transaction.selectFrom('iam.image_grants')
        .select('id')
        .where('group_id', 'in', groupIds)
        .where('server_id', '=', serverId)
        .where('image_id', '=', imageId)
        .executeTakeFirst();
    if (!directImage && !inheritedImage) return null;
    for (const source of mountSources) {
      if (!await this.hasMountSourceAccessInTransaction(
        transaction,
        userId,
        serverId,
        source,
        source.kind === 'local' ? source.sourceIdentity : undefined,
      )) return { grant, mountSourcesAllowed: false };
    }
    return { grant, mountSourcesAllowed: true };
  }

  async getEffectiveAccess(userId: string): Promise<EffectiveServerAccessDto[]> {
    const cache = await this.getUserCache(userId);
    return [...cache.serverGrants].map(([serverId, grant]) => ({
      serverId,
      cpuMillis: grant.cpuMillis,
      memBytes: grant.memBytes,
      diskBytes: grant.diskBytes,
      gpuMode: grant.gpuMode,
      gpuIndices: grant.gpuIndices,
      expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      purgeAt: grant.purgeAt ? grant.purgeAt.toISOString() : null,
      accessPhase: grant.accessPhase,
      allowedImageIds: [...(cache.imageGrants.get(serverId) ?? [])],
    }));
  }

  private async getUserCache(userId: string, retryCount = 0): Promise<UserCache> {
    const epoch = await this.cacheEpoch.refresh();
    const cached = this.cache.get(userId);
    if (cached && cached.epoch === epoch && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      this.cache.delete(userId);
      this.cache.set(userId, cached);
      return cached;
    }
    const cache = await this.transactions.run(async (transaction) => {
      if (!await this.isActiveUser(transaction, userId)) {
        return this.emptyUserCache(epoch);
      }
      const groupRows = await transaction.selectFrom('iam.group_members as membership')
        .innerJoin('iam.groups as group', 'group.id', 'membership.group_id')
        .selectAll('group')
        .where('membership.user_id', '=', userId)
        .orderBy('group.priority', 'desc')
        .orderBy('group.id', 'desc')
        .execute();
      const groups = groupRows.map((row) => this.toGroup(row));
      const groupIds = groups.map((group) => group.id);
      const [directServers, inheritedServers, directImages, inheritedImages, directMounts, inheritedMounts] =
        await Promise.all([
          transaction.selectFrom('iam.server_grants').selectAll()
            .where('user_id', '=', userId).execute(),
          groupIds.length === 0 ? [] : transaction.selectFrom('iam.server_grants')
            .selectAll().where('group_id', 'in', groupIds).execute(),
          transaction.selectFrom('iam.image_grants').selectAll()
            .where('user_id', '=', userId).execute(),
          groupIds.length === 0 ? [] : transaction.selectFrom('iam.image_grants')
            .selectAll().where('group_id', 'in', groupIds).execute(),
          transaction.selectFrom('iam.mount_source_grants').selectAll()
            .where('user_id', '=', userId).execute(),
          groupIds.length === 0 ? [] : transaction.selectFrom('iam.mount_source_grants')
            .selectAll().where('group_id', 'in', groupIds).execute(),
        ]);
      const groupPriority = new Map(groups.map((group) => [group.id, group.priority]));
      const serverGrants = new Map<string, ResolvedServerGrant>();
      const byServer = new Map<string, Array<GrantExpiryCandidate & ServerGrantRow>>();
      const pushCandidate = (
        serverId: string,
        row: ServerGrantRow,
        scopeRank: number,
        priority: number,
        tieBreaker: string,
      ) => {
        const list = byServer.get(serverId) ?? [];
        list.push({
          ...row,
          scopeRank,
          priority,
          tieBreaker,
          expiresAt: row.expires_at,
        });
        byServer.set(serverId, list);
      };
      for (const row of inheritedServers as unknown as ServerGrantRow[]) {
        const groupId = row.group_id ?? '';
        pushCandidate(
          row.server_id,
          row,
          1,
          groupPriority.get(groupId) ?? 0,
          groupId || row.id,
        );
      }
      for (const row of directServers as unknown as ServerGrantRow[]) {
        pushCandidate(row.server_id, row, 0, 0, row.id);
      }
      for (const [serverId, candidates] of byServer) {
        const winner = selectWinningGrantCandidate(candidates);
        if (winner) {
          serverGrants.set(serverId, this.resolveServerGrant(winner.candidate, winner.phase));
        }
      }
      const imageGrants = new Map<string, Set<string>>();
      for (const row of [...inheritedImages, ...directImages]) {
        const images = imageGrants.get(row.server_id) ?? new Set<string>();
        images.add(row.image_id);
        imageGrants.set(row.server_id, images);
      }
      const mountSourceGrants = new Map<string, Map<string, CachedMountSourceRef>>();
      for (const row of [...inheritedMounts, ...directMounts]) {
        if (row.source_kind !== 'local' || !row.server_id || !row.source_identity) continue;
        if (!serverGrants.has(row.server_id)) continue;
        const sources = mountSourceGrants.get(row.server_id) ?? new Map();
        sources.set(`local:${row.source_id}`, {
          kind: 'local',
          id: row.source_id,
          sourceIdentity: row.source_identity,
        });
        mountSourceGrants.set(row.server_id, sources);
      }
      return {
        capabilities: new Set(groups.flatMap((group) => group.capabilities)),
        groups,
        serverGrants,
        imageGrants,
        mountSourceGrants,
        epoch,
        fetchedAt: Date.now(),
      };
    });
    const currentEpoch = await this.cacheEpoch.refresh();
    if (currentEpoch !== epoch) {
      if (retryCount >= CACHE_FILL_MAX_RETRIES) {
        throw new Error('Authorization changed repeatedly while resolving access');
      }
      return this.getUserCache(userId, retryCount + 1);
    }
    this.setCacheBounded(userId, cache);
    return cache;
  }

  private emptyUserCache(epoch: number): UserCache {
    return {
      capabilities: new Set(),
      groups: [],
      serverGrants: new Map(),
      imageGrants: new Map(),
      mountSourceGrants: new Map(),
      epoch,
      fetchedAt: Date.now(),
    };
  }

  private setCacheBounded(userId: string, cache: UserCache): void {
    this.cache.delete(userId);
    this.cache.set(userId, cache);
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async isActiveUser(transaction: IamTransaction, userId: string): Promise<boolean> {
    return Boolean(await transaction.selectFrom('iam.users')
      .select('id')
      .where('id', '=', userId)
      .where('status', '=', UserStatus.Active)
      .forKeyShare()
      .executeTakeFirst());
  }

  private async resourceGrantCount(
    transaction: IamTransaction,
    table: 'iam.server_grants' | 'iam.image_grants' | 'iam.mount_source_grants',
    userId: string,
    groupIds: string[],
  ): Promise<number> {
    const direct = await transaction.selectFrom(table)
      .select('id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (direct) return 1;
    if (groupIds.length === 0) return 0;
    return await transaction.selectFrom(table)
      .select('id')
      .where('group_id', 'in', groupIds)
      .executeTakeFirst() ? 1 : 0;
  }

  private resolveServerGrant(
    row: {
      cpu_millis: number | null;
      mem_bytes: string | null;
      disk_bytes: string | null;
      gpu_mode: string | null;
      gpu_indices: number[] | null;
      expires_at?: Date | null;
    },
    phase: ServerAccessPhase,
  ): ResolvedServerGrant {
    const number = (value: string | null): number | null => {
      if (value === null) return null;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error('IAM grant exceeds the safe application integer range');
      }
      return parsed;
    };
    const expiresAt = row.expires_at ?? null;
    return {
      ...resolveGrant({
        cpuMillis: row.cpu_millis,
        memBytes: number(row.mem_bytes),
        diskBytes: number(row.disk_bytes),
        gpuMode: row.gpu_mode as GpuGrantMode | null,
        gpuIndices: row.gpu_indices,
      }),
      expiresAt,
      purgeAt: grantPurgeAt(expiresAt),
      accessPhase: phase,
    };
  }

  private toGroup(row: {
    id: string;
    name: string;
    description: string | null;
    priority: number;
    is_system: boolean;
    system_key: string | null;
    capabilities: string[];
    revision: string;
    created_at: Date;
    updated_at: Date;
  }): IamGroup {
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('IAM group revision exceeds the safe application range');
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      priority: row.priority,
      isSystem: row.is_system,
      systemKey: row.system_key as SystemGroupKey | null,
      capabilities: row.capabilities as Capability[],
      revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export { resolveGrant } from './grant-utils.js';
