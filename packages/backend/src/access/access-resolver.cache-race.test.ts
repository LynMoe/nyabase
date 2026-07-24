import { Capability } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { AccessResolverService } from './access-resolver.service.js';

describe('AccessResolverService cache generation fence', () => {
  it('never returns an authority fill that started before invalidateUser', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let oldReadStarted!: () => void;
    const started = new Promise<void>((resolve) => { oldReadStarted = resolve; });
    const membersRepo = {
      find: vi.fn()
        .mockImplementationOnce(async () => {
          oldReadStarted();
          await gate;
          return [{ id: 'member-old', groupId: 'privileged', userId: 'user-a' }];
        })
        .mockResolvedValueOnce([]),
    };
    const groupsRepo = {
      createQueryBuilder: vi.fn(() => ({
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        addOrderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([{
          id: 'privileged',
          priority: 1,
          capabilities: [Capability.ManageUsers],
        }]),
      })),
    };
    const emptyRepo = {
      find: vi.fn().mockResolvedValue([]),
      createQueryBuilder: vi.fn(() => ({
        where: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([]),
      })),
    };
    const resolver = new AccessResolverService(
      groupsRepo as never,
      membersRepo as never,
      emptyRepo as never,
      emptyRepo as never,
      emptyRepo as never,
      { find: vi.fn().mockResolvedValue([]) } as never,
      emptyRepo as never,
      emptyRepo as never,
      { stateCache: { get: vi.fn() } } as never,
      new AccessCacheEpochService(),
    );

    const capabilities = resolver.userCapabilities('user-a');
    await started;
    resolver.invalidateUser('user-a');
    release();

    await expect(capabilities).resolves.toEqual(new Set());
    expect(membersRepo.find).toHaveBeenCalledTimes(2);
  });
});
