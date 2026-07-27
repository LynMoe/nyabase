import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import {
  waitForAgentTask,
  waitForContainer,
  type AgentTaskRef,
  type AgentTaskView,
  type ContainerView,
  type UserAgentTaskView,
} from '../../support/durable-api.js';
import { expectJson } from '../../support/http.js';
import { aggregateErrorWithDiagnostics } from '../../support/error-diagnostics.mjs';
import {
  AbsoluteDeadline,
  cleanupImageLease,
  cleanupOwnedContainer,
  expectStatus,
  resolveContainerId,
  resolveServerIdsBySlugs,
  runCleanupSteps,
  type ContainerIdentity,
} from '../../support/servers-images-lease.js';
import {
  createStandardPersona,
  type StandardPersonaLease,
  type TrackedApiFactory,
} from '../../support/servers-images-persona.js';
import { controlProviderFault } from '../../support/provider-fault-control.js';
import type {
  AgentTaskWireFaultControlInput,
  AgentTaskWireFaultControlResult,
  AvailableTopologyProvider,
} from '../../topology/provider.js';
import type { APIRequestContext, APIResponse } from '@playwright/test';

interface ServerView {
  id: string;
  name: string;
  slug: string;
  hostFingerprint?: string | null;
  status: string;
  lastSeenAt?: string | null;
  runtimeReady: boolean;
  runtimeObservedAt?: string | null;
  gpus?: unknown[];
  disks?: Array<{
    diskId: string;
    mountPoint: string;
    sourceIdentity: string;
    pquotaEnabled: boolean;
  }>;
  dockerDaemon?: {
    state?: string;
    active?: boolean;
    socketPath?: string;
    storageDriver?: string;
  } | null;
}

interface UserServerView {
  id: string;
  name: string;
  slug: string;
  status: string;
  lastSeenAt: string | null;
  runtimeReady: boolean;
}

interface UserDiskView {
  diskId: string;
  displayName: string;
  totalBytes: number;
  usedBytes: number;
  pquotaEnabled: boolean;
}

interface AdminAllDiskView {
  diskId: string;
  serverId: string;
  mountPoint: string;
  sourceIdentity: string;
  label: string | null;
}

interface CreatedServer {
  server: ServerView;
  agentToken: string;
}

interface ImageView {
  id: string;
  revision: number;
  name: string;
  dockerImage: string;
  description: string | null;
  isActive: boolean;
  deleting: boolean;
  disableSsh: boolean;
}

interface ImageTaskRef extends AgentTaskRef {
  serverId: string;
}

interface ImagePullResponse {
  tasks: ImageTaskRef[];
  rejected: Array<{ serverId: string; message: string }>;
}

interface MutableImageIdentity {
  id: string | null;
  name: string;
}

interface CreatedUser {
  id: string;
  username: string;
}

interface UserLogin {
  accessToken: string;
}

let imageSequence = 0;
const cleanupBudgetMs = 120_000;
const rawServerEntityFields = [
  'agentTokenHash',
  'agentConfigFingerprint',
  'macvlanCidr',
  'macvlanGateway',
  'macvlanReservedIps',
  'createdAt',
  'updatedAt',
] as const;

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function expectNoRawServerEntityFields(value: object): void {
  for (const field of rawServerEntityFields) expect(value).not.toHaveProperty(field);
}

function scopedSlug(runId: string, suffix: string): string {
  const base = runId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 40);
  return `${base}-${suffix}`.slice(0, 64);
}

async function createTemporaryServer(
  api: APIRequestContext,
  runId: string,
  suffix: string,
): Promise<CreatedServer> {
  return expectJson<CreatedServer>(
    await api.post('/api/admin/servers', {
      data: {
        name: `${runId} ${suffix}`,
        slug: scopedSlug(runId, suffix),
      },
    }),
    201,
  );
}

async function deleteTemporaryServer(
  api: APIRequestContext,
  serverId: string,
  deadline?: AbsoluteDeadline,
): Promise<void> {
  const response = await api.delete(
    `/api/admin/servers/${serverId}`,
    deadline
      ? { timeout: deadline.remaining(`deleting temporary Server ${serverId}`, 30_000) }
      : undefined,
  );
  if (response.status() === 404) return;
  expect(response.status(), 'temporary Server cleanup response body withheld').toBe(204);
}

function imageName(runId: string, suffix: string): string {
  imageSequence += 1;
  return `${runId} ${suffix} ${imageSequence}`.slice(0, 128);
}

async function createDisposableImage(
  api: APIRequestContext,
  runId: string,
  dockerImage: string,
  suffix: string,
  identity?: MutableImageIdentity,
): Promise<ImageView> {
  const name = identity?.name ?? imageName(runId, suffix);
  const image = await expectJson<ImageView>(
    await api.post('/api/admin/images', {
      data: {
        name,
        dockerImage,
        description: `real CPU E2E ${suffix}`,
        disableSsh: true,
      },
    }),
    201,
  );
  if (identity) identity.id = image.id;
  return image;
}

function trackedImage(runId: string, suffix: string): MutableImageIdentity {
  return { id: null, name: imageName(runId, suffix) };
}

async function waitForServerProjection(
  api: APIRequestContext,
  serverId: string,
  description: string,
  accept: (server: ServerView) => boolean,
  deadline: AbsoluteDeadline,
): Promise<ServerView> {
  const expiresAt = Date.now() + deadline.remaining(`waiting for ${description}`, 90_000);
  let last: ServerView | null = null;
  while (Date.now() < expiresAt) {
    last = await expectJson<ServerView>(await api.get(`/api/admin/servers/${serverId}`));
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server ${serverId} did not reach ${description}; last=${JSON.stringify(last)}`);
}

async function observeTaskPendingAndUnsent(
  api: APIRequestContext,
  taskId: string,
  deadline: AbsoluteDeadline,
): Promise<AgentTaskView> {
  const observationUntil =
    Date.now() + deadline.remaining(`observing offline task ${taskId}`, 2_000);
  let last: AgentTaskView | null = null;
  while (Date.now() < observationUntil) {
    last = await expectJson<AgentTaskView>(await api.get(`/api/admin/agent-tasks/${taskId}`));
    expect(last).toEqual(
      expect.objectContaining({
        id: taskId,
        status: 'pending',
        startedAt: null,
        lastSentAt: null,
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        dispatchAttemptCount: 0,
        completedAt: null,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!last) throw new Error(`offline task ${taskId} was never observable`);
  return last;
}

async function waitForAgentTaskWireEvidence(
  provider: AvailableTopologyProvider,
  input: Omit<AgentTaskWireFaultControlInput, 'action'>,
  description: string,
  accept: (result: AgentTaskWireFaultControlResult) => boolean,
  deadline: AbsoluteDeadline,
): Promise<AgentTaskWireFaultControlResult> {
  const expiresAt = Date.now() + deadline.remaining(`waiting for ${description}`, 90_000);
  let last: AgentTaskWireFaultControlResult | null = null;
  while (Date.now() < expiresAt) {
    last = await controlProviderFault(provider, { ...input, action: 'probe' });
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Agent task wire evidence did not reach ${description}; last=${JSON.stringify(last)}`,
  );
}

function expectAdminDispatchEvidence(
  adminTask: AgentTaskView,
  userTask: UserAgentTaskView,
): void {
  const {
    requestedBy,
    request,
    agentResult,
    result,
    payloadHash,
    dispatchAttemptCount,
    error: adminError,
    ...sharedAdminProjection
  } = adminTask;
  const { error: userError, ...sharedUserProjection } = userTask;
  expect(adminTask).toHaveProperty('requestedBy');
  expect(adminTask).toHaveProperty('request');
  expect(adminTask).toHaveProperty('agentResult');
  expect(adminTask).toHaveProperty('result');
  expect(requestedBy === null || typeof requestedBy === 'string').toBe(true);
  void request;
  void agentResult;
  void result;
  expect(payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(Number.isSafeInteger(dispatchAttemptCount)).toBe(true);
  expect(dispatchAttemptCount).toBeGreaterThanOrEqual(1);
  for (const field of [
    'requestedBy',
    'request',
    'agentResult',
    'result',
    'payloadHash',
    'dispatchAttemptCount',
  ]) {
    expect(userTask).not.toHaveProperty(field);
  }
  expect(sharedUserProjection).toEqual(sharedAdminProjection);
  if (adminError === null) {
    expect(userError).toBeNull();
  } else {
    const requesterError = adminTask.failureStage === 'dispatch'
      ? {
          code: 'TASK_DISPATCH_FAILED',
          message: 'The task could not be sent to the server',
        }
      : adminTask.failureStage === 'agent'
        ? {
            code: 'TASK_EXECUTION_FAILED',
            message: 'The server could not complete the task',
          }
        : adminTask.failureStage === 'finalizer'
          ? {
              code: 'TASK_FINALIZATION_FAILED',
              message: 'The server completed the task, but control-plane finalization failed',
            }
          : { code: 'TASK_FAILED', message: 'The task failed' };
    expect(userError).toEqual(requesterError);
  }
}

async function waitForTaskTerminal(
  api: APIRequestContext,
  taskId: string,
  timeoutMs = 120_000,
): Promise<AgentTaskView> {
  const deadline = Date.now() + timeoutMs;
  let last: AgentTaskView | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<AgentTaskView>(await api.get(`/api/admin/agent-tasks/${taskId}`));
    if (last.status !== 'pending') return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `task ${taskId} did not become terminal; last status=${last?.status ?? 'missing'}`,
  );
}

async function waitForImageAbsent(
  api: APIRequestContext,
  imageId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api.get(`/api/admin/images/${imageId}`);
    if (response.status() === 404) return;
    expect(response.status(), 'image cleanup status response body withheld').toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`image ${imageId} remained after every ensure-absent task settled`);
}

async function waitForImagePresentOnServers(
  api: APIRequestContext,
  imageId: string,
  serverIds: ReadonlySet<string>,
  timeoutMs: number,
): Promise<Array<{ serverId: string; present: boolean }>> {
  const expiresAt = Date.now() + timeoutMs;
  let last: Array<{ serverId: string; present: boolean }> = [];
  while (Date.now() < expiresAt) {
    last = await expectJson<Array<{ serverId: string; present: boolean }>>(
      await api.get(`/api/admin/images/${imageId}/status`),
    );
    const observed = last.filter((status) => serverIds.has(status.serverId));
    if (
      observed.length === serverIds.size &&
      new Set(observed.map((status) => status.serverId)).size === serverIds.size &&
      observed.every((status) => status.present)
    ) {
      return observed;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `image ${imageId} inventory did not converge to present on every expected Server; ` +
      `last=${JSON.stringify(last)}`,
  );
}

async function deleteDisposableImage(
  api: APIRequestContext,
  imageId: string,
  deadline = new AbsoluteDeadline(120_000),
): Promise<AgentTaskView[]> {
  const response = await api.delete(`/api/admin/images/${imageId}`);
  if (response.status() === 404) return [];
  const deleted = await expectJson<{ tasks: ImageTaskRef[] }>(response, 202);
  const tasks = await Promise.all(
    deleted.tasks.map((task) =>
      waitForAgentTask(api, task.taskId, {
        kind: 'image.ensure_absent',
        resourceId: imageId,
        timeoutMs: deadline.remaining(`waiting for image ${imageId} cleanup task`, 120_000),
      }),
    ),
  );
  await waitForImageAbsent(
    api,
    imageId,
    deadline.remaining(`waiting for image ${imageId} absence`, 120_000),
  );
  return tasks;
}

async function settleTaskIds(
  api: APIRequestContext,
  taskIds: readonly string[],
  deadline?: AbsoluteDeadline,
): Promise<void> {
  for (const taskId of [...new Set(taskIds)]) {
    await waitForAgentTask(
      api,
      taskId,
      deadline ? { timeoutMs: deadline.remaining(`settling task ${taskId}`, 60_000) } : {},
    );
  }
}

async function deleteUser(
  api: APIRequestContext,
  userId: string,
  deadline?: AbsoluteDeadline,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const exists = await api.get(
      `/api/admin/users/${userId}`,
      deadline
        ? { timeout: deadline.remaining(`checking cleanup user ${userId}`, 30_000) }
        : undefined,
    );
    if (exists.status() === 404) return;
    expect(exists.status(), 'user cleanup status response body withheld').toBe(200);
    const result = await expectJson<{ deleted: boolean; taskIds: string[] }>(
      await api.delete(
        `/api/admin/users/${userId}`,
        deadline
          ? { timeout: deadline.remaining(`deleting cleanup user ${userId}`, 30_000) }
          : undefined,
      ),
    );
    await settleTaskIds(api, result.taskIds, deadline);
    if (result.deleted) return;
  }
  expect(
    (
      await api.get(
        `/api/admin/users/${userId}`,
        deadline
          ? { timeout: deadline.remaining(`verifying cleanup user ${userId}`, 30_000) }
          : undefined,
      )
    ).status(),
  ).toBe(404);
}

async function expectUnauthorized(response: APIResponse): Promise<void> {
  expect(response.status(), 'anonymous Server API response body withheld').toBe(401);
}

async function createGrantedPersonaForImage(options: {
  adminApi: APIRequestContext;
  anonymousApi: APIRequestContext;
  trackedApiFactory: TrackedApiFactory;
  runId: string;
  label: string;
  serverId: string;
  imageId: string;
  deadline: AbsoluteDeadline;
}): Promise<StandardPersonaLease> {
  return createStandardPersona({
    ...options,
  });
}

let trackedContainerSequence = 0;

function trackedContainer(
  runId: string,
  suffix: string,
  ownerId: string,
  serverId: string,
): ContainerIdentity {
  const nonce = `${Date.now().toString(36)}-${trackedContainerSequence++}`;
  const label = suffix.replace(/[^a-zA-Z0-9_-]/g, '-');
  const tail = `${label.slice(0, Math.max(1, 40 - nonce.length - 1))}-${nonce}`;
  const runPrefix = runId.replace(/[^a-zA-Z0-9_-]/g, '-');
  return {
    id: null,
    taskId: null,
    name: `${runPrefix.slice(0, Math.max(1, 64 - tail.length - 1))}-${tail}`,
    ownerId,
    serverId,
  };
}

async function requestTrackedOwnerContainer(
  owner: StandardPersonaLease,
  adminApi: APIRequestContext,
  imageId: string,
  identity: ContainerIdentity,
  deadline: AbsoluteDeadline,
): Promise<AgentTaskRef> {
  const ref = await expectJson<AgentTaskRef>(
    await owner.api.post('/api/v2/containers', {
      data: {
        serverId: identity.serverId,
        imageId,
        name: identity.name,
      },
    }),
    201,
  );
  identity.taskId = ref.taskId;
  const containerId = await resolveContainerId(owner.api, adminApi, identity, deadline);
  if (!containerId) throw new Error(`container ${identity.name} was not discoverable after create`);
  identity.id = containerId;
  return ref;
}

async function settleTrackedOwnerContainer(
  owner: StandardPersonaLease,
  adminApi: APIRequestContext,
  identity: ContainerIdentity,
  deadline: AbsoluteDeadline,
): Promise<{ task: AgentTaskView; view: ContainerView }> {
  if (!identity.id || !identity.taskId) throw new Error('tracked container identity is incomplete');
  const task = await waitForAgentTask(adminApi, identity.taskId, {
    kind: 'container.create',
    resourceId: identity.id,
    timeoutMs: deadline.remaining(`waiting for container ${identity.id} create`, 120_000),
  });
  const view = await waitForContainer(
    owner.api,
    identity.id,
    'ordinary owner container running',
    (container) =>
      container.runtime.bound &&
      container.runtime.status === 'running' &&
      container.activeTask === null,
    deadline.remaining(`waiting for container ${identity.id} runtime`, 60_000),
  );
  return { task, view };
}

interface OwnerTaskScenario {
  owner: StandardPersonaLease;
  identity: ContainerIdentity;
  ref: AgentTaskRef;
  task: AgentTaskView;
  view: ContainerView;
}

async function createOwnerTaskScenario(options: {
  adminApi: APIRequestContext;
  anonymousApi: APIRequestContext;
  trackedApiFactory: TrackedApiFactory;
  runId: string;
  label: string;
  serverId: string;
  imageId: string;
  deadline: AbsoluteDeadline;
}): Promise<OwnerTaskScenario> {
  const owner = await createGrantedPersonaForImage(options);
  const identity = trackedContainer(options.runId, options.label, owner.userId, options.serverId);
  try {
    const ref = await requestTrackedOwnerContainer(
      owner,
      options.adminApi,
      options.imageId,
      identity,
      options.deadline,
    );
    const settled = await settleTrackedOwnerContainer(
      owner,
      options.adminApi,
      identity,
      options.deadline,
    );
    return { owner, identity, ref, ...settled };
  } catch (error) {
    try {
      await cleanupOwnerScenario({
        owner,
        adminApi: options.adminApi,
        identity,
        deadline: new AbsoluteDeadline(cleanupBudgetMs),
      });
    } catch (cleanupError) {
      throw aggregateErrorWithDiagnostics(
        `owner task scenario ${options.label} setup and cleanup failed`,
        [
          error instanceof Error ? error : new Error(String(error)),
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        ],
      );
    }
    throw error;
  }
}

async function cleanupOwnerScenario(options: {
  owner: StandardPersonaLease;
  intruder?: StandardPersonaLease | null;
  adminApi: APIRequestContext;
  identity: ContainerIdentity;
  deadline: AbsoluteDeadline;
}): Promise<void> {
  await runCleanupSteps(`owner task scenario ${options.identity.name}`, [
    {
      label: 'container',
      run: () =>
        cleanupOwnedContainer(
          options.owner.api,
          options.adminApi,
          options.identity,
          options.deadline,
        ),
    },
    { label: 'owner persona', run: () => options.owner.cleanup(options.deadline) },
    ...(options.intruder
      ? [{ label: 'intruder persona', run: () => options.intruder!.cleanup(options.deadline) }]
      : []),
  ]);
}

test.describe('20 servers, images, and durable tasks', () => {
  test(
    'api.servers.two-real-cpu-agents-runtime-ready @smoke',
    coverageCase(
      'servers.inventory.seeded-cpu-agent-inventory',
      'api.servers.two-real-cpu-agents-runtime-ready',
    ),
    async ({ adminApi, seedState }) => {
      const servers = await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers'));
      const seededIds = new Set(seedState.servers.map((server) => server.serverId));
      const seededServers = servers.filter((server) => seededIds.has(server.id));
      expect(seededServers).toHaveLength(2);
      expect(new Set(seededServers.map((server) => server.id))).toEqual(seededIds);
      for (const server of seededServers) {
        expect(server.status).toBe('online');
        expect(server.runtimeReady).toBe(true);
        expect(server.gpus ?? []).toEqual([]);
        expect(server.dockerDaemon).toEqual(
          expect.objectContaining({
            storageDriver: 'overlay2',
          }),
        );
      }
    },
  );

  test(
    'api.servers.online-and-offline-state',
    coverageCase(
      'servers.inventory.online-and-offline-state',
      'api.servers.online-and-offline-state',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(360_000);
      const deadline = new AbsoluteDeadline(230_000);
      const target = seedState.servers.find((server) => server.key === 'node1')!;
      const peer = seedState.servers.find((server) => server.key === 'node2')!;
      const before = await expectJson<ServerView>(
        await adminApi.get(`/api/admin/servers/${target.serverId}`),
      );
      expect(before).toEqual(expect.objectContaining({ status: 'online', runtimeReady: true }));
      expect(before.lastSeenAt).toEqual(expect.any(String));
      try {
        const stopped = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: target.key,
          action: 'stop',
        });
        expect(stopped.serviceActive).toBe(false);
        const offline = await waitForServerProjection(
          adminApi,
          target.serverId,
          'durable offline state',
          (server) => server.status === 'offline',
          deadline,
        );
        expect(Date.parse(offline.lastSeenAt!)).toBeGreaterThanOrEqual(
          Date.parse(before.lastSeenAt!),
        );
        expect(
          await expectJson<ServerView>(await adminApi.get(`/api/admin/servers/${peer.serverId}`)),
        ).toEqual(expect.objectContaining({ status: 'online', runtimeReady: true }));

        const started = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: target.key,
          action: 'start',
        });
        expect(started.serviceActive).toBe(true);
        const recovered = await waitForServerProjection(
          adminApi,
          target.serverId,
          'online and runtime-ready recovery',
          (server) => server.status === 'online' && server.runtimeReady,
          deadline,
        );
        expect(Date.parse(recovered.lastSeenAt!)).toBeGreaterThanOrEqual(
          Date.parse(offline.lastSeenAt!),
        );
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await runCleanupSteps('Server liveness fault', [
          {
            label: 'restore Agent service',
            run: async () => {
              const restored = await controlProviderFault(topologyProvider, {
                fault: 'agentService',
                runId: seedState.runId,
                nodeKey: target.key,
                action: 'start',
              });
              expect(restored.serviceActive).toBe(true);
              await waitForServerProjection(
                adminApi,
                target.serverId,
                'cleanup online recovery',
                (server) => server.status === 'online' && server.runtimeReady,
                cleanupDeadline,
              );
            },
          },
        ]);
      }
    },
  );

  test(
    'api.servers.host-fingerprint-uniqueness',
    coverageCase(
      'servers.inventory.host-fingerprint-uniqueness',
      'api.servers.host-fingerprint-uniqueness',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(360_000);
      const deadline = new AbsoluteDeadline(230_000);
      const seededIds = new Set(seedState.servers.map((server) => server.serverId));
      const before = (
        await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers'))
      ).filter((server) => seededIds.has(server.id));
      expect(before).toHaveLength(2);
      for (const server of before) {
        expect(server.hostFingerprint).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(new Set(before.map((server) => server.hostFingerprint)).size).toBe(2);

      const target = seedState.servers.find((server) => server.key === 'node2')!;
      const beforeTarget = before.find((server) => server.id === target.serverId)!;
      expect(beforeTarget.lastSeenAt).toEqual(expect.any(String));
      try {
        const restarted = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: target.key,
          action: 'restart',
        });
        expect(restarted.serviceActive).toBe(true);
        const rebound = await waitForServerProjection(
          adminApi,
          target.serverId,
          'same-host identity rebound after Agent restart',
          (server) =>
            server.status === 'online' &&
            server.runtimeReady &&
            Date.parse(server.lastSeenAt!) > Date.parse(beforeTarget.lastSeenAt!),
          deadline,
        );
        expect(rebound.hostFingerprint).toBe(beforeTarget.hostFingerprint);
        const after = (
          await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers'))
        ).filter((server) => seededIds.has(server.id));
        expect(after).toHaveLength(2);
        expect(new Set(after.map((server) => server.hostFingerprint))).toEqual(
          new Set(before.map((server) => server.hostFingerprint)),
        );
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await runCleanupSteps('Server host-identity restart', [
          {
            label: 'restore Agent service',
            run: async () => {
              const restored = await controlProviderFault(topologyProvider, {
                fault: 'agentService',
                runId: seedState.runId,
                nodeKey: target.key,
                action: 'start',
              });
              expect(restored.serviceActive).toBe(true);
              await waitForServerProjection(
                adminApi,
                target.serverId,
                'cleanup identity recovery',
                (server) => server.status === 'online' && server.runtimeReady,
                cleanupDeadline,
              );
            },
          },
        ]);
      }
    },
  );

  test(
    'api.servers.token-one-time-and-rotation @core',
    coverageCase(
      'servers.inventory.token-one-time-visibility-and-rotation',
      'api.servers.token-one-time-and-rotation',
    ),
    async ({ adminApi, seedState }) => {
      const created = await createTemporaryServer(adminApi, seedState.runId, 'token-contract');
      try {
        expect(created.agentToken.length).toBeGreaterThanOrEqual(32);
        const persisted = await expectJson<Record<string, unknown>>(
          await adminApi.get(`/api/admin/servers/${created.server.id}`),
        );
        expect(persisted).not.toHaveProperty('agentToken');
        expect(persisted).not.toHaveProperty('token');

        const rotated = await expectJson<{ token: string }>(
          await adminApi.post(`/api/admin/servers/${created.server.id}/regenerate-token`),
          201,
        );
        expect(rotated.token.length).toBeGreaterThanOrEqual(32);
        expect(
          rotated.token === created.agentToken,
          'rotated Agent token must differ; token values withheld',
        ).toBe(false);
        const afterRotation = await expectJson<Record<string, unknown>>(
          await adminApi.get(`/api/admin/servers/${created.server.id}`),
        );
        expect(afterRotation).not.toHaveProperty('agentToken');
        expect(afterRotation).not.toHaveProperty('token');
      } finally {
        await deleteTemporaryServer(adminApi, created.server.id);
      }
    },
  );

  test(
    'api.servers.real-disk-identities-are-stable @core',
    coverageCase('servers.inventory.disk-identity', 'api.servers.real-disk-identities-are-stable'),
    async ({ adminApi, seedState }) => {
      const servers = await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers'));
      const sourceIdentities = new Set<string>();
      for (const expectedServer of seedState.servers) {
        const server = servers.find((candidate) => candidate.id === expectedServer.serverId);
        expect(server).toBeDefined();
        expect(server?.disks?.length ?? 0).toBeGreaterThan(0);
        for (const disk of server?.disks ?? []) {
          expect(disk.diskId).not.toBe('');
          expect(disk.mountPoint.startsWith('/')).toBe(true);
          expect(disk.sourceIdentity).not.toBe('');
          expect(disk.pquotaEnabled).toBe(true);
          sourceIdentities.add(disk.sourceIdentity);
        }
      }
      expect(sourceIdentities.size).toBeGreaterThanOrEqual(2);
    },
  );

  test(
    'api.servers.real-agent-self-check @core',
    coverageCase('servers.inventory.self-check', 'api.servers.real-agent-self-check'),
    async ({ adminApi, seedState }) => {
      for (const server of seedState.servers) {
        const result = await expectJson<{ items: Array<{ id: string; status: string }> }>(
          await adminApi.get(`/api/admin/servers/${server.serverId}/self-check`),
        );
        const byId = new Map(result.items.map((item) => [item.id, item.status]));
        expect(byId.get('docker')).toBe('ok');
        expect(byId.get('docker_data_xfs')).toBe('ok');
        expect(byId.get('xfs_quota')).toBe('ok');
        expect(byId.get('xfsprogs')).toBe('ok');
      }
    },
  );

  test(
    'api.servers.admin-get-by-id @core',
    coverageCase(
      'servers.inventory.http.get.api-admin-servers-by-id',
      'api.servers.admin-get-by-id',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(
        await anonymousApi.get(`/api/admin/servers/${seedState.servers[0].serverId}`),
      );
      const server = await expectJson<ServerView>(
        await adminApi.get(`/api/admin/servers/${seedState.servers[0].serverId}`),
      );
      expect(server.id).toBe(seedState.servers[0].serverId);
      expect(server.status).toBe('online');
      expect(server.runtimeReady).toBe(true);
    },
  );

  test(
    'api.servers.admin-get-disks @core',
    coverageCase(
      'servers.inventory.http.get.api-admin-servers-by-id-disks',
      'api.servers.admin-get-disks',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(
        await anonymousApi.get(`/api/admin/servers/${seedState.servers[0].serverId}/disks`),
      );
      const disks = await expectJson<NonNullable<ServerView['disks']>>(
        await adminApi.get(`/api/admin/servers/${seedState.servers[0].serverId}/disks`),
      );
      expect(disks.length).toBeGreaterThan(0);
      expect(disks.every((disk) => disk.pquotaEnabled && disk.mountPoint.startsWith('/'))).toBe(
        true,
      );
    },
  );

  test(
    'api.servers.admin-self-check-route @core',
    coverageCase(
      'servers.inventory.http.get.api-admin-servers-by-id-self-check',
      'api.servers.admin-self-check-route',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(
        await anonymousApi.get(`/api/admin/servers/${seedState.servers[0].serverId}/self-check`),
      );
      const result = await expectJson<{ items: Array<{ id: string; status: string }> }>(
        await adminApi.get(`/api/admin/servers/${seedState.servers[0].serverId}/self-check`),
      );
      expect(result.items.some((item) => item.id === 'docker' && item.status === 'ok')).toBe(true);
    },
  );

  test(
    'api.servers.admin-all-disks @core',
    coverageCase(
      'servers.inventory.http.get.api-admin-servers-all-disks',
      'api.servers.admin-all-disks',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(await anonymousApi.get('/api/admin/servers/all-disks'));
      const disks = await expectJson<AdminAllDiskView[]>(
        await adminApi.get('/api/admin/servers/all-disks'),
      );
      expect(new Set(disks.map((disk) => disk.serverId))).toEqual(
        new Set(seedState.servers.map((server) => server.serverId)),
      );
      for (const disk of disks) {
        expectExactKeys(disk, ['diskId', 'serverId', 'mountPoint', 'sourceIdentity', 'label']);
        expect(disk.diskId).not.toBe('');
        expect(disk.mountPoint.startsWith('/')).toBe(true);
        expect(disk.sourceIdentity).not.toBe('');
      }
      for (const grant of seedState.mountSourceGrants) {
        expect(disks).toContainEqual(expect.objectContaining({
          diskId: grant.diskId,
          serverId: grant.serverId,
          sourceIdentity: grant.sourceIdentity,
        }));
      }
    },
  );

  test(
    'api.servers.admin-create @core',
    coverageCase('servers.inventory.http.post.api-admin-servers', 'api.servers.admin-create'),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(
        await anonymousApi.post('/api/admin/servers', {
          data: {
            name: `${seedState.runId} create-route`,
            slug: scopedSlug(seedState.runId, 'create-route'),
          },
        }),
      );
      const created = await createTemporaryServer(adminApi, seedState.runId, 'create-route');
      try {
        expect(created.server.slug).toBe(scopedSlug(seedState.runId, 'create-route'));
        expect(created.agentToken.length).toBeGreaterThanOrEqual(32);
        expect(created.server).not.toHaveProperty('agentToken');
        expectNoRawServerEntityFields(created.server);
      } finally {
        await deleteTemporaryServer(adminApi, created.server.id);
      }
    },
  );

  test(
    'api.servers.admin-update @core',
    coverageCase(
      'servers.inventory.http.patch.api-admin-servers-by-id',
      'api.servers.admin-update',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      const created = await createTemporaryServer(adminApi, seedState.runId, 'update-route');
      try {
        await expectUnauthorized(
          await anonymousApi.patch(`/api/admin/servers/${created.server.id}`, {
            data: { name: `${seedState.runId} anonymous update` },
          }),
        );
        const updated = await expectJson<ServerView>(
          await adminApi.patch(`/api/admin/servers/${created.server.id}`, {
            data: { name: `${seedState.runId} updated` },
          }),
        );
        expect(updated.name).toBe(`${seedState.runId} updated`);
        expect(updated.slug).toBe(created.server.slug);
        expect(updated).not.toHaveProperty('agentToken');
        expectNoRawServerEntityFields(updated);
      } finally {
        await deleteTemporaryServer(adminApi, created.server.id);
      }
    },
  );

  test(
    'api.servers.admin-regenerate-token @core',
    coverageCase(
      'servers.inventory.http.post.api-admin-servers-by-id-regenerate-token',
      'api.servers.admin-regenerate-token',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      const created = await createTemporaryServer(adminApi, seedState.runId, 'rotate-route');
      try {
        await expectUnauthorized(
          await anonymousApi.post(`/api/admin/servers/${created.server.id}/regenerate-token`),
        );
        const rotated = await expectJson<{ token: string }>(
          await adminApi.post(`/api/admin/servers/${created.server.id}/regenerate-token`),
          201,
        );
        expect(rotated.token.length).toBeGreaterThanOrEqual(32);
        expect(
          rotated.token === created.agentToken,
          'rotated Agent token must differ; token values withheld',
        ).toBe(false);
      } finally {
        await deleteTemporaryServer(adminApi, created.server.id);
      }
    },
  );

  test(
    'api.servers.admin-delete @core',
    coverageCase(
      'servers.inventory.http.delete.api-admin-servers-by-id',
      'api.servers.admin-delete',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      const created = await createTemporaryServer(adminApi, seedState.runId, 'delete-route');
      try {
        await expectUnauthorized(
          await anonymousApi.delete(`/api/admin/servers/${created.server.id}`),
        );
        const response = await adminApi.delete(`/api/admin/servers/${created.server.id}`);
        expect(response.status()).toBe(204);
        expect((await adminApi.get(`/api/admin/servers/${created.server.id}`)).status()).toBe(404);
      } finally {
        await deleteTemporaryServer(adminApi, created.server.id);
      }
    },
  );

  test(
    'api.servers.user-list @core',
    coverageCase('servers.inventory.http.get.api-servers', 'api.servers.user-list'),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(await anonymousApi.get('/api/servers'));
      const servers = await expectJson<UserServerView[]>(await adminApi.get('/api/servers'));
      const observed = new Set(servers.map((server) => server.id));
      for (const server of seedState.servers) expect(observed.has(server.serverId)).toBe(true);
      for (const server of servers) {
        expectExactKeys(server, ['id', 'name', 'slug', 'status', 'lastSeenAt', 'runtimeReady']);
      }
    },
  );

  test(
    'api.servers.user-get-by-id @core',
    coverageCase('servers.inventory.http.get.api-servers-by-id', 'api.servers.user-get-by-id'),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(
        await anonymousApi.get(`/api/servers/${seedState.servers[0].serverId}`),
      );
      const server = await expectJson<UserServerView>(
        await adminApi.get(`/api/servers/${seedState.servers[0].serverId}`),
      );
      expect(server.id).toBe(seedState.servers[0].serverId);
      expect(server.status).toBe('online');
      expectExactKeys(server, ['id', 'name', 'slug', 'status', 'lastSeenAt', 'runtimeReady']);
    },
  );

  test(
    'api.servers.user-get-disks @core',
    coverageCase(
      'servers.inventory.http.get.api-servers-by-id-disks',
      'api.servers.user-get-disks',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(
        await anonymousApi.get(`/api/servers/${seedState.servers[0].serverId}/disks`),
      );
      const disks = await expectJson<UserDiskView[]>(
        await adminApi.get(`/api/servers/${seedState.servers[0].serverId}/disks`),
      );
      expect(disks.length).toBeGreaterThan(0);
      for (const disk of disks) {
        expectExactKeys(disk, ['diskId', 'displayName', 'totalBytes', 'usedBytes', 'pquotaEnabled']);
        expect(disk.displayName).not.toBe('');
        expect(disk.pquotaEnabled).toBe(true);
        expect(disk).not.toHaveProperty('mountPoint');
        expect(disk).not.toHaveProperty('sourceIdentity');
      }
    },
  );

  test(
    'api.servers.user-get-gpus-cpu-only @core',
    coverageCase(
      'servers.inventory.http.get.api-servers-by-id-gpus',
      'api.servers.user-get-gpus-cpu-only',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(
        await anonymousApi.get(`/api/servers/${seedState.servers[0].serverId}/gpus`),
      );
      const gpus = await expectJson<unknown[]>(
        await adminApi.get(`/api/servers/${seedState.servers[0].serverId}/gpus`),
      );
      expect(gpus).toEqual([]);
    },
  );

  test(
    'api.servers.user-get-real-quota @core',
    coverageCase(
      'servers.inventory.http.get.api-servers-by-id-quota',
      'api.servers.user-get-real-quota',
    ),
    async ({ adminApi, anonymousApi, seedState }) => {
      await expectUnauthorized(
        await anonymousApi.get(`/api/servers/${seedState.servers[0].serverId}/quota`),
      );
      const quota = await expectJson<{ usedBytes: number; limitBytes: number }>(
        await adminApi.get(`/api/servers/${seedState.servers[0].serverId}/quota`),
      );
      expect(quota.usedBytes).toBeGreaterThanOrEqual(0);
      expect(quota.limitBytes).toBe(2_147_483_648);
    },
  );

  test(
    'api.servers.cpu-only-inventory',
    coverageCase('servers.inventory.cpu-only-inventory', 'api.servers.cpu-only-inventory'),
    async ({ adminApi, seedState }) => {
      const servers = await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers'));
      const expectedIds = new Set(seedState.servers.map((server) => server.serverId));
      const realNodes = servers.filter((server) => expectedIds.has(server.id));
      expect(realNodes).toHaveLength(2);
      expect(new Set(realNodes.map((server) => server.id))).toEqual(expectedIds);
      for (const server of realNodes) {
        expect(server.status).toBe('online');
        expect(server.runtimeReady).toBe(true);
        expect(server.gpus ?? []).toEqual([]);
        expect(server.dockerDaemon).toEqual(
          expect.objectContaining({
            state: 'active',
            active: true,
            storageDriver: 'overlay2',
          }),
        );
      }
    },
  );

  test(
    'api.servers.capacity-and-deletion-guards',
    coverageCase(
      'servers.inventory.capacity-and-deletion-guards',
      'api.servers.capacity-and-deletion-guards',
    ),
    async ({ adminApi, seedState }) => {
      test.setTimeout(360_000);
      const initial = await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers'));
      expect(new Set(initial.map((server) => server.id))).toEqual(
        new Set(seedState.servers.map((server) => server.serverId)),
      );
      const created: CreatedServer[] = [];
      const plannedSlugs = new Set<string>();
      let guardedServerId: string | null = null;
      let guardUserId: string | null = null;

      try {
        for (let index = initial.length; index < 16; index += 1) {
          plannedSlugs.add(scopedSlug(seedState.runId, `capacity-${index}`));
          created.push(await createTemporaryServer(adminApi, seedState.runId, `capacity-${index}`));
        }
        const atCapacity = await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers'));
        expect(atCapacity).toHaveLength(16);
        expect(new Set(created.map((entry) => entry.server.id))).toEqual(
          new Set(
            atCapacity.filter((server) => plannedSlugs.has(server.slug)).map((server) => server.id),
          ),
        );

        const overflow = await adminApi.post('/api/admin/servers', {
          data: {
            name: `${seedState.runId} capacity overflow`,
            slug: scopedSlug(seedState.runId, 'capacity-overflow'),
          },
        });
        expect(overflow.status(), 'server capacity error body withheld').toBe(409);
        const overflowBody = (await overflow.json()) as { code?: string };
        expect(overflowBody.code).toBe('SERVER_CAPACITY_REACHED');
        expect(
          await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers')),
        ).toHaveLength(16);

        const guarded = created[0];
        expect(guarded).toBeDefined();
        guardedServerId = guarded.server.id;
        const guardUsername =
          `${seedState.runId.replace(/-/g, '_').slice(0, 42)}_capacity_guard`;
        const guardUser = await expectJson<CreatedUser>(
          await adminApi.post('/api/admin/users', {
            data: {
              username: guardUsername,
              password: `E2e-${Date.now().toString(36)}-Capacity-Cpu!`,
              displayName: `${seedState.runId} capacity guard user`,
            },
          }),
          201,
        );
        guardUserId = guardUser.id;
        await expectJson(
          await adminApi.post(`/api/admin/users/${guardUser.id}/image-grants`, {
            data: { imageId: seedState.image.id, serverId: guarded.server.id },
          }),
          201,
        );
        const blockedDelete = await adminApi.delete(`/api/admin/servers/${guarded.server.id}`);
        expect(blockedDelete.status(), 'server dependency error body withheld').toBe(409);
        const blockedBody = (await blockedDelete.json()) as {
          code?: string;
          dependencies?: string[];
        };
        expect(blockedBody.code).toBe('SERVER_NOT_EMPTY');
        expect(blockedBody.dependencies).toContain('image grants');
        expect(
          (
            await expectJson<ServerView>(
              await adminApi.get(`/api/admin/servers/${guarded.server.id}`),
            )
          ).id,
        ).toBe(guarded.server.id);
        const removed = await adminApi.delete(
          `/api/admin/users/${guardUser.id}/image-grants/${seedState.image.id}/${guarded.server.id}`,
        );
        expect(removed.status()).toBe(204);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        let discovered: string[] = [];
        let discoveryFailure: { error: unknown } | null = null;
        try {
          discovered = await resolveServerIdsBySlugs(adminApi, plannedSlugs, cleanupDeadline);
        } catch (error) {
          discoveryFailure = { error };
        }
        const serverIds = [...new Set([...created.map((entry) => entry.server.id), ...discovered])];
        await runCleanupSteps('capacity Server scenario', [
          ...(guardedServerId && guardUserId
            ? [
                {
                  label: 'guard image grant',
                  run: async () => {
                    const removed = await adminApi.delete(
                      `/api/admin/users/${guardUserId}/image-grants/${seedState.image.id}/${guardedServerId}`,
                      {
                        timeout: cleanupDeadline.remaining('removing capacity guard grant', 30_000),
                      },
                    );
                    await expectStatus(removed, [204, 404], 'capacity guard image grant cleanup');
                  },
                },
              ]
            : []),
          ...serverIds.reverse().map((serverId) => ({
            label: `Server ${serverId}`,
            run: async () => {
              await deleteTemporaryServer(adminApi, serverId, cleanupDeadline);
              await expectStatus(
                await adminApi.get(`/api/admin/servers/${serverId}`, {
                  timeout: cleanupDeadline.remaining(
                    `verifying temporary Server ${serverId} cleanup`,
                    30_000,
                  ),
                }),
                404,
                `temporary Server ${serverId} durable cleanup`,
              );
            },
          })),
          ...(guardUserId
            ? [{
                label: 'capacity guard user',
                run: () => deleteUser(adminApi, guardUserId!, cleanupDeadline),
              }]
            : []),
          {
            label: 'final seed-only inventory',
            run: async () => {
              const finalServers = await expectJson<ServerView[]>(
                await adminApi.get('/api/admin/servers', {
                  timeout: cleanupDeadline.remaining('verifying final Server inventory', 30_000),
                }),
              );
              expect(new Set(finalServers.map((server) => server.id))).toEqual(
                new Set(seedState.servers.map((server) => server.serverId)),
              );
            },
          },
          ...(discoveryFailure !== null
            ? [
                {
                  label: 'temporary Server discovery',
                  run: async () => {
                    throw discoveryFailure.error;
                  },
                },
              ]
            : []),
        ]);
      }
    },
  );

  test(
    'api.images.seeded-workload-present-on-both-real-agents @smoke',
    coverageCase(
      'images.lifecycle.seeded-image-present',
      'api.images.seeded-workload-present-on-both-real-agents',
    ),
    async ({ adminApi, seedState }) => {
      const image = await expectJson<{
        id: string;
        dockerImage: string;
        isActive: boolean;
        disableSsh: boolean;
      }>(await adminApi.get(`/api/admin/images/${seedState.image.id}`));
      expect(image).toEqual(
        expect.objectContaining({
          id: seedState.image.id,
          dockerImage: seedState.image.dockerImage,
          isActive: true,
          disableSsh: true,
        }),
      );

      const statuses = await expectJson<
        Array<{
          serverId: string;
          online: boolean;
          present: boolean;
        }>
      >(await adminApi.get(`/api/admin/images/${seedState.image.id}/status`));
      expect(statuses).toHaveLength(2);
      expect(new Set(statuses.map((status) => status.serverId))).toEqual(
        new Set(seedState.servers.map((server) => server.serverId)),
      );
      for (const status of statuses) {
        expect(status.online).toBe(true);
        expect(status.present).toBe(true);
      }

      const tasks = await Promise.all(
        seedState.taskIds.imagePull.map((taskId) =>
          waitForAgentTask(adminApi, taskId, {
            kind: 'image.ensure_present',
            resourceId: seedState.image.id,
          }),
        ),
      );
      expect(new Set(tasks.map((task) => task.serverId))).toEqual(
        new Set(seedState.servers.map((server) => server.serverId)),
      );
      for (const task of tasks) {
        expect(task.agentResult).toEqual(expect.objectContaining({ status: 'succeeded' }));
        expect(task.result).toEqual(
          expect.objectContaining({
            imageId: seedState.image.id,
            dockerRef: seedState.image.dockerImage,
            dockerId: expect.any(String),
          }),
        );
      }
    },
  );

  test(
    'api.images.create-and-update-real-reference',
    coverageCase(
      'images.lifecycle.create-and-update',
      'api.images.create-and-update-real-reference',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(480_000);
      const deadline = new AbsoluteDeadline(350_000);
      const identity = trackedImage(seedState.runId, 'create-update');
      const serverId = seedState.servers[0].serverId;
      let persona: StandardPersonaLease | null = null;
      try {
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          seedState.uiImage.dockerImage,
          'create-update',
          identity,
        );
        expect(image).toEqual(
          expect.objectContaining({
            dockerImage: seedState.uiImage.dockerImage,
            isActive: true,
            deleting: false,
            disableSsh: true,
          }),
        );
        expect(
          await expectJson<ImageView>(await adminApi.get(`/api/admin/images/${image.id}`)),
        ).toEqual(expect.objectContaining({ id: image.id, name: identity.name }));
        persona = await createGrantedPersonaForImage({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'image-create-update',
          serverId,
          imageId: image.id,
          deadline,
        });
        expect(
          (await expectJson<ImageView>(await persona.api.get(`/api/images/${image.id}`))).id,
        ).toBe(image.id);
        const updated = await expectJson<ImageView>(
          await adminApi.patch(`/api/admin/images/${image.id}`, {
            data: {
              expectedRevision: image.revision,
              name: imageName(seedState.runId, 'updated'),
              description: 'updated through the real production control plane',
              isActive: false,
              disableSsh: false,
            },
          }),
        );
        expect(updated).toEqual(
          expect.objectContaining({
            id: image.id,
            dockerImage: seedState.uiImage.dockerImage,
            description: 'updated through the real production control plane',
            isActive: false,
            disableSsh: false,
          }),
        );
        const adminReadback = await expectJson<ImageView>(
          await adminApi.get(`/api/admin/images/${image.id}`),
        );
        const ownerReadback = await expectJson<ImageView>(
          await persona.api.get(`/api/images/${image.id}`),
        );
        for (const readback of [adminReadback, ownerReadback]) {
          expect(readback).toEqual(
            expect.objectContaining({
              id: image.id,
              description: 'updated through the real production control plane',
              isActive: false,
              disableSsh: false,
            }),
          );
        }
        const immutable = await adminApi.patch(`/api/admin/images/${image.id}`, {
          data: { expectedRevision: updated.revision, dockerImage: seedState.image.dockerImage },
        });
        expect(immutable.status(), 'immutable image-ref error body withheld').toBe(409);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await runCleanupSteps('image create/update scenario', [
          ...(persona && identity.id
            ? [
                {
                  label: 'image grant',
                  run: () => persona!.revokeImage(identity.id!, serverId, cleanupDeadline),
                },
              ]
            : []),
          {
            label: 'image',
            run: () => cleanupImageLease(adminApi, identity, cleanupDeadline),
          },
          ...(persona ? [{ label: 'persona', run: () => persona!.cleanup(cleanupDeadline) }] : []),
        ]);
      }
    },
  );

  test(
    'api.images.active-and-inactive-visibility',
    coverageCase(
      'images.lifecycle.active-and-inactive-visibility',
      'api.images.active-and-inactive-visibility',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(420_000);
      const deadline = new AbsoluteDeadline(290_000);
      const serverId = seedState.servers[0].serverId;
      const persona = await createGrantedPersonaForImage({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'image-active-visibility',
        serverId,
        imageId: seedState.image.id,
        deadline,
      });
      try {
        const current = await expectJson<ImageView>(
          await adminApi.get(`/api/admin/images/${seedState.image.id}`),
        );
        const inactive = await expectJson<ImageView>(
          await adminApi.patch(`/api/admin/images/${seedState.image.id}`, {
            data: { expectedRevision: current.revision, isActive: false },
          }),
        );
        expect(inactive.isActive).toBe(false);
        const all = await expectJson<ImageView[]>(await adminApi.get('/api/admin/images'));
        const active = await expectJson<ImageView[]>(
          await adminApi.get('/api/admin/images?activeOnly=true'),
        );
        const accessibleActive = await expectJson<ImageView[]>(
          await persona.api.get('/api/images?activeOnly=true'),
        );
        const accessibleAll = await expectJson<ImageView[]>(await persona.api.get('/api/images'));
        expect(all.some((entry) => entry.id === seedState.image.id)).toBe(true);
        expect(active.some((entry) => entry.id === seedState.image.id)).toBe(false);
        expect(accessibleActive.some((entry) => entry.id === seedState.image.id)).toBe(false);
        expect(accessibleAll.some((entry) => entry.id === seedState.image.id)).toBe(true);
        expect(
          (
            await expectJson<ImageView>(
              await adminApi.get(`/api/admin/images/${seedState.image.id}`),
            )
          ).isActive,
        ).toBe(false);
        const reactivated = await expectJson<ImageView>(
          await adminApi.patch(`/api/admin/images/${seedState.image.id}`, {
            data: { expectedRevision: inactive.revision, isActive: true },
          }),
        );
        expect(reactivated.isActive).toBe(true);
        expect(
          (
            await expectJson<ImageView[]>(await persona.api.get('/api/images?activeOnly=true'))
          ).some((entry) => entry.id === seedState.image.id),
        ).toBe(true);
        expect(
          (
            await expectJson<ImageView>(
              await adminApi.get(`/api/admin/images/${seedState.image.id}`),
            )
          ).isActive,
        ).toBe(true);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await runCleanupSteps('image visibility scenario', [
          {
            label: 'restore seed image active state',
            run: async () => {
              const current = await expectJson<ImageView>(
                await adminApi.get(`/api/admin/images/${seedState.image.id}`, {
                  timeout: cleanupDeadline.remaining(
                    'reading seed image before restoring active state',
                    30_000,
                  ),
                }),
              );
              const restored = await expectJson<ImageView>(
                await adminApi.patch(`/api/admin/images/${seedState.image.id}`, {
                  data: { expectedRevision: current.revision, isActive: true },
                  timeout: cleanupDeadline.remaining('restoring seed image active state', 30_000),
                }),
              );
              expect(restored.isActive).toBe(true);
              expect(
                (
                  await expectJson<ImageView>(
                    await adminApi.get(`/api/admin/images/${seedState.image.id}`, {
                      timeout: cleanupDeadline.remaining(
                        'verifying seed image active state',
                        30_000,
                      ),
                    }),
                  )
                ).isActive,
              ).toBe(true);
            },
          },
          { label: 'persona', run: () => persona.cleanup(cleanupDeadline) },
        ]);
      }
    },
  );

  test(
    'api.images.grant-enforcement-for-real-user',
    coverageCase(
      'images.lifecycle.grant-enforcement',
      'api.images.grant-enforcement-for-real-user',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(360_000);
      const username = `${seedState.runId.replace(/-/g, '_').slice(0, 42)}_image_${Date.now().toString(36)}`;
      const password = `E2e-${Date.now().toString(36)}-Image-Cpu!`;
      const user = await expectJson<CreatedUser>(
        await adminApi.post('/api/admin/users', {
          data: { username, password, displayName: `${seedState.runId} image grant user` },
        }),
        201,
      );
      const serverId = seedState.servers[0].serverId;
      let serverGrant = false;
      let imageGrant = false;

      try {
        const grant = await expectJson<{ taskIds: string[] }>(
          await adminApi.post(`/api/admin/users/${user.id}/server-grants/${serverId}`, {
            data: {
              cpuMillis: 500,
              memBytes: 128 * 1024 * 1024,
              diskBytes: 64 * 1024 * 1024,
              gpuMode: 'none',
              gpuIndices: [],
            },
          }),
          201,
        );
        serverGrant = true;
        await settleTaskIds(adminApi, grant.taskIds);
        const session = await expectJson<UserLogin>(
          await anonymousApi.post('/api/auth/login', {
            data: { username, password },
          }),
        );
        const userApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
        });
        expect(
          (await expectJson<ImageView[]>(await userApi.get('/api/images'))).some(
            (entry) => entry.id === seedState.image.id,
          ),
        ).toBe(false);
        expect((await userApi.get(`/api/images/${seedState.image.id}`)).status()).toBe(403);

        await expectJson(
          await adminApi.post(`/api/admin/users/${user.id}/image-grants`, {
            data: { imageId: seedState.image.id, serverId },
          }),
          201,
        );
        imageGrant = true;
        expect(
          (await expectJson<ImageView[]>(await userApi.get('/api/images'))).some(
            (entry) => entry.id === seedState.image.id,
          ),
        ).toBe(true);
        expect(
          (await expectJson<ImageView>(await userApi.get(`/api/images/${seedState.image.id}`))).id,
        ).toBe(seedState.image.id);

        const revoked = await adminApi.delete(
          `/api/admin/users/${user.id}/image-grants/${seedState.image.id}/${serverId}`,
        );
        expect(revoked.status()).toBe(204);
        imageGrant = false;
        expect(
          (await expectJson<ImageView[]>(await userApi.get('/api/images'))).some(
            (entry) => entry.id === seedState.image.id,
          ),
        ).toBe(false);
        expect((await userApi.get(`/api/images/${seedState.image.id}`)).status()).toBe(403);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await runCleanupSteps('image grant enforcement scenario', [
          ...(imageGrant
            ? [
                {
                  label: 'image grant',
                  run: async () => {
                    const response = await adminApi.delete(
                      `/api/admin/users/${user.id}/image-grants/${seedState.image.id}/${serverId}`,
                      { timeout: cleanupDeadline.remaining('removing image grant', 30_000) },
                    );
                    expect([204, 404]).toContain(response.status());
                  },
                },
              ]
            : []),
          ...(serverGrant
            ? [
                {
                  label: 'Server grant',
                  run: async () => {
                    const response = await adminApi.delete(
                      `/api/admin/users/${user.id}/server-grants/${serverId}`,
                      { timeout: cleanupDeadline.remaining('removing Server grant', 30_000) },
                    );
                    if (response.status() !== 404) {
                      const removed = await expectJson<{ taskIds: string[] }>(response);
                      await settleTaskIds(adminApi, removed.taskIds, cleanupDeadline);
                    }
                  },
                },
              ]
            : []),
          {
            label: 'user',
            run: () => deleteUser(adminApi, user.id, cleanupDeadline),
          },
        ]);
      }
    },
  );

  test(
    'api.images.delete-and-ensure-absent-on-both-nodes',
    coverageCase(
      'images.lifecycle.delete-and-ensure-absent',
      'api.images.delete-and-ensure-absent-on-both-nodes',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(540_000);
      const deadline = new AbsoluteDeadline(410_000);
      const identity = trackedImage(seedState.runId, 'delete-absent');
      const serverId = seedState.servers[0].serverId;
      let persona: StandardPersonaLease | null = null;
      let deleted = false;
      try {
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          seedState.uiImage.dockerImage,
          'delete-absent',
          identity,
        );
        persona = await createGrantedPersonaForImage({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'image-delete-absent',
          serverId,
          imageId: image.id,
          deadline,
        });
        expect(
          (await expectJson<ImageView>(await persona.api.get(`/api/images/${image.id}`))).id,
        ).toBe(image.id);
        const pull = await expectJson<ImagePullResponse>(
          await adminApi.post(`/api/admin/images/${image.id}/pull`, {
            data: { serverIds: seedState.servers.map((server) => server.serverId) },
          }),
          201,
        );
        expect(pull.rejected).toEqual([]);
        expect(pull.tasks).toHaveLength(2);
        await Promise.all(
          pull.tasks.map((task) =>
            waitForAgentTask(adminApi, task.taskId, {
              kind: 'image.ensure_present',
              resourceId: image.id,
              timeoutMs: deadline.remaining(`waiting for image pull ${task.taskId}`, 120_000),
            }),
          ),
        );
        const expectedServerIds = new Set(seedState.servers.map((server) => server.serverId));
        const realStatuses = await waitForImagePresentOnServers(
          adminApi,
          image.id,
          expectedServerIds,
          deadline.remaining('waiting for image inventory convergence', 30_000),
        );
        expect(realStatuses).toHaveLength(expectedServerIds.size);
        expect(new Set(realStatuses.map((status) => status.serverId))).toEqual(expectedServerIds);
        expect(realStatuses.every((status) => status.present)).toBe(true);
        await persona.revokeImage(image.id, serverId);
        const absentTasks = await deleteDisposableImage(adminApi, image.id, deadline);
        deleted = true;
        expect(absentTasks).toHaveLength(2);
        expect(new Set(absentTasks.map((task) => task.serverId))).toEqual(
          new Set(seedState.servers.map((server) => server.serverId)),
        );
        expect(absentTasks.every((task) => task.result !== null)).toBe(true);
        await expectStatus(
          await adminApi.get(`/api/admin/images/${image.id}`),
          404,
          'deleted image durable readback',
        );
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await runCleanupSteps('image delete/absent scenario', [
          ...(persona && identity.id
            ? [
                {
                  label: 'image grant',
                  run: () => persona!.revokeImage(identity.id!, serverId, cleanupDeadline),
                },
              ]
            : []),
          ...(!deleted
            ? [
                {
                  label: 'image',
                  run: () => cleanupImageLease(adminApi, identity, cleanupDeadline),
                },
              ]
            : []),
          ...(persona ? [{ label: 'persona', run: () => persona!.cleanup(cleanupDeadline) }] : []),
        ]);
      }
    },
  );

  test(
    'api.images.pull-failure-converges-to-terminal-task',
    coverageCase(
      'images.lifecycle.failure-convergence',
      'api.images.pull-failure-converges-to-terminal-task',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(600_000);
      const deadline = new AbsoluteDeadline(470_000);
      const missingRef = `registry:5000/${seedState.runId}/missing-workload:never-published`;
      const identity = trackedImage(seedState.runId, 'pull-failure');
      const serverId = seedState.servers[0].serverId;
      let persona: StandardPersonaLease | null = null;
      try {
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          missingRef,
          'pull-failure',
          identity,
        );
        persona = await createGrantedPersonaForImage({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'image-pull-failure',
          serverId,
          imageId: image.id,
          deadline,
        });
        const pull = await expectJson<ImagePullResponse>(
          await adminApi.post(`/api/admin/images/${image.id}/pull`, {
            data: { serverIds: [seedState.servers[0].serverId] },
          }),
          201,
        );
        expect(pull.rejected).toEqual([]);
        expect(pull.tasks).toHaveLength(1);
        const terminal = await waitForTaskTerminal(
          adminApi,
          pull.tasks[0].taskId,
          deadline.remaining('waiting for expected image pull failure', 180_000),
        );
        expect(terminal).toEqual(
          expect.objectContaining({
            kind: 'image.ensure_present',
            resourceId: image.id,
            serverId: seedState.servers[0].serverId,
            status: 'failed',
            failureStage: 'agent',
            completedAt: expect.any(String),
            retentionUntil: expect.any(String),
            error: expect.any(Object),
          }),
        );
        const statuses = await expectJson<Array<{ serverId: string; present: boolean }>>(
          await adminApi.get(`/api/admin/images/${image.id}/status`),
        );
        expect(
          statuses.find((entry) => entry.serverId === seedState.servers[0].serverId)?.present,
        ).toBe(false);
        expect(
          (await expectJson<ImageView>(await persona.api.get(`/api/images/${image.id}`))).id,
        ).toBe(image.id);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await runCleanupSteps('image failure scenario', [
          ...(persona && identity.id
            ? [
                {
                  label: 'image grant',
                  run: () => persona!.revokeImage(identity.id!, serverId, cleanupDeadline),
                },
              ]
            : []),
          {
            label: 'image',
            run: () => cleanupImageLease(adminApi, identity, cleanupDeadline),
          },
          ...(persona ? [{ label: 'persona', run: () => persona!.cleanup(cleanupDeadline) }] : []),
        ]);
      }
    },
  );

  test(
    'api.images.admin-list-exact-contract',
    coverageCase(
      'images.lifecycle.http.get.api-admin-images',
      'api.images.admin-list-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(300_000);
      const deadline = new AbsoluteDeadline(290_000);
      const serverId = seedState.servers[0].serverId;
      const persona = await createGrantedPersonaForImage({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'image-admin-list',
        serverId,
        imageId: seedState.image.id,
        deadline,
      });
      try {
        expect((await anonymousApi.get('/api/admin/images')).status()).toBe(401);
        expect((await persona.api.get('/api/admin/images')).status()).toBe(403);
        const images = await expectJson<ImageView[]>(await adminApi.get('/api/admin/images'));
        expect(images).toContainEqual(
          expect.objectContaining({
            id: seedState.image.id,
            dockerImage: seedState.image.dockerImage,
            isActive: true,
          }),
        );
      } finally {
        await persona.cleanup();
      }
    },
  );

  test(
    'api.images.admin-create-exact-contract',
    coverageCase(
      'images.lifecycle.http.post.api-admin-images',
      'api.images.admin-create-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(360_000);
      const deadline = new AbsoluteDeadline(350_000);
      const identity = trackedImage(seedState.runId, 'exact-post');
      const serverId = seedState.servers[0].serverId;
      const persona = await createGrantedPersonaForImage({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'image-admin-create',
        serverId,
        imageId: seedState.image.id,
        deadline,
      });
      try {
        const deniedBody = { name: identity.name, dockerImage: seedState.uiImage.dockerImage };
        expect((await anonymousApi.post('/api/admin/images', { data: deniedBody })).status()).toBe(
          401,
        );
        expect((await persona.api.post('/api/admin/images', { data: deniedBody })).status()).toBe(
          403,
        );
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          seedState.uiImage.dockerImage,
          'exact-post',
          identity,
        );
        expect(image).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            dockerImage: seedState.uiImage.dockerImage,
            isActive: true,
          }),
        );
        expect(
          await expectJson<ImageView>(await adminApi.get(`/api/admin/images/${image.id}`)),
        ).toEqual(
          expect.objectContaining({
            id: image.id,
            name: identity.name,
            dockerImage: seedState.uiImage.dockerImage,
          }),
        );
      } finally {
        await runCleanupSteps('image admin create exact scenario', [
          { label: 'image', run: () => cleanupImageLease(adminApi, identity, deadline) },
          { label: 'persona', run: () => persona.cleanup() },
        ]);
      }
    },
  );

  test(
    'api.images.admin-update-exact-contract',
    coverageCase(
      'images.lifecycle.http.patch.api-admin-images-by-id',
      'api.images.admin-update-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(360_000);
      const deadline = new AbsoluteDeadline(350_000);
      const identity = trackedImage(seedState.runId, 'exact-patch');
      const serverId = seedState.servers[0].serverId;
      let persona: StandardPersonaLease | null = null;
      try {
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          seedState.uiImage.dockerImage,
          'exact-patch',
          identity,
        );
        persona = await createGrantedPersonaForImage({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'image-admin-update',
          serverId,
          imageId: image.id,
          deadline,
        });
        expect(
          (
            await anonymousApi.patch(`/api/admin/images/${image.id}`, {
              data: { description: 'denied' },
            })
          ).status(),
        ).toBe(401);
        expect(
          (
            await persona.api.patch(`/api/admin/images/${image.id}`, {
              data: { description: 'capability denied' },
            })
          ).status(),
        ).toBe(403);
        const updated = await expectJson<ImageView>(
          await adminApi.patch(`/api/admin/images/${image.id}`, {
            data: {
              expectedRevision: image.revision,
              description: 'exact patch persisted',
              disableSsh: false,
            },
          }),
        );
        expect(updated).toEqual(
          expect.objectContaining({
            id: image.id,
            description: 'exact patch persisted',
            disableSsh: false,
          }),
        );
        expect(updated.revision).toBe(image.revision + 1);
        expect(
          (
            await adminApi.patch(`/api/admin/images/${image.id}`, {
              data: {
                expectedRevision: image.revision,
                description: 'stale patch must not persist',
              },
            })
          ).status(),
        ).toBe(409);
        const readBack = await expectJson<ImageView>(
          await adminApi.get(`/api/admin/images/${image.id}`),
        );
        expect(readBack.description).toBe('exact patch persisted');
        expect(
          (await expectJson<ImageView>(await persona.api.get(`/api/images/${image.id}`)))
            .description,
        ).toBe('exact patch persisted');
      } finally {
        await runCleanupSteps('image admin update exact scenario', [
          ...(persona && identity.id
            ? [
                {
                  label: 'image grant',
                  run: () => persona!.revokeImage(identity.id!, serverId),
                },
              ]
            : []),
          { label: 'image', run: () => cleanupImageLease(adminApi, identity, deadline) },
          ...(persona ? [{ label: 'persona', run: () => persona!.cleanup() }] : []),
        ]);
      }
    },
  );

  test(
    'api.images.admin-pull-exact-contract',
    coverageCase(
      'images.lifecycle.http.post.api-admin-images-by-id-pull',
      'api.images.admin-pull-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(300_000);
      const deadline = new AbsoluteDeadline(290_000);
      const serverId = seedState.servers[0].serverId;
      const persona = await createGrantedPersonaForImage({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'image-admin-pull',
        serverId,
        imageId: seedState.image.id,
        deadline,
      });
      try {
        const body = { data: { serverIds: [serverId] } };
        expect(
          (await anonymousApi.post(`/api/admin/images/${seedState.image.id}/pull`, body)).status(),
        ).toBe(401);
        expect(
          (await persona.api.post(`/api/admin/images/${seedState.image.id}/pull`, body)).status(),
        ).toBe(403);
        const pull = await expectJson<ImagePullResponse>(
          await adminApi.post(`/api/admin/images/${seedState.image.id}/pull`, body),
          201,
        );
        expect(pull.rejected).toEqual([]);
        expect(pull.tasks).toHaveLength(1);
        const task = await waitForAgentTask(adminApi, pull.tasks[0].taskId, {
          kind: 'image.ensure_present',
          resourceId: seedState.image.id,
          timeoutMs: deadline.remaining('waiting for exact image pull', 120_000),
        });
        expect(task.serverId).toBe(serverId);
        expect(task.result).toEqual(
          expect.objectContaining({ dockerRef: seedState.image.dockerImage }),
        );
        const statuses = await expectJson<Array<{ serverId: string; present: boolean }>>(
          await adminApi.get(`/api/admin/images/${seedState.image.id}/status`),
        );
        expect(statuses.find((status) => status.serverId === serverId)?.present).toBe(true);
      } finally {
        await persona.cleanup();
      }
    },
  );

  test(
    'api.images.admin-delete-exact-contract',
    coverageCase(
      'images.lifecycle.http.delete.api-admin-images-by-id',
      'api.images.admin-delete-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(360_000);
      const deadline = new AbsoluteDeadline(350_000);
      const identity = trackedImage(seedState.runId, 'exact-delete');
      const serverId = seedState.servers[0].serverId;
      let persona: StandardPersonaLease | null = null;
      let deleted = false;
      try {
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          seedState.uiImage.dockerImage,
          'exact-delete',
          identity,
        );
        persona = await createGrantedPersonaForImage({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'image-admin-delete',
          serverId,
          imageId: image.id,
          deadline,
        });
        expect((await anonymousApi.delete(`/api/admin/images/${image.id}`)).status()).toBe(401);
        expect((await persona.api.delete(`/api/admin/images/${image.id}`)).status()).toBe(403);
        await persona.revokeImage(image.id, serverId);
        const tasks = await deleteDisposableImage(adminApi, image.id, deadline);
        deleted = true;
        expect(tasks).toHaveLength(2);
        expect(tasks.every((task) => task.kind === 'image.ensure_absent')).toBe(true);
        await expectStatus(
          await adminApi.get(`/api/admin/images/${image.id}`),
          404,
          'exact image delete durable readback',
        );
      } finally {
        await runCleanupSteps('image admin delete exact scenario', [
          ...(persona && identity.id
            ? [
                {
                  label: 'image grant',
                  run: () => persona!.revokeImage(identity.id!, serverId),
                },
              ]
            : []),
          ...(!deleted
            ? [
                {
                  label: 'image',
                  run: () => cleanupImageLease(adminApi, identity, deadline),
                },
              ]
            : []),
          ...(persona ? [{ label: 'persona', run: () => persona!.cleanup() }] : []),
        ]);
      }
    },
  );

  test(
    'api.images.user-list-exact-contract',
    coverageCase('images.lifecycle.http.get.api-images', 'api.images.user-list-exact-contract'),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(300_000);
      const deadline = new AbsoluteDeadline(290_000);
      const serverId = seedState.servers[0].serverId;
      const granted = await createGrantedPersonaForImage({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'image-user-list-granted',
        serverId,
        imageId: seedState.image.id,
        deadline,
      });
      let intruder: StandardPersonaLease | null = null;
      try {
        intruder = await createStandardPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'image-user-list-ungranted',
          deadline,
        });
        expect((await anonymousApi.get('/api/images')).status()).toBe(401);
        const images = await expectJson<ImageView[]>(await granted.api.get('/api/images'));
        expect(images).toContainEqual(
          expect.objectContaining({
            id: seedState.image.id,
            dockerImage: seedState.image.dockerImage,
          }),
        );
        expect(
          (await expectJson<ImageView[]>(await intruder.api.get('/api/images'))).some(
            (image) => image.id === seedState.image.id,
          ),
        ).toBe(false);
      } finally {
        await runCleanupSteps('image user list exact scenario', [
          { label: 'granted persona', run: () => granted.cleanup() },
          ...(intruder ? [{ label: 'ungranted persona', run: () => intruder!.cleanup() }] : []),
        ]);
      }
    },
  );

  test(
    'api.images.user-get-exact-contract',
    coverageCase(
      'images.lifecycle.http.get.api-images-by-id',
      'api.images.user-get-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(300_000);
      const deadline = new AbsoluteDeadline(290_000);
      const serverId = seedState.servers[0].serverId;
      const granted = await createGrantedPersonaForImage({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'image-user-get-granted',
        serverId,
        imageId: seedState.image.id,
        deadline,
      });
      let intruder: StandardPersonaLease | null = null;
      try {
        intruder = await createStandardPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'image-user-get-ungranted',
          deadline,
        });
        expect((await anonymousApi.get(`/api/images/${seedState.image.id}`)).status()).toBe(401);
        expect((await intruder.api.get(`/api/images/${seedState.image.id}`)).status()).toBe(403);
        const image = await expectJson<ImageView>(
          await granted.api.get(`/api/images/${seedState.image.id}`),
        );
        expect(image).toEqual(
          expect.objectContaining({
            id: seedState.image.id,
            dockerImage: seedState.image.dockerImage,
            isActive: true,
          }),
        );
        expect(
          (
            await expectJson<ImageView>(
              await adminApi.get(`/api/admin/images/${seedState.image.id}`),
            )
          ).id,
        ).toBe(seedState.image.id);
      } finally {
        await runCleanupSteps('image user get exact scenario', [
          { label: 'granted persona', run: () => granted.cleanup() },
          ...(intruder ? [{ label: 'ungranted persona', run: () => intruder!.cleanup() }] : []),
        ]);
      }
    },
  );

  test(
    'api.agent-tasks.pending-to-terminal-real-container',
    coverageCase(
      'agent-tasks.durable-control.pending-to-terminal-transition',
      'api.agent-tasks.pending-to-terminal-real-container',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(420_000);
      const deadline = new AbsoluteDeadline(410_000);
      const serverId = seedState.servers[0].serverId;
      const scenario = await createOwnerTaskScenario({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'task-transition',
        serverId,
        imageId: seedState.image.id,
        deadline,
      });
      try {
        expect(scenario.ref.status).toBe('pending');
        expect(scenario.identity.taskId).toBe(scenario.ref.taskId);
        expect(scenario.identity.id).toBe(scenario.task.resourceId);
        const [adminDetail, ownerDetail] = await Promise.all([
          expectJson<AgentTaskView>(
            await adminApi.get(`/api/admin/agent-tasks/${scenario.ref.taskId}`),
          ),
          expectJson<UserAgentTaskView>(
            await scenario.owner.api.get(`/api/agent-tasks/${scenario.ref.taskId}`),
          ),
        ]);
        expectAdminDispatchEvidence(adminDetail, ownerDetail);
        expect(scenario.task).toEqual(
          expect.objectContaining({
            id: scenario.ref.taskId,
            kind: 'container.create',
            status: 'succeeded',
            requestedBy: scenario.owner.userId,
            startedAt: expect.any(String),
            completedAt: expect.any(String),
            retentionUntil: expect.any(String),
          }),
        );
        expect(scenario.view).toEqual(
          expect.objectContaining({
            id: scenario.identity.id,
            ownerId: scenario.owner.userId,
            runtime: expect.objectContaining({ bound: true, status: 'running' }),
          }),
        );
      } finally {
        await cleanupOwnerScenario({
          owner: scenario.owner,
          adminApi,
          identity: scenario.identity,
          deadline,
        });
      }
    },
  );

  test(
    'api.agent-tasks.user-and-admin-visibility',
    coverageCase(
      'agent-tasks.durable-control.user-and-admin-visibility',
      'api.agent-tasks.user-and-admin-visibility',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(420_000);
      const deadline = new AbsoluteDeadline(410_000);
      const serverId = seedState.servers[0].serverId;
      const scenario = await createOwnerTaskScenario({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'task-visibility',
        serverId,
        imageId: seedState.image.id,
        deadline,
      });
      let intruder: StandardPersonaLease | null = null;
      try {
        intruder = await createStandardPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'task-visibility-intruder',
          deadline,
        });
        const query = `resourceType=container&resourceId=${encodeURIComponent(scenario.identity.id!)}&limit=20`;
        const [adminTasks, ownerTasks, intruderTasks] = await Promise.all([
          expectJson<AgentTaskView[]>(await adminApi.get(`/api/admin/agent-tasks?${query}`)),
          expectJson<UserAgentTaskView[]>(await scenario.owner.api.get(`/api/agent-tasks?${query}`)),
          expectJson<UserAgentTaskView[]>(await intruder.api.get(`/api/agent-tasks?${query}`)),
        ]);
        const adminListTask = adminTasks.find((task) => task.id === scenario.task.id);
        const ownerListTask = ownerTasks.find((task) => task.id === scenario.task.id);
        expect(adminListTask).toBeDefined();
        expect(ownerListTask).toBeDefined();
        expectAdminDispatchEvidence(adminListTask!, ownerListTask!);
        expect(intruderTasks.some((task) => task.id === scenario.task.id)).toBe(false);
        const [adminDetail, ownerDetail] = await Promise.all([
          expectJson<AgentTaskView>(
            await adminApi.get(`/api/admin/agent-tasks/${scenario.task.id}`),
          ),
          expectJson<UserAgentTaskView>(
            await scenario.owner.api.get(`/api/agent-tasks/${scenario.task.id}`),
          ),
        ]);
        expectAdminDispatchEvidence(adminDetail, ownerDetail);
        expect(ownerDetail).not.toHaveProperty('requestedBy');
        expect((await intruder.api.get(`/api/agent-tasks/${scenario.task.id}`)).status()).toBe(404);
      } finally {
        await cleanupOwnerScenario({
          owner: scenario.owner,
          intruder,
          adminApi,
          identity: scenario.identity,
          deadline,
        });
      }
    },
  );

  test(
    'api.agent-tasks.effect-idempotency',
    coverageCase(
      'agent-tasks.durable-control.effect-idempotency',
      'api.agent-tasks.effect-idempotency',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(600_000);
      const deadline = new AbsoluteDeadline(470_000);
      const identity = trackedImage(seedState.runId, 'effect-idempotency');
      const serverId = seedState.servers.find((server) => server.key === 'node2')!.serverId;
      let persona: StandardPersonaLease | null = null;
      try {
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          seedState.uiImage.dockerImage,
          'effect-idempotency',
          identity,
        );
        persona = await createGrantedPersonaForImage({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'task-effect-idempotency',
          serverId,
          imageId: image.id,
          deadline,
        });

        const pullOnce = async (label: string): Promise<AgentTaskView> => {
          const pull = await expectJson<ImagePullResponse>(
            await adminApi.post(`/api/admin/images/${image.id}/pull`, {
              data: { serverIds: [serverId] },
            }),
            201,
          );
          expect(pull.rejected).toEqual([]);
          expect(pull.tasks).toHaveLength(1);
          return waitForAgentTask(adminApi, pull.tasks[0].taskId, {
            kind: 'image.ensure_present',
            resourceId: image.id,
            timeoutMs: deadline.remaining(`waiting for ${label} image ensure`, 120_000),
          });
        };

        const first = await pullOnce('first');
        await waitForImagePresentOnServers(
          adminApi,
          image.id,
          new Set([serverId]),
          deadline.remaining('waiting for first idempotent image inventory', 60_000),
        );
        const second = await pullOnce('second');
        expect(second.id).not.toBe(first.id);
        expect(first.result).toEqual(
          expect.objectContaining({
            imageId: image.id,
            dockerId: expect.any(String),
            dockerRef: seedState.uiImage.dockerImage,
          }),
        );
        expect(second.result).toEqual(first.result);
        expect(second.agentResult).toEqual(first.agentResult);
        expect(
          (await expectJson<ImageView>(await persona.api.get(`/api/images/${image.id}`))).id,
        ).toBe(image.id);
        const statuses = await expectJson<Array<{ serverId: string; present: boolean }>>(
          await adminApi.get(`/api/admin/images/${image.id}/status`),
        );
        expect(statuses.find((status) => status.serverId === serverId)?.present).toBe(true);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await runCleanupSteps('task effect-idempotency scenario', [
          ...(persona && identity.id
            ? [
                {
                  label: 'image grant',
                  run: () => persona!.revokeImage(identity.id!, serverId, cleanupDeadline),
                },
              ]
            : []),
          {
            label: 'image',
            run: () => cleanupImageLease(adminApi, identity, cleanupDeadline),
          },
          ...(persona ? [{ label: 'persona', run: () => persona!.cleanup(cleanupDeadline) }] : []),
        ]);
      }
    },
  );

  test(
    'api.agent-tasks.dispatch-retry',
    coverageCase('agent-tasks.durable-control.dispatch-retry', 'api.agent-tasks.dispatch-retry'),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState, topologyProvider }) => {
      test.setTimeout(720_000);
      const deadline = new AbsoluteDeadline(530_000);
      const target = seedState.servers.find((server) => server.key === 'node2')!;
      const identity = trackedImage(seedState.runId, 'dispatch-retry');
      let persona: StandardPersonaLease | null = null;
      let wireFault: Omit<AgentTaskWireFaultControlInput, 'action'> | null = null;
      let wireAttempted = false;
      try {
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          seedState.uiImage.dockerImage,
          'dispatch-retry',
          identity,
        );
        persona = await createGrantedPersonaForImage({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'task-dispatch-retry',
          serverId: target.serverId,
          imageId: image.id,
          deadline,
        });
        const stopped = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: target.key,
          action: 'stop',
        });
        expect(stopped.serviceActive).toBe(false);
        await waitForServerProjection(
          adminApi,
          target.serverId,
          'offline before durable dispatch',
          (server) => server.status === 'offline',
          deadline,
        );

        const pull = await expectJson<ImagePullResponse>(
          await adminApi.post(`/api/admin/images/${image.id}/pull`, {
            data: { serverIds: [target.serverId] },
          }),
          201,
        );
        expect(pull.rejected).toEqual([]);
        expect(pull.tasks).toHaveLength(1);
        const pending = await observeTaskPendingAndUnsent(adminApi, pull.tasks[0].taskId, deadline);
        expect(
          await expectJson<ServerView>(await adminApi.get(`/api/admin/servers/${target.serverId}`)),
        ).toEqual(expect.objectContaining({ status: 'offline' }));

        wireFault = {
          fault: 'agentTaskWire',
          runId: seedState.runId,
          nodeKey: target.key,
          mode: 'drop-terminal-once',
          taskId: pending.id,
          payloadHash: pending.payloadHash!,
        };
        wireAttempted = true;
        const injected = await controlProviderFault(topologyProvider, {
          ...wireFault,
          action: 'inject',
        });
        expect(injected).toEqual(
          expect.objectContaining({
            serviceActive: true,
            proxyActive: true,
            routeActive: true,
            released: false,
          }),
        );
        const firstWireEvidence = await waitForAgentTaskWireEvidence(
          topologyProvider,
          wireFault,
          'one exact execute and one dropped terminal',
          (result) =>
            result.executeCount === 1 &&
            result.terminalCount === 1 &&
            result.droppedCount === 1 &&
            result.forwardedTerminalCount === 0,
          deadline,
        );
        const firstSent = await expectJson<AgentTaskView>(
          await adminApi.get(`/api/admin/agent-tasks/${pending.id}`),
        );
        expect(firstSent).toEqual(
          expect.objectContaining({
            id: pending.id,
            status: 'pending',
            payloadHash: pending.payloadHash,
            dispatchAttemptCount: 1,
            startedAt: expect.any(String),
            lastSentAt: expect.any(String),
            agentResult: null,
            result: null,
            completedAt: null,
          }),
        );
        expect(firstSent.startedAt).toBe(firstSent.lastSentAt);

        const released = await controlProviderFault(topologyProvider, {
          ...wireFault,
          action: 'release',
        });
        expect(released).toEqual(
          expect.objectContaining({
            released: true,
            droppedCount: 1,
            mutatedCount: 0,
          }),
        );
        const terminal = await waitForAgentTask(adminApi, pending.id, {
          kind: 'image.ensure_present',
          resourceId: image.id,
          timeoutMs: deadline.remaining('waiting for real Agent task resend', 180_000),
        });
        expect(terminal).toEqual(
          expect.objectContaining({
            id: pending.id,
            serverId: target.serverId,
            status: 'succeeded',
            payloadHash: pending.payloadHash,
            dispatchAttemptCount: expect.any(Number),
            startedAt: firstSent.startedAt,
            lastSentAt: expect.any(String),
            completedAt: expect.any(String),
          }),
        );
        expect(terminal.dispatchAttemptCount).toBeGreaterThanOrEqual(2);
        expect(
          Date.parse(terminal.lastSentAt!) - Date.parse(firstSent.lastSentAt!),
        ).toBeGreaterThanOrEqual(5_000);
        const resentEvidence = await waitForAgentTaskWireEvidence(
          topologyProvider,
          wireFault,
          'same exact task resent and its cached terminal forwarded',
          (result) =>
            result.executeCount >= 2 &&
            result.terminalCount >= 2 &&
            result.droppedCount === 1 &&
            result.mutatedCount === 0 &&
            result.forwardedTerminalCount === 1,
          deadline,
        );
        expect(resentEvidence.firstExecuteAt).toBe(firstWireEvidence.firstExecuteAt);
        expect(Date.parse(resentEvidence.lastExecuteAt!)).toBeGreaterThan(
          Date.parse(firstWireEvidence.lastExecuteAt!),
        );
        await waitForImagePresentOnServers(
          adminApi,
          image.id,
          new Set([target.serverId]),
          deadline.remaining('waiting for recovered dispatch inventory', 60_000),
        );
        expect(
          (await expectJson<ImageView>(await persona.api.get(`/api/images/${image.id}`))).id,
        ).toBe(image.id);
        const taskHistory = await expectJson<AgentTaskView[]>(
          await adminApi.get(
            `/api/admin/agent-tasks?resourceType=image&resourceId=${encodeURIComponent(image.id)}&serverId=${encodeURIComponent(target.serverId)}&limit=100`,
          ),
        );
        expect(
          taskHistory.filter((task) => task.kind === 'image.ensure_present').map((task) => task.id),
        ).toEqual([pending.id]);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(180_000);
        await runCleanupSteps('task dispatch-retry scenario', [
          ...(wireAttempted && wireFault
            ? [
                {
                  label: 'restore exact Agent task wire path',
                  run: async () => {
                    const restored = await controlProviderFault(topologyProvider, {
                      ...wireFault!,
                      action: 'restore',
                    });
                    expect(restored).toEqual(
                      expect.objectContaining({
                        serviceActive: true,
                        proxyActive: false,
                        routeActive: false,
                        released: false,
                      }),
                    );
                  },
                },
              ]
            : []),
          {
            label: 'restore Agent service',
            run: async () => {
              const restored = await controlProviderFault(topologyProvider, {
                fault: 'agentService',
                runId: seedState.runId,
                nodeKey: target.key,
                action: 'start',
              });
              expect(restored.serviceActive).toBe(true);
              await waitForServerProjection(
                adminApi,
                target.serverId,
                'dispatch cleanup recovery',
                (server) => server.status === 'online' && server.runtimeReady,
                cleanupDeadline,
              );
            },
          },
          ...(persona && identity.id
            ? [
                {
                  label: 'image grant',
                  run: () => persona!.revokeImage(identity.id!, target.serverId, cleanupDeadline),
                },
              ]
            : []),
          {
            label: 'image',
            run: () => cleanupImageLease(adminApi, identity, cleanupDeadline),
          },
          ...(persona ? [{ label: 'persona', run: () => persona!.cleanup(cleanupDeadline) }] : []),
        ]);
      }
    },
  );

  test(
    'api.agent-tasks.result-validation',
    coverageCase(
      'agent-tasks.durable-control.result-validation',
      'api.agent-tasks.result-validation',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState, topologyProvider }) => {
      test.setTimeout(720_000);
      const deadline = new AbsoluteDeadline(530_000);
      const identity = trackedImage(seedState.runId, 'result-validation');
      const target = seedState.servers.find((server) => server.key === 'node1')!;
      let persona: StandardPersonaLease | null = null;
      let wireFault: Omit<AgentTaskWireFaultControlInput, 'action'> | null = null;
      let wireAttempted = false;
      let taskId: string | null = null;
      try {
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          seedState.uiImage.dockerImage,
          'result-validation',
          identity,
        );
        persona = await createGrantedPersonaForImage({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'task-result-validation',
          serverId: target.serverId,
          imageId: image.id,
          deadline,
        });
        const stopped = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: target.key,
          action: 'stop',
        });
        expect(stopped.serviceActive).toBe(false);
        await waitForServerProjection(
          adminApi,
          target.serverId,
          'offline before invalid-result dispatch',
          (server) => server.status === 'offline',
          deadline,
        );
        const pull = await expectJson<ImagePullResponse>(
          await adminApi.post(`/api/admin/images/${image.id}/pull`, {
            data: { serverIds: [target.serverId] },
          }),
          201,
        );
        expect(pull.rejected).toEqual([]);
        expect(pull.tasks).toHaveLength(1);
        taskId = pull.tasks[0].taskId;
        const pending = await observeTaskPendingAndUnsent(adminApi, taskId, deadline);
        wireFault = {
          fault: 'agentTaskWire',
          runId: seedState.runId,
          nodeKey: target.key,
          mode: 'mutate-image-ref-once',
          taskId,
          payloadHash: pending.payloadHash!,
        };
        wireAttempted = true;
        const injected = await controlProviderFault(topologyProvider, {
          ...wireFault,
          action: 'inject',
        });
        expect(injected).toEqual(
          expect.objectContaining({
            serviceActive: true,
            proxyActive: true,
            routeActive: true,
            released: false,
          }),
        );

        const terminal = await waitForTaskTerminal(
          adminApi,
          taskId,
          deadline.remaining('waiting for Backend invalid-result quarantine', 180_000),
        );
        expect(terminal).toEqual(
          expect.objectContaining({
            kind: 'image.ensure_present',
            resourceType: 'image',
            resourceId: image.id,
            serverId: target.serverId,
            requestedBy: seedState.adminUserId,
            status: 'failed',
            failureStage: 'agent',
            payloadHash: pending.payloadHash,
            result: null,
            completedAt: expect.any(String),
            retentionUntil: expect.any(String),
          }),
        );
        expect(terminal.agentResult).toBeNull();
        expect(terminal.error).toEqual(expect.objectContaining({ code: 'INVALID_AGENT_RESULT' }));
        const invalidEvidence = await waitForAgentTaskWireEvidence(
          topologyProvider,
          wireFault,
          'one exact semantic-invalid image result forwarded',
          (result) =>
            result.executeCount === 1 &&
            result.terminalCount === 1 &&
            result.droppedCount === 0 &&
            result.mutatedCount === 1 &&
            result.forwardedTerminalCount === 1,
          deadline,
        );
        expect(invalidEvidence.released).toBe(false);
        const quarantined = await waitForServerProjection(
          adminApi,
          target.serverId,
          'durable invalid-result quarantine',
          (server) => server.status === 'agent_quarantined',
          deadline,
        );
        expect(quarantined.runtimeReady).toBe(false);

        await persona.revokeImage(image.id, target.serverId);
        const blockedDelete = await adminApi.delete(`/api/admin/images/${image.id}`);
        expect(blockedDelete.status(), 'retained-lock response body asserted separately').toBe(409);
        expect((await blockedDelete.json()) as { message?: string }).toEqual(
          expect.objectContaining({
            message: 'Image is still referenced by a container, grant, or retained task lock',
          }),
        );

        const retried = await expectJson<{ taskIds: string[] }>(
          await adminApi.post(`/api/admin/servers/${target.serverId}/agent-quarantine/retry`),
          201,
        );
        expect(retried.taskIds).toEqual([taskId]);
        const recovered = await waitForAgentTask(adminApi, taskId, {
          kind: 'image.ensure_present',
          resourceId: image.id,
          timeoutMs: deadline.remaining('waiting for exact admin task retry recovery', 180_000),
        });
        expect(recovered).toEqual(
          expect.objectContaining({
            id: taskId,
            status: 'succeeded',
            payloadHash: pending.payloadHash,
            startedAt: terminal.startedAt,
            result: expect.objectContaining({
              dockerRef: seedState.uiImage.dockerImage,
            }),
            error: null,
          }),
        );
        const recoveryEvidence = await waitForAgentTaskWireEvidence(
          topologyProvider,
          wireFault,
          'same task retried with the unmodified cached result',
          (result) =>
            result.executeCount >= 2 &&
            result.terminalCount >= 2 &&
            result.mutatedCount === 1 &&
            result.forwardedTerminalCount >= 2,
          deadline,
        );
        expect(recoveryEvidence.taskId).toBe(taskId);
        await waitForServerProjection(
          adminApi,
          target.serverId,
          'online after exact invalid-result retry',
          (server) => server.status === 'online' && server.runtimeReady,
          deadline,
        );
        expect(
          (await expectJson<ImageView>(await adminApi.get(`/api/admin/images/${image.id}`))).id,
        ).toBe(image.id);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(180_000);
        await runCleanupSteps('task result-validation scenario', [
          ...(wireAttempted && wireFault
            ? [
                {
                  label: 'restore exact Agent task wire path',
                  run: async () => {
                    const restored = await controlProviderFault(topologyProvider, {
                      ...wireFault!,
                      action: 'restore',
                    });
                    expect(restored).toEqual(
                      expect.objectContaining({
                        serviceActive: true,
                        proxyActive: false,
                        routeActive: false,
                        released: false,
                      }),
                    );
                  },
                },
              ]
            : []),
          {
            label: 'restore Agent service',
            run: async () => {
              const restored = await controlProviderFault(topologyProvider, {
                fault: 'agentService',
                runId: seedState.runId,
                nodeKey: target.key,
                action: 'start',
              });
              expect(restored.serviceActive).toBe(true);
            },
          },
          ...(taskId
            ? [
                {
                  label: 'recover retained invalid-result authority',
                  run: async () => {
                    const server = await expectJson<ServerView>(
                      await adminApi.get(`/api/admin/servers/${target.serverId}`),
                    );
                    if (server.status === 'agent_quarantined') {
                      const retried = await expectJson<{ taskIds: string[] }>(
                        await adminApi.post(
                          `/api/admin/servers/${target.serverId}/agent-quarantine/retry`,
                        ),
                        201,
                      );
                      expect(retried.taskIds).toContain(taskId);
                      await waitForAgentTask(adminApi, taskId!, {
                        timeoutMs: cleanupDeadline.remaining(
                          'recovering invalid-result cleanup authority',
                          120_000,
                        ),
                      });
                    }
                    await waitForServerProjection(
                      adminApi,
                      target.serverId,
                      'result-validation cleanup recovery',
                      (current) => current.status === 'online' && current.runtimeReady,
                      cleanupDeadline,
                    );
                  },
                },
              ]
            : []),
          ...(persona && identity.id
            ? [
                {
                  label: 'image grant',
                  run: () => persona!.revokeImage(identity.id!, target.serverId, cleanupDeadline),
                },
              ]
            : []),
          {
            label: 'image',
            run: () => cleanupImageLease(adminApi, identity, cleanupDeadline),
          },
          ...(persona ? [{ label: 'persona', run: () => persona!.cleanup(cleanupDeadline) }] : []),
        ]);
      }
    },
  );

  test(
    'api.agent-tasks.retention-metadata',
    coverageCase(
      'agent-tasks.durable-control.retention-metadata',
      'api.agent-tasks.retention-metadata',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(540_000);
      const deadline = new AbsoluteDeadline(410_000);
      const scenario = await createOwnerTaskScenario({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'task-retention-metadata',
        serverId: seedState.servers[0].serverId,
        imageId: seedState.image.id,
        deadline,
      });
      try {
        const ownerDetail = await expectJson<UserAgentTaskView>(
          await scenario.owner.api.get(`/api/agent-tasks/${scenario.task.id}`),
        );
        const completedAt = Date.parse(ownerDetail.completedAt!);
        const retentionUntil = Date.parse(ownerDetail.retentionUntil!);
        expect(Number.isFinite(completedAt)).toBe(true);
        expect(Number.isFinite(retentionUntil)).toBe(true);
        expect(retentionUntil - completedAt).toBe(7 * 24 * 60 * 60_000);
        expect(retentionUntil).toBeGreaterThan(Date.now());

        await cleanupOwnedContainer(scenario.owner.api, adminApi, scenario.identity, deadline);
        const retained = await expectJson<AgentTaskView>(
          await adminApi.get(`/api/admin/agent-tasks/${scenario.task.id}`),
        );
        expect(retained).toEqual(
          expect.objectContaining({
            id: scenario.task.id,
            status: 'succeeded',
            requestedBy: scenario.owner.userId,
            completedAt: ownerDetail.completedAt,
            retentionUntil: ownerDetail.retentionUntil,
            result: scenario.task.result,
          }),
        );
        expect(
          (await scenario.owner.api.get(`/api/v2/containers/${scenario.identity.id!}`)).status(),
        ).toBe(404);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await cleanupOwnerScenario({
          owner: scenario.owner,
          adminApi,
          identity: scenario.identity,
          deadline: cleanupDeadline,
        });
      }
    },
  );

  test(
    'api.agent-tasks.resource-serialization',
    coverageCase(
      'agent-tasks.durable-control.resource-serialization',
      'api.agent-tasks.resource-serialization',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState, topologyProvider }) => {
      test.setTimeout(600_000);
      const deadline = new AbsoluteDeadline(470_000);
      const target = seedState.servers.find((server) => server.key === 'node2')!;
      const identity = trackedImage(seedState.runId, 'resource-serialization');
      let persona: StandardPersonaLease | null = null;
      try {
        const image = await createDisposableImage(
          adminApi,
          seedState.runId,
          seedState.uiImage.dockerImage,
          'resource-serialization',
          identity,
        );
        persona = await createGrantedPersonaForImage({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'task-resource-serialization',
          serverId: target.serverId,
          imageId: image.id,
          deadline,
        });
        const stopped = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: target.key,
          action: 'stop',
        });
        expect(stopped.serviceActive).toBe(false);
        await waitForServerProjection(
          adminApi,
          target.serverId,
          'offline before resource serialization',
          (server) => server.status === 'offline',
          deadline,
        );

        const path = `/api/admin/images/${image.id}/pull`;
        const body = { data: { serverIds: [target.serverId] } };
        const [firstResponse, secondResponse] = await Promise.all([
          adminApi.post(path, body),
          adminApi.post(path, body),
        ]);
        const [first, second] = await Promise.all([
          expectJson<ImagePullResponse>(firstResponse, 201),
          expectJson<ImagePullResponse>(secondResponse, 201),
        ]);
        const tasks = [...first.tasks, ...second.tasks];
        const rejected = [...first.rejected, ...second.rejected];
        expect(tasks).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toEqual(
          expect.objectContaining({
            serverId: target.serverId,
            message: expect.any(String),
          }),
        );
        await observeTaskPendingAndUnsent(adminApi, tasks[0].taskId, deadline);
        expect(
          await expectJson<ServerView>(await adminApi.get(`/api/admin/servers/${target.serverId}`)),
        ).toEqual(expect.objectContaining({ status: 'offline' }));
        const resourceTasks = await expectJson<AgentTaskView[]>(
          await adminApi.get(
            `/api/admin/agent-tasks?resourceType=image&resourceId=${encodeURIComponent(image.id)}&serverId=${encodeURIComponent(target.serverId)}&limit=20`,
          ),
        );
        expect(resourceTasks.map((task) => task.id)).toEqual([tasks[0].taskId]);

        const started = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: target.key,
          action: 'start',
        });
        expect(started.serviceActive).toBe(true);
        await waitForServerProjection(
          adminApi,
          target.serverId,
          'online after resource serialization',
          (server) => server.status === 'online' && server.runtimeReady,
          deadline,
        );
        const terminal = await waitForAgentTask(adminApi, tasks[0].taskId, {
          kind: 'image.ensure_present',
          resourceId: image.id,
          timeoutMs: deadline.remaining('waiting for serialized task', 120_000),
        });
        expect(terminal.serverId).toBe(target.serverId);
        await waitForImagePresentOnServers(
          adminApi,
          image.id,
          new Set([target.serverId]),
          deadline.remaining('waiting for serialized image inventory', 60_000),
        );
        expect(
          (await expectJson<ImageView>(await persona.api.get(`/api/images/${image.id}`))).id,
        ).toBe(image.id);
      } finally {
        const cleanupDeadline = new AbsoluteDeadline(cleanupBudgetMs);
        await runCleanupSteps('task resource-serialization scenario', [
          {
            label: 'restore Agent service',
            run: async () => {
              const restored = await controlProviderFault(topologyProvider, {
                fault: 'agentService',
                runId: seedState.runId,
                nodeKey: target.key,
                action: 'start',
              });
              expect(restored.serviceActive).toBe(true);
              await waitForServerProjection(
                adminApi,
                target.serverId,
                'serialization cleanup recovery',
                (server) => server.status === 'online' && server.runtimeReady,
                cleanupDeadline,
              );
            },
          },
          ...(persona && identity.id
            ? [
                {
                  label: 'image grant',
                  run: () => persona!.revokeImage(identity.id!, target.serverId, cleanupDeadline),
                },
              ]
            : []),
          {
            label: 'image',
            run: () => cleanupImageLease(adminApi, identity, cleanupDeadline),
          },
          ...(persona ? [{ label: 'persona', run: () => persona!.cleanup(cleanupDeadline) }] : []),
        ]);
      }
    },
  );

  test(
    'api.agent-tasks.admin-list-exact-contract',
    coverageCase(
      'agent-tasks.durable-control.http.get.api-admin-agent-tasks',
      'api.agent-tasks.admin-list-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(420_000);
      const deadline = new AbsoluteDeadline(410_000);
      const scenario = await createOwnerTaskScenario({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'task-admin-list',
        serverId: seedState.servers[0].serverId,
        imageId: seedState.image.id,
        deadline,
      });
      try {
        expect((await anonymousApi.get('/api/admin/agent-tasks')).status()).toBe(401);
        expect((await scenario.owner.api.get('/api/admin/agent-tasks')).status()).toBe(403);
        const tasks = await expectJson<AgentTaskView[]>(
          await adminApi.get(
            `/api/admin/agent-tasks?resourceType=container&resourceId=${encodeURIComponent(scenario.identity.id!)}&limit=20`,
          ),
        );
        expect(tasks).toContainEqual(
          expect.objectContaining({
            id: scenario.task.id,
            requestedBy: scenario.owner.userId,
            status: 'succeeded',
          }),
        );
      } finally {
        await cleanupOwnerScenario({
          owner: scenario.owner,
          adminApi,
          identity: scenario.identity,
          deadline,
        });
      }
    },
  );

  test(
    'api.agent-tasks.admin-detail-exact-contract',
    coverageCase(
      'agent-tasks.durable-control.http.get.api-admin-agent-tasks-by-taskid',
      'api.agent-tasks.admin-detail-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(420_000);
      const deadline = new AbsoluteDeadline(410_000);
      const scenario = await createOwnerTaskScenario({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'task-admin-detail',
        serverId: seedState.servers[0].serverId,
        imageId: seedState.image.id,
        deadline,
      });
      try {
        expect(
          (await anonymousApi.get(`/api/admin/agent-tasks/${scenario.task.id}`)).status(),
        ).toBe(401);
        expect(
          (await scenario.owner.api.get(`/api/admin/agent-tasks/${scenario.task.id}`)).status(),
        ).toBe(403);
        const task = await expectJson<AgentTaskView>(
          await adminApi.get(`/api/admin/agent-tasks/${scenario.task.id}`),
        );
        expect(task).toEqual(
          expect.objectContaining({
            id: scenario.task.id,
            kind: 'container.create',
            resourceId: scenario.identity.id,
            status: 'succeeded',
            requestedBy: scenario.owner.userId,
            completedAt: expect.any(String),
            retentionUntil: expect.any(String),
          }),
        );
      } finally {
        await cleanupOwnerScenario({
          owner: scenario.owner,
          adminApi,
          identity: scenario.identity,
          deadline,
        });
      }
    },
  );

  test(
    'api.agent-tasks.user-list-exact-contract',
    coverageCase(
      'agent-tasks.durable-control.http.get.api-agent-tasks',
      'api.agent-tasks.user-list-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(420_000);
      const deadline = new AbsoluteDeadline(410_000);
      const scenario = await createOwnerTaskScenario({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'task-user-list',
        serverId: seedState.servers[0].serverId,
        imageId: seedState.image.id,
        deadline,
      });
      let intruder: StandardPersonaLease | null = null;
      try {
        intruder = await createStandardPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'task-user-list-intruder',
          deadline,
        });
        expect((await anonymousApi.get('/api/agent-tasks')).status()).toBe(401);
        const query = `resourceType=container&resourceId=${encodeURIComponent(scenario.identity.id!)}&limit=20`;
        const [ownerTasks, intruderTasks, adminTasks] = await Promise.all([
          expectJson<UserAgentTaskView[]>(await scenario.owner.api.get(`/api/agent-tasks?${query}`)),
          expectJson<UserAgentTaskView[]>(await intruder.api.get(`/api/agent-tasks?${query}`)),
          expectJson<AgentTaskView[]>(await adminApi.get(`/api/admin/agent-tasks?${query}`)),
        ]);
        const ownerListTask = ownerTasks.find((task) => task.id === scenario.task.id);
        const adminListTask = adminTasks.find((task) => task.id === scenario.task.id);
        expect(ownerListTask).toBeDefined();
        expect(adminListTask).toBeDefined();
        expectAdminDispatchEvidence(adminListTask!, ownerListTask!);
        expect(ownerTasks.every((task) => !Object.hasOwn(task, 'requestedBy'))).toBe(true);
        expect(intruderTasks.some((task) => task.id === scenario.task.id)).toBe(false);
      } finally {
        await cleanupOwnerScenario({
          owner: scenario.owner,
          intruder,
          adminApi,
          identity: scenario.identity,
          deadline,
        });
      }
    },
  );

  test(
    'api.agent-tasks.user-detail-exact-contract',
    coverageCase(
      'agent-tasks.durable-control.http.get.api-agent-tasks-by-taskid',
      'api.agent-tasks.user-detail-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(420_000);
      const deadline = new AbsoluteDeadline(410_000);
      const scenario = await createOwnerTaskScenario({
        adminApi,
        anonymousApi,
        trackedApiFactory,
        runId: seedState.runId,
        label: 'task-user-detail',
        serverId: seedState.servers[0].serverId,
        imageId: seedState.image.id,
        deadline,
      });
      let intruder: StandardPersonaLease | null = null;
      try {
        intruder = await createStandardPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          runId: seedState.runId,
          label: 'task-user-detail-intruder',
          deadline,
        });
        expect((await anonymousApi.get(`/api/agent-tasks/${scenario.task.id}`)).status()).toBe(401);
        expect((await intruder.api.get(`/api/agent-tasks/${scenario.task.id}`)).status()).toBe(404);
        const [ownerTask, adminTask] = await Promise.all([
          expectJson<UserAgentTaskView>(
            await scenario.owner.api.get(`/api/agent-tasks/${scenario.task.id}`),
          ),
          expectJson<AgentTaskView>(
            await adminApi.get(`/api/admin/agent-tasks/${scenario.task.id}`),
          ),
        ]);
        expectAdminDispatchEvidence(adminTask, ownerTask);
        expect(ownerTask).toEqual(
          expect.objectContaining({
            id: scenario.task.id,
            resourceType: 'container',
            resourceId: scenario.identity.id,
            status: 'succeeded',
          }),
        );
        expect(ownerTask).not.toHaveProperty('requestedBy');
      } finally {
        await cleanupOwnerScenario({
          owner: scenario.owner,
          intruder,
          adminApi,
          identity: scenario.identity,
          deadline,
        });
      }
    },
  );
});
