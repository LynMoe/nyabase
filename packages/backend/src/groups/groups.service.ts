import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  Capability,
  FailureCode,
  SystemGroupKey,
  UserStatus,
  type GroupDto,
  type GroupMemberDto,
  type ServerGrantDto,
  type SharedBackendGrantDto,
  type StoragePoolGrantDto,
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
import { ExtensionDeviceClaimsRepository } from '../server-card-extensions/claims.repository.js';
import { asJsonObject } from '../server-card-extensions/json.js';
import { ServerCardExtensionRegistry } from '../server-card-extensions/registry.js';

type GrantScope = 'user' | 'group';
type GrantExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export const SYSTEM_ACTOR_USERNAME = 'nyabase-system';
export const SYSTEM_ACTOR_DISPLAY_NAME = 'Nyabase System';
export const SYSTEM_ACTOR_PREFERRED_NUMERIC_ID = 4096;
const SYSTEM_ACTOR_NUMERIC_ID_MAX = 4096;
/** Numeric ids commonly hardcoded in tests; skip them when 4096 is taken. */
const TEST_RESERVED_NUMERIC_IDS = new Set([1, 100, 1001, 3001]);
/**
 * Same unusable Argon2id sentinel as AuthService's dummy hash. Not a login
 * password; nyabase-system stays disabled and never joins a human group.
 */
const UNUSABLE_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$DCw8KRwf+V7pMnhiRFOb6g$KSjgFxwH2WqyoDT2q5Hz0Z18Zv/+eAHbnRgKiC6dI5A';

export function pickSystemActorNumericId(used: Iterable<number>): number {
  const occupied = new Set(used);
  if (!occupied.has(SYSTEM_ACTOR_PREFERRED_NUMERIC_ID)) {
    return SYSTEM_ACTOR_PREFERRED_NUMERIC_ID;
  }
  for (let id = SYSTEM_ACTOR_NUMERIC_ID_MAX; id >= 1; id -= 1) {
    if (!occupied.has(id) && !TEST_RESERVED_NUMERIC_IDS.has(id)) return id;
  }
  for (let id = SYSTEM_ACTOR_NUMERIC_ID_MAX; id >= 1; id -= 1) {
    if (!occupied.has(id)) return id;
  }
  throw new ConflictException({
    code: 'USER_LIFETIME_CAPACITY_REACHED',
    message: 'No free numeric_id remains for nyabase-system',
  });
}

interface ServerGrantInput {
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  extensionGrants: Record<string, unknown>;
  expiresAt: string | null;
}

@Injectable()
export class GroupsService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
    private readonly revocation: AccessRevocationGuardService,
    @Optional() private readonly extensions?: ServerCardExtensionRegistry,
    @Optional() private readonly extensionClaims?: ExtensionDeviceClaimsRepository,
  ) {}

  async findAll(): Promise<GroupDto[]> {
    const rows = await this.database.selectFrom('iam.groups')
      .selectAll()
      .orderBy('priority', 'desc')
      .orderBy('name')
      .execute();
    const members = await this.database.selectFrom('iam.group_members as member')
      .innerJoin('iam.users as user', 'user.id', 'member.user_id')
      .select([
        'member.group_id',
        'user.id as user_id',
        'user.username',
        'user.display_name',
      ])
      .execute();
    const byGroup = new Map<string, GroupMemberDto[]>();
    for (const member of members) {
      const list = byGroup.get(member.group_id) ?? [];
      list.push({
        userId: member.user_id,
        username: member.username,
        displayName: member.display_name,
      });
      byGroup.set(member.group_id, list);
    }
    return rows.map((row) => ({
      ...this.toDto(this.toGroup(row)),
      members: byGroup.get(row.id) ?? [],
      memberCount: byGroup.get(row.id)?.length ?? 0,
    }));
  }

  async findById(id: string): Promise<IamGroup> {
    const row = await this.database.selectFrom('iam.groups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Group not found');
    return this.toGroup(row);
  }

  async create(
    input: {
      name: string;
      description?: string;
      priority?: number;
      capabilities?: Capability[];
    },
    actorId?: string,
  ): Promise<GroupDto> {
    const group = await this.transactions.run(async (transaction) => {
      if (actorId) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGroups, ...(input.capabilities ?? [])],
        );
      }
      const duplicate = await transaction.selectFrom('iam.groups')
        .select('id')
        .where('name', '=', input.name)
        .executeTakeFirst();
      if (duplicate) throw new ConflictException('Group name already exists');
      const row = await transaction.insertInto('iam.groups')
        .values({
          id: randomUUID(),
          name: input.name,
          description: input.description ?? null,
          priority: input.priority ?? 0,
          is_system: false,
          system_key: null,
          capabilities: input.capabilities ?? [],
          revision: 1,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.append(
        transaction,
        actorId ?? null,
        AuditAction.CreateGroup,
        row.id,
        'group',
        { name: row.name },
      );
      return this.toGroup(row);
    });
    await this.access.authorizationCommitted();
    return this.toDto(group);
  }

  async update(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      priority?: number;
      capabilities?: Capability[];
    },
    actorId: string | undefined,
    expectedRevision: number,
  ): Promise<GroupDto> {
    const result = await this.transactions.run(async (transaction) => {
      const current = await transaction.selectFrom('iam.groups')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new NotFoundException('Group not found');
      const group = this.toGroup(current);
      if (group.isSystem && (
        input.name !== undefined
        || input.priority !== undefined
        || input.capabilities !== undefined
      )) {
        throw new ForbiddenException({
          code: 'SYSTEM_GROUP_METADATA_IMMUTABLE',
          message: 'System group metadata is immutable',
        });
      }
      if (actorId) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGroups, ...group.capabilities, ...(input.capabilities ?? [])],
        );
        if (input.priority !== undefined || input.capabilities !== undefined) {
          const [serverGrant, poolGrant, backendGrant] = await Promise.all([
            transaction.selectFrom('iam.server_grants').select('id')
              .where('group_id', '=', id).executeTakeFirst(),
            transaction.selectFrom('iam.storage_pool_grants').select('id')
              .where('group_id', '=', id).executeTakeFirst(),
            transaction.selectFrom('iam.shared_backend_grants').select('id')
              .where('group_id', '=', id).executeTakeFirst(),
          ]);
          if (serverGrant || poolGrant || backendGrant) {
            await this.access.assertActorCapabilitiesInTransaction(
              transaction,
              actorId,
              [Capability.ManageGrants],
            );
          }
        }
      }
      if (group.revision !== expectedRevision) {
        throw new ConflictException({ code: 'REVISION_CONFLICT', current: this.toDto(group) });
      }
      const row = await transaction.updateTable('iam.groups')
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
          revision: String(expectedRevision + 1),
        })
        .where('id', '=', id)
        .where('revision', '=', String(expectedRevision))
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new ConflictException({ code: 'REVISION_CONFLICT' });
      const users = await this.groupUserIds(id, transaction);
      await this.audit.append(transaction, actorId ?? null, AuditAction.UpdateGroup, id, 'group', input);
      return { group: this.toGroup(row), users };
    });
    await this.access.authorizationCommitted(result.users);
    return this.toDto(result.group);
  }

  async delete(id: string, actorId?: string): Promise<{ deleted: boolean }> {
    const result = await this.transactions.run(async (transaction) => {
      const group = await this.requireGroup(transaction, id);
      if (group.isSystem) throw new ForbiddenException('Cannot delete a system group');
      if (actorId) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGroups, Capability.ManageGrants, ...group.capabilities],
        );
      }
      const users = await this.groupUserIds(id, transaction);
      const grants = await transaction.selectFrom('iam.server_grants')
        .select('server_id')
        .where('group_id', '=', id)
        .execute();
      const poolGrants = await transaction.selectFrom('iam.storage_pool_grants')
        .select('pool_id')
        .where('group_id', '=', id)
        .execute();
      const backendGrants = await transaction.selectFrom('iam.shared_backend_grants')
        .select('shared_backend_id')
        .where('group_id', '=', id)
        .execute();
      await transaction.deleteFrom('iam.group_members').where('group_id', '=', id).execute();
      await transaction.deleteFrom('iam.server_grants').where('group_id', '=', id).execute();
      await transaction.deleteFrom('iam.storage_pool_grants').where('group_id', '=', id).execute();
      await transaction.deleteFrom('iam.shared_backend_grants').where('group_id', '=', id).execute();
      await this.revocation.assertServerAccessRevocationSafe(
        transaction,
        users.flatMap((userId) => grants.map((grant) => ({ userId, serverId: grant.server_id }))),
      );
      await this.revocation.assertStoragePoolAccessRevocationSafe(
        transaction,
        users.flatMap((userId) => poolGrants.map((grant) => ({ userId, poolId: grant.pool_id }))),
      );
      await this.revocation.assertSharedBackendAccessRevocationSafe(
        transaction,
        users.flatMap((userId) => backendGrants.map((grant) => ({
          userId,
          sharedBackendId: grant.shared_backend_id,
        }))),
      );
      await transaction.deleteFrom('iam.groups').where('id', '=', id).execute();
      await this.audit.append(transaction, actorId ?? null, AuditAction.DeleteGroup, id, 'group');
      return { users };
    });
    await this.access.authorizationCommitted(result.users);
    return { deleted: true };
  }

  async listMembers(groupId: string): Promise<GroupMemberDto[]> {
    await this.findById(groupId);
    return this.database.selectFrom('iam.group_members as member')
      .innerJoin('iam.users as user', 'user.id', 'member.user_id')
      .select([
        'user.id as userId',
        'user.username',
        'user.display_name as displayName',
      ])
      .where('member.group_id', '=', groupId)
      .execute();
  }

  async addMember(groupId: string, userId: string, actorId?: string): Promise<{ changed: boolean }> {
    const result = await this.transactions.run(async (transaction) => {
      const group = await this.requireGroup(transaction, groupId);
      if (actorId) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGroups, ...group.capabilities],
        );
        const [serverGrant, poolGrant, backendGrant] = await Promise.all([
          transaction.selectFrom('iam.server_grants').select('id')
            .where('group_id', '=', groupId).executeTakeFirst(),
          transaction.selectFrom('iam.storage_pool_grants').select('id')
            .where('group_id', '=', groupId).executeTakeFirst(),
          transaction.selectFrom('iam.shared_backend_grants').select('id')
            .where('group_id', '=', groupId).executeTakeFirst(),
        ]);
        if (serverGrant || poolGrant || backendGrant) {
          await this.access.assertActorCapabilitiesInTransaction(
            transaction,
            actorId,
            [Capability.ManageGrants],
          );
        }
      }
      await this.requireUser(transaction, userId);
      const row = await transaction.insertInto('iam.group_members')
        .values({ id: randomUUID(), group_id: groupId, user_id: userId })
        .onConflict((conflict) => conflict.columns(['group_id', 'user_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;
      await this.audit.append(
        transaction,
        actorId ?? null,
        AuditAction.AddGroupMember,
        groupId,
        'group',
        { userId },
      );
      return true;
    });
    if (result) await this.access.authorizationCommitted([userId]);
    return { changed: result };
  }

  async removeMember(groupId: string, userId: string, actorId?: string): Promise<{ changed: boolean }> {
    const result = await this.transactions.run(async (transaction) => {
      const group = await this.requireGroup(transaction, groupId);
      if (actorId) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGroups, ...group.capabilities],
        );
        const [serverGrant, poolGrant, backendGrant] = await Promise.all([
          transaction.selectFrom('iam.server_grants').select('id')
            .where('group_id', '=', groupId).executeTakeFirst(),
          transaction.selectFrom('iam.storage_pool_grants').select('id')
            .where('group_id', '=', groupId).executeTakeFirst(),
          transaction.selectFrom('iam.shared_backend_grants').select('id')
            .where('group_id', '=', groupId).executeTakeFirst(),
        ]);
        if (serverGrant || poolGrant || backendGrant) {
          await this.access.assertActorCapabilitiesInTransaction(
            transaction,
            actorId,
            [Capability.ManageGrants],
          );
        }
      }
      if (group.systemKey === SystemGroupKey.Administrators) {
        await this.access.assertNotFinalActiveAdministratorInTransaction(transaction, userId);
      }
      const deleted = await transaction.deleteFrom('iam.group_members')
        .where('group_id', '=', groupId)
        .where('user_id', '=', userId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return false;
      await this.revocation.assertServerAccessRevocationSafe(
        transaction,
        (await transaction.selectFrom('iam.server_grants')
          .select('server_id')
          .where('group_id', '=', groupId)
          .execute()).map((grant) => ({ userId, serverId: grant.server_id })),
      );
      await this.revocation.assertStoragePoolAccessRevocationSafe(
        transaction,
        (await transaction.selectFrom('iam.storage_pool_grants')
          .select('pool_id')
          .where('group_id', '=', groupId)
          .execute()).map((grant) => ({ userId, poolId: grant.pool_id })),
      );
      await this.revocation.assertSharedBackendAccessRevocationSafe(
        transaction,
        (await transaction.selectFrom('iam.shared_backend_grants')
          .select('shared_backend_id')
          .where('group_id', '=', groupId)
          .execute()).map((grant) => ({
          userId,
          sharedBackendId: grant.shared_backend_id,
        })),
      );
      await this.audit.append(
        transaction,
        actorId ?? null,
        AuditAction.RemoveGroupMember,
        groupId,
        'group',
        { userId },
      );
      return true;
    });
    if (result) await this.access.authorizationCommitted([userId]);
    return { changed: result };
  }

  async ensureUserInSystemGroup(systemKey: SystemGroupKey, userId: string): Promise<void> {
    const group = await this.database.selectFrom('iam.groups')
      .select('id')
      .where('system_key', '=', systemKey)
      .executeTakeFirst();
    if (!group) throw new NotFoundException('System group not found');
    await this.addMember(group.id, userId);
  }

  async ensureUserNotInSystemGroup(systemKey: SystemGroupKey, userId: string): Promise<void> {
    const group = await this.database.selectFrom('iam.groups')
      .select('id')
      .where('system_key', '=', systemKey)
      .executeTakeFirst();
    if (group) await this.removeMember(group.id, userId);
  }

  async deleteUserPermanently(userId: string, actorId: string): Promise<{ deleted: boolean }> {
    const result = await this.transactions.run(async (transaction) => {
      await this.access.assertActorMayAdministerUserInTransaction(transaction, actorId, userId);
      const user = await transaction.selectFrom('iam.users')
        .select(['id', 'status'])
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user || user.status === UserStatus.Deleted) throw new NotFoundException('User not found');
      const dependency = await transaction.selectFrom('control.authorization_dependencies')
        .select(['dependency_kind', 'dependency_id'])
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (dependency) {
        throw new ConflictException({
          code: 'GRANT_REVOCATION_BLOCKED',
          message: 'Delete the user resources before deleting the account',
          dependencyKind: dependency.dependency_kind,
          dependencyId: dependency.dependency_id,
        });
      }
      await transaction.deleteFrom('iam.refresh_tokens').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.api_tokens').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.ssh_public_keys').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.group_members').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.server_grants').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.storage_pool_grants').where('user_id', '=', userId).execute();
      await transaction.deleteFrom('iam.shared_backend_grants').where('user_id', '=', userId).execute();
      await transaction.updateTable('iam.users')
        .set({ status: UserStatus.Deleted })
        .where('id', '=', userId)
        .execute();
      await this.audit.append(transaction, actorId, AuditAction.DeleteUser, userId, 'user');
      return true;
    });
    await this.access.authorizationCommitted([userId]);
    return { deleted: result };
  }

  async assertUserScopeExists(userId: string): Promise<void> {
    await this.requireUser(this.database, userId);
  }

  listGroupServerGrants(id: string): Promise<ServerGrantDto[]> {
    return this.listServerGrants('group', id);
  }

  upsertGroupServerGrant(
    id: string,
    serverId: string,
    input: ServerGrantInput,
    actorId?: string,
  ): Promise<ServerGrantDto> {
    return this.upsertServerGrant('group', id, serverId, input, actorId);
  }

  deleteGroupServerGrant(id: string, serverId: string, actorId?: string): Promise<void> {
    return this.deleteServerGrant('group', id, serverId, actorId);
  }

  listUserServerGrants(id: string): Promise<ServerGrantDto[]> {
    return this.listServerGrants('user', id);
  }

  upsertUserServerGrant(
    id: string,
    serverId: string,
    input: ServerGrantInput,
    actorId?: string,
  ): Promise<ServerGrantDto> {
    return this.upsertServerGrant('user', id, serverId, input, actorId);
  }

  deleteUserServerGrant(id: string, serverId: string, actorId?: string): Promise<void> {
    return this.deleteServerGrant('user', id, serverId, actorId);
  }

  listGroupStoragePoolGrants(id: string): Promise<StoragePoolGrantDto[]> {
    return this.listStoragePoolGrants('group', id);
  }

  listUserStoragePoolGrants(id: string): Promise<StoragePoolGrantDto[]> {
    return this.listStoragePoolGrants('user', id);
  }

  upsertGroupStoragePoolGrant(id: string, poolId: string, expiresAt: string | null, actorId?: string) {
    return this.upsertStoragePoolGrant('group', id, poolId, expiresAt, actorId);
  }

  upsertUserStoragePoolGrant(id: string, poolId: string, expiresAt: string | null, actorId?: string) {
    return this.upsertStoragePoolGrant('user', id, poolId, expiresAt, actorId);
  }

  deleteGroupStoragePoolGrant(id: string, poolId: string, actorId?: string) {
    return this.deleteStoragePoolGrant('group', id, poolId, actorId);
  }

  deleteUserStoragePoolGrant(id: string, poolId: string, actorId?: string) {
    return this.deleteStoragePoolGrant('user', id, poolId, actorId);
  }

  listGroupSharedBackendGrants(id: string): Promise<SharedBackendGrantDto[]> {
    return this.listSharedBackendGrants('group', id);
  }

  listUserSharedBackendGrants(id: string): Promise<SharedBackendGrantDto[]> {
    return this.listSharedBackendGrants('user', id);
  }

  upsertGroupSharedBackendGrant(
    id: string,
    backendId: string,
    input: { limitBytes: number; expiresAt: string | null },
    actorId?: string,
  ) {
    return this.upsertSharedBackendGrant('group', id, backendId, input, actorId);
  }

  upsertUserSharedBackendGrant(
    id: string,
    backendId: string,
    input: { limitBytes: number; expiresAt: string | null },
    actorId?: string,
  ) {
    return this.upsertSharedBackendGrant('user', id, backendId, input, actorId);
  }

  deleteGroupSharedBackendGrant(id: string, backendId: string, actorId?: string) {
    return this.deleteSharedBackendGrant('group', id, backendId, actorId);
  }

  deleteUserSharedBackendGrant(id: string, backendId: string, actorId?: string) {
    return this.deleteSharedBackendGrant('user', id, backendId, actorId);
  }

  async ensureSystemGroups(): Promise<{ admins: IamGroup; operators: IamGroup; users: IamGroup }> {
    return this.transactions.run(async (transaction) => {
      // This row serializes IAM mutations and is required by the authorization
      // triggers used by system-group and admin creation.
      await transaction.insertInto('iam.policy_state')
        .values({ singleton: true, policy_epoch: 0 })
        .onConflict((conflict) => conflict.column('singleton').doNothing())
        .execute();
      const result = {
        admins: await this.ensureSystemGroup(
          transaction,
          SystemGroupKey.Administrators,
          'Administrators',
          1000,
          Object.values(Capability),
        ),
        operators: await this.ensureSystemGroup(
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
        ),
        users: await this.ensureSystemGroup(
          transaction,
          SystemGroupKey.Users,
          'Users',
          10,
          [],
        ),
      };
      await this.ensureSystemActor(transaction);
      return result;
    });
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

  private async upsertServerGrant(
    scope: GrantScope,
    scopeId: string,
    serverId: string,
    input: ServerGrantInput,
    actorId?: string,
  ): Promise<ServerGrantDto> {
    const result = await this.transactions.run(async (transaction) => {
      if (actorId) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGrants],
        );
      }
      await this.requireScope(transaction, scope, scopeId);
      const server = await transaction.selectFrom('infra.servers')
        .select('id')
        .where('id', '=', serverId)
        .executeTakeFirst();
      if (!server) throw new NotFoundException('Server not found');
      const parsedGrants: Record<string, unknown> = {};
      for (const [extensionId, payload] of Object.entries(input.extensionGrants ?? {})) {
        const ext = this.extensions?.get(extensionId);
        if (!ext) {
          throw new BadRequestException({
            code: FailureCode.ExtensionUnknown,
            message: 'Unknown server-card extension',
            details: { extensionId },
          });
        }
        const enabled = this.extensionClaims
          ? await this.extensionClaims.isEnabled(serverId, extensionId, transaction)
          : false;
        if (!enabled) {
          throw new ConflictException({
            code: FailureCode.ExtensionGrantNotApplicable,
            message: 'The server extension is not enabled',
            details: { extensionId, serverId },
          });
        }
        parsedGrants[extensionId] = ext.parseGrantPayload(payload);
      }
      const values = {
        cpu_millis: input.cpuMillis,
        mem_bytes: input.memBytes,
        disk_bytes: input.diskBytes,
        extension_grants: parsedGrants,
        expires_at: input.expiresAt,
        updated_at: new Date(),
      };
      const row = scope === 'user'
        ? await transaction.insertInto('iam.server_grants').values({
          id: randomUUID(),
          user_id: scopeId,
          group_id: null,
          server_id: serverId,
          ...values,
        })
          .onConflict((conflict) => conflict
            .columns(['user_id', 'server_id'])
            .where('user_id', 'is not', null)
            .doUpdateSet(values))
          .returningAll()
          .executeTakeFirstOrThrow()
        : await transaction.insertInto('iam.server_grants').values({
          id: randomUUID(),
          user_id: null,
          group_id: scopeId,
          server_id: serverId,
          ...values,
        })
          .onConflict((conflict) => conflict
            .columns(['group_id', 'server_id'])
            .where('group_id', 'is not', null)
            .doUpdateSet(values))
          .returningAll()
          .executeTakeFirstOrThrow();
      const users = scope === 'user' ? [scopeId] : await this.groupUserIds(scopeId, transaction);
      await this.revocation.assertServerAccessRevocationSafe(
        transaction,
        users.map((userId) => ({ userId, serverId })),
      );
      await this.audit.append(transaction, actorId ?? null, AuditAction.UpsertServerGrant, scopeId, scope, {
        serverId,
      });
      return { row, users };
    });
    await this.access.authorizationCommitted(result.users);
    return this.serverGrantDto(result.row);
  }

  private async deleteServerGrant(
    scope: GrantScope,
    scopeId: string,
    serverId: string,
    actorId?: string,
  ): Promise<void> {
    const users = await this.transactions.run(async (transaction) => {
      if (actorId) {
        await this.access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGrants],
        );
      }
      await this.requireScope(transaction, scope, scopeId);
      const userIds = scope === 'user' ? [scopeId] : await this.groupUserIds(scopeId, transaction);
      const deleted = await transaction.deleteFrom('iam.server_grants')
        .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
        .where('server_id', '=', serverId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return { userIds: [], deleted: false };
      await this.revocation.assertServerAccessRevocationSafe(
        transaction,
        userIds.map((userId) => ({ userId, serverId })),
      );
      await this.audit.append(transaction, actorId ?? null, AuditAction.DeleteServerGrant, scopeId, scope, {
        serverId,
      });
      return { userIds, deleted: true };
    });
    if (users.deleted) await this.access.authorizationCommitted(users.userIds);
  }

  private async listServerGrants(scope: GrantScope, scopeId: string): Promise<ServerGrantDto[]> {
    await this.requireScope(this.database, scope, scopeId);
    const rows = await this.database.selectFrom('iam.server_grants')
      .selectAll()
      .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
      .execute();
    return rows.map((row) => this.serverGrantDto(row));
  }

  private serverGrantDto(row: {
    id: string;
    user_id: string | null;
    group_id: string | null;
    server_id: string;
    cpu_millis: number | null;
    mem_bytes: string | number | null;
    disk_bytes: string | number | null;
    extension_grants: unknown;
    expires_at: Date | string | null;
    created_at: Date;
    updated_at: Date;
  }): ServerGrantDto {
    return {
      id: row.id,
      scope: row.user_id ? 'user' : 'group',
      scopeId: (row.user_id ?? row.group_id)!,
      serverId: row.server_id,
      cpuMillis: row.cpu_millis,
      memBytes: row.mem_bytes === null ? null : Number(row.mem_bytes),
      diskBytes: row.disk_bytes === null ? null : Number(row.disk_bytes),
      extensionGrants: asJsonObject(row.extension_grants),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async listStoragePoolGrants(scope: GrantScope, scopeId: string): Promise<StoragePoolGrantDto[]> {
    await this.requireScope(this.database, scope, scopeId);
    const rows = await this.database.selectFrom('iam.storage_pool_grants')
      .selectAll()
      .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      scope,
      scopeId,
      poolId: row.pool_id,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  private async upsertStoragePoolGrant(
    scope: GrantScope,
    scopeId: string,
    poolId: string,
    expiresAt: string | null,
    actorId?: string,
  ): Promise<StoragePoolGrantDto> {
    const result = await this.transactions.run(async (transaction) => {
      if (actorId) await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageGrants],
      );
      await this.requireScope(transaction, scope, scopeId);
      const pool = await transaction.selectFrom('infra.storage_pools')
        .select('id')
        .where('id', '=', poolId)
        .executeTakeFirst();
      if (!pool) throw new NotFoundException('Storage pool not found');
      const values = {
        expires_at: expiresAt,
        updated_at: new Date(),
      };
      const row = scope === 'user'
        ? await transaction.insertInto('iam.storage_pool_grants').values({
          id: randomUUID(),
          user_id: scopeId,
          group_id: null,
          pool_id: poolId,
          ...values,
        })
          .onConflict((conflict) => conflict
            .columns(['user_id', 'pool_id'])
            .where('user_id', 'is not', null)
            .doUpdateSet(values))
          .returningAll()
          .executeTakeFirstOrThrow()
        : await transaction.insertInto('iam.storage_pool_grants').values({
          id: randomUUID(),
          user_id: null,
          group_id: scopeId,
          pool_id: poolId,
          ...values,
        })
          .onConflict((conflict) => conflict
            .columns(['group_id', 'pool_id'])
            .where('group_id', 'is not', null)
            .doUpdateSet(values))
          .returningAll()
          .executeTakeFirstOrThrow();
      const users = scope === 'user' ? [scopeId] : await this.groupUserIds(scopeId, transaction);
      await this.revocation.assertStoragePoolAccessRevocationSafe(
        transaction,
        users.map((userId) => ({ userId, poolId })),
      );
      await this.audit.append(
        transaction,
        actorId ?? null,
        AuditAction.UpsertStoragePoolGrant,
        poolId,
        scope,
        { scopeId, poolId },
      );
      return {
        row,
        users,
      };
    });
    await this.access.authorizationCommitted(result.users);
    return {
      id: result.row.id,
      scope,
      scopeId,
      poolId: result.row.pool_id,
      expiresAt: result.row.expires_at ? new Date(result.row.expires_at).toISOString() : null,
      createdAt: result.row.created_at.toISOString(),
      updatedAt: result.row.updated_at.toISOString(),
    };
  }

  private async deleteStoragePoolGrant(scope: GrantScope, scopeId: string, poolId: string, actorId?: string): Promise<void> {
    const result = await this.transactions.run(async (transaction) => {
      if (actorId) await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageGrants],
      );
      await this.requireScope(transaction, scope, scopeId);
      const userIds = scope === 'user' ? [scopeId] : await this.groupUserIds(scopeId, transaction);
      const deleted = await transaction.deleteFrom('iam.storage_pool_grants')
        .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
        .where('pool_id', '=', poolId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return { userIds: [], deleted: false };
      await this.revocation.assertStoragePoolAccessRevocationSafe(
        transaction,
        userIds.map((userId) => ({ userId, poolId })),
      );
      await this.audit.append(
        transaction,
        actorId ?? null,
        AuditAction.DeleteStoragePoolGrant,
        poolId,
        scope,
        { scopeId, poolId },
      );
      return { userIds, deleted: true };
    });
    if (result.deleted) await this.access.authorizationCommitted(result.userIds);
  }

  private async listSharedBackendGrants(scope: GrantScope, scopeId: string): Promise<SharedBackendGrantDto[]> {
    await this.requireScope(this.database, scope, scopeId);
    const rows = await this.database.selectFrom('iam.shared_backend_grants')
      .selectAll()
      .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      scope,
      scopeId,
      sharedBackendId: row.shared_backend_id,
      limitBytes: Number(row.limit_bytes),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  private async upsertSharedBackendGrant(
    scope: GrantScope,
    scopeId: string,
    backendId: string,
    input: { limitBytes: number; expiresAt: string | null },
    actorId?: string,
  ): Promise<SharedBackendGrantDto> {
    const result = await this.transactions.run(async (transaction) => {
      if (actorId) await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageGrants],
      );
      await this.requireScope(transaction, scope, scopeId);
      const backend = await transaction.selectFrom('infra.shared_backends')
        .select('id')
        .where('id', '=', backendId)
        .executeTakeFirst();
      if (!backend) throw new NotFoundException('Shared backend not found');
      const values = {
        limit_bytes: input.limitBytes,
        expires_at: input.expiresAt,
        updated_at: new Date(),
      };
      const row = scope === 'user'
        ? await transaction.insertInto('iam.shared_backend_grants').values({
          id: randomUUID(),
          user_id: scopeId,
          group_id: null,
          shared_backend_id: backendId,
          ...values,
        })
          .onConflict((conflict) => conflict
            .columns(['user_id', 'shared_backend_id'])
            .where('user_id', 'is not', null)
            .doUpdateSet(values))
          .returningAll()
          .executeTakeFirstOrThrow()
        : await transaction.insertInto('iam.shared_backend_grants').values({
          id: randomUUID(),
          user_id: null,
          group_id: scopeId,
          shared_backend_id: backendId,
          ...values,
        })
          .onConflict((conflict) => conflict
            .columns(['group_id', 'shared_backend_id'])
            .where('group_id', 'is not', null)
            .doUpdateSet(values))
          .returningAll()
          .executeTakeFirstOrThrow();
      const users = scope === 'user' ? [scopeId] : await this.groupUserIds(scopeId, transaction);
      await this.revocation.assertSharedBackendAccessRevocationSafe(
        transaction,
        users.map((userId) => ({ userId, sharedBackendId: backendId })),
      );
      await this.audit.append(
        transaction,
        actorId ?? null,
        AuditAction.UpsertSharedBackendGrant,
        backendId,
        scope,
        { scopeId, sharedBackendId: backendId, limitBytes: input.limitBytes },
      );
      return {
        row,
        users,
      };
    });
    await this.access.authorizationCommitted(result.users);
    const row = result.row;
    return {
      id: row.id,
      scope,
      scopeId,
      sharedBackendId: row.shared_backend_id,
      limitBytes: Number(row.limit_bytes),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async deleteSharedBackendGrant(scope: GrantScope, scopeId: string, backendId: string, actorId?: string): Promise<void> {
    const result = await this.transactions.run(async (transaction) => {
      if (actorId) await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageGrants],
      );
      await this.requireScope(transaction, scope, scopeId);
      const userIds = scope === 'user' ? [scopeId] : await this.groupUserIds(scopeId, transaction);
      const deleted = await transaction.deleteFrom('iam.shared_backend_grants')
        .where(scope === 'user' ? 'user_id' : 'group_id', '=', scopeId)
        .where('shared_backend_id', '=', backendId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) return { userIds: [], deleted: false };
      await this.revocation.assertSharedBackendAccessRevocationSafe(
        transaction,
        userIds.map((userId) => ({ userId, sharedBackendId: backendId })),
      );
      await this.audit.append(
        transaction,
        actorId ?? null,
        AuditAction.DeleteSharedBackendGrant,
        backendId,
        scope,
        { scopeId, sharedBackendId: backendId },
      );
      return { userIds, deleted: true };
    });
    if (result.deleted) await this.access.authorizationCommitted(result.userIds);
  }

  private async ensureSystemActor(transaction: IamTransaction): Promise<string> {
    const existing = await transaction.selectFrom('iam.users')
      .select(['id', 'numeric_id'])
      .where('username', '=', SYSTEM_ACTOR_USERNAME)
      .executeTakeFirst();
    if (existing) {
      await transaction.updateTable('iam.users')
        .set({
          display_name: SYSTEM_ACTOR_DISPLAY_NAME,
          status: UserStatus.Disabled,
          password_hash: UNUSABLE_PASSWORD_HASH,
          updated_at: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();
      await this.stripSystemGroupMembership(transaction, existing.id);
      return existing.id;
    }

    const occupied = await transaction.selectFrom('iam.users')
      .select('numeric_id')
      .execute();
    const numericId = pickSystemActorNumericId(occupied.map((row) => row.numeric_id));
    const now = new Date();
    await transaction.insertInto('iam.users')
      .values({
        id: randomUUID(),
        numeric_id: numericId,
        username: SYSTEM_ACTOR_USERNAME,
        password_hash: UNUSABLE_PASSWORD_HASH,
        display_name: SYSTEM_ACTOR_DISPLAY_NAME,
        status: UserStatus.Disabled,
        auth_version: 0,
        authz_version: 0,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.column('username').doNothing())
      .execute();
    const created = await transaction.selectFrom('iam.users')
      .select('id')
      .where('username', '=', SYSTEM_ACTOR_USERNAME)
      .executeTakeFirst();
    if (!created) {
      throw new ConflictException('System actor nyabase-system could not be initialized');
    }
    await this.stripSystemGroupMembership(transaction, created.id);
    return created.id;
  }

  private async stripSystemGroupMembership(
    transaction: IamTransaction,
    userId: string,
  ): Promise<void> {
    const groups = await transaction.selectFrom('iam.groups')
      .select('id')
      .where('system_key', 'in', [
        SystemGroupKey.Administrators,
        SystemGroupKey.Operators,
        SystemGroupKey.Users,
      ])
      .execute();
    if (groups.length === 0) return;
    await transaction.deleteFrom('iam.group_members')
      .where('user_id', '=', userId)
      .where('group_id', 'in', groups.map((group) => group.id))
      .execute();
  }

  private async ensureSystemGroup(
    transaction: IamTransaction,
    systemKey: SystemGroupKey,
    name: string,
    priority: number,
    capabilities: Capability[],
  ): Promise<IamGroup> {
    const row = await transaction.insertInto('iam.groups')
      .values({
        id: randomUUID(),
        name,
        description: null,
        priority,
        is_system: true,
        system_key: systemKey,
        capabilities,
        revision: 1,
      })
      .onConflict((conflict) => conflict.column('system_key').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row) return this.toGroup(row);

    const existing = await transaction.selectFrom('iam.groups')
      .selectAll()
      .where('system_key', '=', systemKey)
      .executeTakeFirst();
    if (!existing) {
      throw new ConflictException(`System group ${systemKey} could not be initialized`);
    }
    const desired = [...capabilities].sort();
    const current = [...(existing.capabilities ?? [])].sort();
    if (desired.join('\0') === current.join('\0')) {
      return this.toGroup(existing);
    }
    const updated = await transaction.updateTable('iam.groups')
      .set({
        capabilities,
        revision: Number(existing.revision) + 1,
        updated_at: new Date(),
      })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toGroup(updated);
  }

  private async requireScope(
    executor: GrantExecutor,
    scope: GrantScope,
    scopeId: string,
  ): Promise<void> {
    if (scope === 'group') {
      const group = await executor.selectFrom('iam.groups').select('id').where('id', '=', scopeId).executeTakeFirst();
      if (!group) throw new NotFoundException('Group not found');
    } else {
      await this.requireUser(executor, scopeId);
    }
  }

  private async requireGroup(transaction: IamTransaction, id: string): Promise<IamGroup> {
    const row = await transaction.selectFrom('iam.groups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Group not found');
    return this.toGroup(row);
  }

  private async requireUser(executor: GrantExecutor, id: string): Promise<{ id: string }> {
    const row = await executor.selectFrom('iam.users')
      .select(['id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || row.status === UserStatus.Deleted) throw new NotFoundException('User not found');
    return row;
  }

  private async groupUserIds(
    groupId: string,
    executor: GrantExecutor,
  ): Promise<string[]> {
    return (await executor.selectFrom('iam.group_members')
      .select('user_id')
      .where('group_id', '=', groupId)
      .execute()).map((row) => row.user_id);
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
