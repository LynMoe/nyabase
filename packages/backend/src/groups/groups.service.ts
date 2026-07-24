import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { QuotaDispatchService } from '../quota/quota-dispatch.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import {
  MountSourcesService,
  type MountSourceGrantTarget,
} from '../mount-sources/mount-sources.service.js';
import { AccessRevocationGuardService } from '../access/access-revocation-guard.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import {
  AgentTaskKind,
  AgentTaskStatus,
  Capability,
  GpuGrantMode,
  AuditAction,
  GroupDto,
  GroupMemberDto,
  GroupSummaryDto,
  ServerGrantDto,
  ImageGrantDto,
  MountSourceGrantDto,
  MAX_PLATFORM_SERVERS,
  UserStatus,
  SystemGroupKey,
} from '@nyabase/common';
import { AuthService } from '../auth/auth.service.js';

type TaskIdsResult = { taskIds: string[] };
type WithTaskIds<T> = T & TaskIdsResult;
export type UserDeleteResult = { deleted: boolean; taskIds: string[] };

function advanceGroupRevision(group: GroupEntity): void {
  if (!Number.isSafeInteger(group.revision) || group.revision < 1
    || group.revision === Number.MAX_SAFE_INTEGER) {
    throw new ConflictException({
      code: 'GROUP_REVISION_EXHAUSTED',
      message: 'Group revision cannot be advanced safely',
    });
  }
  group.revision += 1;
}

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
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    private accessResolver: AccessResolverService,
    private auditService: AuditService,
    private quotaDispatchService: QuotaDispatchService,
    private dataSource: DataSource,
    private mountSources: MountSourcesService,
    private revocationGuard: AccessRevocationGuardService,
    private proxySnapshots: ProxySnapshotNotifierService,
    @Inject(forwardRef(() => AuthService))
    private authService: AuthService,
  ) {}

  // ---------------------------------------------------------------------------
  // Group CRUD
  // ---------------------------------------------------------------------------

  async findAll(): Promise<GroupDto[]> {
    const [groups, allMembers] = await Promise.all([
      this.groupsRepo.find({ order: { priority: 'DESC', name: 'ASC' } }),
      this.membersRepo.find(),
    ]);

    const allUserIds = [...new Set(allMembers.map((m) => m.userId))];
    const allUsers = allUserIds.length > 0
      ? await this.usersRepo.find({ where: { id: In(allUserIds) } })
      : [];
    const usersMap = new Map(allUsers.map((u) => [u.id, u]));

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
      const members = membersByGroup.get(g.id) ?? [];
      return {
        ...this.toDto(g),
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
    const group = await runSerializedTransaction(this.dataSource, async (manager) => {
      this.assertOrdinaryGroupName(dto.name);
      if (await manager.findOne(GroupEntity, { where: { name: dto.name } })) {
        throw new ConflictException('Group name already exists');
      }
      if (actorId) {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          manager,
          actorId,
          [Capability.ManageGroups, ...(dto.capabilities ?? [])],
        );
      }
      const created = manager.create(GroupEntity, {
        id: uuidv4(),
        name: dto.name,
        description: dto.description ?? null,
        priority: dto.priority ?? 0,
        isSystem: false,
        systemKey: null,
        revision: 1,
      });
      created.capabilities = dto.capabilities ?? [];
      return manager.save(GroupEntity, created);
    });
    await this.auditBestEffort(
      actorId ?? null, AuditAction.CreateGroup, group.id, 'group', { name: group.name },
    );
    return this.toDto(group);
  }

  async update(
    id: string,
    dto: { name?: string; description?: string | null; priority?: number; capabilities?: Capability[] },
    actorId: string | undefined,
    expectedRevision: number,
  ): Promise<WithTaskIds<GroupDto>> {
    const { group, members, taskIds } = await runSerializedTransaction(this.dataSource, async (manager) => {
      const current = await manager.findOne(GroupEntity, { where: { id } });
      if (!current) throw new NotFoundException('Group not found');
      const desiredCapabilities = dto.capabilities ?? current.capabilities;
      if (actorId) {
        await this.assertActorMayMutateGroupInTransaction(
          manager,
          actorId,
          current,
          desiredCapabilities,
          dto.priority !== undefined && dto.priority !== current.priority,
        );
      }
      if (current.revision !== expectedRevision) {
        throw new ConflictException({
          code: 'GROUP_REVISION_CONFLICT',
          message: 'Group changed; reload and resolve the conflicting fields',
          current: this.toDto(current),
        });
      }
      if (current.systemKey !== null || current.isSystem) {
        if (
          (dto.name !== undefined && dto.name !== current.name)
          || (dto.priority !== undefined && dto.priority !== current.priority)
          || (dto.capabilities !== undefined
            && !this.sameCapabilities(dto.capabilities, current.capabilities))
        ) {
          throw new ForbiddenException({
            code: 'SYSTEM_GROUP_METADATA_IMMUTABLE',
            message: 'Built-in group name, priority, and capabilities are immutable',
          });
        }
      }
      if (dto.name !== undefined) {
        if (current.systemKey === null && !current.isSystem) this.assertOrdinaryGroupName(dto.name);
        const existing = await manager.findOne(GroupEntity, { where: { name: dto.name } });
        if (existing && existing.id !== id) throw new ConflictException('Group name already exists');
        current.name = dto.name;
      }
      if (dto.description !== undefined) current.description = dto.description ?? null;
      const priorityChanged = dto.priority !== undefined && dto.priority !== current.priority;
      const capabilitiesChanged = dto.capabilities !== undefined
        && !this.sameCapabilities(dto.capabilities, current.capabilities);
      if (dto.priority !== undefined) current.priority = dto.priority;
      if (dto.capabilities !== undefined) current.capabilities = dto.capabilities;
      advanceGroupRevision(current);
      const saved = await manager.save(GroupEntity, current);
      const affected = await manager.find(GroupMemberEntity, { where: { groupId: id } });
      if (capabilitiesChanged) {
        await this.bumpAuthVersionsInTransaction(
          manager,
          affected.map((member) => member.userId),
        );
      }
      const taskIds: string[] = [];
      if (priorityChanged && affected.length > 0) {
        const grants = await manager.find(ServerGrantEntity, {
          where: { scope: 'group', scopeId: id },
          select: { serverId: true },
        });
        for (const member of affected) {
          for (const grant of grants) {
            const taskId = await this.syncUserQuotaInTransaction(
              manager, member.userId, grant.serverId, actorId ?? null,
            );
            if (taskId) taskIds.push(taskId);
          }
        }
      }
      return { group: saved, members: affected, taskIds };
    });
    for (const m of members) this.accessResolver.invalidateUser(m.userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.UpdateGroup, id, 'group', dto);

    return this.withTaskIds(this.toDto(group), taskIds);
  }

  async delete(id: string, actorId?: string): Promise<TaskIdsResult> {
    const { group, members, taskIds } = await runSerializedTransaction(this.dataSource, async (manager) => {
      const current = await manager.findOne(GroupEntity, { where: { id } });
      if (!current) throw new NotFoundException('Group not found');
      if (current.isSystem || current.systemKey !== null) {
        throw new ForbiddenException('Cannot delete system group');
      }
      if (actorId) {
        await this.assertActorMayMutateGroupInTransaction(
          manager,
          actorId,
          current,
          current.capabilities,
          true,
        );
      }
      const [affected, grants] = await Promise.all([
        manager.find(GroupMemberEntity, { where: { groupId: id } }),
        manager.find(ServerGrantEntity, {
          where: { scope: 'group', scopeId: id }, select: { serverId: true },
        }),
      ]);
      await this.mountSources.deleteScopeInTransaction(manager, 'group', id);
      await manager.delete(GroupMemberEntity, { groupId: id });
      await manager.delete(ServerGrantEntity, { scope: 'group', scopeId: id });
      await manager.delete(ImageGrantEntity, { scope: 'group', scopeId: id });
      await manager.remove(GroupEntity, current);
      await this.bumpAuthVersionsInTransaction(
        manager,
        affected.map((member) => member.userId),
      );
      await this.revocationGuard.assertServerAccessRevocationSafe(
        manager,
        affected.flatMap((member) => grants.map((grant) => ({
          userId: member.userId,
          serverId: grant.serverId,
        }))),
      );
      const taskIds: string[] = [];
      for (const member of affected) {
        for (const grant of grants) {
          const taskId = await this.syncUserQuotaInTransaction(
            manager, member.userId, grant.serverId, actorId ?? null,
          );
          if (taskId) taskIds.push(taskId);
        }
      }
      return { group: current, members: affected, taskIds };
    });
    for (const m of members) this.accessResolver.invalidateUser(m.userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.DeleteGroup, id, 'group', { name: group.name });
    return { taskIds: this.uniqueTaskIds(taskIds) };
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

  async hasActiveSystemGroupMember(groupId: string, excludedUserId?: string): Promise<boolean> {
    const memberships = await this.membersRepo.find({ where: { groupId } });
    const userIds = memberships
      .map((membership) => membership.userId)
      .filter((userId) => userId !== excludedUserId);
    if (userIds.length === 0) return false;
    return await this.usersRepo.count({
      where: { id: In(userIds), status: UserStatus.Active },
    }) > 0;
  }

  async addMember(groupId: string, userId: string, actorId?: string): Promise<TaskIdsResult> {
    const changed = await runSerializedTransaction(this.dataSource, async (manager) => {
      const group = await manager.findOne(GroupEntity, { where: { id: groupId } });
      if (!group) {
        throw new NotFoundException('Group not found');
      }
      if (actorId) {
        await this.assertActorMayMutateGroupInTransaction(
          manager,
          actorId,
          group,
          group.capabilities,
          true,
        );
      }
      await this.requireUserInTransaction(manager, userId);
      const existing = await manager.findOne(GroupMemberEntity, { where: { groupId, userId } });
      if (existing) return { changed: false, taskIds: [] as string[] };
      await manager.save(GroupMemberEntity, manager.create(GroupMemberEntity, {
        id: uuidv4(), groupId, userId,
      }));
      await this.bumpAuthVersionsInTransaction(manager, [userId]);
      const groupGrants = await manager.find(ServerGrantEntity, {
        where: { scope: 'group', scopeId: groupId },
        select: { serverId: true },
      });
      const taskIds: string[] = [];
      for (const grant of groupGrants) {
        const taskId = await this.syncUserQuotaInTransaction(
          manager, userId, grant.serverId, actorId ?? null,
        );
        if (taskId) taskIds.push(taskId);
      }
      return { changed: true, taskIds };
    });
    if (!changed.changed) return { taskIds: [] };
    this.accessResolver.invalidateUser(userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.AddGroupMember, groupId, 'group', { userId });
    return { taskIds: this.uniqueTaskIds(changed.taskIds) };
  }

  async removeMember(groupId: string, userId: string, actorId?: string): Promise<TaskIdsResult> {
    const result = await runSerializedTransaction(this.dataSource, async (manager) => {
      const group = await manager.findOneBy(GroupEntity, { id: groupId });
      if (!group) throw new NotFoundException('Group not found');
      if (actorId) {
        await this.assertActorMayMutateGroupInTransaction(
          manager,
          actorId,
          group,
          group.capabilities,
          true,
        );
      }
      if (!await manager.existsBy(UserEntity, { id: userId })) {
        throw new NotFoundException('User not found');
      }
      const membership = await manager.findOneBy(GroupMemberEntity, { groupId, userId });
      if (!membership) return { changed: false, taskIds: [] as string[] };
      if (group.systemKey === SystemGroupKey.Administrators) {
        const member = await manager.findOneBy(UserEntity, { id: userId });
        if (member?.status === UserStatus.Active) {
          await this.accessResolver.assertNotFinalActiveAdministratorInTransaction(manager, userId);
        }
      }
      const [groupGrants, mountGrants] = await Promise.all([
        manager.find(ServerGrantEntity, {
          where: { scope: 'group', scopeId: groupId },
          select: { serverId: true },
        }),
        manager.find(MountSourceGrantEntity, {
          where: { scope: 'group', scopeId: groupId },
        }),
      ]);
      await manager.delete(GroupMemberEntity, { groupId, userId });
      await this.bumpAuthVersionsInTransaction(manager, [userId]);
      await this.revocationGuard.assertServerAccessRevocationSafe(
        manager,
        groupGrants.map((grant) => ({ userId, serverId: grant.serverId })),
      );
      for (const grant of mountGrants) {
        await this.revocationGuard.assertMountSourceRevocationSafe(manager, [userId], {
          sourceKind: grant.sourceKind,
          sourceId: grant.sourceId,
          serverId: grant.serverId,
          sourceIdentity: grant.sourceIdentity,
        });
      }
      const taskIds: string[] = [];
      for (const grant of groupGrants) {
        const taskId = await this.syncUserQuotaInTransaction(
          manager, userId, grant.serverId, actorId ?? null,
        );
        if (taskId) taskIds.push(taskId);
      }
      return { changed: true, taskIds };
    });
    if (!result.changed) return { taskIds: [] };
    this.accessResolver.invalidateUser(userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.RemoveGroupMember, groupId, 'group', { userId });
    return { taskIds: this.uniqueTaskIds(result.taskIds) };
  }

  async ensureUserInSystemGroup(systemKey: SystemGroupKey, userId: string): Promise<void> {
    const group = await this.groupsRepo.findOne({ where: { systemKey } });
    if (!group || !group.isSystem) {
      throw new ConflictException({
        code: 'SYSTEM_GROUP_MISSING',
        message: `Required built-in group is unavailable: ${systemKey}`,
      });
    }
    await this.addMember(group.id, userId);
  }

  async ensureUserNotInSystemGroup(systemKey: SystemGroupKey, userId: string): Promise<void> {
    const group = await this.groupsRepo.findOne({ where: { systemKey, isSystem: true } });
    if (!group) return;
    await this.removeMember(group.id, userId);
  }

  /**
   * Revoke access and durably drain every known physical quota to zero. The
   * final successful quota task tombstones the user automatically.
   */
  async deleteUserPermanently(userId: string, actorId: string): Promise<UserDeleteResult> {
    const result = await runSerializedTransaction(this.dataSource, async (manager) => {
      const user = await manager.findOneBy(UserEntity, { id: userId });
      if (!user || user.status === UserStatus.Deleted) throw new NotFoundException('User not found');
      await this.accessResolver.assertActorMayAdministerUserInTransaction(
        manager,
        actorId,
        userId,
      );
      if (user.status === UserStatus.Deleting) {
        await this.deleteUserCredentialsInTransaction(manager, userId);
      }
      if (user.status === UserStatus.Active) {
        await this.accessResolver.assertNotFinalActiveAdministratorInTransaction(manager, userId);
      }
      const [container, dataDir] = await Promise.all([
        manager.findOneBy(ContainerEntity, { ownerId: userId }),
        manager.findOneBy(DataDirectoryEntity, { userId }),
      ]);
      if (container || dataDir) {
        throw new ConflictException({
          code: 'USER_DELETE_HAS_RESOURCES',
          message: 'Delete every container and data directory before deleting the user',
          userId,
        });
      }

      const desiredQuotas = await manager.find(QuotaDesiredEntity, {
        where: { userId },
        order: { serverId: 'ASC' },
      });

      const pendingQuotaTasks = await manager.find(AgentTaskEntity, {
        select: {
          id: true,
          kind: true,
          serverId: true,
          resourceType: true,
          resourceId: true,
          payloadJson: true,
          startedAt: true,
          lastSentAt: true,
          agentResultJson: true,
        },
        where: {
          kind: AgentTaskKind.QuotaEnsure,
          resourceType: 'quota',
          resourceId: userId,
          status: AgentTaskStatus.Pending,
        },
        order: { id: 'ASC' },
        take: MAX_PLATFORM_SERVERS + 1,
      });
      if (pendingQuotaTasks.length > MAX_PLATFORM_SERVERS) {
        throw new ConflictException({
          code: 'USER_DELETE_QUOTA_AUTHORITY_CORRUPT',
          message: 'User quota has more pending task owners than the platform Server bound',
          userId,
        });
      }
      const desiredByServer = new Map(desiredQuotas.map((desired) => [desired.serverId, desired]));
      const exactDeletingTasks = pendingQuotaTasks.filter((task) => {
        const desired = desiredByServer.get(task.serverId);
        return desired !== undefined && this.quotaTaskMatchesDesired(task, desired, 0);
      });

      const quotaLocks = await manager.createQueryBuilder(ResourceLockEntity, 'lock')
        .where('lock.resource_key LIKE :resourceKey', { resourceKey: `quota:%:${userId}` })
        .getMany();

      if (user.status === UserStatus.Deleting) {
        const exactTaskIds = new Set(exactDeletingTasks.map((task) => task.id));
        const invalidPending = pendingQuotaTasks.find((task) => !exactTaskIds.has(task.id));
        const invalidLock = quotaLocks.find((lock) => !exactTaskIds.has(lock.taskId));
        if (invalidPending || invalidLock) {
          throw new ConflictException({
            code: 'USER_DELETE_QUOTA_BLOCKED',
            message: 'User deletion is blocked by quota evidence that is not its exact zero-limit task',
            userId,
            taskId: invalidPending?.id ?? invalidLock?.taskId,
          });
        }
        if (exactDeletingTasks.length > 0) {
          return { deleted: false, taskIds: this.uniqueTaskIds(exactDeletingTasks.map((task) => task.id)) };
        }
        const lastTaskIds = desiredQuotas
          .map((desired) => desired.lastTaskId)
          .filter((id): id is string => id !== null);
        const proofs = lastTaskIds.length === 0
          ? []
          : await manager.find(AgentTaskEntity, {
              select: {
                id: true,
                status: true,
                kind: true,
                serverId: true,
                resourceType: true,
                resourceId: true,
                payloadJson: true,
              },
              where: { id: In(lastTaskIds) },
            });
        const proofById = new Map(proofs.map((task) => [task.id, task]));
        const converged = desiredQuotas.every((desired) => {
          const proof = desired.lastTaskId ? proofById.get(desired.lastTaskId) : undefined;
          return proof?.status === AgentTaskStatus.Succeeded
            && this.quotaTaskMatchesDesired(proof, desired, 0);
        });
        if (!converged) {
          throw new ConflictException({
            code: 'USER_DELETE_QUOTA_BLOCKED',
            message: 'User deletion has no pending task and lacks exact successful zero-quota evidence',
            userId,
          });
        }
        await this.deleteUserCredentialsInTransaction(manager, userId);
        await manager.delete(QuotaDesiredEntity, { userId });
        await manager.update(UserEntity, userId, { status: UserStatus.Deleted });
        return { deleted: true, taskIds: [] };
      }

      const physicallyAmbiguousTask = pendingQuotaTasks.find((task) =>
        task.startedAt !== null
        || task.lastSentAt !== null
        || task.agentResultJson !== null);
      if (physicallyAmbiguousTask) {
        throw new ConflictException({
          code: 'USER_DELETE_QUOTA_IN_PROGRESS',
          message: 'Wait for the dispatched quota task to reach a terminal state before deleting the user',
          userId,
          taskId: physicallyAmbiguousTask.id,
        });
      }

      const undispatchedTaskIds = pendingQuotaTasks.map((task) => task.id);
      const undispatchedTaskIdSet = new Set(undispatchedTaskIds);
      const physicallyAmbiguousLock = quotaLocks.find((lock) =>
        !undispatchedTaskIdSet.has(lock.taskId));
      if (physicallyAmbiguousLock) {
        throw new ConflictException({
          code: 'USER_DELETE_QUOTA_IN_PROGRESS',
          message: 'Wait for every task holding the user quota lock to reach a safe terminal state',
          userId,
          taskId: physicallyAmbiguousLock.taskId,
        });
      }
      if (undispatchedTaskIds.length > 0) {
        await manager.update(AgentTaskEntity, { id: In(undispatchedTaskIds) }, {
          status: AgentTaskStatus.Failed,
          failureStage: null,
          errorJson: {
            code: 'TASK_SUPERSEDED',
            message: 'User deletion superseded the undispatched quota intent',
          },
          lastSentAt: null,
          nextDispatchAt: null,
          completedAt: new Date(),
        } as never);
        await manager.delete(ResourceLockEntity, { taskId: In(undispatchedTaskIds) });
      }

      const lastTaskIds = desiredQuotas
        .map((desired) => desired.lastTaskId)
        .filter((id): id is string => id !== null);
      const proofs = lastTaskIds.length === 0
        ? []
        : await manager.find(AgentTaskEntity, {
            select: {
              id: true,
              status: true,
              kind: true,
              serverId: true,
              resourceType: true,
              resourceId: true,
              payloadJson: true,
            },
            where: { id: In(lastTaskIds) },
          });
      const proofById = new Map(proofs.map((task) => [task.id, task]));
      const taskIds: string[] = [];
      for (const desired of desiredQuotas) {
        const proof = desired.lastTaskId ? proofById.get(desired.lastTaskId) : undefined;
        if (
          proof?.status === AgentTaskStatus.Succeeded
          && this.quotaTaskMatchesDesired(proof, desired, 0)
        ) continue;
        taskIds.push(await this.quotaDispatchService.applyInTransaction(manager, {
          serverId: desired.serverId,
          userId,
          numericUserId: user.numericId,
          diskBytes: 0,
          requestedBy: actorId,
          allowDeleting: true,
        }));
      }

      await manager.update(UserEntity, userId, {
        status: taskIds.length > 0 ? UserStatus.Deleting : UserStatus.Deleted,
        authVersion: user.authVersion + 1,
      });
      await this.deleteUserCredentialsInTransaction(manager, userId);
      await manager.delete(GroupMemberEntity, { userId });
      await manager.delete(ServerGrantEntity, { scope: 'user', scopeId: userId });
      await manager.delete(ImageGrantEntity, { scope: 'user', scopeId: userId });
      await this.mountSources.deleteScopeInTransaction(
        manager,
        'user',
        userId,
        { bypassResourceGuard: true },
      );
      if (taskIds.length === 0) await manager.delete(QuotaDesiredEntity, { userId });
      return { deleted: taskIds.length === 0, taskIds: this.uniqueTaskIds(taskIds) };
    });
    this.accessResolver.invalidateUser(userId);
    await this.proxySnapshots.notify('user-deleted');
    await this.auditBestEffort(
      actorId,
      AuditAction.DeleteUser,
      userId,
      'user',
      {
        status: result.deleted ? UserStatus.Deleted : UserStatus.Deleting,
        grantsRemoved: true,
        quotaDrainTaskIds: result.taskIds,
      },
    );
    return result;
  }

  private async deleteUserCredentialsInTransaction(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await this.authService.deleteUserCredentialsInTransaction(manager, userId);
    await manager.delete(SshPublicKeyEntity, { userId });
    await manager.delete(UserInternalSshKeyEntity, { userId });
  }

  // ---------------------------------------------------------------------------
  // Server grants (group scope)
  // ---------------------------------------------------------------------------

  async listGroupServerGrants(groupId: string): Promise<ServerGrantDto[]> {
    await this.findById(groupId);
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
  ): Promise<WithTaskIds<ServerGrantDto>> {
    const { grant, members, taskIds } = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId) await this.requireGrantActorInTransaction(manager, actorId);
      if (!await manager.findOne(GroupEntity, { where: { id: groupId } })) {
        throw new NotFoundException('Group not found');
      }
      await this.requireServerInTransaction(manager, serverId);
      let current = await manager.findOne(ServerGrantEntity, {
        where: { scope: 'group', scopeId: groupId, serverId },
      });
      if (!current) {
        current = manager.create(ServerGrantEntity, {
          id: uuidv4(), scope: 'group', scopeId: groupId, serverId, gpuMode: null,
        });
      }
      this.applyGrantDto(current, dto);
      const saved = await manager.save(ServerGrantEntity, current);
      const affected = await manager.find(GroupMemberEntity, { where: { groupId } });
      const taskIds: string[] = [];
      for (const member of affected) {
        const taskId = await this.syncUserQuotaInTransaction(
          manager, member.userId, serverId, actorId ?? null,
        );
        if (taskId) taskIds.push(taskId);
      }
      return { grant: saved, members: affected, taskIds };
    });
    for (const member of members) this.accessResolver.invalidateUser(member.userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.UpsertServerGrant, groupId, 'group', { serverId, ...dto });
    return this.withTaskIds(this.serverGrantToDto(grant), taskIds);
  }

  async deleteGroupServerGrant(groupId: string, serverId: string, actorId?: string): Promise<TaskIdsResult> {
    const { changed, members, taskIds } = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId) await this.requireGrantActorInTransaction(manager, actorId);
      await this.requireGroupInTransaction(manager, groupId);
      await this.requireServerInTransaction(manager, serverId);
      const existing = await manager.findOneBy(ServerGrantEntity, {
        scope: 'group', scopeId: groupId, serverId,
      });
      if (!existing) return {
        changed: false,
        members: [] as GroupMemberEntity[],
        taskIds: [] as string[],
      };
      const affected = await manager.find(GroupMemberEntity, { where: { groupId } });
      await manager.delete(ServerGrantEntity, { scope: 'group', scopeId: groupId, serverId });
      await this.revocationGuard.assertServerAccessRevocationSafe(
        manager,
        affected.map((member) => ({ userId: member.userId, serverId })),
      );
      const taskIds: string[] = [];
      for (const member of affected) {
        const taskId = await this.syncUserQuotaInTransaction(
          manager, member.userId, serverId, actorId ?? null,
        );
        if (taskId) taskIds.push(taskId);
      }
      return { changed: true, members: affected, taskIds };
    });
    if (!changed) return { taskIds: [] };
    for (const member of members) this.accessResolver.invalidateUser(member.userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.DeleteServerGrant, groupId, 'group', { serverId });
    return { taskIds: this.uniqueTaskIds(taskIds) };
  }

  // ---------------------------------------------------------------------------
  // Image grants (group scope)
  // ---------------------------------------------------------------------------

  async listGroupImageGrants(groupId: string): Promise<ImageGrantDto[]> {
    await this.findById(groupId);
    const grants = await this.imageGrantsRepo.find({
      where: { scope: 'group', scopeId: groupId },
    });
    return grants.map((g) => this.imageGrantToDto(g));
  }

  async addGroupImageGrant(
    groupId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<ImageGrantDto> {
    const grant = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId) await this.requireGrantActorInTransaction(manager, actorId);
      await this.requireGroupInTransaction(manager, groupId);
      await this.requireImageInTransaction(manager, imageId);
      await this.requireServerInTransaction(manager, serverId);
      let current = await manager.findOne(ImageGrantEntity, {
        where: { scope: 'group', scopeId: groupId, imageId, serverId },
      });
      if (!current) {
        current = manager.create(ImageGrantEntity, {
          id: uuidv4(), scope: 'group', scopeId: groupId, imageId, serverId,
        });
        current = await manager.save(ImageGrantEntity, current);
      }
      return current;
    });
    await this.invalidateGroupMembers(groupId);
    await this.auditBestEffort(actorId ?? null, AuditAction.UpsertImageGrant, groupId, 'group', {
      imageId,
      serverId,
    });
    return this.imageGrantToDto(grant);
  }

  async deleteGroupImageGrant(
    groupId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<void> {
    const changed = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId) await this.requireGrantActorInTransaction(manager, actorId);
      await this.requireGroupInTransaction(manager, groupId);
      await this.requireImageInTransaction(manager, imageId);
      await this.requireServerInTransaction(manager, serverId);
      const deleted = await manager.delete(ImageGrantEntity, {
        scope: 'group', scopeId: groupId, imageId, serverId,
      });
      return deleted.affected === 1;
    });
    if (!changed) return;
    await this.invalidateGroupMembers(groupId);
    await this.auditBestEffort(actorId ?? null, AuditAction.DeleteImageGrant, groupId, 'group', {
      imageId,
      serverId,
    });
  }

  /** Sync image grants for a group on specific servers (replace all for those servers) */
  async syncGroupImageGrantsForServers(
    groupId: string,
    imageId: string,
    serverIds: string[],
    actorId?: string,
  ): Promise<ImageGrantDto[]> {
    const updated = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId) await this.requireGrantActorInTransaction(manager, actorId);
      await this.requireGroupInTransaction(manager, groupId);
      await this.requireImageInTransaction(manager, imageId);
      const targetServerIds = [...new Set(serverIds)];
      if (targetServerIds.length > 0) {
        const servers = await manager.find(ServerEntity, {
          where: { id: In(targetServerIds) },
          select: { id: true },
        });
        const found = new Set(servers.map((server) => server.id));
        const missing = targetServerIds.filter((serverId) => !found.has(serverId));
        if (missing.length > 0) throw new NotFoundException(`Server not found: ${missing.join(', ')}`);
      }
      const existing = await manager.find(ImageGrantEntity, {
        where: { scope: 'group', scopeId: groupId, imageId },
      });
      const existingServerIds = new Set(existing.map((grant) => grant.serverId));
      const target = new Set(targetServerIds);
      const toRemove = existing.filter((grant) => !target.has(grant.serverId));
      const toAdd = targetServerIds
        .filter((serverId) => !existingServerIds.has(serverId))
        .map((serverId) => manager.create(ImageGrantEntity, {
          id: uuidv4(), scope: 'group', scopeId: groupId, imageId, serverId,
        }));
      if (toRemove.length > 0) await manager.remove(ImageGrantEntity, toRemove);
      if (toAdd.length > 0) await manager.save(ImageGrantEntity, toAdd);
      return manager.find(ImageGrantEntity, {
        where: { scope: 'group', scopeId: groupId, imageId },
      });
    });
    await this.invalidateGroupMembers(groupId);
    await this.auditBestEffort(actorId ?? null, AuditAction.UpsertImageGrant, groupId, 'group', {
      imageId,
      serverIds: [...new Set(serverIds)],
      mode: 'replace_servers',
    });
    return updated.map((g) => this.imageGrantToDto(g));
  }

  // ---------------------------------------------------------------------------
  // Server grants (user scope)
  // ---------------------------------------------------------------------------

  async listUserServerGrants(userId: string): Promise<ServerGrantDto[]> {
    await this.requireUserScope(userId);
    const grants = await this.serverGrantsRepo.find({ where: { scope: 'user', scopeId: userId } });
    return grants.map((g) => this.serverGrantToDto(g));
  }

  async assertUserScopeExists(userId: string): Promise<void> {
    await this.requireUserScope(userId);
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
  ): Promise<WithTaskIds<ServerGrantDto>> {
    const { grant, taskId } = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId) await this.requireGrantActorInTransaction(manager, actorId);
      await this.requireUserInTransaction(manager, userId);
      await this.requireServerInTransaction(manager, serverId);
      let current = await manager.findOne(ServerGrantEntity, {
        where: { scope: 'user', scopeId: userId, serverId },
      });
      if (!current) {
        current = manager.create(ServerGrantEntity, {
          id: uuidv4(), scope: 'user', scopeId: userId, serverId, gpuMode: null,
        });
      }
      this.applyGrantDto(current, dto);
      const saved = await manager.save(ServerGrantEntity, current);
      const taskId = await this.syncUserQuotaInTransaction(
        manager, userId, serverId, actorId ?? null,
      );
      return { grant: saved, taskId };
    });
    this.accessResolver.invalidateUser(userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.UpsertServerGrant, userId, 'user', { serverId, ...dto });
    return this.withTaskIds(this.serverGrantToDto(grant), taskId ? [taskId] : []);
  }

  async deleteUserServerGrant(userId: string, serverId: string, actorId?: string): Promise<TaskIdsResult> {
    const result = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId) await this.requireGrantActorInTransaction(manager, actorId);
      await this.requireUserInTransaction(manager, userId);
      await this.requireServerInTransaction(manager, serverId);
      const existing = await manager.findOneBy(ServerGrantEntity, {
        scope: 'user', scopeId: userId, serverId,
      });
      if (!existing) return { changed: false, taskId: null as string | null };
      await manager.delete(ServerGrantEntity, { scope: 'user', scopeId: userId, serverId });
      await this.revocationGuard.assertServerAccessRevocationSafe(manager, [{ userId, serverId }]);
      return {
        changed: true,
        taskId: await this.syncUserQuotaInTransaction(
          manager, userId, serverId, actorId ?? null,
        ),
      };
    });
    if (!result.changed) return { taskIds: [] };
    this.accessResolver.invalidateUser(userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.DeleteServerGrant, userId, 'user', { serverId });
    return { taskIds: result.taskId ? [result.taskId] : [] };
  }

  // ---------------------------------------------------------------------------
  // Image grants (user scope)
  // ---------------------------------------------------------------------------

  async listUserImageGrants(userId: string): Promise<ImageGrantDto[]> {
    await this.requireUserScope(userId);
    const grants = await this.imageGrantsRepo.find({ where: { scope: 'user', scopeId: userId } });
    return grants.map((g) => this.imageGrantToDto(g));
  }

  async addUserImageGrant(
    userId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<ImageGrantDto> {
    const grant = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId) await this.requireGrantActorInTransaction(manager, actorId);
      await this.requireUserInTransaction(manager, userId);
      await this.requireImageInTransaction(manager, imageId);
      await this.requireServerInTransaction(manager, serverId);
      let current = await manager.findOne(ImageGrantEntity, {
        where: { scope: 'user', scopeId: userId, imageId, serverId },
      });
      if (!current) {
        current = manager.create(ImageGrantEntity, {
          id: uuidv4(), scope: 'user', scopeId: userId, imageId, serverId,
        });
        current = await manager.save(ImageGrantEntity, current);
      }
      return current;
    });
    this.accessResolver.invalidateUser(userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.UpsertImageGrant, userId, 'user', {
      imageId,
      serverId,
    });
    return this.imageGrantToDto(grant);
  }

  async deleteUserImageGrant(
    userId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<void> {
    const changed = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId) await this.requireGrantActorInTransaction(manager, actorId);
      await this.requireUserInTransaction(manager, userId);
      await this.requireImageInTransaction(manager, imageId);
      await this.requireServerInTransaction(manager, serverId);
      const deleted = await manager.delete(ImageGrantEntity, {
        scope: 'user', scopeId: userId, imageId, serverId,
      });
      return deleted.affected === 1;
    });
    if (!changed) return;
    this.accessResolver.invalidateUser(userId);
    await this.auditBestEffort(actorId ?? null, AuditAction.DeleteImageGrant, userId, 'user', {
      imageId,
      serverId,
    });
  }

  // ---------------------------------------------------------------------------
  // Ensure system groups exist
  // ---------------------------------------------------------------------------

  async ensureSystemGroups(): Promise<{
    admins: GroupEntity;
    operators: GroupEntity;
    users: GroupEntity;
  }> {
    const legacyUnknown = await this.groupsRepo.find({
      where: { isSystem: true, systemKey: IsNull() },
    });
    const expectedLegacyNames = new Set(['Administrators', 'Operators', 'Users']);
    const unsafeLegacy = legacyUnknown.filter((group) => !expectedLegacyNames.has(group.name));
    if (unsafeLegacy.length > 0) {
      throw new ConflictException({
        code: 'UNKNOWN_LEGACY_SYSTEM_GROUP',
        message: 'A renamed legacy system group cannot be identified safely; repair it explicitly',
        groupIds: unsafeLegacy.map((group) => group.id),
      });
    }
    const admins = await this.ensureSystemGroup(
      SystemGroupKey.Administrators,
      'Administrators',
      1000,
      Object.values(Capability),
    );
    const operators = await this.ensureSystemGroup(SystemGroupKey.Operators, 'Operators', 500, [
      Capability.ManageServers,
      Capability.ManageImages,
      Capability.ManageGrants,
      Capability.ManageContainersAny,
      Capability.ViewAudit,
      Capability.ViewMetricsAll,
      Capability.ManageSystemSettings,
    ]);
    const users = await this.ensureSystemGroup(SystemGroupKey.Users, 'Users', 10, []);
    return { admins, operators, users };
  }

  private async ensureSystemGroup(
    systemKey: SystemGroupKey,
    name: string,
    priority: number,
    caps: Capability[],
  ): Promise<GroupEntity> {
    let group = await this.groupsRepo.findOne({ where: { systemKey } });
    if (!group) {
      const sameName = await this.groupsRepo.findOne({ where: { name } });
      if (sameName && (!sameName.isSystem || sameName.systemKey !== null)) {
        throw new ConflictException({
          code: 'SYSTEM_GROUP_NAME_CONFLICT',
          message: `The reserved built-in group name ${name} is occupied`,
          groupId: sameName.id,
        });
      }
      group = sameName ?? this.groupsRepo.create({
        id: uuidv4(),
        name,
        priority,
        isSystem: true,
        systemKey,
        description: null,
      });
      group.name = name;
      group.priority = priority;
      group.isSystem = true;
      group.systemKey = systemKey;
      group.capabilities = caps;
      await this.groupsRepo.save(group);
    } else {
      if (group.name !== name) {
        throw new ConflictException({
          code: 'SYSTEM_GROUP_IDENTITY_MISMATCH',
          message: `Built-in group ${systemKey} has an unexpected name`,
          groupId: group.id,
        });
      }
      let changed = !this.sameCapabilities(group.capabilities, caps);
      if (group.priority !== priority) {
        group.priority = priority;
        changed = true;
      }
      if (!group.isSystem) {
        group.isSystem = true;
        changed = true;
      }
      if (changed) {
        group.capabilities = [...caps];
        await this.groupsRepo.save(group);
        const members = await this.membersRepo.find({ where: { groupId: group.id } });
        if (members.length > 0) {
          await this.usersRepo.increment(
            { id: In(members.map((member) => member.userId)) },
            'authVersion',
            1,
          );
        }
        for (const member of members) this.accessResolver.invalidateUser(member.userId);
      }
    }
    return group;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private assertOrdinaryGroupName(name: string): void {
    if (name === 'Administrators' || name === 'Operators' || name === 'Users') {
      throw new ConflictException({
        code: 'SYSTEM_GROUP_NAME_RESERVED',
        message: `${name} is reserved for a built-in group`,
      });
    }
  }

  private sameCapabilities(left: readonly Capability[], right: readonly Capability[]): boolean {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return leftSet.size === rightSet.size && [...leftSet].every((capability) => rightSet.has(capability));
  }

  private async assertActorMayMutateGroupInTransaction(
    manager: EntityManager,
    actorId: string,
    current: GroupEntity,
    desiredCapabilities: readonly Capability[],
    resourceAuthoritySensitive: boolean,
  ): Promise<void> {
    const governedCapabilities = new Set([
      Capability.ManageGroups,
      ...current.capabilities,
      ...desiredCapabilities,
    ]);
    await this.accessResolver.assertActorCapabilitiesInTransaction(
      manager,
      actorId,
      governedCapabilities,
    );
    if (!resourceAuthoritySensitive) return;
    const [serverGrants, imageGrants, mountSourceGrants] = await Promise.all([
      manager.count(ServerGrantEntity, { where: { scope: 'group', scopeId: current.id } }),
      manager.count(ImageGrantEntity, { where: { scope: 'group', scopeId: current.id } }),
      manager.count(MountSourceGrantEntity, { where: { scope: 'group', scopeId: current.id } }),
    ]);
    if (serverGrants + imageGrants + mountSourceGrants > 0) {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        manager,
        actorId,
        [Capability.ManageGrants],
      );
    }
  }

  private async bumpAuthVersionsInTransaction(
    manager: EntityManager,
    userIds: readonly string[],
  ): Promise<void> {
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length === 0) return;
    await manager.increment(UserEntity, { id: In(uniqueUserIds) }, 'authVersion', 1);
  }

  private async invalidateGroupMembers(groupId: string): Promise<GroupMemberEntity[]> {
    const members = await this.membersRepo.find({ where: { groupId } });
    for (const m of members) this.accessResolver.invalidateUser(m.userId);
    return members;
  }

  private async syncUserQuotaInTransaction(
    manager: EntityManager,
    userId: string,
    serverId: string,
    requestedBy: string | null,
  ): Promise<string | null> {
    const grant = await this.accessResolver.resolveServerInTransaction(manager, userId, serverId);
    if (!grant) return null;
    const user = await manager.findOne(UserEntity, {
      where: { id: userId },
      select: { id: true, numericId: true },
    });
    if (!user?.numericId) {
      throw new ConflictException(`User ${userId} has no numeric quota identity`);
    }
    return this.quotaDispatchService.applyInTransaction(manager, {
      serverId,
      userId,
      numericUserId: user.numericId,
      diskBytes: grant.diskBytes,
      requestedBy,
    });
  }

  private async requireGroupInTransaction(manager: EntityManager, groupId: string): Promise<void> {
    if (!await manager.findOneBy(GroupEntity, { id: groupId })) {
      throw new NotFoundException('Group not found');
    }
  }

  private async requireUserInTransaction(manager: EntityManager, userId: string): Promise<void> {
    const user = await manager.findOneBy(UserEntity, { id: userId });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.status === UserStatus.Deleted || user.status === UserStatus.Deleting) {
      throw new ConflictException({
        code: user.status === UserStatus.Deleted ? 'USER_DELETED' : 'USER_DELETING',
        message: 'A deleted or deleting user cannot receive memberships or grants',
        userId,
      });
    }
  }

  private async requireUserScope(userId: string): Promise<void> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user || user.status === UserStatus.Deleted) {
      throw new NotFoundException('User not found');
    }
  }

  private async requireGrantActorInTransaction(
    manager: EntityManager,
    actorId: string,
  ): Promise<void> {
    await this.accessResolver.assertActorCapabilitiesInTransaction(
      manager,
      actorId,
      [Capability.ManageGrants],
    );
  }

  private quotaTaskMatchesDesired(
    task: AgentTaskEntity,
    desired: QuotaDesiredEntity,
    diskBytes: number,
  ): boolean {
    const payload = task.payloadJson && typeof task.payloadJson === 'object' && !Array.isArray(task.payloadJson)
      ? task.payloadJson as Record<string, unknown>
      : null;
    return task.kind === AgentTaskKind.QuotaEnsure
      && task.resourceType === 'quota'
      && task.resourceId === desired.userId
      && task.serverId === desired.serverId
      && payload?.generation === desired.generation
      && payload.numericUserId === desired.numericUserId
      && payload.diskBytes === diskBytes
      && desired.limitBytes === diskBytes
      && desired.lastTaskId === task.id;
  }

  private async requireServerInTransaction(manager: EntityManager, serverId: string): Promise<void> {
    if (!await manager.findOneBy(ServerEntity, { id: serverId })) {
      throw new NotFoundException('Server not found');
    }
  }

  private async requireImageInTransaction(manager: EntityManager, imageId: string): Promise<void> {
    const image = await manager.findOneBy(ImageEntity, { id: imageId });
    if (!image) {
      throw new NotFoundException('Image not found');
    }
    if (image.deleting) {
      throw new ConflictException({
        code: 'IMAGE_DELETING',
        message: 'Image cleanup is in progress and cannot receive new grants',
        imageId,
      });
    }
  }

  private uniqueTaskIds(taskIds: readonly string[]): string[] {
    return [...new Set(taskIds)];
  }

  private withTaskIds<T extends object>(value: T, taskIds: readonly string[]): T & TaskIdsResult {
    return Object.assign(value, { taskIds: this.uniqueTaskIds(taskIds) });
  }

  private async auditBestEffort(
    actorId: string | null,
    action: AuditAction,
    targetId: string,
    targetType: string,
    details: unknown,
  ): Promise<void> {
    try {
      await this.auditService.log(actorId, action, targetId, targetType, details);
    } catch (error) {
      // The business mutation and its durable Agent intent have already
      // committed atomically. Audit transport/storage failure must not turn a
      // successful request into a misleading 500 that callers retry.
      console.warn('[Groups] Audit write failed after commit', error);
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
      revision: g.revision,
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
    await this.findById(groupId);
    return this.mountSources.listGrantsForScope('group', groupId);
  }

  async upsertGroupMountSourceGrant(
    actorId: string,
    groupId: string,
    target: MountSourceGrantTarget,
  ): Promise<MountSourceGrantDto> {
    return this.mountSources.upsertGrant(actorId, 'group', groupId, target);
  }

  async deleteGroupMountSourceGrant(
    actorId: string,
    groupId: string,
    target: MountSourceGrantTarget,
  ): Promise<void> {
    await this.mountSources.deleteGrant(actorId, 'group', groupId, target);
  }

  // ---------------------------------------------------------------------------
  // Mount source grants (user scope)
  // ---------------------------------------------------------------------------

  async listUserMountSourceGrants(userId: string): Promise<MountSourceGrantDto[]> {
    await this.requireUserScope(userId);
    return this.mountSources.listGrantsForScope('user', userId);
  }

  async upsertUserMountSourceGrant(
    actorId: string,
    userId: string,
    target: MountSourceGrantTarget,
  ): Promise<MountSourceGrantDto> {
    return this.mountSources.upsertGrant(actorId, 'user', userId, target);
  }

  async deleteUserMountSourceGrant(
    actorId: string,
    userId: string,
    target: MountSourceGrantTarget,
  ): Promise<void> {
    await this.mountSources.deleteGrant(actorId, 'user', userId, target);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

}
