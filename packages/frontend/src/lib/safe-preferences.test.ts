import { describe, expect, it, vi } from 'vitest';
import { createSafePreferenceAdapter } from './safe-preferences.js';

function storageWith(overrides: Partial<Storage>): Storage {
  return {
    length: 0,
    clear: vi.fn(),
    getItem: vi.fn(() => null),
    key: vi.fn(() => null),
    removeItem: vi.fn(),
    setItem: vi.fn(),
    ...overrides,
  };
}

describe('safe preference adapter', () => {
  it('falls back to memory when getItem throws', () => {
    const storage = storageWith({ getItem: () => { throw new DOMException('blocked'); } });
    const preferences = createSafePreferenceAdapter(() => storage);
    preferences.set('server', 's1');
    expect(preferences.get('server')).toBe('s1');
  });

  it('retains an in-memory value when setItem throws', () => {
    const storage = storageWith({
      getItem: () => 'stale-server',
      setItem: () => { throw new DOMException('quota'); },
    });
    const preferences = createSafePreferenceAdapter(() => storage);
    preferences.set('server', 's2');
    expect(preferences.get('server')).toBe('s2');
  });

  it('removes the in-memory value even when removeItem throws', () => {
    const storage = storageWith({
      getItem: () => 'stale-server',
      removeItem: () => { throw new DOMException('blocked'); },
    });
    const preferences = createSafePreferenceAdapter(() => storage);
    preferences.remove('server');
    expect(preferences.get('server')).toBeNull();
  });
});
