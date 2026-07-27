import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RedisClientType } from 'redis';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { RuntimeRoleService } from './runtime-role.service.js';

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const COMMAND_TIMEOUT_MS = 1_000;
const MAX_REDIS_MESSAGE_BYTES = 1024 * 1024;
const MAX_CACHE_TTL_MS = 60_000;
const MAX_RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const MAX_RATE_LIMIT_RESERVATIONS_PER_WINDOW = 10_000;
export const DISPOSABLE_REDIS_CLIENT = Symbol('NYABASE_DISPOSABLE_REDIS_CLIENT');

export type DisposableWakeTopic =
  | 'cache-invalidation'
  | 'dispatch'
  | 'proxy-snapshot'
  | 'reconcile'
  | 'system-settings';

export interface RateLimitResult {
  available: boolean;
  allowed: boolean;
  count: number;
  retryAfterMs: number;
  reservation: RateLimitReservation | null;
}

export interface RateLimitReservation {
  scope: string;
  windowId: string;
  reservationId: string;
}

type WakeHandler = (payload: string) => void | Promise<void>;

/**
 * Redis is a disposable acceleration boundary except where split API/Gateway
 * roles explicitly use addressed RPC as an availability dependency. Canonical
 * ownership remains PostgreSQL. Every operation is bounded.
 */
@Injectable()
export class RedisDisposableAdapter implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisDisposableAdapter.name);
  private readonly client: RedisClientType;
  private subscriber: RedisClientType | null = null;
  private subscriberConnecting: Promise<void> | null = null;
  private readonly wakeHandlers = new Map<
    string,
    Set<WakeHandler>
  >();
  private readonly subscribedTopics = new Set<string>();
  private readonly topicMutationTails = new Map<string, Promise<void>>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private connecting: Promise<void> | null = null;
  private stopped = false;
  private warnedUnavailable = false;
  readonly gatewayId = `gateway:${randomUUID()}`;

  constructor(
    @Inject(DISPOSABLE_REDIS_CLIENT)
    client: RedisClientType,
    config: NyabaseConfigService,
    _runtimeRole: RuntimeRoleService,
  ) {
    this.keyPrefix = config.get<string>('redis.keyPrefix');
    this.client = client;
    this.client.on('error', (error) => this.warnUnavailable(error));
  }

  private readonly keyPrefix: string;

  onModuleInit(): void {
    void this.recoverAndSchedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await Promise.allSettled([
      this.connecting,
      this.subscriberConnecting,
    ].filter((pending): pending is Promise<void> => pending !== null));
    await Promise.allSettled([...this.topicMutationTails.values()]);
    const subscriber = this.subscriber;
    this.subscriber = null;
    this.wakeHandlers.clear();
    this.subscribedTopics.clear();
    this.topicMutationTails.clear();
    await Promise.allSettled([
      this.closeClient(subscriber),
      this.closeClient(this.client),
    ]);
  }

  isAvailable(): boolean {
    return this.client.isReady;
  }

  isAddressedRpcReady(): boolean {
    const topic = this.rpcTopic(this.gatewayId);
    return this.client.isReady
      && Boolean(this.subscriber?.isReady)
      && this.subscribedTopics.has(topic);
  }

  async setCache(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_CACHE_TTL_MS) return false;
    return this.bestEffort(async (client) => {
      await client.set(this.key(`cache:${key}`), value, { PX: ttlMs });
      return true;
    }, false);
  }

  async getCache(key: string): Promise<string | null> {
    return this.bestEffort(
      (client) => client.get(this.key(`cache:${key}`)),
      null,
    );
  }

  async invalidateCache(key: string): Promise<boolean> {
    return this.bestEffort(
      async (client) => (await client.del(this.key(`cache:${key}`))) > 0,
      false,
    );
  }

  async publish(topic: DisposableWakeTopic, payload: string): Promise<boolean> {
    if (!validMessage(payload)) return false;
    return this.bestEffort(async (client) => {
      await client.publish(this.channel(topic), payload);
      return true;
    }, false);
  }

  async publishAddressedRpc(destinationGatewayId: string, payload: string): Promise<boolean> {
    const channel = this.rpcChannel(destinationGatewayId);
    if (!channel || !validMessage(payload)) return false;
    return this.bestEffort(async (client) => {
      await client.publish(channel, payload);
      return true;
    }, false);
  }

  subscribeAddressedRpc(
    handler: WakeHandler,
  ): Promise<() => Promise<void>> {
    return this.subscribeChannel(this.rpcTopic(this.gatewayId), handler);
  }

  async subscribe(topic: DisposableWakeTopic, handler: WakeHandler): Promise<() => Promise<void>> {
    return this.subscribeChannel(topic, handler);
  }

  private async subscribeChannel(
    topic: DisposableWakeTopic | string,
    handler: WakeHandler,
  ): Promise<() => Promise<void>> {
    if (this.stopped) {
      throw new Error('Redis adapter is shutting down');
    }
    let handlers = this.wakeHandlers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.wakeHandlers.set(topic, handlers);
    }
    handlers.add(handler);
    await this.recoverConnections();
    await this.ensureTopicSubscribed(topic);
    if (this.stopped) {
      this.wakeHandlers.get(topic)?.delete(handler);
      throw new Error('Redis adapter is shutting down');
    }

    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.wakeHandlers.get(topic);
      current?.delete(handler);
      if (current && current.size > 0) return;
      this.wakeHandlers.delete(topic);
      await this.runTopicMutation(topic, async () => {
        if ((this.wakeHandlers.get(topic)?.size ?? 0) > 0) return;
        this.subscribedTopics.delete(topic);
        const subscriber = this.subscriber;
        if (!subscriber?.isReady) return;
        try {
          await withDeadline(
            subscriber.unsubscribe(this.channel(topic)),
            COMMAND_TIMEOUT_MS,
            'Redis unsubscribe timed out',
          );
        } catch (error) {
          this.warnUnavailable(error);
          if (this.subscriber === subscriber) {
            this.subscriber = null;
            this.subscribedTopics.clear();
          }
          await this.closeClient(subscriber);
        }
      });
    };
  }

  async consumeRateLimit(
    scope: string,
    limit: number,
    windowMs: number,
  ): Promise<RateLimitResult> {
    if (
      !/^[a-z0-9:_-]{1,160}$/.test(scope)
      ||
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_RATE_LIMIT_RESERVATIONS_PER_WINDOW
      || !Number.isSafeInteger(windowMs)
      || windowMs < 1
      || windowMs > MAX_RATE_LIMIT_WINDOW_MS
    ) {
      return unavailableRateLimit();
    }
    const proposedWindowId = randomUUID();
    const reservationId = randomUUID();
    return this.bestEffort(async (client) => {
      const result = await client.eval(
        'local values=redis.call("HMGET",KEYS[1],"window","count");'
        + ' local window=values[1]; local n=tonumber(values[2]);'
        + ' local ttl=redis.call("PTTL",KEYS[1]);'
        + ' if (not window) or (not n) or ttl<=0 then'
        + ' window=ARGV[3]; n=1;'
        + ' redis.call("HSET",KEYS[1],"window",window,"count",n,'
        + '"reservation:"..ARGV[4],1);'
        + ' redis.call("PEXPIRE",KEYS[1],ARGV[1]); ttl=tonumber(ARGV[1]);'
        + ' return {1,n,ttl,window}; end;'
        + ' if n>=tonumber(ARGV[2]) then return {0,n,ttl,window}; end;'
        + ' n=redis.call("HINCRBY",KEYS[1],"count",1);'
        + ' redis.call("HSET",KEYS[1],"reservation:"..ARGV[4],1);'
        + ' return {1,n,ttl,window}',
        {
          keys: [this.key(`limit:${scope}`)],
          arguments: [
            String(windowMs),
            String(limit),
            proposedWindowId,
            reservationId,
          ],
        },
      ) as [number, number, number, string];
      const [allowed, count, ttl, windowId] = result;
      return {
        available: true,
        allowed: allowed === 1,
        count,
        retryAfterMs: Math.max(0, ttl),
        reservation: allowed === 1
          ? { scope, windowId, reservationId }
          : null,
      };
    }, unavailableRateLimit());
  }

  async releaseRateLimit(
    reservation: RateLimitReservation,
  ): Promise<boolean> {
    if (
      !/^[a-z0-9:_-]{1,160}$/.test(reservation.scope)
      || !isUuid(reservation.windowId)
      || !isUuid(reservation.reservationId)
    ) return false;
    return this.bestEffort(async (client) => {
      const released = await client.eval(
        'if redis.call("HGET",KEYS[1],"window")~=ARGV[1] then return 0 end;'
        + ' if redis.call("HDEL",KEYS[1],"reservation:"..ARGV[2])~=1'
        + ' then return 0 end;'
        + ' local n=redis.call("HINCRBY",KEYS[1],"count",-1);'
        + ' if n<=0 then redis.call("DEL",KEYS[1]) end; return 1',
        {
          keys: [this.key(`limit:${reservation.scope}`)],
          arguments: [reservation.windowId, reservation.reservationId],
        },
      );
      return Number(released) === 1;
    }, false);
  }

  private async bestEffort<T>(
    operation: (client: RedisClientType) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      await this.ensureConnected();
      if (this.stopped || !this.client.isReady) return fallback;
      const commandClient = typeof this.client.withCommandOptions === 'function'
        ? this.client.withCommandOptions({ timeout: COMMAND_TIMEOUT_MS })
        : this.client;
      const value = await operation(commandClient);
      this.warnedUnavailable = false;
      return value;
    } catch (error) {
      this.warnUnavailable(error);
      return fallback;
    }
  }

  private ensureConnected(): Promise<void> {
    if (this.stopped || this.client.isReady) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.client.connect()
      .then(() => {
        this.warnedUnavailable = false;
      })
      .catch((error: unknown) => {
        this.warnUnavailable(error);
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async recoverConnections(): Promise<void> {
    await this.ensureConnected();
    if (
      this.stopped
      || !this.client.isReady
      || this.wakeHandlers.size === 0
    ) return;
    await this.ensureSubscriberConnected();
  }

  private async recoverAndSchedule(): Promise<void> {
    if (this.stopped) return;
    await this.recoverConnections();
    if (this.stopped) return;
    if (this.client.isReady && (
      this.wakeHandlers.size === 0 || this.subscriber?.isReady
    )) {
      this.reconnectAttempt = 0;
    } else {
      this.reconnectAttempt += 1;
    }
    const exponential = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * (2 ** Math.min(this.reconnectAttempt, 6)),
    );
    const jittered = Math.max(
      RECONNECT_MIN_MS,
      Math.floor(exponential * (0.75 + Math.random() * 0.5)),
    );
    this.reconnectTimer = setTimeout(
      () => void this.recoverAndSchedule(),
      jittered,
    );
    this.reconnectTimer.unref?.();
  }

  private ensureSubscriberConnected(): Promise<void> {
    if (
      this.stopped
      || this.wakeHandlers.size === 0
      || this.subscriber?.isReady
    ) return Promise.resolve();
    if (this.subscriberConnecting) return this.subscriberConnecting;

    const stale = this.subscriber;
    this.subscriber = null;
    this.subscribedTopics.clear();
    this.subscriberConnecting = (async () => {
      await this.closeClient(stale).catch(() => undefined);
      if (this.stopped || !this.client.isReady || this.wakeHandlers.size === 0) {
        return;
      }
      // Duplicate without overrides so a rediss:// command client's private
      // CA, SNI and rejectUnauthorized settings are inherited intact.
      const subscriber = this.client.duplicate();
      this.subscriber = subscriber;
      subscriber.on('error', (error) => this.warnUnavailable(error));
      subscriber.on('end', () => {
        if (this.subscriber !== subscriber) return;
        this.subscriber = null;
        this.subscribedTopics.clear();
      });
      try {
        await subscriber.connect();
        if (this.subscriber !== subscriber || this.stopped) return;
        for (const topic of this.wakeHandlers.keys()) {
          await this.subscribeTopic(subscriber, topic);
        }
        this.warnedUnavailable = false;
      } catch (error) {
        if (this.subscriber === subscriber) this.subscriber = null;
        this.subscribedTopics.clear();
        await this.closeClient(subscriber).catch(() => undefined);
        this.warnUnavailable(error);
      }
    })().finally(() => {
      this.subscriberConnecting = null;
    });
    return this.subscriberConnecting;
  }

  private async ensureTopicSubscribed(
    topic: DisposableWakeTopic | string,
  ): Promise<void> {
    if (
      this.stopped
      ||
      !this.wakeHandlers.has(topic)
      || this.subscribedTopics.has(topic)
    ) return;
    await this.ensureSubscriberConnected();
    const subscriber = this.subscriber;
    if (!subscriber?.isReady || this.subscribedTopics.has(topic)) return;
    await this.subscribeTopic(subscriber, topic);
  }

  private async subscribeTopic(
    subscriber: RedisClientType,
    topic: DisposableWakeTopic | string,
  ): Promise<void> {
    await this.runTopicMutation(topic, async () => {
      if (
        this.stopped
        ||
        this.subscriber !== subscriber
        || !this.wakeHandlers.has(topic)
        || this.subscribedTopics.has(topic)
      ) return;
      await withDeadline(
        subscriber.subscribe(this.channel(topic), (message) => {
          if (!validMessage(message)) {
            this.warnUnavailable(new Error('Oversized Redis message discarded'));
            return;
          }
          const handlers = [...(this.wakeHandlers.get(topic) ?? [])];
          for (const handler of handlers) {
            void Promise.resolve(handler(message))
              .catch((error) => this.warnUnavailable(error));
          }
        }),
        COMMAND_TIMEOUT_MS,
        'Redis subscription timed out',
      );
      if (this.subscriber === subscriber && subscriber.isReady) {
        this.subscribedTopics.add(topic);
      }
    });
  }

  private async closeClient(client: RedisClientType | null): Promise<void> {
    if (!client?.isOpen) return;
    try {
      await withDeadline(
        client.close(),
        COMMAND_TIMEOUT_MS,
        'Redis close timed out',
      );
    } catch (error) {
      this.warnUnavailable(error);
      client.destroy();
    }
  }

  private runTopicMutation(
    topic: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.topicMutationTails.get(topic) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        if (this.topicMutationTails.get(topic) === current) {
          this.topicMutationTails.delete(topic);
        }
      });
    this.topicMutationTails.set(topic, current);
    return current;
  }

  private key(suffix: string): string {
    return `${this.keyPrefix}${suffix}`;
  }

  private channel(topic: string): string {
    return this.key(`wake:${topic}`);
  }

  private rpcTopic(gatewayId: string): string {
    return `rpc:v1:${gatewayId}`;
  }

  private rpcChannel(gatewayId: string): string | null {
    if (!/^gateway:[0-9a-f-]{36}$/.test(gatewayId)) return null;
    return this.channel(this.rpcTopic(gatewayId));
  }

  private warnUnavailable(error: unknown): void {
    if (this.warnedUnavailable) return;
    this.warnedUnavailable = true;
    this.logger.warn(
      `Redis runtime unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unavailableRateLimit(): RateLimitResult {
  return {
    available: false,
    allowed: false,
    count: 0,
    retryAfterMs: 0,
    reservation: null,
  };
}

function validMessage(value: string): boolean {
  return Buffer.byteLength(value) <= MAX_REDIS_MESSAGE_BYTES;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}
