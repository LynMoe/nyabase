import { describe, expect, it } from 'vitest';
import { Role, type UserDto, UserStatus } from '@nyabase/common';
import { activeAdminCount, userActionAvailability } from './user-administration.js';

function user(id: string, role: Role, status = UserStatus.Active): UserDto {
  return { id, username: id, displayName: id, status, createdAt: '2026-01-01T00:00:00Z', role, groups: [] };
}

describe('user administration availability', () => {
  const root = user('root', Role.Admin);
  const ops = user('ops', Role.Operator);
  const member = user('member', Role.User);

  it('counts only active admins', () => {
    expect(activeAdminCount([root, ops, user('gone', Role.Admin, UserStatus.Disabled)])).toBe(1);
  });

  it('offers nothing to operators and users', () => {
    for (const viewer of [ops, member]) {
      const result = userActionAvailability(viewer, member, [root, ops, member]);
      expect(result.changeRole.allowed).toBe(false);
      expect(result.disable.allowed).toBe(false);
      expect(result.delete.allowed).toBe(false);
    }
  });

  it('lets an admin manage other users', () => {
    const result = userActionAvailability(root, member, [root, member]);
    expect(result).toEqual({
      changeRole: { allowed: true, reason: null },
      disable: { allowed: true, reason: null },
      delete: { allowed: true, reason: null },
    });
  });

  it('never lets an admin delete themselves', () => {
    const second = user('second', Role.Admin);
    const result = userActionAvailability(root, root, [root, second]);
    expect(result.delete).toMatchObject({ allowed: false, reason: '不能删除自己' });
    expect(result.changeRole.allowed).toBe(true);
  });

  it('protects the last active admin from demotion, disabling and deletion', () => {
    const result = userActionAvailability(root, root, [root, ops]);
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
