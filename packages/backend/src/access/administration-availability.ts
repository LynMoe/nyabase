import {
  Capability,
  SystemGroupKey,
  UserStatus,
  type ActionAvailabilityDto,
  type AdministrationActionsDto,
} from '@nyabase/common';

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
      const targetCapabilities = new Set(memberGroups.flatMap((group) => [...group.capabilities]));
      const hasResourceGrants = user.hasDirectResourceGrants
        || memberGroups.some((group) => group.hasResourceGrants);
      const canAdminister = availability(actorCapabilities, [
        Capability.ManageUsers,
        ...targetCapabilities,
        ...(hasResourceGrants ? [Capability.ManageGrants] : []),
      ]);
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
        canEditPriority: group.isSystem
          ? denied('内置用户组优先级不可修改')
          : canManageResourceSensitive,
        canManageMembers: canManageResourceSensitive,
        canRemoveMembers,
        canDelete: group.isSystem ? denied('内置用户组不可删除') : canManageResourceSensitive,
      }];
    })),
  };
}
