import { describe, expect, it, vi } from 'vitest';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';

describe('AccessCacheEpochService', () => {
  it('advances monotonically for post-commit invalidation fences', () => {
    const epoch = new AccessCacheEpochService();
    expect(epoch.current()).toBe(0);
    expect(epoch.bump()).toBe(1);
    expect(epoch.bump()).toBe(2);
    expect(epoch.current()).toBe(2);
  });

  it('publishes post-commit invalidation and applies only remote Redis hints', async () => {
    let subscribed: ((payload: string) => void) | undefined;
    const redis = {
      gatewayId: 'process-a',
      publish: vi.fn().mockResolvedValue(true),
      subscribe: vi.fn(async (_topic: string, handler: (payload: string) => void) => {
        subscribed = handler;
        return async () => undefined;
      }),
    };
    const epoch = new AccessCacheEpochService(undefined as never, redis as never);
    epoch.onModuleInit();
    await Promise.resolve();

    expect(epoch.bump()).toBe(1);
    expect(redis.publish).toHaveBeenCalledWith(
      'cache-invalidation',
      'access:process-a',
    );
    subscribed?.('access:process-a');
    expect(epoch.current()).toBe(1);
    subscribed?.('access:process-b');
    expect(epoch.current()).toBe(2);
    await epoch.onModuleDestroy();
  });

  it('unsubscribes a Redis handler that resolves after destroy', async () => {
    let resolveSubscribe!: (unsubscribe: () => Promise<void>) => void;
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const redis = {
      subscribe: vi.fn(
        () => new Promise<() => Promise<void>>((resolve) => {
          resolveSubscribe = resolve;
        }),
      ),
    };
    const epoch = new AccessCacheEpochService(undefined as never, redis as never);
    epoch.onModuleInit();

    const destroyed = epoch.onModuleDestroy();
    resolveSubscribe(unsubscribe);
    await destroyed;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect((epoch as unknown as {
      unsubscribeRedis: unknown;
    }).unsubscribeRedis).toBeNull();
  });

  it('contains a rejected Redis subscription without an unhandled rejection', async () => {
    const redis = {
      subscribe: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const epoch = new AccessCacheEpochService(undefined as never, redis as never);
    epoch.onModuleInit();
    await epoch.onModuleDestroy();
    expect(redis.subscribe).toHaveBeenCalledOnce();
  });
});
