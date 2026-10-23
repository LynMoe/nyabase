import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerRecoveryService } from './server-recovery.service.js';

describe('ServerRecoveryService timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns a database error during a scheduled probe into a later retry, not an unhandled rejection', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const failingQuery = {
      select: () => failingQuery,
      where: () => failingQuery,
      executeTakeFirst: () => Promise.reject(new Error('connection terminated')),
    };
    const database = { selectFrom: () => failingQuery };
    const agents = { isConnected: vi.fn(() => true) };
    const service = new ServerRecoveryService(
      database as never,
      agents as never,
      { get: vi.fn() } as never,
      { wake: vi.fn() } as never,
    );
    try {
      service.watch('server-1', 1_000);
      const watch = vi.spyOn(service, 'watch');
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(watch).toHaveBeenCalledWith('server-1', 2_000);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      service.onModuleDestroy();
      process.off('unhandledRejection', unhandled);
    }
  });
});
