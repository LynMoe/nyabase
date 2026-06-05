import { AuditAction, GpuGrantMode } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../entities/user.entity.js', () => ({ UserEntity: class UserEntity {} }));

import { GroupsService } from '../groups.service.js';

function repo(overrides: Record<string, unknown> = {}) {
  return {
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockResolvedValue([]),
    findBy: vi.fn().mockResolvedValue([]),
    create: vi.fn((input) => ({
      ...input,
      createdAt: input.createdAt ?? new Date('2026-06-03T00:00:00Z'),
      updatedAt: input.updatedAt ?? new Date('2026-06-03T00:00:00Z'),
    })),
    save: vi.fn(async (input) => ({
      ...input,
      createdAt: input.createdAt ?? new Date('2026-06-03T00:00:00Z'),
      updatedAt: input.updatedAt ?? new Date('2026-06-03T00:00:00Z'),
    })),
    delete: vi.fn().mockResolvedValue({ affected: 1 }),
    remove: vi.fn(async (input) => input),
    ...overrides,
  };
}

function makeService() {
  const group = { id: 'group-a', name: 'Group A', priority: 0, isSystem: false, description: null, capabilities: [] };
  const groupsRepo = repo({ findOne: vi.fn().mockResolvedValue(group) });
  const membersRepo = repo({
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockResolvedValue([{ id: 'member-a', groupId: 'group-a', userId: 'user-a' }]),
  });
  const serverGrantsRepo = repo({
    find: vi.fn().mockResolvedValue([{ id: 'grant-a', scope: 'group', scopeId: 'group-a', serverId: 'server-a', diskBytes: 4096 }]),
    findOne: vi.fn().mockResolvedValue(null),
  });
  const usersRepo = repo({
    findOne: vi.fn().mockResolvedValue({ id: 'user-a', numericId: 1001 }),
  });
  const accessResolver = {
    invalidateUser: vi.fn(),
    resolveServer: vi.fn().mockResolvedValue({ diskBytes: 4096 }),
  };
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const quotaDispatchService = { apply: vi.fn().mockResolvedValue(undefined) };
  const service = new GroupsService(
    groupsRepo as never,
    membersRepo as never,
    serverGrantsRepo as never,
    repo() as never,
    repo() as never,
    repo() as never,
    repo() as never,
    usersRepo as never,
    accessResolver as never,
    auditService as never,
    quotaDispatchService as never,
  );
  return {
    service,
    groupsRepo,
    membersRepo,
    serverGrantsRepo,
    usersRepo,
    accessResolver,
    auditService,
    quotaDispatchService,
  };
}

describe('GroupsService quota desired dispatch', () => {
  it('routes addMember quota sync through QuotaDispatchService and preserves audit/invalidation', async () => {
    const { service, membersRepo, accessResolver, auditService, quotaDispatchService } = makeService();

    await expect(service.addMember('group-a', 'user-a', 'actor-a')).resolves.toBeUndefined();

    expect(membersRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'group-a',
      userId: 'user-a',
    }));
    expect(accessResolver.invalidateUser).toHaveBeenCalledWith('user-a');
    expect(auditService.log).toHaveBeenCalledWith(
      'actor-a',
      AuditAction.AddGroupMember,
      'group-a',
      'group',
      { userId: 'user-a' },
    );
    expect(quotaDispatchService.apply).toHaveBeenCalledWith({
      serverId: 'server-a',
      userId: 'user-a',
      numericUserId: 1001,
      diskBytes: 4096,
      requestedBy: 'actor-a',
    });
  });

  it('routes group grant changes through quota dispatch for current members and swallows quota failures', async () => {
    const { service, serverGrantsRepo, quotaDispatchService } = makeService();
    quotaDispatchService.apply.mockRejectedValueOnce(new Error('quota task failed'));

    await expect(service.upsertGroupServerGrant('group-a', 'server-a', {
      diskBytes: 8192,
      gpuMode: GpuGrantMode.None,
    }, 'actor-a')).resolves.toMatchObject({
      serverId: 'server-a',
      diskBytes: 8192,
    });

    expect(serverGrantsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'group',
      scopeId: 'group-a',
      serverId: 'server-a',
      diskBytes: 8192,
    }));
    expect(quotaDispatchService.apply).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-a',
      userId: 'user-a',
      numericUserId: 1001,
      requestedBy: 'actor-a',
    }));
  });
});
