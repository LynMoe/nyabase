import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GrantExpiryEnforcementRepository } from './grant-expiry-enforcement.repository.js';

describe('GrantExpiryEnforcementRepository lease decisions', () => {
  it('respects active leases and completion sentinels', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(GrantExpiryEnforcementRepository.isDueForWork('grace', undefined, now)).toBe(true);
    expect(GrantExpiryEnforcementRepository.isDueForWork('grace', {
      grace_stopped_at: now,
      purged_at: null,
      claim_token: null,
      lease_expires_at: null,
    }, now)).toBe(false);
    expect(GrantExpiryEnforcementRepository.isDueForWork('grace', {
      grace_stopped_at: null,
      purged_at: null,
      claim_token: randomUUID(),
      lease_expires_at: new Date(now.getTime() + 60_000),
    }, now)).toBe(false);
    expect(GrantExpiryEnforcementRepository.isDueForWork('lost', {
      grace_stopped_at: now,
      purged_at: null,
      claim_token: randomUUID(),
      lease_expires_at: new Date(now.getTime() - 1),
    }, now)).toBe(true);
    expect(GrantExpiryEnforcementRepository.isDueForWork('lost', {
      grace_stopped_at: now,
      purged_at: now,
      claim_token: null,
      lease_expires_at: null,
    }, now)).toBe(false);
  });
});
