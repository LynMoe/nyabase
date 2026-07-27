import { describe, expect, it } from 'vitest';
import { AdminRuntimeMetricsController } from './admin-runtime-metrics.controller.js';

describe('AdminRuntimeMetricsController', () => {
  it('returns bounded aggregate dependency metrics without raw errors or identities', () => {
    const controller = new AdminRuntimeMetricsController(
      {
        totalCount: 8,
        idleCount: 3,
        waitingCount: 2,
        options: { max: 12 },
      } as never,
      {
        isAvailable: () => true,
        isAddressedRpcReady: () => false,
      } as never,
      {
        role: 'api',
        requiresRedisAvailability: () => true,
      } as never,
      {
        getStats: () => ({
          queued: 4,
          queuedPoints: 20,
          queuedBytes: 1024,
          dropped: 3,
          inFlight: 1,
          lastFlushAt: 1234,
          lastError: 'redis://user:secret@example/private-server',
        }),
      } as never,
    );

    const result = controller.runtime();
    expect(result).toEqual({
      role: 'api',
      postgres: { total: 8, idle: 3, waiting: 2, max: 12 },
      redis: { available: true, addressedRpcReady: false, required: true },
      telemetry: {
        queuedBatches: 4,
        queuedPoints: 20,
        queuedBytes: 1024,
        droppedBatches: 3,
        inFlightFlushes: 1,
        lastFlushAt: 1234,
        degraded: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private-server|user:/);
  });
});
