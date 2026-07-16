import { AuditAction, GpuGrantMode } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../entities/user.entity.js', () => ({ UserEntity: class UserEntity {} }));

import { GroupsService } from '../groups.service.js';
import { GroupsController } from '../groups.controller.js';
import { UserGrantsController } from '../user-grants.controller.js';

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
    resolveServerInTransaction: vi.fn().mockResolvedValue({ diskBytes: 4096 }),
  };
  const auditService = { log: vi.fn().mockResolvedValue(undefined) };
  const quotaDispatchService = {
    apply: vi.fn().mockResolvedValue('quota-task-a'),
    applyInTransaction: vi.fn().mockResolvedValue('quota-task-a'),
  };
  const manager = {
    findOneBy: vi.fn(async (entity: { name?: string }, where: { id?: string }) => {
      if (entity.name === 'GroupEntity') return where.id === 'group-a' ? group : null;
      if (entity.name === 'UserEntity') return where.id === 'user-a'
        ? { id: 'user-a', numericId: 1001 }
        : null;
      if (entity.name === 'ServerEntity') return where.id === 'server-a' ? { id: 'server-a' } : null;
      if (entity.name === 'ImageEntity') return where.id === 'image-a' ? { id: 'image-a' } : null;
      return null;
    }),
    findOne: vi.fn(async (entity: { name?: string }, options: unknown) => {
      if (entity.name === 'GroupEntity') return groupsRepo.findOne(options);
      if (entity.name === 'GroupMemberEntity') return membersRepo.findOne(options);
      if (entity.name === 'ServerGrantEntity') return serverGrantsRepo.findOne(options);
      if (entity.name === 'UserEntity') return usersRepo.findOne(options);
      return null;
    }),
    find: vi.fn(async (entity: { name?: string }, options: unknown) => {
      if (entity.name === 'GroupMemberEntity') return membersRepo.find(options);
      if (entity.name === 'ServerGrantEntity') return serverGrantsRepo.find(options);
      return [];
    }),
    create: vi.fn((entity: { name?: string }, input: unknown) => {
      if (entity.name === 'GroupMemberEntity') return membersRepo.create(input);
      if (entity.name === 'ServerGrantEntity') return serverGrantsRepo.create(input);
      return input;
    }),
    save: vi.fn(async (entity: { name?: string }, input: unknown) => {
      if (entity.name === 'GroupMemberEntity') return membersRepo.save(input);
      if (entity.name === 'ServerGrantEntity') return serverGrantsRepo.save(input);
      return input;
    }),
    delete: vi.fn(),
  };
  const dataSource = {
    options: { type: 'postgres' },
    transaction: vi.fn(async (...args: unknown[]) => {
      const work = args.at(-1) as (value: typeof manager) => Promise<unknown>;
      return work(manager);
    }),
  };
  const service = new GroupsService(
    groupsRepo as never,
    membersRepo as never,
    serverGrantsRepo as never,
    repo() as never,
    usersRepo as never,
    accessResolver as never,
    auditService as never,
    quotaDispatchService as never,
    dataSource as never,
    {} as never,
    {
      assertServerAccessRevocationSafe: vi.fn(),
      assertMountSourceRevocationSafe: vi.fn(),
    } as never,
    { notify: vi.fn() } as never,
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
    manager,
  };
}

describe('GroupsService quota desired dispatch', () => {
  it('routes addMember quota sync through QuotaDispatchService and preserves audit/invalidation', async () => {
    const { service, membersRepo, accessResolver, auditService, quotaDispatchService } = makeService();

    await expect(service.addMember('group-a', 'user-a', 'actor-a')).resolves.toEqual({
      taskIds: ['quota-task-a'],
    });

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
    expect(quotaDispatchService.applyInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      {
      serverId: 'server-a',
      userId: 'user-a',
      numericUserId: 1001,
      diskBytes: 4096,
      requestedBy: 'actor-a',
      },
    );
  });

  it('returns every durable quota task id with a group grant mutation', async () => {
    const { service, quotaDispatchService } = makeService();
    quotaDispatchService.applyInTransaction.mockResolvedValueOnce('quota-task-member-a');

    await expect(service.upsertGroupServerGrant('group-a', 'server-a', {
      diskBytes: 8192,
      gpuMode: GpuGrantMode.None,
    }, 'actor-a')).resolves.toMatchObject({
      serverId: 'server-a',
      taskIds: ['quota-task-member-a'],
    });
  });

  it('rolls back the grant request when durable quota intent cannot be enqueued', async () => {
    const { service, serverGrantsRepo, quotaDispatchService } = makeService();
    quotaDispatchService.applyInTransaction.mockRejectedValueOnce(new Error('quota task failed'));

    await expect(service.upsertGroupServerGrant('group-a', 'server-a', {
      diskBytes: 8192,
      gpuMode: GpuGrantMode.None,
    }, 'actor-a')).rejects.toThrow('quota task failed');

    expect(serverGrantsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'group',
      scopeId: 'group-a',
      serverId: 'server-a',
      diskBytes: 8192,
    }));
    expect(quotaDispatchService.applyInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverId: 'server-a',
        userId: 'user-a',
        numericUserId: 1001,
        requestedBy: 'actor-a',
      }),
    );
  });

  it('rejects a grant for a deleted server before writing grant or quota intent', async () => {
    const { service, manager, serverGrantsRepo, quotaDispatchService } = makeService();
    manager.findOneBy.mockImplementation(async (entity: { name?: string }) => (
      entity.name === 'ServerEntity' ? null : { id: 'existing', numericId: 1001 }
    ));

    await expect(service.upsertUserServerGrant('user-a', 'server-deleted', {
      diskBytes: 8192,
    }, 'actor-a')).rejects.toThrow('Server not found');

    expect(serverGrantsRepo.save).not.toHaveBeenCalled();
    expect(quotaDispatchService.applyInTransaction).not.toHaveBeenCalled();
  });
});

describe('mount-source grant controller input', () => {
  it('accepts non-UUID local source ids for group grants', async () => {
    const groupsService = {
      upsertGroupMountSourceGrant: vi.fn().mockResolvedValue({
        id: 'grant-a',
        sourceKind: 'local',
        sourceId: 'disk-a',
      }),
    };
    const controller = new GroupsController(groupsService as never);

    await expect(controller.upsertMountSourceGrant(
      'group-a',
      { sourceKind: 'local', sourceId: 'disk-a', serverId: 'server-a' },
      { id: 'actor-a' } as never,
    )).resolves.toMatchObject({ sourceId: 'disk-a' });
    expect(groupsService.upsertGroupMountSourceGrant).toHaveBeenCalledWith(
      'actor-a',
      'group-a',
      { sourceKind: 'local', sourceId: 'disk-a', serverId: 'server-a' },
    );
  });

  it('accepts non-UUID local source ids for user grants', async () => {
    const groupsService = {
      upsertUserMountSourceGrant: vi.fn().mockResolvedValue({
        id: 'grant-a',
        sourceKind: 'local',
        sourceId: 'disk-a',
      }),
    };
    const controller = new UserGrantsController(groupsService as never, {} as never);

    await expect(controller.upsertUserMountSourceGrant(
      'user-a',
      { sourceKind: 'local', sourceId: 'disk-a', serverId: 'server-a' },
      { id: 'actor-a' } as never,
    )).resolves.toMatchObject({ sourceId: 'disk-a' });
    expect(groupsService.upsertUserMountSourceGrant).toHaveBeenCalledWith(
      'actor-a',
      'user-a',
      { sourceKind: 'local', sourceId: 'disk-a', serverId: 'server-a' },
    );
  });
});
