import { describe, expect, it } from 'vitest';
import { Role, type UserDto, UserStatus } from '@nyabase/common';
import { activeAdminCount, userActionAvailability } from './user-administration.js';

function user(id: string, role: Role, status = UserStatus.Active): UserDto {
  return { id, username: id, displayName: id, status, createdAt: '2026-01-01T00:00:00Z', role };
}

const ALLOWED = { allowed: true, reason: null };

describe('user administration availability', () => {
  const root = user('root', Role.Admin);
  const manager = user('manager', Role.UserAdmin);
  const member = user('member', Role.User);

  it('counts only active admins', () => {
    expect(activeAdminCount([root, manager, user('gone', Role.Admin, UserStatus.Disabled)])).toBe(1);
  });

  it('offers nothing to plain users', () => {
    const result = userActionAvailability(member, member, [root, manager, member]);
    expect(Object.values(result).every((action) => !action.allowed)).toBe(true);
  });

  it('lets an admin manage other users', () => {
    const result = userActionAvailability(root, member, [root, member]);
    expect(result).toEqual({ edit: ALLOWED, changeRole: ALLOWED, disable: ALLOWED, delete: ALLOWED });
  });

  it('lets a user admin manage users and user admins, but not roles', () => {
    for (const target of [member, user('peer', Role.UserAdmin)]) {
      const result = userActionAvailability(manager, target, [root, manager, member]);
      expect(result).toMatchObject({ edit: ALLOWED, disable: ALLOWED, delete: ALLOWED });
      expect(result.changeRole).toMatchObject({ allowed: false, reason: '只有超级管理员可以修改角色' });
    }
  });

  it('keeps admins out of a user admin\'s reach', () => {
    const result = userActionAvailability(manager, root, [root, manager]);
    expect(Object.values(result).every((action) => !action.allowed)).toBe(true);
    expect(result.edit.reason).toBe('只有超级管理员可以管理超级管理员');
  });

  it('never lets an admin delete themselves', () => {
    const second = user('second', Role.Admin);
    const result = userActionAvailability(root, root, [root, second]);
    expect(result.delete).toMatchObject({ allowed: false, reason: '不能删除自己' });
    expect(result.changeRole.allowed).toBe(true);
  });

  it('protects the last active admin from demotion, disabling and deletion', () => {
    const result = userActionAvailability(root, root, [root, manager]);
    expect(result.changeRole.allowed).toBe(false);
    expect(result.disable.allowed).toBe(false);
    expect(result.delete.allowed).toBe(false);
    expect(result.changeRole.reason).toContain('最后一个');
  });

  it('does not treat a disabled admin as the last one', () => {
    const disabled = user('off', Role.Admin, UserStatus.Disabled);
    expect(userActionAvailability(root, disabled, [root, disabled]).delete.allowed).toBe(true);
  });

  it('leaves the last-admin rule to the backend while the list is unknown', () => {
    expect(userActionAvailability(root, root, undefined).changeRole.allowed).toBe(true);
  });
});
