import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EphemeralStore } from './ephemeral-store.js';

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

  it('refuses new entries once the store is full of live values', () => {
    for (let index = 0; index < 10_000; index += 1) {
      expect(store.set(`k:${index}`, 'v', 60_000)).toBe(true);
    }
    expect(store.set('overflow', 'v', 60_000)).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(store.set('overflow', 'v', 60_000)).toBe(true);
  });
});
