import { describe, expect, it } from 'vitest';
import { Capability, SystemGroupKey, UserStatus } from '@nyabase/common';
import { projectAdministrationActions } from './administration-availability.js';

describe('authoritative administration action projection', () => {
  const groups = [
    {
      id: 'users', isSystem: true, systemKey: SystemGroupKey.Users,
      capabilities: [] as Capability[], hasResourceGrants: false,
    },
    {
      id: 'powerful', isSystem: false, systemKey: null,
      capabilities: [Capability.ViewAudit], hasResourceGrants: true,
    },
  ];

  it('denies higher-capability and resource-bearing targets until the actor holds both authorities', () => {
    const base = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities: new Set([Capability.ManageUsers, Capability.ManageGroups]),
      groups,
      users: [{
        id: 'target', status: UserStatus.Active, groupIds: ['powerful'], hasDirectResourceGrants: false,
      }],
    });
    expect(base.users.target?.canAdminister).toMatchObject({
      allowed: false,
      missingCapabilities: expect.arrayContaining([Capability.ViewAudit, Capability.ManageGrants]),
    });
    expect(base.groups.powerful?.canEditMetadata.missingCapabilities).toEqual([Capability.ViewAudit]);
    expect(base.groups.powerful?.canManageMembers.missingCapabilities)
      .toEqual([Capability.ViewAudit, Capability.ManageGrants]);

    const elevated = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities: new Set([
        Capability.ManageUsers, Capability.ManageGroups, Capability.ManageGrants, Capability.ViewAudit,
      ]),
      groups,
      users: [{
        id: 'target', status: UserStatus.Active, groupIds: ['powerful'], hasDirectResourceGrants: false,
      }],
    });
    expect(elevated.users.target?.canAdminister.allowed).toBe(true);
    expect(elevated.groups.powerful?.canManageMembers.allowed).toBe(true);
  });

  it('denies self-delete and derives create-user authority from the Users group', () => {
    const projected = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities: new Set([Capability.ManageUsers]),
      groups: [{
        ...groups[0]!,
        capabilities: [Capability.ViewAudit],
        hasResourceGrants: true,
      }],
      users: [{
        id: 'actor', status: UserStatus.Active, groupIds: [], hasDirectResourceGrants: false,
      }],
    });
    expect(projected.users.actor?.canDelete).toMatchObject({ allowed: false, reason: '不能删除当前账号' });
    expect(projected.createUser.missingCapabilities)
      .toEqual([Capability.ViewAudit, Capability.ManageGrants]);
    expect(projected.assignableGroupCapabilities).toEqual([Capability.ManageUsers]);
  });

  it('keeps non-resource group metadata editable while protecting priority and membership', () => {
    const projected = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities: new Set([Capability.ManageGroups, Capability.ViewAudit]),
      groups,
      users: [],
    });
    expect(projected.groups.powerful?.canEditMetadata.allowed).toBe(true);
    expect(projected.groups.powerful?.canEditPriority).toMatchObject({
      allowed: false,
      missingCapabilities: [Capability.ManageGrants],
    });
    expect(projected.groups.powerful?.canManageMembers.allowed).toBe(false);
    expect(projected.groups.users?.canDelete).toMatchObject({ allowed: false, reason: '内置用户组不可删除' });
  });

  it('requires ManageGrants for a directly granted user even without inherited group grants', () => {
    const projected = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities: new Set([Capability.ManageUsers]),
      groups,
      users: [{
        id: 'target', status: UserStatus.Active, groupIds: [], hasDirectResourceGrants: true,
      }],
    });
    expect(projected.users.target?.canAdminister).toMatchObject({
      allowed: false,
      missingCapabilities: [Capability.ManageGrants],
    });
  });

  it('projects final-active-administrator removal and deletion from the current snapshot', () => {
    const adminGroup = {
      id: 'admins', isSystem: true, systemKey: SystemGroupKey.Administrators,
      capabilities: [] as Capability[], hasResourceGrants: false,
    };
    const actorCapabilities = new Set([Capability.ManageUsers, Capability.ManageGroups]);
    const projected = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities,
      groups: [...groups, adminGroup],
      users: [
        { id: 'actor', status: UserStatus.Active, groupIds: [], hasDirectResourceGrants: false },
        { id: 'last-admin', status: UserStatus.Active, groupIds: ['admins'], hasDirectResourceGrants: false },
        { id: 'inactive-admin', status: UserStatus.Disabled, groupIds: ['admins'], hasDirectResourceGrants: false },
      ],
    });

    expect(projected.users['last-admin']?.canDelete).toMatchObject({
      allowed: false,
      reason: '不能删除最后一个活跃管理员',
    });
    expect(projected.groups.admins?.canRemoveMembers['last-admin']).toMatchObject({
      allowed: false,
      reason: '不能移出最后一个活跃管理员',
    });
    expect(projected.groups.admins?.canRemoveMembers['inactive-admin']?.allowed).toBe(true);
    expect(projected.users.actor?.canDelete.reason).toBe('不能删除当前账号');

    const withAlternative = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities,
      groups: [...groups, adminGroup],
      users: [
        { id: 'actor', status: UserStatus.Active, groupIds: [], hasDirectResourceGrants: false },
        { id: 'admin-a', status: UserStatus.Active, groupIds: ['admins'], hasDirectResourceGrants: false },
        { id: 'admin-b', status: UserStatus.Active, groupIds: ['admins'], hasDirectResourceGrants: false },
      ],
    });
    expect(withAlternative.users['admin-a']?.canDelete.allowed).toBe(true);
    expect(withAlternative.groups.admins?.canRemoveMembers['admin-a']?.allowed).toBe(true);
    expect(withAlternative.groups.admins?.canRemoveMembers['admin-b']?.allowed).toBe(true);
  });

  it('does not treat a non-system group reusing the administrator key as built-in', () => {
    const projected = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities: new Set([Capability.ManageUsers, Capability.ManageGroups]),
      groups: [{
        id: 'imposter', isSystem: false, systemKey: SystemGroupKey.Administrators,
        capabilities: [], hasResourceGrants: false,
      }],
      users: [{
        id: 'target', status: UserStatus.Active, groupIds: ['imposter'], hasDirectResourceGrants: false,
      }],
    });
    expect(projected.users.target?.canDelete.allowed).toBe(true);
    expect(projected.groups.imposter?.canRemoveMembers.target?.allowed).toBe(true);
  });

  it('recomputes final-administrator decisions after a membership snapshot change', () => {
    const adminGroup = {
      id: 'admins', isSystem: true, systemKey: SystemGroupKey.Administrators,
      capabilities: [] as Capability[], hasResourceGrants: false,
    };
    const actorCapabilities = new Set([Capability.ManageUsers, Capability.ManageGroups]);
    const target = {
      id: 'target', status: UserStatus.Active, groupIds: ['admins'], hasDirectResourceGrants: false,
    };
    const alternative = {
      id: 'alternative', status: UserStatus.Active, groupIds: ['admins'], hasDirectResourceGrants: false,
    };

    const before = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities,
      groups: [adminGroup],
      users: [target, alternative],
    });
    expect(before.users.target?.canDelete.allowed).toBe(true);

    const after = projectAdministrationActions({
      actorId: 'actor',
      actorCapabilities,
      groups: [adminGroup],
      users: [target],
    });
    expect(after.users.target?.canDelete).toMatchObject({
      allowed: false,
      reason: '不能删除最后一个活跃管理员',
    });
    expect(after.groups.admins?.canRemoveMembers.target).toMatchObject({
      allowed: false,
      reason: '不能移出最后一个活跃管理员',
    });
  });
});
