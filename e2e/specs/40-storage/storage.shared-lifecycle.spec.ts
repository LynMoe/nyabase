import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { eventually } from '../../support/poll.js';
import {
  assertNoCephCatalog,
  attachVolume,
  conflictCode,
  createLocalVolumeOnServer,
  createRunningContainer,
  createRunningContainerWithVolumes,
  createSharedVolume,
  deleteContainer,
  deleteIncusCustomVolume,
  deleteVolume,
  detachVolume,
  execInContainer,
  expectDetachRequiresStop,
  expectStartBusyWhileDetaching,
  incusCustomVolumeExists,
  incusCustomVolumeSize,
  incusSizeMatches,
  listCephCatalogServers,
  listContainerVolumes,
  listShareableCephPools,
  liveLabServer,
  nonGpuLabServers,
  pickPreflightReadyWorker,
  registeredCephPool,
  requireSucceededIntent,
  restoreLabServer,
  startContainer,
  stopContainer,
  waitForCephCatalogGone,
  waitForDetachOracle,
  waitForIncusVolumeSize,
  waitForSharedResizeIntents,
  waitForIntent,
  withBlockedIncusHttps,
  withCephPoolsUnregistered,
  type JsonRecord,
} from '../../support/volume-ops.js';

test(
  'never-mounted shared volume is a PG reservation: no catalog, resize 200, delete PG-only',
  { ...coverageCase('shared-cephfs-never-mounted', 'shared-cephfs-never-mounted-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const cephServers = await listCephCatalogServers(adminApi, seedState);
    expect(cephServers.length).toBeGreaterThan(0);

    let volumeId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-never-${Date.now().toString(36)}`,
        64 * 1024 * 1024,
      );
      const created = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(created.dirEnsured).toBe(false);
      expect(created.lifecyclePhase).toBe('active');
      expect(created.poolId).toBeUndefined();
      const incusName = created.incusName as string;
      await assertNoCephCatalog(incusName, cephServers);

      const resized = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/shared-volumes/${volumeId}`, {
          data: {
            expectedRevision: created.generation,
            sizeBytes: 96 * 1024 * 1024,
          },
        }),
        200,
      );
      expect(resized.intentId).toBeUndefined();
      expect(Number(resized.sizeBytes)).toBe(96 * 1024 * 1024);
      expect(resized.dirEnsured).toBe(false);
      await assertNoCephCatalog(incusName, cephServers);

      const deleted = await adminApi.delete(`/api/admin/shared-volumes/${volumeId}`);
      expect([200, 202, 204]).toContain(deleted.status());
      if (deleted.status() === 202) {
        const body = await expectJson<JsonRecord>(deleted, 202);
        if (typeof body.intentId === 'string') await waitForIntent(adminApi, body.intentId);
      }
      expect((await adminApi.get(`/api/admin/shared-volumes/${volumeId}`)).status()).toBe(404);
      volumeId = undefined;
      await assertNoCephCatalog(incusName, cephServers);
    } finally {
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'running detach of attached requires stop; attaching without catalog can cancel online',
  { ...coverageCase('shared-cephfs-detach-requires-stop', 'shared-cephfs-detach-requires-stop-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
    let volumeId: string | undefined;
    let cancelVolumeId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-f2-${Date.now().toString(36)}`,
      );
      containerId = await createRunningContainer(adminApi, seedState, 'e2e-f2');
      const attached = await attachVolume(
        adminApi,
        containerId,
        volumeId,
        '/mnt/shared',
        'shared',
      );
      expect(attached.bindState).toBe('attached');
      expect(attached.onlineCancelAllowed).toBe(false);
      const marker = `f2-${seedState.runId}`;
      await execInContainer(
        adminApi,
        containerId,
        `printf '%s\\n' '${marker}' > /mnt/shared/marker && cat /mnt/shared/marker`,
      );
      const volume = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const incusName = volume.incusName as string;
      expect(await incusCustomVolumeExists(String(primaryPool.incusName), incusName)).toBe(true);

      await expectDetachRequiresStop(adminApi, containerId, attached.attachmentId, 'shared');
      expect(await execInContainer(adminApi, containerId, 'cat /mnt/shared/marker'))
        .toContain(marker);
      const stillAttached = await listContainerVolumes(adminApi, containerId, 'shared');
      const attachedRow = stillAttached.find((entry) => entry.id === attached.attachmentId);
      expect(attachedRow?.bindState).toBe('attached');
      expect(attachedRow?.onlineCancelAllowed).toBe(false);
      expect(await incusCustomExists(primaryPool, incusName)).toBe(true);

      cancelVolumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-f2c-${Date.now().toString(36)}`,
      );
      const cancelVolume = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${cancelVolumeId}`),
      );
      const cancelIncusName = cancelVolume.incusName as string;
      const attaching = await expectJson<JsonRecord>(
        await adminApi.post(`/api/admin/containers/${containerId}/shared-volumes`, {
          data: { volumeId: cancelVolumeId, containerPath: '/mnt/cancel', readOnly: false },
        }),
        202,
      );
      const oracle = await waitForDetachOracle(
        adminApi,
        containerId,
        cancelVolumeId,
        String(primaryPool.incusName),
        cancelIncusName,
      );
      if (oracle.onlineCancel) {
        const cancelled = await expectJson<JsonRecord>(
          await adminApi.delete(
            `/api/admin/containers/${containerId}/shared-volumes/${oracle.row.id}`,
          ),
          202,
        );
        await requireSucceededIntent(adminApi, cancelled.intentId, 'f2 online cancel');
        await waitForIntent(adminApi, attaching.intentId);
      } else {
        const blocked = await adminApi.delete(
          `/api/admin/containers/${containerId}/shared-volumes/${oracle.row.id}`,
        );
        expect(blocked.status()).toBe(409);
        expect(conflictCode(await blocked.json())).toBe('VOLUME_DETACH_REQUIRES_STOP');
        await waitForIntent(adminApi, attaching.intentId);
        await stopContainer(adminApi, containerId);
        await detachVolume(adminApi, containerId, oracle.row.id as string, 'shared');
        await startContainer(adminApi, containerId);
      }

      await stopContainer(adminApi, containerId);
      await detachVolume(adminApi, containerId, attached.attachmentId, 'shared');
      expect(await incusCustomExists(primaryPool, incusName)).toBe(true);
    } finally {
      await deleteContainer(adminApi, containerId);
      await deleteVolume(adminApi, cancelVolumeId);
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'shared volume legal ops: adopt, grow, unbind keeps catalog, rebind reads, then destroy',
  { ...coverageCase('shared-cephfs-legal-ops', 'shared-cephfs-legal-ops-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const workers = nonGpuLabServers(seedState);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    const worker = workers[0]!;
    const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
    const workerPool = await registeredCephPool(adminApi, seedState, worker.id);
    const cephServers = await listCephCatalogServers(adminApi, seedState);

    let volumeId: string | undefined;
    let primaryContainer: string | undefined;
    let workerContainer: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-legal-${Date.now().toString(36)}`,
      );
      const created = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(created.dirEnsured).toBe(false);
      const incusName = created.incusName as string;
      await assertNoCephCatalog(incusName, cephServers);

      primaryContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-legal-a',
        seedState.server.id,
      );
      await attachVolume(adminApi, primaryContainer, volumeId, '/mnt/shared', 'shared');
      expect(await incusCustomExists(primaryPool, incusName)).toBe(true);
      const afterAttach = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(afterAttach.dirEnsured).toBe(true);

      const occupancyAttached = await adminApi.delete(`/api/admin/shared-volumes/${volumeId}`);
      expect(occupancyAttached.status()).toBe(409);
      expect(conflictCode(await occupancyAttached.json())).toMatch(/VOLUME_REQUIRES_UNBIND/);

      const marker = `legal-${seedState.runId}`;
      await execInContainer(
        adminApi,
        primaryContainer,
        `printf '%s\\n' '${marker}' > /mnt/shared/marker && cat /mnt/shared/marker`,
      );

      workerContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-legal-b',
        worker.id,
      );
      await attachVolume(adminApi, workerContainer, volumeId, '/mnt/shared', 'shared');
      expect(await incusCustomExists(workerPool, incusName, worker.ssh)).toBe(true);
      const fromWorker = await execInContainer(
        adminApi,
        workerContainer,
        'cat /mnt/shared/marker',
        worker.ssh,
      );
      expect(fromWorker).toContain(marker);

      const beforeGrow = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const grown = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/shared-volumes/${volumeId}`, {
          data: {
            expectedRevision: beforeGrow.generation,
            sizeBytes: 96 * 1024 * 1024,
          },
        }),
        202,
      );
      await requireSucceededIntent(adminApi, grown.intentId, 'shared volume.grow');
      const afterGrow = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(Number(afterGrow.sizeBytes)).toBe(96 * 1024 * 1024);

      await expectDetachRequiresStop(
        adminApi,
        workerContainer,
        (await listContainerVolumes(adminApi, workerContainer, 'shared'))
          .find((entry) => entry.volumeId === volumeId)!.id as string,
        'shared',
      );

      await stopContainer(adminApi, workerContainer);
      const workerAttachments = await listContainerVolumes(adminApi, workerContainer, 'shared');
      const workerAttachment = workerAttachments.find((entry) => entry.volumeId === volumeId);
      expect(workerAttachment?.id).toBeTruthy();
      const detaching = await expectJson<JsonRecord>(
        await adminApi.delete(
          `/api/admin/containers/${workerContainer}/shared-volumes/${workerAttachment!.id}`,
        ),
        202,
      );
      await expectStartBusyWhileDetaching(adminApi, workerContainer);
      await requireSucceededIntent(adminApi, detaching.intentId, 'legal-ops detach B');
      expect(await incusCustomExists(workerPool, incusName, worker.ssh)).toBe(true);
      expect(await execInContainer(adminApi, primaryContainer, 'cat /mnt/shared/marker'))
        .toContain(marker);

      await startContainer(adminApi, workerContainer);
      await attachVolume(adminApi, workerContainer, volumeId, '/mnt/shared', 'shared');
      expect(await execInContainer(
        adminApi,
        workerContainer,
        'cat /mnt/shared/marker',
        worker.ssh,
      )).toContain(marker);

      await stopContainer(adminApi, primaryContainer);
      await stopContainer(adminApi, workerContainer);
      await deleteContainer(adminApi, primaryContainer);
      primaryContainer = undefined;
      await deleteContainer(adminApi, workerContainer);
      workerContainer = undefined;
      await deleteVolume(adminApi, volumeId);
      volumeId = undefined;
      await waitForCephCatalogGone(incusName, [
        { id: seedState.server.id, poolName: String(primaryPool.incusName) },
        { id: worker.id, ssh: worker.ssh, poolName: String(workerPool.incusName) },
      ]);
    } finally {
      await deleteContainer(adminApi, primaryContainer);
      await deleteContainer(adminApi, workerContainer);
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'shared volume concurrency: parallel attach/detach, double delete, duplicate path',
  { ...coverageCase('shared-cephfs-concurrency', 'shared-cephfs-concurrency-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const workers = nonGpuLabServers(seedState);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    const worker = workers[0]!;

    let volumeId: string | undefined;
    let primaryContainer: string | undefined;
    let workerContainer: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-conc-${Date.now().toString(36)}`,
      );
      primaryContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-conc-a',
        seedState.server.id,
      );
      workerContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-conc-b',
        worker.id,
      );

      const [attachA, attachB] = await Promise.all([
        adminApi.post(`/api/admin/containers/${primaryContainer}/shared-volumes`, {
          data: { volumeId, containerPath: '/mnt/shared', readOnly: false },
        }),
        adminApi.post(`/api/admin/containers/${workerContainer}/shared-volumes`, {
          data: { volumeId, containerPath: '/mnt/shared', readOnly: false },
        }),
      ]);
      expect(attachA.status()).toBe(202);
      expect(attachB.status()).toBe(202);
      const acceptedA = await expectJson<JsonRecord>(attachA, 202);
      const acceptedB = await expectJson<JsonRecord>(attachB, 202);
      await requireSucceededIntent(adminApi, acceptedA.intentId, 'concurrent attach A');
      await requireSucceededIntent(adminApi, acceptedB.intentId, 'concurrent attach B');

      const dup = await adminApi.post(`/api/admin/containers/${primaryContainer}/shared-volumes`, {
        data: { volumeId, containerPath: '/mnt/shared', readOnly: false },
      });
      expect(dup.status()).toBe(409);
      expect(conflictCode(await dup.json())).toMatch(/INVALID_INPUT|already attached|path is in use/i);

      const [deleteWhileMountedA, deleteWhileMountedB] = await Promise.all([
        adminApi.delete(`/api/admin/shared-volumes/${volumeId}`),
        adminApi.delete(`/api/admin/shared-volumes/${volumeId}`),
      ]);
      expect(deleteWhileMountedA.status()).toBe(409);
      expect(deleteWhileMountedB.status()).toBe(409);
      expect(conflictCode(await deleteWhileMountedA.json())).toMatch(/VOLUME_REQUIRES_UNBIND/);
      expect(conflictCode(await deleteWhileMountedB.json())).toMatch(/VOLUME_REQUIRES_UNBIND/);

      await stopContainer(adminApi, primaryContainer);
      await stopContainer(adminApi, workerContainer);
      const attachmentsA = await listContainerVolumes(adminApi, primaryContainer, 'shared');
      const attachmentsB = await listContainerVolumes(adminApi, workerContainer, 'shared');
      const idA = attachmentsA.find((entry) => entry.volumeId === volumeId)?.id as string;
      const idB = attachmentsB.find((entry) => entry.volumeId === volumeId)?.id as string;
      expect(idA && idB).toBeTruthy();

      const [detachA, detachB] = await Promise.all([
        adminApi.delete(`/api/admin/containers/${primaryContainer}/shared-volumes/${idA}`),
        adminApi.delete(`/api/admin/containers/${workerContainer}/shared-volumes/${idB}`),
      ]);
      expect(detachA.status()).toBe(202);
      expect(detachB.status()).toBe(202);
      await requireSucceededIntent(
        adminApi,
        (await expectJson<JsonRecord>(detachA, 202)).intentId,
        'concurrent detach A',
      );
      await requireSucceededIntent(
        adminApi,
        (await expectJson<JsonRecord>(detachB, 202)).intentId,
        'concurrent detach B',
      );

      const [firstDelete, secondDelete] = await Promise.all([
        adminApi.delete(`/api/admin/shared-volumes/${volumeId}`),
        adminApi.delete(`/api/admin/shared-volumes/${volumeId}`),
      ]);
      const deleteStatuses = [firstDelete.status(), secondDelete.status()].sort();
      expect(deleteStatuses[0]).toBe(202);
      expect([202, 409, 404]).toContain(deleteStatuses[1]);
      const winner = firstDelete.status() === 202 ? firstDelete : secondDelete;
      if (winner.status() === 202) {
        const body = await expectJson<JsonRecord>(winner, 202);
        await waitForIntent(adminApi, body.intentId);
      }
      await eventually(
        async () => adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
        (response) => response.status() === 404,
        180_000,
        500,
        'shared volume gone after concurrent delete',
      );
      volumeId = undefined;
    } finally {
      await deleteContainer(adminApi, primaryContainer);
      await deleteContainer(adminApi, workerContainer);
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'in-flight attach then detach still gates delete until the device is gone',
  { ...coverageCase('shared-cephfs-inflight-unbind', 'shared-cephfs-inflight-unbind-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    let volumeId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-inflight-${Date.now().toString(36)}`,
      );
      const volume = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const incusName = volume.incusName as string;
      const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
      containerId = await createRunningContainer(adminApi, seedState, 'e2e-inflight');
      const attaching = await expectJson<JsonRecord>(
        await adminApi.post(`/api/admin/containers/${containerId}/shared-volumes`, {
          data: { volumeId, containerPath: '/mnt/shared', readOnly: false },
        }),
        202,
      );
      const oracle = await waitForDetachOracle(
        adminApi,
        containerId,
        volumeId,
        String(primaryPool.incusName),
        incusName,
      );
      expect(['attaching', 'attached']).toContain(oracle.row.bindState);

      const blocked = await adminApi.delete(`/api/admin/shared-volumes/${volumeId}`);
      expect(blocked.status()).toBe(409);
      expect(conflictCode(await blocked.json())).toMatch(/VOLUME_REQUIRES_UNBIND/);

      const cancel = await adminApi.delete(
        `/api/admin/containers/${containerId}/shared-volumes/${oracle.row.id}`,
      );
      if (oracle.onlineCancel) {
        const detaching = await expectJson<JsonRecord>(cancel, 202);
        const mid = await listContainerVolumes(adminApi, containerId, 'shared');
        const midRow = mid.find((entry) => entry.id === oracle.row.id);
        if (midRow) expect(midRow.bindState).toBe('detaching');
        const stillBlocked = await adminApi.delete(`/api/admin/shared-volumes/${volumeId}`);
        expect(stillBlocked.status()).toBe(409);
        expect(conflictCode(await stillBlocked.json())).toMatch(/VOLUME_REQUIRES_UNBIND/);
        await requireSucceededIntent(adminApi, detaching.intentId, 'inflight online cancel');
      } else {
        expect(cancel.status()).toBe(409);
        expect(conflictCode(await cancel.json())).toBe('VOLUME_DETACH_REQUIRES_STOP');
        await waitForIntent(adminApi, attaching.intentId);
        await stopContainer(adminApi, containerId);
        const afterStop = await listContainerVolumes(adminApi, containerId, 'shared');
        const still = afterStop.find((entry) => entry.volumeId === volumeId);
        expect(still?.id).toBeTruthy();
        expect(still?.onlineCancelAllowed).toBe(false);
        const detaching = await expectJson<JsonRecord>(
          await adminApi.delete(
            `/api/admin/containers/${containerId}/shared-volumes/${still!.id}`,
          ),
          202,
        );
        const mid = await listContainerVolumes(adminApi, containerId, 'shared');
        const midRow = mid.find((entry) => entry.id === still!.id);
        if (midRow) expect(midRow.bindState).toBe('detaching');
        const stillBlocked = await adminApi.delete(`/api/admin/shared-volumes/${volumeId}`);
        expect(stillBlocked.status()).toBe(409);
        expect(conflictCode(await stillBlocked.json())).toMatch(/VOLUME_REQUIRES_UNBIND/);
        await expectStartBusyWhileDetaching(adminApi, containerId);
        await requireSucceededIntent(adminApi, detaching.intentId, 'inflight stop-then-detach');
      }
      await waitForIntent(adminApi, attaching.intentId);
      await deleteContainer(adminApi, containerId);
      containerId = undefined;
      await deleteVolume(adminApi, volumeId);
      volumeId = undefined;
    } finally {
      await deleteContainer(adminApi, containerId);
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'scan does not invent catalogs on an unadopted peer and that peer does not block destroy',
  { ...coverageCase('shared-cephfs-scan-no-spread', 'shared-cephfs-scan-no-spread-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const workers = nonGpuLabServers(seedState);
    expect(workers.length).toBeGreaterThanOrEqual(2);
    const idle = await liveLabServer(adminApi, seedState, workers[1]!);
    const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
    const idlePool = await registeredCephPool(adminApi, seedState, idle.id);

    let volumeId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-scan-${Date.now().toString(36)}`,
      );
      const volume = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const incusName = volume.incusName as string;
      expect(volume.dirEnsured).toBe(false);
      expect(await incusCustomExists(primaryPool, incusName)).toBe(false);
      expect(await incusCustomExists(idlePool, incusName, idle.ssh)).toBe(false);

      containerId = await createRunningContainer(adminApi, seedState, 'e2e-scan');
      await attachVolume(adminApi, containerId, volumeId, '/mnt/shared', 'shared');
      const afterAttach = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(afterAttach.dirEnsured).toBe(true);
      expect(await incusCustomExists(primaryPool, incusName)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 70_000));
      expect(await incusCustomExists(idlePool, incusName, idle.ssh)).toBe(false);

      await stopContainer(adminApi, containerId);
      const attachments = await listContainerVolumes(adminApi, containerId, 'shared');
      const attachment = attachments.find((entry) => entry.volumeId === volumeId);
      if (attachment?.id) {
        await detachVolume(adminApi, containerId, attachment.id as string, 'shared');
      }
      await deleteContainer(adminApi, containerId);
      containerId = undefined;
      await deleteVolume(adminApi, volumeId);
      volumeId = undefined;
      expect(await incusCustomExists(idlePool, incusName, idle.ssh)).toBe(false);
    } finally {
      await deleteContainer(adminApi, containerId);
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'an unreachable catalog server does not block destroy while another eligible node is online',
  { ...coverageCase('shared-cephfs-offline-delete', 'shared-cephfs-offline-delete-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const workers = nonGpuLabServers(seedState);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    const worker = workers[0]!;
    const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
    const workerPool = await registeredCephPool(adminApi, seedState, worker.id);

    let volumeId: string | undefined;
    let dummyVolumeId: string | undefined;
    let dummyIntentId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-off-${Date.now().toString(36)}`,
      );
      const volume = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const incusName = volume.incusName as string;
      containerId = await createRunningContainer(adminApi, seedState, 'e2e-off', worker.id);
      const attached = await attachVolume(
        adminApi,
        containerId,
        volumeId,
        '/mnt/shared',
        'shared',
      );
      await stopContainer(adminApi, containerId);
      await detachVolume(adminApi, containerId, attached.attachmentId, 'shared');
      expect(await incusCustomExists(workerPool, incusName, worker.ssh)).toBe(true);

      const primaryBefore = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
      );
      expect(primaryBefore.status).toBe('online');

      await withBlockedIncusHttps(worker.endpoint, async () => {
        const dummy = await createLocalVolumeOnServer(
          adminApi,
          seedState,
          worker.id,
          worker.dirPoolId,
          `e2e-off-dummy-${Date.now().toString(36)}`,
        );
        dummyVolumeId = dummy.volumeId;
        dummyIntentId = dummy.intentId;
        const unreachable = await eventually(
          async () => expectJson<JsonRecord>(
            await adminApi.get(`/api/admin/servers/${worker.id}`),
          ),
          (server) => server.status === 'unreachable',
          90_000,
          1_000,
          `worker ${worker.id} marked unreachable`,
        );
        expect(unreachable.status).toBe('unreachable');
        const stillPrimary = await expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
        );
        expect(stillPrimary.status).toBe('online');
        const deleted = await expectJson<JsonRecord>(
          await adminApi.delete(`/api/admin/shared-volumes/${volumeId}`),
          202,
        );
        await waitForIntent(adminApi, deleted.intentId);
      });

      if (dummyIntentId) await waitForIntent(adminApi, dummyIntentId);
      const recovered = await eventually(
        async () => expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/servers/${worker.id}`),
        ),
        (server) => server.status === 'online',
        90_000,
        1_000,
        `worker ${worker.id} recovered online`,
      ).catch(async () => {
        const kick = await createLocalVolumeOnServer(
          adminApi,
          seedState,
          worker.id,
          worker.dirPoolId,
          `e2e-off-kick-${Date.now().toString(36)}`,
        );
        await requireSucceededIntent(adminApi, kick.intentId, 'offline recovery kick');
        await deleteVolume(adminApi, kick.volumeId);
        return expectJson<JsonRecord>(await adminApi.get(`/api/admin/servers/${worker.id}`));
      });
      expect(recovered.status).toBe('online');
      await eventually(
        async () => adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
        (response) => response.status() === 404,
        180_000,
        500,
        'shared volume gone after eligible-node destroy',
      );
      volumeId = undefined;
      await waitForCephCatalogGone(incusName, [
        { id: seedState.server.id, poolName: String(primaryPool.incusName) },
        { id: worker.id, ssh: worker.ssh, poolName: String(workerPool.incusName) },
      ]);
    } finally {
      await deleteContainer(adminApi, containerId);
      await deleteVolume(adminApi, dummyVolumeId);
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'control-plane server delete keeps peer shared volumes and drops volumes only catalogued there',
  { ...coverageCase('shared-cephfs-server-cascade', 'shared-cephfs-server-cascade-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const workers = nonGpuLabServers(seedState);
    expect(workers.length).toBeGreaterThanOrEqual(2);
    const cascade = await pickPreflightReadyWorker(adminApi, seedState);
    const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
    const cascadePool = await registeredCephPool(adminApi, seedState, cascade.id);

    let remainId: string | undefined;
    let onlyCascadeId: string | undefined;
    let neverMountedId: string | undefined;
    let containerId: string | undefined;
    let remainName: string | undefined;
    let onlyName: string | undefined;
    let serverDeleted = false;
    const probe = `cascade-${seedState.runId}`;
    try {
      remainId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-keep-${Date.now().toString(36)}`,
      );
      remainName = (await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${remainId}`),
      )).incusName as string;
      onlyCascadeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-drop-${Date.now().toString(36)}`,
      );
      onlyName = (await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${onlyCascadeId}`),
      )).incusName as string;
      neverMountedId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-nm-${Date.now().toString(36)}`,
      );

      const primaryContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-casc-p',
        seedState.server.id,
      );
      const primaryAttached = await attachVolume(
        adminApi,
        primaryContainer,
        remainId,
        '/mnt/shared',
        'shared',
      );
      await execInContainer(
        adminApi,
        primaryContainer,
        `printf '%s\\n' '${probe}' > /mnt/shared/marker && cat /mnt/shared/marker`,
      );
      await stopContainer(adminApi, primaryContainer);
      await detachVolume(adminApi, primaryContainer, primaryAttached.attachmentId, 'shared');
      await deleteContainer(adminApi, primaryContainer);

      containerId = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-casc',
        cascade.id,
      );
      const attached = await attachVolume(
        adminApi,
        containerId,
        remainId,
        '/mnt/shared',
        'shared',
      );
      await stopContainer(adminApi, containerId);
      await detachVolume(adminApi, containerId, attached.attachmentId, 'shared');
      await startContainer(adminApi, containerId);
      const cascadeOnly = await attachVolume(
        adminApi,
        containerId,
        onlyCascadeId,
        '/mnt/drop',
        'shared',
      );
      await stopContainer(adminApi, containerId);
      await detachVolume(adminApi, containerId, cascadeOnly.attachmentId, 'shared');
      await deleteContainer(adminApi, containerId);
      containerId = undefined;

      const before = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/servers/${cascade.id}`),
      );
      const deleted = await adminApi.delete(
        `/api/admin/servers/${cascade.id}?expectedRevision=${before.revision}`,
      );
      expect([200, 204]).toContain(deleted.status());
      serverDeleted = true;
      expect((await adminApi.get(`/api/admin/servers/${cascade.id}`)).status()).toBe(404);

      expect((await adminApi.get(`/api/admin/shared-volumes/${onlyCascadeId}`)).status()).toBe(404);
      onlyCascadeId = undefined;
      const remaining = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${remainId}`),
      );
      expect(remaining.id).toBe(remainId);
      expect(await incusCustomExists(primaryPool, remainName)).toBe(true);
      expect(await incusCustomExists(cascadePool, onlyName!, cascade.ssh)).toBe(true);
      const neverMounted = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${neverMountedId}`),
      );
      expect(neverMounted.id).toBe(neverMountedId);
      expect(neverMounted.dirEnsured).toBe(false);

      const reread = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-casc-r',
        seedState.server.id,
      );
      containerId = reread;
      await attachVolume(adminApi, reread, remainId, '/mnt/shared', 'shared');
      expect(await execInContainer(adminApi, reread, 'cat /mnt/shared/marker')).toContain(probe);
      await stopContainer(adminApi, reread);
      const rereadAttachments = await listContainerVolumes(adminApi, reread, 'shared');
      const rereadAttachment = rereadAttachments.find((entry) => entry.volumeId === remainId);
      if (rereadAttachment?.id) {
        await detachVolume(adminApi, reread, rereadAttachment.id as string, 'shared');
      }
      await deleteContainer(adminApi, reread);
      containerId = undefined;

      await deleteVolume(adminApi, remainId);
      remainId = undefined;
      await deleteVolume(adminApi, neverMountedId);
      neverMountedId = undefined;
    } finally {
      await deleteContainer(adminApi, containerId);
      await deleteVolume(adminApi, remainId);
      await deleteVolume(adminApi, onlyCascadeId);
      await deleteVolume(adminApi, neverMountedId);
      if (serverDeleted) {
        if (remainName) {
          await deleteIncusCustomVolume(String(cascadePool.incusName), remainName, cascade.ssh);
        }
        if (onlyName) {
          await deleteIncusCustomVolume(String(cascadePool.incusName), onlyName, cascade.ssh);
        }
        const restoredId = await restoreLabServer(adminApi, seedState, cascade);
        await eventually(
          async () => expectJson<JsonRecord>(
            await adminApi.get(`/api/admin/servers/${restoredId}`),
          ),
          (row) => row.status === 'online',
          90_000,
          1_000,
          `cascade worker ${cascade.name} online after restore`,
        );
      }
    }
  },
);

test(
  'shared volume shrink below observed usage is rejected',
  { ...coverageCase('shared-volume-shrink-below-usage', 'shared-volume-shrink-below-usage-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    test.setTimeout(360_000);
    const quotaBytes = 64 * 1024 * 1024;
    const fillBytes = 16 * 1024 * 1024;
    let volumeId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-sshrink-${Date.now().toString(36)}`,
        quotaBytes,
      );
      containerId = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-sshrink',
        seedState.server.id,
      );
      await attachVolume(adminApi, containerId, volumeId, '/mnt/shared', 'shared');
      await execInContainer(
        adminApi,
        containerId,
        `dd if=/dev/zero of=/mnt/shared/fill bs=${fillBytes} count=1 conv=fsync oflag=sync`,
      );
      let observed = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      try {
        observed = await eventually(
          async () => expectJson<JsonRecord>(
            await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
          ),
          (volume) => typeof volume.usedBytes === 'number' && volume.usedBytes >= fillBytes * 0.5,
          20_000,
          1_000,
          'shared volume usedBytes after guest write',
        );
      } catch {
        observed = await expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
        );
      }
      const used = Number(observed.usedBytes);
      const canAssertFloor = Number.isFinite(used) && used >= fillBytes * 0.5;
      const tooSmall = await adminApi.patch(`/api/admin/shared-volumes/${volumeId}`, {
        data: {
          expectedRevision: observed.generation,
          sizeBytes: canAssertFloor
            ? Math.max(1024 * 1024, Math.floor(used / 2))
            : 8 * 1024 * 1024,
        },
      });
      if (canAssertFloor || tooSmall.status() !== 202) {
        expect(tooSmall.status()).toBe(409);
        expect(JSON.stringify(await tooSmall.json())).toMatch(
          /VOLUME_SHRINK_BELOW_USAGE|VOLUME_USAGE_UNKNOWN/,
        );
        const after = await expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
        );
        expect(Number(after.sizeBytes)).toBe(quotaBytes);
      } else {
        const accepted = await expectJson<JsonRecord>(tooSmall, 202);
        await requireSucceededIntent(adminApi, accepted.intentId, 'shared volume shrink while occupancy unobserved');
      }
    } finally {
      if (containerId) {
        await stopContainer(adminApi, containerId).catch(() => undefined);
        const attachments = await listContainerVolumes(adminApi, containerId, 'shared');
        for (const row of attachments) {
          await detachVolume(adminApi, containerId, row.id as string, 'shared').catch(() => undefined);
        }
        await deleteContainer(adminApi, containerId);
      }
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'CephFS size quota stops a guest write and bounds concurrent writers on two servers',
  { ...coverageCase('shared-cephfs-quota-enforcement', 'shared-cephfs-quota-enforcement-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const quotaBytes = 16 * 1024 * 1024;
    const workers = nonGpuLabServers(seedState);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    const worker = await liveLabServer(adminApi, seedState, workers[0]!);
    const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
    expect(primaryPool.incusName).toBeTruthy();

    let volumeId: string | undefined;
    let primaryContainer: string | undefined;
    let workerContainer: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-quota-${Date.now().toString(36)}`,
        quotaBytes,
      );
      primaryContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-quota-a',
        seedState.server.id,
      );
      await attachVolume(adminApi, primaryContainer, volumeId, '/mnt/shared', 'shared');

      const dfBefore = parseQuotaProbe(await execInContainer(
        adminApi,
        primaryContainer,
        quotaProbeScript('fill-a'),
      ));
      console.log('shared-cephfs-quota single-writer', JSON.stringify(dfBefore));
      expect(dfBefore.exit, JSON.stringify(dfBefore)).not.toBe(0);
      expect(dfBefore.raw, JSON.stringify(dfBefore)).toMatch(/quota exceeded|No space left|ENOSPC/i);
      expect(dfBefore.bytes > 0, JSON.stringify(dfBefore)).toBe(true);
      expect(dfBefore.bytes <= quotaBytes * 1.25, JSON.stringify(dfBefore)).toBe(true);

      workerContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-quota-b',
        worker.id,
      );
      await attachVolume(adminApi, workerContainer, volumeId, '/mnt/shared', 'shared');
      await execInContainer(adminApi, primaryContainer, 'rm -f /mnt/shared/fill-a');

      const [fromA, fromB] = await Promise.all([
        execInContainer(adminApi, primaryContainer, quotaProbeScript('fill-a')),
        execInContainer(adminApi, workerContainer, quotaProbeScript('fill-b'), worker.ssh),
      ]);
      const dualA = parseQuotaProbe(fromA);
      const dualB = parseQuotaProbe(fromB);
      const dual = {
        a: dualA,
        b: dualB,
        totalBytes: dualA.bytes + dualB.bytes,
        quotaBytes,
      };
      console.log('shared-cephfs-quota dual-writer', JSON.stringify(dual));
      expect(dualA.exit === 0 && dualB.exit === 0, JSON.stringify(dual)).toBe(false);
      expect(dual.totalBytes > 0, JSON.stringify(dual)).toBe(true);
      expect(dual.totalBytes <= quotaBytes * 1.5, JSON.stringify(dual)).toBe(true);
    } finally {
      if (workerContainer) {
        await stopContainer(adminApi, workerContainer).catch(() => undefined);
        const attachments = await listContainerVolumes(adminApi, workerContainer, 'shared');
        for (const row of attachments) {
          await detachVolume(adminApi, workerContainer, row.id as string, 'shared').catch(() => undefined);
        }
        await deleteContainer(adminApi, workerContainer);
      }
      if (primaryContainer) {
        await stopContainer(adminApi, primaryContainer).catch(() => undefined);
        const attachments = await listContainerVolumes(adminApi, primaryContainer, 'shared');
        for (const row of attachments) {
          await detachVolume(adminApi, primaryContainer, row.id as string, 'shared').catch(() => undefined);
        }
        await deleteContainer(adminApi, primaryContainer);
      }
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'shared resize updates every sticky catalog, including after unbind and after a peer outage',
  { ...coverageCase('shared-cephfs-resize-catalog-sync', 'shared-cephfs-resize-catalog-sync-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const workers = nonGpuLabServers(seedState);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    const worker = await liveLabServer(adminApi, seedState, workers[0]!);
    const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
    const workerPool = await registeredCephPool(adminApi, seedState, worker.id);
    const primaryName = String(primaryPool.incusName);
    const workerName = String(workerPool.incusName);

    let volumeId: string | undefined;
    let primaryContainer: string | undefined;
    let workerContainer: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-rsync-${Date.now().toString(36)}`,
        64 * 1024 * 1024,
      );
      const created = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const incusName = created.incusName as string;

      primaryContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-rsync-a',
        seedState.server.id,
      );
      workerContainer = await createRunningContainer(
        adminApi,
        seedState,
        'e2e-rsync-b',
        worker.id,
      );
      await attachVolume(adminApi, primaryContainer, volumeId, '/mnt/shared', 'shared');
      await attachVolume(adminApi, workerContainer, volumeId, '/mnt/shared', 'shared');
      await execInContainer(
        adminApi,
        primaryContainer,
        `printf 'rsync\\n' > /mnt/shared/keep && cat /mnt/shared/keep`,
      );

      const beforeGrow = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const growBoth = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/shared-volumes/${volumeId}`, {
          data: { expectedRevision: beforeGrow.generation, sizeBytes: 96 * 1024 * 1024 },
        }),
        202,
      );
      await requireSucceededIntent(adminApi, growBoth.intentId, 'resize both catalogs 96MiB');
      await waitForSharedResizeIntents(adminApi, volumeId);
      const grownPrimary = await waitForIncusVolumeSize(primaryName, incusName, 96 * 1024 * 1024);
      const grownWorker = await waitForIncusVolumeSize(
        workerName,
        incusName,
        96 * 1024 * 1024,
        worker.ssh,
      );
      expect(incusSizeMatches(grownPrimary, 96 * 1024 * 1024)).toBe(true);
      expect(incusSizeMatches(grownWorker, 96 * 1024 * 1024)).toBe(true);

      await stopContainer(adminApi, workerContainer);
      const workerAttachment = (await listContainerVolumes(adminApi, workerContainer, 'shared'))
        .find((entry) => entry.volumeId === volumeId);
      expect(workerAttachment?.id).toBeTruthy();
      await detachVolume(adminApi, workerContainer, workerAttachment!.id as string, 'shared');
      expect(await incusCustomVolumeExists(workerName, incusName, worker.ssh)).toBe(true);

      const afterUnbind = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const growSticky = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/shared-volumes/${volumeId}`, {
          data: { expectedRevision: afterUnbind.generation, sizeBytes: 128 * 1024 * 1024 },
        }),
        202,
      );
      await requireSucceededIntent(adminApi, growSticky.intentId, 'resize sticky catalogs 128MiB');
      await waitForSharedResizeIntents(adminApi, volumeId);
      await waitForIncusVolumeSize(primaryName, incusName, 128 * 1024 * 1024);
      await waitForIncusVolumeSize(workerName, incusName, 128 * 1024 * 1024, worker.ssh);

      const afterGrowSticky = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const shrunk = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/shared-volumes/${volumeId}`, {
          data: { expectedRevision: afterGrowSticky.generation, sizeBytes: 80 * 1024 * 1024 },
        }),
        202,
      );
      await requireSucceededIntent(adminApi, shrunk.intentId, 'shrink sticky catalogs 80MiB');
      await waitForSharedResizeIntents(adminApi, volumeId);
      await waitForIncusVolumeSize(primaryName, incusName, 80 * 1024 * 1024);
      await waitForIncusVolumeSize(workerName, incusName, 80 * 1024 * 1024, worker.ssh);
      expect(await execInContainer(adminApi, primaryContainer, 'cat /mnt/shared/keep'))
        .toContain('rsync');

      const beforeOutage = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      await withBlockedIncusHttps(worker.endpoint, async () => {
        const grownOffline = await adminApi.patch(`/api/admin/shared-volumes/${volumeId}`, {
          data: { expectedRevision: beforeOutage.generation, sizeBytes: 112 * 1024 * 1024 },
        });
        expect(grownOffline.status()).toBe(202);
        await waitForIncusVolumeSize(primaryName, incusName, 112 * 1024 * 1024);
        const workerDuringOutage = await incusCustomVolumeSize(workerName, incusName, worker.ssh);
        expect(incusSizeMatches(workerDuringOutage, 80 * 1024 * 1024)).toBe(true);
      });
      await waitForIncusVolumeSize(workerName, incusName, 112 * 1024 * 1024, worker.ssh, 180_000);
    } finally {
      if (workerContainer) {
        await stopContainer(adminApi, workerContainer).catch(() => undefined);
        const attachments = await listContainerVolumes(adminApi, workerContainer, 'shared');
        for (const row of attachments) {
          await detachVolume(adminApi, workerContainer, row.id as string, 'shared').catch(() => undefined);
        }
        await deleteContainer(adminApi, workerContainer);
      }
      if (primaryContainer) {
        await stopContainer(adminApi, primaryContainer).catch(() => undefined);
        const attachments = await listContainerVolumes(adminApi, primaryContainer, 'shared');
        for (const row of attachments) {
          await detachVolume(adminApi, primaryContainer, row.id as string, 'shared').catch(() => undefined);
        }
        await deleteContainer(adminApi, primaryContainer);
      }
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'never-mounted resize is applied on first attach catalog size',
  { ...coverageCase('shared-cephfs-resize-then-attach', 'shared-cephfs-resize-then-attach-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
    let volumeId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-rsz-${Date.now().toString(36)}`,
        64 * 1024 * 1024,
      );
      const created = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      const resized = await expectJson<JsonRecord>(
        await adminApi.patch(`/api/admin/shared-volumes/${volumeId}`, {
          data: { expectedRevision: created.generation, sizeBytes: 96 * 1024 * 1024 },
        }),
        200,
      );
      expect(Number(resized.sizeBytes)).toBe(96 * 1024 * 1024);
      expect(resized.dirEnsured).toBe(false);

      containerId = await createRunningContainer(adminApi, seedState, 'e2e-rsz');
      await attachVolume(adminApi, containerId, volumeId, '/mnt/shared', 'shared');
      const size = await incusCustomVolumeSize(
        String(primaryPool.incusName),
        created.incusName as string,
      );
      expect(size.toLowerCase()).toMatch(/96\s*mib|100663296|96mib/);
      const after = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(after.dirEnsured).toBe(true);
      expect(Number(after.sizeBytes)).toBe(96 * 1024 * 1024);
    } finally {
      if (containerId) {
        await stopContainer(adminApi, containerId).catch(() => undefined);
        const attachments = await listContainerVolumes(adminApi, containerId, 'shared');
        for (const row of attachments) {
          await detachVolume(adminApi, containerId, row.id as string, 'shared').catch(() => undefined);
        }
        await deleteContainer(adminApi, containerId);
      }
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'container.create volumes[] mkdirs the shared catalog on first boot',
  { ...coverageCase('shared-cephfs-create-with-disks', 'shared-cephfs-create-with-disks-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const primaryPool = await registeredCephPool(adminApi, seedState, seedState.server.id);
    let volumeId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-born-${Date.now().toString(36)}`,
      );
      const created = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(created.dirEnsured).toBe(false);
      const attachable = await expectJson<JsonRecord[]>(
        await adminApi.get(
          `/api/admin/shared-volumes?attachableOnServerId=${seedState.server.id}`,
        ),
      );
      expect(attachable.some((row) => row.id === volumeId)).toBe(true);

      containerId = await createRunningContainerWithVolumes(
        adminApi,
        seedState,
        'e2e-born',
        [{ volumeId, containerPath: '/mnt/shared', readOnly: false }],
      );
      const marker = `born-${seedState.runId}`;
      await execInContainer(
        adminApi,
        containerId,
        `printf '%s\\n' '${marker}' > /mnt/shared/marker && cat /mnt/shared/marker`,
      );
      expect(await incusCustomVolumeExists(
        String(primaryPool.incusName),
        created.incusName as string,
      )).toBe(true);
      const after = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(after.dirEnsured).toBe(true);
      const attachments = await listContainerVolumes(adminApi, containerId, 'shared');
      expect(attachments.some((row) => row.volumeId === volumeId && row.bindState === 'attached'))
        .toBe(true);
    } finally {
      if (containerId) {
        await stopContainer(adminApi, containerId).catch(() => undefined);
        const attachments = await listContainerVolumes(adminApi, containerId, 'shared');
        for (const row of attachments) {
          await detachVolume(adminApi, containerId, row.id as string, 'shared').catch(() => undefined);
        }
        await deleteContainer(adminApi, containerId);
      }
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'attach is denied when the container server has no registered CephFS for the backend',
  { ...coverageCase('shared-cephfs-cross-server-denied', 'shared-cephfs-cross-server-denied-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const worker = nonGpuLabServers(seedState)[0];
    expect(worker, 'need a worker to unregister CephFS on').toBeTruthy();
    const live = await liveLabServer(adminApi, seedState, worker!);
    const workerPools = (await listShareableCephPools(adminApi, seedState))
      .filter((pool) => pool.serverId === live.id && pool.registered === true);
    expect(workerPools.length).toBeGreaterThan(0);

    let volumeId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-xsrv-${Date.now().toString(36)}`,
      );
      containerId = await createRunningContainer(adminApi, seedState, 'e2e-xsrv', live.id);
      await withCephPoolsUnregistered(adminApi, workerPools, async () => {
        const denied = await adminApi.post(
          `/api/admin/containers/${containerId}/shared-volumes`,
          { data: { volumeId, containerPath: '/mnt/shared', readOnly: false } },
        );
        expect(denied.status()).toBe(409);
        expect(conflictCode(await denied.json())).toBe('VOLUME_CROSS_SERVER_DENIED');
      });
    } finally {
      await deleteContainer(adminApi, containerId);
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'delete is VOLUME_DELETE_BACKEND_UNREACHABLE when no online registered CephFS executor remains',
  { ...coverageCase('shared-cephfs-backend-unreachable', 'shared-cephfs-backend-unreachable-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    const worker = nonGpuLabServers(seedState)[0];
    expect(worker).toBeTruthy();
    const live = await liveLabServer(adminApi, seedState, worker!);
    let volumeId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-unreach-${Date.now().toString(36)}`,
      );
      containerId = await createRunningContainer(adminApi, seedState, 'e2e-unreach', live.id);
      const attached = await attachVolume(adminApi, containerId, volumeId, '/mnt/shared', 'shared');
      await stopContainer(adminApi, containerId);
      await detachVolume(adminApi, containerId, attached.attachmentId, 'shared');
      await deleteContainer(adminApi, containerId);
      containerId = undefined;
      const ensured = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(ensured.dirEnsured).toBe(true);

      const pools = await listShareableCephPools(adminApi, seedState);
      expect(pools.some((pool) => pool.registered === true)).toBe(true);
      await withCephPoolsUnregistered(adminApi, pools, async () => {
        const blocked = await adminApi.delete(`/api/admin/shared-volumes/${volumeId}`);
        expect(blocked.status()).toBe(409);
        expect(conflictCode(await blocked.json())).toBe('VOLUME_DELETE_BACKEND_UNREACHABLE');
        const still = await expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
        );
        expect(still.id).toBe(volumeId);
        expect(still.dirEnsured).toBe(true);
      });

      await deleteVolume(adminApi, volumeId);
      volumeId = undefined;
    } finally {
      await deleteContainer(adminApi, containerId);
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'inspect occupancy: in_use while attached, cache after unbind, skip never-seen nodes',
  { ...coverageCase('shared-cephfs-inspect-occupancy', 'shared-cephfs-inspect-occupancy-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    let volumeId: string | undefined;
    let containerId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-insp-${Date.now().toString(36)}`,
      );
      const empty = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}/catalogs`),
      );
      expect(empty.items).toEqual([]);

      containerId = await createRunningContainer(adminApi, seedState, 'e2e-insp');
      await attachVolume(adminApi, containerId, volumeId, '/mnt/shared', 'shared');
      const attachedInspect = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}/catalogs`),
      );
      const inUse = (attachedInspect.items as JsonRecord[])
        .filter((item) => item.occupancy === 'in_use');
      expect(inUse.length).toBe(1);
      expect(inUse[0]?.serverId).toBe(seedState.server.id);
      expect(inUse[0]?.pgCatalogState).toBe('present');
      expect(inUse[0]?.incusPresent).toBe(true);
      expect((attachedInspect.items as JsonRecord[]).every((item) => item.occupancy !== 'skip'))
        .toBe(true);

      await stopContainer(adminApi, containerId);
      const attachments = await listContainerVolumes(adminApi, containerId, 'shared');
      await detachVolume(adminApi, containerId, attachments[0]!.id as string, 'shared');
      const cacheInspect = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}/catalogs`),
      );
      const cache = (cacheInspect.items as JsonRecord[])
        .filter((item) => item.occupancy === 'cache');
      expect(cache.length).toBe(1);
      expect(cache[0]?.serverId).toBe(seedState.server.id);
      expect(cache[0]?.hasAttachment === undefined || cache[0]?.incusPresent === true).toBe(true);
    } finally {
      if (containerId) {
        await stopContainer(adminApi, containerId).catch(() => undefined);
        const attachments = await listContainerVolumes(adminApi, containerId, 'shared');
        for (const row of attachments) {
          await detachVolume(adminApi, containerId, row.id as string, 'shared').catch(() => undefined);
        }
        await deleteContainer(adminApi, containerId);
      }
      await deleteVolume(adminApi, volumeId);
    }
  },
);

test(
  'the same shared volume can attach to two containers on one server',
  { ...coverageCase('shared-cephfs-two-containers-same-server', 'shared-cephfs-two-containers-same-server-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    let volumeId: string | undefined;
    let firstId: string | undefined;
    let secondId: string | undefined;
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-twin-${Date.now().toString(36)}`,
      );
      firstId = await createRunningContainer(adminApi, seedState, 'e2e-twin-a');
      secondId = await createRunningContainer(adminApi, seedState, 'e2e-twin-b');
      await attachVolume(adminApi, firstId, volumeId, '/mnt/shared', 'shared');
      await attachVolume(adminApi, secondId, volumeId, '/mnt/shared', 'shared');
      const marker = `twin-${seedState.runId}`;
      await execInContainer(
        adminApi,
        firstId,
        `printf '%s\\n' '${marker}' > /mnt/shared/twin && cat /mnt/shared/twin`,
      );
      expect(await execInContainer(adminApi, secondId, 'cat /mnt/shared/twin')).toContain(marker);
      const blocked = await adminApi.delete(`/api/admin/shared-volumes/${volumeId}`);
      expect(blocked.status()).toBe(409);
      expect(conflictCode(await blocked.json())).toBe('VOLUME_REQUIRES_UNBIND');
    } finally {
      for (const id of [firstId, secondId]) {
        if (!id) continue;
        await stopContainer(adminApi, id).catch(() => undefined);
        const attachments = await listContainerVolumes(adminApi, id, 'shared');
        for (const row of attachments) {
          await detachVolume(adminApi, id, row.id as string, 'shared').catch(() => undefined);
        }
        await deleteContainer(adminApi, id);
      }
      await deleteVolume(adminApi, volumeId);
    }
  },
);

async function incusCustomExists(
  pool: JsonRecord,
  incusName: string,
  ssh?: string,
): Promise<boolean> {
  return incusCustomVolumeExists(String(pool.incusName), incusName, ssh);
}

function quotaProbeScript(filename: string): string {
  return [
    `rm -f /mnt/shared/${filename}`,
    `dd if=/dev/zero of=/mnt/shared/${filename} bs=1048576 count=64 conv=fsync oflag=sync 2>/tmp/dd.err`,
    'echo EXIT:$?',
    `du -sb /mnt/shared/${filename} 2>/dev/null || echo 0 /mnt/shared/${filename}`,
    'df -B1 /mnt/shared | tail -n 1',
    'cat /tmp/dd.err 2>/dev/null || true',
  ].join('; ');
}

function parseQuotaProbe(output: string): {
  exit: number;
  bytes: number;
  dfSize: number;
  dfUsed: number;
  raw: string;
} {
  const exitMatch = output.match(/EXIT:(\d+)/);
  const duMatch = output.match(/^(\d+)\s+\/mnt\/shared\//m);
  const dfMatch = output.match(/(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+\/mnt\/shared/);
  return {
    exit: exitMatch ? Number(exitMatch[1]) : -1,
    bytes: duMatch ? Number(duMatch[1]) : 0,
    dfSize: dfMatch ? Number(dfMatch[1]) : 0,
    dfUsed: dfMatch ? Number(dfMatch[2]) : 0,
    raw: output.slice(0, 800),
  };
}
