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

test(
  'a user without grants cannot see or mutate the lab server, images, or grants',
  { ...coverageCase('user-ungranted-scope', 'user-ungranted-scope-live') },
  async ({ adminApi, authedApiFactory, seedState }) => {
    const persona = await createPersonaUser(adminApi, 'nogr');
    let refreshToken: string | undefined;
    try {
      const session = await loginPersona(adminApi, persona);
      refreshToken = session.refreshToken;
      const userApi = await authedApiFactory(session.accessToken);

      const servers = await expectJson<JsonRecord[]>(await userApi.get('/api/servers'));
      expect(servers.some((server) => server.id === seedState.server.id)).toBe(false);
      const hiddenServer = await userApi.get(`/api/servers/${seedState.server.id}`);
      expect([403, 404]).toContain(hiddenServer.status());

      const images = await expectJson<JsonRecord[]>(await userApi.get('/api/images'));
      expect(images.some((image) => image.id === seedState.image.id)).toBe(false);

      const created = await readErrorBody(
        await userApi.post('/api/containers', {
          data: {
            serverId: seedState.server.id,
            imageId: seedState.image.id,
            name: `e2e-nogr-${Date.now().toString(36)}`,
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            extensions: {},
            powerIntent: 'stopped',
          },
        }),
      );
      expect([403, 404]).toContain(created.status);

      const selfGrant = await userApi.put(
        `/api/admin/users/${persona.userId}/server-grants/${seedState.server.id}`,
        {
          data: {
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            diskBytes: 2 * 1024 * 1024 * 1024,
            extensionGrants: {},
            expiresAt: null,
          },
        },
      );
      expect(selfGrant.status()).toBe(403);
    } finally {
      if (refreshToken) {
        await adminApi.post('/api/auth/logout', { data: { refreshToken } }).catch(() => undefined);
      }
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);
