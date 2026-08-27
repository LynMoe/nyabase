import { describe, expect, it, vi } from 'vitest';
import { ProxySnapshotNotifierService } from './proxy-snapshot-notifier.service.js';

describe('ProxySnapshotNotifierService', () => {
  it('fans one post-commit revocation out to HTTP and SSH and isolates listener failure', async () => {
    const service = new ProxySnapshotNotifierService();
    const http = vi.fn().mockRejectedValue(new Error('http unavailable'));
    const ssh = vi.fn().mockResolvedValue(undefined);
    service.register('http', http);
    service.register('ssh', ssh);

    await expect(service.notify('container deleted')).resolves.toBeUndefined();

    expect(http).toHaveBeenCalledWith('container deleted');
    expect(ssh).toHaveBeenCalledWith('container deleted');
  });

  it('rejects duplicate channel ownership and unregisters only the current listener', () => {
    const service = new ProxySnapshotNotifierService();
    const first = vi.fn().mockResolvedValue(undefined);
    const unregister = service.register('ssh', first);

    expect(() => service.register('ssh', vi.fn())).toThrow(/already registered/);
    unregister();
    expect(() => service.register('ssh', vi.fn())).not.toThrow();
  });

  it('blocks routes without fencing the recovery session', () => {
    const service = new ProxySnapshotNotifierService();
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const fenceSession = vi.fn();
    service.register('http', invalidate);
    service.registerServerBlockListener(fenceSession);

    const epoch = service.blockServerRoutes('server-a', 'safety recovery pending');

    expect(service.isServerBlocked('server-a')).toBe(true);
    expect(invalidate).toHaveBeenCalledWith('safety recovery pending');
    expect(fenceSession).not.toHaveBeenCalled();
    expect(service.unblockServerIfEpoch('server-a', epoch + 1, 'stale report')).toBe(false);
    expect(service.unblockServerIfEpoch('server-a', epoch, 'recovered')).toBe(true);
    expect(service.isServerBlocked('server-a')).toBe(false);
  });

  it('fans remote Redis invalidations locally without republishing or trusting delivery', async () => {
    let subscribed: ((payload: string) => void) | undefined;
    const redis = {
      gatewayId: 'process-a',
      publish: vi.fn().mockResolvedValue(true),
      subscribe: vi.fn(async (_topic: string, handler: (payload: string) => void) => {
        subscribed = handler;
        return async () => undefined;
      }),
    };
    const service = new ProxySnapshotNotifierService(redis as never);
    const http = vi.fn().mockResolvedValue(undefined);
    service.register('http', http);
    service.onModuleInit();
    await Promise.resolve();

    subscribed?.(JSON.stringify({ origin: 'process-a', reason: 'self' }));
    expect(http).not.toHaveBeenCalled();
    subscribed?.(JSON.stringify({ origin: 'process-b', reason: 'route changed' }));
    expect(http).toHaveBeenCalledWith('redis:route changed');
    expect(redis.publish).not.toHaveBeenCalled();
    await service.onModuleDestroy();
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
    const service = new ProxySnapshotNotifierService(redis as never);
    service.onModuleInit();

    const destroyed = service.onModuleDestroy();
    resolveSubscribe(unsubscribe);
    await destroyed;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect((service as unknown as {
      unsubscribeRedis: unknown;
    }).unsubscribeRedis).toBeNull();
  });

  it('contains a rejected Redis subscription without an unhandled rejection', async () => {
    const redis = {
      subscribe: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const service = new ProxySnapshotNotifierService(redis as never);
    service.onModuleInit();
    await service.onModuleDestroy();
    expect(redis.subscribe).toHaveBeenCalledOnce();
  });
});
