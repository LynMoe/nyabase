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
  errorMessageText,
  loginPersona,
  provisionGrantedUser,
  readErrorBody,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

test(
  'cross-user container, volume, and intent access is denied without changing victim resources',
  { ...coverageCase('abuse-cross-user-resource-access', 'abuse-cross-user-resource-access-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(300_000);
    const owner = await provisionGrantedUser(adminApi, seedState, 'ownera');
    const attacker = await provisionGrantedUser(adminApi, seedState, 'attackerb');
    let ownerApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let attackerApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let ownerRefresh: string | undefined;
    let attackerRefresh: string | undefined;
    let containerId: string | undefined;
    let volumeId: string | undefined;
    let createIntentId: string | undefined;
    try {
      const ownerSession = await loginPersona(await trackedApiFactory(), owner);
      ownerRefresh = ownerSession.refreshToken;
      ownerApi = await authedApiFactory(ownerSession.accessToken);

      const attackerSession = await loginPersona(await trackedApiFactory(), attacker);
      attackerRefresh = attackerSession.refreshToken;
      attackerApi = await authedApiFactory(attackerSession.accessToken);

      const created = await createUserContainer(ownerApi, seedState, {
        namePrefix: 'e2e-xown',
        powerIntent: 'running',
      });
      containerId = created.containerId;
      createIntentId = created.intentId;

      const volume = await createUserVolume(
        ownerApi,
        seedState,
        `e2e-xvol-${Date.now().toString(36)}`,
        128 * 1024 * 1024,
      );
      volumeId = volume.volumeId;

      const before = await expectJson<JsonRecord>(
        await ownerApi.get(`/api/containers/${containerId}`),
      );

      const getDenied = await readErrorBody(
        await attackerApi.get(`/api/containers/${containerId}`),
      );
      expect(getDenied.status).toBe(403);
      expect(errorMessageText(getDenied.body)).toMatch(/not owned by current user/i);

      const stopDenied = await readErrorBody(
        await attackerApi.post(`/api/containers/${containerId}/actions/stop`),
      );
      expect(stopDenied.status).toBe(403);

      const deleteDenied = await readErrorBody(
        await attackerApi.post(`/api/containers/${containerId}/actions/delete`),
      );
      expect(deleteDenied.status).toBe(403);

      const volumeBefore = await expectJson<JsonRecord>(
        await ownerApi.get(`/api/volumes/${volumeId}`),
      );
      const volumePatchDenied = await readErrorBody(
        await attackerApi.patch(`/api/volumes/${volumeId}`, {
          data: {
            // Positive revision so Zod accepts the body; ownership must still deny.
            expectedRevision: Number(volumeBefore.generation ?? 1),
            sizeBytes: Number(volumeBefore.sizeBytes) + 64 * 1024 * 1024,
          },
        }),
      );
      // Non-owners receive NotFound (404) or Forbidden depending on includeAll path.
      expect([403, 404]).toContain(volumePatchDenied.status);
      const volumeAfter = await expectJson<JsonRecord>(
        await ownerApi.get(`/api/volumes/${volumeId}`),
      );
      expect(Number(volumeAfter.generation)).toBe(Number(volumeBefore.generation));
      expect(Number(volumeAfter.sizeBytes)).toBe(Number(volumeBefore.sizeBytes));

      const intentDenied = await readErrorBody(
        await attackerApi.get(`/api/intents/${createIntentId}`),
      );
      expect(intentDenied.status).toBe(403);
      expect(errorMessageText(intentDenied.body)).toMatch(/Intent is not owned by current user/i);

      const retryDenied = await readErrorBody(
        await attackerApi.post(`/api/intents/${createIntentId}/retry`, { data: {} }),
      );
      expect(retryDenied.status).toBe(403);

      const after = await expectJson<JsonRecord>(
        await ownerApi.get(`/api/containers/${containerId}`),
      );
      expect(after.generation ?? after.revision).toBe(before.generation ?? before.revision);
      expect(after.powerIntent).toBe(before.powerIntent);
      await assertNoActiveIntents(ownerApi, `/api/containers/${containerId}/intents`);
    } finally {
      if (ownerApi) {
        await deleteUserVolume(ownerApi, adminApi, volumeId);
        await deleteUserContainer(ownerApi, adminApi, containerId);
      }
      for (const token of [ownerRefresh, attackerRefresh]) {
        if (!token) continue;
        await (await trackedApiFactory()).post('/api/auth/logout', {
          data: { refreshToken: token },
        }).catch(() => undefined);
      }
      await deletePersonaUser(adminApi, attacker.userId);
      await deletePersonaUser(adminApi, owner.userId);
    }
  },
);
