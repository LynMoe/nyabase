import { Injectable } from '@nestjs/common';

/**
 * In-process signal that IAM state which decides who is covered (membership,
 * grants, user status) changed. IAM writers fire it through `afterCommit`, so
 * a listener never looks before the commit; the access-lapse processor listens
 * and scans out of its regular schedule. A missed signal only costs latency:
 * the processor also runs periodically.
 */
@Injectable()
export class AccessChangeNotifier {
  private readonly listeners = new Set<() => void>();

  notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener failure must not fail the committed IAM write.
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
