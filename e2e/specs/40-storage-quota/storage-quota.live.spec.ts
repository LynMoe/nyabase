import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import {
  executeThroughConsole,
  type ConsoleSession,
} from '../../support/console.js';
import {
  cleanupContainerThroughProductApi,
  getContainerOrNull,
  requestContainerAction,
  waitForAgentTask,
  waitForContainer,
  type AgentTaskView,
} from '../../support/durable-api.js';
import { expectJson } from '../../support/http.js';
import { aggregateErrorWithDiagnostics } from '../../support/error-diagnostics.mjs';
import { controlProviderFault } from '../../support/provider-fault-control.js';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';
import type { APIRequestContext, APIResponse } from '@playwright/test';

interface LocalDisk {
  diskId: string;
  mountPoint: string;
  sourceIdentity: string;
  pquotaEnabled: boolean;
}

interface LiveMountSource {
  kind: string;
  id: string;
  serverId: string;
  label: string;
  description?: string;
}

interface DataDirCreateResult {
  id: string;
  resourceId: string;
  serverId: string;
  sourceKind: 'local';
  sourceId: string;
  name: string;
  hostPath: string;
  taskId: string;
}

interface DataDirView extends Omit<DataDirCreateResult, 'taskId'> {
  userId: string;
  desiredState: 'creating' | 'active' | 'removing' | 'failed';
  generation: number;
  lastTaskId: string | null;
}

interface AgentTaskRef {
  ok: true;
  taskId: string;
  status: 'pending' | 'succeeded' | 'failed';
}

interface MountSourceGrant {
  id: string;
  scope: 'user' | 'group';
  scopeId: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  serverId: string | null;
  sourceIdentity: string | null;
}

interface StorageUserView {
  id: string;
  username: string;
  status: 'active' | 'disabled' | 'deleting' | 'deleted';
  capabilities: string[];
}

interface StorageUserSession {
  accessToken: string;
  user: StorageUserView;
}

interface StorageServerFaultView {
  id: string;
  status: string;
  runtimeReady: boolean;
  quarantineCode: string | null;
  quarantineMessage: string | null;
}

interface CreatedStorageUser {
  user: StorageUserView;
  password: string;
}

type TrackedApiFactory = (options?: {
  extraHTTPHeaders?: Record<string, string>;
}) => Promise<APIRequestContext>;

const MIB = 1024 * 1024;
let resourceSequence = 0;

function dataDirName(runId: string, suffix: string): string {
  const base = runId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 40);
  return `${base}-${suffix}`.slice(0, 64);
}

function resourceStem(label: string): string {
  resourceSequence += 1;
  const runId = currentRunId()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 32);
  return `${runId}-${label}-${Date.now().toString(36)}-${resourceSequence}`.slice(0, 64);
}

async function createStorageUser(
  adminApi: APIRequestContext,
  label: string,
): Promise<CreatedStorageUser> {
  const stem = resourceStem(label);
  const username = stem.replace(/-/g, '_').slice(0, 64);
  const password = `E2e-${stem.slice(-20)}-Cpu!`;
  const user = await expectJson<StorageUserView>(
    await adminApi.post('/api/admin/users', {
      data: {
        username,
        password,
        displayName: `${stem} storage user`,
      },
    }),
    201,
  );
  return { user, password };
}

async function loginStorageUser(
  anonymousApi: APIRequestContext,
  trackedApiFactory: TrackedApiFactory,
  created: CreatedStorageUser,
): Promise<{ api: APIRequestContext; accessToken: string }> {
  const session = await expectJson<StorageUserSession>(
    await anonymousApi.post('/api/auth/login', {
      data: { username: created.user.username, password: created.password },
    }),
  );
  expect(session.user.id).toBe(created.user.id);
  expect(session.user.capabilities).toEqual([]);
  expect(session.accessToken.length).toBeGreaterThan(16);
  const api = await trackedApiFactory({
    extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
  });
  return { api, accessToken: session.accessToken };
}

async function grantStorageAccess(
  adminApi: APIRequestContext,
  input: {
    userId: string;
    serverId: string;
    sourceId: string;
    imageId?: string;
    diskBytes: number;
  },
): Promise<AgentTaskView[]> {
  const serverGrant = await expectJson<{ taskIds: string[] }>(
    await adminApi.post(`/api/admin/users/${input.userId}/server-grants/${input.serverId}`, {
      data: {
        cpuMillis: 500,
        memBytes: 256 * MIB,
        diskBytes: input.diskBytes,
        gpuMode: 'none',
        gpuIndices: [],
      },
    }),
    201,
  );
  const quotaTasks = await Promise.all(
    serverGrant.taskIds.map((taskId) =>
      waitForAgentTask(adminApi, taskId, {
        kind: 'quota.ensure',
        resourceId: input.userId,
      }),
    ),
  );

  if (input.imageId) {
    await expectJson<unknown>(
      await adminApi.post(`/api/admin/users/${input.userId}/image-grants`, {
        data: { imageId: input.imageId, serverId: input.serverId },
      }),
      201,
    );
  }
  await expectJson<MountSourceGrant>(
    await adminApi.post(`/api/admin/mount-sources/grants/local/${input.sourceId}`, {
      data: {
        scope: 'user',
        scopeId: input.userId,
        serverId: input.serverId,
      },
    }),
    201,
  );
  return quotaTasks;
}

async function settleTaskIds(
  adminApi: APIRequestContext,
  taskIds: readonly string[],
): Promise<void> {
  for (const taskId of [...new Set(taskIds)]) {
    await waitForAgentTask(adminApi, taskId, { timeoutMs: 120_000 });
  }
}

async function runCleanupSteps(
  description: string,
  steps: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw aggregateErrorWithDiagnostics(`${description} had multiple failures`, errors);
  }
}

async function deleteStorageUser(adminApi: APIRequestContext, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await adminApi.get(`/api/admin/users/${userId}`);
    if (existing.status() === 404) return;
    expect(existing.status(), 'temporary storage user lookup body withheld').toBe(200);
    const result = await expectJson<{ deleted: boolean; taskIds: string[] }>(
      await adminApi.delete(`/api/admin/users/${userId}`),
    );
    await settleTaskIds(adminApi, result.taskIds);
    if (result.deleted) return;
  }
  expect((await adminApi.get(`/api/admin/users/${userId}`)).status()).toBe(404);
}

async function cleanupStorageUserAccess(
  adminApi: APIRequestContext,
  input: {
    userId: string;
    serverId: string;
    sourceId: string;
    imageId?: string;
  },
): Promise<void> {
  if (input.imageId) {
    const image = await adminApi.delete(
      `/api/admin/users/${input.userId}/image-grants/${input.imageId}/${input.serverId}`,
    );
    expect([204, 404], 'temporary image-grant cleanup body withheld').toContain(image.status());
  }
  const mount = await adminApi.delete(
    `/api/admin/mount-sources/grants/local/${input.sourceId}/user/${input.userId}` +
      `?serverId=${input.serverId}`,
  );
  expect([204, 404], 'temporary mount-grant cleanup body withheld').toContain(mount.status());

  const server = await adminApi.delete(
    `/api/admin/users/${input.userId}/server-grants/${input.serverId}`,
  );
  if (server.status() !== 404) {
    const result = await expectJson<{ taskIds: string[] }>(server);
    await settleTaskIds(adminApi, result.taskIds);
  }
  await deleteStorageUser(adminApi, input.userId);
}

async function firstLocalDisk(api: APIRequestContext, serverId: string): Promise<LocalDisk> {
  const disks = await expectJson<LocalDisk[]>(
    await api.get(`/api/admin/servers/${serverId}/disks`),
  );
  const disk = disks.find((candidate) => candidate.pquotaEnabled);
  expect(disk, `server ${serverId} has no real pquota local source`).toBeDefined();
  return disk!;
}

async function waitForLiveLocalMountSource(
  api: APIRequestContext,
  serverId: string,
  timeoutMs = 30_000,
): Promise<LiveMountSource> {
  const deadline = Date.now() + timeoutMs;
  let last: LiveMountSource[] = [];
  let attempts = 0;
  let lastLocalCount = 0;
  let lastServerLocalCount = 0;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    attempts += 1;
    last = await expectJson<LiveMountSource[]>(
      await api.get(`/api/mount-sources?serverId=${serverId}`, {
        timeout: Math.max(1, Math.min(10_000, remaining)),
      }),
    );
    lastLocalCount = last.filter((candidate) => candidate.kind === 'local').length;
    lastServerLocalCount = last.filter(
      (candidate) => candidate.kind === 'local' && candidate.serverId === serverId,
    ).length;
    const source = last.find(
      (candidate) =>
        candidate.kind === 'local' &&
        candidate.serverId === serverId &&
        candidate.id !== '' &&
        candidate.label.trim() !== '',
    );
    if (source) return source;
    const sleepRemaining = deadline - Date.now();
    if (sleepRemaining <= 0) break;
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, Math.min(250, sleepRemaining)),
    );
  }
  throw new Error(
    `Server ${serverId} did not publish a live local mount source within ${timeoutMs}ms; ` +
      `attempts=${attempts}; lastCount=${last.length}; lastLocalCount=${lastLocalCount}; ` +
      `lastServerLocalCount=${lastServerLocalCount}`,
  );
}

async function waitForStorageServer(
  api: APIRequestContext,
  serverId: string,
  description: string,
  accept: (server: StorageServerFaultView) => boolean,
  timeoutMs = 90_000,
): Promise<StorageServerFaultView> {
  const deadline = Date.now() + timeoutMs;
  let last: StorageServerFaultView | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<StorageServerFaultView>(
      await api.get(`/api/admin/servers/${serverId}`),
    );
    if (accept(last)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Server ${serverId} did not reach ${description} within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

async function recoverStorageInventoryFault(
  api: APIRequestContext,
  serverId: string,
  timeoutMs = 90_000,
): Promise<StorageServerFaultView> {
  const deadline = Date.now() + timeoutMs;
  let retrySubmitted = false;
  let last: StorageServerFaultView | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<StorageServerFaultView>(
      await api.get(`/api/admin/servers/${serverId}`),
    );
    if (last.status === 'online' && last.runtimeReady) return last;
    if (last.status === 'agent_quarantined' && !retrySubmitted) {
      const retried = await expectJson<{ taskIds: string[] }>(
        await api.post(`/api/admin/servers/${serverId}/agent-quarantine/retry`),
        201,
      );
      expect(retried.taskIds).toEqual([]);
      retrySubmitted = true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Server ${serverId} did not recover from its inventory fault within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

async function createAdminDataDir(
  api: APIRequestContext,
  input: { serverId: string; sourceId: string; userId: string; name: string },
): Promise<DataDirCreateResult> {
  return expectJson<DataDirCreateResult>(
    await api.post('/api/admin/data-dirs', {
      data: { ...input, sourceKind: 'local' },
    }),
    201,
  );
}

async function createUserDataDir(
  api: APIRequestContext,
  input: { serverId: string; sourceId: string; name: string },
): Promise<DataDirCreateResult> {
  return expectJson<DataDirCreateResult>(
    await api.post('/api/data-dirs', {
      data: { ...input, sourceKind: 'local' },
    }),
    201,
  );
}

async function deleteAdminDataDir(
  api: APIRequestContext,
  input: { serverId: string; sourceId: string; userId: string; name: string },
): Promise<string | null> {
  const response = await api.delete(
    `/api/admin/data-dirs/${input.serverId}/${input.sourceId}/${input.name}` +
      `?sourceKind=local&userId=${input.userId}`,
  );
  if (response.status() === 404) return null;
  const task = await expectJson<AgentTaskRef>(response);
  await waitForAgentTask(api, task.taskId, { kind: 'datadir.absent' });
  return task.taskId;
}

async function deleteUserDataDir(
  api: APIRequestContext,
  input: { serverId: string; sourceId: string; name: string },
  taskObserverApi: APIRequestContext = api,
): Promise<string | null> {
  const response = await api.delete(
    `/api/data-dirs/${input.serverId}/${input.sourceId}/${input.name}?sourceKind=local`,
  );
  if (response.status() === 404) return null;
  const task = await expectJson<AgentTaskRef>(response);
  await waitForAgentTask(taskObserverApi, task.taskId, { kind: 'datadir.absent' });
  return task.taskId;
}

async function listAdminDataDirs(
  api: APIRequestContext,
  serverId: string,
  userId: string,
): Promise<DataDirView[]> {
  return expectJson<DataDirView[]>(
    await api.get(`/api/admin/data-dirs?serverId=${serverId}&userId=${userId}`),
  );
}

async function expectUnauthorized(response: APIResponse): Promise<void> {
  expect(response.status(), 'anonymous storage API response body withheld').toBe(401);
}

async function createMountedContainer(
  ownerApi: APIRequestContext,
  adminApi: APIRequestContext,
  input: {
    serverId: string;
    imageId: string;
    name: string;
    sourceId: string;
    dirName: string;
    containerPath: string;
    onAllocated?: (containerId: string) => void;
  },
): Promise<{ containerId: string; createTask: AgentTaskView }> {
  const ref = await expectJson<AgentTaskRef>(
    await ownerApi.post('/api/v2/containers', {
      data: {
        serverId: input.serverId,
        imageId: input.imageId,
        name: input.name,
        dataDirs: [
          {
            sourceKind: 'local',
            sourceId: input.sourceId,
            dirName: input.dirName,
            containerPath: input.containerPath,
          },
        ],
      },
    }),
    201,
  );
  const pending = await expectJson<AgentTaskView>(
    await adminApi.get(`/api/admin/agent-tasks/${ref.taskId}`),
  );
  const containerId = pending.resourceId;
  expect(containerId).not.toBe('');
  input.onAllocated?.(containerId);
  const createTask = await waitForAgentTask(adminApi, ref.taskId, {
    kind: 'container.create',
    resourceId: containerId,
    timeoutMs: 180_000,
  });
  await waitForContainer(
    ownerApi,
    containerId,
    'running with the real local DataDir mounted',
    (container) =>
      container.runtime.bound &&
      container.runtime.status === 'running' &&
      container.activeTask === null,
    90_000,
  );
  return { containerId, createTask };
}

async function executeInContainer(
  ownerApi: APIRequestContext,
  page: Parameters<typeof executeThroughConsole>[0],
  accessToken: string,
  containerId: string,
  input: string,
  timeoutMs = 30_000,
): Promise<{ output: string; exitCode: number }> {
  const execSession = await expectJson<ConsoleSession>(
    await ownerApi.post(`/api/v2/containers/${containerId}/exec-sessions`, {
      data: { shell: '/bin/sh', tty: false },
    }),
    201,
  );
  return executeThroughConsole(
    page,
    requireRuntimeEnv('E2E_BASE_URL'),
    execSession,
    accessToken,
    input,
    timeoutMs,
  );
}

test.describe('40 storage and quota', () => {
  test(
    'api.storage.provider-owned-local-data-dir-orphan-is-detected-and-restored',
    coverageCase(
      'storage.local-quota.orphan-detection',
      'api.storage.provider-owned-local-data-dir-orphan-is-detected-and-restored',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(240_000);
      const runId = currentRunId();
      const seededServer = seedState.servers.find((server) => server.key === 'node1');
      expect(seededServer, 'CPU E2E seed has no node1').toBeDefined();
      const serverId = seededServer!.serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const initial = await expectJson<Array<{ kind: string; serverId: string }>>(
        await adminApi.get(
          `/api/admin/data-dirs/issues?sourceKind=local&sourceId=${encodeURIComponent(disk.diskId)}`,
        ),
      );
      expect(initial).toEqual([]);

      let faultAttempted = false;
      let primaryFailure: { error: unknown } | null = null;
      try {
        faultAttempted = true;
        const injected = await controlProviderFault(topologyProvider, {
          fault: 'localDataDirOrphan',
          runId,
          nodeKey: 'node1',
          action: 'inject',
        });
        expect(injected).toEqual(expect.objectContaining({
          sourceId: disk.diskId,
          sourceIdentity: disk.sourceIdentity,
          present: true,
          serviceActive: true,
        }));
        expect(injected.hostPath).toBe(
          `${disk.mountPoint}/.nyabase/dirs/${injected.resourceId}/data`,
        );

        const quarantined = await waitForStorageServer(
          adminApi,
          serverId,
          'provider orphan quarantine',
          (server) => server.status === 'agent_quarantined',
        );
        expect(quarantined.runtimeReady).toBe(false);
        expect(quarantined.quarantineCode).toBe('AGENT_INVENTORY_FAULT');
        expect(quarantined.quarantineMessage).toContain('1 orphan');

        const probed = await controlProviderFault(topologyProvider, {
          fault: 'localDataDirOrphan',
          runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        expect(probed).toEqual(expect.objectContaining({
          resourceId: injected.resourceId,
          sourceIdentity: injected.sourceIdentity,
          hostPath: injected.hostPath,
          present: true,
        }));
      } catch (error) {
        primaryFailure = { error };
      }

      let cleanupFailure: { error: unknown } | null = null;
      if (faultAttempted) {
        try {
          const restored = await controlProviderFault(topologyProvider, {
            fault: 'localDataDirOrphan',
            runId,
            nodeKey: 'node1',
            action: 'restore',
          });
          expect(restored.present).toBe(false);
          expect(restored.serviceActive).toBe(true);
          await recoverStorageInventoryFault(adminApi, serverId);
          const issues = await expectJson<Array<{ kind: string; serverId: string }>>(
            await adminApi.get(
              `/api/admin/data-dirs/issues?sourceKind=local&sourceId=${encodeURIComponent(disk.diskId)}`,
            ),
          );
          expect(issues).toEqual([]);
        } catch (error) {
          cleanupFailure = { error };
        }
      }
      if (primaryFailure !== null && cleanupFailure !== null) {
        throw aggregateErrorWithDiagnostics(
          'provider orphan behavior and restoration both failed',
          [primaryFailure.error, cleanupFailure.error],
        );
      }
      if (primaryFailure !== null) throw primaryFailure.error;
      if (cleanupFailure !== null) throw cleanupFailure.error;
    },
  );

  test(
    'api.storage.agent-reports-real-pquota-disks',
    coverageCase(
      'storage.local-quota.agent-pquota-inventory',
      'api.storage.agent-reports-real-pquota-disks',
    ),
    async ({ adminApi, seedState }) => {
      const servers = await expectJson<
        Array<{
          id: string;
          disks?: Array<{
            diskId: string;
            mountPoint: string;
            sourceIdentity: string;
            pquotaEnabled: boolean;
          }>;
        }>
      >(await adminApi.get('/api/admin/servers'));

      const seededIds = new Set(seedState.servers.map((server) => server.serverId));
      const seededServers = servers.filter((server) => seededIds.has(server.id));
      expect(seededServers).toHaveLength(2);
      for (const server of seededServers) {
        const quotaDisks = (server.disks ?? []).filter((disk) => disk.pquotaEnabled);
        expect(quotaDisks.length, `server ${server.id} has no pquota disk`).toBeGreaterThan(0);
        for (const disk of quotaDisks) {
          expect(disk.diskId).not.toBe('');
          expect(disk.mountPoint.startsWith('/')).toBe(true);
          expect(disk.sourceIdentity).not.toBe('');
        }
      }
    },
  );

  test(
    'api.storage.mount-source-inventory-comes-from-live-agent',
    coverageCase(
      'storage.local-quota.mount-source-inventory-live',
      'api.storage.mount-source-inventory-comes-from-live-agent',
    ),
    async ({ adminApi, seedState }) => {
      const serverId = seedState.servers[0].serverId;
      const source = await waitForLiveLocalMountSource(adminApi, serverId);
      expect(source).toEqual(
        expect.objectContaining({
          kind: 'local',
          id: expect.any(String),
          serverId,
          label: expect.any(String),
        }),
      );
      expect(source.id).not.toBe('');
      expect(source.label.trim()).not.toBe('');
      expect(Object.keys(source).sort()).toEqual(['kind', 'id', 'serverId', 'label'].sort());
      expect(source).not.toHaveProperty('hostRoot');
    },
  );

  test(
    'api.storage.real-xfs-quota-enforcement @core',
    coverageCase('storage.local-quota.quota-enforcement', 'api.storage.real-xfs-quota-enforcement'),
    async ({ adminApi, anonymousApi, trackedApiFactory, page, seedState }) => {
      test.setTimeout(300_000);
      const server = seedState.servers.find((entry) => entry.key === 'node1');
      expect(server).toBeDefined();
      const disk = await firstLocalDisk(adminApi, server!.serverId);
      const diskBytes = 32 * MIB;
      const dirName = dataDirName(seedState.runId, 'quota-denial');
      const containerName = resourceStem('quota-denial');
      let createdUser: CreatedStorageUser | null = null;
      let userApi: APIRequestContext | null = null;
      let userAccessToken: string | null = null;
      let dataDir: DataDirCreateResult | null = null;
      let containerId: string | null = null;

      try {
        createdUser = await createStorageUser(adminApi, 'quota');
        expect(createdUser.user).toEqual(
          expect.objectContaining({
            status: 'active',
            capabilities: [],
          }),
        );
        const login = await loginStorageUser(anonymousApi, trackedApiFactory, createdUser);
        userApi = login.api;
        userAccessToken = login.accessToken;

        const quotaTasks = await grantStorageAccess(adminApi, {
          userId: createdUser.user.id,
          serverId: server!.serverId,
          sourceId: disk.diskId,
          imageId: seedState.image.id,
          diskBytes,
        });
        expect(quotaTasks).toHaveLength(1);
        expect(quotaTasks[0]).toEqual(
          expect.objectContaining({
            kind: 'quota.ensure',
            resourceId: createdUser.user.id,
            serverId: server!.serverId,
            status: 'succeeded',
            result: expect.objectContaining({
              numericUserId: expect.any(Number),
              hardLimitBytes: diskBytes,
            }),
          }),
        );
        const observedQuota = await expectJson<{ usedBytes: number; limitBytes: number }>(
          await userApi.get(`/api/servers/${server!.serverId}/quota`),
        );
        expect(observedQuota.limitBytes).toBe(diskBytes);
        expect(observedQuota.usedBytes).toBeGreaterThanOrEqual(0);

        dataDir = await createUserDataDir(userApi, {
          serverId: server!.serverId,
          sourceId: disk.diskId,
          name: dirName,
        });
        const dataDirTask = await waitForAgentTask(adminApi, dataDir.taskId, {
          kind: 'datadir.ensure',
          resourceId: dataDir.id,
        });
        expect(dataDirTask.result).toEqual(
          expect.objectContaining({
            exists: true,
            quotaAssigned: true,
          }),
        );

        const mounted = await createMountedContainer(userApi, adminApi, {
          serverId: server!.serverId,
          imageId: seedState.image.id,
          name: containerName,
          sourceId: disk.diskId,
          dirName,
          containerPath: '/quota',
          onAllocated: (allocated) => {
            containerId = allocated;
          },
        });
        containerId = mounted.containerId;
        expect(mounted.createTask.result).toEqual(
          expect.objectContaining({
            containerId,
            runtimeId: expect.any(String),
          }),
        );

        const write = await executeInContainer(
          userApi,
          page,
          userAccessToken,
          containerId,
          [
            'set +e',
            'error="$(dd if=/dev/zero of=/quota/limit-probe bs=1048576 count=64 conv=fsync 2>&1)"',
            'rc=$?',
            'printf "NYABASE_DD_EXIT=%s\\n" "$rc"',
            'printf "%s\\n" "$error"',
            'case "$error" in',
            '  *"No space left on device"*) printf "NYABASE_ERRNO=ENOSPC\\n" ;;',
            '  *"Disk quota exceeded"*|*"Quota exceeded"*) printf "NYABASE_ERRNO=EDQUOT\\n" ;;',
            '  *) printf "NYABASE_ERRNO=OTHER\\n" ;;',
            'esac',
            'rm -f /quota/limit-probe',
            'exit 0',
            '',
          ].join('\n'),
          60_000,
        );
        expect(write.exitCode).toBe(0);
        expect(write.output).toMatch(/NYABASE_DD_EXIT=[1-9][0-9]*/);
        expect(write.output).toMatch(/NYABASE_ERRNO=(ENOSPC|EDQUOT)/);
        expect(write.output).not.toContain('NYABASE_ERRNO=OTHER');
      } finally {
        await runCleanupSteps('quota enforcement cleanup', [
          async () => {
            if (containerId && userApi) {
              await cleanupContainerThroughProductApi(userApi, containerId, adminApi);
            }
          },
          async () => {
            if (dataDir && userApi) {
              await deleteUserDataDir(
                userApi,
                {
                  serverId: server!.serverId,
                  sourceId: disk.diskId,
                  name: dirName,
                },
                adminApi,
              );
            }
          },
          async () => {
            if (createdUser) {
              await cleanupStorageUserAccess(adminApi, {
                userId: createdUser.user.id,
                serverId: server!.serverId,
                sourceId: disk.diskId,
                imageId: seedState.image.id,
              });
            }
          },
        ]);
      }
    },
  );

  test(
    'api.storage.local-mount-persists-across-container-restart @core',
    coverageCase(
      'storage.local-quota.mount-persistence',
      'api.storage.local-mount-persists-across-container-restart',
    ),
    async ({ adminApi, adminSession, page, seedState }) => {
      test.setTimeout(300_000);
      const server = seedState.servers.find((entry) => entry.key === 'node1');
      expect(server).toBeDefined();
      const disk = await firstLocalDisk(adminApi, server!.serverId);
      const dirName = dataDirName(seedState.runId, 'restart-persistence');
      const input = {
        serverId: server!.serverId,
        sourceId: disk.diskId,
        userId: seedState.adminUserId,
        name: dirName,
      };
      const marker = resourceStem('persistent-content');
      let dataDir: DataDirCreateResult | null = null;
      let containerId: string | null = null;

      try {
        dataDir = await createAdminDataDir(adminApi, input);
        await waitForAgentTask(adminApi, dataDir.taskId, {
          kind: 'datadir.ensure',
          resourceId: dataDir.id,
        });
        const mounted = await createMountedContainer(adminApi, adminApi, {
          serverId: server!.serverId,
          imageId: seedState.image.id,
          name: resourceStem('restart-persistence'),
          sourceId: disk.diskId,
          dirName,
          containerPath: '/persist',
          onAllocated: (allocated) => {
            containerId = allocated;
          },
        });
        containerId = mounted.containerId;
        const beforeRestart = await getContainerOrNull(adminApi, containerId);
        expect(beforeRestart?.runtime.runtimeId).toEqual(expect.any(String));

        const write = await executeInContainer(
          adminApi,
          page,
          adminSession.accessToken,
          containerId,
          `printf '%s\\n' '${marker}' > /persist/restart-marker; sync; exit\n`,
        );
        expect(write.exitCode).toBe(0);

        const restartRef = await requestContainerAction(adminApi, containerId, 'restart');
        const restartTask = await waitForAgentTask(adminApi, restartRef.taskId, {
          kind: 'container.restart',
          resourceId: containerId,
        });
        expect(restartTask.result).toEqual(
          expect.objectContaining({
            containerId,
            runtimeId: beforeRestart!.runtime.runtimeId,
          }),
        );
        const restarted = await waitForContainer(
          adminApi,
          containerId,
          'running after restart with the same mounted DataDir',
          (container) =>
            container.runtime.bound &&
            container.runtime.status === 'running' &&
            container.powerIntent === 'running' &&
            container.activeTask === null,
          90_000,
        );
        expect(restarted.runtime.runtimeId).toBe(beforeRestart!.runtime.runtimeId);

        const read = await executeInContainer(
          adminApi,
          page,
          adminSession.accessToken,
          containerId,
          'cat /persist/restart-marker; exit\n',
        );
        expect(read.exitCode).toBe(0);
        expect(read.output.trim()).toBe(marker);
      } finally {
        await runCleanupSteps('mount persistence cleanup', [
          async () => {
            if (containerId) {
              await cleanupContainerThroughProductApi(adminApi, containerId);
              expect(await getContainerOrNull(adminApi, containerId)).toBeNull();
            }
          },
          async () => {
            if (dataDir) await deleteAdminDataDir(adminApi, input);
          },
        ]);
      }
    },
  );

  test(
    'api.storage.ordinary-users-cannot-read-or-delete-each-others-data-dir @core',
    coverageCase(
      'storage.local-quota.ownership-isolation',
      'api.storage.ordinary-users-cannot-read-or-delete-each-others-data-dir',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(300_000);
      const server = seedState.servers.find((entry) => entry.key === 'node1');
      expect(server).toBeDefined();
      const disk = await firstLocalDisk(adminApi, server!.serverId);
      const dirName = dataDirName(seedState.runId, 'owner-a-only');
      let userA: CreatedStorageUser | null = null;
      let userB: CreatedStorageUser | null = null;
      let apiA: APIRequestContext | null = null;
      let apiB: APIRequestContext | null = null;
      let dataDir: DataDirCreateResult | null = null;

      try {
        userA = await createStorageUser(adminApi, 'owner-a');
        userB = await createStorageUser(adminApi, 'owner-b');
        expect(userA.user.capabilities).toEqual([]);
        expect(userB.user.capabilities).toEqual([]);
        apiA = (await loginStorageUser(anonymousApi, trackedApiFactory, userA)).api;
        apiB = (await loginStorageUser(anonymousApi, trackedApiFactory, userB)).api;

        const [tasksA, tasksB] = await Promise.all([
          grantStorageAccess(adminApi, {
            userId: userA.user.id,
            serverId: server!.serverId,
            sourceId: disk.diskId,
            diskBytes: 128 * MIB,
          }),
          grantStorageAccess(adminApi, {
            userId: userB.user.id,
            serverId: server!.serverId,
            sourceId: disk.diskId,
            diskBytes: 128 * MIB,
          }),
        ]);
        expect(tasksA).toHaveLength(1);
        expect(tasksB).toHaveLength(1);

        dataDir = await createUserDataDir(apiA, {
          serverId: server!.serverId,
          sourceId: disk.diskId,
          name: dirName,
        });
        await waitForAgentTask(adminApi, dataDir.taskId, {
          kind: 'datadir.ensure',
          resourceId: dataDir.id,
        });

        const ownerRows = await expectJson<DataDirView[]>(
          await apiA.get(`/api/data-dirs?serverId=${server!.serverId}`),
        );
        expect(ownerRows).toContainEqual(
          expect.objectContaining({
            id: dataDir.id,
            userId: userA.user.id,
            desiredState: 'active',
          }),
        );

        const foreignRows = await expectJson<DataDirView[]>(
          await apiB.get(
            `/api/data-dirs?serverId=${server!.serverId}&userId=${encodeURIComponent(userA.user.id)}`,
          ),
        );
        expect(foreignRows.some((row) => row.id === dataDir!.id)).toBe(false);
        expect(foreignRows.every((row) => row.userId === userB!.user.id)).toBe(true);

        const foreignDelete = await apiB.delete(
          `/api/data-dirs/${server!.serverId}/${disk.diskId}/${dirName}?sourceKind=local` +
            `&userId=${encodeURIComponent(userA.user.id)}`,
        );
        if (foreignDelete.status() === 200) {
          const unexpectedTask = await expectJson<AgentTaskRef>(foreignDelete);
          await waitForAgentTask(adminApi, unexpectedTask.taskId, { kind: 'datadir.absent' });
        }
        expect(foreignDelete.status(), 'cross-user delete response body withheld').toBe(404);

        const [adminRowsA, adminRowsB] = await Promise.all([
          listAdminDataDirs(adminApi, server!.serverId, userA.user.id),
          listAdminDataDirs(adminApi, server!.serverId, userB.user.id),
        ]);
        expect(adminRowsA.some((row) => row.id === dataDir!.id)).toBe(true);
        expect(adminRowsB.some((row) => row.id === dataDir!.id)).toBe(false);
      } finally {
        await runCleanupSteps('ownership isolation cleanup', [
          async () => {
            if (dataDir && apiA) {
              await deleteUserDataDir(
                apiA,
                {
                  serverId: server!.serverId,
                  sourceId: disk.diskId,
                  name: dirName,
                },
                adminApi,
              );
            }
          },
          async () => {
            if (userB) {
              await cleanupStorageUserAccess(adminApi, {
                userId: userB.user.id,
                serverId: server!.serverId,
                sourceId: disk.diskId,
              });
            }
          },
          async () => {
            if (userA) {
              await cleanupStorageUserAccess(adminApi, {
                userId: userA.user.id,
                serverId: server!.serverId,
                sourceId: disk.diskId,
              });
            }
          },
        ]);
      }
    },
  );

  test(
    'api.storage.concurrent-same-name-create-has-single-winner @core',
    coverageCase(
      'storage.local-quota.concurrent-mutation',
      'api.storage.concurrent-same-name-create-has-single-winner',
    ),
    async ({ adminApi, seedState }) => {
      test.setTimeout(180_000);
      const serverId = seedState.servers[0].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const name = dataDirName(seedState.runId, `concurrent-${Date.now().toString(36)}`);
      const input = {
        serverId,
        sourceId: disk.diskId,
        userId: seedState.adminUserId,
        name,
      };
      const created: DataDirCreateResult[] = [];

      try {
        const responses = await Promise.all([
          adminApi.post('/api/admin/data-dirs', {
            data: { ...input, sourceKind: 'local' },
          }),
          adminApi.post('/api/admin/data-dirs', {
            data: { ...input, sourceKind: 'local' },
          }),
        ]);
        const statuses = responses.map((response) => response.status()).sort((a, b) => a - b);
        for (const response of responses) {
          if (response.status() === 201) {
            created.push(await expectJson<DataDirCreateResult>(response, 201));
          }
        }
        for (const row of created) {
          await waitForAgentTask(adminApi, row.taskId, {
            kind: 'datadir.ensure',
            resourceId: row.id,
          });
        }

        expect(statuses).toEqual([201, 409]);
        expect(created).toHaveLength(1);
        const rows = await listAdminDataDirs(adminApi, serverId, seedState.adminUserId);
        expect(
          rows.filter(
            (row) =>
              row.sourceKind === 'local' && row.sourceId === disk.diskId && row.name === name,
          ),
        ).toEqual([
          expect.objectContaining({
            id: created[0].id,
            desiredState: 'active',
          }),
        ]);
      } finally {
        for (const row of created) {
          try {
            await waitForAgentTask(adminApi, row.taskId, { timeoutMs: 120_000 });
          } catch {
            // The primary task failure remains the test outcome. Once terminal,
            // product deletion can still reconcile a failed DataDir reservation.
          }
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if ((await deleteAdminDataDir(adminApi, input)) === null) break;
        }
      }
    },
  );

  test(
    'api.storage.real-data-directory-lifecycle @core',
    coverageCase(
      'storage.local-quota.data-directory-lifecycle',
      'api.storage.real-data-directory-lifecycle',
    ),
    async ({ adminApi, seedState }) => {
      const serverId = seedState.servers[0].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const name = dataDirName(seedState.runId, 'lifecycle');
      const input = { serverId, sourceId: disk.diskId, userId: seedState.adminUserId, name };
      const created = await createAdminDataDir(adminApi, input);
      try {
        const ensure = await waitForAgentTask(adminApi, created.taskId, {
          kind: 'datadir.ensure',
          resourceId: created.id,
        });
        expect(ensure.result).toEqual(
          expect.objectContaining({
            exists: true,
            isDirectory: true,
            resourceId: created.id,
            quotaAssigned: true,
          }),
        );
        const active = (await listAdminDataDirs(adminApi, serverId, seedState.adminUserId)).find(
          (entry) => entry.id === created.id,
        );
        expect(active).toEqual(
          expect.objectContaining({
            desiredState: 'active',
            lastTaskId: created.taskId,
            hostPath: created.hostPath,
          }),
        );
        const deleteTaskId = await deleteAdminDataDir(adminApi, input);
        expect(deleteTaskId).not.toBeNull();
        expect(
          (await listAdminDataDirs(adminApi, serverId, seedState.adminUserId)).some(
            (entry) => entry.id === created.id,
          ),
        ).toBe(false);
      } finally {
        await deleteAdminDataDir(adminApi, input);
      }
    },
  );

  test(
    'api.storage.real-xfs-project-assignment @core',
    coverageCase(
      'storage.local-quota.xfs-project-assignment',
      'api.storage.real-xfs-project-assignment',
    ),
    async ({ adminApi, seedState }) => {
      const serverId = seedState.servers[1].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const input = {
        serverId,
        sourceId: disk.diskId,
        userId: seedState.adminUserId,
        name: dataDirName(seedState.runId, 'project-assignment'),
      };
      const created = await createAdminDataDir(adminApi, input);
      try {
        const task = await waitForAgentTask(adminApi, created.taskId, {
          kind: 'datadir.ensure',
          resourceId: created.id,
        });
        expect(task.result).toEqual(
          expect.objectContaining({
            path: created.hostPath,
            exists: true,
            isDirectory: true,
            uid: 1000,
            resourceId: created.id,
            quotaAssigned: true,
          }),
        );
      } finally {
        await deleteAdminDataDir(adminApi, input);
      }
    },
  );

  test(
    'api.storage.local-source-grant-lifecycle @core',
    coverageCase(
      'storage.local-quota.local-source-grants',
      'api.storage.local-source-grant-lifecycle',
    ),
    async ({ adminApi, seedState }) => {
      const serverId = seedState.servers[0].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const grantPath = `/api/admin/mount-sources/grants/local/${disk.diskId}`;
      const grantsPath =
        `/api/admin/mount-sources/grants?sourceKind=local&sourceId=${disk.diskId}&serverId=${serverId}`;
      try {
        const removed = await adminApi.delete(
          `${grantPath}/user/${seedState.adminUserId}?serverId=${serverId}`,
        );
        expect(removed.status()).toBe(204);
        expect(
          await expectJson<MountSourceGrant[]>(
            await adminApi.get(grantsPath),
          ),
        ).not.toContainEqual(
          expect.objectContaining({
            scope: 'user',
            scopeId: seedState.adminUserId,
          }),
        );

        const grant = await expectJson<MountSourceGrant>(
          await adminApi.post(grantPath, {
            data: { scope: 'user', scopeId: seedState.adminUserId, serverId },
          }),
          201,
        );
        expect(grant).toEqual(
          expect.objectContaining({
            scope: 'user',
            scopeId: seedState.adminUserId,
            sourceKind: 'local',
            sourceId: disk.diskId,
            serverId,
            sourceIdentity: disk.sourceIdentity,
          }),
        );
        const grants = await expectJson<MountSourceGrant[]>(
          await adminApi.get(grantsPath),
        );
        expect(grants.some((entry) => entry.id === grant.id)).toBe(true);
      } finally {
        // Restore the run fixture because later user-facing DataDir cases must
        // traverse the same explicit source authorization.
        const grants = await expectJson<MountSourceGrant[]>(
          await adminApi.get(grantsPath),
        );
        const fixtureGrantPresent = grants.some((entry) =>
          entry.scope === 'user'
          && entry.scopeId === seedState.adminUserId
          && entry.serverId === serverId);
        if (!fixtureGrantPresent) {
          await expectJson<MountSourceGrant>(
            await adminApi.post(grantPath, {
              data: { scope: 'user', scopeId: seedState.adminUserId, serverId },
            }),
            201,
          );
        }
      }
    },
  );

  test(
    'api.storage.admin-create-data-dir @core',
    coverageCase(
      'storage.local-quota.http.post.api-admin-data-dirs',
      'api.storage.admin-create-data-dir',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      const serverId = seedState.servers[0].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const input = {
        serverId,
        sourceId: disk.diskId,
        userId: seedState.adminUserId,
        name: dataDirName(seedState.runId, 'admin-post'),
      };
      await expectUnauthorized(
        await anonymousApi.post('/api/admin/data-dirs', {
          data: { ...input, sourceKind: 'local' },
        }),
      );
      const created = await createAdminDataDir(adminApi, input);
      try {
        const task = await waitForAgentTask(adminApi, created.taskId, { kind: 'datadir.ensure' });
        expect(task.result).toEqual(expect.objectContaining({ exists: true, quotaAssigned: true }));
      } finally {
        await deleteAdminDataDir(adminApi, input);
      }
    },
  );

  test(
    'api.storage.admin-list-data-dirs @core',
    coverageCase(
      'storage.local-quota.http.get.api-admin-data-dirs',
      'api.storage.admin-list-data-dirs',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      const serverId = seedState.servers[0].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const input = {
        serverId,
        sourceId: disk.diskId,
        userId: seedState.adminUserId,
        name: dataDirName(seedState.runId, 'admin-get'),
      };
      const created = await createAdminDataDir(adminApi, input);
      try {
        await waitForAgentTask(adminApi, created.taskId, { kind: 'datadir.ensure' });
        await expectUnauthorized(
          await anonymousApi.get(
            `/api/admin/data-dirs?serverId=${serverId}&userId=${seedState.adminUserId}`,
          ),
        );
        const rows = await listAdminDataDirs(adminApi, serverId, seedState.adminUserId);
        expect(rows.some((row) => row.id === created.id && row.desiredState === 'active')).toBe(
          true,
        );
      } finally {
        await deleteAdminDataDir(adminApi, input);
      }
    },
  );

  test(
    'api.storage.admin-data-dir-issues @core',
    coverageCase(
      'storage.local-quota.http.get.api-admin-data-dirs-issues',
      'api.storage.admin-data-dir-issues',
    ),
    async ({ adminApi, anonymousApi }) => {
      await expectUnauthorized(
        await anonymousApi.get('/api/admin/data-dirs/issues?sourceKind=local'),
      );
      const issues = await expectJson<Array<{ kind: string; serverId: string }>>(
        await adminApi.get('/api/admin/data-dirs/issues?sourceKind=local'),
      );
      expect(issues).toEqual([]);
    },
  );

  test(
    'api.storage.admin-delete-data-dir @core',
    coverageCase(
      'storage.local-quota.http.delete.api-admin-data-dirs-by-serverid-by-sourceid-by-name',
      'api.storage.admin-delete-data-dir',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      const serverId = seedState.servers[0].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const input = {
        serverId,
        sourceId: disk.diskId,
        userId: seedState.adminUserId,
        name: dataDirName(seedState.runId, 'admin-delete'),
      };
      const created = await createAdminDataDir(adminApi, input);
      try {
        await waitForAgentTask(adminApi, created.taskId, { kind: 'datadir.ensure' });
        await expectUnauthorized(
          await anonymousApi.delete(
            `/api/admin/data-dirs/${serverId}/${disk.diskId}/${input.name}` +
              `?sourceKind=local&userId=${seedState.adminUserId}`,
          ),
        );
        const taskId = await deleteAdminDataDir(adminApi, input);
        expect(taskId).not.toBeNull();
        expect(
          (await listAdminDataDirs(adminApi, serverId, seedState.adminUserId)).some(
            (row) => row.id === created.id,
          ),
        ).toBe(false);
      } finally {
        await deleteAdminDataDir(adminApi, input);
      }
    },
  );

  test(
    'api.storage.user-create-data-dir @core',
    coverageCase('storage.local-quota.http.post.api-data-dirs', 'api.storage.user-create-data-dir'),
    async ({ adminApi, anonymousApi, seedState }) => {
      const serverId = seedState.servers[1].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const input = {
        serverId,
        sourceId: disk.diskId,
        name: dataDirName(seedState.runId, 'user-post'),
      };
      await expectUnauthorized(
        await anonymousApi.post('/api/data-dirs', {
          data: { ...input, sourceKind: 'local' },
        }),
      );
      const created = await createUserDataDir(adminApi, input);
      try {
        const task = await waitForAgentTask(adminApi, created.taskId, { kind: 'datadir.ensure' });
        expect(task.result).toEqual(expect.objectContaining({ exists: true, quotaAssigned: true }));
      } finally {
        await deleteUserDataDir(adminApi, input);
      }
    },
  );

  test(
    'api.storage.user-list-data-dirs @core',
    coverageCase('storage.local-quota.http.get.api-data-dirs', 'api.storage.user-list-data-dirs'),
    async ({ adminApi, anonymousApi, seedState }) => {
      const serverId = seedState.servers[1].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const input = {
        serverId,
        sourceId: disk.diskId,
        name: dataDirName(seedState.runId, 'user-get'),
      };
      const created = await createUserDataDir(adminApi, input);
      try {
        await waitForAgentTask(adminApi, created.taskId, { kind: 'datadir.ensure' });
        await expectUnauthorized(await anonymousApi.get(`/api/data-dirs?serverId=${serverId}`));
        const rows = await expectJson<DataDirView[]>(
          await adminApi.get(`/api/data-dirs?serverId=${serverId}`),
        );
        expect(
          rows.some((row) => row.id === created.id && row.userId === seedState.adminUserId),
        ).toBe(true);
      } finally {
        await deleteUserDataDir(adminApi, input);
      }
    },
  );

  test(
    'api.storage.user-delete-data-dir @core',
    coverageCase(
      'storage.local-quota.http.delete.api-data-dirs-by-serverid-by-sourceid-by-name',
      'api.storage.user-delete-data-dir',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      const serverId = seedState.servers[1].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      const input = {
        serverId,
        sourceId: disk.diskId,
        name: dataDirName(seedState.runId, 'user-delete'),
      };
      const created = await createUserDataDir(adminApi, input);
      try {
        await waitForAgentTask(adminApi, created.taskId, { kind: 'datadir.ensure' });
        await expectUnauthorized(
          await anonymousApi.delete(
            `/api/data-dirs/${serverId}/${disk.diskId}/${input.name}?sourceKind=local`,
          ),
        );
        const taskId = await deleteUserDataDir(adminApi, input);
        expect(taskId).not.toBeNull();
        const rows = await expectJson<DataDirView[]>(
          await adminApi.get(`/api/data-dirs?serverId=${serverId}`),
        );
        expect(rows.some((row) => row.id === created.id)).toBe(false);
      } finally {
        await deleteUserDataDir(adminApi, input);
      }
    },
  );

  test(
    'api.storage.user-list-mount-sources @core',
    coverageCase(
      'storage.local-quota.http.get.api-mount-sources',
      'api.storage.user-list-mount-sources',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      const serverId = seedState.servers[0].serverId;
      const disk = await firstLocalDisk(adminApi, serverId);
      await expectUnauthorized(await anonymousApi.get(`/api/mount-sources?serverId=${serverId}`));
      const sources = await expectJson<LiveMountSource[]>(
        await adminApi.get(`/api/mount-sources?serverId=${serverId}`),
      );
      const source = sources.find((candidate) => (
        candidate.kind === 'local' && candidate.id === disk.diskId
      ));
      expect(source).toEqual(expect.objectContaining({
        kind: 'local',
        id: disk.diskId,
        serverId,
        label: expect.any(String),
      }));
      expect(Object.keys(source!).sort()).toEqual(['kind', 'id', 'serverId', 'label'].sort());
      expect(source).not.toHaveProperty('hostRoot');
    },
  );
});
