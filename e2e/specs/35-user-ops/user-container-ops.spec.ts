import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import {
  assertNoActiveIntents,
  createUserContainer,
  deletePersonaUser,
  deleteUserContainer,
  loginPersona,
  provisionGrantedUser,
  requireSucceededIntent,
  waitForUserContainerPower,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

test(
  'user adjusts container CPU/memory limits via PATCH /limits',
  { ...coverageCase('user-container-adjust-limits', 'user-container-adjust-limits-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(360_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'clims');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const created = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-ulim',
        cpuMillis: 500,
        memBytes: 512 * MiB,
        powerIntent: 'running',
      });
      containerId = created.containerId;

      const nextCpu = 750;
      const nextMem = 768 * MiB;
      const accepted = await expectJson<JsonRecord>(
        await userApi.patch(`/api/containers/${containerId}/limits`, {
          data: {
            cpuMillis: nextCpu,
            memBytes: nextMem,
          },
        }),
        202,
      );
      await requireSucceededIntent(userApi, accepted.intentId, 'user.container.update.limits');

      const after = await expectJson<JsonRecord>(
        await userApi.get(`/api/containers/${containerId}`),
      );
      expect(Number(after.cpuMillis)).toBe(nextCpu);
      expect(Number(after.memBytes)).toBe(nextMem);
      await assertNoActiveIntents(userApi, `/api/containers/${containerId}/intents`);
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

test(
  'user grows container root size via PATCH /root-size',
  { ...coverageCase('user-container-root-size-grow', 'user-container-root-size-grow-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(420_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'croot');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const initialRoot = 2 * GiB;
      const grownRoot = 3 * GiB;
      const created = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-uroot',
        rootSizeBytes: initialRoot,
        powerIntent: 'running',
      });
      containerId = created.containerId;
      const before = await expectJson<JsonRecord>(
        await userApi.get(`/api/containers/${containerId}`),
      );
      expect(Number(before.rootSizeBytes)).toBe(initialRoot);

      const accepted = await expectJson<JsonRecord>(
        await userApi.patch(`/api/containers/${containerId}/root-size`, {
          data: { sizeBytes: grownRoot },
        }),
        202,
      );
      await requireSucceededIntent(userApi, accepted.intentId, 'user.container.root.grow');

      const after = await expectJson<JsonRecord>(
        await userApi.get(`/api/containers/${containerId}`),
      );
      expect(Number(after.rootSizeBytes)).toBe(grownRoot);
      await assertNoActiveIntents(userApi, `/api/containers/${containerId}/intents`);
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

test(
  'user power-cycles a container: stop → start → restart',
  { ...coverageCase('user-container-power-cycle', 'user-container-power-cycle-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(480_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'cpwr');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);

      const created = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-upwr',
        powerIntent: 'running',
      });
      containerId = created.containerId;

      const stop = await expectJson<JsonRecord>(
        await userApi.post(`/api/containers/${containerId}/actions/stop`),
        202,
      );
      await requireSucceededIntent(userApi, stop.intentId, 'user.container.stop');
      await waitForUserContainerPower(userApi, containerId, 'stopped');

      const start = await expectJson<JsonRecord>(
        await userApi.post(`/api/containers/${containerId}/actions/start`),
        202,
      );
      await requireSucceededIntent(userApi, start.intentId, 'user.container.start');
      await waitForUserContainerPower(userApi, containerId, 'running');

      const restart = await expectJson<JsonRecord>(
        await userApi.post(`/api/containers/${containerId}/actions/restart`),
        202,
      );
      await requireSucceededIntent(userApi, restart.intentId, 'user.container.restart');
      await waitForUserContainerPower(userApi, containerId, 'running');

      const finalState = await expectJson<JsonRecord>(
        await userApi.get(`/api/containers/${containerId}`),
      );
      expect(finalState.powerIntent).toBe('running');
      expect(finalState.actual?.status).toBe('running');
      await assertNoActiveIntents(userApi, `/api/containers/${containerId}/intents`);
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
