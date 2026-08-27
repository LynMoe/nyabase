import { describe, expect, it, vi } from 'vitest';
import { Capability } from '@nyabase/common';
import { AccessResolverService } from './access-resolver.service.js';

describe('AccessResolverService external admission', () => {
  it('finishes the authorization transaction before starting remote work', async () => {
    const transaction = {};
    const transactions = {
      run: vi.fn(async <T>(work: (value: typeof transaction) => Promise<T>) => work(transaction)),
    };
    const resolver = new AccessResolverService(
      undefined as never,
      transactions as never,
      undefined as never,
    );
    vi.spyOn(resolver, 'assertActorCapabilitiesInTransaction')
      .mockResolvedValue(new Set([Capability.ManageServers]));
    const start = vi.fn().mockResolvedValue('remote-result');

    const admitted = await resolver.startExternalWithActorCapabilities(
      'actor-a',
      [Capability.ManageServers],
      start,
    );

    expect(transactions.run).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    await expect(admitted.completion).resolves.toBe('remote-result');
  });
});
