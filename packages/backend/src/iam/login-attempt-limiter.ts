export const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60_000;
export const MAX_LOGIN_LIMITER_KEYS = 16_384;

export interface LoginAttemptRule {
  key: string;
  limit: number;
}

interface LoginAttemptEntry {
  count: number;
  windowStartedAt: number;
  lastSeenAt: number;
}

export interface LoginAttemptReservation {
  key: string;
  entry: LoginAttemptEntry;
}

/**
 * Process-local fixed-window counters. An attempt reserves one unit on every
 * rule before the expensive credential check and gives it back on success,
 * so the counters measure failures (and in-flight attempts).
 *
 * The map is kept in least-recently-used order (every touch re-inserts the
 * key). A full table evicts its least recently used entry instead of refusing
 * new keys, so filling it can never lock everybody out.
 */
export class LoginAttemptLimiter {
  private readonly entries = new Map<string, LoginAttemptEntry>();

  constructor(
    private readonly now: () => number,
    private readonly maxKeys = MAX_LOGIN_LIMITER_KEYS,
    private readonly windowMs = LOGIN_ATTEMPT_WINDOW_MS,
  ) {}

  /** All-or-nothing: `null` when any rule is exhausted, nothing is consumed then. */
  reserve(rules: readonly LoginAttemptRule[]): LoginAttemptReservation[] | null {
    const now = this.now();
    this.pruneStale(now);
    const current = rules.map((rule) => {
      const existing = this.entries.get(rule.key);
      return existing && now - existing.windowStartedAt < this.windowMs ? existing : null;
    });
    if (rules.some((rule, index) => (current[index]?.count ?? 0) >= rule.limit)) return null;
    return rules.map((rule, index) => {
      const entry = current[index] ?? { count: 0, windowStartedAt: now, lastSeenAt: now };
      entry.count += 1;
      entry.lastSeenAt = now;
      this.entries.delete(rule.key);
      while (this.entries.size >= this.maxKeys) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      this.entries.set(rule.key, entry);
      return { key: rule.key, entry };
    });
  }

  /**
   * Gives back exactly these reservations. Entry identity fences a window
   * that was replaced (or evicted) meanwhile: an older call never decrements it.
   */
  release(reservations: readonly LoginAttemptReservation[]): void {
    for (const { key, entry } of reservations) {
      if (this.entries.get(key) !== entry || entry.count <= 0) continue;
      entry.count -= 1;
      if (entry.count === 0) this.entries.delete(key);
    }
  }

  size(): number {
    return this.entries.size;
  }

  /** Oldest-touched first: stop at the first entry seen within the window. */
  private pruneStale(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt < this.windowMs) return;
      this.entries.delete(key);
    }
  }
}
