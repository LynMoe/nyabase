import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures/live-stack.js';
import { ContainerDeadline } from '../../support/container-deadline.js';
import {
  closeConsoleAfterOutput,
  closePersistentConsoleForCleanup,
  executeThroughConsole,
  openPersistentConsoleUntilOutput,
  requirePersistentConsoleClosed,
  type ConsoleSession,
} from '../../support/console.js';
import {
  cleanupContainerPersona,
  createContainerPersona,
  type ContainerPersona,
} from '../../support/container-persona.js';
import { coverageCase } from '../../support/coverage-marker.js';
import {
  cleanupContainerThroughProductApi,
  requestContainerAction,
  waitForAgentTask,
  waitForContainer,
  type AgentTaskRef,
  type AgentTaskView,
  type ContainerView,
} from '../../support/durable-api.js';
import { expectJson } from '../../support/http.js';
import {
  aggregateErrorWithDiagnostics,
  runCleanupStepsPreservingPrimary,
} from '../../support/error-diagnostics.mjs';
import { controlProviderFault } from '../../support/provider-fault-control.js';
import { controlProxyClient } from '../../support/proxy-client-control.js';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';
import { ContainerSshImageLease } from '../../support/container-ssh-image-lease.js';
import {
  ContainerLease,
  uniqueContainerLeaseName,
} from '../../support/container-lease.js';
import type { SeedState } from '../../support/seed-state.js';
import type {
  AgentTaskWireFaultControlInput,
  AgentTaskWireFaultControlResult,
  AvailableTopologyProvider,
  TopologyNodeKey,
} from '../../topology/provider.js';

interface RecoveryProof {
  schemaVersion: 1;
  runId: string;
  fault: { kind: string; target: string; appliedAt: string };
  before: { generation: string; healthy: boolean };
  after: { generation: string; healthy: boolean };
}

interface ServerView {
  id: string;
  status: string;
  runtimeReady: boolean;
  runtimeObservedAt?: string | null;
  quarantineCode: string | null;
  quarantineMessage: string | null;
}

interface ImageView {
  id: string;
  name: string;
  dockerImage: string;
  deleting: boolean;
}

interface ImagePullResponse {
  tasks: Array<AgentTaskRef & { serverId: string }>;
  rejected: Array<{ serverId: string; message: string }>;
}

interface ProxyStatus {
  connectedProxies: number;
  activeConnections: number;
  proxies: Array<{
    lastSnapshotGeneration: number | null;
    lastSnapshotAt: number | null;
    activeConnections: number;
  }>;
}

interface HttpDomainPool {
  id: string;
  wildcardDomain: string;
}

interface HttpProxyBinding {
  id: string;
  hostname: string;
  status: string;
}

async function waitForProxySnapshotAfter(
  api: APIRequestContext,
  path: '/api/admin/ssh-proxy/status' | '/api/admin/http-proxy/status',
  observedAt: string,
  timeoutMs = 60_000,
): Promise<ProxyStatus> {
  const minimumSnapshotAt = Date.parse(observedAt);
  const deadline = Date.now() + timeoutMs;
  let last: ProxyStatus | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<ProxyStatus>(await api.get(path));
    const proxy = last.proxies[0];
    if (
      last.connectedProxies === 1
      && proxy?.lastSnapshotGeneration !== null
      && proxy?.lastSnapshotAt !== null
      && proxy.lastSnapshotAt >= minimumSnapshotAt
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Proxy status ${path} did not install a snapshot after ${observedAt}; last=${JSON.stringify(last)}`,
  );
}

interface RunningAdminContainer {
  id: string;
  serverId: string;
  task: AgentTaskView;
  view: ContainerView;
}

interface WireScenarioFixtures {
  adminApi: APIRequestContext;
  seedState: SeedState;
  topologyProvider: AvailableTopologyProvider;
}

interface WireScenario {
  image: ImageView;
  target: SeedState['servers'][number];
  task: AgentTaskView;
  fault: Omit<AgentTaskWireFaultControlInput, 'action'>;
}

let resourceSequence = 0;

function uniqueName(runId: string, label: string, max = 64): string {
  resourceSequence += 1;
  const safe = `${runId}-${label}-${Date.now().toString(36)}-${resourceSequence}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  return safe.slice(0, max);
}

async function waitForServer(
  api: APIRequestContext,
  serverId: string,
  description: string,
  accept: (server: ServerView) => boolean,
  timeoutMs = 120_000,
): Promise<ServerView> {
  const deadline = Date.now() + timeoutMs;
  let last: ServerView | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<ServerView>(await api.get(`/api/admin/servers/${serverId}`));
    if (accept(last)) return last;
    await delay(500);
  }
  throw new Error(
    `Server ${serverId} did not reach ${description} within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

async function createRunningAdminContainer(
  adminApi: APIRequestContext,
  seedState: SeedState,
  nodeKey: TopologyNodeKey,
  label: string,
  options: { imageId?: string; sshEnabled?: boolean } = {},
): Promise<RunningAdminContainer> {
  const server = seedState.servers.find((candidate) => candidate.key === nodeKey);
  if (!server) throw new Error(`Seed state has no ${nodeKey}`);
  const ref = await expectJson<AgentTaskRef>(
    await adminApi.post('/api/v2/containers', {
      data: {
        serverId: server.serverId,
        imageId: options.imageId ?? seedState.image.id,
        name: uniqueName(seedState.runId, label),
      },
    }),
    201,
  );
  const pending = await expectJson<AgentTaskView>(
    await adminApi.get(`/api/admin/agent-tasks/${ref.taskId}`),
  );
  const task = await waitForAgentTask(adminApi, ref.taskId, {
    kind: 'container.create',
    resourceId: pending.resourceId,
    timeoutMs: 180_000,
  });
  const view = await waitForRunningContainerQuiescence(
    adminApi,
    server.serverId,
    pending.resourceId,
    options.sshEnabled ?? false,
  );
  if (!view.runtime.runtimeId || !/^[a-f0-9]{64}$/.test(view.runtime.runtimeId)) {
    throw new Error(`Container ${view.id} has no full physical Docker identity`);
  }
  return { id: pending.resourceId, serverId: server.serverId, task, view };
}

async function waitForRunningContainerQuiescence(
  adminApi: APIRequestContext,
  serverId: string,
  containerId: string,
  expectedSshEnabled = false,
  timeoutMs = 180_000,
): Promise<ContainerView> {
  const deadline = Date.now() + timeoutMs;
  let stableFingerprint: string | null = null;
  let lastReportMarker: number | null = null;
  let reportAdvancements = 0;
  let lastView: ContainerView | null = null;
  let lastTasks: AgentTaskView[] = [];
  let lastServer: ServerView | null = null;
  while (Date.now() < deadline) {
    [lastView, lastTasks, lastServer] = await Promise.all([
      expectJson<ContainerView>(await adminApi.get(`/api/admin/v2/containers/${containerId}`)),
      listContainerTasks(adminApi, containerId),
      expectJson<ServerView>(await adminApi.get(`/api/admin/servers/${serverId}`)),
    ]);
    const taskFingerprint = JSON.stringify(
      lastTasks
        .map(({ id, kind, status, completedAt }) => ({ id, kind, status, completedAt }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    const sshConverged = expectedSshEnabled
      ? lastView.ssh.enabled === true && lastView.ssh.status === 'running' && lastView.ssh.ready
      : lastView.ssh.enabled === false && lastView.ssh.status === 'disabled';
    const converged =
      lastServer.status === 'online' &&
      lastServer.runtimeReady &&
      lastView.runtime.bound &&
      lastView.runtime.status === 'running' &&
      lastView.powerIntent === 'running' &&
      lastView.activeTask === null &&
      (lastView.failureCode ?? null) === null &&
      sshConverged &&
      typeof lastView.ssh.observedAt === 'string' &&
      !Number.isNaN(Date.parse(lastView.ssh.observedAt)) &&
      lastTasks.length > 0 &&
      lastTasks.every((candidate) =>
        candidate.status === 'succeeded'
        || (candidate.status === 'failed'
          && (candidate.error as { code?: unknown } | null)?.code === 'TASK_SUPERSEDED'));
    if (converged) {
      const containerFingerprint = JSON.stringify({
        runtimeId: lastView.runtime.runtimeId,
        status: lastView.runtime.status,
        powerIntent: lastView.powerIntent,
        activeTaskId: lastView.activeTask?.id ?? null,
        failureCode: lastView.failureCode ?? null,
        sshEnabled: lastView.ssh.enabled,
        sshStatus: lastView.ssh.status,
        sshReady: lastView.ssh.ready,
        taskFingerprint,
      });
      const marker = typeof lastServer.runtimeObservedAt === 'string'
        ? Date.parse(lastServer.runtimeObservedAt)
        : Number.NaN;
      if (containerFingerprint !== stableFingerprint || !Number.isFinite(marker)) {
        stableFingerprint = containerFingerprint;
        lastReportMarker = Number.isFinite(marker) ? marker : null;
        reportAdvancements = 0;
      } else if (lastReportMarker !== null && marker > lastReportMarker) {
        lastReportMarker = marker;
        reportAdvancements += 1;
        if (reportAdvancements >= 2) return lastView;
      }
    } else {
      stableFingerprint = null;
      lastReportMarker = null;
      reportAdvancements = 0;
    }
    await delay(500);
  }
  throw new Error(
    `Container ${containerId} did not remain converged across two later full reports; advancements=${reportAdvancements} lastServer=${JSON.stringify(lastServer)} lastView=${JSON.stringify(lastView)} lastTasks=${JSON.stringify(lastTasks)}`,
  );
}

async function waitForStableUndispatchedSshOwner(
  adminApi: APIRequestContext,
  serverId: string,
  containerId: string,
  runtimeId: string,
  timeoutMs = 180_000,
): Promise<AgentTaskView> {
  const deadline = Date.now() + timeoutMs;
  let taskId: string | null = null;
  let lastReportMarker: number | null = null;
  let reportAdvancements = 0;
  let lastState: unknown = null;
  while (Date.now() < deadline) {
    const [view, server] = await Promise.all([
      expectJson<ContainerView>(await adminApi.get(`/api/admin/v2/containers/${containerId}`)),
      expectJson<ServerView>(await adminApi.get(`/api/admin/servers/${serverId}`)),
    ]);
    const active = view.activeTask;
    const task = active?.kind === 'container.ssh.ensure'
      ? await expectJson<AgentTaskView>(
        await adminApi.get(`/api/admin/agent-tasks/${active.id}`),
      )
      : null;
    const matches =
      server.status === 'online' &&
      server.runtimeReady &&
      view.runtime.bound &&
      view.runtime.runtimeId === runtimeId &&
      view.runtime.status === 'running' &&
      view.powerIntent === 'running' &&
      (view.failureCode ?? null) === null &&
      task?.kind === 'container.ssh.ensure' &&
      task.resourceId === containerId &&
      task.status === 'pending' &&
      task.dispatchAttemptCount === 0 &&
      task.startedAt === null &&
      task.lastSentAt === null;
    const marker = typeof server.runtimeObservedAt === 'string'
      ? Date.parse(server.runtimeObservedAt)
      : Number.NaN;
    if (matches && task) {
      if (taskId !== task.id || !Number.isFinite(marker)) {
        taskId = task.id;
        lastReportMarker = Number.isFinite(marker) ? marker : null;
        reportAdvancements = 0;
      } else if (lastReportMarker !== null && marker > lastReportMarker) {
        lastReportMarker = marker;
        reportAdvancements += 1;
        if (reportAdvancements >= 2) return task;
      }
    } else {
      taskId = null;
      lastReportMarker = null;
      reportAdvancements = 0;
    }
    lastState = {
      serverStatus: server.status,
      runtimeReady: server.runtimeReady,
      runtimeObservedAt: server.runtimeObservedAt ?? null,
      runtimeId: view.runtime.runtimeId,
      runtimeStatus: view.runtime.status,
      powerIntent: view.powerIntent,
      failureCode: view.failureCode ?? null,
      activeTask: active
        ? { id: active.id, kind: active.kind, status: active.status }
        : null,
      task: task
        ? {
          id: task.id,
          status: task.status,
          dispatchAttemptCount: task.dispatchAttemptCount,
          startedAt: task.startedAt,
          lastSentAt: task.lastSentAt,
        }
        : null,
    };
    await delay(500);
  }
  throw new Error(
    `Container ${containerId} did not retain one undispatched SSH owner across two later full reports; advancements=${reportAdvancements} last=${JSON.stringify(lastState)}`,
  );
}

async function listServerTasks(
  adminApi: APIRequestContext,
  serverId: string,
): Promise<AgentTaskView[]> {
  return expectJson<AgentTaskView[]>(
    await adminApi.get(
      `/api/admin/agent-tasks?serverId=${encodeURIComponent(serverId)}&limit=100`,
    ),
  );
}

async function listContainerTasks(
  adminApi: APIRequestContext,
  containerId: string,
): Promise<AgentTaskView[]> {
  return expectJson<AgentTaskView[]>(
    await adminApi.get(
      `/api/admin/agent-tasks?resourceType=container&resourceId=${encodeURIComponent(containerId)}&limit=100`,
    ),
  );
}

async function waitForNewContainerTask(
  adminApi: APIRequestContext,
  containerId: string,
  kind: string,
  excludedTaskIds: ReadonlySet<string>,
  timeoutMs = 180_000,
): Promise<AgentTaskView> {
  const deadline = Date.now() + timeoutMs;
  let last: AgentTaskView[] = [];
  while (Date.now() < deadline) {
    last = await listContainerTasks(adminApi, containerId);
    const task = last.find(
      (candidate) => candidate.kind === kind && !excludedTaskIds.has(candidate.id),
    );
    if (task) return task;
    await delay(500);
  }
  throw new Error(
    `Container ${containerId} did not enqueue a new ${kind} task; last=${JSON.stringify(last)}`,
  );
}

async function listServerContainers(
  adminApi: APIRequestContext,
  serverId: string,
): Promise<ContainerView[]> {
  return expectJson<ContainerView[]>(
    await adminApi.get(`/api/admin/v2/containers?serverId=${encodeURIComponent(serverId)}`),
  );
}

async function createDisposableImage(
  adminApi: APIRequestContext,
  seedState: SeedState,
  label: string,
): Promise<ImageView> {
  return expectJson<ImageView>(
    await adminApi.post('/api/admin/images', {
      data: {
        name: uniqueName(seedState.runId, label, 128),
        dockerImage: seedState.uiImage.dockerImage,
        description: `Recovery ${label}`,
        disableSsh: true,
      },
    }),
    201,
  );
}

async function deleteDisposableImage(
  adminApi: APIRequestContext,
  imageId: string,
): Promise<void> {
  const response = await adminApi.delete(`/api/admin/images/${imageId}`);
  if (response.status() === 404) return;
  const deletion = await expectJson<{ tasks: Array<AgentTaskRef & { serverId: string }> }>(
    response,
    202,
  );
  for (const task of deletion.tasks) {
    await waitForAgentTask(adminApi, task.taskId, {
      kind: 'image.ensure_absent',
      resourceId: imageId,
      timeoutMs: 180_000,
    });
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const readback = await adminApi.get(`/api/admin/images/${imageId}`);
    if (readback.status() === 404) return;
    expect(readback.status()).toBe(200);
    await delay(500);
  }
  throw new Error(`Disposable image ${imageId} remained after product cleanup`);
}

async function observePendingUnsentTask(
  adminApi: APIRequestContext,
  taskId: string,
): Promise<AgentTaskView> {
  const deadline = Date.now() + 2_000;
  let last: AgentTaskView | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<AgentTaskView>(
      await adminApi.get(`/api/admin/agent-tasks/${taskId}`),
    );
    expect(last.status).toBe('pending');
    expect(last.startedAt).toBeNull();
    expect(last.lastSentAt).toBeNull();
    expect(last.dispatchAttemptCount).toBe(0);
    expect(last.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    await delay(250);
  }
  if (!last?.payloadHash) throw new Error(`Task ${taskId} never exposed an immutable payload hash`);
  return last;
}

async function waitForTaskTerminal(
  adminApi: APIRequestContext,
  taskId: string,
  timeoutMs = 180_000,
): Promise<AgentTaskView> {
  const deadline = Date.now() + timeoutMs;
  let last: AgentTaskView | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<AgentTaskView>(
      await adminApi.get(`/api/admin/agent-tasks/${taskId}`),
    );
    if (last.status !== 'pending') return last;
    await delay(500);
  }
  throw new Error(`Task ${taskId} did not become terminal; last=${JSON.stringify(last)}`);
}

async function waitForWireEvidence(
  provider: AvailableTopologyProvider,
  fault: Omit<AgentTaskWireFaultControlInput, 'action'>,
  description: string,
  accept: (result: AgentTaskWireFaultControlResult) => boolean,
  timeoutMs = 120_000,
): Promise<AgentTaskWireFaultControlResult> {
  const deadline = Date.now() + timeoutMs;
  let last: AgentTaskWireFaultControlResult | null = null;
  while (Date.now() < deadline) {
    last = await controlProviderFault(provider, { ...fault, action: 'probe' });
    if (accept(last)) return last;
    await delay(500);
  }
  throw new Error(`Wire evidence did not reach ${description}; last=${JSON.stringify(last)}`);
}

async function withImageWireFault(
  fixtures: WireScenarioFixtures,
  options: {
    label: string;
    nodeKey: TopologyNodeKey;
    mode: AgentTaskWireFaultControlInput['mode'];
  },
  run: (scenario: WireScenario) => Promise<void>,
): Promise<void> {
  const target = fixtures.seedState.servers.find((server) => server.key === options.nodeKey);
  if (!target) throw new Error(`Seed state has no ${options.nodeKey}`);
  let image: ImageView | null = null;
  let task: AgentTaskView | null = null;
  let fault: Omit<AgentTaskWireFaultControlInput, 'action'> | null = null;
  let wireAttempted = false;
  let agentStopped = false;
  let primaryFailure: { error: unknown } | null = null;

  try {
    image = await createDisposableImage(fixtures.adminApi, fixtures.seedState, options.label);
    const stopped = await controlProviderFault(fixtures.topologyProvider, {
      fault: 'agentService',
      runId: fixtures.seedState.runId,
      nodeKey: options.nodeKey,
      action: 'stop',
    });
    agentStopped = true;
    expect(stopped.serviceActive).toBe(false);
    await waitForServer(
      fixtures.adminApi,
      target.serverId,
      'offline before exact wire fault',
      (server) => server.status === 'offline',
    );
    const pull = await expectJson<ImagePullResponse>(
      await fixtures.adminApi.post(`/api/admin/images/${image.id}/pull`, {
        data: { serverIds: [target.serverId] },
      }),
      201,
    );
    expect(pull.rejected).toEqual([]);
    expect(pull.tasks).toHaveLength(1);
    task = await observePendingUnsentTask(fixtures.adminApi, pull.tasks[0]!.taskId);
    fault = {
      fault: 'agentTaskWire',
      runId: fixtures.seedState.runId,
      nodeKey: options.nodeKey,
      mode: options.mode,
      taskId: task.id,
      payloadHash: task.payloadHash!,
    };
    wireAttempted = true;
    const injected = await controlProviderFault(fixtures.topologyProvider, {
      ...fault,
      action: 'inject',
    });
    agentStopped = false;
    expect(injected).toEqual(
      expect.objectContaining({
        serviceActive: true,
        proxyActive: true,
        routeActive: true,
      }),
    );
    await run({ image, target, task, fault });
  } catch (error) {
    primaryFailure = { error };
  }

  const cleanupErrors: unknown[] = [];
  if (wireAttempted && fault) {
    await captureCleanupError(cleanupErrors, async () => {
      const restored = await controlProviderFault(fixtures.topologyProvider, {
        ...fault!,
        action: 'restore',
      });
      expect(restored.serviceActive).toBe(true);
      expect(restored.proxyActive).toBe(false);
      expect(restored.routeActive).toBe(false);
    });
  } else if (agentStopped) {
    await captureCleanupError(cleanupErrors, async () => {
      const started = await controlProviderFault(fixtures.topologyProvider, {
        fault: 'agentService',
        runId: fixtures.seedState.runId,
        nodeKey: options.nodeKey,
        action: 'start',
      });
      expect(started.serviceActive).toBe(true);
    });
  }
  await captureCleanupError(cleanupErrors, async () => {
    const server = await expectJson<ServerView>(
      await fixtures.adminApi.get(`/api/admin/servers/${target.serverId}`),
    );
    if (server.status === 'agent_quarantined') {
      const retried = await expectJson<{ taskIds: string[] }>(
        await fixtures.adminApi.post(
          `/api/admin/servers/${target.serverId}/agent-quarantine/retry`,
        ),
        201,
      );
      for (const taskId of retried.taskIds) {
        await waitForAgentTask(fixtures.adminApi, taskId, { timeoutMs: 180_000 });
      }
    }
    await waitForServer(
      fixtures.adminApi,
      target.serverId,
      'online after wire-fault cleanup',
      (candidate) => candidate.status === 'online' && candidate.runtimeReady,
      180_000,
    );
  });
  if (image) {
    await captureCleanupError(cleanupErrors, () =>
      deleteDisposableImage(fixtures.adminApi, image!.id),
    );
  }

  if (primaryFailure !== null && cleanupErrors.length > 0) {
    throw aggregateErrorWithDiagnostics(
      `${options.label} and cleanup failed`,
      [primaryFailure.error, ...cleanupErrors],
    );
  }
  if (primaryFailure !== null) throw primaryFailure.error;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw aggregateErrorWithDiagnostics(
      `${options.label} cleanup had multiple failures`,
      cleanupErrors,
    );
  }
}

interface HeldTlsRequest {
  release(): Promise<{ status: number; raw: string }>;
  abort(): void;
}

async function openHeldTlsPost(
  path: string,
  accessToken: string,
  body: string,
): Promise<HeldTlsRequest> {
  const base = new URL(requireRuntimeEnv('E2E_BASE_URL'));
  const ca = readFileSync(`${requireRuntimeEnv('E2E_RUNTIME_ROOT')}/certs/ca.crt`);
  const prefix = body.slice(0, -1);
  const suffix = body.slice(-1);
  let socket: TLSSocket | null = null;
  let settled = false;
  let responseResolve: ((value: { status: number; raw: string }) => void) | null = null;
  let responseReject: ((error: Error) => void) | null = null;
  const response = new Promise<{ status: number; raw: string }>((resolvePromise, reject) => {
    responseResolve = resolvePromise;
    responseReject = reject;
  });

  await new Promise<void>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    socket = connectTls({
      host: base.hostname,
      port: Number(base.port || 443),
      servername: base.hostname,
      ca,
      rejectUnauthorized: true,
    });
    socket.setTimeout(45_000);
    socket.once('secureConnect', () => {
      const headers = [
        `POST ${path} HTTP/1.1`,
        `Host: ${base.host}`,
        `Authorization: Bearer ${accessToken}`,
        `X-Nyabase-E2E-Run: ${currentRunId()}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      socket!.write(`${headers}${prefix}`, (error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once('timeout', () => {
      const error = new Error('Held TLS request exceeded its response deadline');
      if (!settled) reject(error);
      responseReject?.(error);
      socket?.destroy();
    });
    socket.once('error', (error) => {
      if (!settled) reject(error);
      responseReject?.(error);
    });
    socket.once('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/m.exec(raw)?.[1]);
      if (!Number.isSafeInteger(status)) {
        responseReject?.(new Error(`Held TLS request returned malformed HTTP: ${raw.slice(0, 200)}`));
      } else {
        responseResolve?.({ status, raw });
      }
    });
  });

  return {
    release: async () => {
      settled = true;
      // Keep the client side readable while Nginx forwards the completed
      // request. TLSSocket.end() emits close_notify immediately; Nginx may
      // then treat the client as gone and abort the upstream response before
      // the Backend's authorization result can reach this probe.
      await new Promise<void>((resolvePromise, reject) => {
        socket!.write(suffix, (error) => {
          if (error) reject(error);
          else resolvePromise();
        });
      });
      return response;
    },
    abort: () => socket?.destroy(),
  };
}

async function captureCleanupError(errors: unknown[], work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    errors.push(error);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function settleRecoveryContainerAction(
  api: APIRequestContext,
  containerId: string,
  action: 'start' | 'stop' | 'restart',
  kind: string,
): Promise<AgentTaskView> {
  const ref = await requestContainerAction(api, containerId, action);
  return waitForAgentTask(api, ref.taskId, {
    kind,
    resourceId: containerId,
    timeoutMs: 180_000,
  });
}

async function waitForVmagentQueue(
  provider: AvailableTopologyProvider,
  runId: string,
  description: string,
  accept: (pendingBytes: number) => boolean,
  timeoutMs = 120_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < deadline) {
    const probe = await controlProviderFault(provider, {
      fault: 'telemetryService',
      runId,
      service: 'vmagent',
      action: 'probe',
    });
    last = probe.queuePendingBytes;
    if (last !== null && accept(last)) return last;
    await delay(500);
  }
  throw new Error(
    `vmagent queue did not reach ${description} within ${timeoutMs}ms; last=${last}`,
  );
}

test.describe('80 recovery and security', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'recovery.backend.restart-reconstructs-durable-state',
    coverageCase(
      'recovery.security.backend-restart-and-state-reconstruction',
      'recovery.backend.restart-reconstructs-durable-state',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(420_000);
      const container = await createRunningAdminContainer(
        adminApi,
        seedState,
        'node1',
        'backend-restart',
      );
      try {
        const beforeRuntimeId = container.view.runtime.runtimeId!;
        const restarted = await controlProviderFault(topologyProvider, {
          fault: 'backendService',
          runId: seedState.runId,
          action: 'restart',
        });
        expect(restarted.restarted).toBe(true);
        expect(restarted.after.generation).not.toBe(restarted.before.generation);
        for (const server of seedState.servers) {
          await waitForServer(
            adminApi,
            server.serverId,
            'reconnected after Backend reconstruction',
            (candidate) => candidate.status === 'online' && candidate.runtimeReady,
            180_000,
          );
        }
        const reconstructed = await waitForContainer(
          adminApi,
          container.id,
          'same durable runtime after Backend restart',
          (candidate) =>
            candidate.runtime.status === 'running' &&
            candidate.runtime.runtimeId === beforeRuntimeId &&
            candidate.activeTask === null,
          120_000,
        );
        expect(reconstructed.name).toBe(container.view.name);
        const durableTask = await expectJson<AgentTaskView>(
          await adminApi.get(`/api/admin/agent-tasks/${container.task.id}`),
        );
        expect(durableTask).toEqual(
          expect.objectContaining({
            id: container.task.id,
            status: 'succeeded',
            resourceId: container.id,
          }),
        );
      } finally {
        await cleanupContainerThroughProductApi(adminApi, container.id, adminApi);
      }
    },
  );

  test(
    'recovery.redis.disposable-outage-recovers-authorization-dispatch',
    coverageCase(
      'recovery.security.redis-disposable-outage-recovery',
      'recovery.redis.disposable-outage-recovers-authorization-dispatch',
    ),
    async ({
      adminApi,
      adminSession,
      anonymousApi,
      page,
      trackedApiFactory,
      seedState,
      topologyProvider,
    }) => {
      test.setTimeout(600_000);
      let redisStopped = false;
      let container: RunningAdminContainer | null = null;
      try {
        const before = await controlProviderFault(topologyProvider, {
          fault: 'redisService',
          runId: seedState.runId,
          action: 'probe',
        });
        expect(before).toEqual(expect.objectContaining({ running: true, healthy: true }));

        const stopped = await controlProviderFault(topologyProvider, {
          fault: 'redisService',
          runId: seedState.runId,
          action: 'stop',
        });
        redisStopped = true;
        expect(stopped).toEqual(expect.objectContaining({ running: false, healthy: false }));
        const outageReadiness = await anonymousApi.get('/api/health/ready');
        expect(outageReadiness.status()).toBe(503);
        const outageReadinessBody = await expectJson<{ code: string }>(
          outageReadiness,
          503,
        );
        expect(outageReadinessBody).toEqual(
          expect.objectContaining({ code: 'REDIS_NOT_READY' }),
        );

        const outageSession = await expectJson<{ accessToken: string }>(
          await anonymousApi.post('/api/auth/login', {
            data: {
              username: requireRuntimeEnv('E2E_ADMIN_USERNAME'),
              password: requireRuntimeEnv('E2E_ADMIN_PASSWORD'),
            },
          }),
        );
        const outageApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${outageSession.accessToken}` },
        });
        container = await createRunningAdminContainer(
          outageApi,
          seedState,
          'node1',
          'redis-stopped-dispatch',
        );
        expect(container.task).toEqual(expect.objectContaining({
          status: 'succeeded',
          kind: 'container.create',
        }));

        const target = seedState.servers.find((server) => server.key === 'node1')!;
        const beforeTasks = (await listServerTasks(adminApi, target.serverId))
          .map((task) => task.id)
          .sort();
        const beforeView = await expectJson<ContainerView>(
          await adminApi.get(`/api/admin/v2/containers/${container.id}`),
        );
        const beforePhysical = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        const expectBoundedRouteFailure = async (
          request: () => Promise<{ status(): number }>,
          label: string,
        ) => {
          const startedAt = Date.now();
          const response = await request();
          expect(
            [500, 502, 503, 504],
            `${label} must fail closed while the API cannot reach the socket owner`,
          ).toContain(response.status());
          expect(Date.now() - startedAt, `${label} failure must be bounded`).toBeLessThan(45_000);
        };
        await expectBoundedRouteFailure(
          () => adminApi.get(
            `/api/admin/servers/${target.serverId}/self-check`,
            { timeout: 45_000 },
          ),
          'Agent self-check',
        );
        await expectBoundedRouteFailure(
          () => adminApi.post(
            `/api/admin/v2/containers/${container!.id}/actions/restart`,
            { timeout: 45_000 },
          ),
          'restart pre-inspection',
        );
        await expectBoundedRouteFailure(
          () => adminApi.post(
            `/api/admin/v2/containers/${container!.id}/exec-sessions`,
            {
              data: { shell: '/bin/sh', tty: false },
              timeout: 45_000,
            },
          ),
          'Console admission',
        );
        const [afterFailureTasks, afterFailureView, afterFailurePhysical, afterFailureServer] =
          await Promise.all([
            listServerTasks(adminApi, target.serverId),
            expectJson<ContainerView>(
              await adminApi.get(`/api/admin/v2/containers/${container.id}`),
            ),
            controlProviderFault(topologyProvider, {
              fault: 'agentService',
              runId: seedState.runId,
              nodeKey: 'node1',
              action: 'probe',
            }),
            expectJson<ServerView>(
              await adminApi.get(`/api/admin/servers/${target.serverId}`),
            ),
        ]);
        expect(afterFailureTasks.map((task) => task.id).sort()).toEqual(beforeTasks);
        const {
          observedAt: beforeRuntimeObservedAt,
          ...beforeStableRuntime
        } = beforeView.runtime!;
        const {
          observedAt: afterRuntimeObservedAt,
          ...afterStableRuntime
        } = afterFailureView.runtime!;
        expect(afterStableRuntime).toEqual(beforeStableRuntime);
        expect(Date.parse(afterRuntimeObservedAt!)).toBeGreaterThanOrEqual(
          Date.parse(beforeRuntimeObservedAt!),
        );
        expect(afterFailureView).toEqual(expect.objectContaining({
          powerIntent: beforeView.powerIntent,
          activeTask: beforeView.activeTask,
        }));
        expect(afterFailurePhysical.runtimeContainerIds).toEqual(
          beforePhysical.runtimeContainerIds,
        );
        expect(afterFailurePhysical.activeRuntimeContainerIds).toEqual(
          beforePhysical.activeRuntimeContainerIds,
        );
        expect(afterFailureServer).toEqual(expect.objectContaining({
          status: 'online',
          runtimeReady: true,
          quarantineCode: null,
        }));

        const restarted = await controlProviderFault(topologyProvider, {
          fault: 'redisService',
          runId: seedState.runId,
          action: 'restart',
        });
        redisStopped = false;
        expect(restarted).toEqual(expect.objectContaining({ running: true, healthy: true }));
        expect(restarted.generation).not.toBe(before.generation);
        await expect.poll(
          async () => (await anonymousApi.get('/api/health/ready')).status(),
          {
            message: 'split API readiness must recover after Redis addressed RPC reconnects',
            timeout: 120_000,
            intervals: [250, 500, 1_000],
          },
        ).toBe(200);

        let recoveredSelfCheck: {
          items: Array<{ id: string; status: string }>;
        } | null = null;
        let lastRecoveryFailure = 'no recovery attempt completed';
        const recoveryDeadline = Date.now() + 120_000;
        while (Date.now() < recoveryDeadline) {
          try {
            const response = await adminApi.get(
              `/api/admin/servers/${target.serverId}/self-check`,
              { timeout: Math.min(15_000, recoveryDeadline - Date.now()) },
            );
            if (response.status() === 200) {
              const candidate = await expectJson<{
                items: Array<{ id: string; status: string }>;
              }>(response);
              if (candidate.items.find((item) => item.id === 'docker')?.status === 'ok') {
                recoveredSelfCheck = candidate;
                break;
              }
              lastRecoveryFailure = 'Docker self-check was not ok';
            } else {
              lastRecoveryFailure = `HTTP ${response.status()}`;
            }
          } catch (error) {
            lastRecoveryFailure = error instanceof Error ? error.message : String(error);
          }
          await delay(500);
        }
        expect(
          recoveredSelfCheck,
          `Agent RPC did not recover after disposable Redis restart: ${lastRecoveryFailure}`,
        ).not.toBeNull();
        const routeRestart = await settleRecoveryContainerAction(
          adminApi,
          container.id,
          'restart',
          'container.restart',
        );
        expect(routeRestart.status).toBe('succeeded');
        const execSession = await expectJson<ConsoleSession>(
          await adminApi.post(
            `/api/admin/v2/containers/${container.id}/exec-sessions`,
            { data: { shell: '/bin/sh', tty: false } },
          ),
          201,
        );
        const routeMarker = `redis-route-${seedState.runId}`;
        const routeConsole = await executeThroughConsole(
          page,
          requireRuntimeEnv('E2E_BASE_URL'),
          execSession,
          adminSession.accessToken,
          `printf '${routeMarker}'; exit\n`,
        );
        expect(routeConsole).toEqual(expect.objectContaining({
          exitCode: 0,
          output: expect.stringContaining(routeMarker),
        }));

        const flushed = await controlProviderFault(topologyProvider, {
          fault: 'redisService',
          runId: seedState.runId,
          action: 'flush',
        });
        expect(flushed.flushed).toBe(true);
        const stopTask = await settleRecoveryContainerAction(
          outageApi,
          container.id,
          'stop',
          'container.stop',
        );
        expect(stopTask.status).toBe('succeeded');
        await waitForContainer(
          outageApi,
          container.id,
          'stopped after Redis flush',
          (view) =>
            view.runtime.status === 'exited'
            && view.powerIntent === 'stopped'
            && view.activeTask === null,
        );

        const restartedAgain = await controlProviderFault(topologyProvider, {
          fault: 'redisService',
          runId: seedState.runId,
          action: 'restart',
        });
        expect(restartedAgain.generation).not.toBe(restarted.generation);
        const recoveredSession = await expectJson<{ accessToken: string }>(
          await anonymousApi.post('/api/auth/login', {
            data: {
              username: requireRuntimeEnv('E2E_ADMIN_USERNAME'),
              password: requireRuntimeEnv('E2E_ADMIN_PASSWORD'),
            },
          }),
        );
        const recoveredApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${recoveredSession.accessToken}` },
        });
        const startTask = await settleRecoveryContainerAction(
          recoveredApi,
          container.id,
          'start',
          'container.start',
        );
        expect(startTask.status).toBe('succeeded');
        await waitForContainer(
          recoveredApi,
          container.id,
          'running after Redis restart',
          (view) =>
            view.runtime.status === 'running'
            && view.powerIntent === 'running'
            && view.activeTask === null,
        );
      } finally {
        if (redisStopped) {
          await controlProviderFault(topologyProvider, {
            fault: 'redisService',
            runId: seedState.runId,
            action: 'restart',
          });
        }
        if (container) {
          await cleanupContainerThroughProductApi(adminApi, container.id, adminApi);
        }
      }
    },
  );

  test(
    'recovery.telemetry.victoriametrics-outage-buffers-and-replays',
    coverageCase(
      'recovery.security.victoriametrics-backlog-replay',
      'recovery.telemetry.victoriametrics-outage-buffers-and-replays',
    ),
    async ({
      adminApi,
      seedState,
      topologyProvider,
    }) => {
      test.setTimeout(360_000);
      const baseline = await controlProviderFault(topologyProvider, {
        fault: 'telemetryService',
        runId: seedState.runId,
        service: 'vmagent',
        action: 'probe',
      });
      expect(baseline.queuePendingBytes).not.toBeNull();
      let victoriaMetricsStopped = false;
      let groupId: string | null = null;
      try {
        const stopped = await controlProviderFault(topologyProvider, {
          fault: 'telemetryService',
          runId: seedState.runId,
          service: 'victoriametrics',
          action: 'stop',
        });
        victoriaMetricsStopped = true;
        expect(stopped.healthy).toBe(false);

        const group = await expectJson<{ id: string }>(
          await adminApi.post('/api/admin/groups', {
            data: {
              name: uniqueName(seedState.runId, 'vm-outage-mutation', 128),
              description: 'control mutation while VictoriaMetrics is unavailable',
              capabilities: [],
            },
          }),
          201,
        );
        groupId = group.id;
        expect(
          await expectJson<{ taskIds: string[] }>(
            await adminApi.delete(`/api/admin/groups/${groupId}`),
          ),
        ).toEqual({ taskIds: [] });
        groupId = null;

        const queued = await waitForVmagentQueue(
          topologyProvider,
          seedState.runId,
          `more than baseline ${baseline.queuePendingBytes}`,
          (pendingBytes) => pendingBytes > (baseline.queuePendingBytes ?? 0),
        );
        const started = await controlProviderFault(topologyProvider, {
          fault: 'telemetryService',
          runId: seedState.runId,
          service: 'victoriametrics',
          action: 'start',
        });
        victoriaMetricsStopped = false;
        expect(started.healthy).toBe(true);
        const replayed = await waitForVmagentQueue(
          topologyProvider,
          seedState.runId,
          `less than outage backlog ${queued}`,
          (pendingBytes) => pendingBytes < queued,
        );
        expect(replayed).toBeLessThan(queued);
      } finally {
        if (victoriaMetricsStopped) {
          await controlProviderFault(topologyProvider, {
            fault: 'telemetryService',
            runId: seedState.runId,
            service: 'victoriametrics',
            action: 'start',
          });
        }
        if (groupId) {
          const response = await adminApi.delete(`/api/admin/groups/${groupId}`);
          expect([200, 404]).toContain(response.status());
        }
      }
    },
  );

  test(
    'recovery.telemetry.vmagent-outage-does-not-block-control',
    coverageCase(
      'recovery.security.vmagent-bounded-degradation',
      'recovery.telemetry.vmagent-outage-does-not-block-control',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(420_000);
      let vmagentStopped = false;
      let container: RunningAdminContainer | null = null;
      try {
        const stopped = await controlProviderFault(topologyProvider, {
          fault: 'telemetryService',
          runId: seedState.runId,
          service: 'vmagent',
          action: 'stop',
        });
        vmagentStopped = true;
        expect(stopped).toEqual(expect.objectContaining({
          healthy: false,
          queuePendingBytes: null,
        }));
        // Cross at least one real 5-second Agent metrics cadence while the
        // ingestion endpoint is absent, then prove the WS/control path remains
        // responsive and physical dispatch still converges.
        await delay(7_000);
        container = await createRunningAdminContainer(
          adminApi,
          seedState,
          'node2',
          'vmagent-stopped-control',
        );
        for (const server of seedState.servers) {
          await waitForServer(
            adminApi,
            server.serverId,
            'online while vmagent is unavailable',
            (candidate) => candidate.status === 'online' && candidate.runtimeReady,
          );
        }

        const requestStartedAt = Date.now();
        const metricsResponse = await adminApi.get(
          `/api/admin/metrics/servers/${container.serverId}/host?range=1h`,
          { timeout: 8_000 },
        );
        expect(Date.now() - requestStartedAt).toBeLessThan(8_000);
        expect(metricsResponse.status()).toBe(200);
        const metrics = await expectJson<{
          cpu: { points: Array<{ t: number; v: number | null }> };
        }>(metricsResponse);
        expect(metrics.cpu.points).toEqual(expect.any(Array));
      } finally {
        if (vmagentStopped) {
          const started = await controlProviderFault(topologyProvider, {
            fault: 'telemetryService',
            runId: seedState.runId,
            service: 'vmagent',
            action: 'start',
          });
          expect(started.healthy).toBe(true);
          expect(started.queuePendingBytes).not.toBeNull();
        }
        if (container) {
          await cleanupContainerThroughProductApi(adminApi, container.id, adminApi);
        }
      }
    },
  );

  test(
    'recovery.agent.reconnect-preserves-runtime',
    coverageCase(
      'recovery.security.agent-reconnect',
      'recovery.agent.reconnect-preserves-runtime',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(420_000);
      const target = seedState.servers.find((server) => server.key === 'node1')!;
      const container = await createRunningAdminContainer(
        adminApi,
        seedState,
        'node1',
        'agent-reconnect',
      );
      const runtimeId = container.view.runtime.runtimeId!;
      let stopped = false;
      try {
        const taskIdsBefore = new Set(
          (await listContainerTasks(adminApi, container.id)).map((task) => task.id),
        );
        const before = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        expect(before.runtimeContainerIds).toContain(runtimeId);
        const result = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'stop',
        });
        stopped = true;
        expect(result.serviceActive).toBe(false);
        await waitForServer(
          adminApi,
          target.serverId,
          'offline after real Agent stop',
          (server) => server.status === 'offline',
        );
        const started = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'start',
        });
        stopped = false;
        expect(started.serviceActive).toBe(true);
        await waitForServer(
          adminApi,
          target.serverId,
          'online after Agent reconnect',
          (server) => server.status === 'online' && server.runtimeReady,
          180_000,
        );
        const queuedRecovery = await waitForNewContainerTask(
          adminApi,
          container.id,
          'container.start',
          taskIdsBefore,
        );
        const recovery = await waitForAgentTask(adminApi, queuedRecovery.id, {
          kind: 'container.start',
          resourceId: container.id,
          timeoutMs: 180_000,
        });
        expect(recovery.requestedBy).toBeNull();
        expect(recovery.request).toEqual({
          reason: 'authoritative_state_report_power_recovery',
        });
        const recovered = await waitForContainer(
          adminApi,
          container.id,
          'same runtime after Agent reconnect',
          (candidate) =>
            candidate.runtime.status === 'running' &&
            candidate.runtime.runtimeId === runtimeId &&
            candidate.activeTask === null,
          120_000,
        );
        expect(recovered.failureCode ?? null).toBeNull();
        expect(recovered.powerIntent).toBe('running');
        const after = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        expect(after.runtimeContainerIds).toEqual(before.runtimeContainerIds);
        expect(after.activeRuntimeContainerIds).toContain(runtimeId);
      } finally {
        if (stopped) {
          await controlProviderFault(topologyProvider, {
            fault: 'agentService',
            runId: seedState.runId,
            nodeKey: 'node1',
            action: 'start',
          });
          await waitForServer(
            adminApi,
            target.serverId,
            'online for Agent reconnect cleanup',
            (server) => server.status === 'online' && server.runtimeReady,
            180_000,
          );
        }
        await cleanupContainerThroughProductApi(adminApi, container.id, adminApi);
      }
    },
  );

  test(
    'recovery.dockerd.restart-preserves-runtime-identity',
    coverageCase(
      'recovery.security.dockerd-restart',
      'recovery.dockerd.restart-preserves-runtime-identity',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(360_000);
      const container = await createRunningAdminContainer(
        adminApi,
        seedState,
        'node2',
        'dockerd-restart',
      );
      try {
        const runtimeId = container.view.runtime.runtimeId!;
        const taskIdsBefore = new Set(
          (await listContainerTasks(adminApi, container.id)).map((task) => task.id),
        );
        const restarted = await controlProviderFault(topologyProvider, {
          fault: 'dockerdService',
          runId: seedState.runId,
          nodeKey: 'node2',
          action: 'restart',
        });
        expect(restarted.beforeGeneration).not.toBe(restarted.afterGeneration);
        expect(restarted.runtimeContainerIdsBefore).toEqual(restarted.runtimeContainerIdsAfter);
        expect(restarted.runtimeContainerIdsAfter).toContain(runtimeId);
        const queuedRecovery = await waitForNewContainerTask(
          adminApi,
          container.id,
          'container.start',
          taskIdsBefore,
        );
        const recovery = await waitForAgentTask(adminApi, queuedRecovery.id, {
          kind: 'container.start',
          resourceId: container.id,
          timeoutMs: 180_000,
        });
        expect(recovery.requestedBy).toBeNull();
        expect(recovery.request).toEqual({
          reason: 'authoritative_state_report_power_recovery',
        });
        const converged = await waitForContainer(
          adminApi,
          container.id,
          'same live runtime after dockerd restart',
          (candidate) =>
            candidate.runtime.status === 'running' &&
            candidate.runtime.runtimeId === runtimeId &&
            candidate.activeTask === null,
          120_000,
        );
        expect(converged.powerIntent).toBe('running');
        const physical = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node2',
          action: 'probe',
        });
        expect(physical.runtimeContainerIds).toContain(runtimeId);
        expect(physical.activeRuntimeContainerIds).toContain(runtimeId);
      } finally {
        await cleanupContainerThroughProductApi(adminApi, container.id, adminApi);
      }
    },
  );

  test(
    'recovery.runtime.pending-ssh-yields-to-power-recovery',
    coverageCase(
      'recovery.security.pending-ssh-power-recovery-race',
      'recovery.runtime.pending-ssh-yields-to-power-recovery',
    ),
    async ({
      adminApi,
      anonymousApi,
      trackedApiFactory,
      seedState,
      topologyProvider,
    }) => {
      test.setTimeout(600_000);
      const target = seedState.servers.find((server) => server.key === 'node2')!;
      const sshImage = new ContainerSshImageLease({
        adminApi,
        seedImageId: seedState.image.id,
        seedDockerImage: seedState.image.dockerImage,
        temporaryDockerImage: seedState.uiImage.dockerImage,
        serverId: target.serverId,
        label: 'pending-ssh-power-race',
      });
      let container: RunningAdminContainer | null = null;
      let containerLease: ContainerLease | null = null;
      let persona: ContainerPersona | null = null;
      let agentStopped = false;
      let blockerTask: AgentTaskView | null = null;
      let wireFault: Omit<AgentTaskWireFaultControlInput, 'action'> | null = null;
      let wireRestored = false;
      let primaryFailure: { error: unknown } | null = null;
      try {
        const image = await sshImage.setup();
        persona = await createContainerPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          label: 'pending-ssh-power-race',
          access: {
            serverId: target.serverId,
            imageId: image.id,
          },
        });
        containerLease = new ContainerLease({
          ownerApi: persona.api,
          adminApi,
          ownerId: persona.user.id,
          serverId: target.serverId,
          imageId: image.id,
          name: uniqueContainerLeaseName('pending-ssh-power-race'),
        });
        const created = await containerLease.createRunning();
        const runningView = await waitForRunningContainerQuiescence(
          adminApi,
          target.serverId,
          created.view.id,
          true,
        );
        container = {
          id: runningView.id,
          serverId: target.serverId,
          task: created.task,
          view: runningView,
        };
        const runtimeId = container.view.runtime.runtimeId!;
        agentStopped = true;
        await controlProviderFault(topologyProvider, {
          fault: 'agentService', runId: seedState.runId, nodeKey: 'node2', action: 'stop',
        });
        await waitForServer(
          adminApi,
          target.serverId,
          'offline before pending SSH dispatch blocker',
          (server) => server.status === 'offline',
        );
        const blockerPull = await expectJson<ImagePullResponse>(
          await adminApi.post(`/api/admin/images/${image.id}/pull`, {
            data: { serverIds: [target.serverId] },
          }),
          201,
        );
        expect(blockerPull.rejected).toEqual([]);
        expect(blockerPull.tasks).toHaveLength(1);
        blockerTask = await observePendingUnsentTask(adminApi, blockerPull.tasks[0]!.taskId);
        wireFault = {
          fault: 'agentTaskWire',
          runId: seedState.runId,
          nodeKey: 'node2',
          mode: 'hold-terminal-until-release',
          taskId: blockerTask.id,
          payloadHash: blockerTask.payloadHash!,
        };
        await controlProviderFault(topologyProvider, { ...wireFault, action: 'inject' });
        agentStopped = false;
        await waitForWireEvidence(
          topologyProvider,
          wireFault,
          'one sent image task with its terminal held while the Agent remains connected',
          (evidence) =>
            evidence.executeCount >= 1 &&
            evidence.terminalCount >= 1 &&
            evidence.droppedCount === 1 &&
            evidence.forwardedTerminalCount === 0 &&
            evidence.serviceActive &&
            evidence.proxyActive &&
            evidence.routeActive,
        );
        await waitForServer(
          adminApi,
          target.serverId,
          'online behind the pending SSH dispatch blocker',
          (server) => server.status === 'online' && server.runtimeReady,
          180_000,
        );
        const undispatched = await waitForStableUndispatchedSshOwner(
          adminApi,
          target.serverId,
          container.id,
          runtimeId,
          180_000,
        );
        const taskIdsBefore = new Set(
          (await listContainerTasks(adminApi, container.id)).map((task) => task.id),
        );
        expect(undispatched).toEqual(expect.objectContaining({
          kind: 'container.ssh.ensure',
          resourceId: container.id,
          status: 'pending',
          dispatchAttemptCount: 0,
          startedAt: null,
          lastSentAt: null,
        }));
        expect(
          await expectJson<ContainerView>(
            await adminApi.get(`/api/admin/v2/containers/${container.id}`),
          ),
        ).toEqual(expect.objectContaining({
          activeTask: expect.objectContaining({ id: undispatched.id }),
        }));

        const stopped = await controlProviderFault(topologyProvider, {
          fault: 'containerRuntimeDrift',
          runId: seedState.runId,
          nodeKey: 'node2',
          action: 'stop',
          containerId: container.id,
          runtimeId,
        });
        expect(stopped.physicalAbsent).toBe(false);
        expect(stopped.physicalRunning).toBe(false);

        const superseded = await waitForTaskTerminal(adminApi, undispatched.id);
        expect(superseded).toEqual(expect.objectContaining({
          kind: 'container.ssh.ensure',
          resourceId: container.id,
          status: 'failed',
          dispatchAttemptCount: 0,
          startedAt: null,
          lastSentAt: null,
          error: expect.objectContaining({ code: 'TASK_SUPERSEDED' }),
        }));
        const startTask = await waitForNewContainerTask(
          adminApi,
          container.id,
          'container.start',
          taskIdsBefore,
        );
        await controlProviderFault(topologyProvider, { ...wireFault, action: 'restore' });
        wireRestored = true;
        await waitForServer(
          adminApi,
          target.serverId,
          'online after pending SSH power race',
          (server) => server.status === 'online' && server.runtimeReady,
          180_000,
        );
        const settledBlocker = await waitForAgentTask(adminApi, blockerTask.id, {
          kind: 'image.ensure_present', resourceId: image.id, timeoutMs: 180_000,
        });
        expect(settledBlocker.dispatchAttemptCount).toBeGreaterThanOrEqual(2);
        const recoveredTask = await waitForAgentTask(adminApi, startTask.id, {
          kind: 'container.start', resourceId: container.id, timeoutMs: 180_000,
        });
        expect(recoveredTask.request).toEqual({
          reason: 'authoritative_state_report_power_recovery',
        });
        const recovered = await waitForRunningContainerQuiescence(
          adminApi,
          target.serverId,
          container.id,
          true,
          180_000,
        );
        expect(recovered.runtime.runtimeId).toBe(runtimeId);
        expect(recovered.failureCode ?? null).toBeNull();
      } catch (error) {
        primaryFailure = { error };
      } finally {
        await runCleanupStepsPreservingPrimary('Pending SSH power-race cleanup failed', [
          async () => {
            if (wireFault && !wireRestored) {
              await controlProviderFault(topologyProvider, { ...wireFault, action: 'restore' });
              wireRestored = true;
              agentStopped = false;
            } else if (agentStopped) {
              await controlProviderFault(topologyProvider, {
                fault: 'agentService', runId: seedState.runId, nodeKey: 'node2', action: 'start',
              });
              agentStopped = false;
            }
          },
          async () => {
            if (!wireFault && !blockerTask && !container) return;
            await waitForServer(
              adminApi,
              target.serverId,
              'online for pending SSH race cleanup',
              (server) => server.status === 'online' && server.runtimeReady,
              180_000,
            );
          },
          async () => {
            if (!blockerTask) return;
            await waitForAgentTask(adminApi, blockerTask.id, {
              kind: 'image.ensure_present', timeoutMs: 180_000,
            });
          },
          async () => {
            await containerLease?.cleanup();
          },
          async () => {
            if (!persona) return;
            await cleanupContainerPersona(
              adminApi,
              persona,
              new ContainerDeadline(180_000, 'pending SSH power-race persona cleanup'),
            );
          },
          async () => sshImage.cleanup(),
        ], primaryFailure);
      }
    },
  );

  test(
    'recovery.tasks.replay-is-idempotent',
    coverageCase(
      'recovery.security.task-replay-and-idempotency',
      'recovery.tasks.replay-is-idempotent',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(600_000);
      await withImageWireFault(
        { adminApi, seedState, topologyProvider },
        { label: 'task-replay', nodeKey: 'node2', mode: 'drop-terminal-once' },
        async ({ image, target, task, fault }) => {
          const first = await waitForWireEvidence(
            topologyProvider,
            fault,
            'one execution with its terminal dropped',
            (evidence) =>
              evidence.executeCount === 1 &&
              evidence.terminalCount === 1 &&
              evidence.droppedCount === 1 &&
              evidence.forwardedTerminalCount === 0,
          );
          const pending = await expectJson<AgentTaskView>(
            await adminApi.get(`/api/admin/agent-tasks/${task.id}`),
          );
          expect(pending.status).toBe('pending');
          expect(pending.dispatchAttemptCount).toBe(1);
          expect(pending.payloadHash).toBe(task.payloadHash);
          const released = await controlProviderFault(topologyProvider, {
            ...fault,
            action: 'release',
          });
          expect(released.released).toBe(true);
          const settled = await waitForAgentTask(adminApi, task.id, {
            kind: 'image.ensure_present',
            resourceId: image.id,
            timeoutMs: 180_000,
          });
          expect(settled.serverId).toBe(target.serverId);
          expect(settled.dispatchAttemptCount).toBeGreaterThanOrEqual(2);
          expect(settled.payloadHash).toBe(task.payloadHash);
          const replayed = await waitForWireEvidence(
            topologyProvider,
            fault,
            'same task replayed with one terminal effect',
            (evidence) =>
              evidence.executeCount >= 2 &&
              evidence.terminalCount >= 2 &&
              evidence.droppedCount === 1 &&
              evidence.forwardedTerminalCount === 1,
          );
          expect(replayed.firstExecuteAt).toBe(first.firstExecuteAt);
          const history = await expectJson<AgentTaskView[]>(
            await adminApi.get(
              `/api/admin/agent-tasks?resourceType=image&resourceId=${encodeURIComponent(image.id)}&serverId=${encodeURIComponent(target.serverId)}&limit=100`,
            ),
          );
          expect(history.filter((candidate) => candidate.kind === 'image.ensure_present'))
            .toHaveLength(1);
          expect(history[0]?.id).toBe(task.id);
        },
      );
    },
  );

  test(
    'recovery.runtime.drift-fails-closed',
    coverageCase(
      'recovery.security.runtime-drift-reconciliation',
      'recovery.runtime.drift-fails-closed',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(420_000);
      const container = await createRunningAdminContainer(
        adminApi,
        seedState,
        'node1',
        'runtime-drift',
      );
      try {
        const runtimeId = container.view.runtime.runtimeId!;
        const removed = await controlProviderFault(topologyProvider, {
          fault: 'containerRuntimeDrift',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'remove',
          containerId: container.id,
          runtimeId,
        });
        expect(removed.physicalAbsent).toBe(true);
        const reconciled = await waitForContainer(
          adminApi,
          container.id,
          'runtime-missing fail-stop projection',
          (candidate) =>
            candidate.failureCode === 'runtime_missing' &&
            candidate.runtime.runtimeId === runtimeId &&
            candidate.runtime.status === 'unknown' &&
            candidate.activeTask === null &&
            candidate.actions.delete?.enabled === true,
          180_000,
        );
        expect(reconciled.failureReason).toBe(
          'The container operation failed; retry it or contact an administrator',
        );
        expect(reconciled.failureReason).not.toContain(runtimeId);
        expect(reconciled.actions.start?.enabled).toBe(false);
        expect(reconciled.actions.stop?.enabled).toBe(false);
        expect(reconciled.actions.restart?.enabled).toBe(false);
        const probe = await controlProviderFault(topologyProvider, {
          fault: 'containerRuntimeDrift',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
          containerId: container.id,
          runtimeId,
        });
        expect(probe.physicalAbsent).toBe(true);
      } finally {
        await cleanupContainerThroughProductApi(adminApi, container.id, adminApi);
      }
    },
  );

  test(
    'recovery.quarantine.invalid-result-retry-clears',
    coverageCase(
      'recovery.security.quarantine-and-clear',
      'recovery.quarantine.invalid-result-retry-clears',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(600_000);
      await withImageWireFault(
        { adminApi, seedState, topologyProvider },
        { label: 'quarantine-clear', nodeKey: 'node1', mode: 'mutate-image-ref-once' },
        async ({ image, target, task, fault }) => {
          const failed = await waitForTaskTerminal(adminApi, task.id);
          expect(failed).toEqual(
            expect.objectContaining({
              status: 'failed',
              failureStage: 'agent',
              resourceId: image.id,
              error: expect.objectContaining({ code: 'INVALID_AGENT_RESULT' }),
            }),
          );
          const mutation = await waitForWireEvidence(
            topologyProvider,
            fault,
            'one semantic-invalid terminal result',
            (evidence) =>
              evidence.mutatedCount === 1 &&
              evidence.forwardedTerminalCount === 1 &&
              evidence.terminalCount === 1,
          );
          expect(mutation.taskId).toBe(task.id);
          const quarantined = await waitForServer(
            adminApi,
            target.serverId,
            'durable invalid-result quarantine',
            (server) => server.status === 'agent_quarantined',
          );
          expect(quarantined.runtimeReady).toBe(false);
          const retried = await expectJson<{ taskIds: string[] }>(
            await adminApi.post(
              `/api/admin/servers/${target.serverId}/agent-quarantine/retry`,
            ),
            201,
          );
          expect(retried.taskIds).toEqual([task.id]);
          const recovered = await waitForAgentTask(adminApi, task.id, {
            kind: 'image.ensure_present',
            resourceId: image.id,
            timeoutMs: 180_000,
          });
          expect(recovered.error).toBeNull();
          expect(recovered.payloadHash).toBe(task.payloadHash);
          await waitForServer(
            adminApi,
            target.serverId,
            'online after exact quarantine retry',
            (server) => server.status === 'online' && server.runtimeReady,
            180_000,
          );
        },
      );
    },
  );

  test(
    'recovery.agent.duplicate-session-is-fenced',
    coverageCase(
      'recovery.security.stale-session-fencing',
      'recovery.agent.duplicate-session-is-fenced',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(240_000);
      const before = await controlProviderFault(topologyProvider, {
        fault: 'agentService',
        runId: seedState.runId,
        nodeKey: 'node1',
        action: 'probe',
      });
      const fenced = await controlProviderFault(topologyProvider, {
        fault: 'duplicateAgentSession',
        runId: seedState.runId,
        nodeKey: 'node1',
        action: 'probe',
      });
      expect(fenced).toEqual(
        expect.objectContaining({
          serverId: seedState.servers.find((server) => server.key === 'node1')!.serverId,
          opened: true,
          admissionReceived: false,
          closed: true,
        }),
      );
      const authoritative = await waitForServer(
        adminApi,
        fenced.serverId,
        'authoritative Agent remains online after stale-session fence',
        (server) => server.status === 'online' && server.runtimeReady,
      );
      expect(authoritative.quarantineCode).toBeNull();
      const after = await controlProviderFault(topologyProvider, {
        fault: 'agentService',
        runId: seedState.runId,
        nodeKey: 'node1',
        action: 'probe',
      });
      expect(after.runtimeContainerIds).toEqual(before.runtimeContainerIds);
      expect(after.activeRuntimeContainerIds).toEqual(before.activeRuntimeContainerIds);
    },
  );

  test(
    'recovery.agent.split-gateway-takeover-fences-stale-owner',
    coverageCase(
      'recovery.security.split-gateway-session-takeover',
      'recovery.agent.split-gateway-takeover-fences-stale-owner',
    ),
    async ({
      adminApi,
      adminSession,
      page,
      seedState,
      topologyProvider,
    }) => {
      test.setTimeout(900_000);
      const target = seedState.servers.find((server) => server.key === 'node1')!;
      const raceAdminApi = adminApi;
      const raceAdminAccessToken = adminSession.accessToken;
      let container: RunningAdminContainer | null = null;
      let sshImageLease: ContainerSshImageLease | null = null;
      let sshImageGrant: { imageId: string; serverId: string } | null = null;
      let sshKeyId: string | null = null;
      let httpPoolId: string | null = null;
      let httpBindingId: string | null = null;
      let raceInjected = false;
      let staleConsoleSessionId: string | null = null;
      let primaryGatewayProcessGeneration: string | null = null;
      let primaryFailure: { error: unknown } | null = null;
      try {
        sshImageLease = new ContainerSshImageLease({
          adminApi,
          seedImageId: seedState.image.id,
          seedDockerImage: seedState.image.dockerImage,
          temporaryDockerImage: seedState.uiImage.dockerImage,
          serverId: target.serverId,
          label: 'split-gateway-race',
        });
        const sshImage = await sshImageLease.setup();
        await expectJson<unknown>(
          await adminApi.post(
            `/api/admin/users/${adminSession.user.id}/image-grants`,
            {
              data: {
                imageId: sshImage.id,
                serverId: target.serverId,
              },
            },
          ),
          201,
        );
        sshImageGrant = {
          imageId: sshImage.id,
          serverId: target.serverId,
        };
        container = await createRunningAdminContainer(
          raceAdminApi,
          seedState,
          'node1',
          'split-gateway-race',
          { imageId: sshImage.id, sshEnabled: true },
        );
        const proxyPublicKey = readFileSync(
          join(requireRuntimeEnv('E2E_RUNTIME_ROOT'), 'proxies', 'external-key.pub'),
          'utf8',
        ).trim();
        sshKeyId = (await expectJson<{ id: string }>(
          await raceAdminApi.post(`/api/users/${adminSession.user.id}/ssh-keys`, {
            data: {
              name: `${seedState.runId} split Gateway route`,
              keyText: proxyPublicKey,
            },
          }),
          201,
        )).id;

        const httpMarker = `split-http-${seedState.runId}`;
        const httpBody = `nyabase-real-proxy-target:/e2e/${httpMarker}`;
        const serverSession = await expectJson<ConsoleSession>(
          await raceAdminApi.post(
            `/api/admin/v2/containers/${container.id}/exec-sessions`,
            { data: { shell: '/bin/sh', tty: false } },
          ),
          201,
        );
        const primaryConsoleEndpoint = new URL(
          serverSession.consoleUrl,
          requireRuntimeEnv('E2E_BASE_URL'),
        );
        const expectedPrimaryConsoleEndpoint = new URL(
          '/ws/console',
          requireRuntimeEnv('E2E_BASE_URL'),
        );
        expectedPrimaryConsoleEndpoint.protocol = 'wss:';
        expect(primaryConsoleEndpoint.origin).toBe(expectedPrimaryConsoleEndpoint.origin);
        expect(primaryConsoleEndpoint.pathname).toBe('/ws/console');
        expect(primaryConsoleEndpoint.searchParams.get('sessionId')).toBe(
          serverSession.sessionId,
        );
        const serverStarted = await executeThroughConsole(
          page,
          requireRuntimeEnv('E2E_BASE_URL'),
          serverSession,
          raceAdminAccessToken,
          `mkdir -p /tmp/split-http; printf '%s\\n' '#!/bin/sh' 'printf "HTTP/1.1 200 OK\\r\\nContent-Length: ${Buffer.byteLength(httpBody)}\\r\\nConnection: close\\r\\n\\r\\n${httpBody}"' > /tmp/split-http/respond; chmod 700 /tmp/split-http/respond; /usr/bin/nc -lk -p 8080 -e /tmp/split-http/respond > /tmp/split-http/server.log 2>&1 & exit\n`,
        );
        expect(serverStarted.exitCode).toBe(0);
        const suffix = seedState.runId
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .slice(-24);
        const pool = await expectJson<HttpDomainPool>(
          await raceAdminApi.post('/api/admin/http-proxy/domain-pools', {
            data: {
              wildcardDomain: `*.split-${suffix}.test`,
              enabled: true,
              httpsEnabled: false,
            },
          }),
          201,
        );
        httpPoolId = pool.id;
        const hostname = `route.split-${suffix}.test`;
        const binding = await expectJson<HttpProxyBinding>(
          await raceAdminApi.post('/api/v2/http-proxy/bindings', {
            data: {
              hostname,
              containerId: container.id,
              targetPort: 8080,
            },
          }),
          201,
        );
        httpBindingId = binding.id;
        const beforePhysical = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        const [beforeSshProxy, beforeHttpProxy] = await Promise.all([
          expectJson<ProxyStatus>(await raceAdminApi.get('/api/admin/ssh-proxy/status')),
          expectJson<ProxyStatus>(await raceAdminApi.get('/api/admin/http-proxy/status')),
        ]);
        const staleSession = await expectJson<ConsoleSession>(
          await raceAdminApi.post(
            `/api/admin/v2/containers/${container.id}/exec-sessions`,
            { data: { shell: '/bin/sh', tty: false } },
          ),
          201,
        );
        staleConsoleSessionId = staleSession.sessionId;
        const staleConsoleEndpoint = new URL(
          staleSession.consoleUrl,
          requireRuntimeEnv('E2E_BASE_URL'),
        );
        expect(staleConsoleEndpoint.origin).toBe(expectedPrimaryConsoleEndpoint.origin);
        const staleOutputMarker = `split-stale-open-${seedState.runId}`;
        const staleProcessMarker = `split-stale-process-${seedState.runId}`;
        const staleFollowupMarker = `split-stale-forbidden-${seedState.runId}`;
        const staleOpen = await openPersistentConsoleUntilOutput(
          page,
          requireRuntimeEnv('E2E_BASE_URL'),
          staleSession,
          raceAdminAccessToken,
          `printf '${staleOutputMarker}'; exec /bin/sh -c 'while :; do sleep 60; done' '${staleProcessMarker}'\n`,
          staleOutputMarker,
        );
        expect(staleOpen).toEqual(expect.objectContaining({
          websocketUrl: staleConsoleEndpoint.toString(),
          output: expect.stringContaining(staleOutputMarker),
        }));
        const injected = await controlProviderFault(topologyProvider, {
          fault: 'splitGatewaySessionRace',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'inject',
          staleExecSessionId: staleSession.sessionId,
        });
        raceInjected = true;
        primaryGatewayProcessGeneration = injected.primaryGatewayProcessGeneration;
        expect(injected.ownerGatewayId).not.toBe(injected.baselineGatewayId);
        expect(injected).toEqual(expect.objectContaining({
          serverId: target.serverId,
          serverOnline: true,
          runtimeReady: true,
          primaryGatewayActive: true,
          primaryGatewayPaused: false,
          delayedPrimaryCleanupReleased: true,
          secondaryGatewayActive: true,
          secondaryEdgeActive: true,
          secondaryEdgeHostPortActive: true,
          secondaryEdgeHostPortOwned: true,
          routeActive: true,
          cleanupComplete: false,
        }));
        expect(injected.closedExecSessions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionId: staleSession.sessionId,
              state: 'closed',
              gatewayId: injected.baselineGatewayId,
            }),
          ]),
        );
        const staleClosed = await requirePersistentConsoleClosed(
          page,
          staleSession.sessionId,
          `printf '${staleFollowupMarker}'\n`,
          staleFollowupMarker,
        );
        staleConsoleSessionId = null;
        expect(staleClosed).toEqual(expect.objectContaining({
          websocketUrl: staleConsoleEndpoint.toString(),
          output: expect.stringContaining(staleOutputMarker),
          followupAccepted: false,
        }));
        expect(staleClosed.output).not.toContain(staleFollowupMarker);
        expect(staleClosed.closedAt).toBeGreaterThanOrEqual(staleClosed.openedAt);

        const selfCheck = await expectJson<{
          items: Array<{ id: string; status: string }>;
        }>(
          await raceAdminApi.get(`/api/admin/servers/${target.serverId}/self-check`),
        );
        expect(selfCheck.items.find((item) => item.id === 'docker')?.status).toBe('ok');

        const restarted = await settleRecoveryContainerAction(
          raceAdminApi,
          container.id,
          'restart',
          'container.restart',
        );
        expect(restarted).toEqual(expect.objectContaining({
          status: 'succeeded',
          serverId: target.serverId,
          resourceId: container.id,
        }));
        const running = await waitForContainer(
          raceAdminApi,
          container.id,
          'running through secondary socket owner',
          (candidate) =>
            candidate.runtime.status === 'running'
            && candidate.runtime.runtimeId === container!.view.runtime.runtimeId
            && candidate.activeTask === null,
        );
        expect(running.failureCode ?? null).toBeNull();

        const execSession = await expectJson<ConsoleSession>(
          await raceAdminApi.post(
            `/api/admin/v2/containers/${container.id}/exec-sessions`,
            { data: { shell: '/bin/sh', tty: false } },
          ),
          201,
        );
        expect(execSession.consoleUrl).toBe(
          `${injected.secondaryConsoleUrl}?sessionId=${encodeURIComponent(execSession.sessionId)}`,
        );
        const ownerConsoleEndpoint = new URL(
          execSession.consoleUrl,
          requireRuntimeEnv('E2E_BASE_URL'),
        );
        expect(ownerConsoleEndpoint.protocol).toBe('wss:');
        expect(ownerConsoleEndpoint.hostname).toBe('localhost');
        expect(ownerConsoleEndpoint.port).toBe(String(injected.secondaryEdgeHostPort));
        expect(ownerConsoleEndpoint.host).not.toBe(expectedPrimaryConsoleEndpoint.host);
        expect(ownerConsoleEndpoint.pathname).toBe('/ws/console');
        expect(ownerConsoleEndpoint.searchParams.get('sessionId')).toBe(
          execSession.sessionId,
        );
        const marker = `split-owner-${seedState.runId}`;
        const consoleResult = await executeThroughConsole(
          page,
          requireRuntimeEnv('E2E_BASE_URL'),
          execSession,
          raceAdminAccessToken,
          `printf '${marker}'; exit\n`,
        );
        expect(consoleResult).toEqual(expect.objectContaining({
          exitCode: 0,
          output: expect.stringContaining(marker),
          websocketUrl: ownerConsoleEndpoint.toString(),
          closeCode: 1000,
          closeReason: 'Session ended',
          closeWasClean: true,
        }));
        expect(consoleResult.output).not.toContain(staleFollowupMarker);

        const browserCloseSession = await expectJson<ConsoleSession>(
          await raceAdminApi.post(
            `/api/admin/v2/containers/${container.id}/exec-sessions`,
            { data: { shell: '/bin/sh', tty: false } },
          ),
          201,
        );
        const browserCloseEndpoint = new URL(
          browserCloseSession.consoleUrl,
          requireRuntimeEnv('E2E_BASE_URL'),
        );
        expect(browserCloseEndpoint.host).toBe(ownerConsoleEndpoint.host);
        expect(browserCloseEndpoint.host).not.toBe(expectedPrimaryConsoleEndpoint.host);
        const browserCloseOutputMarker = `split-browser-close-${seedState.runId}`;
        const browserCloseProcessMarker = `split-close-process-${seedState.runId}`;
        const browserClosed = await closeConsoleAfterOutput(
          page,
          requireRuntimeEnv('E2E_BASE_URL'),
          browserCloseSession,
          raceAdminAccessToken,
          `printf '${browserCloseOutputMarker}'; exec /bin/sh -c 'while :; do sleep 60; done' '${browserCloseProcessMarker}'\n`,
          browserCloseOutputMarker,
        );
        expect(browserClosed).toEqual(expect.objectContaining({
          websocketUrl: browserCloseEndpoint.toString(),
          output: expect.stringContaining(browserCloseOutputMarker),
          closeCode: 1000,
          closeWasClean: true,
        }));

        // Interactive exec close deliberately uses an exact-container stop as
        // its race-free physical absence barrier when Docker cannot prove the
        // exec itself exited. Wait for a newer desired-state observation
        // before opening the verification shell; then require another
        // strictly newer ready observation so a deferred stop cannot land
        // between the readiness proof and the next exec request.
        const runningObservedAt = running.runtime.observedAt;
        const firstPostBarrierObservation = await waitForContainer(
          raceAdminApi,
          container.id,
          'first running observation with SSH restored after browser-close physical exec barrier',
          (candidate) =>
            candidate.runtime.status === 'running'
            && candidate.activeTask === null
            && candidate.ssh.status === 'running'
            && candidate.ssh.ready === true
            && candidate.runtime.observedAt !== null
            && (
              runningObservedAt === null
              || Date.parse(candidate.runtime.observedAt) > Date.parse(runningObservedAt)
            ),
          180_000,
        );
        const settledPostBarrierObservation = await waitForContainer(
          raceAdminApi,
          container.id,
          'second running observation with SSH restored after browser-close physical exec barrier',
          (candidate) =>
            candidate.runtime.status === 'running'
            && candidate.activeTask === null
            && candidate.ssh.status === 'running'
            && candidate.ssh.ready === true
            && candidate.runtime.observedAt !== null
            && firstPostBarrierObservation.runtime.observedAt !== null
            && Date.parse(candidate.runtime.observedAt)
              > Date.parse(firstPostBarrierObservation.runtime.observedAt),
          180_000,
        );

        const closeCheckSession = await expectJson<ConsoleSession>(
          await raceAdminApi.post(
            `/api/admin/v2/containers/${container.id}/exec-sessions`,
            { data: { shell: '/bin/sh', tty: false } },
          ),
          201,
        );
        const closeCheckEndpoint = new URL(
          closeCheckSession.consoleUrl,
          requireRuntimeEnv('E2E_BASE_URL'),
        );
        expect(closeCheckEndpoint.host).toBe(ownerConsoleEndpoint.host);
        const closeTerminatedMarker = `split-close-terminated-${seedState.runId}`;
        // The HTTP fixture is an intentionally ephemeral process, not the
        // container entrypoint. Both the explicit restart and the physical
        // exec-absence barrier stop it, so restore the workload through the
        // secondary owner before proving the durable proxy binding still
        // routes to the recovered container.
        const closeCheck = await executeThroughConsole(
          page,
          requireRuntimeEnv('E2E_BASE_URL'),
          closeCheckSession,
          raceAdminAccessToken,
          `for i in $(seq 1 50); do if ! ps -eo args | grep -F '${browserCloseProcessMarker}' | grep -v 'grep -F' >/dev/null; then /usr/bin/nc -lk -p 8080 -e /tmp/split-http/respond > /tmp/split-http/server.log 2>&1 & for j in $(seq 1 50); do if grep -q ':1F90 .* 0A ' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then printf '${closeTerminatedMarker}'; exit 0; fi; sleep 0.1; done; exit 24; fi; sleep 0.2; done; exit 23\n`,
        );
        expect(closeCheck).toEqual(expect.objectContaining({
          websocketUrl: closeCheckEndpoint.toString(),
          exitCode: 0,
          output: expect.stringContaining(closeTerminatedMarker),
          closeCode: 1000,
          closeWasClean: true,
        }));
        await Promise.all([
          waitForProxySnapshotAfter(
            raceAdminApi,
            '/api/admin/ssh-proxy/status',
            settledPostBarrierObservation.runtime.observedAt!,
          ),
          waitForProxySnapshotAfter(
            raceAdminApi,
            '/api/admin/http-proxy/status',
            settledPostBarrierObservation.runtime.observedAt!,
          ),
        ]);
        const sshRoute = await controlProxyClient(topologyProvider, {
          runId: seedState.runId,
          action: 'sshExec',
          nodeKey: 'node1',
          containerName: container.view.name,
          marker: `split-ssh-${seedState.runId}`,
        });
        expect(sshRoute.markerMatched).toBe(true);
        const httpRoute = await controlProxyClient(topologyProvider, {
          runId: seedState.runId,
          action: 'httpGet',
          hostname,
          marker: httpMarker,
        });
        expect(httpRoute).toEqual(expect.objectContaining({
          httpStatus: 200,
          markerMatched: true,
        }));
        const [afterSshProxy, afterHttpProxy] = await Promise.all([
          expectJson<ProxyStatus>(await raceAdminApi.get('/api/admin/ssh-proxy/status')),
          expectJson<ProxyStatus>(await raceAdminApi.get('/api/admin/http-proxy/status')),
        ]);
        for (const [before, after] of [
          [beforeSshProxy, afterSshProxy],
          [beforeHttpProxy, afterHttpProxy],
        ] as const) {
          expect(after.connectedProxies).toBe(1);
          expect(after.proxies[0]?.lastSnapshotGeneration).not.toBeNull();
          expect(after.proxies[0]?.lastSnapshotGeneration ?? -1).toBeGreaterThanOrEqual(
            before.proxies[0]?.lastSnapshotGeneration ?? -1,
          );
        }

        const stable = await controlProviderFault(topologyProvider, {
          fault: 'splitGatewaySessionRace',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
          expectedClosedExecSessionIds: [
            staleSession.sessionId,
            browserCloseSession.sessionId,
          ],
        });
        expect(stable).toEqual(expect.objectContaining({
          ownerGatewayId: injected.ownerGatewayId,
          ownerSessionId: injected.ownerSessionId,
          ownerGeneration: injected.ownerGeneration,
          primaryGatewayProcessGeneration: injected.primaryGatewayProcessGeneration,
          serverOnline: true,
          runtimeReady: true,
          primaryGatewayActive: true,
          secondaryGatewayActive: true,
          secondaryEdgeHostPortActive: true,
          secondaryEdgeHostPortOwned: true,
          routeActive: true,
        }));
        expect(stable.closedExecSessions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionId: staleSession.sessionId,
              state: 'closed',
              gatewayId: injected.baselineGatewayId,
            }),
            expect.objectContaining({
              sessionId: browserCloseSession.sessionId,
              state: 'closed',
              gatewayId: injected.ownerGatewayId,
            }),
          ]),
        );
        const afterPhysical = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        expect(afterPhysical.runtimeContainerIds).toEqual(beforePhysical.runtimeContainerIds);
        expect(afterPhysical.activeRuntimeContainerIds).toEqual(
          beforePhysical.activeRuntimeContainerIds,
        );
      } catch (error) {
        primaryFailure = { error };
      } finally {
        await runCleanupStepsPreservingPrimary(
          'split Gateway session race cleanup failed',
          [
            async () => {
              if (!raceInjected) return;
              const restored = await controlProviderFault(topologyProvider, {
                fault: 'splitGatewaySessionRace',
                runId: seedState.runId,
                nodeKey: 'node1',
                action: 'restore',
              });
              raceInjected = false;
              expect(restored).toEqual(expect.objectContaining({
                serverId: target.serverId,
                serverOnline: true,
                runtimeReady: true,
                primaryGatewayActive: true,
                primaryGatewayPaused: false,
                delayedPrimaryCleanupReleased: true,
                primaryGatewayProcessGeneration:
                  primaryGatewayProcessGeneration,
                secondaryGatewayActive: false,
                secondaryEdgeActive: false,
                secondaryEdgeHostPortActive: false,
                secondaryEdgeHostPortOwned: false,
                routeActive: false,
                cleanupComplete: true,
              }));
            },
            async () => {
              if (!staleConsoleSessionId) return;
              await closePersistentConsoleForCleanup(page, staleConsoleSessionId);
              staleConsoleSessionId = null;
            },
            async () => {
              if (!container) return;
              if (httpBindingId) {
                const response = await raceAdminApi.delete(
                  `/api/v2/http-proxy/bindings/${httpBindingId}`,
                );
                expect([200, 204, 404]).toContain(response.status());
                httpBindingId = null;
              }
              if (httpPoolId) {
                const response = await raceAdminApi.delete(
                  `/api/admin/http-proxy/domain-pools/${httpPoolId}`,
                );
                expect([200, 204, 404]).toContain(response.status());
                httpPoolId = null;
              }
              if (sshKeyId) {
                const response = await raceAdminApi.delete(
                  `/api/users/${adminSession.user.id}/ssh-keys/${sshKeyId}`,
                );
                expect([200, 204, 404]).toContain(response.status());
                sshKeyId = null;
              }
              await cleanupContainerThroughProductApi(
                raceAdminApi,
                container.id,
                raceAdminApi,
              );
              container = null;
            },
            async () => {
              if (!sshImageGrant) return;
              const response = await raceAdminApi.delete(
                `/api/admin/users/${adminSession.user.id}/image-grants/`
                + `${sshImageGrant.imageId}/${sshImageGrant.serverId}`,
              );
              expect([204, 404]).toContain(response.status());
              sshImageGrant = null;
            },
            async () => {
              if (!sshImageLease) return;
              await sshImageLease.cleanup();
              sshImageLease = null;
            },
          ],
          primaryFailure,
        );
      }
    },
  );

  test(
    'recovery.authorization.held-request-rechecks-after-revocation',
    coverageCase(
      'recovery.security.authorization-race',
      'recovery.authorization.held-request-rechecks-after-revocation',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState, topologyProvider }) => {
      test.setTimeout(480_000);
      const target = seedState.servers.find((server) => server.key === 'node1')!;
      let persona: ContainerPersona | null = null;
      let held: HeldTlsRequest | null = null;
      try {
        persona = await createContainerPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          label: 'authorization-race',
          access: { serverId: target.serverId, imageId: seedState.image.id },
        });
        const beforeTasks = (await listServerTasks(adminApi, target.serverId))
          .map((task) => task.id)
          .sort();
        const beforeContainers = (await listServerContainers(adminApi, target.serverId))
          .map((container) => container.id)
          .sort();
        const beforePhysical = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        const attemptedName = uniqueName(seedState.runId, 'held-authorization');
        const body = JSON.stringify({
          serverId: target.serverId,
          imageId: seedState.image.id,
          name: attemptedName,
        });
        held = await openHeldTlsPost('/api/v2/containers', persona.accessToken, body);

        const revoked = await adminApi.delete(
          `/api/admin/users/${persona.user.id}/image-grants/${seedState.image.id}/${target.serverId}`,
        );
        expect(revoked.status()).toBe(204);
        const denied = await held.release();
        held = null;
        expect(denied.status).toBe(403);

        const afterTasks = (await listServerTasks(adminApi, target.serverId))
          .map((task) => task.id)
          .sort();
        const afterContainers = await listServerContainers(adminApi, target.serverId);
        expect(afterTasks).toEqual(beforeTasks);
        expect(afterContainers.map((container) => container.id).sort()).toEqual(beforeContainers);
        expect(afterContainers.some((container) => container.name === attemptedName)).toBe(false);
        const afterPhysical = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        expect(afterPhysical.runtimeContainerIds).toEqual(beforePhysical.runtimeContainerIds);
        expect(afterPhysical.activeRuntimeContainerIds).toEqual(
          beforePhysical.activeRuntimeContainerIds,
        );
      } finally {
        held?.abort();
        if (persona) {
          await cleanupContainerPersona(
            adminApi,
            persona,
            new ContainerDeadline(240_000, 'authorization race persona cleanup'),
          );
        }
      }
    },
  );

  test(
    'recovery.network.unknown-peer-inventory-fails-stop',
    coverageCase(
      'recovery.security.network-inventory-fail-stop',
      'recovery.network.unknown-peer-inventory-fails-stop',
    ),
    async ({ adminApi, seedState, topologyProvider }) => {
      test.setTimeout(360_000);
      const target = seedState.servers.find((server) => server.key === 'node1')!;
      const peer = seedState.servers.find((server) => server.key === 'node2')!;
      const beforeTasks = (await listServerTasks(adminApi, target.serverId))
        .map((task) => task.id)
        .sort();
      const beforeContainers = (await listServerContainers(adminApi, target.serverId))
        .map((container) => container.id)
        .sort();
      const beforePhysical = await controlProviderFault(topologyProvider, {
        fault: 'agentService',
        runId: seedState.runId,
        nodeKey: 'node1',
        action: 'probe',
      });
      let stopped = false;
      try {
        await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node2',
          action: 'stop',
        });
        stopped = true;
        await waitForServer(
          adminApi,
          peer.serverId,
          'untrusted peer inventory',
          (server) => server.status !== 'online' && !server.runtimeReady,
        );
        const attemptedName = uniqueName(seedState.runId, 'network-fail-stop');
        const rejected = await adminApi.post('/api/v2/containers', {
          data: {
            serverId: target.serverId,
            imageId: seedState.image.id,
            name: attemptedName,
          },
        });
        expect(rejected.status()).toBe(409);
        expect(await rejected.json()).toEqual(
          expect.objectContaining({ code: 'NETWORK_INVENTORY_UNTRUSTED' }),
        );
        expect((await listServerTasks(adminApi, target.serverId)).map((task) => task.id).sort())
          .toEqual(beforeTasks);
        const afterContainers = await listServerContainers(adminApi, target.serverId);
        expect(afterContainers.map((container) => container.id).sort()).toEqual(beforeContainers);
        expect(afterContainers.some((container) => container.name === attemptedName)).toBe(false);
        const afterPhysical = await controlProviderFault(topologyProvider, {
          fault: 'agentService',
          runId: seedState.runId,
          nodeKey: 'node1',
          action: 'probe',
        });
        expect(afterPhysical.runtimeContainerIds).toEqual(beforePhysical.runtimeContainerIds);
      } finally {
        if (stopped) {
          await controlProviderFault(topologyProvider, {
            fault: 'agentService',
            runId: seedState.runId,
            nodeKey: 'node2',
            action: 'start',
          });
          await waitForServer(
            adminApi,
            peer.serverId,
            'trusted peer inventory restored',
            (server) => server.status === 'online' && server.runtimeReady,
            180_000,
          );
        }
      }
    },
  );

  test(
    'recovery.artifacts.live-diagnostics-are-redacted',
    coverageCase(
      'recovery.security.secret-and-artifact-redaction',
      'recovery.artifacts.live-diagnostics-are-redacted',
    ),
    async ({ seedState, topologyProvider }) => {
      test.setTimeout(240_000);
      const audit = await controlProviderFault(topologyProvider, {
        fault: 'artifactAudit',
        runId: seedState.runId,
        action: 'capture',
      });
      expect(audit.status).toBe('clean');
      expect(audit.playwrightArtifactPolicy).toBe('pre-report-empty');
      expect(audit.filesChecked).toBeGreaterThan(10);
      expect(audit.knownSecretsChecked).toBeGreaterThanOrEqual(5);
      const bytes = readFileSync(audit.evidencePath);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(audit.evidenceSha256);
      const evidence = JSON.parse(bytes.toString('utf8')) as {
        runId: string;
        status: string;
        playwrightArtifactPolicy: string;
        fixtureProofsChecked: number;
      };
      expect(evidence).toEqual(
        expect.objectContaining({
          runId: seedState.runId,
          status: 'clean',
          playwrightArtifactPolicy: 'pre-report-empty',
          fixtureProofsChecked: 8,
        }),
      );
    },
  );

  test(
    'evidence.recovery.real-fault-applied-and-stack-converged @recovery',
    coverageCase(
      'recovery.security.runtime-fault-proof-contract',
      'evidence.recovery.real-fault-applied-and-stack-converged',
    ),
    async ({ adminApi }) => {
      const path = requireRuntimeEnv('E2E_RECOVERY_PROOF');
      const proof = JSON.parse(readFileSync(path, 'utf8')) as RecoveryProof;
      expect(proof.schemaVersion).toBe(1);
      expect(proof.runId).toBe(currentRunId());
      expect(proof.fault.kind).toBe('backendService');
      expect(proof.fault.target).toBe(`nyabase-e2e-${proof.runId}-split-control-plane`);
      expect(Number.isNaN(Date.parse(proof.fault.appliedAt))).toBe(false);
      expect(proof.before.healthy).toBe(true);
      expect(proof.after.healthy).toBe(true);
      expect(proof.after.generation).not.toBe(proof.before.generation);

      const servers = await expectJson<Array<{ status: string; runtimeReady: boolean }>>(
        await adminApi.get('/api/admin/servers'),
      );
      expect(servers).toHaveLength(2);
      for (const server of servers) {
        expect(server.status).toBe('online');
        expect(server.runtimeReady).toBe(true);
      }
    },
  );

  test(
    'recovery.http.agent-quarantine-retry-contract',
    coverageCase(
      'recovery.security.http.post.api-admin-servers-by-serverid-agent-quarantine-retry',
      'recovery.http.agent-quarantine-retry-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState, topologyProvider }) => {
      test.setTimeout(480_000);
      const target = seedState.servers.find((server) => server.key === 'node2')!;
      let persona: ContainerPersona | null = null;
      let faultAttempted = false;
      let restored = false;
      try {
        persona = await createContainerPersona({
          adminApi,
          anonymousApi,
          trackedApiFactory,
          label: 'quarantine-route-denial',
        });
        faultAttempted = true;
        const injected = await controlProviderFault(topologyProvider, {
          fault: 'localDataDirOrphan',
          runId: seedState.runId,
          nodeKey: 'node2',
          action: 'inject',
        });
        expect(injected.present).toBe(true);
        const quarantined = await waitForServer(
          adminApi,
          target.serverId,
          'inventory-fault quarantine for route contract',
          (server) => server.status === 'agent_quarantined',
        );
        expect(quarantined.quarantineCode).toBe('AGENT_INVENTORY_FAULT');
        const route = `/api/admin/servers/${target.serverId}/agent-quarantine/retry`;
        expect((await anonymousApi.post(route)).status()).toBe(401);
        expect((await persona.api.post(route)).status()).toBe(403);

        const removed = await controlProviderFault(topologyProvider, {
          fault: 'localDataDirOrphan',
          runId: seedState.runId,
          nodeKey: 'node2',
          action: 'restore',
        });
        restored = true;
        expect(removed.present).toBe(false);
        const retried = await expectJson<{ taskIds: string[] }>(
          await adminApi.post(route),
          201,
        );
        expect(retried).toEqual({ taskIds: [] });
        const recovered = await waitForServer(
          adminApi,
          target.serverId,
          'online after inventory quarantine retry',
          (server) =>
            server.status === 'online' &&
            server.runtimeReady &&
            server.quarantineCode === null &&
            server.quarantineMessage === null,
          180_000,
        );
        expect(recovered.runtimeReady).toBe(true);
      } finally {
        if (faultAttempted && !restored) {
          await controlProviderFault(topologyProvider, {
            fault: 'localDataDirOrphan',
            runId: seedState.runId,
            nodeKey: 'node2',
            action: 'restore',
          });
        }
        const server = await expectJson<ServerView>(
          await adminApi.get(`/api/admin/servers/${target.serverId}`),
        );
        if (server.status === 'agent_quarantined') {
          await expectJson<{ taskIds: string[] }>(
            await adminApi.post(
              `/api/admin/servers/${target.serverId}/agent-quarantine/retry`,
            ),
            201,
          );
          await waitForServer(
            adminApi,
            target.serverId,
            'online for quarantine route cleanup',
            (candidate) => candidate.status === 'online' && candidate.runtimeReady,
            180_000,
          );
        }
        if (persona) {
          await cleanupContainerPersona(
            adminApi,
            persona,
            new ContainerDeadline(180_000, 'quarantine route persona cleanup'),
          );
        }
      }
    },
  );

  test(
    'recovery.retention.production-horizon-prunes-unreferenced-history',
    coverageCase(
      'recovery.security.retention-horizon-pruning',
      'recovery.retention.production-horizon-prunes-unreferenced-history',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState, topologyProvider }) => {
      test.setTimeout(480_000);
      const target = seedState.servers.find((server) => server.key === 'node2')!;
      const image = await createDisposableImage(adminApi, seedState, 'retention-horizon');
      let advanced = false;
      try {
        const pull = await expectJson<ImagePullResponse>(
          await adminApi.post(`/api/admin/images/${image.id}/pull`, {
            data: { serverIds: [target.serverId] },
          }),
          201,
        );
        expect(pull.rejected).toEqual([]);
        expect(pull.tasks).toHaveLength(1);
        const historicalTask = await waitForAgentTask(adminApi, pull.tasks[0]!.taskId, {
          kind: 'image.ensure_present',
          resourceId: image.id,
          timeoutMs: 180_000,
        });
        expect(historicalTask.retentionUntil).not.toBeNull();
        await deleteDisposableImage(adminApi, image.id);
        expect((await adminApi.get(`/api/admin/agent-tasks/${historicalTask.id}`)).status())
          .toBe(200);

        const clock = await controlProviderFault(topologyProvider, {
          fault: 'backendClock',
          runId: seedState.runId,
          action: 'advance',
        });
        advanced = true;
        expect(clock.offsetMs).toBe(691_200_000);
        const session = await expectJson<{ accessToken: string }>(
          await anonymousApi.post('/api/auth/login', {
            data: {
              username: requireRuntimeEnv('E2E_ADMIN_USERNAME'),
              password: requireRuntimeEnv('E2E_ADMIN_PASSWORD'),
            },
          }),
        );
        const advancedApi = await trackedApiFactory({
          extraHTTPHeaders: { authorization: `Bearer ${session.accessToken}` },
        });
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          if ((await advancedApi.get(`/api/admin/agent-tasks/${historicalTask.id}`)).status() === 404) {
            break;
          }
          await delay(500);
        }
        expect(
          (await advancedApi.get(`/api/admin/agent-tasks/${historicalTask.id}`)).status(),
        ).toBe(404);
        const history = await expectJson<AgentTaskView[]>(
          await advancedApi.get(
            `/api/admin/agent-tasks?resourceType=image&resourceId=${encodeURIComponent(image.id)}&limit=100`,
          ),
        );
        expect(history.some((task) => task.id === historicalTask.id)).toBe(false);
      } finally {
        if (advanced) {
          const restored = await controlProviderFault(topologyProvider, {
            fault: 'backendClock',
            runId: seedState.runId,
            action: 'restore',
          });
          expect(restored.offsetMs).toBe(0);
          for (const server of seedState.servers) {
            await waitForServer(
              adminApi,
              server.serverId,
              'online after retention clock restoration',
              (candidate) => candidate.status === 'online' && candidate.runtimeReady,
              180_000,
            );
          }
        }
        if ((await adminApi.get(`/api/admin/images/${image.id}`)).status() !== 404) {
          await deleteDisposableImage(adminApi, image.id);
        }
      }
    },
  );
});
