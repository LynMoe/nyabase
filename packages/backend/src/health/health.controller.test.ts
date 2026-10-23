import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PgSchemaReadiness } from '../platform/persistence-pg/persistence-pg.module.js';
import { HealthController, SharedCheck } from './health.controller.js';
import { RuntimeLifecycleService } from './runtime-lifecycle.service.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('SharedCheck', () => {
  it('runs one check for concurrent callers', async () => {
    const pending = deferred();
    const check = vi.fn(() => pending.promise);
    const shared = new SharedCheck(check, 1_000, () => 0);
    const results = [shared.run(), shared.run(), shared.run()];
    pending.resolve();
    await expect(Promise.all(results)).resolves.toEqual([true, true, true]);
    expect(check).toHaveBeenCalledOnce();
  });

  it('reuses a verdict until it is ttl old, failures included', async () => {
    let now = 0;
    const check = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('pool exhausted'))
      .mockResolvedValue(undefined);
    const shared = new SharedCheck(check, 1_000, () => now);

    await expect(shared.run()).resolves.toBe(false);
    now = 999;
    await expect(shared.run()).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(1);

    now = 1_000;
    await expect(shared.run()).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('HealthController readiness', () => {
  function controller(check: () => Promise<void>) {
    const lifecycle = new RuntimeLifecycleService();
    const readiness = { check } as unknown as PgSchemaReadiness;
    return { lifecycle, health: new HealthController(readiness, lifecycle) };
  }

  it('answers a probe flood with one database check', async () => {
    const check = vi.fn(async () => undefined);
    const { lifecycle, health } = controller(check);
    lifecycle.markReady();
    const results = await Promise.all(Array.from({ length: 50 }, () => health.ready()));
    expect(results.every((result) => result.database === 'ok')).toBe(true);
    expect(check).toHaveBeenCalledOnce();
  });

  it('reports the database as not ready, and draining before touching it', async () => {
    const check = vi.fn(async () => { throw new Error('down'); });
    const { lifecycle, health } = controller(check);
    await expect(health.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(check).not.toHaveBeenCalled();

    lifecycle.markReady();
    await expect(health.ready()).rejects.toMatchObject({
      response: { code: 'DATABASE_NOT_READY' },
    });
    lifecycle.beforeApplicationShutdown();
    await expect(health.ready()).rejects.toMatchObject({
      response: { code: 'PROCESS_NOT_READY' },
    });
  });
});
