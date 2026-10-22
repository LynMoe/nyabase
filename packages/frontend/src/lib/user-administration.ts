import { Role, roleAtLeast, type UserDto, UserStatus } from '@nyabase/common';

/**
 * Which user-management buttons are available. The backend enforces the same
 * rules; this only decides what to offer and why something is unavailable.
 */
export interface ActionAvailability {
  allowed: boolean;
  reason: string | null;
}

export interface UserActionAvailability {
  changeRole: ActionAvailability;
  disable: ActionAvailability;
  delete: ActionAvailability;
}

const ALLOWED: ActionAvailability = { allowed: true, reason: null };
const NOT_ADMIN: ActionAvailability = { allowed: false, reason: '需要管理员角色' };
const LAST_ADMIN: ActionAvailability = {
  allowed: false,
  reason: '这是最后一个启用的管理员，不能被降级、停用或删除',
};
const SELF_DELETE: ActionAvailability = { allowed: false, reason: '不能删除自己' };

export function activeAdminCount(users: readonly UserDto[]): number {
  return users.filter((user) => user.role === Role.Admin && user.status === UserStatus.Active).length;
}

/** `users` is the full user list the viewer sees; with it unknown, the last-admin rule is left to the backend. */
export function userActionAvailability(
  viewer: Pick<UserDto, 'id' | 'role'> | null | undefined,
  target: UserDto,
  users: readonly UserDto[] | undefined,
): UserActionAvailability {
  if (!viewer || !roleAtLeast(viewer.role, Role.Admin)) {
    return { changeRole: NOT_ADMIN, disable: NOT_ADMIN, delete: NOT_ADMIN };
  }
  const isLastActiveAdmin = users !== undefined
    && target.role === Role.Admin
    && target.status === UserStatus.Active
    && activeAdminCount(users) <= 1;
  const guarded = isLastActiveAdmin ? LAST_ADMIN : ALLOWED;
  return {
    changeRole: guarded,
    disable: guarded,
    delete: viewer.id === target.id ? SELF_DELETE : guarded,
  };
}
