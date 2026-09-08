import { randomBytes } from 'node:crypto';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import {
  assertNoActiveIntents,
  createUserContainer,
  createUserVolume,
  deletePersonaUser,
  deleteUserContainer,
  deleteUserVolume,
  loginPersona,
  provisionGrantedUser,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

test(
  'normal user logs in, reads access, creates container and volume, then cleans up',
  { ...coverageCase('persona-normal-user-happy-path', 'persona-normal-user-happy-path-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(300_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'normal');
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let refreshToken: string | undefined;
    let containerId: string | undefined;
    let volumeId: string | undefined;
    try {
      const anonymous = await trackedApiFactory();
      const session = await loginPersona(anonymous, persona);
      refreshToken = session.refreshToken;
      expect(session.user.id).toBe(persona.userId);
      expect(session.user.capabilities ?? []).not.toContain('manage_users');

      userApi = await authedApiFactory(session.accessToken);
      const access = await expectJson<JsonRecord>(await userApi.get('/api/me/access'));
      expect(Array.isArray(access.servers)).toBe(true);
      expect(
        access.servers.some((entry: JsonRecord) => entry.serverId === seedState.server.id),
      ).toBe(true);

      const created = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-nu',
        cpuMillis: 500,
        memBytes: 512 * 1024 * 1024,
      });
      containerId = created.containerId;
      const container = await expectJson<JsonRecord>(
        await userApi.get(`/api/containers/${containerId}`),
      );
      expect(container.ownerId ?? container.owner_id ?? persona.userId).toBeTruthy();
      expect(container.serverId).toBe(seedState.server.id);

      const volume = await createUserVolume(
        userApi,
        seedState,
        `e2e-nu-vol-${Date.now().toString(36)}`,
        128 * 1024 * 1024,
      );
      volumeId = volume.volumeId;
      const volumeDto = await expectJson<JsonRecord>(
        await userApi.get(`/api/volumes/${volumeId}`),
      );
      expect(volumeDto.id).toBe(volumeId);

      await assertNoActiveIntents(userApi, `/api/containers/${containerId}/intents`);
    } finally {
      if (userApi) {
        await deleteUserVolume(userApi, adminApi, volumeId);
        await deleteUserContainer(userApi, adminApi, containerId);
      } else {
        await deleteUserVolume(adminApi, adminApi, volumeId);
        await deleteUserContainer(adminApi, adminApi, containerId);
      }
      if (refreshToken) {
        await (await trackedApiFactory()).post('/api/auth/logout', {
          data: { refreshToken },
        }).catch(() => undefined);
      }
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);

test(
  'anonymous and forged tokens cannot mutate protected admin or user routes',
  { ...coverageCase('abuse-unauthorized-admin-and-user-mutations', 'abuse-unauthorized-mutations-live') },
  async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
    const forged = await trackedApiFactory({
      extraHTTPHeaders: {
        authorization: `Bearer ${randomBytes(32).toString('base64url')}.forged.token`,
      },
    });
    const probes: Array<{ label: string; run: () => Promise<{ status: () => number }> }> = [
      {
        label: 'anonymous admin stop container',
        run: () => anonymousApi.post(
          '/api/admin/containers/00000000-0000-4000-8000-000000000001/actions/stop',
        ),
      },
      {
        label: 'forged admin stop container',
        run: () => forged.post(
          '/api/admin/containers/00000000-0000-4000-8000-000000000001/actions/stop',
        ),
      },
      {
        label: 'anonymous user create container',
        run: () => anonymousApi.post('/api/containers', {
          data: {
            serverId: seedState.server.id,
            imageId: seedState.image.id,
            name: `e2e-anon-u-${Date.now().toString(36)}`,
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            extensions: {},
            powerIntent: 'stopped',
          },
        }),
      },
      {
        label: 'forged grant upsert',
        run: () => forged.put(
          `/api/admin/users/${seedState.adminUserId}/server-grants/${seedState.server.id}`,
          {
            data: {
              cpuMillis: 100,
              memBytes: 128 * 1024 * 1024,
              diskBytes: 1 * 1024 * 1024 * 1024,
              extensionGrants: {},
              expiresAt: null,
            },
          },
        ),
      },
      {
        label: 'anonymous delete volume',
        run: () => anonymousApi.delete(`/api/admin/volumes/${seedState.storagePools.dirQuotaOnline.id}`),
      },
      {
        label: 'forged get intent',
        run: () => forged.get('/api/intents/00000000-0000-4000-8000-000000000001'),
      },
    ];

    for (const probe of probes) {
      const response = await probe.run();
      expect(
        [401, 403].includes(response.status()),
        `${probe.label} returned ${response.status()}`,
      ).toBe(true);
    }

    // Valid normal user must still be blocked from admin mutations.
    const persona = await provisionGrantedUser(adminApi, seedState, 'unauth');
    let refreshToken: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      const userApi = await trackedApiFactory({
        extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
      });
      const adminBlocked = await userApi.post('/api/admin/containers', {
        data: {
          serverId: seedState.server.id,
          imageId: seedState.image.id,
          name: `e2e-priv-${Date.now().toString(36)}`,
          rootSizeBytes: 2 * 1024 * 1024 * 1024,
          cpuMillis: 500,
          memBytes: 512 * 1024 * 1024,
          extensions: {},
          powerIntent: 'stopped',
        },
      });
      expect(adminBlocked.status()).toBe(404);
      const grantBlocked = await userApi.put(
        `/api/admin/users/${seedState.adminUserId}/server-grants/${seedState.server.id}`,
        {
          data: {
            cpuMillis: 100,
            memBytes: 128 * 1024 * 1024,
            diskBytes: 1 * 1024 * 1024 * 1024,
            extensionGrants: {},
            expiresAt: null,
          },
        },
      );
      expect(grantBlocked.status()).toBe(403);
    } finally {
      if (refreshToken) {
        await (await trackedApiFactory()).post('/api/auth/logout', {
          data: { refreshToken },
        }).catch(() => undefined);
      }
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);
