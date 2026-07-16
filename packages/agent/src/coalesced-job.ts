/**
 * Runs at most one copy of a periodic/reconcile collector and retains only the
 * latest trigger while it is active. This bounds memory without dropping the
 * final observation requested during a long collection.
 */
export class CoalescedJob {
  private active: Promise<void> | null = null;
  private pending: (() => Promise<void>) | null = null;

  run(work: () => Promise<void>): Promise<void> {
    if (this.active) {
      this.pending = work;
      return this.active;
    }

    const execute = async () => {
      let next: (() => Promise<void>) | null = work;
      while (next) {
        await next();
        next = this.pending;
        this.pending = null;
      }
    };
    // Start on the next microtask so `active` is visible even if `work`
    // synchronously triggers the same job before its first await.
    const tracked = Promise.resolve().then(execute).finally(() => {
      if (this.active === tracked) this.active = null;
      this.pending = null;
    });
    this.active = tracked;
    return tracked;
  }
}
