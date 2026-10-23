import { describe, expect, it, vi } from 'vitest';
import { reloadOnStaleBundle, STALE_BUNDLE_RELOAD_GUARD_MS } from './stale-bundle-reload.js';

function fakeHost(storage: Pick<Storage, 'getItem' | 'setItem'> | (() => never)) {
  let listener: (() => void) | undefined;
  const reload = vi.fn();
  const host = {
    addEventListener: (_type: 'vite:preloadError', handler: () => void) => { listener = handler; },
    get sessionStorage() {
      return typeof storage === 'function' ? storage() : storage;
    },
    location: { reload },
  };
  return { host, reload, fire: () => listener?.() };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('reloadOnStaleBundle', () => {
  it('reloads once, then lets a repeated failure surface until the guard expires', () => {
    let now = 1_000_000;
    const storage = memoryStorage();
    const { host, reload, fire } = fakeHost(storage);
    reloadOnStaleBundle(host, () => now);

    fire();
    expect(reload).toHaveBeenCalledOnce();

    // The reloaded page fails again right away: no loop.
    now += 2_000;
    fire();
    expect(reload).toHaveBeenCalledOnce();

    // A later redeploy in the same tab session reloads again.
    now += STALE_BUNDLE_RELOAD_GUARD_MS;
    fire();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload when sessionStorage is unavailable', () => {
    const blocked = fakeHost(() => { throw new DOMException('denied', 'SecurityError'); });
    reloadOnStaleBundle(blocked.host);
    blocked.fire();
    expect(blocked.reload).not.toHaveBeenCalled();

    const failingWrite = fakeHost({
      getItem: () => null,
      setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
    });
    reloadOnStaleBundle(failingWrite.host);
    failingWrite.fire();
    expect(failingWrite.reload).not.toHaveBeenCalled();
  });
});
