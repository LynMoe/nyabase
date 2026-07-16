import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import {
  assertNetworkClaimCapacity,
  gcExpiredNetworkClaims,
  MAX_NETWORK_ADDRESS_CLAIMS_GLOBAL,
  NETWORK_CLAIM_GC_BATCH,
  NetworkClaimLedgerCapacityError,
} from './network-claim-ledger.js';

describe('network claim ledger bounds', () => {
  it('rejects a new row at the durable global cap', async () => {
    const manager = {
      count: vi.fn().mockResolvedValue(MAX_NETWORK_ADDRESS_CLAIMS_GLOBAL),
    } as unknown as EntityManager;

    await expect(assertNetworkClaimCapacity(manager, 0)).resolves.toBeUndefined();
    await expect(assertNetworkClaimCapacity(manager, 1))
      .rejects.toBeInstanceOf(NetworkClaimLedgerCapacityError);
  });

  it('garbage-collects only one fixed batch after both leases expire', async () => {
    const reusableAt = new Date('2026-07-16T00:00:00.000Z');
    const rows = [
      { id: 'claim-a', reusableAt },
      { id: 'claim-b', reusableAt },
    ];
    const find = vi.fn().mockResolvedValue(rows);
    const remove = vi.fn().mockResolvedValue(undefined);
    const mayReuse = vi.fn((_key: string) => _key.endsWith('claim-a'));
    const manager = { find, delete: remove } as unknown as EntityManager;

    await expect(gcExpiredNetworkClaims(manager, {
      now: new Date('2026-07-16T00:10:00.000Z'),
      guard: { mayReuse },
    })).resolves.toBe(1);

    expect(find).toHaveBeenCalledWith(NetworkAddressClaimEntity, expect.objectContaining({
      order: { reusableAt: 'ASC', id: 'ASC' },
      take: NETWORK_CLAIM_GC_BATCH,
    }));
    expect(mayReuse).toHaveBeenCalledTimes(2);
    const where = remove.mock.calls[0]?.[1] as { id?: { _value?: string[] } };
    expect(where.id?._value).toEqual(['claim-a']);
  });
});
