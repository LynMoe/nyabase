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
