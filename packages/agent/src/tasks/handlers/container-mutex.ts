import { Mutex } from 'async-mutex';

const MAX_ENTRIES = 512;
const mutexes = new Map<string, Mutex>();

function getMutex(runtimeId: string): Mutex {
  const existing = mutexes.get(runtimeId);
  if (existing) {
    mutexes.delete(runtimeId);
    mutexes.set(runtimeId, existing);
    return existing;
  }
  const created = new Mutex();
  mutexes.set(runtimeId, created);
  if (mutexes.size > MAX_ENTRIES) {
    const oldest = mutexes.keys().next().value;
    if (oldest !== undefined) mutexes.delete(oldest);
  }
  return created;
}

export function withContainerMutex<T>(runtimeId: string, work: () => Promise<T>): Promise<T> {
  return getMutex(runtimeId).runExclusive(work);
}

export function forgetContainerMutex(runtimeId: string): void {
  mutexes.delete(runtimeId);
}
