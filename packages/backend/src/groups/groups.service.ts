import {
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import {
  AuditAction,
  Capability,
  GpuGrantMode,
  MAX_GROUP_MEMBERS,
  MAX_PLATFORM_GROUPS,
  MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION,
  type GroupDto,
  type GroupMemberDto,
  type GroupSummaryDto,
  type ImageGrantDto,
  type MountSourceGrantDto,
  type ServerGrantDto,
  SystemGroupKey,
  UserStatus,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import {
  AccessResolverService,
  type IamGroup,
  type IamTransaction,
} from '../access/access-resolver.service.js';
import { AccessRevocationGuardService } from '../access/access-revocation-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import {
  MountSourcesService,
  type MountSourceGrantTarget,
} from '../mount-sources/mount-sources.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { QuotaDispatchService } from '../quota/quota-dispatch.service.js';

type TaskIdsResult = { taskIds: string[] };
type WithTaskIds<T> = T & TaskIdsResult;
export type UserDeleteResult = { deleted: boolean; taskIds: string[] };
type GrantScope = 'user' | 'group';

interface ServerGrant {
  id: string;
  scope: GrantScope;
  scopeId: string;
  serverId: string;
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  gpuMode: GpuGrantMode | null;
  gpuIndices: number[] | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ImageGrant {
  id: string;
  scope: GrantScope;
  scopeId: string;
  imageId: string;
  serverId: string;
  createdAt: Date;
}

@Injectable()
export class GroupsService {
  constructor(
    database: Kysely<NyabaseDatabase>,
    transactions: PgTransactionManager,
    accessResolver: AccessResolverService,
    auditService: AuditService,
    revocationGuard: AccessRevocationGuardService,
    mountSources: MountSourcesService,
    quotaDispatch: QuotaDispatchService,
    proxySnapshots: ProxySnapshotNotifierService,
    authService: AuthService,
  );
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly accessResolver: AccessResolverService,
    @Inject(forwardRef(() => AuditService))
    private readonly auditService: AuditService,
    private readonly revocationGuard: AccessRevocationGuardService,
    private readonly mountSources: MountSourcesService,
    private readonly quotaDispatch: QuotaDispatchService,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
  ) {}

  async findAll(): Promise<GroupDto[]> {
    const [rows, members] = await Promise.all([
      this.database.selectFrom('iam.groups').selectAll()
        .orderBy('priority', 'desc').orderBy('name').execute(),
      this.database.selectFrom('iam.group_members as membership')
        .innerJoin('iam.users as user', 'user.id', 'membership.user_id')
        .select([
          'membership.group_id',
          'user.id as user_id',
          'user.username',
          'user.display_name',
        ])
        .limit(MAX_PLATFORM_GROUPS * MAX_GROUP_MEMBERS + 1)
        .execute(),
    ]);
    if (members.length > MAX_PLATFORM_GROUPS * MAX_GROUP_MEMBERS) {
      throw new ConflictException({
        code: 'GROUP_MEMBERSHIP_CAPACITY_DRIFT',
        message: 'Stored group memberships exceed the bounded catalog contract',
      });
    }
    const byGroup = new Map<string, GroupMemberDto[]>();
    for (const member of members) {
      const groupMembers = byGroup.get(member.group_id) ?? [];
      groupMembers.push({
        userId: member.user_id,
        username: member.username,
        displayName: member.display_name,
      });
      byGroup.set(member.group_id, groupMembers);
    }
    return rows.map((row) => {
      const group = this.toGroup(row);
      const groupMembers = byGroup.get(group.id) ?? [];
      return {
        ...this.toDto(group),
        members: groupMembers,
        memberCount: groupMembers.length,
      };
    });
  }

  async findById(id: string): Promise<IamGroup> {
    const row = await this.database.selectFrom('iam.groups')
      .selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('Group not found');
    return this.toGroup(row);
  }

  async create(
    dto: {
      name: string;
      description?: string;
      priority?: number;
      capabilities?: Capability[];
    },
    actorId?: string,
  ): Promise<GroupDto> {
    this.assertOrdinaryGroupName(dto.name);
    const group = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      if (actorId) {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGroups, ...(dto.capabilities ?? [])],
        );
      }
      const count = await transaction.selectFrom('iam.groups')
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= MAX_PLATFORM_GROUPS) {
        throw new ConflictException({
          code: 'GROUP_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_GROUPS} groups are supported`,
        });
      }
      if (await transaction.selectFrom('iam.groups').select('id')
        .where('name', '=', dto.name).executeTakeFirst()) {
        throw new ConflictException('Group name already exists');
      }
      const row = await transaction.insertInto('iam.groups').values({
        id: uuidv4(),
        name: dto.name,
        description: dto.description ?? null,
        priority: dto.priority ?? 0,
        is_system: false,
        system_key: null,
        capabilities: dto.capabilities ?? [],
        revision: 1,
      }).returningAll().executeTakeFirstOrThrow();
      await sql`SELECT iam.bump_policy_epoch()`.execute(transaction);
      const group = this.toGroup(row);
      await this.auditService.append(
        transaction,
        actorId ?? null,
        AuditAction.CreateGroup,
        group.id,
        'group',
        { name: group.name },
      );
      return group;
    });
    await this.accessResolver.authorizationCommitted();
    return this.toDto(group);
  }

  async update(
    id: string,
    dto: {
      name?: string;
      description?: string | null;
      priority?: number;
      capabilities?: Capability[];
    },
    actorId: string | undefined,
    expectedRevision: number,
  ): Promise<WithTaskIds<GroupDto>> {
    const result = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      const row = await transaction.selectFrom('iam.groups')
        .selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!row) throw new NotFoundException('Group not found');
      const current = this.toGroup(row);
      const desiredCapabilities = dto.capabilities ?? current.capabilities;
      if (actorId) {
        await this.assertActorMayMutateGroup(
          transaction,
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
      if (current.isSystem || current.systemKey !== null) {
        const metadataChanged =
          (dto.name !== undefined && dto.name !== current.name)
          || (dto.priority !== undefined && dto.priority !== current.priority)
          || (dto.capabilities !== undefined
            && !this.sameCapabilities(dto.capabilities, current.capabilities));
        if (metadataChanged) {
          throw new ForbiddenException({
            code: 'SYSTEM_GROUP_METADATA_IMMUTABLE',
            message: 'Built-in group name, priority, and capabilities are immutable',
          });
        }
      }
      if (dto.name !== undefined) {
        this.assertOrdinaryGroupName(dto.name);
        const conflict = await transaction.selectFrom('iam.groups').select('id')
          .where('name', '=', dto.name).where('id', '!=', id).executeTakeFirst();
        if (conflict) throw new ConflictException('Group name already exists');
      }
      const updated = await transaction.updateTable('iam.groups').set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.capabilities !== undefined ? { capabilities: dto.capabilities } : {}),
        revision: current.revision + 1,
        updated_at: new Date(),
      }).where('id', '=', id)
        .where('revision', '=', String(expectedRevision))
        .returningAll()
        .executeTakeFirst();
      if (!updated) {
        throw new ConflictException({
          code: 'GROUP_REVISION_CONFLICT',
          message: 'Group changed; reload and resolve the conflicting fields',
        });
      }
      const members = await transaction.selectFrom('iam.group_members')
        .select('user_id').where('group_id', '=', id).execute();
      await this.auditService.append(
        transaction,
        actorId ?? null,
        AuditAction.UpdateGroup,
        id,
        'group',
        dto,
      );
      return { group: this.toGroup(updated), userIds: members.map((m) => m.user_id) };
    });
    await this.accessResolver.authorizationCommitted(result.userIds);
    return this.withTaskIds(this.toDto(result.group), []);
  }

  async delete(id: string, actorId?: string): Promise<TaskIdsResult> {
    const affected = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      const row = await transaction.selectFrom('iam.groups')
        .selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!row) throw new NotFoundException('Group not found');
      const group = this.toGroup(row);
      if (group.isSystem || group.systemKey !== null) {
        throw new ForbiddenException('Cannot delete system group');
      }
      if (actorId) {
        await this.assertActorMayMutateGroup(
          transaction,
          actorId,
          group,
          group.capabilities,
          true,
        );
      }
      const members = await transaction.selectFrom('iam.group_members')
        .select('user_id').where('group_id', '=', id).execute();
      const grants = await transaction.selectFrom('iam.server_grants')
        .select('server_id').where('group_id', '=', id).execute();
      const mountGrants = await transaction.selectFrom('iam.mount_source_grants')
        .select(['source_kind', 'source_id', 'server_id', 'source_identity'])
        .where('group_id', '=', id)
        .execute();
      this.assertQuotaFanoutWithinLimit(
        members.length * new Set(grants.map((grant) => grant.server_id)).size,
        'delete-group',
      );
      await transaction.deleteFrom('iam.group_members').where('group_id', '=', id).execute();
      await transaction.deleteFrom('iam.server_grants').where('group_id', '=', id).execute();
      await transaction.deleteFrom('iam.image_grants').where('group_id', '=', id).execute();
      await transaction.deleteFrom('iam.mount_source_grants').where('group_id', '=', id).execute();
      await transaction.deleteFrom('iam.groups').where('id', '=', id).executeTakeFirstOrThrow();
      await this.revocationGuard.assertServerAccessRevocationSafe(
        transaction,
        members.flatMap((member) => grants.map((grant) => ({
          userId: member.user_id,
          serverId: grant.server_id,
        }))),
      );
      await this.revocationGuard.assertMountSourcesRevocationSafe(
        transaction,
        members.map((member) => member.user_id),
        mountGrants.map((grant) => ({
          sourceKind: grant.source_kind === 'local' ? 'local' : 'remote',
          sourceId: grant.source_id,
          serverId: grant.server_id,
          sourceIdentity: grant.source_identity,
        })),
      );
      const taskIds = await this.syncUserQuotasInTransaction(
        transaction,
        members.flatMap((member) => grants.map((grant) => ({
          userId: member.user_id,
          serverId: grant.server_id,
        }))),
        actorId ?? null,
      );
      await sql`SELECT iam.bump_policy_epoch()`.execute(transaction);
      await this.auditService.append(
        transaction,
        actorId ?? null,
        AuditAction.DeleteGroup,
        id,
        'group',
        { name: group.name },
      );
      return { group, userIds: members.map((m) => m.user_id), taskIds };
    });
    await this.accessResolver.authorizationCommitted(affected.userIds);
    return { taskIds: affected.taskIds };
  }

  async listMembers(groupId: string): Promise<GroupMemberDto[]> {
    await this.findById(groupId);
    const members = await this.database.selectFrom('iam.group_members as membership')
      .innerJoin('iam.users as user', 'user.id', 'membership.user_id')
      .select([
        'user.id as userId',
        'user.username',
        'user.display_name as displayName',
      ])
      .where('membership.group_id', '=', groupId)
      .limit(MAX_GROUP_MEMBERS + 1)
      .execute();
    if (members.length > MAX_GROUP_MEMBERS) {
      throw new ConflictException({
        code: 'GROUP_MEMBERSHIP_CAPACITY_DRIFT',
        message: 'Stored group memberships exceed the bounded group contract',
        groupId,
      });
    }
    return members;
  }

  async hasActiveSystemGroupMember(
    groupId: string,
    excludedUserId?: string,
  ): Promise<boolean> {
    let query = this.database.selectFrom('iam.group_members as membership')
      .innerJoin('iam.users as user', 'user.id', 'membership.user_id')
      .select('user.id')
      .where('membership.group_id', '=', groupId)
      .where('user.status', '=', UserStatus.Active);
    if (excludedUserId) query = query.where('user.id', '!=', excludedUserId);
    return Boolean(await query.executeTakeFirst());
  }

  async addMember(groupId: string, userId: string, actorId?: string): Promise<TaskIdsResult> {
    const changed = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      const group = await this.requireGroup(transaction, groupId);
      if (actorId) {
        await this.assertActorMayMutateGroup(
          transaction,
          actorId,
          group,
          group.capabilities,
          true,
        );
      }
      await this.requireUser(transaction, userId);
      const membershipState = await transaction.selectFrom('iam.group_members')
        .select((expression) => [
          expression.fn.countAll<string>().as('count'),
          sql<boolean>`bool_or(user_id = ${userId}::uuid)`.as('already_member'),
        ])
        .where('group_id', '=', groupId)
        .executeTakeFirstOrThrow();
      if (membershipState.already_member === true) {
        return { changed: false, taskIds: [] };
      }
      if (Number(membershipState.count) >= MAX_GROUP_MEMBERS) {
        throw new ConflictException({
          code: 'GROUP_MEMBER_CAPACITY_REACHED',
          message: `At most ${MAX_GROUP_MEMBERS} members are supported per group`,
          groupId,
          maxMembers: MAX_GROUP_MEMBERS,
        });
      }
      const inserted = await transaction.insertInto('iam.group_members').values({
        id: uuidv4(),
        group_id: groupId,
        user_id: userId,
      }).onConflict((conflict) => conflict.columns(['group_id', 'user_id']).doNothing())
        .returning('id').executeTakeFirst();
      if (!inserted) return { changed: false, taskIds: [] };
      const grants = await transaction.selectFrom('iam.server_grants')
        .select('server_id')
        .where('group_id', '=', groupId)
        .execute();
      this.assertQuotaFanoutWithinLimit(grants.length, 'add-group-member');
      const taskIds = await this.syncUserQuotasInTransaction(
        transaction,
        grants.map((grant) => ({ userId, serverId: grant.server_id })),
        actorId ?? null,
      );
      await this.auditService.append(
        transaction,
        actorId ?? null,
        AuditAction.AddGroupMember,
        groupId,
        'group',
        { userId },
      );
      return { changed: true, taskIds };
    });
    if (changed.changed) {
      await this.accessResolver.authorizationCommitted([userId]);
    }
    return { taskIds: changed.taskIds };
  }

  async removeMember(groupId: string, userId: string, actorId?: string): Promise<TaskIdsResult> {
    const changed = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      const group = await this.requireGroup(transaction, groupId);
      if (actorId) {
        await this.assertActorMayMutateGroup(
          transaction,
          actorId,
          group,
          group.capabilities,
          true,
        );
      }
      await this.requireUser(transaction, userId, false);
      const membership = await transaction.selectFrom('iam.group_members')
        .select('id')
        .where('group_id', '=', groupId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!membership) return { changed: false, taskIds: [] as string[] };
      if (group.systemKey === SystemGroupKey.Administrators) {
        await this.accessResolver.assertNotFinalActiveAdministratorInTransaction(
          transaction,
          userId,
        );
      }
      const serverIds = await transaction.selectFrom('iam.server_grants')
        .select('server_id').where('group_id', '=', groupId).execute();
      const mountGrants = await transaction.selectFrom('iam.mount_source_grants')
        .select(['source_kind', 'source_id', 'server_id', 'source_identity'])
        .where('group_id', '=', groupId)
        .execute();
      this.assertQuotaFanoutWithinLimit(serverIds.length, 'remove-group-member');
      await transaction.deleteFrom('iam.group_members').where('id', '=', membership.id).execute();
      await this.revocationGuard.assertServerAccessRevocationSafe(
        transaction,
        serverIds.map((grant) => ({ userId, serverId: grant.server_id })),
      );
      await this.revocationGuard.assertMountSourcesRevocationSafe(
        transaction,
        [userId],
        mountGrants.map((grant) => ({
          sourceKind: grant.source_kind === 'local' ? 'local' : 'remote',
          sourceId: grant.source_id,
          serverId: grant.server_id,
          sourceIdentity: grant.source_identity,
        })),
      );
      const taskIds = await this.syncUserQuotasInTransaction(
        transaction,
        serverIds.map((grant) => ({ userId, serverId: grant.server_id })),
        actorId ?? null,
      );
      await this.auditService.append(
        transaction,
        actorId ?? null,
        AuditAction.RemoveGroupMember,
        groupId,
        'group',
        { userId },
      );
      return { changed: true, taskIds };
    });
    if (changed.changed) {
      await this.accessResolver.authorizationCommitted([userId]);
    }
    return {
      taskIds: changed.taskIds,
    };
  }

  async ensureUserInSystemGroup(systemKey: SystemGroupKey, userId: string): Promise<void> {
    const group = await this.database.selectFrom('iam.groups')
      .select('id').where('system_key', '=', systemKey).executeTakeFirst();
    if (!group) throw new NotFoundException('System group not found');
    await this.addMember(group.id, userId);
  }

  async ensureUserNotInSystemGroup(systemKey: SystemGroupKey, userId: string): Promise<void> {
    const group = await this.database.selectFrom('iam.groups')
      .select('id').where('system_key', '=', systemKey).executeTakeFirst();
    if (!group) return;
    await this.removeMember(group.id, userId);
  }

  async deleteUserPermanently(userId: string, actorId: string): Promise<UserDeleteResult> {
    const result = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      const user = await transaction.selectFrom('iam.users')
        .selectAll().where('id', '=', userId).forUpdate().executeTakeFirst();
      if (!user || user.status === UserStatus.Deleted) {
        throw new NotFoundException('User not found');
      }
      await this.accessResolver.assertActorMayAdministerUserInTransaction(
        transaction,
        actorId,
        userId,
      );
      if (user.status === UserStatus.Active) {
        await this.accessResolver.assertNotFinalActiveAdministratorInTransaction(
          transaction,
          userId,
        );
      }
      const dependency = await transaction.selectFrom('control.authorization_dependencies')
        .select(['dependency_kind', 'dependency_id'])
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (dependency) {
        throw new ConflictException({
          code: 'USER_DELETE_HAS_RESOURCES',
          message: 'Delete the user resources before deleting the account',
          dependencyKind: dependency.dependency_kind,
          dependencyId: dependency.dependency_id,
        });
      }

      const pending = await transaction.selectFrom('workflow.tasks')
        .select(['id', 'server_id', 'started_at', 'last_sent_at', 'agent_result_json'])
        .where('kind', '=', 'quota.ensure')
        .where('resource_type', '=', 'quota')
        .where('resource_id', '=', userId)
        .where('status', '=', 'pending')
        .orderBy('id')
        .execute();
      if (user.status === UserStatus.Deleting && pending.length > 0) {
        return { deleted: false, taskIds: pending.map((task) => task.id) };
      }
      if (user.status !== UserStatus.Deleting) {
        const ambiguous = pending.find((task) =>
          task.started_at !== null
          || task.last_sent_at !== null
          || task.agent_result_json !== null);
        if (ambiguous) {
          throw new ConflictException({
            code: 'USER_DELETE_QUOTA_IN_PROGRESS',
            message:
              'Wait for the dispatched quota task to reach a terminal state before deleting the user',
            userId,
            taskId: ambiguous.id,
          });
        }
      }

      const desiredServers = await transaction.selectFrom('control.quota_desired')
        .select('server_id')
        .where('user_id', '=', userId)
        .execute();
      const directServers = await transaction.selectFrom('iam.server_grants')
        .select('server_id')
        .where('user_id', '=', userId)
        .execute();
      const inheritedServers = await transaction.selectFrom('iam.group_members as membership')
        .innerJoin('iam.server_grants as grant', 'grant.group_id', 'membership.group_id')
        .select('grant.server_id')
        .where('membership.user_id', '=', userId)
        .execute();
      const serverIds = [...new Set([
        ...desiredServers.map((row) => row.server_id),
        ...directServers.map((row) => row.server_id),
        ...inheritedServers.map((row) => row.server_id),
      ])].sort();

      await this.authService.deleteUserCredentialsInTransaction(transaction, userId);
      await transaction.deleteFrom('iam.ssh_public_keys').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.user_internal_ssh_keys').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.group_members').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.server_grants').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.image_grants').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.mount_source_grants').where('user_id', '=', userId).execute();
      const nextStatus = serverIds.length === 0 ? UserStatus.Deleted : UserStatus.Deleting;
      await transaction.updateTable('iam.users').set({
        status: nextStatus,
        auth_version: user.auth_version + 1,
        authz_version: sql`authz_version + 1`,
        updated_at: new Date(),
      }).where('id', '=', userId).executeTakeFirstOrThrow();
      await sql`SELECT iam.bump_policy_epoch()`.execute(transaction);
      if (serverIds.length === 0) {
        await this.auditService.append(
          transaction,
          actorId,
          AuditAction.DeleteUser,
          userId,
          'user',
          { terminal: true },
        );
        return { deleted: true, taskIds: [] as string[] };
      }
      const taskIds: string[] = [];
      for (const serverId of serverIds) {
        taskIds.push(await this.quotaDispatch.applyInTransaction(transaction, {
          serverId,
          userId,
          numericUserId: user.numeric_id,
          diskBytes: 0,
          requestedBy: actorId,
          allowDeleting: true,
        }));
      }
      return { deleted: false, taskIds };
    });
    await this.accessResolver.authorizationCommitted([userId]);
    if (result.deleted) {
      await this.proxySnapshots.notify('user-deleted').catch(() => undefined);
    }
    return result;
  }

  listGroupServerGrants(groupId: string): Promise<ServerGrantDto[]> {
    return this.listServerGrants('group', groupId);
  }

  upsertGroupServerGrant(
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
    return this.upsertServerGrant('group', groupId, serverId, dto, actorId);
  }

  deleteGroupServerGrant(
    groupId: string,
    serverId: string,
    actorId?: string,
  ): Promise<TaskIdsResult> {
    return this.deleteServerGrant('group', groupId, serverId, actorId);
  }

  listGroupImageGrants(groupId: string): Promise<ImageGrantDto[]> {
    return this.listImageGrants('group', groupId);
  }

  addGroupImageGrant(
    groupId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<ImageGrantDto> {
    return this.addImageGrant('group', groupId, imageId, serverId, actorId);
  }

  deleteGroupImageGrant(
    groupId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<void> {
    return this.deleteImageGrant('group', groupId, imageId, serverId, actorId);
  }

  async syncGroupImageGrantsForServers(
    groupId: string,
    imageId: string,
    serverIds: string[],
    actorId?: string,
  ): Promise<ImageGrantDto[]> {
    const targets = [...new Set(serverIds)];
    const rows = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      if (actorId) await this.requireGrantActor(transaction, actorId);
      await this.requireGroup(transaction, groupId);
      const existing = await transaction.selectFrom('iam.image_grants')
        .selectAll()
        .where('group_id', '=', groupId)
        .where('image_id', '=', imageId)
        .execute();
      const existingIds = new Set(existing.map((row) => row.server_id));
      await transaction.deleteFrom('iam.image_grants')
        .where('group_id', '=', groupId)
        .where('image_id', '=', imageId)
        .$if(targets.length > 0, (query) => query.where('server_id', 'not in', targets))
        .execute();
      for (const serverId of targets) {
        if (existingIds.has(serverId)) continue;
        await transaction.insertInto('iam.image_grants').values({
          id: uuidv4(),
          user_id: null,
          group_id: groupId,
          image_id: imageId,
          server_id: serverId,
        }).execute();
      }
      const rows = await transaction.selectFrom('iam.image_grants').selectAll()
        .where('group_id', '=', groupId)
        .where('image_id', '=', imageId)
        .execute();
      await this.auditService.append(
        transaction,
        actorId ?? null,
        AuditAction.UpsertImageGrant,
        groupId,
        'group',
        { imageId, serverIds: targets, mode: 'replace_servers' },
      );
      return rows;
    });
    const userIds = await this.groupUserIds(groupId);
    await this.accessResolver.authorizationCommitted(userIds);
    return rows.map((row) => this.imageGrantToDto(this.toImageGrant(row)));
  }

  listUserServerGrants(userId: string): Promise<ServerGrantDto[]> {
    return this.listServerGrants('user', userId);
  }

  async assertUserScopeExists(userId: string): Promise<void> {
    await this.requireUserScope(userId);
  }

  upsertUserServerGrant(
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
    return this.upsertServerGrant('user', userId, serverId, dto, actorId);
  }

  deleteUserServerGrant(
    userId: string,
    serverId: string,
    actorId?: string,
  ): Promise<TaskIdsResult> {
    return this.deleteServerGrant('user', userId, serverId, actorId);
  }

  listUserImageGrants(userId: string): Promise<ImageGrantDto[]> {
    return this.listImageGrants('user', userId);
  }

  addUserImageGrant(
    userId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<ImageGrantDto> {
    return this.addImageGrant('user', userId, imageId, serverId, actorId);
  }

  deleteUserImageGrant(
    userId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<void> {
    return this.deleteImageGrant('user', userId, imageId, serverId, actorId);
  }

  async ensureSystemGroups(): Promise<{
    admins: IamGroup;
    operators: IamGroup;
    users: IamGroup;
  }> {
    return this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      const admins = await this.ensureSystemGroup(
        transaction,
        SystemGroupKey.Administrators,
        'Administrators',
        1000,
        Object.values(Capability),
      );
      const operators = await this.ensureSystemGroup(
        transaction,
        SystemGroupKey.Operators,
        'Operators',
        500,
        [
          Capability.ManageServers,
          Capability.ManageImages,
          Capability.ManageGrants,
          Capability.ManageContainersAny,
          Capability.ViewAudit,
          Capability.ViewMetricsAll,
          Capability.ManageSystemSettings,
        ],
      );
      const users = await this.ensureSystemGroup(
        transaction,
        SystemGroupKey.Users,
        'Users',
        10,
        [],
      );
      return { admins, operators, users };
    });
  }

  async listGroupMountSourceGrants(groupId: string): Promise<MountSourceGrantDto[]> {
    await this.findById(groupId);
    return this.mountSources.listGrantsForScope('group', groupId);
  }

  upsertGroupMountSourceGrant(
    actorId: string,
    groupId: string,
    target: MountSourceGrantTarget,
  ): Promise<MountSourceGrantDto> {
    return this.mountSources.upsertGrant(actorId, 'group', groupId, target);
  }

  deleteGroupMountSourceGrant(
    actorId: string,
    groupId: string,
    target: MountSourceGrantTarget,
  ): Promise<void> {
    return this.mountSources.deleteGrant(actorId, 'group', groupId, target);
  }

  async listUserMountSourceGrants(userId: string): Promise<MountSourceGrantDto[]> {
    await this.requireUserScope(userId);
    return this.mountSources.listGrantsForScope('user', userId);
  }

  upsertUserMountSourceGrant(
    actorId: string,
    userId: string,
    target: MountSourceGrantTarget,
  ): Promise<MountSourceGrantDto> {
    return this.mountSources.upsertGrant(actorId, 'user', userId, target);
  }

  deleteUserMountSourceGrant(
    actorId: string,
    userId: string,
    target: MountSourceGrantTarget,
  ): Promise<void> {
    return this.mountSources.deleteGrant(actorId, 'user', userId, target);
  }

  toDto(group: IamGroup): GroupDto {
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      priority: group.priority,
      isSystem: group.isSystem,
      capabilities: group.capabilities,
      revision: group.revision,
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    };
  }

  toSummaryDto(group: IamGroup): GroupSummaryDto {
    return {
      id: group.id,
      name: group.name,
      priority: group.priority,
      isSystem: group.isSystem,
    };
  }

  serverGrantToDto(grant: ServerGrant): ServerGrantDto {
    return {
      id: grant.id,
      scope: grant.scope,
      scopeId: grant.scopeId,
      serverId: grant.serverId,
      cpuMillis: grant.cpuMillis,
      memBytes: grant.memBytes,
      diskBytes: grant.diskBytes,
      gpuMode: grant.gpuMode,
      gpuIndices: grant.gpuIndices,
      createdAt: grant.createdAt.toISOString(),
      updatedAt: grant.updatedAt.toISOString(),
    };
  }

  imageGrantToDto(grant: ImageGrant): ImageGrantDto {
    return {
      id: grant.id,
      scope: grant.scope,
      scopeId: grant.scopeId,
      imageId: grant.imageId,
      serverId: grant.serverId,
      createdAt: grant.createdAt.toISOString(),
    };
  }

  private async listServerGrants(
    scope: GrantScope,
    scopeId: string,
  ): Promise<ServerGrantDto[]> {
    await this.requireScope(scope, scopeId);
    const rows = await this.database.selectFrom('iam.server_grants').selectAll()
      .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
      .execute();
    return rows.map((row) => this.serverGrantToDto(this.toServerGrant(row)));
  }

  private async upsertServerGrant(
    scope: GrantScope,
    scopeId: string,
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
    const result = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      if (actorId) await this.requireGrantActor(transaction, actorId);
      await this.requireScopeInTransaction(transaction, scope, scopeId);
      if (!await transaction.selectFrom('infra.servers')
        .select('id')
        .where('id', '=', serverId)
        .executeTakeFirst()) {
        throw new NotFoundException('Server not found');
      }
      const existing = await transaction.selectFrom('iam.server_grants').selectAll()
        .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      const gpuMode = 'gpuMode' in dto
        ? dto.gpuMode ?? null
        : existing?.gpu_mode ?? null;
      const values = {
        cpu_millis: 'cpuMillis' in dto ? dto.cpuMillis ?? null : existing?.cpu_millis ?? null,
        mem_bytes: 'memBytes' in dto ? dto.memBytes ?? null : existing?.mem_bytes ?? null,
        disk_bytes: 'diskBytes' in dto ? dto.diskBytes ?? null : existing?.disk_bytes ?? null,
        gpu_mode: gpuMode,
        // The public contract uses [] with `none`/`all`, while PostgreSQL
        // stores indices only for the `indices` discriminator.
        gpu_indices: 'gpuMode' in dto
          ? gpuMode === GpuGrantMode.Indices
            ? dto.gpuIndices ?? []
            : null
          : existing?.gpu_indices ?? null,
        updated_at: new Date(),
      };
      const row = existing
        ? await transaction.updateTable('iam.server_grants').set(values)
          .where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow()
        : await transaction.insertInto('iam.server_grants').values({
          id: uuidv4(),
          user_id: scope === 'user' ? scopeId : null,
          group_id: scope === 'group' ? scopeId : null,
          server_id: serverId,
          ...values,
        }).returningAll().executeTakeFirstOrThrow();
      const grant = this.toServerGrant(row);
      const userIds = scope === 'user'
        ? [scopeId]
        : (await transaction.selectFrom('iam.group_members')
            .select('user_id')
            .where('group_id', '=', scopeId)
            .execute()).map((member) => member.user_id);
      this.assertQuotaFanoutWithinLimit(userIds.length, 'upsert-server-grant');
      const taskIds = await this.syncUserQuotasInTransaction(
        transaction,
        userIds.map((userId) => ({ userId, serverId })),
        actorId ?? null,
      );
      await this.auditService.append(
        transaction,
        actorId ?? null,
        AuditAction.UpsertServerGrant,
        scopeId,
        scope,
        { serverId, ...dto },
      );
      return { grant, userIds, taskIds };
    });
    await this.accessResolver.authorizationCommitted(result.userIds);
    return this.withTaskIds(
      this.serverGrantToDto(result.grant),
      result.taskIds,
    );
  }

  private async deleteServerGrant(
    scope: GrantScope,
    scopeId: string,
    serverId: string,
    actorId?: string,
  ): Promise<TaskIdsResult> {
    const result = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      if (actorId) await this.requireGrantActor(transaction, actorId);
      await this.requireScopeInTransaction(transaction, scope, scopeId);
      const users = scope === 'user'
        ? [scopeId]
        : (await transaction.selectFrom('iam.group_members').select('user_id')
          .where('group_id', '=', scopeId).execute()).map((row) => row.user_id);
      this.assertQuotaFanoutWithinLimit(users.length, 'delete-server-grant');
      const deleted = await transaction.deleteFrom('iam.server_grants')
        .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
        .where('server_id', '=', serverId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return { changed: false, users, taskIds: [] as string[] };
      await this.revocationGuard.assertServerAccessRevocationSafe(
        transaction,
        users.map((userId) => ({ userId, serverId })),
      );
      const taskIds = await this.syncUserQuotasInTransaction(
        transaction,
        users.map((userId) => ({ userId, serverId })),
        actorId ?? null,
      );
      await this.auditService.append(
        transaction,
        actorId ?? null,
        AuditAction.DeleteServerGrant,
        scopeId,
        scope,
        { serverId },
      );
      return { changed: true, users, taskIds };
    });
    if (!result.changed) return { taskIds: [] };
    await this.accessResolver.authorizationCommitted(result.users);
    return { taskIds: result.taskIds };
  }

  private async listImageGrants(
    scope: GrantScope,
    scopeId: string,
  ): Promise<ImageGrantDto[]> {
    await this.requireScope(scope, scopeId);
    const rows = await this.database.selectFrom('iam.image_grants').selectAll()
      .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
      .execute();
    return rows.map((row) => this.imageGrantToDto(this.toImageGrant(row)));
  }

  private async addImageGrant(
    scope: GrantScope,
    scopeId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<ImageGrantDto> {
    const grant = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      if (actorId) await this.requireGrantActor(transaction, actorId);
      await this.requireScopeInTransaction(transaction, scope, scopeId);
      const existing = await transaction.selectFrom('iam.image_grants').selectAll()
        .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
        .where('image_id', '=', imageId)
        .where('server_id', '=', serverId)
        .executeTakeFirst();
      const row = existing ?? await transaction.insertInto('iam.image_grants').values({
        id: uuidv4(),
        user_id: scope === 'user' ? scopeId : null,
        group_id: scope === 'group' ? scopeId : null,
        image_id: imageId,
        server_id: serverId,
      }).returningAll().executeTakeFirstOrThrow();
      const grant = this.toImageGrant(row);
      await this.auditService.append(
        transaction,
        actorId ?? null,
        AuditAction.UpsertImageGrant,
        scopeId,
        scope,
        { imageId, serverId },
      );
      return grant;
    });
    const userIds = scope === 'user' ? [scopeId] : await this.groupUserIds(scopeId);
    await this.accessResolver.authorizationCommitted(userIds);
    return this.imageGrantToDto(grant);
  }

  private async deleteImageGrant(
    scope: GrantScope,
    scopeId: string,
    imageId: string,
    serverId: string,
    actorId?: string,
  ): Promise<void> {
    const changed = await this.transactions.run(async (transaction) => {
      await this.lockPolicy(transaction);
      if (actorId) await this.requireGrantActor(transaction, actorId);
      await this.requireScopeInTransaction(transaction, scope, scopeId);
      const changed = Boolean(await transaction.deleteFrom('iam.image_grants')
        .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
        .where('image_id', '=', imageId)
        .where('server_id', '=', serverId)
        .returning('id')
        .executeTakeFirst());
      if (changed) {
        await this.auditService.append(
          transaction,
          actorId ?? null,
          AuditAction.DeleteImageGrant,
          scopeId,
          scope,
          { imageId, serverId },
        );
      }
      return changed;
    });
    if (!changed) return;
    const userIds = scope === 'user' ? [scopeId] : await this.groupUserIds(scopeId);
    await this.accessResolver.authorizationCommitted(userIds);
  }

  private async ensureSystemGroup(
    transaction: IamTransaction,
    systemKey: SystemGroupKey,
    name: string,
    priority: number,
    capabilities: Capability[],
  ): Promise<IamGroup> {
    const byKey = await transaction.selectFrom('iam.groups').selectAll()
      .where('system_key', '=', systemKey).executeTakeFirst();
    if (byKey) {
      const group = this.toGroup(byKey);
      if (group.name !== name || group.priority !== priority
        || !group.isSystem || !this.sameCapabilities(group.capabilities, capabilities)) {
        throw new ConflictException({
          code: 'SYSTEM_GROUP_METADATA_DRIFT',
          message: `Built-in group ${systemKey} has invalid immutable metadata`,
          groupId: group.id,
        });
      }
      return group;
    }
    const byName = await transaction.selectFrom('iam.groups').selectAll()
      .where('name', '=', name).executeTakeFirst();
    if (byName) {
      throw new ConflictException({
        code: 'SYSTEM_GROUP_NAME_CONFLICT',
        message: `The reserved built-in group name ${name} is occupied`,
        groupId: byName.id,
      });
    }
    const inserted = await transaction.insertInto('iam.groups').values({
      id: uuidv4(),
      name,
      description: null,
      priority,
      is_system: true,
      system_key: systemKey,
      capabilities,
      revision: 1,
    }).returningAll().executeTakeFirstOrThrow();
    await sql`SELECT iam.bump_policy_epoch()`.execute(transaction);
    return this.toGroup(inserted);
  }

  private async assertActorMayMutateGroup(
    transaction: IamTransaction,
    actorId: string,
    current: IamGroup,
    desiredCapabilities: Capability[],
    resourceSensitive: boolean,
  ): Promise<void> {
    await this.accessResolver.assertActorCapabilitiesInTransaction(
      transaction,
      actorId,
      [Capability.ManageGroups, ...current.capabilities, ...desiredCapabilities],
    );
    if (!resourceSensitive) return;
    const hasGrant = await Promise.all([
      transaction.selectFrom('iam.server_grants').select('id')
        .where('group_id', '=', current.id).executeTakeFirst(),
      transaction.selectFrom('iam.image_grants').select('id')
        .where('group_id', '=', current.id).executeTakeFirst(),
      transaction.selectFrom('iam.mount_source_grants').select('id')
        .where('group_id', '=', current.id).executeTakeFirst(),
    ]);
    if (hasGrant.some(Boolean)) {
      await this.accessResolver.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageGrants],
      );
    }
  }

  private requireGrantActor(transaction: IamTransaction, actorId: string): Promise<Set<Capability>> {
    return this.accessResolver.assertActorCapabilitiesInTransaction(
      transaction,
      actorId,
      [Capability.ManageGrants],
    );
  }

  private async syncUserQuotasInTransaction(
    transaction: IamTransaction,
    pairs: readonly { userId: string; serverId: string }[],
    requestedBy: string | null,
  ): Promise<string[]> {
    const unique = [...new Map(pairs.map((pair) => [
      `${pair.userId}\0${pair.serverId}`,
      pair,
    ])).values()];
    if (unique.length === 0) return [];
    const grants = await this.accessResolver.resolveServerPairsInTransaction(
      transaction,
      unique,
    );
    const grantedPairs = unique.flatMap((pair) => {
      const grant = grants.get(`${pair.userId}\0${pair.serverId}`);
      return grant ? [{ ...pair, grant }] : [];
    });
    if (grantedPairs.length === 0) return [];
    const users = await transaction.selectFrom('iam.users')
      .select(['id', 'numeric_id', 'status'])
      .where('id', 'in', [...new Set(grantedPairs.map((pair) => pair.userId))])
      .execute();
    const usersById = new Map(users.map((user) => [user.id, user]));
    const requests = grantedPairs.map(({ userId, serverId, grant }) => {
      const user = usersById.get(userId);
      if (!user || user.status === UserStatus.Deleted || user.status === UserStatus.Deleting) {
        throw new ConflictException({
          code: user?.status === UserStatus.Deleting ? 'USER_DELETING' : 'USER_DELETED',
          message: 'A deleted or deleting user cannot receive quota intent',
          userId,
        });
      }
      if (!Number.isSafeInteger(user.numeric_id) || user.numeric_id <= 0) {
        throw new ConflictException(`User ${userId} has no numeric quota identity`);
      }
      return {
        serverId,
        userId,
        numericUserId: user.numeric_id,
        diskBytes: grant.diskBytes,
        requestedBy,
      };
    });
    return this.quotaDispatch.applyManyInTransaction(
      transaction,
      requests,
    );
  }

  private assertQuotaFanoutWithinLimit(count: number, operation: string): void {
    if (count <= MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION) return;
    throw new ConflictException({
      code: 'QUOTA_FANOUT_LIMIT',
      message:
        `Operation would enqueue ${count} quota intents in one transaction; `
        + `maximum is ${MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION}`,
      operation,
      requestedIntents: count,
      maxIntents: MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION,
    });
  }

  private async requireScope(scope: GrantScope, scopeId: string): Promise<void> {
    await this.transactions.run((transaction) =>
      this.requireScopeInTransaction(transaction, scope, scopeId));
  }

  private requireScopeInTransaction(
    transaction: IamTransaction,
    scope: GrantScope,
    scopeId: string,
  ): Promise<IamGroup | { id: string }> {
    return scope === 'group'
      ? this.requireGroup(transaction, scopeId)
      : this.requireUser(transaction, scopeId);
  }

  private async requireGroup(
    transaction: IamTransaction,
    groupId: string,
  ): Promise<IamGroup> {
    const row = await transaction.selectFrom('iam.groups').selectAll()
      .where('id', '=', groupId).executeTakeFirst();
    if (!row) throw new NotFoundException('Group not found');
    return this.toGroup(row);
  }

  private async requireUser(
    transaction: IamTransaction,
    userId: string,
    activeOnly = true,
  ): Promise<{ id: string }> {
    const row = await transaction.selectFrom('iam.users').select(['id', 'status'])
      .where('id', '=', userId).executeTakeFirst();
    if (!row || row.status === UserStatus.Deleted
      || (activeOnly && row.status !== UserStatus.Active)) {
      throw new NotFoundException('User not found');
    }
    return row;
  }

  private async requireUserScope(userId: string): Promise<void> {
    await this.transactions.run((transaction) => this.requireUser(transaction, userId));
  }

  private async lockPolicy(transaction: IamTransaction): Promise<void> {
    await transaction.selectFrom('iam.policy_state').select('policy_epoch')
      .where('singleton', '=', true).forUpdate().executeTakeFirstOrThrow();
  }

  private async groupUserIds(groupId: string): Promise<string[]> {
    return (await this.database.selectFrom('iam.group_members').select('user_id')
      .where('group_id', '=', groupId).execute()).map((row) => row.user_id);
  }

  private assertOrdinaryGroupName(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 128) {
      throw new ConflictException('Group name must contain 1-128 non-whitespace characters');
    }
    if (Object.values(SystemGroupKey).includes(trimmed.toLowerCase() as SystemGroupKey)
      || ['Administrators', 'Operators', 'Users'].includes(trimmed)) {
      throw new ConflictException({
        code: 'SYSTEM_GROUP_NAME_RESERVED',
        message: 'Built-in group names are reserved',
      });
    }
  }

  private sameCapabilities(
    left: readonly Capability[],
    right: readonly Capability[],
  ): boolean {
    return left.length === right.length
      && new Set(left).size === new Set(right).size
      && left.every((capability) => right.includes(capability));
  }

  private withTaskIds<T extends object>(value: T, taskIds: string[]): T & TaskIdsResult {
    return Object.assign(value, { taskIds: [...new Set(taskIds)] });
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

  private toServerGrant(row: {
    id: string;
    user_id: string | null;
    group_id: string | null;
    server_id: string;
    cpu_millis: number | null;
    mem_bytes: string | null;
    disk_bytes: string | null;
    gpu_mode: string | null;
    gpu_indices: number[] | null;
    created_at: Date;
    updated_at: Date;
  }): ServerGrant {
    const scope: GrantScope = row.user_id ? 'user' : 'group';
    return {
      id: row.id,
      scope,
      scopeId: (row.user_id ?? row.group_id)!,
      serverId: row.server_id,
      cpuMillis: row.cpu_millis,
      memBytes: row.mem_bytes === null ? null : Number(row.mem_bytes),
      diskBytes: row.disk_bytes === null ? null : Number(row.disk_bytes),
      gpuMode: row.gpu_mode as GpuGrantMode | null,
      gpuIndices: row.gpu_indices,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toImageGrant(row: {
    id: string;
    user_id: string | null;
    group_id: string | null;
    image_id: string;
    server_id: string;
    created_at: Date;
  }): ImageGrant {
    const scope: GrantScope = row.user_id ? 'user' : 'group';
    return {
      id: row.id,
      scope,
      scopeId: (row.user_id ?? row.group_id)!,
      imageId: row.image_id,
      serverId: row.server_id,
      createdAt: row.created_at,
    };
  }
}
