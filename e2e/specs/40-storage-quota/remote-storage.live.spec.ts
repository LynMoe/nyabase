import { readFileSync, statSync } from 'node:fs';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import {
  cleanupContainerThroughProductApi,
  waitForAgentTask,
  waitForContainer,
  type AgentTaskRef,
  type AgentTaskView,
} from '../../support/durable-api.js';
import { expectJson, expectSuccess } from '../../support/http.js';
import { controlRemoteStorage } from '../../support/remote-storage-control.js';
import { controlStorageFixture } from '../../support/storage-fixture-control.js';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';
import { runCleanupStepsPreservingPrimary } from '../../support/error-diagnostics.mjs';
import type {
  AvailableTopologyProvider,
  TopologyNodeKey,
} from '../../topology/provider.js';

interface NfsParams {
  type: 'nfs';
  nfsServer: string;
  exportPath: string;
  version: '3' | '4' | '4.1' | '4.2';
}

interface CephFsCreateParams {
  type: 'cephfs';
  monHosts: string;
  fsName?: string;
  exportPath: string;
  clientName: string;
  secret: string;
}

interface CephFsViewParams extends Omit<CephFsCreateParams, 'secret'> {
  secretConfigured: boolean;
}

type RemoteFsCreateParams = NfsParams | CephFsCreateParams;
type RemoteFsViewParams = NfsParams | CephFsViewParams;

interface RemoteMountView {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  type: 'nfs' | 'cephfs';
  options: string;
  hostMountPoint: string;
  params: RemoteFsViewParams;
  createdAt: string;
  updatedAt: string;
  serverIds: string[];
  serverStatuses?: Record<string, {
    id: string;
    hostMountPoint: string;
    status: 'mounted' | 'mounting' | 'error';
    error?: string;
    lastCheckedAt: number;
  }>;
  taskIds?: string[];
}

interface CatalogRemoteMountView {
  id: string;
  name: string;
  displayName: string | null;
  serverIds: string[];
}

interface RemoteAssignmentView {
  id: string;
  remoteFsMountId: string;
  serverId: string;
  desiredState: 'ensuring' | 'active' | 'removing' | 'failed';
  generation: number;
  lastTaskId: string | null;
  taskId?: string;
}

interface RemoteFixture<T extends 'nfs' | 'cephfs', P> {
  schemaVersion: 1;
  runId: string;
  type: T;
  options: string;
  params: P;
}

interface CephFixture extends RemoteFixture<'cephfs', Omit<CephFsCreateParams, 'secret'>> {
  secretFile: string;
}

interface DataDirCreateResult {
  id: string;
  resourceId: string;
  serverId: string;
  sourceKind: 'remote';
  sourceId: string;
  name: string;
  hostPath: string;
  taskId: string;
}

interface MountSourceGrantView {
  id: string;
  scope: 'user' | 'group';
  scopeId: string;
  sourceKind: 'remote';
  sourceId: string;
  serverId: null;
  sourceIdentity: null;
}

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let resourceSequence = 0;

function resourceStem(label: string): string {
  resourceSequence += 1;
  const run = currentRunId()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 28);
  return `${run}-${label}-${Date.now().toString(36)}-${resourceSequence}`;
}

function readNfsFixture(): RemoteFixture<'nfs', NfsParams> {
  const fixture = JSON.parse(
    readFileSync(requireRuntimeEnv('E2E_NFS_FIXTURE'), 'utf8'),
  ) as RemoteFixture<'nfs', NfsParams>;
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.runId).toBe(currentRunId());
  expect(fixture.type).toBe('nfs');
  expect(fixture.params.type).toBe('nfs');
  return fixture;
}

function readCephFixture(): {
  fixture: CephFixture;
  params: CephFsCreateParams;
} {
  const fixture = JSON.parse(
    readFileSync(requireRuntimeEnv('E2E_CEPHFS_FIXTURE'), 'utf8'),
  ) as CephFixture;
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.runId).toBe(currentRunId());
  expect(fixture.type).toBe('cephfs');
  expect(fixture.params.type).toBe('cephfs');
  expect(statSync(fixture.secretFile).mode & 0o777).toBe(0o600);
  const secret = readFileSync(fixture.secretFile, 'utf8').trim();
  expect(secret.length).toBeGreaterThan(16);
  return { fixture, params: { ...fixture.params, secret } };
}

function assertNoSecretKey(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSecretKey(entry);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    expect(key).not.toBe('secret');
    assertNoSecretKey(entry);
  }
}

async function expectUnauthorized(response: APIResponse): Promise<void> {
  expect(response.status(), 'anonymous remote-storage response body withheld').toBe(401);
}

async function createRemoteMount(
  adminApi: APIRequestContext,
  label: string,
  fixture: { options: string; params: RemoteFsCreateParams },
  serverIds: string[] = [],
): Promise<RemoteMountView> {
  const name = resourceStem(label).slice(0, 128);
  const mount = await expectJson<RemoteMountView>(
    await adminApi.post('/api/admin/remote-fs-mounts', {
      data: {
        name,
        displayName: `${label} real CPU fixture`,
        description: `${currentRunId()} ${label} live remote storage`,
        serverIds,
        options: fixture.options,
        params: fixture.params,
      },
    }),
    201,
  );
  expect(mount.id).toMatch(uuidV4Pattern);
  expect(mount.name).toBe(name);
  expect(mount.hostMountPoint).toBe(`/mnt/remote-fs/${mount.id}`);
  expect(mount.type).toBe(fixture.params.type);
  expect(mount.serverIds.sort()).toEqual([...serverIds].sort());
  assertNoSecretKey(mount);
  return mount;
}

async function listAssignments(
  adminApi: APIRequestContext,
  mountId: string,
): Promise<RemoteAssignmentView[]> {
  return expectJson<RemoteAssignmentView[]>(
    await adminApi.get(`/api/admin/remote-fs-mounts/${mountId}/servers`),
  );
}

async function waitForAssignments(
  adminApi: APIRequestContext,
  mountId: string,
  description: string,
  accept: (rows: RemoteAssignmentView[]) => boolean,
  timeoutMs = 60_000,
): Promise<RemoteAssignmentView[]> {
  const deadline = Date.now() + timeoutMs;
  let last: RemoteAssignmentView[] = [];
  while (Date.now() < deadline) {
    last = await listAssignments(adminApi, mountId);
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Remote mount ${mountId} did not reach ${description}; assignmentCount=${last.length}`,
  );
}

async function waitForTaskTerminal(
  adminApi: APIRequestContext,
  taskId: string,
  timeoutMs = 150_000,
): Promise<AgentTaskView> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'missing';
  while (Date.now() < deadline) {
    const task = await expectJson<AgentTaskView>(
      await adminApi.get(`/api/admin/agent-tasks/${taskId}`),
    );
    lastStatus = task.status;
    if (task.status === 'succeeded' || task.status === 'failed') return task;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Remote storage task ${taskId} remained ${lastStatus}`);
}

async function assignAndWait(
  adminApi: APIRequestContext,
  topologyProvider: AvailableTopologyProvider,
  mountId: string,
  fsType: 'nfs' | 'cephfs',
  nodeKey: TopologyNodeKey,
  serverId: string,
): Promise<{ assignment: RemoteAssignmentView; task: AgentTaskView }> {
  const assignment = await expectJson<RemoteAssignmentView>(
    await adminApi.post(`/api/admin/remote-fs-mounts/${mountId}/servers`, {
      data: { serverId },
    }),
    201,
  );
  expect(assignment.remoteFsMountId).toBe(mountId);
  expect(assignment.serverId).toBe(serverId);
  expect(assignment.taskId).toBeTruthy();
  const task = await waitForAgentTask(adminApi, assignment.taskId!, {
    kind: 'remote_fs.ensure',
    resourceId: mountId,
    timeoutMs: 150_000,
  });
  const rows = await waitForAssignments(
    adminApi,
    mountId,
    `${nodeKey} active`,
    (entries) => entries.some(
      (entry) => entry.serverId === serverId && entry.desiredState === 'active',
    ),
  );
  const active = rows.find((entry) => entry.serverId === serverId)!;
  expect(active.lastTaskId).toBe(task.id);
  const physical = await controlRemoteStorage(topologyProvider, {
    runId: currentRunId(), nodeKey, mountId, fsType, action: 'probe',
  });
  expect(physical.mounted).toBe(true);
  expect(physical.cephSecretArtifactsAbsent).toBe(true);
  return { assignment: active, task };
}

async function unassignAndWait(
  adminApi: APIRequestContext,
  topologyProvider: AvailableTopologyProvider,
  mountId: string,
  fsType: 'nfs' | 'cephfs',
  nodeKey: TopologyNodeKey,
  serverId: string,
): Promise<AgentTaskView> {
  const result = await expectJson<{ ok: true; taskIds: string[] }>(
    await adminApi.delete(`/api/admin/remote-fs-mounts/${mountId}/servers/${serverId}`),
  );
  expect(result.ok).toBe(true);
  expect(result.taskIds).toHaveLength(1);
  const task = await waitForAgentTask(adminApi, result.taskIds[0]!, {
    kind: 'remote_fs.absent',
    resourceId: mountId,
    timeoutMs: 150_000,
  });
  await waitForAssignments(
    adminApi,
    mountId,
    `${nodeKey} assignment absent`,
    (entries) => entries.every((entry) => entry.serverId !== serverId),
  );
  const physical = await controlRemoteStorage(topologyProvider, {
    runId: currentRunId(), nodeKey, mountId, fsType, action: 'probe',
  });
  expect(physical.mounted).toBe(false);
  return task;
}

async function deleteMountAndAssertAbsent(
  adminApi: APIRequestContext,
  mountId: string,
): Promise<void> {
  const result = await expectJson<{ ok: true; taskIds: string[] }>(
    await adminApi.delete(`/api/admin/remote-fs-mounts/${mountId}`),
  );
  expect(result).toEqual({ ok: true, taskIds: [] });
  expect((await adminApi.get(`/api/admin/remote-fs-mounts/${mountId}`)).status()).toBe(404);
}

async function ensureNfsFixtureRunning(
  topologyProvider: AvailableTopologyProvider,
): Promise<void> {
  const probe = await controlStorageFixture(topologyProvider, {
    runId: currentRunId(), fixture: 'nfs', action: 'probe',
  });
  if (probe.running && probe.portReady) return;
  const started = await controlStorageFixture(topologyProvider, {
    runId: currentRunId(), fixture: 'nfs', action: 'start',
  });
  expect(started.running).toBe(true);
  expect(started.portReady).toBe(true);
}

async function cleanupRemoteMount(
  adminApi: APIRequestContext,
  topologyProvider: AvailableTopologyProvider,
  mountId: string,
  fsType: 'nfs' | 'cephfs',
): Promise<void> {
  if (fsType === 'nfs') await ensureNfsFixtureRunning(topologyProvider);
  for (const nodeKey of ['node1', 'node2'] as const) {
    await controlRemoteStorage(topologyProvider, {
      runId: currentRunId(), nodeKey, mountId, fsType, action: 'releaseBusy',
    });
  }
  if ((await adminApi.get(`/api/admin/remote-fs-mounts/${mountId}`)).status() === 404) return;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const assignments = await listAssignments(adminApi, mountId);
    if (assignments.length === 0) break;
    for (const assignment of assignments) {
      const response = await adminApi.delete(
        `/api/admin/remote-fs-mounts/${mountId}/servers/${assignment.serverId}`,
      );
      if (response.status() === 404) continue;
      const result = await expectJson<{ ok: true; taskIds: string[] }>(response);
      for (const taskId of result.taskIds) await waitForTaskTerminal(adminApi, taskId);
    }
  }
  const remaining = await listAssignments(adminApi, mountId);
  if (remaining.length > 0) {
    throw new Error(`Remote mount ${mountId} retained ${remaining.length} assignments during cleanup`);
  }
  const response = await adminApi.delete(`/api/admin/remote-fs-mounts/${mountId}`);
  if (response.status() !== 404) await expectSuccess(response);
}

async function createRemoteGrant(
  adminApi: APIRequestContext,
  mountId: string,
  userId: string,
): Promise<MountSourceGrantView> {
  const grant = await expectJson<MountSourceGrantView>(
    await adminApi.post(`/api/admin/mount-sources/grants/remote/${mountId}`, {
      data: { scope: 'user', scopeId: userId },
    }),
    201,
  );
  expect(grant).toEqual(expect.objectContaining({
    scope: 'user', scopeId: userId, sourceKind: 'remote', sourceId: mountId,
    serverId: null, sourceIdentity: null,
  }));
  return grant;
}

async function deleteRemoteGrant(
  adminApi: APIRequestContext,
  mountId: string,
  userId: string,
): Promise<void> {
  const response = await adminApi.delete(
    `/api/admin/mount-sources/grants/remote/${mountId}/user/${userId}`,
  );
  expect([204, 404]).toContain(response.status());
}

async function createRemoteDataDir(
  adminApi: APIRequestContext,
  input: { serverId: string; sourceId: string; userId: string; name: string },
): Promise<DataDirCreateResult> {
  const created = await expectJson<DataDirCreateResult>(
    await adminApi.post('/api/admin/data-dirs', {
      data: { ...input, sourceKind: 'remote' },
    }),
    201,
  );
  await waitForAgentTask(adminApi, created.taskId, {
    kind: 'datadir.ensure', resourceId: created.id, timeoutMs: 150_000,
  });
  return created;
}

async function deleteRemoteDataDir(
  adminApi: APIRequestContext,
  input: { serverId: string; sourceId: string; userId: string; name: string },
): Promise<void> {
  const response = await adminApi.delete(
    `/api/admin/data-dirs/${input.serverId}/${input.sourceId}/${input.name}` +
      `?sourceKind=remote&userId=${input.userId}`,
  );
  if (response.status() === 404) return;
  const task = await expectJson<AgentTaskRef>(response);
  await waitForAgentTask(adminApi, task.taskId, {
    kind: 'datadir.absent', timeoutMs: 150_000,
  });
}

async function createRemoteMountedContainer(
  adminApi: APIRequestContext,
  input: {
    serverId: string;
    imageId: string;
    name: string;
    sourceId: string;
    dirName: string;
  },
  rememberContainerId: (containerId: string) => void,
): Promise<string> {
  const ref = await expectJson<AgentTaskRef>(
    await adminApi.post('/api/v2/containers', {
      data: {
        serverId: input.serverId,
        imageId: input.imageId,
        name: input.name,
        dataDirs: [{
          sourceKind: 'remote', sourceId: input.sourceId,
          dirName: input.dirName, containerPath: '/data',
        }],
      },
    }),
    201,
  );
  const pending = await expectJson<AgentTaskView>(
    await adminApi.get(`/api/admin/agent-tasks/${ref.taskId}`),
  );
  const containerId = pending.resourceId;
  rememberContainerId(containerId);
  await waitForAgentTask(adminApi, ref.taskId, {
    kind: 'container.create', resourceId: containerId, timeoutMs: 180_000,
  });
  const container = await waitForContainer(
    adminApi,
    containerId,
    'running with the real remote DataDir mounted',
    (view) => view.runtime.status === 'running' && view.activeTask === null,
    90_000,
  );
  expect(container.mounts).toContainEqual(expect.objectContaining({
    sourceKind: 'remote', sourceId: input.sourceId,
    dirName: input.dirName, containerPath: '/data',
  }));
  return containerId;
}

test.describe('40 real remote storage behaviors', () => {
  test(
    'api.storage.real-nfs-cross-node-lifecycle',
    coverageCase(
      'storage.remote.nfs-create-assign-mount-unmount-delete',
      'api.storage.real-nfs-cross-node-lifecycle',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(300_000);
      const fixture = readNfsFixture();
      const mount = await createRemoteMount(adminApi, 'nfs-lifecycle', fixture);
      try {
        const node1 = seedState.servers.find((server) => server.key === 'node1')!;
        const node2 = seedState.servers.find((server) => server.key === 'node2')!;
        await assignAndWait(adminApi, topologyProvider, mount.id, 'nfs', 'node1', node1.serverId);
        await assignAndWait(adminApi, topologyProvider, mount.id, 'nfs', 'node2', node2.serverId);
        const marker = `nfs.cross:${Date.now()}`;
        const written = await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node1', mountId: mount.id,
          fsType: 'nfs', action: 'write', marker,
        });
        expect(written.markerMatched).toBe(true);
        const read = await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node2', mountId: mount.id,
          fsType: 'nfs', action: 'read', marker,
        });
        expect(read.markerMatched).toBe(true);

        await unassignAndWait(
          adminApi, topologyProvider, mount.id, 'nfs', 'node1', node1.serverId,
        );
        expect((await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node2', mountId: mount.id,
          fsType: 'nfs', action: 'probe',
        })).mounted).toBe(true);
        await unassignAndWait(
          adminApi, topologyProvider, mount.id, 'nfs', 'node2', node2.serverId,
        );
        await deleteMountAndAssertAbsent(adminApi, mount.id);
      } finally {
        await cleanupRemoteMount(adminApi, topologyProvider, mount.id, 'nfs');
      }
    },
  );

  test(
    'api.storage.real-cephfs-cross-node-lifecycle',
    coverageCase(
      'storage.remote.cephfs-create-assign-mount-unmount-delete',
      'api.storage.real-cephfs-cross-node-lifecycle',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(300_000);
      const { fixture, params } = readCephFixture();
      const mount = await createRemoteMount(adminApi, 'cephfs-lifecycle', {
        options: fixture.options, params,
      });
      try {
        const node1 = seedState.servers.find((server) => server.key === 'node1')!;
        const node2 = seedState.servers.find((server) => server.key === 'node2')!;
        await assignAndWait(adminApi, topologyProvider, mount.id, 'cephfs', 'node1', node1.serverId);
        await assignAndWait(adminApi, topologyProvider, mount.id, 'cephfs', 'node2', node2.serverId);
        const marker = `ceph.cross:${Date.now()}`;
        expect((await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node2', mountId: mount.id,
          fsType: 'cephfs', action: 'write', marker,
        })).markerMatched).toBe(true);
        expect((await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node1', mountId: mount.id,
          fsType: 'cephfs', action: 'read', marker,
        })).markerMatched).toBe(true);
        await unassignAndWait(
          adminApi, topologyProvider, mount.id, 'cephfs', 'node1', node1.serverId,
        );
        expect((await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node2', mountId: mount.id,
          fsType: 'cephfs', action: 'probe',
        })).mounted).toBe(true);
        await unassignAndWait(
          adminApi, topologyProvider, mount.id, 'cephfs', 'node2', node2.serverId,
        );
        await deleteMountAndAssertAbsent(adminApi, mount.id);
      } finally {
        await cleanupRemoteMount(adminApi, topologyProvider, mount.id, 'cephfs');
      }
    },
  );

  test(
    'api.storage.cephfs-credentials-are-redacted-everywhere',
    coverageCase(
      'storage.remote.credential-redaction',
      'api.storage.cephfs-credentials-are-redacted-everywhere',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(240_000);
      const { fixture, params } = readCephFixture();
      const node1 = seedState.servers.find((server) => server.key === 'node1')!;
      const mount = await createRemoteMount(adminApi, 'cephfs-redaction', {
        options: fixture.options, params,
      }, [node1.serverId]);
      try {
        expect(mount.taskIds).toHaveLength(1);
        const task = await waitForAgentTask(adminApi, mount.taskIds![0]!, {
          kind: 'remote_fs.ensure', resourceId: mount.id, timeoutMs: 150_000,
        });
        const detail = await expectJson<AgentTaskView>(
          await adminApi.get(`/api/admin/agent-tasks/${task.id}`),
        );
        const fetched = await expectJson<RemoteMountView>(
          await adminApi.get(`/api/admin/remote-fs-mounts/${mount.id}`),
        );
        const listed = await expectJson<RemoteMountView[]>(
          await adminApi.get('/api/admin/remote-fs-mounts'),
        );
        const listedMount = listed.find((entry) => entry.id === mount.id);
        expect(listedMount).toBeDefined();
        for (const value of [mount, fetched, listedMount, detail.request]) {
          assertNoSecretKey(value);
          if (JSON.stringify(value).includes(params.secret)) {
            throw new Error('A CephFS raw credential appeared in a public API projection');
          }
        }
        expect(fetched.params).toEqual(expect.objectContaining({
          type: 'cephfs', secretConfigured: true,
        }));
        const physical = await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node1', mountId: mount.id,
          fsType: 'cephfs', action: 'probe',
        });
        expect(physical.mounted).toBe(true);
        expect(physical.cephSecretArtifactsAbsent).toBe(true);
        await unassignAndWait(
          adminApi, topologyProvider, mount.id, 'cephfs', 'node1', node1.serverId,
        );
        await deleteMountAndAssertAbsent(adminApi, mount.id);
      } finally {
        await cleanupRemoteMount(adminApi, topologyProvider, mount.id, 'cephfs');
      }
    },
  );

  test(
    'api.storage.remote-assignment-isolation-with-real-container-consumer',
    coverageCase(
      'storage.remote.server-assignment-isolation',
      'api.storage.remote-assignment-isolation-with-real-container-consumer',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(420_000);
      const fixture = readNfsFixture();
      const node1 = seedState.servers.find((server) => server.key === 'node1')!;
      const node2 = seedState.servers.find((server) => server.key === 'node2')!;
      const mount = await createRemoteMount(adminApi, 'nfs-isolation', fixture);
      const dirName = resourceStem('remote-dir').slice(0, 64);
      const dataDirInput = {
        serverId: node2.serverId,
        sourceId: mount.id,
        userId: seedState.adminUserId,
        name: dirName,
      };
      let containerId: string | null = null;
      let dataDirCreated = false;
      let grantCreated = false;
      let primaryFailure: { error: unknown } | null = null;
      try {
        await assignAndWait(
          adminApi, topologyProvider, mount.id, 'nfs', 'node1', node1.serverId,
        );
        await assignAndWait(
          adminApi, topologyProvider, mount.id, 'nfs', 'node2', node2.serverId,
        );
        grantCreated = true;
        await createRemoteGrant(adminApi, mount.id, seedState.adminUserId);
        dataDirCreated = true;
        await createRemoteDataDir(adminApi, dataDirInput);
        containerId = await createRemoteMountedContainer(adminApi, {
          serverId: node2.serverId,
          imageId: seedState.image.id,
          name: resourceStem('remote-container').slice(0, 64),
          sourceId: mount.id,
          dirName,
        }, (createdContainerId) => {
          containerId = createdContainerId;
        });

        await unassignAndWait(
          adminApi, topologyProvider, mount.id, 'nfs', 'node1', node1.serverId,
        );
        expect((await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node2', mountId: mount.id,
          fsType: 'nfs', action: 'probe',
        })).mounted).toBe(true);
        expect((await adminApi.delete(
          `/api/admin/remote-fs-mounts/${mount.id}/servers/${node2.serverId}`,
        )).status()).toBe(409);
        expect((await adminApi.delete(
          `/api/admin/remote-fs-mounts/${mount.id}`,
        )).status()).toBe(409);

        await cleanupContainerThroughProductApi(adminApi, containerId);
        containerId = null;
        const lastAssignmentBlocked = await expectJson<{ code: string; message: string }>(
          await adminApi.delete(
            `/api/admin/remote-fs-mounts/${mount.id}/servers/${node2.serverId}`,
          ),
          409,
        );
        expect(lastAssignmentBlocked.code).toBe('REMOTE_FS_LAST_ASSIGNMENT_HAS_DATA_DIRS');
        expect((await adminApi.delete(
          `/api/admin/remote-fs-mounts/${mount.id}`,
        )).status()).toBe(409);

        await deleteRemoteDataDir(adminApi, dataDirInput);
        dataDirCreated = false;
        await deleteRemoteGrant(adminApi, mount.id, seedState.adminUserId);
        grantCreated = false;
        await unassignAndWait(
          adminApi, topologyProvider, mount.id, 'nfs', 'node2', node2.serverId,
        );
        await deleteMountAndAssertAbsent(adminApi, mount.id);
      } catch (error) {
        primaryFailure = { error };
      } finally {
        await runCleanupStepsPreservingPrimary('Remote assignment-isolation cleanup failed', [
          async () => {
            if (containerId) {
              await cleanupContainerThroughProductApi(adminApi, containerId);
            }
          },
          async () => {
            if (dataDirCreated) await deleteRemoteDataDir(adminApi, dataDirInput);
          },
          async () => {
            if (grantCreated) {
              await deleteRemoteGrant(adminApi, mount.id, seedState.adminUserId);
            }
          },
          async () => cleanupRemoteMount(
            adminApi, topologyProvider, mount.id, 'nfs',
          ),
        ], primaryFailure);
      }
    },
  );

  test(
    'api.storage.nfs-mount-failure-converges-and-repairs',
    coverageCase(
      'storage.remote.mount-failure-convergence',
      'api.storage.nfs-mount-failure-converges-and-repairs',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(360_000);
      const fixture = readNfsFixture();
      const node1 = seedState.servers.find((server) => server.key === 'node1')!;
      const mount = await createRemoteMount(adminApi, 'nfs-failure', {
        ...fixture,
        // The normal fixture intentionally certifies hard-mount behavior. A
        // stopped hard server can leave mount(8) waiting in the kernel beyond
        // the Agent mutation deadline, which is a fail-stop boundary rather
        // than an ordinary task failure. This case targets the recoverable
        // failure contract, so bound the foreground mount helper explicitly.
        options: 'soft,proto=tcp,timeo=1,retrans=1,retry=0',
      });
      try {
        const stopped = await controlStorageFixture(topologyProvider, {
          runId: currentRunId(), fixture: 'nfs', action: 'stop',
        });
        expect(stopped.running).toBe(false);
        expect(stopped.portReady).toBe(false);
        const failedIntent = await expectJson<RemoteAssignmentView>(
          await adminApi.post(`/api/admin/remote-fs-mounts/${mount.id}/servers`, {
            data: { serverId: node1.serverId },
          }),
          201,
        );
        const failedTask = await waitForTaskTerminal(adminApi, failedIntent.taskId!, 180_000);
        expect(failedTask.kind).toBe('remote_fs.ensure');
        expect(failedTask.status).toBe('failed');
        expect(failedTask.failureStage).toBe('agent');
        expect(failedTask.error).not.toBeNull();
        const failedRows = await waitForAssignments(
          adminApi,
          mount.id,
          'failed mount intent',
          (rows) => rows.some(
            (row) => row.serverId === node1.serverId && row.desiredState === 'failed',
          ),
        );
        const failedAssignment = failedRows.find((row) => row.serverId === node1.serverId)!;
        expect((await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node1', mountId: mount.id,
          fsType: 'nfs', action: 'probe',
        })).mounted).toBe(false);

        await ensureNfsFixtureRunning(topologyProvider);
        const repaired = await assignAndWait(
          adminApi, topologyProvider, mount.id, 'nfs', 'node1', node1.serverId,
        );
        expect(repaired.assignment.id).toBe(failedAssignment.id);
        expect(repaired.assignment.generation).toBeGreaterThan(failedAssignment.generation);
        await unassignAndWait(
          adminApi, topologyProvider, mount.id, 'nfs', 'node1', node1.serverId,
        );
        await deleteMountAndAssertAbsent(adminApi, mount.id);
      } finally {
        await ensureNfsFixtureRunning(topologyProvider);
        await cleanupRemoteMount(adminApi, topologyProvider, mount.id, 'nfs');
      }
    },
  );

  test(
    'api.storage.busy-nfs-unmount-fails-closed-and-recovers',
    coverageCase(
      'storage.remote.busy-unmount-recovery',
      'api.storage.busy-nfs-unmount-fails-closed-and-recovers',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(300_000);
      const fixture = readNfsFixture();
      const node1 = seedState.servers.find((server) => server.key === 'node1')!;
      const mount = await createRemoteMount(adminApi, 'nfs-busy', fixture);
      try {
        await assignAndWait(adminApi, topologyProvider, mount.id, 'nfs', 'node1', node1.serverId);
        const held = await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node1', mountId: mount.id,
          fsType: 'nfs', action: 'holdBusy',
        });
        expect(held.busyPid).toBeGreaterThan(0);
        const first = await expectJson<{ ok: true; taskIds: string[] }>(
          await adminApi.delete(
            `/api/admin/remote-fs-mounts/${mount.id}/servers/${node1.serverId}`,
          ),
        );
        expect(first.taskIds).toHaveLength(1);
        const failed = await waitForTaskTerminal(adminApi, first.taskIds[0]!);
        expect(failed.kind).toBe('remote_fs.absent');
        expect(failed.status).toBe('failed');
        expect(failed.failureStage).toBe('agent');
        expect((await listAssignments(adminApi, mount.id)).find(
          (row) => row.serverId === node1.serverId,
        )?.desiredState).toBe('removing');
        expect((await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node1', mountId: mount.id,
          fsType: 'nfs', action: 'probe',
        })).mounted).toBe(true);

        const released = await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node1', mountId: mount.id,
          fsType: 'nfs', action: 'releaseBusy',
        });
        expect(released.busyPid).toBe(held.busyPid);
        await unassignAndWait(
          adminApi, topologyProvider, mount.id, 'nfs', 'node1', node1.serverId,
        );
        await deleteMountAndAssertAbsent(adminApi, mount.id);
      } finally {
        await controlRemoteStorage(topologyProvider, {
          runId: currentRunId(), nodeKey: 'node1', mountId: mount.id,
          fsType: 'nfs', action: 'releaseBusy',
        });
        await cleanupRemoteMount(adminApi, topologyProvider, mount.id, 'nfs');
      }
    },
  );
});

let exactMountId: string | null = null;
let exactMountName = '';

test.describe.serial('40 remote storage exact API contracts', () => {
  test.afterEach(async ({ adminApi, topologyProvider }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && exactMountId) {
      const mountId = exactMountId;
      exactMountId = null;
      await cleanupRemoteMount(adminApi, topologyProvider, mountId, 'nfs');
    }
  });

  test(
    'api.storage.remote.post-mount-exact-contract',
    coverageCase(
      'storage.remote.http.post.api-admin-remote-fs-mounts',
      'api.storage.remote.post-mount-exact-contract',
    ),
    async ({ adminApi, anonymousApi }) => {
      const fixture = readNfsFixture();
      await expectUnauthorized(await anonymousApi.post('/api/admin/remote-fs-mounts', {
        data: { name: 'denied', options: fixture.options, params: fixture.params },
      }));
      const mount = await createRemoteMount(adminApi, 'nfs-exact', fixture);
      exactMountId = mount.id;
      exactMountName = mount.name;
      expect(mount.serverIds).toEqual([]);
      expect(mount.taskIds).toEqual([]);
      expect(mount.params).toEqual(fixture.params);
    },
  );

  test(
    'api.storage.remote.get-mounts-exact-contract',
    coverageCase(
      'storage.remote.http.get.api-admin-remote-fs-mounts',
      'api.storage.remote.get-mounts-exact-contract',
    ),
    async ({ adminApi, anonymousApi }) => {
      expect(exactMountId).not.toBeNull();
      await expectUnauthorized(await anonymousApi.get('/api/admin/remote-fs-mounts'));
      const mounts = await expectJson<RemoteMountView[]>(
        await adminApi.get('/api/admin/remote-fs-mounts'),
      );
      expect(mounts).toContainEqual(expect.objectContaining({
        id: exactMountId, name: exactMountName, type: 'nfs', serverIds: [],
      }));
    },
  );

  test(
    'api.catalog.grant-remote-fs-mounts-purpose-safe-projection',
    coverageCase(
      'storage.remote.catalog-grant-remote-fs-projection',
      'api.catalog.grant-remote-fs-mounts-purpose-safe-projection',
    ),
    async ({ adminApi, anonymousApi }) => {
      expect(exactMountId).not.toBeNull();
      await expectUnauthorized(
        await anonymousApi.get('/api/admin/catalog/grant-remote-fs-mounts'),
      );
      const mounts = await expectJson<CatalogRemoteMountView[]>(
        await adminApi.get('/api/admin/catalog/grant-remote-fs-mounts'),
      );
      const mount = mounts.find((candidate) => candidate.id === exactMountId);
      expect(mount).toEqual(expect.objectContaining({
        id: exactMountId,
        name: exactMountName,
        serverIds: [],
      }));
      expect(Object.keys(mount!).sort()).toEqual(
        ['id', 'name', 'displayName', 'serverIds'].sort(),
      );
    },
  );

  test(
    'api.storage.remote.get-mount-exact-contract',
    coverageCase(
      'storage.remote.http.get.api-admin-remote-fs-mounts-by-id',
      'api.storage.remote.get-mount-exact-contract',
    ),
    async ({ adminApi, anonymousApi }) => {
      expect(exactMountId).not.toBeNull();
      await expectUnauthorized(await anonymousApi.get(
        `/api/admin/remote-fs-mounts/${exactMountId}`,
      ));
      const mount = await expectJson<RemoteMountView>(
        await adminApi.get(`/api/admin/remote-fs-mounts/${exactMountId}`),
      );
      expect(mount).toEqual(expect.objectContaining({
        id: exactMountId, name: exactMountName, type: 'nfs', serverIds: [],
      }));
    },
  );

  test(
    'api.storage.remote.patch-mount-exact-contract',
    coverageCase(
      'storage.remote.http.patch.api-admin-remote-fs-mounts-by-id',
      'api.storage.remote.patch-mount-exact-contract',
    ),
    async ({ adminApi, anonymousApi }) => {
      expect(exactMountId).not.toBeNull();
      await expectUnauthorized(await anonymousApi.patch(
        `/api/admin/remote-fs-mounts/${exactMountId}`,
        { data: { displayName: 'denied' } },
      ));
      const displayName = `${currentRunId()} exact remote updated`;
      const mount = await expectJson<RemoteMountView>(
        await adminApi.patch(`/api/admin/remote-fs-mounts/${exactMountId}`, {
          data: { displayName, description: 'real exact route update' },
        }),
      );
      expect(mount.displayName).toBe(displayName);
      expect(mount.description).toBe('real exact route update');
    },
  );

  test(
    'api.storage.remote.post-server-exact-contract',
    coverageCase(
      'storage.remote.http.post.api-admin-remote-fs-mounts-by-id-servers',
      'api.storage.remote.post-server-exact-contract',
    ),
    async ({ adminApi, anonymousApi, seedState, topologyProvider }) => {
      expect(exactMountId).not.toBeNull();
      const node1 = seedState.servers.find((server) => server.key === 'node1')!;
      await expectUnauthorized(await anonymousApi.post(
        `/api/admin/remote-fs-mounts/${exactMountId}/servers`,
        { data: { serverId: node1.serverId } },
      ));
      const applied = await assignAndWait(
        adminApi, topologyProvider, exactMountId!, 'nfs', 'node1', node1.serverId,
      );
      expect(applied.assignment.id).toMatch(uuidV4Pattern);
      expect(applied.assignment.desiredState).toBe('active');
      expect(applied.task.kind).toBe('remote_fs.ensure');
    },
  );

  test(
    'api.storage.remote.get-servers-exact-contract',
    coverageCase(
      'storage.remote.http.get.api-admin-remote-fs-mounts-by-id-servers',
      'api.storage.remote.get-servers-exact-contract',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      expect(exactMountId).not.toBeNull();
      const node1 = seedState.servers.find((server) => server.key === 'node1')!;
      await expectUnauthorized(await anonymousApi.get(
        `/api/admin/remote-fs-mounts/${exactMountId}/servers`,
      ));
      const rows = await listAssignments(adminApi, exactMountId!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        remoteFsMountId: exactMountId,
        serverId: node1.serverId,
        desiredState: 'active',
      }));
      expect(rows[0]!.lastTaskId).toBeTruthy();
    },
  );

  test(
    'api.storage.remote.delete-server-exact-contract',
    coverageCase(
      'storage.remote.http.delete.api-admin-remote-fs-mounts-by-id-servers-by-serverid',
      'api.storage.remote.delete-server-exact-contract',
    ),
    async ({ adminApi, anonymousApi, seedState, topologyProvider }) => {
      expect(exactMountId).not.toBeNull();
      const node1 = seedState.servers.find((server) => server.key === 'node1')!;
      await expectUnauthorized(await anonymousApi.delete(
        `/api/admin/remote-fs-mounts/${exactMountId}/servers/${node1.serverId}`,
      ));
      const task = await unassignAndWait(
        adminApi, topologyProvider, exactMountId!, 'nfs', 'node1', node1.serverId,
      );
      expect(task.kind).toBe('remote_fs.absent');
      expect(await listAssignments(adminApi, exactMountId!)).toEqual([]);
    },
  );

  test(
    'api.storage.remote.delete-mount-exact-contract',
    coverageCase(
      'storage.remote.http.delete.api-admin-remote-fs-mounts-by-id',
      'api.storage.remote.delete-mount-exact-contract',
    ),
    async ({ adminApi, anonymousApi }) => {
      expect(exactMountId).not.toBeNull();
      await expectUnauthorized(await anonymousApi.delete(
        `/api/admin/remote-fs-mounts/${exactMountId}`,
      ));
      await deleteMountAndAssertAbsent(adminApi, exactMountId!);
      exactMountId = null;
    },
  );
});
