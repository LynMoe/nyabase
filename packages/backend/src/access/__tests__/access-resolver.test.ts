import { describe, expect, it, vi } from 'vitest';
import { Capability, UserStatus } from '@nyabase/common';
import {
  AccessResolverService,
  type ResolvedServerGrant,
} from '../access-resolver.service.js';

describe('AccessResolverService effective access projections', () => {
  const grant: ResolvedServerGrant = {
    cpuMillis: 1_000,
    memBytes: 2_000,
    diskBytes: 3_000,
    extensionGrants: {},
    expiresAt: null,
    purgeAt: null,
    accessPhase: 'live',
  };

  function service() {
    const resolver = new AccessResolverService(
      undefined as never,
      undefined as never,
      { refresh: vi.fn().mockResolvedValue(1) } as never,
    );
    (resolver as unknown as {
      userCache: ReturnType<typeof vi.fn>;
    }).userCache = vi.fn().mockResolvedValue({
      epoch: 1,
      fetchedAt: Date.now(),
      capabilities: new Set<Capability>(),
      groups: [],
      servers: new Map([['server-a', grant]]),
      imageAssignments: new Map([['server-a', new Set(['image-a'])]]),
    });
    return resolver;
  }

  it('derives image access only for an effectively granted server', async () => {
    const resolver = service();
    await expect(resolver.resolveAllowedImages('user-a', 'server-a'))
      .resolves.toEqual(new Set(['image-a']));
    await expect(resolver.resolveAllowedImages('user-a', 'server-b'))
      .resolves.toEqual(new Set());
    await expect(resolver.isImageAccessibleForUser('user-a', 'image-a'))
      .resolves.toBe(true);
  });

  it('exposes only canonical server access in the effective projection', async () => {
    const resolver = service();
    await expect(resolver.getEffectiveAccess('user-a')).resolves.toEqual([{
      serverId: 'server-a',
      cpuMillis: 1_000,
      memBytes: 2_000,
      diskBytes: 3_000,
      extensionGrants: {},
      expiresAt: null,
      purgeAt: null,
      accessPhase: 'live',
      allowedImageIds: ['image-a'],
    }]);
  });

  it('returns an empty shared-backend projection when the user has no grants', async () => {
    const chain: {
      selectFrom: ReturnType<typeof vi.fn>;
      leftJoin: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      where: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
      forUpdate: ReturnType<typeof vi.fn>;
      execute: ReturnType<typeof vi.fn>;
      executeTakeFirst: ReturnType<typeof vi.fn>;
    } = {
      selectFrom: vi.fn(),
      leftJoin: vi.fn(),
      select: vi.fn(),
      where: vi.fn(),
      groupBy: vi.fn(),
      forUpdate: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue({ status: UserStatus.Active }),
    };
    chain.selectFrom.mockReturnValue(chain);
    chain.leftJoin.mockReturnValue(chain);
    chain.select.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.groupBy.mockReturnValue(chain);
    chain.forUpdate.mockReturnValue(chain);
    const resolver = new AccessResolverService(
      chain as never,
      undefined as never,
      { refresh: vi.fn().mockResolvedValue(1) } as never,
    );
    await expect(resolver.getEffectiveSharedAccess('user-a')).resolves.toEqual([]);
    expect(chain.forUpdate).not.toHaveBeenCalled();
  });
});
