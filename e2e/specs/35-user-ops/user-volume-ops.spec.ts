import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { eventually } from '../../support/poll.js';
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
  stopUserContainer,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

const MiB = 1024 * 1024;

test(
  'user grows a local volume via PATCH /api/volumes/:id',
  { ...coverageCase('user-volume-grow-success', 'user-volume-grow-success-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(360_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'vgrow');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let volumeId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const created = await createUserVolume(
        userApi,
        seedState,
        `e2e-ugrow-${Date.now().toString(36)}`,
        128 * MiB,
      );
      volumeId = created.volumeId;
      const before = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));
      const generation = Number(before.generation);
      expect(Number(before.sizeBytes)).toBe(128 * MiB);
      expect(Number.isFinite(generation)).toBe(true);

      const grownSize = 192 * MiB;
      const accepted = await expectJson<JsonRecord>(
        await userApi.patch(`/api/volumes/${volumeId}`, {
          data: {
            expectedRevision: generation,
            sizeBytes: grownSize,
          },
        }),
        202,
      );
      await requireSucceededIntent(userApi, accepted.intentId, 'user.volume.resize.grow');

      const after = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));
      expect(Number(after.sizeBytes)).toBe(grownSize);
      expect(Number(after.generation)).toBeGreaterThan(generation);
      await assertNoActiveIntents(userApi, `/api/volumes/${volumeId}/intents`);
    } finally {
      await deleteUserVolume(userApi ?? adminApi, adminApi, volumeId);
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
  'user shrinks a dir-quota-online volume or gets an explicit 4xx',
  { ...coverageCase('user-volume-shrink-success', 'user-volume-shrink-success-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(360_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'vshrk');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let volumeId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);
      const api = userApi;

      const initialSize = 192 * MiB;
      const targetSize = 128 * MiB;
      const created = await createUserVolume(
        api,
        seedState,
        `e2e-ushrk-${Date.now().toString(36)}`,
        initialSize,
      );
      volumeId = created.volumeId;
      const before = await expectJson<JsonRecord>(await api.get(`/api/volumes/${volumeId}`));
      const generation = Number(before.generation);
      const capability = before.capability ?? {};
      expect(Number(before.sizeBytes)).toBe(initialSize);

      if (capability.shrinkOnline === true) {
        const observed = await eventually(
          async () => expectJson<JsonRecord>(await api.get(`/api/volumes/${volumeId}`)),
          (volume) => volume.usedBytes !== null && Number(volume.usedBytes) < targetSize,
          90_000,
          1_000,
          'dir volume usedBytes before empty shrink',
        );
        const accepted = await expectJson<JsonRecord>(
          await api.patch(`/api/volumes/${volumeId}`, {
            data: {
              expectedRevision: observed.generation,
              sizeBytes: targetSize,
            },
          }),
          202,
        );
        await requireSucceededIntent(api, accepted.intentId, 'user.volume.resize.shrink');
        const after = await expectJson<JsonRecord>(await api.get(`/api/volumes/${volumeId}`));
        expect(Number(after.sizeBytes)).toBe(targetSize);
        expect(Number(after.generation)).toBeGreaterThan(generation);
      } else {
        // Prefer not hanging: product must reject online shrink clearly when unsupported.
        const response = await api.patch(`/api/volumes/${volumeId}`, {
          data: {
            expectedRevision: generation,
            sizeBytes: targetSize,
          },
        });
        const error = await readErrorBody(response);
        expect(
          [400, 409].includes(error.status),
          `shrink expected 4xx when shrinkOnline=false; got ${error.status} body=${error.raw.slice(0, 400)}`,
        ).toBe(true);
        expect(
          errorCode(error.body) === 'VOLUME_SHRINK_REQUIRES_DETACH'
            || errorCode(error.body) === 'VOLUME_SHRINK_UNSUPPORTED'
            || errorCode(error.body) === 'VOLUME_SHRINK_BELOW_USAGE'
            || errorCode(error.body) === 'VOLUME_USAGE_UNKNOWN'
            || /shrink|detach|unsupported|usage/i.test(errorMessageText(error.body)),
        ).toBe(true);
        const after = await expectJson<JsonRecord>(await api.get(`/api/volumes/${volumeId}`));
        expect(Number(after.sizeBytes)).toBe(initialSize);
      }
      await assertNoActiveIntents(api, `/api/volumes/${volumeId}/intents`);
    } finally {
      await deleteUserVolume(userApi ?? adminApi, adminApi, volumeId);
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
  'user hot-attaches and detaches a volume then deletes it without 409',
  { ...coverageCase('user-volume-hot-attach-detach', 'user-volume-hot-attach-detach-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(420_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'vatt');
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
        namePrefix: 'e2e-uatt',
        powerIntent: 'running',
      });
      containerId = created.containerId;
      const volume = await createUserVolume(
        userApi,
        seedState,
        `e2e-uatt-vol-${Date.now().toString(36)}`,
        128 * MiB,
      );
      volumeId = volume.volumeId;

      const attach = await expectJson<JsonRecord>(
        await userApi.post(`/api/containers/${containerId}/volumes`, {
          data: {
            volumeId,
            containerPath: '/mnt/e2e-uatt',
            readOnly: false,
          },
        }),
        202,
      );
      await requireSucceededIntent(userApi, attach.intentId, 'user.volume.attach');

      const attachments = await expectJson<JsonRecord[]>(
        await userApi.get(`/api/containers/${containerId}/volumes`),
      );
      const attachment = attachments.find((entry) => entry.volumeId === volumeId);
      expect(attachment?.id, JSON.stringify(attachments)).toBeTruthy();
      expect(attachment?.containerPath).toBe('/mnt/e2e-uatt');
      attachmentId = attachment!.id as string;

      const runningDetach = await userApi.delete(
        `/api/containers/${containerId}/volumes/${attachmentId}`,
      );
      expect(runningDetach.status()).toBe(409);
      expect(JSON.stringify(await runningDetach.json())).toMatch(/VOLUME_DETACH_REQUIRES_STOP/);
      await stopUserContainer(userApi, containerId);
      const detach = await expectJson<JsonRecord>(
        await userApi.delete(`/api/containers/${containerId}/volumes/${attachmentId}`),
        202,
      );
      await requireSucceededIntent(userApi, detach.intentId, 'user.volume.detach');
      attachmentId = undefined;

      const afterDetach = await expectJson<JsonRecord[]>(
        await userApi.get(`/api/containers/${containerId}/volumes`),
      );
      expect(afterDetach.some((entry) => entry.volumeId === volumeId)).toBe(false);

      const deleted = await expectJson<JsonRecord>(
        await userApi.delete(`/api/volumes/${volumeId}`),
        202,
      );
      await requireSucceededIntent(userApi, deleted.intentId, 'user.volume.delete.after.detach');
      volumeId = undefined;

      await assertNoActiveIntents(userApi, `/api/containers/${containerId}/intents`);
    } finally {
      if (containerId && userApi) {
        await stopUserContainer(userApi, containerId).catch(() => undefined);
        if (attachmentId) {
          const detach = await userApi.delete(
            `/api/containers/${containerId}/volumes/${attachmentId}`,
          ).catch(() => undefined);
          if (detach?.status() === 202) {
            const body = await detach.json() as JsonRecord;
            if (typeof body.intentId === 'string') {
              await requireSucceededIntent(userApi, body.intentId, 'cleanup.detach');
            }
          }
        }
      }
      await deleteUserContainer(userApi ?? adminApi, adminApi, containerId);
      await deleteUserVolume(userApi ?? adminApi, adminApi, volumeId);
      if (refreshToken) {
        await (await trackedApiFactory()).post('/api/auth/logout', {
          data: { refreshToken },
        }).catch(() => undefined);
      }
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);
