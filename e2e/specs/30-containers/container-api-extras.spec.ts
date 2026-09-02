import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';

const missing = '00000000-0000-4000-8000-0000000000cc';

test(
  'admin intent list and retry of an unknown intent are fail-closed',
  { ...coverageCase('admin-intents-list-retry', 'admin-intents-list-retry-live') },
  async ({ adminApi }) => {
    const listed = await expectJson<{ items?: unknown[] } | unknown[]>(
      await adminApi.get('/api/admin/intents'),
    );
    expect(listed).toBeDefined();
    const retry = await adminApi.post(
      '/api/admin/intents/00000000-0000-4000-8000-0000000000bb/retry',
      { data: {} },
    );
    expect(retry.status()).toBe(404);
  },
);

test(
  'stats, extension, exec, power, and limit routes reject an unknown container',
  { ...coverageCase('container-stats-gpu-exec', 'container-stats-gpu-exec-live') },
  async ({ adminApi }) => {
    const listed = await expectJson<unknown>(await adminApi.get('/api/admin/containers'));
    expect(listed).toBeDefined();

    const userStats = await adminApi.get(`/api/containers/${missing}/stats`);
    expect(userStats.status()).toBeGreaterThanOrEqual(400);
    const adminStats = await adminApi.get(`/api/admin/containers/${missing}/stats`);
    expect(adminStats.status()).toBeGreaterThanOrEqual(400);
    const volumes = await adminApi.get(`/api/admin/containers/${missing}/volumes`);
    expect([200, 400, 403, 404]).toContain(volumes.status());
    const intents = await adminApi.get(`/api/admin/containers/${missing}/intents`);
    expect([200, 400, 403, 404]).toContain(intents.status());

    const userExtension = await adminApi.patch(`/api/containers/${missing}/extensions/nvidia-gpu`, {
      data: { pciAddresses: [] },
    });
    expect(userExtension.status()).toBeGreaterThanOrEqual(400);
    const adminExtension = await adminApi.patch(`/api/admin/containers/${missing}/extensions/nvidia-gpu`, {
      data: { pciAddresses: [] },
    });
    expect(adminExtension.status()).toBeGreaterThanOrEqual(400);
    const limits = await adminApi.patch(`/api/admin/containers/${missing}/limits`, {
      data: { cpuMillis: 500, memBytes: 512 * 1024 * 1024 },
    });
    expect(limits.status()).toBeGreaterThanOrEqual(400);
    const rootSize = await adminApi.patch(`/api/admin/containers/${missing}/root-size`, {
      data: { sizeBytes: 4 * 1024 * 1024 * 1024 },
    });
    expect(rootSize.status()).toBeGreaterThanOrEqual(400);

    const userExec = await adminApi.post(`/api/containers/${missing}/exec-sessions`, {
      data: { command: ['/bin/true'], tty: false },
    });
    expect(userExec.status()).toBeGreaterThanOrEqual(400);
    for (const action of ['start', 'stop', 'restart'] as const) {
      const response = await adminApi.post(
        `/api/admin/containers/${missing}/actions/${action}`,
        { data: {} },
      );
      expect(response.status()).toBeGreaterThanOrEqual(400);
    }
  },
);
