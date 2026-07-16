import { performance } from 'node:perf_hooks';
import { CONTAINER_DELETE_PROXY_DRAIN_MS } from '@nyabase/common';

const MAX_MONOTONIC_REUSE_GUARDS = 262_144;

/**
 * Process-local second clock for identifier reuse. Database wall time remains
 * the durable lower bound; this guard prevents wall-clock jumps and Backend
 * restarts from shortening a proxy drain lease.
 */
export class MonotonicReuseGuard {
  private readonly deadlines = new Map<string, number>();

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly drainMs = CONTAINER_DELETE_PROXY_DRAIN_MS,
  ) {}

  arm(key: string): void {
    if (!this.deadlines.has(key) && this.deadlines.size >= MAX_MONOTONIC_REUSE_GUARDS) {
      throw new Error('Monotonic identifier drain registry capacity is exhausted');
    }
    // arm() can run before the surrounding database transaction commits. A
    // rollback followed by a later successful retry must start a fresh full
    // monotonic drain; replacing the deadline can only extend protection.
    this.deadlines.set(key, this.now() + this.drainMs);
  }

  /** Wall-clock expiry and a full process-observed monotonic lease are required. */
  mayReuse(key: string, durableReusableAt: Date | null, wallNow = Date.now()): boolean {
    if (!durableReusableAt || durableReusableAt.getTime() > wallNow) return false;
    const deadline = this.deadlines.get(key);
    if (deadline === undefined) {
      // A row first seen after restart receives a fresh full lease.
      this.arm(key);
      return false;
    }
    if (this.now() < deadline) return false;
    this.deadlines.delete(key);
    return true;
  }
}

export const monotonicReuseGuard = new MonotonicReuseGuard();

export const networkClaimReuseKey = (claimId: string) => `network:${claimId}`;
export const hostnameReuseKey = (hostname: string) => `hostname:${hostname}`;
