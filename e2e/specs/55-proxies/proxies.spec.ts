import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';

type JsonRecord = Record<string, any>;

test(
  'HTTP proxy status, domain pools, and bindings are reachable',
  { ...coverageCase('http-proxy-api', 'http-proxy-api-live') },
  async ({ adminApi }) => {
    await expectJson(await adminApi.get('/api/admin/http-proxy/status'));
    await expectJson(await adminApi.get('/api/admin/http-proxy/bindings'));
    await expectJson(await adminApi.get('/api/admin/http-proxy/domain-pools'));
    await expectJson(await adminApi.get('/api/http-proxy/bindings'));
    await expectJson(await adminApi.get('/api/http-proxy/domain-pools'));

    const wildcard = `*.e2e-${Date.now().toString(36)}.example.test`;
    const pool = await expectJson<JsonRecord>(
      await adminApi.post('/api/admin/http-proxy/domain-pools', {
        data: { wildcardDomain: wildcard, enabled: true, httpsEnabled: false },
      }),
      [200, 201],
    );
    const patched = await expectJson<JsonRecord>(
      await adminApi.patch(`/api/admin/http-proxy/domain-pools/${pool.id}`, {
        data: { enabled: false },
      }),
    );
    expect(patched.id).toBe(pool.id);
    const missingBinding = '00000000-0000-4000-8000-0000000000dd';
    const createBinding = await adminApi.post('/api/http-proxy/bindings', {
      data: {
        hostname: `app${Date.now().toString(36)}.e2e.example.test`,
        containerId: missingBinding,
        targetPort: 80,
      },
    });
    expect(createBinding.status()).toBeGreaterThanOrEqual(400);
    const patchBinding = await adminApi.patch(`/api/http-proxy/bindings/${missingBinding}`, {
      data: { targetPort: 8080 },
    });
    expect(patchBinding.status()).toBeGreaterThanOrEqual(400);
    const deleteBinding = await adminApi.delete(`/api/http-proxy/bindings/${missingBinding}`);
    expect(deleteBinding.status()).toBeGreaterThanOrEqual(400);
    const deleted = await adminApi.delete(`/api/admin/http-proxy/domain-pools/${pool.id}`);
    expect([200, 204]).toContain(deleted.status());
  },
);

test(
  'SSH proxy status, host-key, rotate, and disconnect-all',
  { ...coverageCase('ssh-proxy-admin', 'ssh-proxy-admin-live') },
  async ({ adminApi }) => {
    await expectJson(await adminApi.get('/api/admin/ssh-proxy/status'));
    await expectJson(await adminApi.get('/api/admin/ssh-proxy/host-key'));
    await expectJson(await adminApi.post('/api/admin/ssh-proxy/host-key/rotate', { data: {} }));
    const disconnected = await adminApi.post('/api/admin/ssh-proxy/disconnect-all', { data: {} });
    expect([200, 204]).toContain(disconnected.status());
  },
);
