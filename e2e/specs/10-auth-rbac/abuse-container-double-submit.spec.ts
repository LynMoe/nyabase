import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { waitForGone } from '../../support/wait-for-gone.js';
import {
  assertNoActiveIntents,
  createUserContainer,
  createUserVolume,
  deletePersonaUser,
  deleteUserContainer,
  deleteUserVolume,
  errorCode,
  errorMessageText,
  loginPersona,
  provisionGrantedUser,
  readErrorBody,
  requireSucceededIntent,
  waitForIntent,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

test(
  'container power/delete double-submit rejects losers and leaves no stuck intents',
  { ...coverageCase('abuse-container-double-submit-and-reject-recovery', 'abuse-container-double-submit-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(360_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'dbl');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerId: string | undefined;
    let volumeId: string | undefined;
    let attachmentId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const created = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-dbl',
        powerIntent: 'running',
      });
      containerId = created.containerId;

      const [stopA, stopB] = await Promise.all([
        userApi.post(`/api/containers/${containerId}/actions/stop`),
        userApi.post(`/api/containers/${containerId}/actions/stop`),
      ]);
      const stopStatuses = [stopA.status(), stopB.status()];
      expect(stopStatuses.every((status) => [202, 409].includes(status))).toBe(true);
      expect(stopStatuses.filter((status) => status === 202).length).toBeGreaterThanOrEqual(1);

      const stopBodies = await Promise.all(
        [stopA, stopB].map(async (response) => {
          if (response.status() !== 202) return null;
          return response.json() as Promise<JsonRecord>;
        }),
      );
      for (const body of stopBodies) {
        if (!body?.intentId) continue;
        const intent = await waitForIntent(userApi, body.intentId as string);
        expect(['succeeded', 'failed']).toContain(intent.status);
      }
      await assertNoActiveIntents(userApi, `/api/containers/${containerId}/intents`);

      const restart = await expectJson<JsonRecord>(
        await userApi.post(`/api/containers/${containerId}/actions/start`),
        202,
      );
      await requireSucceededIntent(userApi, restart.intentId, 'container.start after double-stop');

      const volume = await createUserVolume(
        userApi,
        seedState,
        `e2e-dbl-vol-${Date.now().toString(36)}`,
        128 * 1024 * 1024,
      );
      volumeId = volume.volumeId;
      const attach = await expectJson<JsonRecord>(
        await userApi.post(`/api/containers/${containerId}/volumes`, {
          data: {
            volumeId,
            containerPath: '/mnt/e2e-dbl',
            readOnly: false,
          },
        }),
        202,
      );
      await requireSucceededIntent(userApi, attach.intentId, 'volume.attach');
      const attachments = await expectJson<JsonRecord[]>(
        await userApi.get(`/api/containers/${containerId}/volumes`),
      );
      attachmentId = attachments.find((entry) => entry.volumeId === volumeId)?.id as string | undefined;
      expect(attachmentId).toBeTruthy();

      const deleteWhileAttached = await readErrorBody(
        await userApi.delete(`/api/volumes/${volumeId}`),
      );
      expect(deleteWhileAttached.status).toBe(409);
      expect(
        errorCode(deleteWhileAttached.body) === 'VOLUME_DETACH_DRAINING'
          || /Detach|attached|in use|VOLUME/i.test(errorMessageText(deleteWhileAttached.body)),
      ).toBe(true);

      const listed = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));
      expect(listed.id).toBe(volumeId);
      const stillAttached = await expectJson<JsonRecord[]>(
        await userApi.get(`/api/containers/${containerId}/volumes`),
      );
      expect(stillAttached.some((entry) => entry.volumeId === volumeId)).toBe(true);
      await assertNoActiveIntents(userApi, `/api/containers/${containerId}/intents`);

      const [deleteA, deleteB] = await Promise.all([
        userApi.post(`/api/containers/${containerId}/actions/delete`),
        userApi.post(`/api/containers/${containerId}/actions/delete`),
      ]);
      const deleteStatuses = [deleteA.status(), deleteB.status()];
      expect(deleteStatuses.every((status) => [202, 409].includes(status))).toBe(true);
      expect(deleteStatuses.filter((status) => status === 202).length).toBeGreaterThanOrEqual(1);
      const deleteBodies = await Promise.all(
        [deleteA, deleteB].map(async (response) => {
          if (response.status() !== 202) return null;
          return response.json() as Promise<JsonRecord>;
        }),
      );
      for (const body of deleteBodies) {
        if (!body?.intentId) continue;
        const intent = await waitForIntent(adminApi, body.intentId as string);
        expect(['succeeded', 'failed']).toContain(intent.status);
      }
      await waitForGone(adminApi, `/api/admin/containers/${containerId}`);
      containerId = undefined;
      attachmentId = undefined;

      // Volume should remain after container delete (detached by delete path or still listed).
      const volumeAfter = await adminApi.get(`/api/admin/volumes/${volumeId}`);
      if (volumeAfter.status() === 200) {
        await deleteUserVolume(userApi, adminApi, volumeId);
        volumeId = undefined;
      } else {
        volumeId = undefined;
      }
    } finally {
      if (attachmentId && containerId && userApi) {
        await userApi.delete(`/api/containers/${containerId}/volumes/${attachmentId}`)
          .catch(() => undefined);
      }
      await deleteUserVolume(userApi ?? adminApi, adminApi, volumeId);
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
