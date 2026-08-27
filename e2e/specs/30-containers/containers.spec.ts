import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { eventually } from '../../support/poll.js';
import { runCommand } from '../../support/incus-control.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';
import { waitForContainerSshReady } from '../../support/wait-for-ssh.js';
import { waitForGone } from '../../support/wait-for-gone.js';
import { runViaSshProxyJump, sshProxyJumpConfigured } from '../../support/ssh-jump.js';

type JsonRecord = Record<string, any>;

test(
  'creates an Incus container, reconciles it, executes a command, and reaches SSH',
  { ...coverageCase('container-intent-exec-ssh', 'container-exec-ssh-live') },
  async ({ adminApi, seedState }) => {
    // Create (~30s) + ssh.ready/port wait (up to ~180s) + exec/SSH/delete headroom.
    test.setTimeout(300_000);
    let containerId: string | undefined;
    try {
      const accepted = await expectJson<JsonRecord>(
        await adminApi.post('/api/admin/containers', {
          data: {
            ownerId: seedState.adminUserId,
            serverId: seedState.server.id,
            imageId: seedState.image.id,
            name: `e2e-${seedState.runId}-${Date.now().toString(36)}`,
            rootSizeBytes: 4 * 1024 * 1024 * 1024,
            cpuMillis: 500,
            memBytes: 512 * 1024 * 1024,
            gpuPciAddresses: [],
            powerIntent: 'running',
          },
        }),
        202,
      );
      containerId = accepted.resourceId;
      expect(containerId).toBeTruthy();
      expect(accepted.intentId).toBeTruthy();

      const intent = await eventually(
        async () => expectJson<JsonRecord>(
          await adminApi.get(`/api/intents/${accepted.intentId}`),
        ),
        (value) => value.status === 'succeeded' || value.status === 'failed',
        180_000,
        500,
        'container.create intent settled',
      );
      expect(intent.status, JSON.stringify({
        intentId: accepted.intentId,
        failureCode: intent.failureCode,
        failure: intent.failure,
      })).toBe('succeeded');
      expect(intent.kind).toBe('container.create');

      // Tolerate brief GET 404 only while create has not been observed yet.
      // Once the resource was visible, 404 means mid-test deletion — fail clearly.
      let createLanded = false;
      let pendingCreate404s = 0;
      const container = await waitForContainerSshReady(
        async () => {
          const response = await adminApi.get(`/api/admin/containers/${containerId}`);
          if (response.status() === 404) {
            if (createLanded) {
              throw new Error(
                `container ${containerId} deleted mid-test (GET 404 after create was observed)`,
              );
            }
            pendingCreate404s += 1;
            if (pendingCreate404s > 10) {
              throw new Error(
                `container ${containerId} never became visible (GET 404 after create intent succeeded)`,
              );
            }
            return {
              actual: { status: 'pending' },
              routedIp: null,
              ssh: { ready: false },
            } as JsonRecord;
          }
          pendingCreate404s = 0;
          const value = await expectJson<JsonRecord>(response, 200);
          createLanded = true;
          return value;
        },
        180_000,
        500,
      );
      expect(container.imageFingerprint).toBe(seedState.image.fingerprint);
      expect(container.gpuPciAddresses).toEqual([]);
      expect(container.ssh?.ready).toBe(true);
      expect(container.ssh?.status).toBe('running');

      const repair = await expectJson<{ woken: boolean }>(
        await adminApi.post(`/api/admin/containers/${containerId}/actions/repair-ssh`),
        202,
      );
      expect(repair.woken).toBe(true);

      const session = await expectJson<JsonRecord>(
        await adminApi.post(`/api/admin/containers/${containerId}/exec-sessions`, {
          data: {
            command: ['/bin/sh', '-lc', 'printf incus-e2e'],
            tty: false,
            cols: 120,
            rows: 40,
          },
        }),
        [200, 201],
      );
      expect(session.consoleUrl).toMatch(/^\/ws\/console\?/);
      expect(session.sessionId).toBeTruthy();

      // macvlan isolates the host from local containers; prove the guest via Incus exec.
      expect(container.instanceName).toBeTruthy();
      const guest = await runCommand('incus', [
        'exec',
        container.instanceName,
        '--',
        '/bin/sh',
        '-lc',
        'printf incus-e2e && ip -4 addr show dev eth0',
      ]);
      expect(guest.code, guest.stderr).toBe(0);
      expect(guest.stdout).toContain('incus-e2e');
      expect(guest.stdout).toContain(container.routedIp);

      if (sshProxyJumpConfigured()) {
        const jump = await eventually(
          async () => runViaSshProxyJump({
            username: container.ownerName ?? requireRuntimeEnv('E2E_ADMIN_USERNAME'),
            containerName: container.name,
            loginUser: container.ssh?.loginUser ?? requireRuntimeEnv('E2E_SSH_USER'),
            routedIp: container.routedIp,
            command: 'printf jump-e2e',
          }),
          (value) => value.code === 0 && value.stdout.includes('jump-e2e'),
          60_000,
          2_000,
          'ssh proxy jump reaches guest',
        );
        expect(jump.code, jump.stderr).toBe(0);
        expect(jump.stdout).toContain('jump-e2e');
      }
    } finally {
      if (containerId) {
        const deletion = await adminApi.post(
          `/api/admin/containers/${containerId}/actions/delete`,
        ).catch(() => undefined);
        if (deletion?.status() === 202) {
          await waitForGone(adminApi, `/api/admin/containers/${containerId}`);
        }
      }
    }
  },
);

test(
  'creates a GPU container on peer server #2 and claims the proven PCI address',
  { ...coverageCase('container-intent-exec-ssh', 'container-gpu-peer-claim-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    test.setTimeout(300_000);
    const gpuCapability = topologyProvider.capabilities['gpu-pci'];
    if (gpuCapability.state !== 'available' || seedState.blocked.gpu.startsWith('BLOCKED:')) {
      expect(gpuCapability.state).toBe('blocked');
      expect(seedState.blocked.gpu.startsWith('BLOCKED:')).toBe(true);
      return;
    }
    const peerServerId = requireRuntimeEnv('E2E_GPU_PEER_SERVER_ID');
    const pciAddress = requireRuntimeEnv('E2E_GPU_PCI_ADDRESS');
    expect(peerServerId).not.toBe(seedState.server.id);
    expect(seedState.blocked.gpu.startsWith('PROVEN:')).toBe(true);

    const servers = await expectJson<JsonRecord[]>(
      await adminApi.get('/api/admin/servers'),
    );
    const peer = servers.find((server) => server.id === peerServerId);
    expect(peer, `peer server ${peerServerId} missing from control plane`).toBeTruthy();
    expect(peer?.gpuRuntimeAvailable).toBe(true);
    expect(peer?.preflightStatus).toBe('passed');

    let containerId: string | undefined;
    try {
      const accepted = await expectJson<JsonRecord>(
        await adminApi.post('/api/admin/containers', {
          data: {
            ownerId: seedState.adminUserId,
            serverId: peerServerId,
            imageId: seedState.image.id,
            name: `e2e-gpu-${seedState.runId}-${Date.now().toString(36)}`,
            rootSizeBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 1000,
            memBytes: 2 * 1024 * 1024 * 1024,
            gpuPciAddresses: [pciAddress],
            powerIntent: 'running',
          },
        }),
        202,
      );
      containerId = accepted.resourceId;
      expect(containerId).toBeTruthy();

      const intent = await eventually(
        async () => expectJson<JsonRecord>(
          await adminApi.get(`/api/intents/${accepted.intentId}`),
        ),
        (value) => value.status === 'succeeded' || value.status === 'failed',
        180_000,
        500,
        'peer GPU container.create intent settled',
      );
      expect(intent.status, JSON.stringify({
        intentId: accepted.intentId,
        failureCode: intent.failureCode,
        failure: intent.failure,
      })).toBe('succeeded');

      const container = await eventually(
        async () => expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/containers/${containerId}`),
        ),
        (value) => value.lifecyclePhase === 'active' && value.actual?.status === 'running',
        180_000,
        500,
        'peer GPU container active',
      );
      expect(container.serverId).toBe(peerServerId);
      expect(container.gpuPciAddresses).toEqual([pciAddress]);
      expect(container.failureCode).toBeFalsy();
    } finally {
      if (containerId) {
        const deletion = await adminApi.post(
          `/api/admin/containers/${containerId}/actions/delete`,
        ).catch(() => undefined);
        if (deletion?.status() === 202) {
          await waitForGone(adminApi, `/api/admin/containers/${containerId}`);
        }
      }
    }
  },
);
