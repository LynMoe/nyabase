import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import {
  createPersonaUser,
  deletePersonaUser,
  loginPersona,
  readErrorBody,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

const E2E_SSH_PUB =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMUSvfm6E/IR+VAbs1kgJHtzswUDgA/l0ZMjcnkLni6J e2e';

test(
  'admin user list, get, patch, and ssh-key delete observe the admin user API',
  { ...coverageCase('iam-admin-users', 'iam-admin-users-live') },
  async ({ adminApi, seedState }) => {
    const users = await expectJson<JsonRecord[]>(await adminApi.get('/api/admin/users'));
    expect(Array.isArray(users)).toBe(true);
    const self = await expectJson<JsonRecord>(
      await adminApi.get(`/api/admin/users/${seedState.adminUserId}`),
    );
    expect(self.id).toBe(seedState.adminUserId);
    const patched = await expectJson<JsonRecord>(
      await adminApi.patch(`/api/admin/users/${seedState.adminUserId}`, {
        data: { displayName: self.displayName },
      }),
    );
    expect(patched.id).toBe(seedState.adminUserId);
    const keys = await expectJson<JsonRecord[]>(
      await adminApi.get(`/api/admin/users/${seedState.adminUserId}/ssh-keys`),
    );
    expect(Array.isArray(keys)).toBe(true);
    const missing = await adminApi.delete(
      `/api/admin/users/${seedState.adminUserId}/ssh-keys/00000000-0000-4000-8000-000000000001`,
    );
    expect([404, 204]).toContain(missing.status());
  },
);

test(
  'self-service user profile and ssh keys round-trip',
  { ...coverageCase('iam-self-user', 'iam-self-user-live') },
  async ({ adminApi, authedApiFactory }) => {
    const persona = await createPersonaUser(adminApi, 'selfu');
    try {
      const login = await expectJson<JsonRecord>(
        await adminApi.post('/api/auth/login', {
          data: { username: persona.username, password: persona.password },
        }),
      );
      const api = await authedApiFactory(login.accessToken as string);
      const me = await expectJson<JsonRecord>(await api.get(`/api/users/${persona.userId}`));
      expect(me.id).toBe(persona.userId);
      const patched = await expectJson<JsonRecord>(
        await api.patch(`/api/users/${persona.userId}`, {
          data: { displayName: `${persona.displayName} x` },
        }),
      );
      expect(patched.displayName).toContain(persona.displayName);
      const created = await expectJson<JsonRecord>(
        await api.post(`/api/users/${persona.userId}/ssh-keys`, {
          data: { name: 'e2e-key', keyText: E2E_SSH_PUB },
        }),
        [200, 201],
      );
      const listed = await expectJson<JsonRecord[]>(
        await api.get(`/api/users/${persona.userId}/ssh-keys`),
      );
      expect(listed.some((key) => key.id === created.id)).toBe(true);
      const deleted = await api.delete(`/api/users/${persona.userId}/ssh-keys/${created.id}`);
      expect([200, 204]).toContain(deleted.status());

      const statusDenied = await api.patch(`/api/users/${persona.userId}`, {
        data: { status: 'disabled' },
      });
      expect(statusDenied.status()).toBeGreaterThanOrEqual(400);

      const other = await createPersonaUser(adminApi, 'selfx');
      try {
        const cross = await api.patch(`/api/users/${other.userId}`, {
          data: { displayName: 'hijacked' },
        });
        expect(cross.status()).toBe(403);
      } finally {
        await deletePersonaUser(adminApi, other.userId);
      }

      const wrongPassword = await readErrorBody(
        await api.patch(`/api/users/${persona.userId}`, {
          data: { password: 'E2ePass_new_ok_1', currentPassword: 'definitely-wrong' },
        }),
      );
      expect(wrongPassword.status).toBe(401);

      const nextPassword = `E2ePass_new_${Date.now().toString(36)}_9`;
      const rotated = await expectJson<JsonRecord>(
        await api.patch(`/api/users/${persona.userId}`, {
          data: { password: nextPassword, currentPassword: persona.password },
        }),
      );
      expect(rotated.id).toBe(persona.userId);
      const oldLogin = await readErrorBody(
        await adminApi.post('/api/auth/login', {
          data: { username: persona.username, password: persona.password },
        }),
      );
      expect(oldLogin.status).toBe(401);
      const session = await expectJson<JsonRecord>(
        await adminApi.post('/api/auth/login', {
          data: { username: persona.username, password: nextPassword },
        }),
      );
      expect(session.accessToken).toBeTruthy();
    } finally {
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);

test(
  'admin group CRUD, membership, and group grants',
  { ...coverageCase('iam-admin-groups', 'iam-admin-groups-live') },
  async ({ adminApi, seedState }) => {
    const persona = await createPersonaUser(adminApi, 'grpm');
    let groupId: string | undefined;
    try {
      const created = await expectJson<JsonRecord>(
        await adminApi.post('/api/admin/groups', {
          data: { name: `e2e-g-${Date.now().toString(36)}` },
        }),
        [200, 201],
      );
      groupId = created.id as string;
      expect(groupId).toBeTruthy();
      const listed = await expectJson<JsonRecord[]>(await adminApi.get('/api/admin/groups'));
      expect(listed.some((group) => group.id === groupId)).toBe(true);
      const detail = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/groups/${groupId}`),
      );
      const patched = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/groups/${groupId}`, {
          data: {
            expectedRevision: detail.revision,
            description: 'e2e',
          },
        }),
      );
      expect(patched.id).toBe(groupId);
      await expectJson(await adminApi.get(`/api/admin/groups/${groupId}/members`));
      await expectJson(
        await adminApi.post(`/api/admin/groups/${groupId}/members`, {
          data: { userId: persona.userId },
        }),
        [200, 201],
      );
      const removed = await adminApi.delete(
        `/api/admin/groups/${groupId}/members/${persona.userId}`,
      );
      expect([200, 204]).toContain(removed.status());

      await expectJson(await adminApi.get(`/api/admin/groups/${groupId}/server-grants`));
      await expectJson(
        await adminApi.put(
          `/api/admin/groups/${groupId}/server-grants/${seedState.server.id}`,
          {
            data: {
              cpuMillis: 500,
              memBytes: 512 * 1024 * 1024,
              diskBytes: 2 * 1024 * 1024 * 1024,
              extensionGrants: {},
              expiresAt: null,
            },
          },
        ),
      );
      const dropServer = await adminApi.delete(
        `/api/admin/groups/${groupId}/server-grants/${seedState.server.id}`,
      );
      expect([200, 204, 409]).toContain(dropServer.status());

      const poolId = seedState.storagePools.dirQuotaOnline.id;
      await expectJson(await adminApi.get(`/api/admin/groups/${groupId}/storage-pool-grants`));
      await expectJson(
        await adminApi.put(
          `/api/admin/groups/${groupId}/storage-pool-grants/${poolId}`,
          { data: { expiresAt: null } },
        ),
      );
      const dropPool = await adminApi.delete(
        `/api/admin/groups/${groupId}/storage-pool-grants/${poolId}`,
      );
      expect([200, 204, 409]).toContain(dropPool.status());

      await expectJson(
        await adminApi.get(`/api/admin/groups/${groupId}/shared-backend-grants`),
      );
      const missingBackend = '00000000-0000-4000-8000-000000000099';
      const putShared = await adminApi.put(
        `/api/admin/groups/${groupId}/shared-backend-grants/${missingBackend}`,
        { data: { limitBytes: 1024, expiresAt: null } },
      );
      expect(putShared.status()).toBeGreaterThanOrEqual(400);
      const dropShared = await adminApi.delete(
        `/api/admin/groups/${groupId}/shared-backend-grants/${missingBackend}`,
      );
      expect([200, 204, 404]).toContain(dropShared.status());
    } finally {
      if (groupId) {
        await adminApi.delete(`/api/admin/groups/${groupId}`);
      }
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);

test(
  'catalog selectors return purpose-safe lists',
  { ...coverageCase('iam-catalog', 'iam-catalog-live') },
  async ({ adminApi }) => {
    for (const path of [
      '/api/admin/catalog/administration-actions',
      '/api/admin/catalog/grant-servers',
      '/api/admin/catalog/groups',
      '/api/admin/catalog/metric-servers',
      '/api/admin/catalog/users',
    ]) {
      const body = await expectJson<unknown>(await adminApi.get(path));
      expect(body).toBeDefined();
    }
  },
);

test(
  'system settings get and revision-guarded patch',
  { ...coverageCase('iam-system-settings', 'iam-system-settings-live') },
  async ({ adminApi }) => {
    const settings = await expectJson<JsonRecord>(
      await adminApi.get('/api/admin/system-settings'),
    );
    expect(settings.revision).toBeDefined();
    const conflict = await adminApi.patch('/api/admin/system-settings', {
      data: {
        expectedRevision: settings.revision,
        expectedSnapshotToken: settings.snapshotToken ?? settings.expectedSnapshotToken ?? '',
        values: { missing_key_for_boundary: true },
      },
    });
    expect(conflict.status()).toBeGreaterThanOrEqual(400);
  },
);

test(
  'auth API tokens create, list, and delete',
  { ...coverageCase('iam-auth-tokens', 'iam-auth-tokens-live') },
  async ({ adminApi }) => {
    const created = await expectJson<JsonRecord>(
      await adminApi.post('/api/auth/tokens', { data: { name: `e2e-${Date.now()}` } }),
      [200, 201],
    );
    const token = (created.token ?? created) as JsonRecord;
    expect(token.id).toBeTruthy();
    expect(created.secret ?? token.secret).toBeTruthy();
    const listed = await expectJson<JsonRecord[]>(await adminApi.get('/api/auth/tokens'));
    expect(listed.some((entry) => entry.id === token.id)).toBe(true);
    const deleted = await adminApi.delete(`/api/auth/tokens/${token.id}`);
    expect([200, 204]).toContain(deleted.status());
  },
);

test(
  'purge-resources on a user without owned instances is fail-closed or empty',
  { ...coverageCase('iam-purge-resources', 'iam-purge-resources-live') },
  async ({ adminApi, seedState }) => {
    const persona = await createPersonaUser(adminApi, 'purg');
    try {
      const response = await adminApi.post(
        `/api/admin/users/${persona.userId}/servers/${seedState.server.id}/purge-resources`,
      );
      expect(response.status()).toBeLessThan(500);
    } finally {
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);

test(
  'admin disable blocks login and invalidates the existing session',
  { ...coverageCase('admin-disable-user-blocks-login', 'admin-disable-user-blocks-login-live') },
  async ({ adminApi, authedApiFactory }) => {
    const persona = await createPersonaUser(adminApi, 'disa');
    try {
      const session = await loginPersona(adminApi, persona);
      const userApi = await authedApiFactory(session.accessToken);
      await expectJson(await userApi.get(`/api/users/${persona.userId}`));

      const disabled = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/users/${persona.userId}`, {
          data: { status: 'disabled' },
        }),
      );
      expect(disabled.status ?? disabled.userStatus).toBe('disabled');

      const loginDenied = await readErrorBody(
        await adminApi.post('/api/auth/login', {
          data: { username: persona.username, password: persona.password },
        }),
      );
      expect(loginDenied.status).toBe(401);

      const staleSession = await userApi.get(`/api/users/${persona.userId}`);
      expect(staleSession.status()).toBe(401);

      const enabled = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/users/${persona.userId}`, {
          data: { status: 'active' },
        }),
      );
      expect(enabled.status ?? enabled.userStatus).toBe('active');
      const restored = await loginPersona(adminApi, persona);
      expect(restored.accessToken).toBeTruthy();
    } finally {
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);

test(
  'group capabilities elevate a user without a server grant',
  { ...coverageCase('group-capability-elevation', 'group-capability-elevation-live') },
  async ({ adminApi, authedApiFactory }) => {
    const persona = await createPersonaUser(adminApi, 'gcap');
    let groupId: string | undefined;
    try {
      const session = await loginPersona(adminApi, persona);
      const userApi = await authedApiFactory(session.accessToken);
      const before = await userApi.get('/api/audit');
      expect(before.status()).toBe(403);

      const group = await expectJson<JsonRecord>(
        await adminApi.post('/api/admin/groups', {
          data: {
            name: `e2e-gcap-${Date.now().toString(36)}`,
            capabilities: ['view_audit'],
          },
        }),
        [200, 201],
      );
      groupId = group.id as string;
      await expectJson(
        await adminApi.post(`/api/admin/groups/${groupId}/members`, {
          data: { userId: persona.userId },
        }),
        [200, 201],
      );

      const elevated = await loginPersona(adminApi, persona);
      const elevatedApi = await authedApiFactory(elevated.accessToken);
      const audit = await expectJson<unknown>(await elevatedApi.get('/api/audit'));
      expect(audit).toBeDefined();
    } finally {
      if (groupId) await adminApi.delete(`/api/admin/groups/${groupId}`);
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);

