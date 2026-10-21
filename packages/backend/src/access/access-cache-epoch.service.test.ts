import { describe, expect, it, vi } from 'vitest';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';

function databaseWithEpoch(policyEpoch: string | number) {
  const executeTakeFirstOrThrow = vi.fn(async () => ({ policy_epoch: policyEpoch }));
  const chain = {
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirstOrThrow,
  };
  return { selectFrom: vi.fn(() => chain), executeTakeFirstOrThrow };
}

describe('AccessCacheEpochService', () => {
  it('advances monotonically for post-commit invalidation fences', () => {
    const epoch = new AccessCacheEpochService(undefined as never);
    expect(epoch.current()).toBe(0);
    expect(epoch.bump()).toBe(1);
    expect(epoch.bump()).toBe(2);
    expect(epoch.current()).toBe(2);
  });

  it('adopts a higher durable epoch and never moves backwards', async () => {
    const database = databaseWithEpoch('7');
    const epoch = new AccessCacheEpochService(database as never);
    await expect(epoch.refresh()).resolves.toBe(7);

    database.executeTakeFirstOrThrow.mockResolvedValueOnce({ policy_epoch: '3' });
    epoch.bump();
    await expect(epoch.refresh()).resolves.toBe(8);
    expect(epoch.current()).toBe(8);
  });

  it('rejects a durable epoch outside the safe integer range', async () => {
    const epoch = new AccessCacheEpochService(
      databaseWithEpoch('9007199254740993') as never,
    );
    await expect(epoch.refresh()).rejects.toThrow('safe application range');
  });
});
