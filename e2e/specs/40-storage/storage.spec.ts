import { test, expect } from '../../fixtures/live-stack.js';
import type { ApiClient } from '../../support/api-client.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { runCommand, runIncus } from '../../support/incus-control.js';
import { eventually } from '../../support/poll.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';
import { waitForContainerSshReady } from '../../support/wait-for-ssh.js';
import { waitForGone } from '../../support/wait-for-gone.js';
import {
  attachVolume as attachSharedVolume,
  createSharedVolume,
  deleteVolume as deleteAnyVolume,
  detachVolume as detachSharedVolume,
  expectDetachRequiresStop,
  stopContainer as stopSharedContainer,
  waitForCephCatalogGone,
} from '../../support/volume-ops.js';

type JsonRecord = Record<string, any>;

async function waitForIntent(
  api: ApiClient,
  intentId: string,
  timeoutMs = 180_000,
): Promise<JsonRecord> {
  return eventually(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/intents/${intentId}`),
    ),
    (intent) => intent.status === 'succeeded' || intent.status === 'failed',
    timeoutMs,
    500,
    `intent ${intentId} settled`,
  );
}

async function requireSucceededIntent(
  api: ApiClient,
  intentId: string,
  label: string,
): Promise<JsonRecord> {
  const intent = await waitForIntent(api, intentId);
  expect(intent.status, JSON.stringify({
    label,
    intentId,
    failureCode: intent.failureCode,
    failure: intent.failure,
  })).toBe('succeeded');
  return intent;
}

async function createRunningContainer(
  api: ApiClient,
  seedState: {
    runId: string;
    adminUserId: string;
    server: { id: string };
    image: { id: string };
  },
  namePrefix: string,
  serverId = seedState.server.id,
): Promise<string> {
  const accepted = await expectJson<JsonRecord>(
    await api.post('/api/admin/containers', {
      data: {
        ownerId: seedState.adminUserId,
        serverId,
        imageId: seedState.image.id,
        name: `${namePrefix}-${Date.now().toString(36)}`,
        rootSizeBytes: 2 * 1024 * 1024 * 1024,
        cpuMillis: 500,
        memBytes: 512 * 1024 * 1024,
        gpuPciAddresses: [],
        powerIntent: 'running',
      },
    }),
    202,
  );
  const containerId = accepted.resourceId as string;
  await requireSucceededIntent(api, accepted.intentId, 'container.create');
  await eventually(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/containers/${containerId}`),
    ),
    (value) => value.lifecyclePhase === 'active' && value.actual?.status === 'running',
    180_000,
    500,
    `container ${containerId} running`,
  );
  return containerId;
}

// Real in-guest proof: exec-sessions is a WebSocket-driven console bridge with no
// synchronous stdout in its HTTP response, so it cannot assert command output by
// itself. The Incus exec helper runs the command host-side and returns real stdout,
// which is what proves the volume path/content inside the guest.
async function execInContainer(
  api: ApiClient,
  containerId: string,
  command: string,
): Promise<string> {
  const container = await expectJson<JsonRecord>(
    await api.get(`/api/admin/containers/${containerId}`),
  );
  const instanceName = container.instanceName as string;
  expect(instanceName, JSON.stringify(container)).toBeTruthy();
  const result = await runIncus(['exec', instanceName, '--', '/bin/sh', '-lc', command]);
  expect(result.code, JSON.stringify(result)).toBe(0);
  return result.stdout;
}

// Peer instances are not on the local Incus unix socket. Prefer host-side
// `incus exec` over SSH to E2E_GPU_PEER_HOST. Host TCP to routedIp:22 is a
// valid extra assertion when the SSH proxy runs on the Incus host.
async function peerExecInContainer(
  api: ApiClient,
  containerId: string,
  command: string,
): Promise<string> {
  const container = await expectJson<JsonRecord>(
    await api.get(`/api/admin/containers/${containerId}`),
  );
  const instanceName = container.instanceName as string;
  expect(instanceName, JSON.stringify(container)).toBeTruthy();

  const peerHost = process.env.E2E_GPU_PEER_HOST?.trim();
  if (peerHost) {
    // Pass one remote shell string so `/bin/sh -lc <script>` keeps spaces intact.
    const remote = [
      'incus',
      'exec',
      instanceName,
      '--',
      '/bin/sh',
      '-lc',
      JSON.stringify(command),
    ].join(' ');
    const result = await runCommand('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      `lyn@${peerHost}`,
      remote,
    ]);
    expect(result.code, `${result.stderr}\nremote=${remote}`).toBe(0);
    return result.stdout;
  }

  const ready = await waitForContainerSshReady(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/containers/${containerId}`),
    ),
  );
  const result = await runCommand('ssh', [
    '-i',
    requireRuntimeEnv('E2E_SSH_PRIVATE_KEY_FILE'),
    '-o',
    `UserKnownHostsFile=${requireRuntimeEnv('E2E_SSH_KNOWN_HOSTS')}`,
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ConnectTimeout=15',
    `${requireRuntimeEnv('E2E_SSH_USER')}@${ready.routedIp}`,
    '/bin/sh',
    '-lc',
    command,
  ]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function deleteContainer(
  api: ApiClient,
  containerId: string | undefined,
): Promise<void> {
  if (!containerId) return;
  const deletion = await api.post(
    `/api/admin/containers/${containerId}/actions/delete`,
  ).catch(() => undefined);
  if (deletion?.status() === 202) {
    await waitForGone(api, `/api/admin/containers/${containerId}`);
  }
}

async function createLocalVolume(
  api: ApiClient,
  seedState: {
    adminUserId: string;
    server: { id: string };
    storagePools: { dirQuotaOnline: { id: string } };
  },
  name: string,
  sizeBytes = 128 * 1024 * 1024,
  poolId = seedState.storagePools.dirQuotaOnline.id,
): Promise<string> {
  const accepted = await expectJson<JsonRecord>(
    await api.post('/api/admin/volumes', {
      data: {
        ownerId: seedState.adminUserId,
        name,
        sizeBytes,
        scope: {
          kind: 'local',
          serverId: seedState.server.id,
          poolId,
        },
      },
    }),
    202,
  );
  const volumeId = accepted.resourceId as string;
  await requireSucceededIntent(api, accepted.intentId, 'volume.create');
  return volumeId;
}

async function deleteVolume(
  api: ApiClient,
  volumeId: string | undefined,
): Promise<void> {
  await deleteAnyVolume(api, volumeId);
}

async function attachVolume(
  api: ApiClient,
  containerId: string,
  volumeId: string,
  containerPath: string,
): Promise<{ attachmentId: string; intentId: string }> {
  const accepted = await expectJson<JsonRecord>(
    await api.post(`/api/admin/containers/${containerId}/volumes`, {
      data: {
        volumeId,
        containerPath,
        readOnly: false,
      },
    }),
    202,
  );
  await requireSucceededIntent(api, accepted.intentId, 'volume.attach');
  const attachments = await expectJson<JsonRecord[]>(
    await api.get(`/api/admin/containers/${containerId}/volumes`),
  );
  const attachment = attachments.find((entry) => entry.volumeId === volumeId
    && entry.containerPath === containerPath);
  expect(attachment?.id, JSON.stringify(attachments)).toBeTruthy();
  return { attachmentId: attachment!.id as string, intentId: accepted.intentId as string };
}

async function detachVolume(
  api: ApiClient,
  containerId: string,
  attachmentId: string,
): Promise<void> {
  const response = await api.delete(
    `/api/admin/containers/${containerId}/volumes/${attachmentId}`,
  );
  if (response.status() === 409) {
    const body = await response.json();
    throw new Error(
      `VOLUME_DETACH_REQUIRES_STOP: stop the container before detach `
      + `(container=${containerId} attachment=${attachmentId}) body=${JSON.stringify(body)}`,
    );
  }
  const accepted = await expectJson<JsonRecord>(response, 202);
  await requireSucceededIntent(api, accepted.intentId, 'volume.detach');
}

async function stopContainer(
  api: ApiClient,
  containerId: string,
): Promise<void> {
  const current = await expectJson<JsonRecord>(
    await api.get(`/api/admin/containers/${containerId}`),
  );
  if (current.actual?.status === 'stopped' && current.powerIntent === 'stopped') return;
  const accepted = await expectJson<JsonRecord>(
    await api.post(`/api/admin/containers/${containerId}/actions/stop`),
    202,
  );
  await requireSucceededIntent(api, accepted.intentId, 'container.power.stop');
  await eventually(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/containers/${containerId}`),
    ),
    (value) => value.actual?.status === 'stopped' && value.powerIntent === 'stopped',
    180_000,
    500,
    `container ${containerId} stopped`,
  );
}

test(
  'discovers both storage families and resizes local volumes',
  { ...coverageCase('storage-capability-families', 'storage-families-live') },
  async ({ adminApi, seedState }) => {
    const pools = await expectJson<JsonRecord[]>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}/storage-pools`),
    );
    expect(pools.some((pool) => pool.id === seedState.storagePools.dirQuotaOnline.id
      && pool.driver === 'dir')).toBe(true);
    expect(pools.some((pool) => pool.id === seedState.storagePools.lvmBlockBacked.id
      && pool.driver === 'lvm')).toBe(true);

    const capacity = await expectJson<JsonRecord>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}/storage-capacity`),
    );
    expect(capacity).toBeDefined();
    await expectJson(
      await adminApi.get(`/api/servers/${seedState.server.id}/storage-pools`),
    );
    await expectJson(
      await adminApi.get(`/api/servers/${seedState.server.id}/storage-capacity`),
    );
    await expectJson(await adminApi.get('/api/admin/volumes'));
    await expectJson(
      await adminApi.post(`/api/admin/servers/${seedState.server.id}/storage-pools/discover`),
    );
    const missingPool = await adminApi.patch(
      '/api/admin/storage-pools/00000000-0000-4000-8000-0000000000aa',
      { data: { expectedRevision: 1, registered: true } },
    );
    expect(missingPool.status()).toBeGreaterThanOrEqual(400);

    const volumeIds: string[] = [];
    const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      for (const [label, poolId] of [
        ['dir', seedState.storagePools.dirQuotaOnline.id],
        ['lvm', seedState.storagePools.lvmBlockBacked.id],
      ] as const) {
        const accepted = await expectJson<JsonRecord>(
          await adminApi.post('/api/admin/volumes', {
            data: {
              ownerId: seedState.adminUserId,
              name: `e2e-${label}-${uniqueSuffix}`,
              sizeBytes: 128 * 1024 * 1024,
              scope: {
                kind: 'local',
                serverId: seedState.server.id,
                poolId,
              },
            },
          }),
          202,
        );
        const volumeId = accepted.resourceId as string;
        volumeIds.push(volumeId);
        await waitForIntent(adminApi, accepted.intentId);

        await expectJson(await adminApi.get(`/api/admin/volumes/${volumeId}/intents`));
        const volume = await expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/volumes/${volumeId}`),
        );
        // VolumeDto uses generation (not revision); omitting expectedRevision yields 400 INVALID_INPUT.
        expect(volume.generation).toEqual(expect.any(Number));
        const resized = await expectJson<JsonRecord>(
          await adminApi.patch(`/api/admin/volumes/${volumeId}`, {
            data: {
              expectedRevision: volume.generation,
              sizeBytes: 192 * 1024 * 1024,
            },
          }),
          202,
        );
        await waitForIntent(adminApi, resized.intentId);
        const updated = await expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/volumes/${volumeId}`),
        );
        expect(Number(updated.sizeBytes)).toBe(192 * 1024 * 1024);
      }
    } finally {
      for (const volumeId of volumeIds) {
        await deleteVolume(adminApi, volumeId);
      }
    }
  },
);

test(
  'shrinks a block-backed LVM volume using detach/stop product rules',
  { ...coverageCase('storage-lvm-block-backed-shrink', 'storage-lvm-block-backed-shrink-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    test.setTimeout(420_000);
    const lvmCapability = topologyProvider.capabilities['storage-lvm-block-backed'];
    if (lvmCapability.state !== 'available') {
      throw new Error(`BLOCKED: storage-lvm-block-backed is ${lvmCapability.state}`);
    }

    const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const initialSize = 192 * 1024 * 1024;
    const targetSize = 128 * 1024 * 1024;
    let containerId: string | undefined;
    let volumeId: string | undefined;
    try {
      volumeId = await createLocalVolume(
        adminApi,
        seedState,
        `e2e-lvm-shrink-${uniqueSuffix}`,
        initialSize,
        seedState.storagePools.lvmBlockBacked.id,
      );
      const created = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/volumes/${volumeId}`),
      );
      expect(Number(created.sizeBytes)).toBe(initialSize);
      const capability = created.capability ?? {};
      expect(capability.shrinkNever).not.toBe(true);

      containerId = await createRunningContainer(
        adminApi,
        seedState,
        `e2e-lvm-shrink-${uniqueSuffix}`,
      );
      const { attachmentId } = await attachVolume(
        adminApi,
        containerId,
        volumeId,
        '/mnt/e2e-lvm-shrink',
      );

      const attachedVolume = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/volumes/${volumeId}`),
      );
      const attachedShrink = await adminApi.patch(`/api/admin/volumes/${volumeId}`, {
        data: {
          expectedRevision: attachedVolume.generation,
          sizeBytes: targetSize,
        },
      });
      expect(attachedShrink.status()).toBe(409);
      const attachedBody = await attachedShrink.json();
      expect(JSON.stringify(attachedBody)).toMatch(/VOLUME_SHRINK_REQUIRES_DETACH/);

      await stopContainer(adminApi, containerId);
      await detachVolume(adminApi, containerId, attachmentId);

      const detached = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/volumes/${volumeId}`),
      );
      const shrunk = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/volumes/${volumeId}`, {
          data: {
            expectedRevision: detached.generation,
            sizeBytes: targetSize,
          },
        }),
        202,
      );
      await requireSucceededIntent(adminApi, shrunk.intentId, 'volume.resize.lvm-shrink');
      const updated = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/volumes/${volumeId}`),
      );
      expect(Number(updated.sizeBytes)).toBe(targetSize);
      expect(Number(updated.sizeBytes)).toBeLessThan(initialSize);
    } finally {
      await deleteContainer(adminApi, containerId);
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'attaches and detaches local volumes, rejects delete-while-attached, and races attach/resize',
  { ...coverageCase('local-volume-attach-detach', 'local-volume-attach-detach-live') },
  async ({ adminApi, seedState }) => {
    test.setTimeout(420_000);
    const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let containerA: string | undefined;
    let containerB: string | undefined;
    let volumeId: string | undefined;
    let raceVolumeId: string | undefined;
    try {
      containerA = await createRunningContainer(adminApi, seedState, `e2e-vol-a-${uniqueSuffix}`);
      containerB = await createRunningContainer(adminApi, seedState, `e2e-vol-b-${uniqueSuffix}`);
      volumeId = await createLocalVolume(
        adminApi,
        seedState,
        `e2e-attach-${uniqueSuffix}`,
      );

      const { attachmentId } = await attachVolume(
        adminApi,
        containerA,
        volumeId,
        '/mnt/e2e-local',
      );

      const attachments = await expectJson<JsonRecord[]>(
        await adminApi.get(`/api/admin/containers/${containerA}/volumes`),
      );
      expect(attachments.some((entry) => entry.id === attachmentId
        && entry.volumeId === volumeId
        && entry.containerPath === '/mnt/e2e-local')).toBe(true);

      const proof = await execInContainer(
        adminApi,
        containerA,
        'test -d /mnt/e2e-local && printf proof > /mnt/e2e-local/e2e-proof && cat /mnt/e2e-local/e2e-proof',
      );
      expect(proof.trim()).toBe('proof');

      const deleteWhileAttached = await adminApi.delete(`/api/admin/volumes/${volumeId}`);
      expect(deleteWhileAttached.status()).toBe(409);
      const deleteBody = await deleteWhileAttached.json();
      expect(JSON.stringify(deleteBody)).toMatch(
        /VOLUME_REQUIRES_UNBIND|Detach all volume attachments/i,
      );

      await expectDetachRequiresStop(adminApi, containerA, attachmentId, 'local');
      await stopContainer(adminApi, containerA);
      await detachVolume(adminApi, containerA, attachmentId);
      const afterDetach = await expectJson<JsonRecord[]>(
        await adminApi.get(`/api/admin/containers/${containerA}/volumes`),
      );
      expect(afterDetach.some((entry) => entry.id === attachmentId)).toBe(false);

      raceVolumeId = await createLocalVolume(
        adminApi,
        seedState,
        `e2e-race-${uniqueSuffix}`,
        96 * 1024 * 1024,
      );
      const raceVolume = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/volumes/${raceVolumeId}`),
      );

      const [attachRaceA, attachRaceB, resizeRace] = await Promise.all([
        adminApi.post(`/api/admin/containers/${containerA}/volumes`, {
          data: {
            volumeId: raceVolumeId,
            containerPath: '/mnt/e2e-race-a',
            readOnly: false,
          },
        }),
        adminApi.post(`/api/admin/containers/${containerB}/volumes`, {
          data: {
            volumeId: raceVolumeId,
            containerPath: '/mnt/e2e-race-b',
            readOnly: false,
          },
        }),
        adminApi.patch(`/api/admin/volumes/${raceVolumeId}`, {
          data: {
            expectedRevision: raceVolume.generation,
            sizeBytes: 160 * 1024 * 1024,
          },
        }),
      ]);

      const raceStatuses = [attachRaceA.status(), attachRaceB.status(), resizeRace.status()];
      expect(raceStatuses.filter((status) => status === 202).length).toBeGreaterThanOrEqual(1);
      expect(raceStatuses.every((status) => status === 202 || status === 409 || status === 400))
        .toBe(true);

      for (const response of [attachRaceA, attachRaceB, resizeRace]) {
        if (response.status() === 202) {
          const accepted = await response.json() as JsonRecord;
          await waitForIntent(adminApi, accepted.intentId);
        }
      }

      for (const containerId of [containerA, containerB]) {
        await stopContainer(adminApi, containerId);
        const listed = await expectJson<JsonRecord[]>(
          await adminApi.get(`/api/admin/containers/${containerId}/volumes`),
        );
        for (const attachment of listed.filter((entry) => entry.volumeId === raceVolumeId)) {
          await detachVolume(adminApi, containerId, attachment.id);
        }
      }

      await deleteVolume(adminApi, volumeId);
      volumeId = undefined;
      await deleteVolume(adminApi, raceVolumeId);
      raceVolumeId = undefined;
    } finally {
      await deleteVolume(adminApi, volumeId);
      await deleteVolume(adminApi, raceVolumeId);
      await deleteContainer(adminApi, containerA);
      await deleteContainer(adminApi, containerB);
    }
  },
);

test(
  'reports shared backend state without inventing a cluster capability',
  { ...coverageCase('shared-backend-contract', 'shared-backend-state-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    const shared = await expectJson<JsonRecord[]>(
      await adminApi.get('/api/shared-backends'),
    );
    expect(Array.isArray(shared)).toBe(true);

    const adminShared = await expectJson<JsonRecord[]>(
      await adminApi.get('/api/admin/shared-backends'),
    );
    expect(Array.isArray(adminShared)).toBe(true);

    const missing = '00000000-0000-4000-8000-000000000099';
    if (seedState.sharedBackendId) {
      // User-facing GET filters by grants; admin list/detail remain authoritative
      // for seeded backends even when no grant is currently attached.
      const detail = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-backends/${seedState.sharedBackendId}`),
      );
      expect(detail.id).toBe(seedState.sharedBackendId);
      expect(adminShared.some((entry) => entry.id === seedState.sharedBackendId)).toBe(true);
      const userDetail = await adminApi.get(`/api/shared-backends/${seedState.sharedBackendId}`);
      expect(userDetail.status()).toBeLessThan(500);
    } else {
      expect(adminShared).toHaveLength(0);
      expect(shared).toHaveLength(0);
      const userMissing = await adminApi.get(`/api/shared-backends/${missing}`);
      expect(userMissing.status()).toBeGreaterThanOrEqual(400);
      const adminMissing = await adminApi.get(`/api/admin/shared-backends/${missing}`);
      expect(adminMissing.status()).toBeGreaterThanOrEqual(400);
    }
    const patched = await adminApi.patch(`/api/admin/shared-backends/${missing}`, {
      data: { expectedRevision: 1, displayName: 'e2e' },
    });
    expect(patched.status()).toBeGreaterThanOrEqual(400);
    const deleted = await adminApi.delete(`/api/admin/shared-backends/${missing}`);
    expect(deleted.status()).toBeGreaterThanOrEqual(400);

    if (seedState.blocked.cephfs.startsWith('BLOCKED:')) {
      expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('blocked');
    }
  },
);

test(
  'rejects CephFS cluster usage when the identity is not a provisioned cluster',
  { ...coverageCase('cephfs-cluster-absent', 'cephfs-cluster-absent-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    const cephCapability = topologyProvider.capabilities['cephfs-cluster'];
    if (cephCapability.state === 'blocked') {
      expect(seedState.blocked.cephfs.startsWith('BLOCKED:')).toBe(true);
      expect(seedState.sharedBackendId ?? '').toBe('');
    }
    const created = await adminApi.post('/api/admin/shared-backends', {
      data: {
        name: `e2e-ceph-absent-${seedState.runId}`,
        kind: 'cephfs',
        identityKey: 'cephfs:e2e-absent-unprovisioned',
        fsid: '00000000-0000-0000-0000-000000000000',
      },
    });
    expect(created.status()).toBeGreaterThanOrEqual(400);
    expect(created.status()).toBeLessThan(500);
  },
);

test(
  'attaches a shared CephFS volume to containers on two Incus workers',
  { ...coverageCase('shared-cephfs-storage', 'shared-cephfs-storage-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    expect(seedState.sharedBackendId).toBeTruthy();
    const labServers = seedState.labServers ?? [];
    expect(labServers.length).toBeGreaterThanOrEqual(1);
    const worker = labServers[0];

    const primaryPools = await expectJson<JsonRecord[]>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}/storage-pools`),
    );
    const cephPool = primaryPools.find(
      (pool) => pool.driver === 'cephfs' && pool.shareable === true && pool.registered === true,
    );
    expect(cephPool?.id, 'primary CephFS pool').toBeTruthy();
    if (!cephPool) throw new Error('primary CephFS pool is missing');
    expect(cephPool.sharedBackendId).toBe(seedState.sharedBackendId);

    let volumeId: string | undefined;
    let primaryContainer: string | undefined;
    let workerContainer: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-ceph-${Date.now().toString(36)}`,
      );
      await expectJson(await adminApi.get('/api/admin/shared-volumes'));
      await expectJson(await adminApi.get(`/api/admin/shared-volumes/${volumeId}`));
      await expectJson(await adminApi.get(`/api/admin/shared-volumes/${volumeId}/catalogs`));
      await expectJson(await adminApi.get(`/api/admin/shared-volumes/${volumeId}/intents`));
      await expectJson(
        await adminApi.get(`/api/admin/shared-backends/${seedState.sharedBackendId}/catalog-inspect`),
      );
      await adminApi.get('/api/shared-volumes');
      await adminApi.get(`/api/shared-volumes/${volumeId}`);
      await adminApi.get(`/api/shared-volumes/${volumeId}/intents`);
      await adminApi.post('/api/shared-volumes', {
        data: {
          name: `e2e-ceph-user-${Date.now().toString(36)}`,
          sizeBytes: 64 * 1024 * 1024,
          scope: { kind: 'shared', sharedBackendId: seedState.sharedBackendId },
        },
      });
      await adminApi.patch(`/api/shared-volumes/${volumeId}`, {
        data: { expectedRevision: 1, sizeBytes: 80 * 1024 * 1024 },
      });
      await adminApi.delete('/api/shared-volumes/00000000-0000-4000-8000-000000000099');
      const createdForPatch = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      await adminApi.patch(`/api/admin/shared-volumes/${volumeId}`, {
        data: {
          expectedRevision: createdForPatch.generation,
          name: createdForPatch.name,
        },
      });

      primaryContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-ceph-a',
        seedState.server.id,
      );
      workerContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-ceph-b',
        worker.id,
      );
      await attachSharedVolume(adminApi, primaryContainer, volumeId, '/mnt/shared', 'shared');
      await attachSharedVolume(adminApi, workerContainer, volumeId, '/mnt/shared', 'shared');
      await adminApi.get(`/api/containers/${primaryContainer}/shared-volumes`);
      await adminApi.post(`/api/containers/${primaryContainer}/shared-volumes`, {
        data: { volumeId, containerPath: '/mnt/dup', readOnly: false },
      });
      await adminApi.delete(
        `/api/containers/${primaryContainer}/shared-volumes/00000000-0000-4000-8000-000000000099`,
      );

      const marker = `e2e-ceph-${seedState.runId}`;
      const written = await execInContainer(
        adminApi,
        primaryContainer,
        `printf '%s\\n' '${marker}' > /mnt/shared/marker && cat /mnt/shared/marker`,
      );
      expect(written).toContain(marker);

      const workerRow = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/containers/${workerContainer}`),
      );
      const instanceName = workerRow.instanceName as string;
      expect(instanceName).toBeTruthy();
      const remote = await runCommand('ssh', [
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=15',
        worker.ssh,
        [
          'incus',
          'exec',
          instanceName,
          '--',
          '/bin/sh',
          '-lc',
          JSON.stringify('cat /mnt/shared/marker'),
        ].join(' '),
      ]);
      expect(remote.code, remote.stderr).toBe(0);
      expect(remote.stdout).toContain(marker);

      const volume = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const incusName = volume.incusName as string;
      expect(incusName).toMatch(/^nyv-/);
      const workerPools = await expectJson<JsonRecord[]>(
        await adminApi.get(`/api/admin/servers/${worker.id}/storage-pools`),
      );
      const workerCeph = workerPools.find(
        (pool) => pool.driver === 'cephfs' && pool.shareable === true && pool.registered === true,
      );
      expect(workerCeph?.incusName, 'worker CephFS pool').toBeTruthy();

      const workerAttachments = await expectJson<JsonRecord[]>(
        await adminApi.get(`/api/admin/containers/${workerContainer}/shared-volumes`),
      );
      const workerAttachment = workerAttachments.find((entry) => entry.volumeId === volumeId);
      expect(workerAttachment?.id).toBeTruthy();
      await expectDetachRequiresStop(
        adminApi,
        workerContainer,
        workerAttachment!.id as string,
        'shared',
      );
      await stopSharedContainer(adminApi, workerContainer);
      await detachSharedVolume(adminApi, workerContainer, workerAttachment!.id as string, 'shared');

      const stillOnPrimary = await execInContainer(
        adminApi,
        primaryContainer,
        'cat /mnt/shared/marker',
      );
      expect(stillOnPrimary).toContain(marker);

      const workerCatalogAfterDetach = await runCommand('ssh', [
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=15',
        worker.ssh,
        ['incus', 'storage', 'volume', 'show', String(workerCeph!.incusName), `custom/${incusName}`].join(' '),
      ]);
      expect(workerCatalogAfterDetach.code, workerCatalogAfterDetach.stderr).toBe(0);

      const deleteWhileAttached = await adminApi.delete(`/api/admin/shared-volumes/${volumeId}`);
      expect(deleteWhileAttached.status()).toBe(409);
      const deleteBody = await deleteWhileAttached.json();
      expect(JSON.stringify(deleteBody)).toMatch(
        /VOLUME_REQUIRES_UNBIND|Detach all volume attachments/i,
      );

      await deleteContainer(adminApi, primaryContainer);
      primaryContainer = undefined;
      await deleteContainer(adminApi, workerContainer);
      workerContainer = undefined;
      await deleteVolume(adminApi, volumeId);
      volumeId = undefined;

      await waitForCephCatalogGone(incusName, [
        { id: seedState.server.id, poolName: String(cephPool.incusName) },
        { id: worker.id, ssh: worker.ssh, poolName: String(workerCeph!.incusName) },
      ]);
    } finally {
      await deleteContainer(adminApi, primaryContainer);
      await deleteContainer(adminApi, workerContainer);
      await deleteVolume(adminApi, volumeId);
    }
  },
);
