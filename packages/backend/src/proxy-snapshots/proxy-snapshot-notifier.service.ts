import { Injectable, Logger } from '@nestjs/common';

export type ProxySnapshotChannel = 'http' | 'ssh';
type SnapshotListener = (reason: string) => Promise<void>;

/**
 * Small dependency boundary between durable transactions and proxy gateways.
 * Domain code calls notify only after commit; gateways register their own
 * snapshot broadcaster without coupling proxy modules to domain workers.
 * A failed notification is logged and bounded by each proxy's snapshot lease,
 * and never rewrites an already committed intent outcome.
 */
@Injectable()
export class ProxySnapshotNotifierService {
  private readonly logger = new Logger(ProxySnapshotNotifierService.name);
  private readonly listeners = new Map<ProxySnapshotChannel, SnapshotListener>();

  register(channel: ProxySnapshotChannel, listener: SnapshotListener): () => void {
    if (this.listeners.has(channel)) {
      throw new Error(`Proxy snapshot listener already registered for ${channel}`);
    }
    this.listeners.set(channel, listener);
    return () => {
      if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
    };
  }

  async notify(reason: string): Promise<void> {
    const listeners = [...this.listeners.entries()];
    const outcomes = await Promise.allSettled(
      listeners.map(async ([channel, listener]) => {
        await listener(reason);
        return channel;
      }),
    );
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index]!;
      if (outcome.status === 'fulfilled') continue;
      const channel = listeners[index]![0];
      this.logger.warn(
        `${channel} proxy snapshot notification failed after commit (${reason}): ${this.errorMessage(outcome.reason)}`,
      );
    }
  }

  /**
   * Establish the post-commit invalidation linearization point without
   * waiting for database snapshot builds or WebSocket writes. Gateway
   * listeners synchronously advance their revision before their first await;
   * later failures are safe because snapshots have absolute leases and
   * destructive address reuse has a durable drain gate.
   */
  invalidate(reason: string): void {
    for (const [channel, listener] of this.listeners) {
      void listener(reason).catch((error: unknown) => {
        this.logger.warn(
          `${channel} proxy snapshot invalidation failed after commit (${reason}): ${this.errorMessage(error)}`,
        );
      });
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
