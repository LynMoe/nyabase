import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { QuotaDispatchService } from '../quota/quota-dispatch.service.js';
import {
  Capability,
  GpuGrantMode,
  AuditAction,
  GroupDto,
  GroupMemberDto,
  GroupSummaryDto,
  ServerGrantDto,
  ImageGrantDto,
  MountSourceGrantDto,
  MountSourceKind,
} from '@nyabase/common';

@Injectable()
export class GroupsService {
  constructor(
    @InjectRepository(GroupEntity)
    private groupsRepo: Repository<GroupEntity>,
    @InjectRepository(GroupMemberEntity)
    private membersRepo: Repository<GroupMemberEntity>,
    @InjectRepository(ServerGrantEntity)
    private serverGrantsRepo: Repository<ServerGrantEntity>,
    @InjectRepository(ImageGrantEntity)
    private imageGrantsRepo: Repository<ImageGrantEntity>,
    @InjectRepository(MountSourceGrantEntity)
    private mountSourceGrantsRepo: Repository<MountSourceGrantEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(DataDiskEntity)
    private dataDisksRepo: Repository<DataDiskEntity>,
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    private accessResolver: AccessResolverService,
    private auditService: AuditService,
    private quotaDispatchService: QuotaDispatchService,
  ) {}

  // ---------------------------------------------------------------------------
  // Group CRUD
  // ---------------------------------------------------------------------------

  async findAll(): Promise<GroupDto[]> {
    const [groups, allServerGrants, allImageGrants, allMembers] = await Promise.all([
      this.groupsRepo.find({ order: { priority: 'DESC', name: 'ASC' } }),
      this.serverGrantsRepo.find({ where: { scope: 'group' } }),
      this.imageGrantsRepo.find({ where: { scope: 'group' } }),
      this.membersRepo.find(),
    ]);

    const allUserIds = [...new Set(allMembers.map((m) => m.userId))];
    const allUsers = allUserIds.length > 0
      ? await this.usersRepo.find({ where: { id: In(allUserIds) } })
      : [];
    const usersMap = new Map(allUsers.map((u) => [u.id, u]));

    const serverGrantsByGroup = new Map<string, ServerGrantEntity[]>();
    for (const g of allServerGrants) {
      if (!serverGrantsByGroup.has(g.scopeId)) serverGrantsByGroup.set(g.scopeId, []);
      serverGrantsByGroup.get(g.scopeId)!.push(g);
    }

    const imageIdsByGroup = new Map<string, Set<string>>();
    for (const g of allImageGrants) {
      if (!imageIdsByGroup.has(g.scopeId)) imageIdsByGroup.set(g.scopeId, new Set());
      imageIdsByGroup.get(g.scopeId)!.add(g.imageId);
    }

    const membersByGroup = new Map<string, GroupMemberDto[]>();
    for (const m of allMembers) {
      if (!membersByGroup.has(m.groupId)) membersByGroup.set(m.groupId, []);
      const u = usersMap.get(m.userId);
      membersByGroup.get(m.groupId)!.push({
        userId: m.userId,
        username: u?.username ?? m.userId,
        displayName: u?.displayName ?? '',
      });
    }

    return groups.map((g) => {
      const grants = serverGrantsByGroup.get(g.id) ?? [];
      const members = membersByGroup.get(g.id) ?? [];
      return {
        ...this.toDto(g),
        serverIds: grants.map((sg) => sg.serverId),
        serverGrants: grants.map((sg) => this.serverGrantToDto(sg)),
        imageIds: Array.from(imageIdsByGroup.get(g.id) ?? new Set<string>()),
        members,
        memberCount: members.length,
      };
    });
  }

  async findById(id: string): Promise<GroupEntity> {
    const g = await this.groupsRepo.findOne({ where: { id } });
    if (!g) throw new NotFoundException('Group not found');
    return g;
  }

  async create(
    dto: { name: string; description?: string; priority?: number; capabilities?: Capability[] },
    actorId?: string,
  ): Promise<GroupDto> {
    const existing = await this.groupsRepo.findOne({ where: { name: dto.name } });
    if (existing) throw new ConflictException('Group name already exists');

    const group = this.groupsRepo.create({
      id: uuidv4(),
      name: dto.name,
      description: dto.description ?? null,
      priority: dto.priority ?? 0,
      isSystem: false,
    });
    group.capabilities = dto.capabilities ?? [];
    await this.groupsRepo.save(group);
    await this.auditService.log(actorId ?? null, AuditAction.CreateGroup, group.id, 'group', { name: group.name });
    return this.toDto(group);
  }

  async update(
    id: string,
    dto: { name?: string; description?: string; priority?: number; capabilities?: Capability[] },
    actorId?: string,
  ): Promise<GroupDto> {
    const group = await this.findById(id);

    if (dto.name !== undefined) {
      const existing = await this.groupsRepo.findOne({ where: { name: dto.name } });
      if (existing && existing.id !== id) throw new ConflictException('Group name already exists');
      group.name = dto.name;
    }
    if (dto.description !== undefined) group.description = dto.description ?? null;
    if (dto.priority !== undefined) group.priority = dto.priority;
    if (dto.capabilities !== undefined) group.capabilities = dto.capabilities;

    await this.groupsRepo.save(group);
    await this.auditService.log(actorId ?? null, AuditAction.UpdateGroup, id, 'group', dto);

    const members = await this.membersRepo.find({ where: { groupId: id } });
    for (const m of members) this.accessResolver.invalidateUser(m.userId);

    return this.toDto(group);
  }

  async delete(id: string, actorId?: string): Promise<void> {
    const group = await this.findById(id);
    if (group.isSystem) throw new ForbiddenException('Cannot delete system group');

    const [members, groupServerGrants] = await Promise.all([
      this.membersRepo.find({ where: { groupId: id } }),
      this.serverGrantsRepo.find({ where: { scope: 'group', scopeId: id }, select: { serverId: true } }),
    ]);
    await this.membersRepo.delete({ groupId: id });
    await this.serverGrantsRepo.delete({ scope: 'group', scopeId: id });
    await this.imageGrantsRepo.delete({ scope: 'group', scopeId: id });
    await this.mountSourceGrantsRepo.delete({ scope: 'group', scopeId: id });
    await this.groupsRepo.remove(group);
    await this.auditService.log(actorId ?? null, AuditAction.DeleteGroup, id, 'group', { name: group.name });

    for (const m of members) this.accessResolver.invalidateUser(m.userId);
    await Promise.all(
      members.flatMap((m) => groupServerGrants.map((g) => this.syncUserQuota(m.userId, g.serverId, actorId ?? null))),
    );
  }

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------

  async listMembers(groupId: string): Promise<GroupMemberDto[]> {
    await this.findById(groupId);
    const members = await this.membersRepo.find({ where: { groupId } });
    if (members.length === 0) return [];
    const userIds = members.map((m) => m.userId);
    const users = await this.usersRepo.find({ where: { id: In(userIds) } });
    const usersMap = new Map(users.map((u) => [u.id, u]));
    return members.map((m) => {
      const u = usersMap.get(m.userId);
      return { userId: m.userId, username: u?.username ?? m.userId, displayName: u?.displayName ?? '' };
    });
  }

  async addMember(groupId: string, userId: string, actorId?: string): Promise<void> {
    await this.findById(groupId);
    const existing = await this.membersRepo.findOne({ where: { groupId, userId } });
    if (existing) return; // idempotent
    await this.membersRepo.save(this.membersRepo.create({ id: uuidv4(), groupId, userId }));
    this.accessResolver.invalidateUser(userId);
    await this.auditService.log(actorId ?? null, AuditAction.AddGroupMember, groupId, 'group', { userId });
    const groupGrants = await this.serverGrantsRepo.find({
      where: { scope: 'group', scopeId: groupId },
      select: { serverId: true },
    });
    await Promise.all(groupGrants.map((g) => this.syncUserQuota(userId, g.serverId, actorId ?? null)));
  }

  async removeMember(groupId: string, userId: string, actorId?: string): Promise<void> {
    const groupGrants = await this.serverGrantsRepo.find({
      where: { scope: 'group', scopeId: groupId },
      select: { serverId: true },
    });
    await this.membersRepo.delete({ groupId, userId });
    this.accessResolver.invalidateUser(userId);
    await this.auditService.log(actorId ?? null, AuditAction.RemoveGroupMember, groupId, 'group', { userId });
    await Promise.all(groupGrants.map((g) => this.syncUserQuota(userId, g.serverId, actorId ?? null)));
  }

  async ensureUserInGroup(groupName: string, userId: string): Promise<void> {
    const group = await this.groupsRepo.findOne({ where: { name: groupName } });
    if (!group) return;
    await this.addMember(group.id, userId);
  }

  async ensureUserNotInSystemGroup(groupName: string, userId: string): Promise<void> {
    const group = await this.groupsRepo.findOne({ where: { name: groupName, isSystem: true } });
    if (!group) return;
    await this.removeMember(group.id, userId);
  }

  /** Remove all group memberships, server grants, image grants, and mount source grants for a deleted user */
  async cleanupUserData(userId: string): Promise<void> {
    await this.membersRepo.delete({ userId });
    await this.serverGrantsRepo.delete({ scope: 'user', scopeId: userId });
    await this.imageGrantsRepo.delete({ scope: 'user', scopeId: userId });
    await this.mountSourceGrantsRepo.delete({ scope: 'user', scopeId: userId });
    this.accessResolver.invalidateUser(userId);
  }

  // ---------------------------------------------------------------------------
  // Server grants (group scope)
  // ---------------------------------------------------------------------------

  async listGroupServerGrants(groupId: string): Promise<ServerGrantDto[]> {
    const grants = await this.serverGrantsRepo.find({
      where: { scope: 'group', scopeId: groupId },
    });
    return grants.map((g) => this.serverGrantToDto(g));
  }

  async upsertGroupServerGrant(
    groupId: string,
    serverId: string,
    dto: Partial<{
      cpuMillis: number | null;
      memBytes: number | null;
      diskBytes: number | null;
      gpuMode: GpuGrantMode | null;
      gpuIndices: number[] | null;
    }>,
    actorId?: string,
  ): Promise<ServerGrantDto> {
    await this.findById(groupId);
    let grant = await this.serverGrantsRepo.findOne({
      where: { scope: 'group', scopeId: groupId, serverId },
    });
    if (!grant) {
      grant = this.serverGrantsRepo.create({
        id: uuidv4(),
        scope: 'group',
        scopeId: groupId,
        serverId,
        gpuMode: null,
      });
    }
    this.applyGrantDto(grant, dto);
    await this.serverGrantsRepo.save(grant);
    const members = await this.invalidateGroupMembers(groupId);
    await this.auditService.log(actorId ?? null, AuditAction.UpsertServerGrant, groupId, 'group', { serverId, ...dto });
    await Promise.all(members.map((m) => this.syncUserQuota(m.userId, serverId, actorId ?? null)));
    return this.serverGrantToDto(grant);
  }

  async deleteGroupServerGrant(groupId: string, serverId: string, actorId?: string): Promise<void> {
    await this.serverGrantsRepo.delete({ scope: 'group', scopeId: groupId, serverId });
    const members = await this.invalidateGroupMembers(groupId);
    await this.auditService.log(actorId ?? null, AuditAction.DeleteServerGrant, groupId, 'group', { serverId });
    await Promise.all(members.map((m) => this.syncUserQuota(m.userId, serverId, actorId ?? null)));
  }

  // ---------------------------------------------------------------------------
  // Image grants (group scope)
  // ---------------------------------------------------------------------------

  async listGroupImageGrants(groupId: string): Promise<ImageGrantDto[]> {
    const grants = await this.imageGrantsRepo.find({
      where: { scope: 'group', scopeId: groupId },
    });
    return grants.map((g) => this.imageGrantToDto(g));
  }

  async addGroupImageGrant(groupId: string, imageId: string, serverId: string): Promise<ImageGrantDto> {
    await this.findById(groupId);
    let grant = await this.imageGrantsRepo.findOne({
      where: { scope: 'group', scopeId: groupId, imageId, serverId },
    });
    if (!grant) {
      grant = this.imageGrantsRepo.create({
        id: uuidv4(),
        scope: 'group',
        scopeId: groupId,
        imageId,
        serverId,
      });
      await this.imageGrantsRepo.save(grant);
    }
    await this.invalidateGroupMembers(groupId);
    return this.imageGrantToDto(grant);
  }

  async deleteGroupImageGrant(groupId: string, imageId: string, serverId: string): Promise<void> {
    await this.imageGrantsRepo.delete({ scope: 'group', scopeId: groupId, imageId, serverId });
    await this.invalidateGroupMembers(groupId);
  }

  /** Sync image grants for a group on specific servers (replace all for those servers) */
  async syncGroupImageGrantsForServers(
    groupId: string,
    imageId: string,
    serverIds: string[],
  ): Promise<ImageGrantDto[]> {
    await this.findById(groupId);
    const existing = await this.imageGrantsRepo.find({
      where: { scope: 'group', scopeId: groupId, imageId },
    });

    const existingServerIds = new Set(existing.map((g) => g.serverId));
    const targetServerIds = new Set(serverIds);

    const toRemove = existing.filter((g) => !targetServerIds.has(g.serverId));
    const toAdd = serverIds
      .filter((sid) => !existingServerIds.has(sid))
      .map((sid) =>
        this.imageGrantsRepo.create({
          id: uuidv4(),
          scope: 'group',
          scopeId: groupId,
          imageId,
          serverId: sid,
        }),
      );

    await Promise.all([
      toRemove.length > 0 ? this.imageGrantsRepo.remove(toRemove) : Promise.resolve(),
      toAdd.length > 0 ? this.imageGrantsRepo.save(toAdd) : Promise.resolve(),
    ]);

    await this.invalidateGroupMembers(groupId);
    const updated = await this.imageGrantsRepo.find({
      where: { scope: 'group', scopeId: groupId, imageId },
    });
    return updated.map((g) => this.imageGrantToDto(g));
  }

  // ---------------------------------------------------------------------------
  // Server grants (user scope)
  // ---------------------------------------------------------------------------

  async listUserServerGrants(userId: string): Promise<ServerGrantDto[]> {
    const grants = await this.serverGrantsRepo.find({ where: { scope: 'user', scopeId: userId } });
    return grants.map((g) => this.serverGrantToDto(g));
  }

  async upsertUserServerGrant(
    userId: string,
    serverId: string,
    dto: Partial<{
      cpuMillis: number | null;
      memBytes: number | null;
      diskBytes: number | null;
      gpuMode: GpuGrantMode | null;
      gpuIndices: number[] | null;
    }>,
    actorId?: string,
  ): Promise<ServerGrantDto> {
    let grant = await this.serverGrantsRepo.findOne({
      where: { scope: 'user', scopeId: userId, serverId },
    });
    if (!grant) {
      grant = this.serverGrantsRepo.create({
        id: uuidv4(),
        scope: 'user',
        scopeId: userId,
        serverId,
        gpuMode: null,
      });
    }
    this.applyGrantDto(grant, dto);
    await this.serverGrantsRepo.save(grant);
    this.accessResolver.invalidateUser(userId);
    await this.auditService.log(actorId ?? null, AuditAction.UpsertServerGrant, userId, 'user', { serverId, ...dto });
    await this.syncUserQuota(userId, serverId, actorId ?? null);
    return this.serverGrantToDto(grant);
  }

  async deleteUserServerGrant(userId: string, serverId: string, actorId?: string): Promise<void> {
    await this.serverGrantsRepo.delete({ scope: 'user', scopeId: userId, serverId });
    this.accessResolver.invalidateUser(userId);
    await this.auditService.log(actorId ?? null, AuditAction.DeleteServerGrant, userId, 'user', { serverId });
    await this.syncUserQuota(userId, serverId, actorId ?? null);
  }

  // ---------------------------------------------------------------------------
  // Image grants (user scope)
  // ---------------------------------------------------------------------------

  async listUserImageGrants(userId: string): Promise<ImageGrantDto[]> {
    const grants = await this.imageGrantsRepo.find({ where: { scope: 'user', scopeId: userId } });
    return grants.map((g) => this.imageGrantToDto(g));
  }

  async addUserImageGrant(userId: string, imageId: string, serverId: string): Promise<ImageGrantDto> {
    let grant = await this.imageGrantsRepo.findOne({
      where: { scope: 'user', scopeId: userId, imageId, serverId },
    });
    if (!grant) {
      grant = this.imageGrantsRepo.create({
        id: uuidv4(),
        scope: 'user',
        scopeId: userId,
        imageId,
        serverId,
      });
      await this.imageGrantsRepo.save(grant);
    }
    this.accessResolver.invalidateUser(userId);
    return this.imageGrantToDto(grant);
  }

  async deleteUserImageGrant(userId: string, imageId: string, serverId: string): Promise<void> {
    await this.imageGrantsRepo.delete({ scope: 'user', scopeId: userId, imageId, serverId });
    this.accessResolver.invalidateUser(userId);
  }

  // ---------------------------------------------------------------------------
  // Ensure system groups exist
  // ---------------------------------------------------------------------------

  async ensureSystemGroups(): Promise<{
    admins: GroupEntity;
    operators: GroupEntity;
    users: GroupEntity;
  }> {
    const admins = await this.ensureSystemGroup('Administrators', 1000, Object.values(Capability));
    const operators = await this.ensureSystemGroup('Operators', 500, [
      Capability.ManageServers,
      Capability.ManageImages,
      Capability.ManageGrants,
      Capability.ManageContainersAny,
      Capability.ViewAudit,
      Capability.ViewMetricsAll,
      Capability.ManageSystemSettings,
    ]);
    const users = await this.ensureSystemGroup('Users', 10, []);
    return { admins, operators, users };
  }

  private async ensureSystemGroup(
    name: string,
    priority: number,
    caps: Capability[],
  ): Promise<GroupEntity> {
    let group = await this.groupsRepo.findOne({ where: { name } });
    if (!group) {
      group = this.groupsRepo.create({ id: uuidv4(), name, priority, isSystem: true, description: null });
      group.capabilities = caps;
      await this.groupsRepo.save(group);
    } else {
      const current = new Set(group.capabilities);
      let changed = false;
      for (const cap of caps) {
        if (!current.has(cap)) {
          current.add(cap);
          changed = true;
        }
      }
      if (group.priority !== priority) {
        group.priority = priority;
        changed = true;
      }
      if (!group.isSystem) {
        group.isSystem = true;
        changed = true;
      }
      if (changed) {
        group.capabilities = Array.from(current);
        await this.groupsRepo.save(group);
        const members = await this.membersRepo.find({ where: { groupId: group.id } });
        for (const member of members) this.accessResolver.invalidateUser(member.userId);
      }
    }
    return group;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async invalidateGroupMembers(groupId: string): Promise<GroupMemberEntity[]> {
    const members = await this.membersRepo.find({ where: { groupId } });
    for (const m of members) this.accessResolver.invalidateUser(m.userId);
    return members;
  }

  private async syncUserQuota(
    userId: string,
    serverId: string,
    requestedBy: string | null,
  ): Promise<void> {
    const grant = await this.accessResolver.resolveServer(userId, serverId);
    if (!grant) return;
    const user = await this.usersRepo.findOne({ where: { id: userId }, select: ['id', 'numericId'] });
    if (!user?.numericId) return;
    try {
      await this.quotaDispatchService.apply({
        serverId,
        userId,
        numericUserId: user.numericId,
        diskBytes: grant.diskBytes,
        requestedBy,
      });
    } catch {
      // Quota reconciliation is durable; failures are visible on the reconcile task/operation.
    }
  }

  private applyGrantDto(
    grant: ServerGrantEntity,
    dto: Partial<{
      cpuMillis: number | null;
      memBytes: number | null;
      diskBytes: number | null;
      gpuMode: GpuGrantMode | null;
      gpuIndices: number[] | null;
    }>,
  ) {
    if ('cpuMillis' in dto) grant.cpuMillis = dto.cpuMillis ?? null;
    if ('memBytes' in dto) grant.memBytes = dto.memBytes ?? null;
    if ('diskBytes' in dto) grant.diskBytes = dto.diskBytes ?? null;
    if ('gpuMode' in dto) grant.gpuMode = dto.gpuMode ?? null;
    if ('gpuIndices' in dto) grant.gpuIndices = dto.gpuIndices ?? null;
  }

  toDto(g: GroupEntity): GroupDto {
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      priority: g.priority,
      isSystem: g.isSystem,
      capabilities: g.capabilities,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    };
  }

  toSummaryDto(g: GroupEntity): GroupSummaryDto {
    return { id: g.id, name: g.name, priority: g.priority, isSystem: g.isSystem };
  }

  serverGrantToDto(g: ServerGrantEntity): ServerGrantDto {
    return {
      id: g.id,
      scope: g.scope,
      scopeId: g.scopeId,
      serverId: g.serverId,
      cpuMillis: g.cpuMillis,
      memBytes: g.memBytes,
      diskBytes: g.diskBytes,
      gpuMode: g.gpuMode,
      gpuIndices: g.gpuIndices,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    };
  }

  imageGrantToDto(g: ImageGrantEntity): ImageGrantDto {
    return {
      id: g.id,
      scope: g.scope,
      scopeId: g.scopeId,
      imageId: g.imageId,
      serverId: g.serverId,
      createdAt: g.createdAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Mount source grants (group scope)
  // ---------------------------------------------------------------------------

  async listGroupMountSourceGrants(groupId: string): Promise<MountSourceGrantDto[]> {
    const grants = await this.mountSourceGrantsRepo.find({ where: { scope: 'group', scopeId: groupId } });
    return grants.map((g) => this.mountSourceGrantToDto(g));
  }

  async upsertGroupMountSourceGrant(
    actorId: string,
    groupId: string,
    sourceKind: MountSourceKind,
    sourceId: string,
  ): Promise<MountSourceGrantDto> {
    await this.findById(groupId);
    await this.assertSourceExists(sourceKind, sourceId);

    let grant = await this.mountSourceGrantsRepo.findOne({
      where: { scope: 'group', scopeId: groupId, sourceKind, sourceId },
    });
    if (!grant) {
      grant = this.mountSourceGrantsRepo.create({ id: uuidv4(), scope: 'group', scopeId: groupId, sourceKind, sourceId });
      await this.mountSourceGrantsRepo.save(grant);
      await this.auditService.log(actorId, AuditAction.UpsertMountSourceGrant, grant.id, 'mount_source', { groupId, sourceKind, sourceId });
    }
    await this.invalidateGroupMembers(groupId);
    return this.mountSourceGrantToDto(grant);
  }

  async deleteGroupMountSourceGrant(
    actorId: string,
    groupId: string,
    sourceKind: MountSourceKind,
    sourceId: string,
  ): Promise<void> {
    await this.mountSourceGrantsRepo.delete({ scope: 'group', scopeId: groupId, sourceKind, sourceId });
    await this.invalidateGroupMembers(groupId);
    await this.auditService.log(actorId, AuditAction.DeleteMountSourceGrant, sourceId, 'mount_source', { groupId, sourceKind });
  }

  // ---------------------------------------------------------------------------
  // Mount source grants (user scope)
  // ---------------------------------------------------------------------------

  async listUserMountSourceGrants(userId: string): Promise<MountSourceGrantDto[]> {
    const grants = await this.mountSourceGrantsRepo.find({ where: { scope: 'user', scopeId: userId } });
    return grants.map((g) => this.mountSourceGrantToDto(g));
  }

  async upsertUserMountSourceGrant(
    actorId: string,
    userId: string,
    sourceKind: MountSourceKind,
    sourceId: string,
  ): Promise<MountSourceGrantDto> {
    await this.assertSourceExists(sourceKind, sourceId);

    let grant = await this.mountSourceGrantsRepo.findOne({
      where: { scope: 'user', scopeId: userId, sourceKind, sourceId },
    });
    if (!grant) {
      grant = this.mountSourceGrantsRepo.create({ id: uuidv4(), scope: 'user', scopeId: userId, sourceKind, sourceId });
      await this.mountSourceGrantsRepo.save(grant);
      await this.auditService.log(actorId, AuditAction.UpsertMountSourceGrant, grant.id, 'mount_source', { userId, sourceKind, sourceId });
    }
    this.accessResolver.invalidateUser(userId);
    return this.mountSourceGrantToDto(grant);
  }

  async deleteUserMountSourceGrant(
    actorId: string,
    userId: string,
    sourceKind: MountSourceKind,
    sourceId: string,
  ): Promise<void> {
    await this.mountSourceGrantsRepo.delete({ scope: 'user', scopeId: userId, sourceKind, sourceId });
    this.accessResolver.invalidateUser(userId);
    await this.auditService.log(actorId, AuditAction.DeleteMountSourceGrant, sourceId, 'mount_source', { userId, sourceKind });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private mountSourceGrantToDto(g: MountSourceGrantEntity): MountSourceGrantDto {
    return {
      id: g.id,
      scope: g.scope,
      scopeId: g.scopeId,
      sourceKind: g.sourceKind,
      sourceId: g.sourceId,
      createdAt: g.createdAt.toISOString(),
    };
  }

  private async assertSourceExists(sourceKind: MountSourceKind, sourceId: string): Promise<void> {
    if (sourceKind === 'local') {
      const disk = await this.dataDisksRepo.findOne({ where: { id: sourceId } });
      if (!disk) throw new NotFoundException(`Data disk ${sourceId} not found`);
    } else {
      const mount = await this.remoteFsMountsRepo.findOne({ where: { id: sourceId } });
      if (!mount) throw new NotFoundException(`Remote FS mount ${sourceId} not found`);
    }
  }
}
