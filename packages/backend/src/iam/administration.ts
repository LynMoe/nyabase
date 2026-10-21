import { ForbiddenException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  Capability,
  SystemGroupKey,
  UserStatus,
  type ActionAvailabilityDto,
  type AdministrationActionsDto,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

/**
 * The administration rules, in one place:
 *
 *  - R7 hierarchy: an actor may only administer a user whose capabilities are a
 *    subset of the actor's own; when the target holds resource grants (direct or
 *    through a group) the actor also needs `ManageGrants`.
 *  - The final active administrator is protected.
 *  - Every IAM write serialises on one advisory lock, so these checks see the
 *    state they will commit against.
 *
 * Each rule is one function; the transactional guards and the UI projection
 * below are both built from them.
 */
type IamExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

const IAM_POLICY_LOCK = 'nyabase:iam-policy';

/** Transaction-scoped; re-entrant for the same transaction. */
export async function lockIamPolicy(transaction: Transaction<NyabaseDatabase>): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${IAM_POLICY_LOCK}, 0))`
    .execute(transaction);
}

/** Capabilities come only from group membership; inactive users hold none by default. */
export async function loadCapabilities(
  executor: IamExecutor,
  userId: string,
  requireActive = true,
): Promise<Set<Capability>> {
  const user = await executor.selectFrom('iam.users')
    .select('status')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user || (requireActive && user.status !== UserStatus.Active)) return new Set();
  const groups = await executor.selectFrom('iam.group_members as member')
    .innerJoin('iam.groups as group', 'group.id', 'member.group_id')
    .select('group.capabilities')
    .where('member.user_id', '=', userId)
    .execute();
  return new Set(groups.flatMap((group) => group.capabilities as Capability[]));
}

function escalationDenied(missing: Capability[]): ForbiddenException {
  return new ForbiddenException({
    code: 'PRIVILEGE_ESCALATION_DENIED',
    message: 'The actor does not hold the required capabilities',
    missingCapabilities: missing,
  });
}

/** The actor must hold every capability in `required`, read inside the transaction. */
export async function assertActorHolds(
  transaction: Transaction<NyabaseDatabase>,
  actorId: string,
  required: Iterable<Capability>,
): Promise<Set<Capability>> {
  await lockIamPolicy(transaction);
  const capabilities = await loadCapabilities(transaction, actorId, true);
  const missing = [...new Set(required)].filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) throw escalationDenied(missing);
  return capabilities;
}

/** What it takes to administer a user (or group member) with these properties. */
export function capabilitiesRequiredToAdminister(
  targetCapabilities: Iterable<Capability>,
  targetHoldsResourceGrants: boolean,
): Capability[] {
  return [
    Capability.ManageUsers,
    ...targetCapabilities,
    ...(targetHoldsResourceGrants ? [Capability.ManageGrants] : []),
  ];
}

export async function assertActorMayAdminister(
  transaction: Transaction<NyabaseDatabase>,
  actorId: string,
  targetUserId: string,
): Promise<void> {
  await lockIamPolicy(transaction);
  const targetCapabilities = await loadCapabilities(transaction, targetUserId, false);
  const holdsGrants = await userHoldsResourceGrants(transaction, targetUserId);
  await assertActorHolds(
    transaction,
    actorId,
    capabilitiesRequiredToAdminister(targetCapabilities, holdsGrants),
  );
}

/** Direct grants, or grants of any group the user belongs to (expiry is irrelevant). */
async function userHoldsResourceGrants(
  transaction: Transaction<NyabaseDatabase>,
  userId: string,
): Promise<boolean> {
  const rows = await sql<{ held: boolean }>`
    SELECT (
      EXISTS (SELECT 1 FROM iam.server_grants WHERE user_id = ${userId}::uuid)
      OR EXISTS (SELECT 1 FROM iam.storage_pool_grants WHERE user_id = ${userId}::uuid)
      OR EXISTS (SELECT 1 FROM iam.shared_backend_grants WHERE user_id = ${userId}::uuid)
      OR EXISTS (
        SELECT 1 FROM iam.group_members AS member
        WHERE member.user_id = ${userId}::uuid AND (
          EXISTS (SELECT 1 FROM iam.server_grants WHERE group_id = member.group_id)
          OR EXISTS (SELECT 1 FROM iam.storage_pool_grants WHERE group_id = member.group_id)
          OR EXISTS (SELECT 1 FROM iam.shared_backend_grants WHERE group_id = member.group_id)
        )
      )
    ) AS held
  `.execute(transaction);
  return rows.rows[0]?.held === true;
}

/** True when any grant (server, pool or shared backend) is held by the group. */
export async function groupHoldsResourceGrants(
  transaction: Transaction<NyabaseDatabase>,
  groupId: string,
): Promise<boolean> {
  const rows = await sql<{ held: boolean }>`
    SELECT (
      EXISTS (SELECT 1 FROM iam.server_grants WHERE group_id = ${groupId}::uuid)
      OR EXISTS (SELECT 1 FROM iam.storage_pool_grants WHERE group_id = ${groupId}::uuid)
      OR EXISTS (SELECT 1 FROM iam.shared_backend_grants WHERE group_id = ${groupId}::uuid)
    ) AS held
  `.execute(transaction);
  return rows.rows[0]?.held === true;
}

/** Removing, disabling or deleting `userId` must leave another active administrator. */
export async function assertNotLastAdministrator(
  transaction: Transaction<NyabaseDatabase>,
  userId: string,
): Promise<void> {
  await lockIamPolicy(transaction);
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

// ---------------------------------------------------------------------------
// UI projection of the same rules.
// ---------------------------------------------------------------------------

export interface AdministrationUserSnapshot {
  id: string;
  status: UserStatus;
  groupIds: readonly string[];
  hasDirectResourceGrants: boolean;
}

export interface AdministrationGroupSnapshot {
  id: string;
  isSystem: boolean;
  systemKey: SystemGroupKey | null;
  capabilities: readonly Capability[];
  hasResourceGrants: boolean;
}

function availability(
  actorCapabilities: ReadonlySet<Capability>,
  required: Iterable<Capability>,
  deniedReason?: string,
): ActionAvailabilityDto {
  const missingCapabilities = [...new Set(required)]
    .filter((capability) => !actorCapabilities.has(capability));
  return {
    allowed: missingCapabilities.length === 0 && deniedReason === undefined,
    reason: deniedReason
      ?? (missingCapabilities.length > 0 ? `缺少权限：${missingCapabilities.join(', ')}` : null),
    missingCapabilities,
  };
}

function denied(reason: string): ActionAvailabilityDto {
  return { allowed: false, reason, missingCapabilities: [] };
}

export function projectAdministrationActions(input: {
  actorId: string;
  actorCapabilities: ReadonlySet<Capability>;
  users: readonly AdministrationUserSnapshot[];
  groups: readonly AdministrationGroupSnapshot[];
}): AdministrationActionsDto {
  const { actorId, actorCapabilities, users, groups } = input;
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const administratorsGroup = groups.find((group) =>
    group.isSystem && group.systemKey === SystemGroupKey.Administrators);
  const activeAdministratorIds = administratorsGroup
    ? users
      .filter((user) =>
        user.status === UserStatus.Active && user.groupIds.includes(administratorsGroup.id))
      .map((user) => user.id)
    : [];
  const finalActiveAdministratorId = activeAdministratorIds.length === 1
    ? activeAdministratorIds[0]
    : null;
  const assignableGroupCapabilities = Object.values(Capability)
    .filter((capability) => actorCapabilities.has(capability));
  const createGroup = availability(actorCapabilities, [Capability.ManageGroups]);
  const usersGroup = groups.find((group) => group.systemKey === SystemGroupKey.Users);
  const createUser = usersGroup
    ? availability(actorCapabilities, [
        Capability.ManageUsers,
        ...usersGroup.capabilities,
        ...(usersGroup.hasResourceGrants ? [Capability.ManageGrants] : []),
      ])
    : denied('内置 Users 用户组不可用');

  return {
    actorCapabilities: [...actorCapabilities],
    assignableGroupCapabilities,
    createUser,
    createGroup,
    users: Object.fromEntries(users.map((user) => {
      const memberGroups = user.groupIds.flatMap((groupId) => {
        const group = groupsById.get(groupId);
        return group ? [group] : [];
      });
      const targetCapabilities = memberGroups.flatMap((group) => [...group.capabilities]);
      const holdsGrants = user.hasDirectResourceGrants
        || memberGroups.some((group) => group.hasResourceGrants);
      const canAdminister = availability(
        actorCapabilities,
        capabilitiesRequiredToAdminister(targetCapabilities, holdsGrants),
      );
      return [user.id, {
        canAdminister,
        canDelete: user.id === actorId
          ? denied('不能删除当前账号')
          : user.id === finalActiveAdministratorId
            ? denied('不能删除最后一个活跃管理员')
            : canAdminister,
      }];
    })),
    groups: Object.fromEntries(groups.map((group) => {
      const baseRequired = [Capability.ManageGroups, ...group.capabilities];
      const resourceRequired = [
        ...baseRequired,
        ...(group.hasResourceGrants ? [Capability.ManageGrants] : []),
      ];
      const canEditMetadata = availability(actorCapabilities, baseRequired);
      const canManageResourceSensitive = availability(actorCapabilities, resourceRequired);
      const canRemoveMembers = Object.fromEntries(users
        .filter((user) => user.groupIds.includes(group.id))
        .map((user) => [user.id,
          group.id === administratorsGroup?.id && user.id === finalActiveAdministratorId
            ? denied('不能移出最后一个活跃管理员')
            : canManageResourceSensitive,
        ]));
      return [group.id, {
        canEditMetadata,
        canManageMembers: canManageResourceSensitive,
        canRemoveMembers,
        canDelete: group.isSystem ? denied('内置用户组不可删除') : canManageResourceSensitive,
      }];
    })),
  };
}

export async function loadAdministrationActions(
  transaction: Transaction<NyabaseDatabase>,
  actorId: string,
): Promise<AdministrationActionsDto> {
  const [actorCapabilities, users, groups, memberships, grants] = await Promise.all([
    loadCapabilities(transaction, actorId, true),
    transaction.selectFrom('iam.users')
      .select(['id', 'status'])
      .where('status', '!=', UserStatus.Deleted)
      .execute(),
    transaction.selectFrom('iam.groups')
      .select(['id', 'is_system', 'system_key', 'capabilities'])
      .execute(),
    transaction.selectFrom('iam.group_members').select(['group_id', 'user_id']).execute(),
    sql<{ user_id: string | null; group_id: string | null }>`
      SELECT user_id, group_id FROM iam.server_grants
      UNION ALL SELECT user_id, group_id FROM iam.storage_pool_grants
      UNION ALL SELECT user_id, group_id FROM iam.shared_backend_grants
    `.execute(transaction).then((result) => result.rows),
  ]);
  const grantedUsers = new Set(grants.flatMap((grant) => grant.user_id ? [grant.user_id] : []));
  const grantedGroups = new Set(grants.flatMap((grant) => grant.group_id ? [grant.group_id] : []));
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
      isSystem: group.is_system,
      systemKey: group.system_key as SystemGroupKey | null,
      capabilities: group.capabilities as Capability[],
      hasResourceGrants: grantedGroups.has(group.id),
    })),
  });
}
