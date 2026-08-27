import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RedisClientType } from 'redis';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';
import type { RuntimeRoleService } from './runtime-role.service.js';
import {
  RedisDisposableAdapter,
  TRUST_TOKEN_TTL_MS,
} from './redis-disposable.adapter.js';

type StoredValue = { value: string; options?: Record<string, unknown> };

function fakeRedis() {
  const values = new Map<string, StoredValue>();
  const listeners = new Map<string, (message: string) => void>();
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  let available = true;
  const client = {
    isReady: false,
    isOpen: false,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
      return client;
    }),
    connect: vi.fn(async function (this: { isReady: boolean; isOpen: boolean }) {
      if (!available) throw new Error('redis down');
      this.isOpen = true;
      this.isReady = true;
    }),
    close: vi.fn(async function (this: { isReady: boolean; isOpen: boolean }) {
      this.isReady = false;
      this.isOpen = false;
    }),
    destroy: vi.fn(function (this: { isReady: boolean; isOpen: boolean }) {
      this.isReady = false;
      this.isOpen = false;
    }),
    set: vi.fn(async (key: string, value: string, options?: Record<string, unknown>) => {
      values.set(key, { value, options });
      return 'OK';
    }),
    get: vi.fn(async (key: string) => values.get(key)?.value ?? null),
    del: vi.fn(async (key: string) => values.delete(key) ? 1 : 0),
    publish: vi.fn(async (channel: string, payload: string) => {
      listeners.get(channel)?.(payload);
      return listeners.has(channel) ? 1 : 0;
    }),
    eval: vi.fn(async () => [
      1,
      1,
      1_000,
      '00000000-0000-4000-8000-000000000001',
    ]),
    duplicate: vi.fn(() => client),
    subscribe: vi.fn(async (channel: string, handler: (message: string) => void) => {
      listeners.set(channel, handler);
    }),
    unsubscribe: vi.fn(async (channel: string) => {
      listeners.delete(channel);
    }),
  };
  return {
    client,
    values,
    setAvailable(value: boolean) {
      available = value;
    },
    disconnect() {
      client.isReady = false;
      client.isOpen = false;
      for (const handler of eventHandlers.get('end') ?? []) handler();
    },
  };
}

function makeAdapter(
  role: 'all' | 'api' | 'worker' = 'api',
  fake = fakeRedis(),
): { adapter: RedisDisposableAdapter; fake: ReturnType<typeof fakeRedis> } {
  const config = {
    get: vi.fn((key: string) => key === 'redis.keyPrefix' ? 'test:' : undefined),
  } as unknown as NyabaseConfigService;
  const runtime = {
    servesProxySockets: () => role === 'all' || role === 'api',
  } as RuntimeRoleService;
  return {
    adapter: new RedisDisposableAdapter(
      fake.client as unknown as RedisClientType,
      config,
      runtime,
    ),
    fake,
  };
}

describe('RedisDisposableAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('puts a bounded TTL on every cache key', async () => {
    const { adapter, fake } = makeAdapter();

    await expect(adapter.setCache('projection-a', '{"ok":true}', 5_000)).resolves.toBe(true);

    expect(fake.values.get('test:cache:projection-a')?.options).toEqual({ PX: 5_000 });
    expect(fake.client.set).toHaveBeenCalledTimes(1);
    await adapter.onApplicationShutdown();
  });

  it('stores trust tokens under opaque references with a ten-minute TTL', async () => {
    const { adapter, fake } = makeAdapter();
    const serverId = '00000000-0000-4000-8000-000000000001';

    const reference = await adapter.storeTrustToken(serverId, 'one-time-secret');

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.client.set).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^test:trust-token:${serverId}:`)),
      'one-time-secret',
      { NX: true, PX: TRUST_TOKEN_TTL_MS },
    );
    await adapter.onApplicationShutdown();
  });

  it('atomically consumes a trust token only once and never falls back on Redis failure', async () => {
    const fake = fakeRedis();
    fake.client.eval
      .mockResolvedValueOnce('one-time-secret' as never)
      .mockResolvedValueOnce(false as never);
    const { adapter } = makeAdapter('worker', fake);
    const serverId = '00000000-0000-4000-8000-000000000001';
    const reference = '00000000-0000-4000-8000-000000000002';

    await expect(adapter.consumeTrustToken(serverId, reference)).resolves.toBe('one-time-secret');
    await expect(adapter.consumeTrustToken(serverId, reference)).resolves.toBeNull();
    expect(fake.client.eval).toHaveBeenCalledWith(
      expect.stringContaining('GET'),
      {
        keys: [`test:trust-token:${serverId}:${reference}`],
        arguments: [],
      },
    );

    fake.setAvailable(false);
    fake.client.isReady = false;
    fake.client.isOpen = false;
    await expect(adapter.consumeTrustToken(serverId, reference))
      .rejects.toThrow('Redis ephemeral state is unavailable');
    await adapter.onApplicationShutdown();
  });

  it('treats a Redis flush as a cache miss', async () => {
    const { adapter, fake } = makeAdapter();
    await adapter.setCache('projection-a', '{"ok":true}', 5_000);
    expect(await adapter.getCache('projection-a')).toBe('{"ok":true}');

    fake.values.clear();
    await expect(adapter.getCache('projection-a')).resolves.toBeNull();
    await adapter.onApplicationShutdown();
  });

  it('returns explicit unavailable fallbacks instead of throwing into control-plane work', async () => {
    const fake = fakeRedis();
    fake.client.connect.mockRejectedValue(new Error('redis down'));
    const { adapter } = makeAdapter('api', fake);

    await expect(adapter.getCache('anything')).resolves.toBeNull();
    await expect(adapter.publish('dispatch', 'server-a')).resolves.toBe(false);
    await expect(adapter.consumeRateLimit('login:subject', 5, 1_000)).resolves.toEqual({
      available: false,
      allowed: false,
      count: 0,
      retryAfterMs: 0,
      reservation: null,
    });
    await adapter.onApplicationShutdown();
  });

  it('namespaces at-most-once wake channels and delivers local subscriptions', async () => {
    const { adapter, fake } = makeAdapter();
    const handler = vi.fn();
    const unsubscribe = await adapter.subscribe('reconcile', handler);

    await expect(adapter.publish('reconcile', 'task-a')).resolves.toBe(true);
    expect(fake.client.publish).toHaveBeenCalledWith('test:wake:reconcile', 'task-a');
    expect(handler).toHaveBeenCalledWith('task-a');
    await unsubscribe();
    await adapter.onApplicationShutdown();
  });

  it('routes versioned RPC only to the addressed process channel', async () => {
    const { adapter, fake } = makeAdapter();
    const handler = vi.fn();
    const unsubscribe = await adapter.subscribeAddressedRpc(handler);

    await expect(adapter.publishAddressedRpc(
      adapter.gatewayId,
      '{"v":1}',
    )).resolves.toBe(true);
    expect(fake.client.publish).toHaveBeenCalledWith(
      `test:wake:rpc:v1:${adapter.gatewayId}`,
      '{"v":1}',
    );
    expect(handler).toHaveBeenCalledWith('{"v":1}');
    await expect(adapter.publishAddressedRpc('invalid', '{}')).resolves.toBe(false);
    await unsubscribe();
    await adapter.onApplicationShutdown();
  });

  it('duplicates the subscriber without overriding inherited TLS options', async () => {
    const { adapter, fake } = makeAdapter();
    const unsubscribe = await adapter.subscribeAddressedRpc(() => undefined);

    expect(fake.client.duplicate).toHaveBeenCalledWith();
    await unsubscribe();
    await adapter.onApplicationShutdown();
  });

  it('does not report addressed RPC ready when only the command client is ready', async () => {
    const { adapter } = makeAdapter();
    await adapter.setCache('connect', 'ok', 1_000);
    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.isAddressedRpcReady()).toBe(false);

    const unsubscribe = await adapter.subscribeAddressedRpc(() => undefined);
    expect(adapter.isAddressedRpcReady()).toBe(true);
    (adapter as unknown as {
      subscriber: { isReady: boolean };
    }).subscriber = { isReady: false };
    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.isAddressedRpcReady()).toBe(false);
    await unsubscribe();
    await adapter.onApplicationShutdown();
  });

  it('uses an expiring Lua counter for advisory rate limits', async () => {
    const { adapter, fake } = makeAdapter();
    fake.client.eval.mockResolvedValue([
      0,
      6,
      750,
      '00000000-0000-4000-8000-000000000001',
    ]);

    await expect(adapter.consumeRateLimit('handshake:subject', 5, 300_000)).resolves.toEqual({
      available: true,
      allowed: false,
      count: 6,
      retryAfterMs: 750,
      reservation: null,
    });
    expect(fake.client.eval).toHaveBeenCalledWith(
      expect.stringContaining('PEXPIRE'),
      {
        keys: ['test:limit:handshake:subject'],
        arguments: [
          '300000',
          '5',
          expect.stringMatching(/^[0-9a-f-]{36}$/),
          expect.stringMatching(/^[0-9a-f-]{36}$/),
        ],
      },
    );
    await adapter.onApplicationShutdown();
  });

  it('issues distinct bounded reservations within one rate-limit window', async () => {
    const { adapter, fake } = makeAdapter();
    const first = await adapter.consumeRateLimit('login:principal:abc', 5, 1_000);
    const second = await adapter.consumeRateLimit('login:principal:abc', 5, 1_000);

    expect(first.reservation?.windowId).toBe(second.reservation?.windowId);
    expect(first.reservation?.reservationId).not.toBe(
      second.reservation?.reservationId,
    );
    await expect(adapter.consumeRateLimit(
      'login:principal:abc',
      10_001,
      1_000,
    )).resolves.toMatchObject({ available: false, reservation: null });
    expect(fake.client.eval).toHaveBeenCalledTimes(2);
    await adapter.onApplicationShutdown();
  });

  it('atomically releases an exact reservation no more than once', async () => {
    const { adapter, fake } = makeAdapter();
    const reservation = {
      scope: 'login:principal:abc',
      windowId: '00000000-0000-4000-8000-000000000001',
      reservationId: '00000000-0000-4000-8000-000000000002',
    };
    fake.client.eval
      .mockResolvedValueOnce(1 as never)
      .mockResolvedValueOnce(0 as never);

    await expect(adapter.releaseRateLimit(reservation)).resolves.toBe(true);
    await expect(adapter.releaseRateLimit(reservation)).resolves.toBe(false);
    expect(fake.client.eval).toHaveBeenCalledWith(
      expect.stringContaining('HDEL'),
      {
        keys: ['test:limit:login:principal:abc'],
        arguments: [reservation.windowId, reservation.reservationId],
      },
    );
    const evalCalls = fake.client.eval.mock.calls as unknown as Array<[string]>;
    const releaseScript = evalCalls[0]![0];
    expect(releaseScript.match(/HINCRBY/g)).toHaveLength(1);
    expect(releaseScript.match(/HDEL/g)).toHaveLength(1);
    await adapter.onApplicationShutdown();
  });

  it('waits for a late primary connect and performs no command after shutdown starts', async () => {
    const fake = fakeRedis();
    let finishConnect!: () => void;
    fake.client.connect.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishConnect = resolve;
      });
      fake.client.isOpen = true;
      fake.client.isReady = true;
    });
    const { adapter } = makeAdapter('api', fake);
    const read = adapter.getCache('late');
    await vi.waitFor(() => expect(fake.client.connect).toHaveBeenCalledOnce());

    const shutdown = adapter.onApplicationShutdown();
    finishConnect();

    await expect(read).resolves.toBeNull();
    await expect(shutdown).resolves.toBeUndefined();
    expect(fake.client.get).not.toHaveBeenCalled();
    expect(fake.client.close).toHaveBeenCalled();
  });

  it('closes a subscriber whose connect resolves after shutdown begins', async () => {
    const fake = fakeRedis();
    const { adapter } = makeAdapter('api', fake);
    await adapter.setCache('connected', 'yes', 1_000);
    let finishSubscriberConnect!: () => void;
    const subscriber = {
      ...fake.client,
      isOpen: false,
      isReady: false,
      connect: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          finishSubscriberConnect = resolve;
        });
        subscriber.isOpen = true;
        subscriber.isReady = true;
      }),
      close: vi.fn(async () => {
        subscriber.isOpen = false;
        subscriber.isReady = false;
      }),
    };
    fake.client.duplicate.mockReturnValue(subscriber);
    const subscribing = adapter.subscribeAddressedRpc(() => undefined);
    await vi.waitFor(() => expect(subscriber.connect).toHaveBeenCalledOnce());

    const shutdown = adapter.onApplicationShutdown();
    finishSubscriberConnect();

    await expect(subscribing).rejects.toThrow('shutting down');
    await expect(shutdown).resolves.toBeUndefined();
    expect(subscriber.close).toHaveBeenCalled();
  });

  it('serializes unsubscribe with a concurrent resubscribe to the same topic', async () => {
    const fake = fakeRedis();
    const { adapter } = makeAdapter('api', fake);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = await adapter.subscribe('dispatch', first);
    let finishUnsubscribe!: () => void;
    fake.client.unsubscribe.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishUnsubscribe = resolve;
      });
    });
    const removing = unsubscribeFirst();
    await vi.waitFor(() => expect(fake.client.unsubscribe).toHaveBeenCalledOnce());
    const subscribing = adapter.subscribe('dispatch', second);
    finishUnsubscribe();
    const unsubscribeSecond = await subscribing;
    await removing;

    await adapter.publish('dispatch', 'wake');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('wake');
    expect(fake.client.subscribe).toHaveBeenCalledTimes(2);
    await unsubscribeSecond();
    await adapter.onApplicationShutdown();
  });

  it('bounds shutdown even when Redis close never resolves', async () => {
    vi.useFakeTimers();
    const fake = fakeRedis();
    const { adapter } = makeAdapter('api', fake);
    await adapter.setCache('connected', 'yes', 1_000);
    fake.client.close.mockReturnValue(new Promise(() => undefined));

    const shutdown = adapter.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(shutdown).resolves.toBeUndefined();
    expect(fake.client.destroy).toHaveBeenCalledOnce();
  });

  it('rejects oversized outbound messages before touching Redis', async () => {
    const { adapter, fake } = makeAdapter();
    await expect(adapter.publish(
      'dispatch',
      'x'.repeat(1024 * 1024 + 1),
    )).resolves.toBe(false);
    expect(fake.client.connect).not.toHaveBeenCalled();
    expect(fake.client.publish).not.toHaveBeenCalled();
    await adapter.onApplicationShutdown();
  });

  it('retains subscriptions across startup outage and subscribes after Redis recovers', async () => {
    vi.useFakeTimers();
    const fake = fakeRedis();
    fake.setAvailable(false);
    const { adapter } = makeAdapter('api', fake);
    const handler = vi.fn();
    adapter.onModuleInit();

    const unsubscribe = await adapter.subscribe('dispatch', handler);
    expect(fake.client.subscribe).not.toHaveBeenCalled();

    fake.setAvailable(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.client.subscribe).toHaveBeenCalledWith(
      'test:wake:dispatch',
      expect.any(Function),
    );
    await adapter.publish('dispatch', 'server-a');
    expect(handler).toHaveBeenCalledWith('server-a');

    await unsubscribe();
    await adapter.onApplicationShutdown();
  });

  it('rebuilds a dropped subscriber and restores every registered topic', async () => {
    vi.useFakeTimers();
    const fake = fakeRedis();
    const { adapter } = makeAdapter('api', fake);
    const dispatch = vi.fn();
    const finalize = vi.fn();
    adapter.onModuleInit();
    const unsubscribeDispatch = await adapter.subscribe('dispatch', dispatch);
    const unsubscribeFinalize = await adapter.subscribe('reconcile', finalize);
    expect(fake.client.subscribe).toHaveBeenCalledTimes(2);

    fake.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.client.subscribe).toHaveBeenCalledTimes(4);

    await adapter.publish('dispatch', 'server-a');
    await adapter.publish('reconcile', 'task-a');
    expect(dispatch).toHaveBeenCalledWith('server-a');
    expect(finalize).toHaveBeenCalledWith('task-a');

    await unsubscribeDispatch();
    await unsubscribeFinalize();
    await adapter.onApplicationShutdown();
  });
});
