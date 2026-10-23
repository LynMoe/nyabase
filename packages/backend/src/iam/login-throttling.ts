import { isIP } from 'node:net';

// Login throttling: per-address failure limits, address bucketing, and the
// bounded Argon2 verification gate.

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

/**
 * Rate-limit bucket for a client address (Express `req.ip`, which already
 * honours `server.trustedProxies`). IPv4 (and IPv4-mapped IPv6) is one bucket
 * per address; IPv6 is bucketed by its /64 because a single client usually
 * controls a whole /64 and could otherwise rotate addresses for free. The
 * Argon2 concurrency gate uses the coarser /48 a single site is delegated.
 */
export function clientAddressBucket(raw: string | undefined, ipv6Prefix: 48 | 64 = 64): string {
  const address = (raw ?? '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return 'unknown';
  const groups = expandIpv6(address);
  return groups
    ? `${groups.slice(0, ipv6Prefix / 16).map((group) => group.toString(16)).join(':')}::/${ipv6Prefix}`
    : 'unknown';
}

function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  // An embedded dotted IPv4 tail occupies the last two groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const octets = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length)
      + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest]
    .map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

export const MAX_ACTIVE_PASSWORD_VERIFICATIONS = 4;
export const MAX_QUEUED_PASSWORD_VERIFICATIONS = 64;
export const MAX_PASSWORD_VERIFICATIONS_PER_HOLDER = 2;
export const PASSWORD_VERIFICATION_WAIT_MS = 5_000;

export class PasswordVerificationBusyError extends Error {
  constructor(readonly reason: 'holder' | 'queue' | 'timeout') {
    super(`Password verification is busy (${reason})`);
  }
}

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PasswordVerificationGateOptions {
  maxActive?: number;
  maxQueued?: number;
  maxPerHolder?: number;
  waitMs?: number;
}

/**
 * Bounds Argon2 work (CPU and memory per check). A few checks run at once and
 * the rest wait in a bounded FIFO queue for a few seconds. One holder (client
 * address bucket, or the user re-entering their password) may have at most
 * `maxPerHolder` checks running or queued, so a single noisy client is refused
 * on its own instead of exhausting capacity for everybody.
 */
export class PasswordVerificationGate {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private readonly perHolder = new Map<string, number>();
  private readonly maxActive: number;
  private readonly maxQueued: number;
  private readonly maxPerHolder: number;
  private readonly waitMs: number;

  constructor(options: PasswordVerificationGateOptions = {}) {
    this.maxActive = options.maxActive ?? MAX_ACTIVE_PASSWORD_VERIFICATIONS;
    this.maxQueued = options.maxQueued ?? MAX_QUEUED_PASSWORD_VERIFICATIONS;
    this.maxPerHolder = options.maxPerHolder ?? MAX_PASSWORD_VERIFICATIONS_PER_HOLDER;
    this.waitMs = options.waitMs ?? PASSWORD_VERIFICATION_WAIT_MS;
  }

  async run<T>(holder: string, work: () => Promise<T>): Promise<T> {
    const held = this.perHolder.get(holder) ?? 0;
    if (held >= this.maxPerHolder) throw new PasswordVerificationBusyError('holder');
    this.perHolder.set(holder, held + 1);
    try {
      await this.acquire();
      try {
        return await work();
      } finally {
        this.releaseSlot();
      }
    } finally {
      const remaining = (this.perHolder.get(holder) ?? 1) - 1;
      if (remaining > 0) this.perHolder.set(holder, remaining);
      else this.perHolder.delete(holder);
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new PasswordVerificationBusyError('queue'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new PasswordVerificationBusyError('timeout'));
        }, this.waitMs),
      };
      this.queue.push(waiter);
    });
  }

  /** Hands the slot straight to the next waiter, so `active` never overshoots. */
  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}
