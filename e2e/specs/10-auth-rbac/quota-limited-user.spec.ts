import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import {
  deletePersonaUser,
  deleteUserContainer,
  errorCode,
  errorMessageText,
  loginPersona,
  provisionGrantedUser,
  readErrorBody,
  requireSucceededIntent,
} from '../../support/persona.js';

test(
  'quota-limited user is blocked at compute and storage ceilings without orphan resources',
  { ...coverageCase('quota-limited-user-compute-and-storage', 'quota-limited-user-ceilings-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(180_000);
    const diskBytes = 3 * 1024 * 1024 * 1024;
    const persona = await provisionGrantedUser(adminApi, seedState, 'quota', {
      cpuMillis: 250,
      memBytes: 256 * 1024 * 1024,
      diskBytes,
      expiresAt: null,
    });
    let refreshToken: string | undefined;
    let containerId: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const overCpu = await readErrorBody(
        await userApi.post('/api/containers', {
          data: {
            serverId: seedState.server.id,
            imageId: seedState.image.id,
            name: `e2e-qcpu-${Date.now().toString(36)}`,
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 2_000,
            memBytes: 128 * 1024 * 1024,
            gpuPciAddresses: [],
            powerIntent: 'stopped',
          },
        }),
      );
      expect(overCpu.status).toBe(403);
      expect(errorCode(overCpu.body)).toBe('PERMISSION_DENIED');
      expect(errorMessageText(overCpu.body)).toMatch(/CPU exceeds the server grant/i);

      const overMem = await readErrorBody(
        await userApi.post('/api/containers', {
          data: {
            serverId: seedState.server.id,
            imageId: seedState.image.id,
            name: `e2e-qmem-${Date.now().toString(36)}`,
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 100,
            memBytes: 2 * 1024 * 1024 * 1024,
            gpuPciAddresses: [],
            powerIntent: 'stopped',
          },
        }),
      );
      expect(overMem.status).toBe(403);
      expect(errorCode(overMem.body)).toBe('PERMISSION_DENIED');
      expect(errorMessageText(overMem.body)).toMatch(/memory exceeds the server grant/i);

      const acceptedRoot = await userApi.post('/api/containers', {
        data: {
          serverId: seedState.server.id,
          imageId: seedState.image.id,
          name: `e2e-qok-${Date.now().toString(36)}`,
          rootSizeBytes: 2 * 1024 * 1024 * 1024,
          cpuMillis: 100,
          memBytes: 128 * 1024 * 1024,
          gpuPciAddresses: [],
          powerIntent: 'stopped',
        },
      });
      expect(acceptedRoot.status()).toBe(202);
      const body = await acceptedRoot.json() as { resourceId: string; intentId: string };
      containerId = body.resourceId;
      await requireSucceededIntent(userApi, body.intentId, 'quota-ok container.create');

      const overVolume = await readErrorBody(
        await userApi.post('/api/volumes', {
          data: {
            name: `e2e-qvol-${Date.now().toString(36)}`,
            sizeBytes: diskBytes,
            scope: {
              kind: 'local',
              serverId: seedState.server.id,
              poolId: seedState.storagePools.dirQuotaOnline.id,
            },
          },
        }),
      );
      expect([403, 409]).toContain(overVolume.status);
      expect(
        errorCode(overVolume.body) === 'STORAGE_GRANT_EXCEEDED'
          || /storage grant|not granted|exceeded/i.test(errorMessageText(overVolume.body)),
      ).toBe(true);
      expect(overVolume.body.resourceId ?? overVolume.body.id).toBeFalsy();
    } finally {
      await deleteUserContainer(userApi ?? adminApi, adminApi, containerId);
      if (refreshToken) {
        await (await trackedApiFactory()).post('/api/auth/logout', {
          data: { refreshToken },
        }).catch(() => undefined);
      }
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);
