import { test, expect } from '../../fixtures/live-stack.js';
import type { APIRequestContext } from '@playwright/test';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { runCommand, runIncus } from '../../support/incus-control.js';
import { eventually } from '../../support/poll.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';
import { waitForContainerSshReady } from '../../support/wait-for-ssh.js';
import { waitForGone } from '../../support/wait-for-gone.js';

type JsonRecord = Record<string, any>;

async function waitForIntent(
  api: APIRequestContext,
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
  api: APIRequestContext,
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
  api: APIRequestContext,
  seedState: {
    runId: string;
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
  api: APIRequestContext,
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
// `incus exec` over SSH to E2E_GPU_PEER_HOST (macvlan isolates the local host
// from its own containers). Fall back to guest SSH only when the peer host
// helper is unset (cross-host guest IPs remain reachable on the LAN).
async function peerExecInContainer(
  api: APIRequestContext,
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
  api: APIRequestContext,
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
  api: APIRequestContext,
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
  api: APIRequestContext,
  volumeId: string | undefined,
): Promise<void> {
  if (!volumeId) return;
  const deletion = await api.delete(`/api/admin/volumes/${volumeId}`)
    .catch(() => undefined);
  if (deletion?.status() === 202) {
    await waitForGone(api, `/api/admin/volumes/${volumeId}`);
  }
}

async function attachVolume(
  api: APIRequestContext,
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
  api: APIRequestContext,
  containerId: string,
  attachmentId: string,
): Promise<void> {
  const accepted = await expectJson<JsonRecord>(
    await api.delete(`/api/admin/containers/${containerId}/volumes/${attachmentId}`),
    202,
  );
  await requireSucceededIntent(api, accepted.intentId, 'volume.detach');
}

async function stopContainer(
  api: APIRequestContext,
  containerId: string,
): Promise<void> {
  const accepted = await expectJson<JsonRecord>(
    await api.post(`/api/admin/containers/${containerId}/actions/stop`),
    202,
  );
  await requireSucceededIntent(api, accepted.intentId, 'container.power.stop');
  await eventually(
    async () => expectJson<JsonRecord>(
      await api.get(`/api/admin/containers/${containerId}`),
    ),
    (value) => value.actual?.status === 'stopped' || value.powerIntent === 'stopped',
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
      expect(lvmCapability.state).toBe('blocked');
      return;
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

      await detachVolume(adminApi, containerId, attachmentId);
      if (capability.shrinkRequiresStop === true) {
        await stopContainer(adminApi, containerId);
      }

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
        /VOLUME_DETACH_DRAINING|Detach all volume attachments/i,
      );

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

    if (seedState.sharedBackendId) {
      // User-facing GET filters by grants; admin list/detail remain authoritative
      // for seeded backends even when no grant is currently attached.
      const detail = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-backends/${seedState.sharedBackendId}`),
      );
      expect(detail.id).toBe(seedState.sharedBackendId);
      expect(adminShared.some((entry) => entry.id === seedState.sharedBackendId)).toBe(true);
    } else {
      expect(adminShared).toHaveLength(0);
      expect(shared).toHaveLength(0);
    }

    if (seedState.blocked.cephfs.startsWith('BLOCKED:')) {
      expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('blocked');
    }
  },
);

test(
  'exercises shared CephFS backend grants, volumes, attach/detach, capacity, and cleanup',
  { ...coverageCase('shared-cephfs-storage', 'shared-cephfs-storage-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    test.setTimeout(480_000);
    const cephCapability = topologyProvider.capabilities['cephfs-cluster'];
    const backendId = seedState.sharedBackendId
      ?? process.env.E2E_SHARED_BACKEND_ID?.trim();
    if (cephCapability.state !== 'available' || !backendId) {
      expect(cephCapability.state).toBe('blocked');
      expect(
        seedState.blocked.cephfs.startsWith('BLOCKED:')
          || !seedState.sharedBackendId,
      ).toBe(true);
      return;
    }

    expect(cephCapability.state, cephCapability.detail).toBe('available');
    expect(
      seedState.blocked.cephfs.startsWith('ENABLED:')
        || seedState.blocked.cephfs.startsWith('BLOCKED:'),
    ).toBe(true);

    const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const mountPath = '/mnt/e2e-cephfs';
    let localContainerId: string | undefined;
    let peerContainerId: string | undefined;
    let volumeId: string | undefined;
    let grantRestored = false;

    try {
      const backend = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-backends/${backendId}`),
      );
      expect(backend.id).toBe(backendId);
      expect(backend.identityKey || backend.identity_key).toBeTruthy();
      expect(Number(backend.overcommitRatio)).toBeGreaterThanOrEqual(1);

      const localPools = await expectJson<JsonRecord[]>(
        await adminApi.get(`/api/admin/servers/${seedState.server.id}/storage-pools`),
      );
      const localCephPools = localPools.filter((pool) => (
        pool.driver === 'cephfs'
        && pool.shareable === true
        && pool.registered === true
        && pool.sharedBackendId === backendId
      ));
      expect(localCephPools.length, JSON.stringify(localPools)).toBeGreaterThanOrEqual(1);
      const localCephPool = localCephPools[0]!;

      // Discover remains idempotent against the already-mapped pool.
      const rediscovered = await expectJson<JsonRecord[]>(
        await adminApi.post(
          `/api/admin/servers/${seedState.server.id}/storage-pools/discover`,
          { data: {} },
        ),
        [200, 201],
      );
      expect(rediscovered.some((pool) => pool.id === localCephPool.id)).toBe(true);

      const grantLimitBytes = 512 * 1024 * 1024;
      const grant = await expectJson<JsonRecord>(
        await adminApi.put(
          `/api/admin/users/${seedState.adminUserId}/shared-backend-grants/${backendId}`,
          {
            data: {
              limitBytes: grantLimitBytes,
              expiresAt: null,
            },
          },
        ),
      );
      expect(Number(grant.limitBytes)).toBe(grantLimitBytes);
      expect(grant.expiresAt).toBeNull();
      grantRestored = true;

      const capacity = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/servers/${seedState.server.id}/storage-capacity`),
      );
      expect(capacity.overcommitRatio ?? capacity.pools).toBeDefined();

      const overGrant = await adminApi.post('/api/volumes', {
        data: {
          name: `e2e-ceph-over-${uniqueSuffix}`,
          sizeBytes: grantLimitBytes + 64 * 1024 * 1024,
          scope: {
            kind: 'shared',
            sharedBackendId: backendId,
            poolId: localCephPool.id,
          },
        },
      });
      expect([403, 409]).toContain(overGrant.status());

      const created = await expectJson<JsonRecord>(
        await adminApi.post('/api/admin/volumes', {
          data: {
            ownerId: seedState.adminUserId,
            name: `e2e-ceph-${uniqueSuffix}`,
            sizeBytes: 128 * 1024 * 1024,
            scope: {
              kind: 'shared',
              sharedBackendId: backendId,
              poolId: localCephPool.id,
            },
          },
        }),
        202,
      );
      volumeId = created.resourceId as string;
      await requireSucceededIntent(adminApi, created.intentId, 'shared.volume.create');

      const volume = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/volumes/${volumeId}`),
      );
      expect(volume.scope?.kind ?? volume.sharedBackendId).toBeTruthy();
      const resized = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/volumes/${volumeId}`, {
          data: {
            expectedRevision: volume.generation,
            sizeBytes: 192 * 1024 * 1024,
          },
        }),
        202,
      );
      await requireSucceededIntent(adminApi, resized.intentId, 'shared.volume.resize');

      localContainerId = await createRunningContainer(
        adminApi,
        seedState,
        `e2e-ceph-local-${uniqueSuffix}`,
      );
      const { attachmentId } = await attachVolume(
        adminApi,
        localContainerId,
        volumeId,
        mountPath,
      );

      const deleteWhileAttached = await adminApi.delete(`/api/admin/volumes/${volumeId}`);
      expect(deleteWhileAttached.status()).toBe(409);

      const proof = await execInContainer(
        adminApi,
        localContainerId,
        `test -d ${mountPath} && printf cephfs-e2e > ${mountPath}/e2e-proof && cat ${mountPath}/e2e-proof`,
      );
      expect(proof.trim()).toBe('cephfs-e2e');

      const peerServerId = process.env.E2E_GPU_PEER_SERVER_ID?.trim();
      if (peerServerId && peerServerId !== seedState.server.id) {
        const peerPools = await expectJson<JsonRecord[]>(
          await adminApi.get(`/api/admin/servers/${peerServerId}/storage-pools`),
        );
        const peerMapped = peerPools.some((pool) => (
          pool.driver === 'cephfs'
          && pool.registered === true
          && pool.sharedBackendId === backendId
        ));
        if (peerMapped) {
          peerContainerId = await createRunningContainer(
            adminApi,
            seedState,
            `e2e-ceph-peer-${uniqueSuffix}`,
            peerServerId,
          );
          const peerAttach = await attachVolume(
            adminApi,
            peerContainerId,
            volumeId,
            mountPath,
          );
          const peerProof = await peerExecInContainer(
            adminApi,
            peerContainerId,
            `test -f ${mountPath}/e2e-proof && cat ${mountPath}/e2e-proof`,
          );
          expect(peerProof.trim()).toBe('cephfs-e2e');
          await detachVolume(adminApi, peerContainerId, peerAttach.attachmentId);
        }
      }

      await detachVolume(adminApi, localContainerId, attachmentId);
      await deleteVolume(adminApi, volumeId);
      volumeId = undefined;
    } finally {
      await deleteVolume(adminApi, volumeId);
      await deleteContainer(adminApi, localContainerId);
      await deleteContainer(adminApi, peerContainerId);
      if (grantRestored) {
        await adminApi.delete(
          `/api/admin/users/${seedState.adminUserId}/shared-backend-grants/${backendId}`,
        ).catch(() => undefined);
      }
    }
  },
);
