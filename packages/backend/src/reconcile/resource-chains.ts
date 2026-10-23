import type { IntentRecord } from './intent.repository.js';

/** Resources reconciled at once in this process, and at most this many on one server. */
export const MAX_CONCURRENT_RESOURCES = 12;
export const MAX_CONCURRENT_RESOURCES_PER_SERVER = 4;

function resourceKey(intent: Pick<IntentRecord, 'resourceType' | 'resourceId'>): string {
  return `${intent.resourceType}:${intent.resourceId}`;
}

function serverKey(intent: Pick<IntentRecord, 'serverId'>): string {
  return intent.serverId ?? '';
}

/**
 * The reconcile worker's in-flight work, one chain per resource: a chain runs
 * its intents one after another in queue order, different resources run side
 * by side within the caps. Claims are per worker, so this is also what keeps
 * one resource from being reconciled twice at once in this process.
 */
export class ResourceChains {
  private readonly chains = new Map<string, { readonly serverKey: string; readonly tail: Promise<void> }>();
  /** Intents queued on a chain, left out of the next listings. */
  private readonly queued = new Set<string>();
  private waiters: Array<() => void> = [];

  get size(): number {
    return this.chains.size;
  }

  get queuedIds(): ReadonlySet<string> {
    return this.queued;
  }

  /** Whether the intent can join the queue now (its resource already runs, or a slot is free). */
  admits(intent: IntentRecord): boolean {
    if (this.chains.has(resourceKey(intent))) return true;
    return this.chains.size < MAX_CONCURRENT_RESOURCES
      && this.serverLoad(serverKey(intent)) < MAX_CONCURRENT_RESOURCES_PER_SERVER;
  }

  /** True when every slot is taken; a server at its own cap only defers its intents. */
  get full(): boolean {
    return this.chains.size >= MAX_CONCURRENT_RESOURCES;
  }

  /** Resolves as soon as any chain finishes. */
  async anyIdle(): Promise<void> {
    await Promise.race([...this.chains.values()].map((chain) => chain.tail));
  }

  /** Appends `work` for the intent to its resource's chain, starting one when idle. */
  enqueue(intent: IntentRecord, work: () => Promise<void>): Promise<void> {
    const key = resourceKey(intent);
    const previous = this.chains.get(key)?.tail ?? Promise.resolve();
    this.queued.add(intent.id);
    const tail: Promise<void> = previous.then(work).finally(() => {
      this.queued.delete(intent.id);
      // Only an idle resource frees a slot (and may have successors to list).
      if (this.chains.get(key)?.tail !== tail) return;
      this.chains.delete(key);
      this.signal();
    });
    this.chains.set(key, { serverKey: serverKey(intent), tail });
    return tail;
  }

  /** Resolves when a resource chain goes idle or `signal` is called. */
  nextChange(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  signal(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private serverLoad(key: string): number {
    let load = 0;
    for (const chain of this.chains.values()) {
      if (chain.serverKey === key) load += 1;
    }
    return load;
  }
}
