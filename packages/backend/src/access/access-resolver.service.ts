import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { Capability, GpuGrantMode, EffectiveServerAccessDto, GroupSummaryDto, MountSourceKind } from '@nyabase/common';
import { resolveGrantWithServerDefaults } from './grant-utils.js';

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

/** Per-user cache entry */
interface UserCache {
  capabilities: Set<Capability>;
  groups: GroupEntity[];
  /** serverId → resolved grant */
  serverGrants: Map<string, ResolvedServerGrant>;
  /** serverId → imageId Set */
  imageGrants: Map<string, Set<string>>;
  /** serverId → Set of "kind:sourceId" */
  mountSourceGrants: Map<string, Set<string>>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;
/**
 * Hard upper bound on the in-memory user cache. Picked so that a system with
 * thousands of users still bounds memory while keeping hit rates high for the
 * working set of active sessions.
 */
const CACHE_MAX_ENTRIES = 512;

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
    @InjectRepository(DataDiskEntity)
    private dataDisksRepo: Repository<DataDiskEntity>,
  ) {}

  // ---------------------------------------------------------------------------
  // Cache invalidation
  // ---------------------------------------------------------------------------

  invalidateUser(userId: string) {
    this.cache.delete(userId);
  }

  invalidateAll() {
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async userCapabilities(userId: string): Promise<Set<Capability>> {
    const uc = await this.getUserCache(userId);
    return uc.capabilities;
  }

  async hasCapability(userId: string, cap: Capability): Promise<boolean> {
    const caps = await this.userCapabilities(userId);
    return caps.has(cap);
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
    const keys = uc.mountSourceGrants.get(serverId) ?? new Set<string>();
    const result = new Set<MountSourceRef>();
    for (const key of keys) {
      const colon = key.indexOf(':');
      result.add({ kind: key.slice(0, colon) as MountSourceKind, id: key.slice(colon + 1) });
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

  /** Returns true if the user may access the given image on any server */
  async isImageAccessibleForUser(userId: string, imageId: string): Promise<boolean> {
    const uc = await this.getUserCache(userId);
    for (const serverId of uc.serverGrants.keys()) {
      const imageSet = uc.imageGrants.get(serverId);
      if (imageSet?.has(imageId)) return true;
    }
    return false;
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
    const [localDisks, remoteAssignments] = await Promise.all([
      this.dataDisksRepo.find({ where: { serverId, desiredState: 'active' }, select: { id: true } }),
      this.remoteFsAssignmentsRepo.find({
        where: { serverId, desiredState: 'active' },
        select: { remoteFsMountId: true },
      }),
    ]);
    const result = new Set<MountSourceRef>();
    for (const d of localDisks) result.add({ kind: 'local', id: d.id });
    for (const a of remoteAssignments) result.add({ kind: 'remote', id: a.remoteFsMountId });
    return result;
  }

  private async getUserCache(userId: string): Promise<UserCache> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      // Touch for LRU recency.
      this.cache.delete(userId);
      this.cache.set(userId, cached);
      return cached;
    }

    // Step 1: memberships + all servers in parallel
    const [memberships, servers] = await Promise.all([
      this.membersRepo.find({ where: { userId } }),
      this.serversRepo.find(),
    ]);
    const groupIds = memberships.map((m) => m.groupId);
    const serverMap = new Map(servers.map((s) => [s.id, s]));

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
      const server = serverMap.get(sid);
      if (server) serverGrants.set(sid, this.resolveGrantWithDefaults(grant, server));
    }

    // User-level server grants override group grants
    for (const g of userServerGrants) {
      const server = serverMap.get(g.serverId);
      if (server) serverGrants.set(g.serverId, this.resolveGrantWithDefaults(g, server));
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

    // Mount source grants — resolve to (serverId, "kind:sourceId") pairs
    // and intersect with servers the user has a server-grant for.
    const allMsgGrants = [...userMountSourceGrants, ...groupMountSourceGrants];
    const mountSourceGrants = new Map<string, Set<string>>();

    if (allMsgGrants.length > 0) {
      const localIds = [...new Set(
        allMsgGrants.filter((g) => g.sourceKind === 'local').map((g) => g.sourceId),
      )];
      const remoteIds = [...new Set(
        allMsgGrants.filter((g) => g.sourceKind === 'remote').map((g) => g.sourceId),
      )];

      const [diskRows, assignmentRows] = await Promise.all([
        localIds.length > 0
          ? this.dataDisksRepo.find({ where: { id: In(localIds) }, select: { id: true, serverId: true } })
          : Promise.resolve([]),
        remoteIds.length > 0
          ? this.remoteFsAssignmentsRepo.find({
              where: { remoteFsMountId: In(remoteIds) },
              select: { remoteFsMountId: true, serverId: true },
            })
          : Promise.resolve([]),
      ]);

      // disk id → serverId
      const diskServerMap = new Map(diskRows.map((d) => [d.id, d.serverId]));
      // remoteFsMountId → serverId[]
      const remoteServerMap = new Map<string, string[]>();
      for (const a of assignmentRows) {
        if (!remoteServerMap.has(a.remoteFsMountId)) remoteServerMap.set(a.remoteFsMountId, []);
        remoteServerMap.get(a.remoteFsMountId)!.push(a.serverId);
      }

      const accessibleServerIds = new Set(serverGrants.keys());

      for (const g of allMsgGrants) {
        if (g.sourceKind === 'local') {
          const serverId = diskServerMap.get(g.sourceId);
          if (!serverId) continue;
          if (!accessibleServerIds.has(serverId)) continue;
          if (!mountSourceGrants.has(serverId)) mountSourceGrants.set(serverId, new Set());
          mountSourceGrants.get(serverId)!.add(`local:${g.sourceId}`);
        } else {
          const serverIds = remoteServerMap.get(g.sourceId) ?? [];
          for (const serverId of serverIds) {
            if (!accessibleServerIds.has(serverId)) continue;
            if (!mountSourceGrants.has(serverId)) mountSourceGrants.set(serverId, new Set());
            mountSourceGrants.get(serverId)!.add(`remote:${g.sourceId}`);
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
      fetchedAt: Date.now(),
    };
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

  private resolveGrantWithDefaults(
    grant: ServerGrantEntity,
    server: ServerEntity,
  ): ResolvedServerGrant {
    return resolveGrantWithServerDefaults(grant, server);
  }
}

export { resolveGrantWithServerDefaults } from './grant-utils.js';
