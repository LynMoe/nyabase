import { describe, expect, it, vi } from 'vitest';
import { Capability, UserStatus } from '@nyabase/common';
import { AccessResolverService } from './access-resolver.service.js';

describe('AccessResolverService cache invalidation fences', () => {
  it('drops a user fill and bumps the local epoch on invalidation', () => {
    const cacheEpoch = {
      bump: vi.fn().mockReturnValue(2),
    };
    const resolver = new AccessResolverService(
      undefined as never,
      undefined as never,
      cacheEpoch as never,
    );
    const cache = (resolver as unknown as {
      cache: Map<string, unknown>;
    }).cache;
    cache.set('user-a', { epoch: 1 });

    resolver.invalidateUser('user-a');

    expect(cacheEpoch.bump).toHaveBeenCalledOnce();
    expect(cache.has('user-a')).toBe(false);
  });

  it('clears all cached users after a committed authorization mutation', async () => {
    const cacheEpoch = {
      refreshAndPublish: vi.fn().mockResolvedValue(3),
    };
    const resolver = new AccessResolverService(
      undefined as never,
      undefined as never,
      cacheEpoch as never,
    );
    const cache = (resolver as unknown as {
      cache: Map<string, unknown>;
    }).cache;
    cache.set('user-a', { epoch: 1 });
    cache.set('user-b', { epoch: 1 });

    await resolver.authorizationCommitted();

    expect(cacheEpoch.refreshAndPublish).toHaveBeenCalledOnce();
    expect(cache.size).toBe(0);
  });

  it('retries a slow fill when the policy epoch changes before publication', async () => {
    const now = new Date('2026-08-07T00:00:00.000Z');
    let fillNumber = 0;
    const cacheEpoch = {
      refresh: vi.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValue(2),
    };
    const transactionForFill = (fill: number) => {
      const group = {
        id: 'group-1',
        name: 'Operators',
        description: null,
        priority: 10,
        is_system: false,
        system_key: null,
        capabilities: [Capability.ManageGroups],
        revision: 1,
        created_at: now,
        updated_at: now,
      };
      const builderFor = (table: string) => ({
        select: vi.fn().mockReturnThis(),
        selectAll: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn(async () => (
          table === 'iam.users'
            ? { id: 'user-1', status: UserStatus.Active }
            : undefined
        )),
        execute: vi.fn(async () => {
          if (table === 'iam.group_members as member') {
            return fill === 1 ? [group] : [];
          }
          if (table === 'iam.server_grants as grant') {
            return fill === 1 ? [{
              user_id: 'user-1',
              group_id: null,
              server_id: 'server-1',
              cpu_millis: 1,
              mem_bytes: '2',
              disk_bytes: '3',
              extension_grants: {},
              expires_at: null,
              id: 'grant-1',
              priority: null,
              member_user_id: null,
            }] : [];
          }
          return [];
        }),
      });
      return {
        selectFrom: vi.fn((table: string) => builderFor(table)),
      };
    };
    const resolver = new AccessResolverService(
      undefined as never,
      {
        run: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
          fillNumber += 1;
          return work(transactionForFill(fillNumber));
        }),
      } as never,
      cacheEpoch as never,
    );

    await expect(resolver.userCapabilities('user-1')).resolves.toEqual(new Set());
    expect(cacheEpoch.refresh).toHaveBeenCalledTimes(4);
    const cache = (resolver as unknown as {
      cache: Map<string, { epoch: number; servers: Map<string, unknown> }>;
    }).cache;
    expect(cache.get('user-1')).toMatchObject({ epoch: 2 });
    expect(cache.get('user-1')?.servers.size).toBe(0);
  });
});
