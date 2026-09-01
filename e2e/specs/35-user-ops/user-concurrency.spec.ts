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
  loginPersona,
  provisionGrantedUser,
  readErrorBody,
  requireSucceededIntent,
  settleAcceptedIntent,
  stopUserContainer,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

const MiB = 1024 * 1024;

test(
  'user races attachA∩attachB∩resize on one volume without stuck intents',
  { ...coverageCase('user-volume-attach-resize-race', 'user-volume-attach-resize-race-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(480_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'vrace');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerA: string | undefined;
    let containerB: string | undefined;
    let volumeId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const createdA = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-ura',
        powerIntent: 'running',
      });
      containerA = createdA.containerId;
      const createdB = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-urb',
        powerIntent: 'running',
      });
      containerB = createdB.containerId;

      const volume = await createUserVolume(
        userApi,
        seedState,
        `e2e-urace-${Date.now().toString(36)}`,
        96 * MiB,
      );
      volumeId = volume.volumeId;
      const before = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));

      const [attachRaceA, attachRaceB, resizeRace] = await Promise.all([
        userApi.post(`/api/containers/${containerA}/volumes`, {
          data: {
            volumeId,
            containerPath: '/mnt/e2e-urace-a',
            readOnly: false,
          },
        }),
        userApi.post(`/api/containers/${containerB}/volumes`, {
          data: {
            volumeId,
            containerPath: '/mnt/e2e-urace-b',
            readOnly: false,
          },
        }),
        userApi.patch(`/api/volumes/${volumeId}`, {
          data: {
            expectedRevision: before.generation,
            sizeBytes: 160 * MiB,
          },
        }),
      ]);

      const raceStatuses = [attachRaceA.status(), attachRaceB.status(), resizeRace.status()];
      expect(raceStatuses.every((status) => [202, 409, 400].includes(status))).toBe(true);
      expect(raceStatuses.filter((status) => status === 202).length).toBeGreaterThanOrEqual(1);

      for (const response of [attachRaceA, attachRaceB, resizeRace]) {
        await settleAcceptedIntent(userApi, response, 'user.attach-resize.race');
      }

      await assertNoActiveIntents(userApi, `/api/volumes/${volumeId}/intents`);
      await assertNoActiveIntents(userApi, `/api/containers/${containerA}/intents`);
      await assertNoActiveIntents(userApi, `/api/containers/${containerB}/intents`);

      const after = await expectJson<JsonRecord>(await userApi.get(`/api/volumes/${volumeId}`));
      const size = Number(after.sizeBytes);
      expect(size === 96 * MiB || size === 160 * MiB).toBe(true);

      for (const containerId of [containerA, containerB]) {
        await stopUserContainer(userApi, containerId);
        const listed = await expectJson<JsonRecord[]>(
          await userApi.get(`/api/containers/${containerId}/volumes`),
        );
        for (const attachment of listed.filter((entry) => entry.volumeId === volumeId)) {
          const detach = await expectJson<JsonRecord>(
            await userApi.delete(`/api/containers/${containerId}/volumes/${attachment.id}`),
            202,
          );
          await requireSucceededIntent(userApi, detach.intentId, 'user.race.detach.cleanup');
        }
      }
    } finally {
      if (userApi && volumeId) {
        for (const containerId of [containerA, containerB]) {
          if (!containerId) continue;
          await stopUserContainer(userApi, containerId).catch(() => undefined);
          const listed = await userApi.get(`/api/containers/${containerId}/volumes`)
            .then(async (response) => (response.status() === 200
              ? await response.json() as JsonRecord[]
              : []))
            .catch(() => [] as JsonRecord[]);
          for (const attachment of listed.filter((entry) => entry.volumeId === volumeId)) {
            const detach = await userApi.delete(
              `/api/containers/${containerId}/volumes/${attachment.id}`,
            ).catch(() => undefined);
            if (detach?.status() === 202) {
              const body = await detach.json() as JsonRecord;
              if (typeof body.intentId === 'string') {
                await requireSucceededIntent(userApi, body.intentId, 'user.race.detach.finally');
              }
            }
          }
        }
      }
      await deleteUserContainer(userApi ?? adminApi, adminApi, containerA);
      await deleteUserContainer(userApi ?? adminApi, adminApi, containerB);
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
  'user double-submits config mutations: one 202 winner and one 409 loser',
  { ...coverageCase('user-config-double-submit', 'user-config-double-submit-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(420_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'ucfg');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerId: string | undefined;
    let volumeId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const created = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-ucfg',
        cpuMillis: 500,
        memBytes: 512 * MiB,
        powerIntent: 'running',
      });
      containerId = created.containerId;
      const volume = await createUserVolume(
        userApi,
        seedState,
        `e2e-ucfg-vol-${Date.now().toString(36)}`,
        128 * MiB,
      );
      volumeId = volume.volumeId;
      const volumeBefore = await expectJson<JsonRecord>(
        await userApi.get(`/api/volumes/${volumeId}`),
      );
      const generation = Number(volumeBefore.generation);

      const [limitsA, limitsB] = await Promise.all([
        userApi.patch(`/api/containers/${containerId}/limits`, {
          data: { cpuMillis: 600, memBytes: 640 * MiB },
        }),
        userApi.patch(`/api/containers/${containerId}/limits`, {
          data: { cpuMillis: 700, memBytes: 704 * MiB },
        }),
      ]);
      const limitsStatuses = [limitsA.status(), limitsB.status()];
      expect(limitsStatuses.every((status) => [202, 409].includes(status))).toBe(true);
      expect(limitsStatuses.filter((status) => status === 202).length).toBeGreaterThanOrEqual(1);
      for (const response of [limitsA, limitsB]) {
        if (response.status() === 409) {
          const loser = await readErrorBody(response);
          expect(errorCode(loser.body)).toBe('REVISION_CONFLICT');
          continue;
        }
        const body = await response.json() as JsonRecord;
        await requireSucceededIntent(userApi, body.intentId, 'user.limits.double-submit.winner');
      }

      const containerAfter = await expectJson<JsonRecord>(
        await userApi.get(`/api/containers/${containerId}`),
      );
      const cpu = Number(containerAfter.cpuMillis);
      const mem = Number(containerAfter.memBytes);
      expect(
        (cpu === 600 && mem === 640 * MiB) || (cpu === 700 && mem === 704 * MiB),
      ).toBe(true);
      await assertNoActiveIntents(userApi, `/api/containers/${containerId}/intents`);

      const [resizeA, resizeB] = await Promise.all([
        userApi.patch(`/api/volumes/${volumeId}`, {
          data: { expectedRevision: generation, sizeBytes: 160 * MiB },
        }),
        userApi.patch(`/api/volumes/${volumeId}`, {
          data: { expectedRevision: generation, sizeBytes: 176 * MiB },
        }),
      ]);
      const resizeStatuses = [resizeA.status(), resizeB.status()];
      expect(resizeStatuses.filter((status) => status === 202).length).toBe(1);
      expect(resizeStatuses.filter((status) => status === 409).length).toBe(1);
      const loserResize = resizeA.status() === 409 ? resizeA : resizeB;
      const loserResizeBody = await readErrorBody(loserResize);
      expect(errorCode(loserResizeBody.body)).toBe('REVISION_CONFLICT');

      const winnerSize = resizeA.status() === 202 ? 160 * MiB : 176 * MiB;
      for (const response of [resizeA, resizeB]) {
        if (response.status() !== 202) continue;
        const body = await response.json() as JsonRecord;
        await requireSucceededIntent(userApi, body.intentId, 'user.volume.double-submit.winner');
      }

      const volumeAfter = await expectJson<JsonRecord>(
        await userApi.get(`/api/volumes/${volumeId}`),
      );
      expect(Number(volumeAfter.sizeBytes)).toBe(winnerSize);
      await assertNoActiveIntents(userApi, `/api/volumes/${volumeId}/intents`);
    } finally {
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

test(
  'user create double-submit yields one resource and explicit winner/loser',
  { ...coverageCase('user-create-double-submit', 'user-create-double-submit-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(420_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'ucre');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    const containerIds = new Set<string>();
    const volumeIds = new Set<string>();
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const containerName = `e2e-ucre-${Date.now().toString(36)}`.slice(0, 63);
      const createPayload = {
        serverId: seedState.server.id,
        imageId: seedState.image.id,
        name: containerName,
        rootSizeBytes: 2 * 1024 * 1024 * 1024,
        cpuMillis: 500,
        memBytes: 512 * MiB,
        gpuPciAddresses: [],
        powerIntent: 'stopped' as const,
      };
      const [createA, createB] = await Promise.all([
        userApi.post('/api/containers', { data: createPayload }),
        userApi.post('/api/containers', { data: createPayload }),
      ]);
      const createStatuses = [createA.status(), createB.status()];
      expect(createStatuses.filter((status) => status === 202).length).toBe(1);
      expect(
        createStatuses.filter((status) => status === 409 || status === 400).length,
      ).toBe(1);

      for (const response of [createA, createB]) {
        if (response.status() !== 202) {
          const loser = await readErrorBody(response);
          expect(
            errorCode(loser.body) === 'INVALID_INPUT'
              || /already exists/i.test(JSON.stringify(loser.body)),
          ).toBe(true);
          continue;
        }
        const body = await response.json() as JsonRecord;
        containerIds.add(body.resourceId as string);
        await requireSucceededIntent(userApi, body.intentId, 'user.container.create.winner');
      }
      expect(containerIds.size).toBe(1);

      const volumeName = `e2e-ucre-vol-${Date.now().toString(36)}`;
      const volumePayload = {
        name: volumeName,
        sizeBytes: 128 * MiB,
        scope: {
          kind: 'local' as const,
          serverId: seedState.server.id,
          poolId: seedState.storagePools.dirQuotaOnline.id,
        },
      };
      const [volA, volB] = await Promise.all([
        userApi.post('/api/volumes', { data: volumePayload }),
        userApi.post('/api/volumes', { data: volumePayload }),
      ]);
      const volStatuses = [volA.status(), volB.status()];
      expect(volStatuses.filter((status) => status === 202).length).toBe(1);
      expect(
        volStatuses.filter((status) => status === 409 || status === 400).length,
      ).toBe(1);

      for (const response of [volA, volB]) {
        if (response.status() !== 202) {
          const loser = await readErrorBody(response);
          expect(
            errorCode(loser.body) === 'INVALID_INPUT'
              || /already exists/i.test(JSON.stringify(loser.body)),
          ).toBe(true);
          continue;
        }
        const body = await response.json() as JsonRecord;
        volumeIds.add(body.resourceId as string);
        await requireSucceededIntent(userApi, body.intentId, 'user.volume.create.winner');
      }
      expect(volumeIds.size).toBe(1);

      // Orphan sweep: list owned resources and ensure only the winners remain.
      const listedContainers = await expectJson<JsonRecord[] | { items?: JsonRecord[] }>(
        await userApi.get('/api/containers'),
      );
      const containerItems = Array.isArray(listedContainers)
        ? listedContainers
        : (listedContainers.items ?? []);
      const matchingContainers = containerItems.filter((entry) => entry.name === containerName);
      expect(matchingContainers.length).toBe(1);

      const listedVolumes = await expectJson<JsonRecord[] | { items?: JsonRecord[] }>(
        await userApi.get('/api/volumes'),
      );
      const volumeItems = Array.isArray(listedVolumes) ? listedVolumes : (listedVolumes.items ?? []);
      const matchingVolumes = volumeItems.filter((entry) => entry.name === volumeName);
      expect(matchingVolumes.length).toBe(1);
    } finally {
      for (const volumeId of volumeIds) {
        await deleteUserVolume(userApi ?? adminApi, adminApi, volumeId);
      }
      for (const containerId of containerIds) {
        await deleteUserContainer(userApi ?? adminApi, adminApi, containerId);
      }
      // Best-effort orphan sweep if race created unexpected IDs without capturing them.
      if (userApi) {
        const leftovers = await userApi.get('/api/containers')
          .then(async (response) => (response.status() === 200
            ? await response.json() as JsonRecord[] | { items?: JsonRecord[] }
            : []))
          .catch(() => [] as JsonRecord[]);
        const leftoverItems = Array.isArray(leftovers) ? leftovers : (leftovers.items ?? []);
        for (const entry of leftoverItems) {
          if (typeof entry.id === 'string' && !containerIds.has(entry.id)) {
            await deleteUserContainer(userApi, adminApi, entry.id);
          }
        }
        const leftoverVolumes = await userApi.get('/api/volumes')
          .then(async (response) => (response.status() === 200
            ? await response.json() as JsonRecord[] | { items?: JsonRecord[] }
            : []))
          .catch(() => [] as JsonRecord[]);
        const leftoverVolumeItems = Array.isArray(leftoverVolumes)
          ? leftoverVolumes
          : (leftoverVolumes.items ?? []);
        for (const entry of leftoverVolumeItems) {
          if (typeof entry.id === 'string' && !volumeIds.has(entry.id)) {
            await deleteUserVolume(userApi, adminApi, entry.id);
          }
        }
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
