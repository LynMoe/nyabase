import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { RedisDisposableAdapter } from '../runtime/redis-disposable.adapter.js';

export type ProxySnapshotChannel = 'http' | 'ssh';
type SnapshotListener = (reason: string) => Promise<void>;
type ServerBlockListener = (serverId: string, reason: string) => void;

/**
 * Small dependency boundary between durable transactions and proxy gateways.
 * Domain code calls notify only after commit; gateways register their own
 * snapshot broadcaster without coupling proxy modules to domain workers.
 * A failed notification is logged and bounded by each proxy's snapshot lease,
 * and never rewrites an already committed intent outcome.
 */
@Injectable()
export class ProxySnapshotNotifierService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProxySnapshotNotifierService.name);
  private readonly listeners = new Map<ProxySnapshotChannel, SnapshotListener>();
  private readonly blockedServerIds = new Set<string>();
  private readonly serverBlockListeners = new Set<ServerBlockListener>();
  private readonly blockEpochByServerId = new Map<string, number>();
  private nextBlockEpoch = 1;
  private unsubscribeRedis: (() => Promise<void>) | null = null;
  private redisSubscription: Promise<void> | null = null;
  private destroyed = false;

  constructor(
    @Optional()
    private readonly redis?: RedisDisposableAdapter,
  ) {}

  onModuleInit(): void {
    if (!this.redis) return;
    this.redisSubscription = this.redis.subscribe('proxy-snapshot', (payload) => {
      if (this.destroyed) return;
      const event = parseSnapshotEvent(payload);
      if (!event || event.origin === this.redis?.gatewayId) return;
      this.invalidateLocal(`redis:${event.reason}`);
    }).then(async (unsubscribe) => {
      if (this.destroyed) {
        await unsubscribe();
        return;
      }
      this.unsubscribeRedis = unsubscribe;
    }).catch((error) => {
      this.logger.warn(
        `Proxy snapshot Redis subscription unavailable: ${this.errorMessage(error)}`,
      );
    }).finally(() => {
      this.redisSubscription = null;
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    await this.redisSubscription;
    await this.unsubscribeRedis?.();
    this.unsubscribeRedis = null;
  }

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
    this.publishRedis(reason);
  }

  registerServerBlockListener(listener: ServerBlockListener): () => void {
    this.serverBlockListeners.add(listener);
    return () => this.serverBlockListeners.delete(listener);
  }

  /**
   * Establish the post-commit invalidation linearization point without
   * waiting for database snapshot builds or WebSocket writes. Gateway
   * listeners synchronously advance their revision before their first await;
   * later failures are safe because snapshots have absolute leases and
   * destructive address reuse has a durable drain gate.
   */
  invalidate(reason: string): void {
    this.invalidateLocal(reason);
    this.publishRedis(reason);
  }

  private invalidateLocal(reason: string): void {
    for (const [channel, listener] of this.listeners) {
      void listener(reason).catch((error: unknown) => {
        this.logger.warn(
          `${channel} proxy snapshot invalidation failed after commit (${reason}): ${this.errorMessage(error)}`,
        );
      });
    }
  }

  blockServer(serverId: string, reason: string): number {
    return this.establishServerBlock(serverId, reason, true);
  }

  /**
   * Keep user-facing proxy routes revoked while allowing the current recovery
   * session to execute the exact safety work which can clear that revocation.
   * Unlike a fail-stop block, this must not fence the healthy recovery socket.
   */
  blockServerRoutes(serverId: string, reason: string): number {
    return this.establishServerBlock(serverId, reason, false);
  }

  private establishServerBlock(
    serverId: string,
    reason: string,
    fenceRecoverySession: boolean,
  ): number {
    // Every revocation is a new fence, even if the server was already blocked.
    // A state report that observed an older fence must never be allowed to
    // unblock a later block/disconnect event.
    const epoch = this.nextBlockEpoch++;
    this.blockEpochByServerId.set(serverId, epoch);
    const wasBlocked = this.blockedServerIds.has(serverId);
    this.blockedServerIds.add(serverId);
    if (fenceRecoverySession) {
      for (const listener of this.serverBlockListeners) listener(serverId, reason);
    }
    if (!wasBlocked) this.invalidate(reason);
    return epoch;
  }

  currentBlockEpoch(serverId: string): number {
    return this.blockEpochByServerId.get(serverId) ?? 0;
  }

  unblockServerIfEpoch(serverId: string, expectedEpoch: number, reason: string): boolean {
    if (this.currentBlockEpoch(serverId) !== expectedEpoch) return false;
    if (!this.blockedServerIds.delete(serverId)) return false;
    this.invalidate(reason);
    return true;
  }

  /** Remove process-local revocation state only after the durable Server row is gone. */
  forgetServer(serverId: string, reason: string): void {
    this.blockedServerIds.delete(serverId);
    this.blockEpochByServerId.delete(serverId);
    this.invalidate(reason);
  }

  isServerBlocked(serverId: string): boolean {
    return this.blockedServerIds.has(serverId);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private publishRedis(reason: string): void {
    if (!this.redis) return;
    void this.redis.publish('proxy-snapshot', JSON.stringify({
      origin: this.redis.gatewayId,
      reason,
    }));
  }
}

function parseSnapshotEvent(
  payload: string,
): { origin: string; reason: string } | null {
  try {
    const event = JSON.parse(payload) as Record<string, unknown>;
    if (typeof event.origin !== 'string' || typeof event.reason !== 'string') {
      return null;
    }
    return { origin: event.origin, reason: event.reason };
  } catch {
    return null;
  }
}
