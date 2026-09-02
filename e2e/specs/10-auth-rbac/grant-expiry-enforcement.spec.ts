import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { eventually } from '../../support/poll.js';
import {
  assertNoActiveIntents,
  createUserContainer,
  deletePersonaUser,
  deleteServerGrant,
  deleteStoragePoolGrant,
  deleteUserContainer,
  errorCode,
  errorMessageText,
  loginPersona,
  provisionGrantedUser,
  readErrorBody,
  upsertServerGrant,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

test(
  'expired and revoked grants block user mutations; worker recovers running containers',
  { ...coverageCase('grant-expiry-enforcement-live', 'grant-expiry-enforcement-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    // Create + expire + wait for grant-expiry worker (~60s interval) + cleanup.
    test.setTimeout(360_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'expiry', {
      cpuMillis: 1_000,
      memBytes: 1_024 * 1_024 * 1_024,
      diskBytes: 8 * 1_024 * 1_024 * 1_024,
      expiresAt: null,
    });
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let refreshToken: string | undefined;
    let containerId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const created = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-exp',
        powerIntent: 'running',
      });
      containerId = created.containerId;

      // No-grant lane: revoke before expiry probe on a second attempt path.
      const expiresAt = new Date(Date.now() - 5_000).toISOString();
      await upsertServerGrant(adminApi, persona.userId, seedState.server.id, {
        cpuMillis: 1_000,
        memBytes: 1_024 * 1_024 * 1_024,
        diskBytes: 8 * 1_024 * 1_024 * 1_024,
        expiresAt,
      });

      const access = await expectJson<JsonRecord>(await userApi.get('/api/me/access'));
      const serverAccess = (access.servers as JsonRecord[] | undefined)
        ?.find((entry) => entry.serverId === seedState.server.id);
      if (serverAccess?.accessPhase) {
        expect(serverAccess.accessPhase).not.toBe('live');
      }

      const createWhileGrace = await readErrorBody(
        await userApi.post('/api/containers', {
          data: {
            serverId: seedState.server.id,
            imageId: seedState.image.id,
            name: `e2e-grace-${Date.now().toString(36)}`,
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            extensions: {},
            powerIntent: 'running',
          },
        }),
      );
      expect(createWhileGrace.status).toBe(403);
      // Product may deny via grant phase (PERMISSION_DENIED) or by collapsing
      // image assignment visibility during grace (IMAGE_NOT_AVAILABLE).
      expect(
        ['PERMISSION_DENIED', 'IMAGE_NOT_AVAILABLE'].includes(errorCode(createWhileGrace.body) ?? '')
          || /expiry grace|revoked|PermissionDenied|permission|no active assignment/i.test(
            errorMessageText(createWhileGrace.body),
          ),
        JSON.stringify(createWhileGrace.body),
      ).toBe(true);

      // Worker should stop the existing container during grace (interval ~60s).
      await eventually(
        async () => expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/containers/${containerId}`),
        ),
        (value) => value.powerIntent === 'stopped'
          || value.actual?.status === 'stopped'
          || value.lifecyclePhase === 'deleting',
        150_000,
        2_000,
        'grant-expiry worker stopped container',
      );
      // Grace stop is enqueued as container.power; wait until it leaves pending/running.
      await eventually(
        async () => {
          const intents = await expectJson<JsonRecord[] | { items?: JsonRecord[] }>(
            await adminApi.get(`/api/admin/containers/${containerId}/intents`),
          );
          return Array.isArray(intents) ? intents : (intents.items ?? []);
        },
        (items) => items.every((intent) => (
          intent.status !== 'pending' && intent.status !== 'running'
        )),
        120_000,
        1_000,
        'grant-expiry stop intent settled',
      );
      await assertNoActiveIntents(adminApi, `/api/admin/containers/${containerId}/intents`);

      // Revoking a server grant is blocked while the user still owns resources.
      await deleteUserContainer(userApi, adminApi, containerId);
      containerId = undefined;

      await deleteServerGrant(adminApi, persona.userId, seedState.server.id);
      await deleteStoragePoolGrant(
        adminApi,
        persona.userId,
        seedState.storagePools.dirQuotaOnline.id,
      );

      const createNoGrant = await readErrorBody(
        await userApi.post('/api/containers', {
          data: {
            serverId: seedState.server.id,
            imageId: seedState.image.id,
            name: `e2e-nogrant-${Date.now().toString(36)}`,
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            extensions: {},
            powerIntent: 'running',
          },
        }),
      );
      expect(createNoGrant.status).toBe(403);
      expect(
        errorCode(createNoGrant.body) === 'IMAGE_NOT_AVAILABLE'
          || errorCode(createNoGrant.body) === 'PERMISSION_DENIED'
          || /revoked|not granted|permission|denied|image/i.test(errorMessageText(createNoGrant.body)),
        JSON.stringify(createNoGrant.body),
      ).toBe(true);
    } finally {
      if (userApi) {
        await deleteUserContainer(userApi, adminApi, containerId);
      } else {
        await deleteUserContainer(adminApi, adminApi, containerId);
      }
      await deleteServerGrant(adminApi, persona.userId, seedState.server.id);
      await deleteStoragePoolGrant(
        adminApi,
        persona.userId,
        seedState.storagePools.dirQuotaOnline.id,
      );
      if (refreshToken) {
        await (await trackedApiFactory()).post('/api/auth/logout', {
          data: { refreshToken },
        }).catch(() => undefined);
      }
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);
