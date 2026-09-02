import { describe, expect, it } from 'vitest';
import {
  classifyGrantExpiry,
  expiresAtSortKey,
  grantPurgeAt,
  selectWinningGrantCandidate,
  GRANT_EXPIRY_GRACE_MS,
} from './grant-expiry.js';

const base = {
  cpu_millis: null as number | null,
  mem_bytes: null as string | null,
  disk_bytes: null as string | null,
};

describe('classifyGrantExpiry', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('treats null expiry as live', () => {
    expect(classifyGrantExpiry(null, now)).toBe('live');
  });

  it('classifies live, grace, and lost windows', () => {
    expect(classifyGrantExpiry(new Date('2026-07-01T00:00:00.000Z'), now)).toBe('live');
    expect(classifyGrantExpiry(new Date('2026-05-25T00:00:00.000Z'), now)).toBe('grace');
    expect(classifyGrantExpiry(
      new Date(now.getTime() - GRANT_EXPIRY_GRACE_MS - 1),
      now,
    )).toBe('lost');
  });
});

describe('selectWinningGrantCandidate', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('prefers a live direct grant over a live group grant', () => {
    const winner = selectWinningGrantCandidate([
      {
        ...base,
        scopeRank: 1,
        priority: 100,
        tieBreaker: 'g1',
        expiresAt: null,
      },
      {
        ...base,
        scopeRank: 0,
        priority: 0,
        tieBreaker: 'direct',
        expiresAt: new Date('2026-06-15T00:00:00.000Z'),
      },
    ], now);
    expect(winner?.phase).toBe('live');
    expect(winner?.candidate.tieBreaker).toBe('direct');
  });

  it('falls back to the winning live group when direct access is expired', () => {
    const winner = selectWinningGrantCandidate([
      {
        ...base,
        scopeRank: 0,
        priority: 0,
        tieBreaker: 'direct',
        expiresAt: new Date('2026-05-01T00:00:00.000Z'),
      },
      {
        ...base,
        scopeRank: 1,
        priority: 10,
        tieBreaker: 'g-early',
        expiresAt: new Date('2026-06-10T00:00:00.000Z'),
      },
      {
        ...base,
        scopeRank: 1,
        priority: 1,
        tieBreaker: 'g-late',
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ], now);
    expect(winner?.phase).toBe('live');
    expect(winner?.candidate.tieBreaker).toBe('g-late');
  });

  it('selects grace when no live cover remains', () => {
    const winner = selectWinningGrantCandidate([
      {
        ...base,
        scopeRank: 0,
        priority: 0,
        tieBreaker: 'direct',
        expiresAt: new Date('2026-05-20T00:00:00.000Z'),
      },
    ], now);
    expect(winner?.phase).toBe('grace');
  });

  it('returns null when all covers are lost', () => {
    const winner = selectWinningGrantCandidate([
      {
        ...base,
        scopeRank: 0,
        priority: 0,
        tieBreaker: 'direct',
        expiresAt: new Date(now.getTime() - GRANT_EXPIRY_GRACE_MS - 1_000),
      },
    ], now);
    expect(winner).toBeNull();
  });

  it('prefers higher priority when group grants never expire', () => {
    const winner = selectWinningGrantCandidate([
      {
        ...base,
        scopeRank: 1,
        priority: 1,
        tieBreaker: 'low',
        expiresAt: null,
      },
      {
        ...base,
        scopeRank: 1,
        priority: 100,
        tieBreaker: 'high',
        expiresAt: null,
      },
    ], now);
    expect(winner?.candidate.tieBreaker).toBe('high');
  });

  it('prefers higher priority when group expiry times are equal', () => {
    const expiresAt = new Date('2026-07-01T00:00:00.000Z');
    const winner = selectWinningGrantCandidate([
      {
        ...base,
        scopeRank: 1,
        priority: 5,
        tieBreaker: 'a',
        expiresAt,
      },
      {
        ...base,
        scopeRank: 1,
        priority: 50,
        tieBreaker: 'b',
        expiresAt,
      },
    ], now);
    expect(winner?.candidate.tieBreaker).toBe('b');
  });

  it('prefers never-expiring group access over finite future access', () => {
    const winner = selectWinningGrantCandidate([
      {
        ...base,
        scopeRank: 1,
        priority: 100,
        tieBreaker: 'finite-high-priority',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
      {
        ...base,
        scopeRank: 1,
        priority: 1,
        tieBreaker: 'never',
        expiresAt: null,
      },
    ], now);
    expect(winner?.candidate.tieBreaker).toBe('never');
  });

  it('among grace group grants prefers later expiry and then priority', () => {
    const winner = selectWinningGrantCandidate([
      {
        ...base,
        scopeRank: 1,
        priority: 100,
        tieBreaker: 'earlier-high-priority',
        expiresAt: new Date('2026-05-20T00:00:00.000Z'),
      },
      {
        ...base,
        scopeRank: 1,
        priority: 1,
        tieBreaker: 'later-low-priority',
        expiresAt: new Date('2026-05-25T00:00:00.000Z'),
      },
    ], now);
    expect(winner?.phase).toBe('grace');
    expect(winner?.candidate.tieBreaker).toBe('later-low-priority');
  });
});

describe('grantPurgeAt / expiresAtSortKey', () => {
  it('computes the purge deadline from expiresAt', () => {
    const expires = new Date('2026-06-01T00:00:00.000Z');
    expect(grantPurgeAt(expires)?.getTime()).toBe(expires.getTime() + GRANT_EXPIRY_GRACE_MS);
    expect(grantPurgeAt(null)).toBeNull();
  });

  it('sorts null expiry as infinity', () => {
    expect(expiresAtSortKey(null)).toBe(Number.POSITIVE_INFINITY);
    expect(expiresAtSortKey('2026-01-01T00:00:00.000Z')).toBeLessThan(expiresAtSortKey(null));
  });
});
