import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { runIncus } from '../../support/incus-control.js';
import { eventually } from '../../support/poll.js';
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
  'PATCH /limits writes Incus limits.cpu and limits.memory, not only the DTO',
  { ...coverageCase('container-limits-applied-incus', 'container-limits-applied-incus-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(360_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'clive');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);
      const created = await createUserContainer(userApi, seedState, {
        namePrefix: 'e2e-clive',
        cpuMillis: 500,
        memBytes: 512 * MiB,
        powerIntent: 'running',
      });
      containerId = created.containerId;
      const nextCpu = 750;
      const nextMem = 768 * MiB;
      const accepted = await expectJson<JsonRecord>(
        await userApi.patch(`/api/containers/${containerId}/limits`, {
          data: { cpuMillis: nextCpu, memBytes: nextMem },
        }),
        202,
      );
      await requireSucceededIntent(userApi, accepted.intentId, 'user.container.update.limits.incus');
      const container = await expectJson<JsonRecord>(
        await userApi.get(`/api/containers/${containerId}`),
      );
      const instanceName = container.instanceName as string;
      expect(instanceName).toBeTruthy();
      const cpu = await runIncus(['config', 'get', instanceName, 'limits.cpu']);
      const allowance = await runIncus(['config', 'get', instanceName, 'limits.cpu.allowance']);
      const memory = await runIncus(['config', 'get', instanceName, 'limits.memory']);
      expect(cpu.code, cpu.stderr).toBe(0);
      expect(cpu.stdout.trim()).toBe('1');
      expect(allowance.stdout.trim()).toBe('750ms/1000ms');
      expect(memory.stdout.trim()).toBe(String(nextMem));
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
      const instanceName = after.instanceName as string;
      expect(instanceName).toBeTruthy();
      const rootSize = await runIncus(['config', 'device', 'get', instanceName, 'root', 'size']);
      expect(rootSize.code, rootSize.stderr).toBe(0);
      expect(parseByteSize(rootSize.stdout.trim())).toBe(grownRoot);
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
  'dir root shrink below usage is rejected and a tight quota stops guest writes',
  { ...coverageCase('dir-root-quota-enforcement', 'dir-root-quota-enforcement-live') },
  async ({ adminApi, trackedApiFactory, authedApiFactory, seedState }) => {
    test.setTimeout(420_000);
    const persona = await provisionGrantedUser(adminApi, seedState, 'rquota');
    let refreshToken: string | undefined;
    let userApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerId: string | undefined;
    try {
      const session = await loginPersona(await trackedApiFactory(), persona);
      refreshToken = session.refreshToken;
      userApi = await authedApiFactory(session.accessToken);
      const api = userApi;
      const created = await createUserContainer(api, seedState, {
        namePrefix: 'e2e-rquota',
        rootSizeBytes: 2 * GiB,
        powerIntent: 'running',
      });
      containerId = created.containerId;
      const before = await expectJson<JsonRecord>(
        await api.get(`/api/containers/${containerId}`),
      );
      expect(before.rootCapability?.enforceUsageFloor ?? before.rootCapability?.shrinkOnline)
        .toBeTruthy();
      const tooSmall = await api.patch(`/api/containers/${containerId}/root-size`, {
        data: { sizeBytes: 64 * MiB },
      });
      if (tooSmall.status() === 202) {
        const accepted = await expectJson<JsonRecord>(tooSmall, 202);
        const intent = await eventually(
          async () => expectJson<JsonRecord>(
            await adminApi.get(`/api/admin/intents/${accepted.intentId}`),
          ),
          (value) => value.status === 'succeeded' || value.status === 'failed',
          180_000,
          500,
          'root shrink below usage settled',
        );
        expect(intent.status, JSON.stringify(intent)).toBe('failed');
        expect(JSON.stringify(intent)).toMatch(/ROOT_SHRINK_BELOW_USAGE|ROOT_USAGE_UNKNOWN/);
      } else {
        expect([400, 409]).toContain(tooSmall.status());
        expect(JSON.stringify(await tooSmall.json())).toMatch(/ROOT_SHRINK_BELOW_USAGE|ROOT_USAGE_UNKNOWN/);
      }
      const still = await expectJson<JsonRecord>(
        await api.get(`/api/containers/${containerId}`),
      );
      expect(Number(still.rootSizeBytes)).toBe(2 * GiB);

      const observed = await eventually(
        async () => expectJson<JsonRecord>(await api.get(`/api/containers/${containerId}`)),
        (value) => typeof value.rootUsedBytes === 'number' && value.rootUsedBytes > 0,
        90_000,
        1_000,
        'rootUsedBytes after create',
      );
      const tight = Number(observed.rootUsedBytes) + 16 * MiB;
      expect(tight).toBeLessThan(2 * GiB);
      const tightened = await expectJson<JsonRecord>(
        await api.patch(`/api/containers/${containerId}/root-size`, {
          data: { sizeBytes: tight },
        }),
        202,
      );
      await requireSucceededIntent(api, tightened.intentId, 'user.container.root.tight');
      const instanceName = observed.instanceName as string;
      expect(instanceName).toBeTruthy();
      const fill = await runIncus([
        'exec',
        instanceName,
        '--',
        '/bin/sh',
        '-lc',
        'dd if=/dev/zero of=/root/e2e-root-fill bs=1048576 count=64 conv=fsync oflag=sync 2>/tmp/dd.err; echo EXIT:$?; cat /tmp/dd.err 2>/dev/null || true',
      ]);
      expect(fill.stdout).toMatch(/EXIT:[1-9]/);
      expect(`${fill.stdout}\n${fill.stderr}`).toMatch(/quota exceeded|No space left|ENOSPC|EDQUOT/i);
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
      const repair = await expectJson<JsonRecord>(
        await userApi.post(`/api/containers/${containerId}/actions/repair-ssh`),
        202,
      );
      expect(repair.intentId ?? repair.woken).toBeTruthy();
      if (repair.intentId) {
        await requireSucceededIntent(userApi, repair.intentId, 'user.container.repair-ssh');
      }

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

function parseByteSize(value: string): number {
  const match = /^([0-9]+)(?:\s*)(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i.exec(value.trim());
  if (!match) throw new Error(`unreadable byte size: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
  };
  return amount * (multipliers[unit] ?? 1);
}
