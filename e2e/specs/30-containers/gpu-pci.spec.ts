import { test, expect } from '../../fixtures/live-stack.js';
import type { ApiClient } from '../../support/api-client.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { runCommand } from '../../support/incus-control.js';
import { eventually } from '../../support/poll.js';
import {
  deletePersonaUser,
  deleteUserContainer,
  errorCode,
  loginPersona,
  provisionGrantedUser,
  readErrorBody,
  requireSucceededIntent,
  upsertServerGrant,
  upsertStoragePoolGrant,
} from '../../support/persona.js';
import { waitForGone } from '../../support/wait-for-gone.js';

type JsonRecord = Record<string, any>;

async function waitRunning(adminApi: ApiClient, containerId: string): Promise<JsonRecord> {
  return eventually(
    async () => expectJson<JsonRecord>(await adminApi.get(`/api/admin/containers/${containerId}`)),
    (value) => value.lifecyclePhase === 'active' && value.actual?.status === 'running',
    180_000,
    500,
    `gpu container ${containerId} running`,
  );
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

test(
  'claims a real GPU PCI device on the GPU Incus peer and rejects a second claim',
  { ...coverageCase('container-gpu-pci-claim', 'container-gpu-pci-claim-live') },
  async ({ adminApi, authedApiFactory, seedState, topologyProvider }) => {
    test.setTimeout(420_000);
    expect(topologyProvider.capabilities['gpu-pci'].state).toBe('available');
    expect(seedState.gpuServer?.id).toBeTruthy();
    const gpuServer = seedState.gpuServer!;
    const pci = gpuServer.pciAddress;
    const gpus = await expectJson<{ items?: JsonRecord[] } | JsonRecord[]>(
      await adminApi.get(`/api/admin/servers/${gpuServer.id}/gpus`),
    );
    const items = Array.isArray(gpus) ? gpus : (gpus.items ?? []);
    expect(
      items.some((card) => String(card.pciAddress ?? '').toLowerCase() === pci.toLowerCase()),
      JSON.stringify(items),
    ).toBe(true);

    let adminContainer: string | undefined;
    let userContainer: string | undefined;
    const persona = await provisionGrantedUser(adminApi, seedState, 'gpci');
    try {
      const accepted = await expectJson<JsonRecord>(
        await adminApi.post('/api/admin/containers', {
          data: {
            ownerId: seedState.adminUserId,
            serverId: gpuServer.id,
            imageId: seedState.image.id,
            name: `e2e-gpu-${seedState.runId}-${Date.now().toString(36)}`.slice(0, 63),
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            gpuPciAddresses: [pci],
            powerIntent: 'running',
          },
        }),
        202,
      );
      adminContainer = accepted.resourceId as string;
      await requireSucceededIntent(adminApi, accepted.intentId, 'gpu.container.create');
      const running = await waitRunning(adminApi, adminContainer);
      expect(running.instanceName).toBeTruthy();
      const claimed = (running.gpuPciAddresses as string[] ?? []).map((value) => value.toLowerCase());
      expect(claimed.some((value) => value.includes(pci.slice(-10).toLowerCase()))).toBe(true);

      const guest = await peerExec(
        gpuServer.ssh,
        running.instanceName as string,
        'ls -l /dev/nvidia* 2>/dev/null; test -c /dev/nvidiactl && echo nvidia_ok',
      );
      expect(guest.code, `${guest.stdout}\n${guest.stderr}`).toBe(0);
      expect(guest.stdout).toContain('nvidia_ok');
      expect(guest.stdout).toMatch(/nvidia[0-9]/);

      const collision = await adminApi.post('/api/admin/containers', {
        data: {
          ownerId: seedState.adminUserId,
          serverId: gpuServer.id,
          imageId: seedState.image.id,
          name: `e2e-gpucol-${Date.now().toString(36)}`.slice(0, 63),
          rootSizeBytes: 2 * 1024 * 1024 * 1024,
          cpuMillis: 500,
          memBytes: 512 * 1024 * 1024,
          gpuPciAddresses: [pci],
          powerIntent: 'stopped',
        },
      });
      expect(collision.status()).toBe(409);
      const collisionBody = await collision.json() as JsonRecord;
      expect(errorCode(collisionBody)).toBe('GPU_ALREADY_CLAIMED');

      const session = await loginPersona(adminApi, persona);
      const userApi = await authedApiFactory(session.accessToken);
      await upsertStoragePoolGrant(adminApi, persona.userId, gpuServer.dirPoolId);
      await upsertServerGrant(adminApi, persona.userId, gpuServer.id, {
        cpuMillis: 1_000,
        memBytes: 1_024 * 1_024 * 1_024,
        diskBytes: 8 * 1_024 * 1_024 * 1_024,
        expiresAt: null,
      });
      const denied = await readErrorBody(
        await userApi.post('/api/containers', {
          data: {
            serverId: gpuServer.id,
            imageId: seedState.image.id,
            name: `e2e-gpudeny-${Date.now().toString(36)}`.slice(0, 63),
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            gpuPciAddresses: [pci],
            powerIntent: 'stopped',
          },
        }),
      );
      expect([403, 409]).toContain(denied.status);

      await adminApi.put(
        `/api/admin/users/${persona.userId}/server-grants/${gpuServer.id}`,
        {
          data: {
            cpuMillis: 1_000,
            memBytes: 1_024 * 1_024 * 1_024,
            diskBytes: 8 * 1_024 * 1_024 * 1_024,
            gpu: { mode: 'pci', pciAddresses: [pci] },
            expiresAt: null,
          },
        },
      );

      const deletion = await adminApi.post(`/api/admin/containers/${adminContainer}/actions/delete`);
      expect(deletion.status()).toBe(202);
      await waitForGone(adminApi, `/api/admin/containers/${adminContainer}`);
      adminContainer = undefined;

      const userCreate = await expectJson<JsonRecord>(
        await userApi.post('/api/containers', {
          data: {
            serverId: gpuServer.id,
            imageId: seedState.image.id,
            name: `e2e-gpuu-${Date.now().toString(36)}`.slice(0, 63),
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            gpuPciAddresses: [pci],
            powerIntent: 'stopped',
          },
        }),
        202,
      );
      userContainer = userCreate.resourceId as string;
      await requireSucceededIntent(userApi, userCreate.intentId, 'user.gpu.container.create');
    } finally {
      if (adminContainer) {
        const deletion = await adminApi.post(`/api/admin/containers/${adminContainer}/actions/delete`);
        if (deletion.status() === 202) {
          await waitForGone(adminApi, `/api/admin/containers/${adminContainer}`);
        }
      }
      await deleteUserContainer(adminApi, adminApi, userContainer);
      await deletePersonaUser(adminApi, persona.userId);
    }
  },
);
