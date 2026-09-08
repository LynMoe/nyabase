import { test, expect } from '../../fixtures/live-stack.js';
import type { ApiClient } from '../../support/api-client.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { runCommand } from '../../support/incus-control.js';
import { eventually } from '../../support/poll.js';
import {
  createPersonaUser,
  createUserContainer,
  deletePersonaUser,
  deleteUserContainer,
  errorCode,
  loginPersona,
  readErrorBody,
  requireSucceededIntent,
  upsertServerGrant,
  upsertStoragePoolGrant,
} from '../../support/persona.js';
import { waitForGone } from '../../support/wait-for-gone.js';
import type { SeedState } from '../../support/seed-state.js';
import type { AvailableTopologyProvider } from '../../topology/provider.js';

type JsonRecord = Record<string, any>;

const NVIDIA_GPU = 'nvidia-gpu';
const GiB = 1024 * 1024 * 1024;

function nvidiaState(container: JsonRecord): JsonRecord {
  const bag = (container.extensions ?? {}) as JsonRecord;
  return (bag[NVIDIA_GPU] ?? {}) as JsonRecord;
}

function claimedPci(container: JsonRecord): string[] {
  const addresses = nvidiaState(container).pciAddresses;
  return Array.isArray(addresses)
    ? addresses.map((value) => String(value).toLowerCase())
    : [];
}

function pciMatches(container: JsonRecord, pci: string): boolean {
  const needle = pci.slice(-10).toLowerCase();
  return claimedPci(container).some((value) => value.includes(needle));
}

function requireGpuServer(
  topologyProvider: AvailableTopologyProvider,
  seedState: SeedState,
): NonNullable<SeedState['gpuServer']> {
  expect(
    topologyProvider.capabilities['gpu-pci'].state,
    topologyProvider.capabilities['gpu-pci'].detail,
  ).toBe('available');
  expect(seedState.gpuServer?.id, seedState.blocked.gpu).toBeTruthy();
  return seedState.gpuServer!;
}

async function enableNvidiaGpu(
  adminApi: ApiClient,
  serverId: string,
): Promise<JsonRecord> {
  const enablement = await expectJson<JsonRecord>(
    await adminApi.put(`/api/admin/servers/${serverId}/extensions/${NVIDIA_GPU}`, {
      data: { enabled: true },
    }),
  );
  expect(enablement.enabled).toBe(true);
  expect(
    enablement.health?.runtimeReady,
    JSON.stringify(enablement.health),
  ).toBe(true);
  const checks = Array.isArray(enablement.support?.checks) ? enablement.support.checks : [];
  const cards = checks.find((check: { id?: string }) => check.id === 'nvidia-cards');
  expect(cards?.status, JSON.stringify(enablement.support)).toBe('pass');
  return enablement;
}

async function disableNvidiaGpu(adminApi: ApiClient, serverId: string): Promise<JsonRecord> {
  return expectJson<JsonRecord>(
    await adminApi.put(`/api/admin/servers/${serverId}/extensions/${NVIDIA_GPU}`, {
      data: { enabled: false },
    }),
  );
}

async function extensionRow(
  adminApi: ApiClient,
  serverId: string,
): Promise<JsonRecord> {
  const listed = await expectJson<JsonRecord[]>(
    await adminApi.get(`/api/admin/servers/${serverId}/extensions`),
  );
  const row = listed.find((item) => item.extensionId === NVIDIA_GPU);
  expect(row, JSON.stringify(listed)).toBeTruthy();
  return row!;
}

async function waitStatus(
  adminApi: ApiClient,
  containerId: string,
  status: 'running' | 'stopped' | 'frozen',
): Promise<JsonRecord> {
  return eventually(
    async () => expectJson<JsonRecord>(await adminApi.get(`/api/admin/containers/${containerId}`)),
    (value) => value.lifecyclePhase === 'active' && value.actual?.status === status,
    180_000,
    500,
    `nvidia-gpu container ${containerId} ${status}`,
  );
}

async function createAdminContainer(
  adminApi: ApiClient,
  seedState: SeedState,
  serverId: string,
  options: {
    namePrefix: string;
    powerIntent: 'running' | 'stopped';
    extensions?: Record<string, unknown>;
  },
): Promise<{ containerId: string; container: JsonRecord }> {
  const created = await createUserContainer(adminApi, seedState, {
    namePrefix: options.namePrefix,
    serverId,
    rootSizeBytes: 2 * GiB,
    extensions: options.extensions ?? {},
    powerIntent: options.powerIntent,
  });
  const container = await waitStatus(adminApi, created.containerId, options.powerIntent);
  return { containerId: created.containerId, container };
}

async function stopAdminContainer(adminApi: ApiClient, containerId: string): Promise<JsonRecord> {
  const current = await expectJson<JsonRecord>(
    await adminApi.get(`/api/admin/containers/${containerId}`),
  );
  if (current.actual?.status === 'stopped' && current.powerIntent === 'stopped') return current;
  const accepted = await expectJson<JsonRecord>(
    await adminApi.post(`/api/admin/containers/${containerId}/actions/stop`),
    202,
  );
  await requireSucceededIntent(adminApi, accepted.intentId, 'nvidia-gpu.container.stop');
  return waitStatus(adminApi, containerId, 'stopped');
}

async function startAdminContainer(adminApi: ApiClient, containerId: string): Promise<JsonRecord> {
  const accepted = await expectJson<JsonRecord>(
    await adminApi.post(`/api/admin/containers/${containerId}/actions/start`),
    202,
  );
  await requireSucceededIntent(adminApi, accepted.intentId, 'nvidia-gpu.container.start');
  return waitStatus(adminApi, containerId, 'running');
}

async function patchNvidiaGpu(
  api: ApiClient,
  path: string,
  pciAddresses: readonly string[],
): Promise<JsonRecord> {
  const accepted = await expectJson<JsonRecord>(
    await api.patch(path, { data: { pciAddresses } }),
    202,
  );
  await requireSucceededIntent(api, accepted.intentId, 'nvidia-gpu.container.patch');
  return accepted;
}

async function deleteAdminContainer(
  adminApi: ApiClient,
  containerId: string | undefined,
): Promise<void> {
  if (!containerId) return;
  const stop = await adminApi.post(`/api/admin/containers/${containerId}/actions/stop`)
    .catch(() => undefined);
  if (stop?.status() === 202) {
    const body = await stop.json() as JsonRecord;
    if (typeof body.intentId === 'string') {
      await requireSucceededIntent(adminApi, body.intentId, 'nvidia-gpu.cleanup.stop')
        .catch(() => undefined);
    }
  }
  const deletion = await adminApi.post(`/api/admin/containers/${containerId}/actions/delete`)
    .catch(() => undefined);
  if (deletion?.status() === 202) {
    await waitForGone(adminApi, `/api/admin/containers/${containerId}`);
  }
}

async function peerExec(ssh: string, instanceName: string, command: string) {
  return runCommand('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    ssh,
    [
      'incus',
      'exec',
      instanceName,
      '--',
      '/bin/sh',
      '-lc',
      JSON.stringify(command),
    ].join(' '),
  ]);
}

async function peerIncus(ssh: string, args: readonly string[]) {
  return runCommand('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    ssh,
    ['incus', ...args].map((value) => JSON.stringify(value)).join(' '),
  ]);
}

test(
  'refuses to disable nvidia-gpu while a container claims a device, then disables after claims are cleared',
  { ...coverageCase('container-nvidia-gpu-occupancy-disable', 'container-nvidia-gpu-occupancy-disable-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    test.setTimeout(240_000);
    const gpuServer = requireGpuServer(topologyProvider, seedState);
    const pci = gpuServer.pciAddress;
    await enableNvidiaGpu(adminApi, gpuServer.id);

    let containerId: string | undefined;
    try {
      const created = await createAdminContainer(adminApi, seedState, gpuServer.id, {
        namePrefix: 'e2e-nvocc',
        powerIntent: 'stopped',
        extensions: { [NVIDIA_GPU]: { pciAddresses: [pci] } },
      });
      containerId = created.containerId;
      expect(nvidiaState(created.container).nvidiaRuntime).toBe(true);
      expect(pciMatches(created.container, pci)).toBe(true);
      expect((await extensionRow(adminApi, gpuServer.id)).occupiedDeviceCount).toBeGreaterThan(0);

      const occupied = await readErrorBody(
        await adminApi.put(`/api/admin/servers/${gpuServer.id}/extensions/${NVIDIA_GPU}`, {
          data: { enabled: false },
        }),
      );
      expect(occupied.status).toBe(409);
      expect(errorCode(occupied.body)).toBe('EXTENSION_OCCUPIED');

      await patchNvidiaGpu(
        adminApi,
        `/api/admin/containers/${containerId}/extensions/${NVIDIA_GPU}`,
        [],
      );
      const cleared = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/containers/${containerId}`),
      );
      expect(nvidiaState(cleared).nvidiaRuntime).toBe(true);
      expect(claimedPci(cleared)).toEqual([]);
      expect((await extensionRow(adminApi, gpuServer.id)).occupiedDeviceCount).toBe(0);

      const disabled = await disableNvidiaGpu(adminApi, gpuServer.id);
      expect(disabled.enabled).toBe(false);
    } finally {
      await deleteAdminContainer(adminApi, containerId);
      await adminApi.put(`/api/admin/servers/${gpuServer.id}/extensions/${NVIDIA_GPU}`, {
        data: { enabled: true },
      }).catch(() => undefined);
    }
  },
);

test(
  'creates a zero-card container on an enabled GPU server, then late-adds PCI after stop',
  { ...coverageCase('container-nvidia-gpu-late-add', 'container-nvidia-gpu-late-add-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    test.setTimeout(420_000);
    const gpuServer = requireGpuServer(topologyProvider, seedState);
    const pci = gpuServer.pciAddress;
    await enableNvidiaGpu(adminApi, gpuServer.id);

    let containerId: string | undefined;
    try {
      const created = await createAdminContainer(adminApi, seedState, gpuServer.id, {
        namePrefix: 'e2e-nvlate',
        powerIntent: 'running',
        extensions: {},
      });
      containerId = created.containerId;
      expect(nvidiaState(created.container).nvidiaRuntime).toBe(true);
      expect(claimedPci(created.container)).toEqual([]);
      expect(created.container.instanceName).toBeTruthy();

      await stopAdminContainer(adminApi, containerId);
      await patchNvidiaGpu(
        adminApi,
        `/api/admin/containers/${containerId}/extensions/${NVIDIA_GPU}`,
        [pci],
      );
      const patched = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/containers/${containerId}`),
      );
      expect(nvidiaState(patched).nvidiaRuntime).toBe(true);
      expect(pciMatches(patched, pci)).toBe(true);

      const running = await startAdminContainer(adminApi, containerId);
      expect(running.instanceName).toBeTruthy();
      const guest = await peerExec(
        gpuServer.ssh,
        running.instanceName as string,
        'ls -l /dev/nvidia* 2>/dev/null; test -c /dev/nvidiactl && echo nvidia_ok',
      );
      expect(guest.code, `${guest.stdout}\n${guest.stderr}`).toBe(0);
      expect(guest.stdout).toContain('nvidia_ok');
      expect(guest.stdout).toMatch(/nvidia[0-9]/);
    } finally {
      await deleteAdminContainer(adminApi, containerId);
    }
  },
);

test(
  'CPU-only grant still opens nvidia.runtime on create when the server extension is enabled and ready',
  { ...coverageCase('container-nvidia-gpu-cpu-only-runtime', 'container-nvidia-gpu-cpu-only-runtime-live') },
  async ({ adminApi, authedApiFactory, seedState, topologyProvider }) => {
    test.setTimeout(240_000);
    const gpuServer = requireGpuServer(topologyProvider, seedState);
    const pci = gpuServer.pciAddress;
    await enableNvidiaGpu(adminApi, gpuServer.id);

    const persona = await createPersonaUser(adminApi, 'nvcpu');
    let userContainer: string | undefined;
    try {
      await upsertStoragePoolGrant(adminApi, persona.userId, gpuServer.dirPoolId);
      await upsertServerGrant(adminApi, persona.userId, gpuServer.id, {
        cpuMillis: 1_000,
        memBytes: 1_024 * 1_024 * 1_024,
        diskBytes: 8 * GiB,
        expiresAt: null,
      });
      const session = await loginPersona(adminApi, persona);
      const userApi = await authedApiFactory(session.accessToken);

      const userEnable = await userApi.put(
        `/api/admin/servers/${gpuServer.id}/extensions/${NVIDIA_GPU}`,
        { data: { enabled: true } },
      );
      expect([401, 403, 404]).toContain(userEnable.status());

      const devices = await expectJson<{ items?: JsonRecord[]; enabled?: boolean }>(
        await userApi.get(`/api/servers/${gpuServer.id}/extensions/${NVIDIA_GPU}/devices`),
      );
      expect(devices.enabled).toBe(true);
      expect(devices.items ?? []).toEqual([]);

      const accepted = await expectJson<JsonRecord>(
        await userApi.post('/api/containers', {
          data: {
            serverId: gpuServer.id,
            imageId: seedState.image.id,
            name: `e2e-nvcpu-${seedState.runId}-${Date.now().toString(36)}`.slice(0, 63),
            rootSizeBytes: 2 * GiB,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            extensions: {},
            powerIntent: 'stopped',
          },
        }),
        202,
      );
      userContainer = accepted.resourceId as string;
      await requireSucceededIntent(userApi, accepted.intentId, 'user.nvidia-gpu.cpu-only.create');
      const created = await eventually(
        async () => expectJson<JsonRecord>(await userApi.get(`/api/containers/${userContainer}`)),
        (value) => value.lifecyclePhase === 'active',
        180_000,
        500,
        `cpu-only nvidia-gpu container ${userContainer} active`,
      );
      expect(nvidiaState(created).nvidiaRuntime).toBe(true);
      expect(claimedPci(created)).toEqual([]);

      const denied = await readErrorBody(
        await userApi.patch(`/api/containers/${userContainer}/extensions/${NVIDIA_GPU}`, {
          data: { pciAddresses: [pci] },
        }),
      );
      expect(denied.status).toBe(403);
      expect(errorCode(denied.body)).toBe('PERMISSION_DENIED');
    } finally {
      await deleteUserContainer(adminApi, adminApi, userContainer);
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);

test(
  'create and PATCH with an nvidia-gpu payload fail when the server extension is not enabled',
  { ...coverageCase('container-nvidia-gpu-not-enabled-reject', 'container-nvidia-gpu-not-enabled-reject-live') },
  async ({ adminApi, seedState }) => {
    test.setTimeout(180_000);
    await disableNvidiaGpu(adminApi, seedState.server.id);

    const createDenied = await readErrorBody(
      await adminApi.post('/api/containers', {
        data: {
          serverId: seedState.server.id,
          imageId: seedState.image.id,
          name: `e2e-nvoffc-${seedState.runId}-${Date.now().toString(36)}`.slice(0, 63),
          rootSizeBytes: 2 * GiB,
          cpuMillis: 500,
          memBytes: 512 * 1024 * 1024,
          extensions: { [NVIDIA_GPU]: { pciAddresses: ['0000:41:00.0'] } },
          powerIntent: 'stopped',
        },
      }),
    );
    expect(createDenied.status).toBe(409);
    expect(errorCode(createDenied.body)).toBe('EXTENSION_NOT_ENABLED');

    let containerId: string | undefined;
    try {
      const created = await createAdminContainer(adminApi, seedState, seedState.server.id, {
        namePrefix: 'e2e-nvoffp',
        powerIntent: 'stopped',
        extensions: {},
      });
      containerId = created.containerId;
      expect(created.container.extensions ?? {}).toEqual({});

      const patchDenied = await readErrorBody(
        await adminApi.patch(`/api/admin/containers/${containerId}/extensions/${NVIDIA_GPU}`, {
          data: { pciAddresses: ['0000:41:00.0'] },
        }),
      );
      expect(patchDenied.status).toBe(409);
      expect(errorCode(patchDenied.body)).toBe('EXTENSION_NOT_ENABLED');
    } finally {
      await deleteAdminContainer(adminApi, containerId);
    }
  },
);

test(
  'rejects nvidia-gpu PATCH while the container is running or frozen',
  { ...coverageCase('container-nvidia-gpu-mutation-requires-stop', 'container-nvidia-gpu-mutation-requires-stop-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    test.setTimeout(360_000);
    const gpuServer = requireGpuServer(topologyProvider, seedState);
    const pci = gpuServer.pciAddress;
    await enableNvidiaGpu(adminApi, gpuServer.id);

    let containerId: string | undefined;
    let instanceName: string | undefined;
    try {
      const created = await createAdminContainer(adminApi, seedState, gpuServer.id, {
        namePrefix: 'e2e-nvfrz',
        powerIntent: 'running',
        extensions: {},
      });
      containerId = created.containerId;
      instanceName = created.container.instanceName as string;
      expect(nvidiaState(created.container).nvidiaRuntime).toBe(true);
      expect(instanceName).toBeTruthy();

      const runningDenied = await readErrorBody(
        await adminApi.patch(`/api/admin/containers/${containerId}/extensions/${NVIDIA_GPU}`, {
          data: { pciAddresses: [pci] },
        }),
      );
      expect(runningDenied.status).toBe(409);
      expect(errorCode(runningDenied.body)).toBe('EXTENSION_MUTATION_REQUIRES_STOP');

      // Frozen + powerIntent running is reconciled as start. Pause, then flip
      // desired power immediately so powerTransition is none and persist can
      // record instance_status=frozen.
      const paused = await peerIncus(gpuServer.ssh, ['pause', instanceName]);
      expect(paused.code, `${paused.stdout}\n${paused.stderr}`).toBe(0);
      const stop = await expectJson<JsonRecord>(
        await adminApi.post(`/api/admin/containers/${containerId}/actions/stop`),
        202,
      );
      await requireSucceededIntent(adminApi, stop.intentId, 'nvidia-gpu.freeze.stop');
      const frozen = await eventually(
        async () => expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/containers/${containerId}`),
        ),
        (value) => value.lifecyclePhase === 'active'
          && value.powerIntent === 'stopped'
          && (value.actual?.status === 'frozen' || value.actual?.status === 'stopped'),
        180_000,
        500,
        `nvidia-gpu container ${containerId} settled after freeze+stop`,
      );
      expect(
        frozen.actual?.status,
        JSON.stringify({ actual: frozen.actual, powerIntent: frozen.powerIntent }),
      ).toBe('frozen');

      const frozenDenied = await readErrorBody(
        await adminApi.patch(`/api/admin/containers/${containerId}/extensions/${NVIDIA_GPU}`, {
          data: { pciAddresses: [pci] },
        }),
      );
      expect(frozenDenied.status).toBe(409);
      expect(errorCode(frozenDenied.body)).toBe('EXTENSION_MUTATION_REQUIRES_STOP');
    } finally {
      if (instanceName) {
        await peerIncus(gpuServer.ssh, ['stop', '--force', instanceName])
          .catch(() => undefined);
      }
      await deleteAdminContainer(adminApi, containerId);
    }
  },
);
