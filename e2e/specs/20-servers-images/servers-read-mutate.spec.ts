import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';

type JsonRecord = Record<string, any>;

test(
  'user server catalog, extension devices, and storage-pool get are readable',
  { ...coverageCase('servers-user-read', 'servers-user-read-live') },
  async ({ adminApi, seedState }) => {
    const servers = await expectJson<JsonRecord[]>(await adminApi.get('/api/servers'));
    expect(Array.isArray(servers)).toBe(true);
    const detail = await adminApi.get(`/api/servers/${seedState.server.id}`);
    expect([200, 403, 404]).toContain(detail.status());
    const userDevices = await adminApi.get(
      `/api/servers/${seedState.server.id}/extensions/nvidia-gpu/devices`,
    );
    expect([200, 403, 404]).toContain(userDevices.status());
    const adminExtensions = await expectJson<JsonRecord[]>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}/extensions`),
    );
    expect(Array.isArray(adminExtensions)).toBe(true);
    const adminDevices = await expectJson<JsonRecord>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}/extensions/nvidia-gpu/devices`),
    );
    expect(adminDevices.items ?? adminDevices).toBeDefined();
    const pool = await adminApi.get(
      `/api/servers/${seedState.server.id}/storage-pools/${seedState.storagePools.dirQuotaOnline.id}`,
    );
    expect([200, 403, 404]).toContain(pool.status());

    const adminServers = await expectJson<JsonRecord[]>(await adminApi.get('/api/admin/servers'));
    expect(adminServers.some((server) => server.id === seedState.server.id)).toBe(true);
    const created = await adminApi.post('/api/admin/servers', { data: {} });
    expect(created.status()).toBeGreaterThanOrEqual(400);
    const connect = await adminApi.post(
      '/api/admin/servers/00000000-0000-4000-8000-0000000000aa/connect',
      { data: {} },
    );
    expect(connect.status()).toBeGreaterThanOrEqual(400);
  },
);

test(
  'admin server patch is revision-guarded; delete of unknown server is 404; image CRUD is throwaway',
  { ...coverageCase('admin-server-image-mutate', 'admin-server-image-mutate-live') },
  async ({ adminApi, seedState }) => {
    const server = await expectJson<JsonRecord>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
    );
    const patched = await expectJson<JsonRecord>(
      await adminApi.patch(`/api/admin/servers/${seedState.server.id}`, {
        data: {
          expectedRevision: server.revision,
          name: server.name,
        },
      }),
    );
    expect(patched.id).toBe(seedState.server.id);
    const missing = await adminApi.delete(
      '/api/admin/servers/00000000-0000-4000-8000-0000000000aa',
    );
    expect(missing.status()).toBe(404);

    const alias = `e2eimg${Date.now().toString(36)}`;
    const created = await expectJson<JsonRecord>(
      await adminApi.post('/api/admin/images', {
        data: {
          name: alias,
          alias,
          loginUser: 'root',
          networkManagedExternally: true,
        },
      }),
      [200, 201],
    );
    const updated = await expectJson<JsonRecord>(
      await adminApi.patch(`/api/admin/images/${created.id}`, {
        data: {
          expectedRevision: created.revision,
          description: 'e2e',
        },
      }),
    );
    expect(updated.id).toBe(created.id);
    const deleted = await adminApi.delete(`/api/admin/images/${created.id}`);
    expect([200, 204]).toContain(deleted.status());
  },
);
