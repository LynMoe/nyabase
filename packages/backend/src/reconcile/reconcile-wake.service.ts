import { Injectable, Logger } from '@nestjs/common';
import { outsideRequestContext } from '../platform/request-context.js';
import type { IntentResource } from './intent.repository.js';

export interface ReconcileWakePayload {
  readonly resourceType?: IntentResource;
  readonly resourceId?: string;
  readonly serverId?: string | null;
  readonly reason: 'intent' | 'event' | 'scan' | 'reconnect' | 'disconnected';
}

/**
 * In-process wake-up bus. Producers that create intents inside a transaction
 * must wake through `afterCommit` so the worker never looks before the commit.
 */
@Injectable()
export class ReconcileWakeService {
  private readonly logger = new Logger(ReconcileWakeService.name);
  private readonly listeners = new Set<(payload: ReconcileWakePayload) => void>();

  wake(payload: ReconcileWakePayload): void {
    for (const listener of this.listeners) {
      try {
        // Timers the worker arms here must not carry the waking request's context.
        outsideRequestContext(() => listener(payload));
      } catch (error) {
        this.logger.warn(`Reconcile wake listener failed: ${String(error)}`);
      }
    }
  }

  onWake(listener: (payload: ReconcileWakePayload) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
