import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('serves dependency-free liveness', () => {
    const controller = new HealthController({
      isInitialized: false,
      query: vi.fn(),
    } as never);

    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('reports ready only after a read-only database probe succeeds', async () => {
    const query = vi.fn().mockResolvedValue([{ 1: 1 }]);
    const controller = new HealthController({ isInitialized: true, query } as never);

    await expect(controller.ready()).resolves.toEqual({ status: 'ok', database: 'ok' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('fails closed when TypeORM has not initialized', async () => {
    const query = vi.fn();
    const controller = new HealthController({ isInitialized: false, query } as never);

    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when the database probe errors', async () => {
    const controller = new HealthController({
      isInitialized: true,
      query: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as never);

    await expect(controller.ready()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DATABASE_NOT_READY' }),
      status: 503,
    });
  });
});
