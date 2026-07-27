import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';
import type { RuntimeRoleService } from './runtime-role.service.js';
import { RedisDisposableAdapter } from './redis-disposable.adapter.js';

const redisUrl = process.env.NYABASE_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('RedisDisposableAdapter real Redis integration', () => {
  const prefix = `test:${randomUUID()}:`;
  let client: RedisClientType;
  let adapter: RedisDisposableAdapter;

  beforeAll(async () => {
    client = createClient({
      url: redisUrl,
      disableClientInfo: true,
      socket: {
        connectTimeout: 1_000,
        reconnectStrategy: false,
      },
    }) as RedisClientType;
    adapter = new RedisDisposableAdapter(
      client,
      {
        get: (key: string) => key === 'redis.keyPrefix' ? prefix : undefined,
      } as NyabaseConfigService,
      { servesGateway: () => false } as RuntimeRoleService,
    );
    adapter.onModuleInit();
    const deadline = Date.now() + 5_000;
    while (!adapter.isAvailable() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!adapter.isAvailable()) {
      throw new Error('Redis client did not become ready within 5 seconds');
    }
  });

  afterAll(async () => {
    if (adapter) await adapter.onApplicationShutdown();
  });

  it('executes TTL cache and atomic rate-limit commands against Redis', async () => {
    await expect(adapter.setCache('real', 'value', 30_000)).resolves.toBe(true);
    await expect(adapter.getCache('real')).resolves.toBe('value');

    const first = await adapter.consumeRateLimit('login:real', 1, 30_000);
    const second = await adapter.consumeRateLimit('login:real', 1, 30_000);
    expect(first).toMatchObject({ available: true, allowed: true, count: 1 });
    expect(second).toMatchObject({ available: true, allowed: false, count: 1 });
    expect(second.retryAfterMs).toBeGreaterThan(0);
    expect(second.retryAfterMs).toBeLessThanOrEqual(30_000);

    const rollbackScope = `login:rollback:${randomUUID()}`;
    const reservedA = await adapter.consumeRateLimit(rollbackScope, 2, 30_000);
    const reservedB = await adapter.consumeRateLimit(rollbackScope, 2, 30_000);
    expect(reservedA).toMatchObject({ allowed: true, count: 1 });
    expect(reservedB).toMatchObject({ allowed: true, count: 2 });
    await expect(adapter.releaseRateLimit(reservedB.reservation!)).resolves.toBe(true);
    await expect(adapter.consumeRateLimit(rollbackScope, 2, 30_000))
      .resolves.toMatchObject({ allowed: true, count: 2 });
  });

  it('makes rate-limit reservations one-shot and window-bound', async () => {
    const doubleScope = `login:double:${randomUUID()}`;
    const doubleA = await adapter.consumeRateLimit(doubleScope, 2, 30_000);
    const doubleB = await adapter.consumeRateLimit(doubleScope, 2, 30_000);
    expect(doubleA.reservation).not.toBeNull();
    expect(doubleB.reservation).not.toBeNull();
    expect(doubleA.reservation?.windowId).toBe(doubleB.reservation?.windowId);
    expect(doubleA.reservation?.reservationId).not.toBe(
      doubleB.reservation?.reservationId,
    );
    await expect(adapter.releaseRateLimit(doubleB.reservation!)).resolves.toBe(true);
    await expect(adapter.releaseRateLimit(doubleB.reservation!)).resolves.toBe(false);
    await expect(adapter.consumeRateLimit(doubleScope, 2, 30_000))
      .resolves.toMatchObject({ allowed: true, count: 2 });

    const concurrentScope = `login:concurrent:${randomUUID()}`;
    const concurrentA = await adapter.consumeRateLimit(
      concurrentScope,
      2,
      30_000,
    );
    const concurrentB = await adapter.consumeRateLimit(
      concurrentScope,
      2,
      30_000,
    );
    expect(concurrentA.reservation?.windowId).toBe(
      concurrentB.reservation?.windowId,
    );
    const releases = await Promise.all([
      adapter.releaseRateLimit(concurrentA.reservation!),
      adapter.releaseRateLimit(concurrentA.reservation!),
      adapter.releaseRateLimit(concurrentB.reservation!),
      adapter.releaseRateLimit(concurrentB.reservation!),
    ]);
    expect(releases.filter(Boolean)).toHaveLength(2);
    expect(releases.filter((released) => !released)).toHaveLength(2);
    await expect(adapter.consumeRateLimit(concurrentScope, 2, 30_000))
      .resolves.toMatchObject({ allowed: true, count: 1 });

    const rolloverScope = `login:rollover:${randomUUID()}`;
    const expired = await adapter.consumeRateLimit(rolloverScope, 2, 100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const fresh = await adapter.consumeRateLimit(rolloverScope, 2, 30_000);
    expect(fresh.reservation?.windowId).not.toBe(expired.reservation?.windowId);
    await expect(adapter.releaseRateLimit(expired.reservation!)).resolves.toBe(false);
    await expect(adapter.consumeRateLimit(rolloverScope, 2, 30_000))
      .resolves.toMatchObject({ allowed: true, count: 2 });
  });

  it('delivers addressed RPC through one process subscription', async () => {
    const messages: string[] = [];
    const unsubscribe = await adapter.subscribeAddressedRpc((message) => {
      messages.push(message);
    });

    await expect(adapter.publishAddressedRpc(
      adapter.gatewayId,
      JSON.stringify({ v: 1, requestId: 'real-rpc' }),
    )).resolves.toBe(true);
    await expect.poll(() => messages, { timeout: 2_000 }).toEqual([
      JSON.stringify({ v: 1, requestId: 'real-rpc' }),
    ]);
    await unsubscribe();
  });

  it('fans out once to concurrent local handlers and resubscribes after all release', async () => {
    const first: string[] = [];
    const second: string[] = [];
    const [unsubscribeFirst, unsubscribeSecond] = await Promise.all([
      adapter.subscribeAddressedRpc((message) => {
        first.push(message);
      }),
      adapter.subscribeAddressedRpc((message) => {
        second.push(message);
      }),
    ]);
    await adapter.publishAddressedRpc(adapter.gatewayId, 'concurrent-one');
    await expect.poll(() => [first, second], { timeout: 2_000 }).toEqual([
      ['concurrent-one'],
      ['concurrent-one'],
    ]);

    await Promise.all([unsubscribeFirst(), unsubscribeSecond()]);
    const replacement: string[] = [];
    const unsubscribeReplacement = await adapter.subscribeAddressedRpc(
      (message) => {
        replacement.push(message);
      },
    );
    await adapter.publishAddressedRpc(adapter.gatewayId, 'concurrent-two');
    await expect.poll(() => replacement, { timeout: 2_000 })
      .toEqual(['concurrent-two']);
    expect(first).toEqual(['concurrent-one']);
    expect(second).toEqual(['concurrent-one']);
    await unsubscribeReplacement();
  });

  it('restores the addressed subscription after Redis kills its Pub/Sub connection', async () => {
    const received: string[] = [];
    const unsubscribe = await adapter.subscribeAddressedRpc(
      (message) => {
        received.push(message);
      },
    );
    const listed: unknown = await client.sendCommand([
      'CLIENT',
      'LIST',
      'TYPE',
      'PUBSUB',
    ]).catch(() => null);
    if (typeof listed !== 'string') {
      await unsubscribe();
      return;
    }
    const subscriberId = listed
      .split('\n')
      .map((line) => line.match(/(?:^| )id=(\d+)(?: |$)/)?.[1])
      .find(Boolean);
    expect(subscriberId).toBeDefined();
    await client.sendCommand(['CLIENT', 'KILL', 'ID', subscriberId!]);
    await expect.poll(() => adapter.isAddressedRpcReady(), { timeout: 2_000 })
      .toBe(false);
    await expect.poll(() => adapter.isAddressedRpcReady(), { timeout: 5_000 })
      .toBe(true);

    await adapter.publishAddressedRpc(adapter.gatewayId, 'after-reconnect');
    await expect.poll(() => received, { timeout: 2_000 })
      .toEqual(['after-reconnect']);
    await unsubscribe();
  });

  it('fails an unavailable addressed publication within the connect deadline', async () => {
    const unavailableClient = createClient({
      url: 'redis://127.0.0.1:1/0',
      socket: {
        connectTimeout: 250,
        reconnectStrategy: false,
      },
    }) as RedisClientType;
    const unavailable = new RedisDisposableAdapter(
      unavailableClient,
      {
        get: (key: string) => key === 'redis.keyPrefix' ? prefix : undefined,
      } as NyabaseConfigService,
      { servesGateway: () => false } as RuntimeRoleService,
    );
    const startedAt = performance.now();
    await expect(unavailable.publishAddressedRpc(
      unavailable.gatewayId,
      '{}',
    )).resolves.toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    await unavailable.onApplicationShutdown();
  });
});
