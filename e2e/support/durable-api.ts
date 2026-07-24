import type { APIRequestContext } from '@playwright/test';
import { expectJson } from './http.js';

export interface AgentTaskView {
  id: string;
  kind: string;
  status: 'pending' | 'succeeded' | 'failed';
  resourceType: string;
  resourceId: string;
  serverId: string;
  /** Privileged evidence returned only by the admin task surface. */
  requestedBy?: string | null;
  request?: unknown | null;
  agentResult?: unknown | null;
  result?: unknown | null;
  error: unknown | null;
  failureStage: 'dispatch' | 'agent' | 'finalizer' | null;
  createdAt: string;
  startedAt: string | null;
  lastSentAt: string | null;
  payloadHash?: string;
  dispatchAttemptCount?: number;
  completedAt: string | null;
  retentionUntil: string | null;
}

export type UserAgentTaskView = Omit<
  AgentTaskView,
  'requestedBy' | 'request' | 'agentResult' | 'result' | 'payloadHash' | 'dispatchAttemptCount'
>;

export interface AgentTaskRef {
  ok: true;
  taskId: string;
  status: 'pending' | 'succeeded' | 'failed';
}

export interface ContainerRuntimeDriftView {
  kind: string;
  message?: string;
  desired?: unknown;
  observed?: unknown;
}

export interface ContainerMountView {
  id: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  dirName: string;
  containerPath: string;
}

export interface ContainerView {
  id: string;
  serverId: string;
  ownerId: string;
  name: string;
  imageId: string;
  failureCode?: string | null;
  failureReason?: string | null;
  powerIntent: 'running' | 'stopped';
  runtimeReady: boolean;
  runtime: {
    bound: boolean;
    runtimeId: string | null;
    status: 'creating' | 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'unknown';
    ip?: string | null;
    observedAt: string | null;
    stale?: boolean;
    drift: ContainerRuntimeDriftView[];
  };
  activeTask: AgentTaskView | null;
  resources: {
    cpuMillis: number;
    memBytes: number;
    diskBytes: number;
    gpuIndices: number[];
  };
  ssh: {
    enabled: boolean;
    status: string;
    ready: boolean;
    disabledReason?: string;
    login?: { omittedServer: string | null; explicitServer: string | null };
    proxyHost?: string | null;
    proxyPort?: number | null;
    observedAt?: string | null;
    appliedInternalKeyGeneration?: number | null;
    hostKeyFingerprint?: string | null;
    user?: 'root';
    port?: 22;
    lastError?: string;
  };
  mounts: ContainerMountView[];
  actions: Record<string, { enabled: boolean; reason?: string; message?: string }>;
}

export async function waitForAgentTask(
  api: APIRequestContext,
  taskId: string,
  options: { kind?: string; resourceId?: string; timeoutMs?: number } = {},
): Promise<AgentTaskView> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let last: AgentTaskView | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<AgentTaskView>(await api.get(`/api/admin/agent-tasks/${taskId}`));
    if (last.status === 'failed') {
      throw new Error(
        `Durable task ${taskId} (${last.kind}) failed at ${String(last.failureStage)}: ${JSON.stringify(last.error)}`,
      );
    }
    if (last.status === 'succeeded') {
      if (options.kind && last.kind !== options.kind) {
        throw new Error(`Task ${taskId} kind is ${last.kind}, expected ${options.kind}`);
      }
      if (options.resourceId && last.resourceId !== options.resourceId) {
        throw new Error(
          `Task ${taskId} resource is ${last.resourceId}, expected ${options.resourceId}`,
        );
      }
      if (!last.completedAt || !last.retentionUntil) {
        throw new Error(`Succeeded task ${taskId} is missing durable completion metadata`);
      }
      return last;
    }
    await delay(500);
  }
  throw new Error(
    `Durable task ${taskId} did not settle within ${options.timeoutMs ?? 120_000}ms; last=${JSON.stringify(last)}`,
  );
}

export async function waitForContainer(
  api: APIRequestContext,
  containerId: string,
  description: string,
  accept: (container: ContainerView) => boolean,
  timeoutMs = 60_000,
): Promise<ContainerView> {
  const deadline = Date.now() + timeoutMs;
  let last: ContainerView | null = null;
  while (Date.now() < deadline) {
    const response = await api.get(`/api/v2/containers/${containerId}`);
    if (response.status() === 200) {
      last = await expectJson<ContainerView>(response);
      if (accept(last)) return last;
    } else if (response.status() !== 404) {
      await expectJson<unknown>(response);
    }
    await delay(500);
  }
  throw new Error(
    `Container ${containerId} did not reach ${description} within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

export async function getContainerOrNull(
  api: APIRequestContext,
  containerId: string,
): Promise<ContainerView | null> {
  const response = await api.get(`/api/v2/containers/${containerId}`);
  if (response.status() === 404) return null;
  return expectJson<ContainerView>(response);
}

export async function waitForContainerAbsent(
  api: APIRequestContext,
  containerId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await getContainerOrNull(api, containerId)) === null) return;
    await delay(500);
  }
  throw new Error(`Container ${containerId} remains in the durable control plane after deletion`);
}

export async function requestContainerAction(
  api: APIRequestContext,
  containerId: string,
  action: 'start' | 'stop' | 'restart' | 'delete',
): Promise<AgentTaskRef> {
  return expectJson<AgentTaskRef>(
    await api.post(`/api/v2/containers/${containerId}/actions/${action}`),
    201,
  );
}

export async function cleanupContainerThroughProductApi(
  ownerApi: APIRequestContext,
  containerId: string,
  taskObserverApi: APIRequestContext = ownerApi,
): Promise<AgentTaskView | null> {
  let container = await getContainerOrNull(ownerApi, containerId);
  if (!container) return null;

  if (container.activeTask?.status === 'pending') {
    try {
      await waitForAgentTask(taskObserverApi, container.activeTask.id, { timeoutMs: 120_000 });
    } catch {
      // A failed lifecycle task is terminal and may make delete available. The
      // caller's primary assertion retains the task failure; cleanup still has
      // to remove any partially created product resource.
    }
  }

  container = await getContainerOrNull(ownerApi, containerId);
  if (!container) return null;
  container = await waitForContainer(
    ownerApi,
    containerId,
    'delete availability during cleanup',
    (view) => view.actions.delete?.enabled === true && view.activeTask === null,
    30_000,
  );
  const deletion = await requestContainerAction(ownerApi, container.id, 'delete');
  const task = await waitForAgentTask(taskObserverApi, deletion.taskId, {
    kind: 'container.delete',
    resourceId: container.id,
    timeoutMs: 120_000,
  });
  await waitForContainerAbsent(ownerApi, container.id);
  return task;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
