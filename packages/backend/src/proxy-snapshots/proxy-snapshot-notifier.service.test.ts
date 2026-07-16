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

  it('blocks routes without fencing the Agent recovery session', () => {
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
});
