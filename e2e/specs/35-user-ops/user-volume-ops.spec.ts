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
  errorCode,
  errorMessageText,
  loginPersona,
  provisionGrantedUser,
  readErrorBody,
  requireSucceededIntent,
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

      const initialSize = 192 * MiB;
      const targetSize = 128 * MiB;
      const created = await createUserVolume(
        userApi,
        seedState,
        `e2e-ushrk-${Date.now().toString(36)}`,
        initialSize,
      );
      volumeId = created.volumeId;
      const before = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));
      const generation = Number(before.generation);
      const capability = before.capability ?? {};
      expect(Number(before.sizeBytes)).toBe(initialSize);

      const response = await userApi.patch(`/api/volumes/${volumeId}`, {
        data: {
          expectedRevision: generation,
          sizeBytes: targetSize,
        },
      });

      if (capability.shrinkOnline === true) {
        const accepted = await expectJson<JsonRecord>(response, 202);
        await requireSucceededIntent(userApi, accepted.intentId, 'user.volume.resize.shrink');
        const after = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));
        expect(Number(after.sizeBytes)).toBe(targetSize);
        expect(Number(after.generation)).toBeGreaterThan(generation);
      } else {
        // Prefer not hanging: product must reject online shrink clearly when unsupported.
        const error = await readErrorBody(response);
        expect(
          [400, 409].includes(error.status),
          `shrink expected 4xx when shrinkOnline=false; got ${error.status} body=${error.raw.slice(0, 400)}`,
        ).toBe(true);
        expect(
          errorCode(error.body) === 'VOLUME_SHRINK_REQUIRES_DETACH'
            || errorCode(error.body) === 'VOLUME_SHRINK_UNSUPPORTED'
            || errorCode(error.body) === 'VOLUME_SHRINK_BELOW_USAGE'
            || /shrink|detach|unsupported|usage/i.test(errorMessageText(error.body)),
        ).toBe(true);
        const after = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));
        expect(Number(after.sizeBytes)).toBe(initialSize);
      }
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
