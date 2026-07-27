import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';
import { RuntimeLifecycleService } from './runtime-lifecycle.service.js';

describe('HealthController', () => {
  const redis = { isAddressedRpcReady: vi.fn().mockReturnValue(false) };
  const allRole = { requiresRedisAvailability: vi.fn().mockReturnValue(false) };
  const readyLifecycle = { isAcceptingTraffic: vi.fn().mockReturnValue(true) };
  const readyProjection = { isProjectionReady: vi.fn().mockReturnValue(true) };

  it('serves dependency-free liveness', () => {
    const controller = new HealthController({
      check: vi.fn(),
    } as never, redis as never, allRole as never, readyLifecycle as never, readyProjection as never);

    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('preserves the public readiness shape after the PostgreSQL probe succeeds', async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const controller = new HealthController(
      { check } as never,
      redis as never,
      allRole as never,
      readyLifecycle as never,
      readyProjection as never,
    );

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      database: 'ok',
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it('fails closed when PostgreSQL is unavailable', async () => {
    const controller = new HealthController({
      check: vi.fn().mockRejectedValue(new Error('schema incompatible')),
    } as never, redis as never, allRole as never, readyLifecycle as never, readyProjection as never);

    await expect(controller.ready()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DATABASE_NOT_READY' }),
      status: 503,
    });
  });

  it('fails closed on Redis only for split API/Gateway roles', async () => {
    const splitRole = { requiresRedisAvailability: vi.fn().mockReturnValue(true) };
    const controller = new HealthController(
      { check: vi.fn().mockResolvedValue(undefined) } as never,
      redis as never,
      splitRole as never,
      readyLifecycle as never,
      readyProjection as never,
    );

    await expect(controller.ready()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'REDIS_NOT_READY' }),
      status: 503,
    });
  });

  it('fails readiness while startup is incomplete or shutdown is draining', async () => {
    const controller = new HealthController(
      { check: vi.fn() } as never,
      redis as never,
      allRole as never,
      { isAcceptingTraffic: vi.fn().mockReturnValue(false) } as never,
      readyProjection as never,
    );

    await expect(controller.ready()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROCESS_NOT_READY' }),
      status: 503,
    });
  });

  it('fails API-only readiness when the durable Agent projection poll is unhealthy', async () => {
    const controller = new HealthController(
      { check: vi.fn().mockResolvedValue(undefined) } as never,
      redis as never,
      allRole as never,
      readyLifecycle as never,
      { isProjectionReady: vi.fn().mockReturnValue(false) } as never,
    );

    await expect(controller.ready()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AGENT_PROJECTION_NOT_READY' }),
      status: 503,
    });
  });

  it('marks the process unready before dependency shutdown starts', () => {
    const lifecycle = new RuntimeLifecycleService();
    expect(lifecycle.isAcceptingTraffic()).toBe(false);
    lifecycle.markReady();
    expect(lifecycle.isAcceptingTraffic()).toBe(true);
    lifecycle.beforeApplicationShutdown();
    expect(lifecycle.isAcceptingTraffic()).toBe(false);
  });
});
