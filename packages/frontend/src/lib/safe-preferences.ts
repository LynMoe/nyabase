export interface SafePreferenceAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function createSafePreferenceAdapter(
  storageProvider: () => Storage = () => globalThis.localStorage,
): SafePreferenceAdapter {
  // `null` is an in-memory tombstone. It must shadow an older persisted value
  // when removeItem fails, just as a newly set value must shadow stale storage
  // when setItem fails.
  const memory = new Map<string, string | null>();
  return {
    get(key) {
      if (memory.has(key)) return memory.get(key) ?? null;
      try {
        return storageProvider().getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try { storageProvider().setItem(key, value); } catch { /* in-memory fallback */ }
    },
    remove(key) {
      memory.set(key, null);
      try { storageProvider().removeItem(key); } catch { /* in-memory fallback */ }
    },
  };
}

export const safePreferences = createSafePreferenceAdapter();
