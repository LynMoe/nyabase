import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EphemeralStore, TRUST_TOKEN_TTL_MS } from './ephemeral-store.js';

const SERVER_ID = '00000000-0000-4000-8000-000000000001';
const CLAIM_A = '00000000-0000-4000-8000-0000000000a1';
const CLAIM_B = '00000000-0000-4000-8000-0000000000b2';

describe('EphemeralStore', () => {
  let store: EphemeralStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new EphemeralStore();
  });

  afterEach(() => {
    store.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('expires values after their TTL and sweeps them without a read', () => {
    expect(store.set('console-session:a', 'value', 1_000)).toBe(true);
    expect(store.get('console-session:a')).toBe('value');
    vi.advanceTimersByTime(999);
    expect(store.get('console-session:a')).toBe('value');
    vi.advanceTimersByTime(1);
    expect(store.get('console-session:a')).toBeNull();

    store.set('console-session:b', 'value', 1_000);
    vi.advanceTimersByTime(60_000);
    expect((store as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
  });

  it('keeps an existing value when set is only-if-absent and replaces it otherwise', () => {
    expect(store.set('console-claim:a', 'first', 5_000, true)).toBe(true);
    expect(store.set('console-claim:a', 'second', 5_000, true)).toBe(false);
    expect(store.get('console-claim:a')).toBe('first');
    expect(store.set('console-claim:a', 'third', 5_000)).toBe(true);
    expect(store.get('console-claim:a')).toBe('third');
    vi.advanceTimersByTime(5_000);
    expect(store.set('console-claim:a', 'fourth', 5_000, true)).toBe(true);
  });

  it('rejects unbounded TTLs and oversized values', () => {
    expect(store.set('k', 'v', 0)).toBe(false);
    expect(store.set('k', 'v', 31 * 60_000)).toBe(false);
    expect(store.set('k', 'v', 1.5)).toBe(false);
    expect(store.set('k', 'x'.repeat(16 * 1024 + 1), 1_000)).toBe(false);
    expect(store.get('k')).toBeNull();
  });

  it('deletes values', () => {
    store.set('console-session:a', 'v', 1_000);
    expect(store.delete('console-session:a')).toBe(true);
    expect(store.delete('console-session:a')).toBe(false);
    expect(store.get('console-session:a')).toBeNull();
  });

  it('stores trust tokens under opaque references with a ten-minute TTL', () => {
    const reference = store.storeTrustToken(SERVER_ID, 'one-time-secret');
    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(reference).not.toContain('one-time-secret');

    vi.advanceTimersByTime(TRUST_TOKEN_TTL_MS - 1);
    expect(store.claimTrustToken(SERVER_ID, reference, CLAIM_A)).toBe('one-time-secret');
    store.releaseClaimedTrustToken(SERVER_ID, reference, CLAIM_A);
    vi.advanceTimersByTime(1);
    expect(store.claimTrustToken(SERVER_ID, reference, CLAIM_A)).toBeNull();
  });

  it('scopes trust-token references to their server', () => {
    const reference = store.storeTrustToken(SERVER_ID, 'one-time-secret');
    expect(store.claimTrustToken(
      '00000000-0000-4000-8000-000000000009',
      reference,
      CLAIM_A,
    )).toBeNull();
  });

  it('lets one claimant lease a trust token and consume it exactly once', () => {
    const reference = store.storeTrustToken(SERVER_ID, 'one-time-secret');

    expect(store.claimTrustToken(SERVER_ID, reference, CLAIM_A)).toBe('one-time-secret');
    expect(store.claimTrustToken(SERVER_ID, reference, CLAIM_B)).toBeNull();
    expect(store.consumeClaimedTrustToken(SERVER_ID, reference, CLAIM_B)).toBe(false);
    expect(store.consumeClaimedTrustToken(SERVER_ID, reference, CLAIM_A)).toBe(true);
    expect(store.consumeClaimedTrustToken(SERVER_ID, reference, CLAIM_A)).toBe(false);
    expect(store.claimTrustToken(SERVER_ID, reference, CLAIM_B)).toBeNull();
  });

  it('returns a released claim to the next claimant and expires abandoned claims', () => {
    const reference = store.storeTrustToken(SERVER_ID, 'one-time-secret');

    expect(store.claimTrustToken(SERVER_ID, reference, CLAIM_A)).toBe('one-time-secret');
    expect(store.releaseClaimedTrustToken(SERVER_ID, reference, CLAIM_B)).toBe(false);
    expect(store.releaseClaimedTrustToken(SERVER_ID, reference, CLAIM_A)).toBe(true);
    expect(store.claimTrustToken(SERVER_ID, reference, CLAIM_B)).toBe('one-time-secret');

    vi.advanceTimersByTime(30_000);
    expect(store.claimTrustToken(SERVER_ID, reference, CLAIM_A)).toBe('one-time-secret');
  });

  it('refuses new entries once the store is full of live values', () => {
    for (let index = 0; index < 10_000; index += 1) {
      expect(store.set(`k:${index}`, 'v', 60_000)).toBe(true);
    }
    expect(store.set('overflow', 'v', 60_000)).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(store.set('overflow', 'v', 60_000)).toBe(true);
  });
});
