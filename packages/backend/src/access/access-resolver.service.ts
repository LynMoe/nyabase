import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Not, Repository } from 'typeorm';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import {
  Capability,
  EffectiveServerAccessDto,
  GpuGrantMode,
  GroupSummaryDto,
  MountSourceKind,
  UserStatus,
  SystemGroupKey,
  type AdministrationActionsDto,
} from '@nyabase/common';
import { resolveGrant } from './grant-utils.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { exactLocalDisk } from '../mount-sources/utils.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { projectAdministrationActions } from './administration-availability.js';

export interface ResolvedServerGrant {
  cpuMillis: number;
  memBytes: number;
  diskBytes: number;
  gpuMode: GpuGrantMode;
  gpuIndices: number[];
}

export interface MountSourceRef {
  kind: MountSourceKind;
  id: string;
}

/**
 * Keeps a started external operation boxed so Promise assimilation cannot make
 * the authority transaction wait for the remote acknowledgement.
 */
export interface StartedExternalWork<T> {
  completion: Promise<T>;
}

interface CachedMountSourceRef extends MountSourceRef {
  sourceIdentity: string | null;
}

/** Per-user cache entry */
interface UserCache {
  capabilities: Set<Capability>;
  groups: GroupEntity[];
  /** serverId → resolved grant */
  serverGrants: Map<string, ResolvedServerGrant>;
  /** serverId → imageId Set */
  imageGrants: Map<string, Set<string>>;
  /** serverId → exact source identity map */
  mountSourceGrants: Map<string, Map<string, CachedMountSourceRef>>;
  epoch: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;
/**
 * Hard upper bound on the in-memory user cache. Picked so that a system with
 * thousands of users still bounds memory while keeping hit rates high for the
 * working set of active sessions.
 */
const CACHE_MAX_ENTRIES = 512;
const CACHE_FILL_MAX_RETRIES = 2;

@Injectable()
export class AccessResolverService {
  // Insertion-order Map => approximate-LRU: every read re-inserts so the
  // most recently used entry is at the tail; eviction pops the head.
  private cache = new Map<string, UserCache>();

  constructor(
    @InjectRepository(GroupEntity)
    private groupsRepo: Repository<GroupEntity>,
    @InjectRepository(GroupMemberEntity)
    private membersRepo: Repository<GroupMemberEntity>,
    @InjectRepository(ServerGrantEntity)
    private serverGrantsRepo: Repository<ServerGrantEntity>,
    @InjectRepository(ImageGrantEntity)
    private imageGrantsRepo: Repository<ImageGrantEntity>,
    @InjectRepository(ImageEntity)
    private imagesRepo: Repository<ImageEntity>,
    @InjectRepository(ServerEntity)
    private serversRepo: Repository<ServerEntity>,
    @InjectRepository(MountSourceGrantEntity)
    private mountSourceGrantsRepo: Repository<MountSourceGrantEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    private agentGateway: AgentGateway,
    private cacheEpoch: AccessCacheEpochService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cache invalidation
  // ---------------------------------------------------------------------------

  invalidateUser(userId: string) {
    // Fence any read that began before this invalidation. Merely deleting the
    // entry lets an older in-flight fill publish stale authority afterwards.
    this.cacheEpoch.bump();
    this.cache.delete(userId);
  }

  invalidateAll() {
    this.cacheEpoch.bump();
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async userCapabilities(userId: string): Promise<Set<Capability>> {
    const uc = await this.getUserCache(userId);
    return uc.capabilities;
  }

  /**
   * Resolve security-sensitive route authority from a current serialized DB
   * snapshot. The regular cache remains suitable for projections, but must
   * never extend revoked admin/read authority for its TTL.
   */
  async userCapabilitiesCurrent(userId: string): Promise<Set<Capability>> {
    return runSerializedTransaction(
      this.groupsRepo.manager.connection,
      (manager) => this.userCapabilitiesInTransaction(manager, userId, true),
    );
  }

  /** Build UI action truth from the same durable authority model as mutations. */
  async administrationActionsCurrent(actorId: string): Promise<AdministrationActionsDto> {
    return runSerializedTransaction(this.groupsRepo.manager.connection, async (manager) => {
      const [actorCapabilities, users, groups, memberships, serverGrants, imageGrants, mountGrants] = await Promise.all([
        this.userCapabilitiesInTransaction(manager, actorId, true),
        manager.find(UserEntity, { where: { status: Not(UserStatus.Deleted) } }),
        manager.find(GroupEntity),
        manager.find(GroupMemberEntity),
        manager.find(ServerGrantEntity, { select: { scope: true, scopeId: true } }),
        manager.find(ImageGrantEntity, { select: { scope: true, scopeId: true } }),
        manager.find(MountSourceGrantEntity, { select: { scope: true, scopeId: true } }),
      ]);
      const allGrants = [...serverGrants, ...imageGrants, ...mountGrants];
      const grantedUsers = new Set(allGrants.filter((grant) => grant.scope === 'user').map((grant) => grant.scopeId));
      const grantedGroups = new Set(allGrants.filter((grant) => grant.scope === 'group').map((grant) => grant.scopeId));
      const groupIdsByUser = new Map<string, string[]>();
      for (const membership of memberships) {
        const ids = groupIdsByUser.get(membership.userId) ?? [];
        ids.push(membership.groupId);
        groupIdsByUser.set(membership.userId, ids);
      }
      return projectAdministrationActions({
        actorId,
        actorCapabilities,
        users: users.map((user) => ({
          id: user.id,
          status: user.status,
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

  /** Run database-only work inside the fresh capability transaction. */
  async runWithActorCapabilities<T>(
    actorId: string,
    required: Iterable<Capability>,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return runSerializedTransaction(this.groupsRepo.manager.connection, async (manager) => {
      await this.assertActorCapabilitiesInTransaction(manager, actorId, required);
      return work(manager);
    });
  }

  /**
   * Start an external effect while current authority is linearized, then
   * release the database lease before waiting for the remote result.
   */
  async startExternalWithActorCapabilities<T>(
    actorId: string,
    required: Iterable<Capability>,
    start: () => Promise<T>,
  ): Promise<StartedExternalWork<T>> {
    return runSerializedTransaction(this.groupsRepo.manager.connection, async (manager) => {
      await this.assertActorCapabilitiesInTransaction(manager, actorId, required);
      // `start` must only synchronously dispatch/enqueue bounded work. Boxing
      // the returned Promise keeps the dispatch at the same linearization
      // point as the current-authority read while preventing the transaction
      // from awaiting the external acknowledgement.
      return { completion: start() };
    });
  }

  /** Linearize a direct side-effect with current active-user Server access. */
  async runWithActiveServerAccess<T>(
    userId: string,
    serverId: string,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return runSerializedTransaction(this.groupsRepo.manager.connection, async (manager) => {
      const user = await manager.findOneBy(UserEntity, { id: userId });
      if (
        !user
        || user.status !== UserStatus.Active
        || !await this.resolveServerInTransaction(manager, userId, serverId)
      ) {
        throw new ForbiddenException('Server access was revoked');
      }
      return work(manager);
    });
  }

  /** Server-grant counterpart of startExternalWithActorCapabilities. */
  async startExternalWithActiveServerAccess<T>(
    userId: string,
    serverId: string,
    start: () => Promise<T>,
  ): Promise<StartedExternalWork<T>> {
    return runSerializedTransaction(this.groupsRepo.manager.connection, async (manager) => {
      const user = await manager.findOneBy(UserEntity, { id: userId });
      if (
        !user
        || user.status !== UserStatus.Active
        || !await this.resolveServerInTransaction(manager, userId, serverId)
      ) {
        throw new ForbiddenException('Server access was revoked');
      }
      return { completion: start() };
    });
  }

  async hasCapability(userId: string, cap: Capability): Promise<boolean> {
    const caps = await this.userCapabilities(userId);
    return caps.has(cap);
  }

  /** Resolve capabilities from the caller's durable transaction snapshot. */
  async userCapabilitiesInTransaction(
    manager: EntityManager,
    userId: string,
    requireActive = true,
  ): Promise<Set<Capability>> {
    const user = await manager.findOneBy(UserEntity, { id: userId });
    if (!user || (requireActive && user.status !== UserStatus.Active)) return new Set();
    const memberships = await manager.find(GroupMemberEntity, { where: { userId } });
    if (memberships.length === 0) return new Set();
    const groups = await manager.find(GroupEntity, {
      where: { id: In(memberships.map((membership) => membership.groupId)) },
    });
    const capabilities = new Set<Capability>();
    for (const group of groups) {
      for (const capability of group.capabilities) capabilities.add(capability);
    }
    return capabilities;
  }

  /** Fail closed unless the active actor owns every requested capability. */
  async assertActorCapabilitiesInTransaction(
    manager: EntityManager,
    actorId: string,
    required: Iterable<Capability>,
  ): Promise<Set<Capability>> {
    const actorCapabilities = await this.userCapabilitiesInTransaction(manager, actorId, true);
    const missing = [...new Set(required)].filter((capability) => !actorCapabilities.has(capability));
    if (missing.length > 0) {
      throw new ForbiddenException({
        code: 'PRIVILEGE_ESCALATION_DENIED',
        message: 'The actor cannot grant or administer capabilities they do not hold',
        missingCapabilities: missing,
      });
    }
    return actorCapabilities;
  }

  /** An administrator may not mutate a user who owns capabilities they lack. */
  async assertActorMayAdministerUserInTransaction(
    manager: EntityManager,
    actorId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.assertActorCapabilitiesInTransaction(manager, actorId, [Capability.ManageUsers]);
    const targetCapabilities = await this.userCapabilitiesInTransaction(
      manager,
      targetUserId,
      false,
    );
    await this.assertActorCapabilitiesInTransaction(manager, actorId, targetCapabilities);
    const memberships = await manager.find(GroupMemberEntity, { where: { userId: targetUserId } });
    const groupIds = memberships.map((membership) => membership.groupId);
    const scopes = [
      { scope: 'user' as const, scopeId: targetUserId },
      ...(groupIds.length > 0
        ? [{ scope: 'group' as const, scopeId: In(groupIds) }]
        : []),
    ];
    const [serverGrantCount, imageGrantCount, mountGrantCount] = await Promise.all([
      manager.count(ServerGrantEntity, { where: scopes }),
      manager.count(ImageGrantEntity, { where: scopes }),
      manager.count(MountSourceGrantEntity, { where: scopes }),
    ]);
    if (serverGrantCount + imageGrantCount + mountGrantCount > 0) {
      await this.assertActorCapabilitiesInTransaction(
        manager,
        actorId,
        [Capability.ManageGrants],
      );
    }
  }

  async assertNotFinalActiveAdministratorInTransaction(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const administrators = await manager.findOne(GroupEntity, {
      where: { systemKey: SystemGroupKey.Administrators, isSystem: true },
    });
    if (!administrators) return;
    const membership = await manager.findOne(GroupMemberEntity, {
      where: { groupId: administrators.id, userId },
    });
    if (!membership) return;
    const otherMemberships = (await manager.find(GroupMemberEntity, {
      where: { groupId: administrators.id },
    })).filter((candidate) => candidate.userId !== userId);
    const otherUserIds = otherMemberships.map((candidate) => candidate.userId);
    const alternatives = otherUserIds.length === 0
      ? 0
      : await manager.count(UserEntity, {
          where: { id: In(otherUserIds), status: UserStatus.Active },
        });
    if (alternatives === 0) {
      throw new ForbiddenException({
        code: 'LAST_ACTIVE_ADMINISTRATOR',
        message: 'The final active administrator cannot be disabled, deleted, or removed',
      });
    }
  }

  async getUserGroupSummaries(userId: string): Promise<GroupSummaryDto[]> {
    const uc = await this.getUserCache(userId);
    return uc.groups.map((g) => ({
      id: g.id,
      name: g.name,
      priority: g.priority,
      isSystem: g.isSystem,
    }));
  }

  /** Returns null if user has no access to this server */
  async resolveServer(userId: string, serverId: string): Promise<ResolvedServerGrant | null> {
    const uc = await this.getUserCache(userId);
    return uc.serverGrants.get(serverId) ?? null;
  }

  /** Resolve the effective grant from the caller's transaction snapshot. */
  async resolveServerInTransaction(
    manager: EntityManager,
    userId: string,
    serverId: string,
  ): Promise<ResolvedServerGrant | null> {
    const memberships = await manager.find(GroupMemberEntity, { where: { userId } });
    const groupIds = memberships.map((membership) => membership.groupId);
    const groups = groupIds.length > 0
      ? await manager.find(GroupEntity, {
          where: { id: In(groupIds) },
          order: { priority: 'DESC', id: 'DESC' },
        })
      : [];
    const groupOrder = new Map(groups.map((group, index) => [group.id, index]));
    const userGrant = await manager.findOne(ServerGrantEntity, {
      where: { scope: 'user', scopeId: userId, serverId },
    });
    const groupGrants = groupIds.length > 0
      ? await manager.find(ServerGrantEntity, {
          where: { scope: 'group', scopeId: In(groupIds), serverId },
        })
      : [];
    groupGrants.sort((left, right) =>
      (groupOrder.get(left.scopeId) ?? Number.MAX_SAFE_INTEGER)
      - (groupOrder.get(right.scopeId) ?? Number.MAX_SAFE_INTEGER));
    const selectedGrant = userGrant ?? groupGrants[0];
    return selectedGrant ? resolveGrant(selectedGrant) : null;
  }

  async listAccessibleServers(userId: string): Promise<string[]> {
    const uc = await this.getUserCache(userId);
    return Array.from(uc.serverGrants.keys());
  }

  /** Returns all userIds that have an explicit grant (user-scope or via group) for this server. */
  async getUsersWithServerAccess(serverId: string): Promise<string[]> {
    const [userGrants, groupGrants] = await Promise.all([
      this.serverGrantsRepo.find({ where: { serverId, scope: 'user' }, select: { scopeId: true } }),
      this.serverGrantsRepo.find({ where: { serverId, scope: 'group' }, select: { scopeId: true } }),
    ]);

    const userIds = new Set(userGrants.map((g) => g.scopeId));

    const groupIds = groupGrants.map((g) => g.scopeId);
    if (groupIds.length > 0) {
      const members = await this.membersRepo.find({
        where: { groupId: In(groupIds) },
        select: { userId: true },
      });
      for (const m of members) userIds.add(m.userId);
    }

    return Array.from(userIds);
  }

  /** Returns imageIds the user may use on a specific server */
  async resolveAllowedImages(userId: string, serverId: string): Promise<Set<string>> {
    const uc = await this.getUserCache(userId);
    return uc.imageGrants.get(serverId) ?? new Set();
  }

  /**
   * Returns the set of mount sources the user may access on a specific server.
   * Only explicitly granted sources on servers the user can actually reach are included.
   */
  async resolveMountSources(userId: string, serverId: string): Promise<Set<MountSourceRef>> {
    const uc = await this.getUserCache(userId);
    const cached = uc.mountSourceGrants.get(serverId);
    const result = new Set<MountSourceRef>();
    for (const source of cached?.values() ?? []) {
      if (source.kind === 'local') {
        const snapshot = this.agentGateway.stateCache.get(serverId);
        const disk = snapshot && snapshot.helloAt !== null
          ? exactLocalDisk(snapshot.disks, source.id)
          : null;
        if (!disk || disk.sourceIdentity !== source.sourceIdentity) continue;
      }
      result.add({ kind: source.kind, id: source.id });
    }
    return result;
  }

  async hasMountSourceAccess(
    userId: string,
    serverId: string,
    kind: MountSourceKind,
    sourceId: string,
  ): Promise<boolean> {
    const sources = await this.resolveMountSources(userId, serverId);
    for (const s of sources) {
      if (s.kind === kind && s.id === sourceId) return true;
    }
    return false;
  }

  /** Fail-closed authorization from the caller's serialized DB snapshot. */
  async hasMountSourceAccessInTransaction(
    manager: EntityManager,
    userId: string,
    serverId: string,
    source: MountSourceRef,
    expectedSourceIdentity?: string,
  ): Promise<boolean> {
    const user = await manager.findOneBy(UserEntity, { id: userId });
    if (!user || user.status !== UserStatus.Active) return false;
    if (!await this.resolveServerInTransaction(manager, userId, serverId)) return false;
    const memberships = await manager.find(GroupMemberEntity, { where: { userId } });
    const scopes = [
      { scope: 'user' as const, scopeId: userId },
      ...memberships.map((membership) => ({
        scope: 'group' as const,
        scopeId: membership.groupId,
      })),
    ];

    if (source.kind === 'local') {
      const snapshot = this.agentGateway.stateCache.get(serverId);
      const disk = snapshot && snapshot.helloAt !== null
        ? exactLocalDisk(snapshot.disks, source.id)
        : null;
      if (!disk || (expectedSourceIdentity !== undefined
        && disk.sourceIdentity !== expectedSourceIdentity)) return false;
      for (const scope of scopes) {
        if (await manager.findOneBy(MountSourceGrantEntity, {
          ...scope,
          sourceKind: 'local',
          sourceId: source.id,
          serverId,
          sourceIdentity: disk.sourceIdentity,
        })) return true;
      }
      return false;
    }

    if (expectedSourceIdentity !== undefined) return false;
    if (await manager.count(RemoteFsServerAssignmentEntity, {
      where: { remoteFsMountId: source.id, serverId, desiredState: 'active' },
    }) === 0) return false;
    for (const scope of scopes) {
      if (await manager.findOneBy(MountSourceGrantEntity, {
        ...scope,
        sourceKind: 'remote',
        sourceId: source.id,
        serverId: IsNull(),
        sourceIdentity: IsNull(),
      })) return true;
    }
    return false;
  }

  /** Returns true if the user may access the given image on any server */
  async isImageAccessibleForUser(userId: string, imageId: string): Promise<boolean> {
    const uc = await this.getUserCache(userId);
    for (const serverId of uc.serverGrants.keys()) {
      const imageSet = uc.imageGrants.get(serverId);
      if (imageSet?.has(imageId)) return true;
    }
    return false;
  }

  /**
   * Resolve every authorization input for container creation from one DB
   * transaction snapshot. This deliberately bypasses the read cache so a
   * revoked grant cannot race a stale create request into the task outbox.
   */
  async resolveContainerCreateAccessInTransaction(
    manager: EntityManager,
    userId: string,
    serverId: string,
    imageId: string,
    mountSources: readonly (MountSourceRef & { sourceIdentity?: string })[],
  ): Promise<{ grant: ResolvedServerGrant; mountSourcesAllowed: boolean } | null> {
    const user = await manager.findOneBy(UserEntity, { id: userId });
    if (!user || user.status !== UserStatus.Active) return null;
    const memberships = await manager.find(GroupMemberEntity, { where: { userId } });
    const groupIds = memberships.map((membership) => membership.groupId);
    const groups = groupIds.length > 0
      ? await manager.find(GroupEntity, {
          where: { id: In(groupIds) },
          order: { priority: 'DESC', id: 'DESC' },
        })
      : [];
    const groupOrder = new Map(groups.map((group, index) => [group.id, index]));

    const userGrant = await manager.findOne(ServerGrantEntity, {
      where: { scope: 'user', scopeId: userId, serverId },
    });
    const groupGrants = groupIds.length > 0
      ? await manager.find(ServerGrantEntity, {
          where: { scope: 'group', scopeId: In(groupIds), serverId },
        })
      : [];
    groupGrants.sort((left, right) =>
      (groupOrder.get(left.scopeId) ?? Number.MAX_SAFE_INTEGER)
      - (groupOrder.get(right.scopeId) ?? Number.MAX_SAFE_INTEGER));
    const selectedGrant = userGrant ?? groupGrants[0];
    if (!selectedGrant) return null;

    const imageGrantWhere = [
      { scope: 'user' as const, scopeId: userId, serverId, imageId },
      ...(groupIds.length > 0
        ? [{ scope: 'group' as const, scopeId: In(groupIds), serverId, imageId }]
        : []),
    ];
    if (await manager.count(ImageGrantEntity, { where: imageGrantWhere }) === 0) return null;

    for (const source of mountSources) {
      if (!await this.hasMountSourceAccessInTransaction(
        manager,
        userId,
        serverId,
        source,
        source.kind === 'local' ? source.sourceIdentity : undefined,
      )) {
        return { grant: resolveGrant(selectedGrant), mountSourcesAllowed: false };
      }
    }

    return { grant: resolveGrant(selectedGrant), mountSourcesAllowed: true };
  }

  async getEffectiveAccess(userId: string): Promise<EffectiveServerAccessDto[]> {
    const uc = await this.getUserCache(userId);
    const result: EffectiveServerAccessDto[] = [];
    for (const [serverId, grant] of uc.serverGrants.entries()) {
      const allowedImageIds = Array.from(uc.imageGrants.get(serverId) ?? []);
      result.push({
        serverId,
        cpuMillis: grant.cpuMillis,
        memBytes: grant.memBytes,
        diskBytes: grant.diskBytes,
        gpuMode: grant.gpuMode,
        gpuIndices: grant.gpuIndices,
        allowedImageIds,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async allMountSourcesForServer(serverId: string): Promise<Set<MountSourceRef>> {
    const remoteAssignments = await this.remoteFsAssignmentsRepo.find({
      where: { serverId, desiredState: 'active' },
      select: { remoteFsMountId: true },
    });
    const result = new Set<MountSourceRef>();
    for (const d of this.agentGateway.stateCache.get(serverId)?.disks ?? []) {
      result.add({ kind: 'local', id: d.diskId });
    }
    for (const a of remoteAssignments) result.add({ kind: 'remote', id: a.remoteFsMountId });
    return result;
  }

  private async getUserCache(userId: string, retryCount = 0): Promise<UserCache> {
    const epoch = this.cacheEpoch.current();
    const cached = this.cache.get(userId);
    if (cached && cached.epoch === epoch && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      // Touch for LRU recency.
      this.cache.delete(userId);
      this.cache.set(userId, cached);
      return cached;
    }

    const [memberships, servers] = await Promise.all([
      this.membersRepo.find({ where: { userId } }),
      this.serversRepo.find({ select: { id: true } }),
    ]);
    const groupIds = memberships.map((m) => m.groupId);
    const serverIds = new Set(servers.map((s) => s.id));

    // Step 2: all grant types in parallel
    const [
      groups,
      userServerGrants,
      userImageGrants,
      groupServerGrants,
      groupImageGrants,
      userMountSourceGrants,
      groupMountSourceGrants,
    ] = await Promise.all([
      groupIds.length > 0
        ? this.groupsRepo
            .createQueryBuilder('g')
            .where('g.id IN (:...ids)', { ids: groupIds })
            .orderBy('g.priority', 'DESC')
            .addOrderBy('g.id', 'DESC')
            .getMany()
        : Promise.resolve([] as GroupEntity[]),

      this.serverGrantsRepo.find({ where: { scope: 'user', scopeId: userId } }),
      this.imageGrantsRepo.find({ where: { scope: 'user', scopeId: userId } }),

      groupIds.length > 0
        ? this.serverGrantsRepo
            .createQueryBuilder('sg')
            .where('sg.scope = :scope AND sg.scopeId IN (:...ids)', { scope: 'group', ids: groupIds })
            .getMany()
        : Promise.resolve([] as ServerGrantEntity[]),

      groupIds.length > 0
        ? this.imageGrantsRepo
            .createQueryBuilder('ig')
            .where('ig.scope = :scope AND ig.scopeId IN (:...ids)', { scope: 'group', ids: groupIds })
            .getMany()
        : Promise.resolve([] as ImageGrantEntity[]),

      this.mountSourceGrantsRepo.find({ where: { scope: 'user', scopeId: userId } }),

      groupIds.length > 0
        ? this.mountSourceGrantsRepo
            .createQueryBuilder('msg')
            .where('msg.scope = :scope AND msg.scopeId IN (:...ids)', { scope: 'group', ids: groupIds })
            .getMany()
        : Promise.resolve([] as MountSourceGrantEntity[]),
    ]);

    // Capabilities = union of all group capabilities
    const capabilities = new Set<Capability>();
    for (const g of groups) {
      for (const cap of g.capabilities) capabilities.add(cap);
    }

    const serverGrants = new Map<string, ResolvedServerGrant>();
    const imageGrants = new Map<string, Set<string>>();

    // Group-level server grants: pick highest-priority group per server
    const groupOrder = new Map(groups.map((g, i) => [g.id, i]));
    const bestGroupGrant = new Map<string, { grant: ServerGrantEntity; order: number }>();
    for (const g of groupServerGrants) {
      const order = groupOrder.get(g.scopeId) ?? Number.MAX_SAFE_INTEGER;
      const existing = bestGroupGrant.get(g.serverId);
      if (!existing || order < existing.order) {
        bestGroupGrant.set(g.serverId, { grant: g, order });
      }
    }
    for (const [sid, { grant }] of bestGroupGrant) {
      if (!serverIds.has(sid)) continue;
      serverGrants.set(sid, this.resolveGrant(grant));
    }

    // User-level server grants override group grants
    for (const g of userServerGrants) {
      if (!serverIds.has(g.serverId)) continue;
      serverGrants.set(g.serverId, this.resolveGrant(g));
    }

    // Image grants (group-level then user-level, union)
    for (const ig of groupImageGrants) {
      if (!imageGrants.has(ig.serverId)) imageGrants.set(ig.serverId, new Set());
      imageGrants.get(ig.serverId)!.add(ig.imageId);
    }
    for (const ig of userImageGrants) {
      if (!imageGrants.has(ig.serverId)) imageGrants.set(ig.serverId, new Set());
      imageGrants.get(ig.serverId)!.add(ig.imageId);
    }

    // Mount source grants are bound to an exact physical identity and
    // intersected with servers the user can reach.
    const allMsgGrants = [...userMountSourceGrants, ...groupMountSourceGrants];
    const mountSourceGrants = new Map<string, Map<string, CachedMountSourceRef>>();

    if (allMsgGrants.length > 0) {
      const remoteIds = [...new Set(
        allMsgGrants.filter((g) => g.sourceKind === 'remote').map((g) => g.sourceId),
      )];

      const assignmentRows = remoteIds.length > 0
        ? await this.remoteFsAssignmentsRepo.find({
            where: { remoteFsMountId: In(remoteIds), desiredState: 'active' },
            select: { remoteFsMountId: true, serverId: true },
          })
        : [];
      // remoteFsMountId → serverId[]
      const remoteServerMap = new Map<string, string[]>();
      for (const a of assignmentRows) {
        if (!remoteServerMap.has(a.remoteFsMountId)) remoteServerMap.set(a.remoteFsMountId, []);
        remoteServerMap.get(a.remoteFsMountId)!.push(a.serverId);
      }

      const accessibleServerIds = new Set(serverGrants.keys());

      for (const g of allMsgGrants) {
        if (g.sourceKind === 'local') {
          if (!g.serverId || !g.sourceIdentity || !accessibleServerIds.has(g.serverId)) continue;
          const snapshot = this.agentGateway.stateCache.get(g.serverId);
          if (!snapshot || snapshot.helloAt === null || snapshot.serverId !== g.serverId) continue;
          const disk = exactLocalDisk(snapshot.disks, g.sourceId);
          if (!disk || disk.sourceIdentity !== g.sourceIdentity) continue;
          if (!mountSourceGrants.has(g.serverId)) mountSourceGrants.set(g.serverId, new Map());
          mountSourceGrants.get(g.serverId)!.set(`local:${g.sourceId}`, {
            kind: 'local',
            id: g.sourceId,
            sourceIdentity: g.sourceIdentity,
          });
        } else {
          const serverIds = remoteServerMap.get(g.sourceId) ?? [];
          for (const serverId of serverIds) {
            if (!accessibleServerIds.has(serverId)) continue;
            if (!mountSourceGrants.has(serverId)) mountSourceGrants.set(serverId, new Map());
            mountSourceGrants.get(serverId)!.set(`remote:${g.sourceId}`, {
              kind: 'remote',
              id: g.sourceId,
              sourceIdentity: null,
            });
          }
        }
      }
    }

    const uc: UserCache = {
      capabilities,
      groups,
      serverGrants,
      imageGrants,
      mountSourceGrants,
      epoch,
      fetchedAt: Date.now(),
    };
    // If any authorization mutation committed while this multi-query snapshot
    // was assembled, never return or publish the stale fill to its caller.
    if (this.cacheEpoch.current() !== epoch) {
      if (retryCount >= CACHE_FILL_MAX_RETRIES) {
        throw new Error('Authorization changed repeatedly while resolving access');
      }
      return this.getUserCache(userId, retryCount + 1);
    }
    this.setCacheBounded(userId, uc);
    return uc;
  }

  private setCacheBounded(userId: string, uc: UserCache): void {
    // If overwriting, drop first so the new entry lands at the LRU tail.
    if (this.cache.has(userId)) this.cache.delete(userId);
    this.cache.set(userId, uc);
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  private resolveGrant(
    grant: ServerGrantEntity,
  ): ResolvedServerGrant {
    return resolveGrant(grant);
  }
}

export { resolveGrant } from './grant-utils.js';
