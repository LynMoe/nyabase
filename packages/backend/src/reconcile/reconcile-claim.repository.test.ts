import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECONCILE_RENEWAL_MS,
  ReconcileClaimRepository,
} from './reconcile-claim.repository.js';

const claim = {
  resourceType: 'container',
  resourceId: '00000000-0000-4000-8000-000000000001',
  placementServerId: '00000000-0000-4000-8000-000000000002',
  serverId: '00000000-0000-4000-8000-000000000002',
  workerId: 'worker-test',
  leaseExpiresAt: new Date(Date.now() + 60_000),
  claimedAt: new Date(),
} as const;

describe('ReconcileClaimRepository lease guard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renews long operations every twenty seconds and reports lease loss', async () => {
    vi.useFakeTimers();
    const repository = new ReconcileClaimRepository({} as never);
    const renew = vi.spyOn(repository, 'renew').mockResolvedValue(null);
    const guard = repository.startLeaseGuard(claim);

    await vi.advanceTimersByTimeAsync(RECONCILE_RENEWAL_MS);

    expect(renew).toHaveBeenCalledWith({
      resourceType: claim.resourceType,
      resourceId: claim.resourceId,
      placementServerId: claim.placementServerId,
      workerId: claim.workerId,
    });
    expect(guard.lost).toBe(true);
    expect(() => guard.assertOwned()).toThrow('RECONCILE_LEASE_LOST');
    guard.stop();
  });
});
