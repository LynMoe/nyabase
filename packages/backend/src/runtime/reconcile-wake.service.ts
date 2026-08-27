import { Inject, Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../persistence-pg/tokens.js';
import type { IntentResource } from './intent.repository.js';

export const RECONCILE_WAKE = Symbol('RECONCILE_WAKE');

export interface ReconcileWakePayload {
  readonly resourceType?: IntentResource;
  readonly resourceId?: string;
  readonly serverId?: string | null;
  readonly reason: 'intent' | 'event' | 'scan' | 'reconnect' | 'disconnected';
}

export interface ReconcileWakePort {
  wake(payload: ReconcileWakePayload): void;
  onWake(listener: (payload: ReconcileWakePayload) => void): () => void;
}

@Injectable()
export class ReconcileWakeService
  implements ReconcileWakePort, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileWakeService.name);
  private readonly listeners = new Set<(payload: ReconcileWakePayload) => void>();
  private pgClient?: PoolClient;
  private pgReconnectTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(@Optional() @Inject(PG_POOL) private readonly pool?: Pool) {}

  onModuleInit(): void {
    void this.listenForPostgresNotifications();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.pgReconnectTimer) clearTimeout(this.pgReconnectTimer);
    this.pgReconnectTimer = undefined;
    void this.pgClient?.query('UNLISTEN nyabase_reconcile').catch(() => undefined);
    this.pgClient?.release();
    this.pgClient = undefined;
  }

  wake(payload: ReconcileWakePayload): void {
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch (error) {
        this.logger.warn(`Reconcile wake listener failed: ${String(error)}`);
      }
    }
  }

  onWake(listener: (payload: ReconcileWakePayload) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async listenForPostgresNotifications(): Promise<void> {
    if (!this.pool || this.stopped || this.pgClient) return;
    try {
      const client = await this.pool.connect();
      if (this.stopped) {
        client.release();
        return;
      }
      this.pgClient = client;
      client.on('notification', (notification) => {
        if (notification.channel !== 'nyabase_reconcile') return;
        let payload: Partial<ReconcileWakePayload> = {};
        try {
          payload = JSON.parse(notification.payload ?? '{}') as Partial<ReconcileWakePayload>;
        } catch {
          // A malformed notification is only a lost wake; the periodic scan is authoritative.
        }
        this.wake({
          ...payload,
          reason: 'intent',
        });
      });
      client.on('error', () => {
        if (this.pgClient !== client) return;
        this.pgClient = undefined;
        client.release();
        this.scheduleReconnect();
      });
      await client.query('LISTEN nyabase_reconcile');
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.pgReconnectTimer) return;
    this.pgReconnectTimer = setTimeout(() => {
      this.pgReconnectTimer = undefined;
      void this.listenForPostgresNotifications();
    }, 1_000);
    this.pgReconnectTimer.unref?.();
  }
}

