import { test, expect } from '../../fixtures/live-stack.js';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ContainerDeadline } from '../../support/container-deadline.js';
import { ContainerMountLease } from '../../support/container-mount-lease.js';
import {
  ContainerLease,
  adminContainerLane,
  containerCollectionPath,
  containerResourcePath,
  listContainersViaLane,
  ownerContainerLane,
  settleContainerActionViaLane,
  uniqueContainerLeaseName,
  waitForContainerAbsentViaLane,
  waitForContainerViaLane,
  type RunningContainerLease,
} from '../../support/container-lease.js';
import {
  cleanupContainerPersona,
  createContainerPersona,
  type ContainerPersona,
  type TrackedApiFactory,
} from '../../support/container-persona.js';
import { ContainerSshImageLease } from '../../support/container-ssh-image-lease.js';
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
  waitForContainerAbsent,
  type AgentTaskRef,
  type AgentTaskView,
  type ContainerView,
} from '../../support/durable-api.js';
import { expectJson } from '../../support/http.js';
import { probeContainerSsh } from '../../support/container-ssh-client.js';
import { controlProviderFault } from '../../support/provider-fault-control.js';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';
import { aggregateErrorWithDiagnostics } from '../../support/error-diagnostics.mjs';
import type { SeedState } from '../../support/seed-state.js';
import type { AvailableTopologyProvider, TopologyNodeKey } from '../../topology/provider.js';

interface ContainerScenarioFixtures {
  adminApi: APIRequestContext;
  anonymousApi: APIRequestContext;
  trackedApiFactory: TrackedApiFactory;
  seedState: SeedState;
}

interface ContainerScenario {
  owner: ContainerPersona;
  stranger: ContainerPersona;
  lease: ContainerLease;
  created: RunningContainerLease;
  deadline: ContainerDeadline;
  mountLease: ContainerMountLease | null;
  newLease: (
    persona: ContainerPersona,
    suffix: string,
    overrides?: Partial<
      Pick<ConstructorParameters<typeof ContainerLease>[0], 'imageId' | 'dataDirs'>
    >,
  ) => ContainerLease;
}

interface ContainerScenarioOptions {
  ownerAccess?: {
    cpuMillis?: number;
    memBytes?: number;
    diskBytes?: number;
  };
  strangerAccess?: boolean;
  mount?: { containerPath?: string };
  sshEnabledImage?: boolean;
  operationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

async function withContainerScenario(
  fixtures: ContainerScenarioFixtures,
  label: string,
  run: (scenario: ContainerScenario) => Promise<void>,
  options: ContainerScenarioOptions = {},
): Promise<void> {
  const serverId = fixtures.seedState.servers[0].serverId;
  let owner: ContainerPersona | null = null;
  let stranger: ContainerPersona | null = null;
  let mountLease: ContainerMountLease | null = null;
  let sshImageLease: ContainerSshImageLease | null = null;
  const leases: ContainerLease[] = [];
  let primaryError: unknown = null;
  let failed = false;

  try {
    let imageId = fixtures.seedState.image.id;
    if (options.sshEnabledImage) {
      sshImageLease = new ContainerSshImageLease({
        adminApi: fixtures.adminApi,
        seedImageId: fixtures.seedState.image.id,
        seedDockerImage: fixtures.seedState.image.dockerImage,
        temporaryDockerImage: fixtures.seedState.uiImage.dockerImage,
        serverId,
        label,
      });
      imageId = (await sshImageLease.setup()).id;
    }
    owner = await createContainerPersona({
      ...fixtures,
      label: `${label}-owner`,
      access: { serverId, imageId, ...options.ownerAccess },
    });
    stranger = await createContainerPersona({
      ...fixtures,
      label: `${label}-stranger`,
      ...(options.strangerAccess ? { access: { serverId, imageId } } : {}),
    });
    if (options.mount) {
      const source = fixtures.seedState.mountSourceGrants.find(
        (grant) => grant.serverId === serverId,
      );
      if (!source) throw new Error(`Seed state has no physical mount source for ${serverId}`);
      mountLease = new ContainerMountLease({
        adminApi: fixtures.adminApi,
        ownerApi: owner.api,
        ownerId: owner.user.id,
        serverId,
        sourceId: source.diskId,
        sourceIdentity: source.sourceIdentity,
        label,
        containerPath: options.mount.containerPath,
      });
      await mountLease.setup();
    }
    const newLease: ContainerScenario['newLease'] = (persona, suffix, overrides = {}) => {
      const next = new ContainerLease({
        ownerApi: persona.api,
        adminApi: fixtures.adminApi,
        ownerId: persona.user.id,
        serverId,
        imageId: overrides.imageId ?? imageId,
        name: uniqueContainerLeaseName(`${label}-${suffix}`),
        ...(overrides.dataDirs ? { dataDirs: overrides.dataDirs } : {}),
      });
      leases.push(next);
      return next;
    };
    const lease = newLease(
      owner,
      'primary',
      mountLease ? { dataDirs: [mountLease.mountInput] } : undefined,
    );
    const deadline = new ContainerDeadline(
      options.operationTimeoutMs ?? 240_000,
      `${label} container operations`,
    );
    const created = await lease.createRunning(deadline);
    await run({ owner, stranger, lease, created, deadline, mountLease, newLease });
  } catch (error) {
    failed = true;
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  const cleanupDeadline = new ContainerDeadline(
    options.cleanupTimeoutMs ?? 240_000,
    `cleanup ${label} scenario`,
  );
  for (const lease of [...leases].reverse()) {
    await captureCleanupError(cleanupErrors, () => lease.cleanup(cleanupDeadline));
  }
  if (mountLease) {
    await captureCleanupError(cleanupErrors, () => mountLease!.cleanup(cleanupDeadline));
  }
  if (stranger) {
    await captureCleanupError(cleanupErrors, () =>
      cleanupContainerPersona(fixtures.adminApi, stranger!, cleanupDeadline),
    );
  }
  if (owner) {
    await captureCleanupError(cleanupErrors, () =>
      cleanupContainerPersona(fixtures.adminApi, owner!, cleanupDeadline),
    );
  }
  if (sshImageLease) {
    await captureCleanupError(cleanupErrors, () => sshImageLease!.cleanup(cleanupDeadline));
  }

  if (failed && cleanupErrors.length > 0) {
    throw aggregateErrorWithDiagnostics(
      `${label} scenario and product cleanup both failed`,
      [primaryError, ...cleanupErrors],
    );
  }
  if (failed) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw aggregateErrorWithDiagnostics(
      `${label} scenario cleanup had failures`,
      cleanupErrors,
    );
  }
}

async function captureCleanupError(
  errors: unknown[],
  cleanup: () => Promise<unknown>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

async function executeOwnerShell(
  page: Page,
  owner: ContainerPersona,
  lease: ContainerLease,
  command: string,
  deadline: ContainerDeadline,
): Promise<{ output: string; exitCode: number }> {
  const containerId = lease.requireContainerId();
  const session = await expectJson<ConsoleSession>(
    await owner.api.post(`${containerResourcePath('owner', containerId)}/exec-sessions`, {
      data: { shell: '/bin/sh', tty: false },
      timeout: deadline.remaining(`create Console session for ${containerId}`, 30_000),
    }),
    201,
  );
  return executeThroughConsole(
    page,
    requireRuntimeEnv('E2E_BASE_URL'),
    session,
    owner.accessToken,
    command,
    deadline.remaining(`execute Console command in ${containerId}`, 30_000),
  );
}

async function listContainerTaskHistory(
  adminApi: APIRequestContext,
  containerId: string,
  deadline: ContainerDeadline,
): Promise<AgentTaskView[]> {
  return expectJson<AgentTaskView[]>(
    await adminApi.get(
      `/api/admin/agent-tasks?resourceType=container&resourceId=${encodeURIComponent(containerId)}&limit=100`,
      { timeout: deadline.remaining(`list container task history for ${containerId}`, 30_000) },
    ),
  );
}

async function waitForNewContainerTask(
  adminApi: APIRequestContext,
  containerId: string,
  kind: string,
  excludedTaskIds: ReadonlySet<string>,
  deadline: ContainerDeadline,
): Promise<AgentTaskView> {
  while (true) {
    const tasks = await listContainerTaskHistory(adminApi, containerId, deadline);
    const task = tasks.find(
      (candidate) => candidate.kind === kind && !excludedTaskIds.has(candidate.id),
    );
    if (task) return task;
    await deadline.delay(`wait for new ${kind} task on ${containerId}`, 500);
  }
}

async function waitForSshReady(
  lane: ReturnType<typeof ownerContainerLane> | ReturnType<typeof adminContainerLane>,
  containerId: string,
  deadline: ContainerDeadline,
  generation?: number,
): Promise<ContainerView> {
  return waitForContainerViaLane(
    lane,
    containerId,
    generation === undefined ? 'SSH ready' : `SSH generation ${generation} ready`,
    (view) =>
      view.runtime.status === 'running' &&
      view.activeTask === null &&
      view.ssh.enabled === true &&
      view.ssh.ready === true &&
      (generation === undefined || view.ssh.appliedInternalKeyGeneration === generation) &&
      typeof view.ssh.hostKeyFingerprint === 'string' &&
      /^SHA256:[A-Za-z0-9+/]{43}$/.test(view.ssh.hostKeyFingerprint),
    deadline,
  );
}

async function expectImmutableMountResponse(response: APIResponse): Promise<void> {
  expect(response.status()).toBe(403);
  const body = await expectJson<{ message: string }>(response, 403);
  expect(body.message).toContain('Container mounts are immutable');
}

async function waitForRealContainerSet(
  adminApi: APIRequestContext,
  serverId: string,
  expectedIds: ReadonlySet<string>,
  deadline: ContainerDeadline,
): Promise<ContainerView[]> {
  while (true) {
    const containers = await listContainersViaLane(
      adminContainerLane(adminApi),
      serverId,
      deadline,
    );
    const ids = new Set(containers.map((container) => container.id));
    const allReal =
      containers.length === expectedIds.size &&
      expectedIds.size === ids.size &&
      [...expectedIds].every((id) => ids.has(id)) &&
      containers.every(
        (container) =>
          container.runtime.bound &&
          container.runtime.status === 'running' &&
          container.activeTask === null &&
          typeof container.runtime.runtimeId === 'string' &&
          container.runtime.runtimeId.length === 64,
      ) &&
      new Set(containers.map((container) => container.runtime.runtimeId)).size === expectedIds.size;
    if (allReal) return containers;
    await deadline.delay(`wait for ${expectedIds.size} real managed containers`, 500);
  }
}

interface ContainerCapacitySnapshot {
  tasks: AgentTaskView[];
  taskIds: string[];
  containerIds: string[];
  productRuntimeIds: string[];
  allRuntimeIds: string[];
  activeRuntimeIds: string[];
}

async function captureContainerCapacitySnapshot(
  adminApi: APIRequestContext,
  topologyProvider: AvailableTopologyProvider,
  runId: string,
  serverId: string,
  nodeKey: TopologyNodeKey,
  deadline: ContainerDeadline,
): Promise<ContainerCapacitySnapshot> {
  const tasks = await expectJson<AgentTaskView[]>(
    await adminApi.get(
      `/api/admin/agent-tasks?serverId=${encodeURIComponent(serverId)}` +
        '&resourceType=container&limit=100',
      { timeout: deadline.remaining('list bounded Server container task authority', 30_000) },
    ),
  );
  const containers = await listContainersViaLane(adminContainerLane(adminApi), serverId, deadline);
  const physical = await controlProviderFault(topologyProvider, {
    fault: 'agentService',
    runId,
    nodeKey,
    action: 'probe',
  });
  if (!physical.runtimeContainerIds || !physical.activeRuntimeContainerIds) {
    throw new Error(`Server ${serverId} provider probe omitted physical runtime identities`);
  }
  const productRuntimeIds = containers.map((container) => container.runtime.runtimeId);
  if (productRuntimeIds.some((runtimeId) => !runtimeId || !/^[a-f0-9]{64}$/.test(runtimeId))) {
    throw new Error(`Server ${serverId} product inventory contains an invalid runtime identity`);
  }
  const taskIds = tasks.map((task) => task.id).sort();
  const containerIds = containers.map((container) => container.id).sort();
  const normalizedProductRuntimeIds = (productRuntimeIds as string[]).sort();
  if (
    new Set(taskIds).size !== taskIds.length ||
    new Set(containerIds).size !== containerIds.length ||
    new Set(normalizedProductRuntimeIds).size !== normalizedProductRuntimeIds.length
  ) {
    throw new Error(`Server ${serverId} capacity snapshot contains duplicate durable identities`);
  }
  return {
    tasks,
    taskIds,
    containerIds,
    productRuntimeIds: normalizedProductRuntimeIds,
    allRuntimeIds: [...physical.runtimeContainerIds].sort(),
    activeRuntimeIds: [...physical.activeRuntimeContainerIds].sort(),
  };
}

function expectCapacitySnapshotUnchanged(
  before: ContainerCapacitySnapshot,
  after: ContainerCapacitySnapshot,
  label: string,
): void {
  const beforeTaskIds = new Set(before.taskIds);
  expect(
    after.taskIds.filter((taskId) => !beforeTaskIds.has(taskId)),
    `${label}: rejected admission created no new durable Server task ID`,
  ).toEqual([]);
  expect(after.taskIds, `${label}: no new durable Server task IDs`).toEqual(before.taskIds);
  expect(after.containerIds, `${label}: no new product container IDs`).toEqual(before.containerIds);
  expect(after.productRuntimeIds, `${label}: no product runtime identity drift`).toEqual(
    before.productRuntimeIds,
  );
  expect(after.allRuntimeIds, `${label}: no stopped or delayed physical runtime IDs`).toEqual(
    before.allRuntimeIds,
  );
  expect(after.activeRuntimeIds, `${label}: no active or delayed physical runtime IDs`).toEqual(
    before.activeRuntimeIds,
  );
}

async function getServerRuntimeObservedAt(
  adminApi: APIRequestContext,
  serverId: string,
  deadline: ContainerDeadline,
): Promise<string> {
  const server = await expectJson<{ id: string; runtimeObservedAt: string | null }>(
    await adminApi.get(`/api/admin/servers/${serverId}`, {
      timeout: deadline.remaining(`read Server ${serverId} runtime observation`, 30_000),
    }),
  );
  if (
    server.id !== serverId ||
    !server.runtimeObservedAt ||
    Number.isNaN(Date.parse(server.runtimeObservedAt))
  ) {
    throw new Error(`Server ${serverId} has no valid authoritative runtime observation`);
  }
  return server.runtimeObservedAt;
}

async function waitForServerRuntimeObservationAdvance(
  adminApi: APIRequestContext,
  serverId: string,
  after: string,
  deadline: ContainerDeadline,
): Promise<string> {
  const baseline = Date.parse(after);
  if (Number.isNaN(baseline)) {
    throw new Error(`Server ${serverId} runtime observation baseline is invalid`);
  }
  while (true) {
    const observedAt = await getServerRuntimeObservedAt(adminApi, serverId, deadline);
    if (Date.parse(observedAt) > baseline) return observedAt;
    await deadline.delay(`wait for Server ${serverId} authoritative runtime observation`, 500);
  }
}

test.describe('30 containers', () => {
  test(
    'api.containers.real-cpu-lifecycle-console-and-delete-proof @smoke',
    coverageCase(
      'containers.lifecycle-console.cpu-lifecycle-console-delete-smoke',
      'api.containers.real-cpu-lifecycle-console-and-delete-proof',
    ),
    async ({ adminApi, adminSession, page, seedState }) => {
      test.setTimeout(300_000);
      const server = seedState.servers.find((entry) => entry.key === 'node1');
      expect(server).toBeDefined();
      const runId = currentRunId();
      const name = `${runId.slice(0, 38)}-${Date.now().toString(36)}-cpu`;
      let containerId: string | null = null;

      try {
        const createRef = await expectJson<AgentTaskRef>(
          await adminApi.post('/api/v2/containers', {
            data: {
              serverId: server!.serverId,
              imageId: seedState.image.id,
              name,
            },
          }),
          201,
        );
        expect(createRef.ok).toBe(true);

        const pendingCreate = await expectJson<AgentTaskView>(
          await adminApi.get(`/api/admin/agent-tasks/${createRef.taskId}`),
        );
        containerId = pendingCreate.resourceId;
        expect(containerId).not.toBe('');
        const createTask = await waitForAgentTask(adminApi, createRef.taskId, {
          kind: 'container.create',
          resourceId: containerId,
        });
        expect(createTask.serverId).toBe(server!.serverId);
        expect(createTask.result).toEqual(
          expect.objectContaining({
            containerId,
            runtimeId: expect.any(String),
            ip: expect.any(String),
            quotaPaths: [expect.any(String), expect.any(String)],
          }),
        );

        const running = await waitForContainer(
          adminApi,
          containerId,
          'running after create',
          (view) =>
            view.runtime.bound &&
            view.runtime.status === 'running' &&
            view.powerIntent === 'running' &&
            view.activeTask === null,
        );
        expect(running).toEqual(
          expect.objectContaining({
            id: containerId,
            serverId: server!.serverId,
            imageId: seedState.image.id,
            name,
            runtimeReady: true,
          }),
        );
        expect(running.runtime.runtimeId).toBe(
          (createTask.result as { runtimeId: string }).runtimeId,
        );
        expect(running.runtime.ip).toBe((createTask.result as { ip: string }).ip);
        expect(running.resources).toEqual({
          cpuMillis: 2000,
          memBytes: 1_073_741_824,
          diskBytes: 2_147_483_648,
          gpuIndices: [],
        });

        const stats = await expectJson<{
          containerId: string;
          stats: unknown | null;
          ts: number;
          lastObservedAt?: string;
        }>(await adminApi.get(`/api/v2/containers/${containerId}/stats`));
        expect(stats.containerId).toBe(containerId);
        expect(stats.ts).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(stats.lastObservedAt ?? ''))).toBe(false);

        const execSession = await expectJson<ConsoleSession>(
          await adminApi.post(`/api/v2/containers/${containerId}/exec-sessions`, {
            data: { shell: '/bin/sh', tty: false },
          }),
          201,
        );
        const marker = `nyabase-console-${runId}`;
        const consoleResult = await executeThroughConsole(
          page,
          requireRuntimeEnv('E2E_BASE_URL'),
          execSession,
          adminSession.accessToken,
          `printf '${marker}\\n'; exit\n`,
        );
        expect(consoleResult.exitCode).toBe(0);
        expect(consoleResult.output).toContain(marker);

        const stopTask = await settleAction(adminApi, containerId, 'stop', 'container.stop');
        expect(stopTask.result).toEqual(
          expect.objectContaining({
            containerId,
            runtimeId: running.runtime.runtimeId,
          }),
        );
        const stopped = await waitForContainer(
          adminApi,
          containerId,
          'stopped',
          (view) =>
            view.runtime.status === 'exited' &&
            view.powerIntent === 'stopped' &&
            view.activeTask === null,
        );
        expect(stopped.runtime.drift).not.toContainEqual(
          expect.objectContaining({ kind: 'spec_generation_stale' }),
        );
        expect(stopped.actions.start).toEqual({ enabled: true });

        const startTask = await settleAction(adminApi, containerId, 'start', 'container.start');
        const started = await waitForContainer(
          adminApi,
          containerId,
          'running after start',
          (view) =>
            view.runtime.status === 'running' &&
            view.powerIntent === 'running' &&
            view.activeTask === null,
        );
        expect(started.runtime.runtimeId).toBe(running.runtime.runtimeId);

        const restartTask = await settleAction(
          adminApi,
          containerId,
          'restart',
          'container.restart',
        );
        const restarted = await waitForContainer(
          adminApi,
          containerId,
          'running after restart',
          (view) =>
            view.runtime.status === 'running' &&
            view.powerIntent === 'running' &&
            view.activeTask === null,
        );
        expect(restarted.runtime.runtimeId).toBe(running.runtime.runtimeId);
        expect((restartTask.result as { startedAt: string }).startedAt).not.toBe(
          (startTask.result as { startedAt: string }).startedAt,
        );

        const deleteRef = await requestContainerAction(adminApi, containerId, 'delete');
        const deleteTask = await waitForAgentTask(adminApi, deleteRef.taskId, {
          kind: 'container.delete',
          resourceId: containerId,
        });
        expect(deleteTask.agentResult).toEqual(expect.objectContaining({ status: 'succeeded' }));
        expect(deleteTask.result).toEqual({
          containerId,
          runtimeId: null,
          quotaPaths: (createTask.result as { quotaPaths: string[] }).quotaPaths,
        });
        await waitForContainerAbsent(adminApi, containerId);
        expect(await getContainerOrNull(adminApi, containerId)).toBeNull();

        const history = await expectJson<AgentTaskView[]>(
          await adminApi.get(
            `/api/admin/agent-tasks?resourceType=container&resourceId=${encodeURIComponent(containerId)}&limit=20`,
          ),
        );
        const expectedKinds = [
          'container.create',
          'container.stop',
          'container.start',
          'container.restart',
          'container.delete',
        ];
        for (const kind of expectedKinds) {
          expect(history.filter((task) => task.kind === kind)).toHaveLength(1);
        }
        expect(history.every((task) => task.status === 'succeeded')).toBe(true);
      } finally {
        if (containerId) await cleanupContainerThroughProductApi(adminApi, containerId);
      }
    },
  );

  test(
    'api.containers.create-real-runtime',
    coverageCase('containers.lifecycle-console.create', 'api.containers.create-real-runtime'),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'create',
        async ({ owner, stranger, lease, created }) => {
          const containerId = lease.requireContainerId();
          expect(created.task).toEqual(
            expect.objectContaining({
              kind: 'container.create',
              resourceId: containerId,
              serverId: seedState.servers[0].serverId,
              requestedBy: owner.user.id,
              status: 'succeeded',
              result: expect.objectContaining({
                containerId,
                runtimeId: expect.any(String),
                quotaPaths: [expect.any(String), expect.any(String)],
              }),
            }),
          );
          expect(created.view).toEqual(
            expect.objectContaining({
              id: containerId,
              ownerId: owner.user.id,
              imageId: seedState.image.id,
              runtimeReady: true,
              resources: {
                cpuMillis: 2000,
                memBytes: 1_073_741_824,
                diskBytes: 2_147_483_648,
                gpuIndices: [],
              },
            }),
          );

          const createBody = {
            data: {
              serverId: seedState.servers[0].serverId,
              imageId: seedState.image.id,
              name: uniqueContainerLeaseName('create-denied'),
            },
          };
          expect((await anonymousApi.post('/api/v2/containers', createBody)).status()).toBe(401);
          expect((await stranger.api.post('/api/v2/containers', createBody)).status()).toBe(403);
          expect((await owner.api.get(containerResourcePath('admin', containerId))).status()).toBe(
            403,
          );
          expect((await adminApi.get(containerResourcePath('owner', containerId))).status()).toBe(
            403,
          );
          expect(
            await expectJson<ContainerView>(
              await adminApi.get(containerResourcePath('admin', containerId)),
            ),
          ).toEqual(expect.objectContaining({ id: containerId, ownerId: owner.user.id }));
        },
      );
    },
  );

  test(
    'api.containers.start-stop-restart-delete-real-runtime',
    coverageCase(
      'containers.lifecycle-console.start-stop-restart-delete',
      'api.containers.start-stop-restart-delete-real-runtime',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'lifecycle',
        async ({ owner, stranger, lease, created, deadline }) => {
          const containerId = lease.requireContainerId();
          const runtimeId = created.view.runtime.runtimeId;
          const ownerPath = containerResourcePath('owner', containerId);

          expect((await anonymousApi.post(`${ownerPath}/actions/stop`)).status()).toBe(401);
          expect((await stranger.api.post(`${ownerPath}/actions/stop`)).status()).toBe(403);
          expect((await adminApi.post(`${ownerPath}/actions/stop`)).status()).toBe(403);

          const stopped = await settleContainerActionViaLane(
            lease.ownerLane,
            adminApi,
            containerId,
            'stop',
            deadline,
          );
          expect(stopped).toEqual(
            expect.objectContaining({
              requestedBy: owner.user.id,
              result: expect.objectContaining({ containerId, runtimeId }),
            }),
          );
          await waitForContainerViaLane(
            lease.ownerLane,
            containerId,
            'stopped in owner lifecycle',
            (view) => view.runtime.status === 'exited' && view.powerIntent === 'stopped',
            deadline,
          );

          const started = await settleContainerActionViaLane(
            lease.ownerLane,
            adminApi,
            containerId,
            'start',
            deadline,
          );
          expect(started.requestedBy).toBe(owner.user.id);
          await waitForContainerViaLane(
            lease.ownerLane,
            containerId,
            'started in owner lifecycle',
            (view) => view.runtime.status === 'running' && view.powerIntent === 'running',
            deadline,
          );

          const restarted = await settleContainerActionViaLane(
            lease.ownerLane,
            adminApi,
            containerId,
            'restart',
            deadline,
          );
          expect(restarted).toEqual(
            expect.objectContaining({
              requestedBy: owner.user.id,
              result: expect.objectContaining({ containerId, runtimeId }),
            }),
          );
          const afterRestart = await waitForContainerViaLane(
            lease.ownerLane,
            containerId,
            'restarted in owner lifecycle',
            (view) => view.runtime.status === 'running' && view.activeTask === null,
            deadline,
          );
          expect(afterRestart.runtime.runtimeId).toBe(runtimeId);

          expect((await anonymousApi.post(`${ownerPath}/actions/delete`)).status()).toBe(401);
          expect((await stranger.api.post(`${ownerPath}/actions/delete`)).status()).toBe(403);
          expect((await adminApi.post(`${ownerPath}/actions/delete`)).status()).toBe(403);
          const deleted = await settleContainerActionViaLane(
            lease.ownerLane,
            adminApi,
            containerId,
            'delete',
            deadline,
          );
          expect(deleted.requestedBy).toBe(owner.user.id);
          await waitForContainerAbsentViaLane(lease.adminLane, containerId, deadline);
          lease.markDeleted();
        },
      );
    },
  );

  test(
    'api.containers.exec-and-console-real-traffic',
    coverageCase(
      'containers.lifecycle-console.exec-and-console-traffic',
      'api.containers.exec-and-console-real-traffic',
    ),
    async ({ adminApi, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'console',
        async ({ owner, stranger, lease }) => {
          const containerId = lease.requireContainerId();
          const path = `${containerResourcePath('owner', containerId)}/exec-sessions`;
          const body = { data: { shell: '/bin/sh', tty: false } };
          expect((await anonymousApi.post(path, body)).status()).toBe(401);
          expect((await stranger.api.post(path, body)).status()).toBe(403);
          expect((await adminApi.post(path, body)).status()).toBe(403);

          const session = await expectJson<ConsoleSession>(
            await owner.api.post(path, body),
            201,
          );
          const marker = `console-${lease.input.name}`;
          const result = await executeThroughConsole(
            page,
            requireRuntimeEnv('E2E_BASE_URL'),
            session,
            owner.accessToken,
            `printf '${marker}'; exit\n`,
          );
          expect(result.exitCode).toBe(0);
          expect(result.output).toContain(marker);
        },
      );
    },
  );

  test(
    'api.containers.real-cgroup-cpu-and-memory-limits',
    coverageCase(
      'containers.lifecycle-console.cpu-and-memory-limits',
      'api.containers.real-cgroup-cpu-and-memory-limits',
    ),
    async ({ adminApi, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'cgroup',
        async ({ owner, stranger, lease, created }) => {
          const containerId = lease.requireContainerId();
          const path = `${containerResourcePath('owner', containerId)}/exec-sessions`;
          const body = { data: { shell: '/bin/sh', tty: false } };
          expect((await anonymousApi.post(path, body)).status()).toBe(401);
          expect((await stranger.api.post(path, body)).status()).toBe(403);
          expect((await adminApi.post(path, body)).status()).toBe(403);
          const session = await expectJson<ConsoleSession>(
            await owner.api.post(path, body),
            201,
          );
          const result = await executeThroughConsole(
            page,
            requireRuntimeEnv('E2E_BASE_URL'),
            session,
            owner.accessToken,
            "printf 'CPU='; cat /sys/fs/cgroup/cpu.max; printf 'MEM='; cat /sys/fs/cgroup/memory.max; exit\n",
          );
          expect(result.exitCode).toBe(0);
          expect(result.output).toMatch(/CPU=200000\s+100000/);
          expect(result.output).toMatch(/MEM=1073741824/);
          expect(created.view.resources).toEqual(
            expect.objectContaining({ cpuMillis: 2000, memBytes: 1_073_741_824 }),
          );
        },
      );
    },
  );

  test(
    'api.containers.admin-list-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.get.api-admin-v2-containers',
      'api.containers.admin-list-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-list',
        async ({ owner, stranger, lease }) => {
          const containerId = lease.requireContainerId();
          const adminPath = `${containerCollectionPath('admin')}?serverId=${encodeURIComponent(
            seedState.servers[0].serverId,
          )}`;
          expect((await anonymousApi.get(adminPath)).status()).toBe(401);
          expect((await owner.api.get(adminPath)).status()).toBe(403);
          expect((await stranger.api.get(adminPath)).status()).toBe(403);

          const adminContainers = await listContainersViaLane(
            adminContainerLane(adminApi),
            seedState.servers[0].serverId,
          );
          expect(adminContainers).toContainEqual(
            expect.objectContaining({
              id: containerId,
              ownerId: owner.user.id,
              serverId: seedState.servers[0].serverId,
            }),
          );
          expect(
            (await listContainersViaLane(ownerContainerLane(owner.api))).some(
              (container) => container.id === containerId,
            ),
          ).toBe(true);
          expect(
            (await listContainersViaLane(ownerContainerLane(stranger.api))).some(
              (container) => container.id === containerId,
            ),
          ).toBe(false);
          expect(
            (await listContainersViaLane(ownerContainerLane(adminApi))).some(
              (container) => container.id === containerId,
            ),
          ).toBe(false);
        },
      );
    },
  );

  test(
    'api.containers.admin-get-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.get.api-admin-v2-containers-by-containerid',
      'api.containers.admin-get-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-get',
        async ({ owner, stranger, lease }) => {
          const containerId = lease.requireContainerId();
          const adminPath = containerResourcePath('admin', containerId);
          expect((await anonymousApi.get(adminPath)).status()).toBe(401);
          expect((await owner.api.get(adminPath)).status()).toBe(403);
          expect((await stranger.api.get(adminPath)).status()).toBe(403);
          expect((await adminApi.get(containerResourcePath('owner', containerId))).status()).toBe(
            403,
          );

          const container = await expectJson<ContainerView>(await adminApi.get(adminPath));
          expect(container).toEqual(
            expect.objectContaining({
              id: containerId,
              ownerId: owner.user.id,
              runtimeReady: true,
              runtime: expect.objectContaining({ bound: true, status: 'running' }),
            }),
          );
        },
      );
    },
  );

  test(
    'api.containers.admin-stats-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.get.api-admin-v2-containers-by-containerid-stats',
      'api.containers.admin-stats-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-stats',
        async ({ owner, stranger, lease }) => {
          const containerId = lease.requireContainerId();
          const adminPath = `${containerResourcePath('admin', containerId)}/stats`;
          expect((await anonymousApi.get(adminPath)).status()).toBe(401);
          expect((await owner.api.get(adminPath)).status()).toBe(403);
          expect((await stranger.api.get(adminPath)).status()).toBe(403);
          expect(
            (await adminApi.get(`${containerResourcePath('owner', containerId)}/stats`)).status(),
          ).toBe(403);

          const stats = await expectJson<{
            containerId: string;
            ts: number;
            lastObservedAt?: string;
          }>(await adminApi.get(adminPath));
          expect(stats.containerId).toBe(containerId);
          expect(stats.ts).toBeGreaterThan(0);
          expect(Number.isNaN(Date.parse(stats.lastObservedAt ?? ''))).toBe(false);
        },
      );
    },
  );

  test(
    'api.containers.admin-stop-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-stop',
      'api.containers.admin-stop-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-stop',
        async ({ owner, stranger, lease, deadline }) => {
          const containerId = lease.requireContainerId();
          const adminPath = `${containerResourcePath('admin', containerId)}/actions/stop`;
          expect((await anonymousApi.post(adminPath)).status()).toBe(401);
          expect((await owner.api.post(adminPath)).status()).toBe(403);
          expect((await stranger.api.post(adminPath)).status()).toBe(403);
          expect(
            (
              await adminApi.post(`${containerResourcePath('owner', containerId)}/actions/stop`)
            ).status(),
          ).toBe(403);

          const task = await settleContainerActionViaLane(
            lease.adminLane,
            adminApi,
            containerId,
            'stop',
            deadline,
          );
          expect(task).toEqual(
            expect.objectContaining({
              requestedBy: seedState.adminUserId,
              result: expect.objectContaining({ containerId }),
            }),
          );
          const stopped = await waitForContainerViaLane(
            lease.ownerLane,
            containerId,
            'stopped through admin exact route',
            (view) => view.runtime.status === 'exited' && view.powerIntent === 'stopped',
            deadline,
          );
          expect(stopped.ownerId).toBe(owner.user.id);
        },
      );
    },
  );

  test(
    'api.containers.admin-start-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-start',
      'api.containers.admin-start-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-start',
        async ({ owner, stranger, lease, deadline }) => {
          const containerId = lease.requireContainerId();
          const ownerStop = await settleContainerActionViaLane(
            lease.ownerLane,
            adminApi,
            containerId,
            'stop',
            deadline,
          );
          expect(ownerStop.requestedBy).toBe(owner.user.id);
          await waitForContainerViaLane(
            lease.ownerLane,
            containerId,
            'stopped before admin start',
            (view) => view.runtime.status === 'exited' && view.activeTask === null,
            deadline,
          );

          const adminPath = `${containerResourcePath('admin', containerId)}/actions/start`;
          expect((await anonymousApi.post(adminPath)).status()).toBe(401);
          expect((await owner.api.post(adminPath)).status()).toBe(403);
          expect((await stranger.api.post(adminPath)).status()).toBe(403);
          expect(
            (
              await adminApi.post(`${containerResourcePath('owner', containerId)}/actions/start`)
            ).status(),
          ).toBe(403);

          const task = await settleContainerActionViaLane(
            lease.adminLane,
            adminApi,
            containerId,
            'start',
            deadline,
          );
          expect(task.requestedBy).toBe(seedState.adminUserId);
          const running = await waitForContainerViaLane(
            lease.ownerLane,
            containerId,
            'running through admin start',
            (view) => view.runtime.status === 'running' && view.powerIntent === 'running',
            deadline,
          );
          expect(running.ownerId).toBe(owner.user.id);
        },
      );
    },
  );

  test(
    'api.containers.admin-restart-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-restart',
      'api.containers.admin-restart-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-restart',
        async ({ owner, stranger, lease, created, deadline }) => {
          const containerId = lease.requireContainerId();
          const adminPath = `${containerResourcePath('admin', containerId)}/actions/restart`;
          expect((await anonymousApi.post(adminPath)).status()).toBe(401);
          expect((await owner.api.post(adminPath)).status()).toBe(403);
          expect((await stranger.api.post(adminPath)).status()).toBe(403);
          expect(
            (
              await adminApi.post(`${containerResourcePath('owner', containerId)}/actions/restart`)
            ).status(),
          ).toBe(403);

          const task = await settleContainerActionViaLane(
            lease.adminLane,
            adminApi,
            containerId,
            'restart',
            deadline,
          );
          expect(task).toEqual(
            expect.objectContaining({
              requestedBy: seedState.adminUserId,
              result: expect.objectContaining({
                containerId,
                runtimeId: created.view.runtime.runtimeId,
                startedAt: expect.any(String),
              }),
            }),
          );
          const running = await waitForContainerViaLane(
            lease.ownerLane,
            containerId,
            'running after admin restart',
            (view) => view.runtime.status === 'running' && view.activeTask === null,
            deadline,
          );
          expect(running.ownerId).toBe(owner.user.id);
        },
      );
    },
  );

  test(
    'api.containers.admin-delete-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-delete',
      'api.containers.admin-delete-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-delete',
        async ({ owner, stranger, lease, deadline }) => {
          const containerId = lease.requireContainerId();
          const adminPath = `${containerResourcePath('admin', containerId)}/actions/delete`;
          expect((await anonymousApi.post(adminPath)).status()).toBe(401);
          expect((await owner.api.post(adminPath)).status()).toBe(403);
          expect((await stranger.api.post(adminPath)).status()).toBe(403);
          expect(
            (
              await adminApi.post(`${containerResourcePath('owner', containerId)}/actions/delete`)
            ).status(),
          ).toBe(403);

          const task = await settleContainerActionViaLane(
            lease.adminLane,
            adminApi,
            containerId,
            'delete',
            deadline,
          );
          expect(task).toEqual(
            expect.objectContaining({
              requestedBy: seedState.adminUserId,
              result: expect.objectContaining({ containerId, runtimeId: null }),
            }),
          );
          await waitForContainerAbsentViaLane(lease.adminLane, containerId, deadline);
          lease.markDeleted();
        },
      );
    },
  );

  test(
    'api.containers.admin-exec-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-exec-sessions',
      'api.containers.admin-exec-exact-contract',
    ),
    async ({ adminApi, adminSession, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-exec',
        async ({ owner, stranger, lease }) => {
          const containerId = lease.requireContainerId();
          const adminPath = `${containerResourcePath('admin', containerId)}/exec-sessions`;
          const body = { data: { shell: '/bin/sh', tty: false } };
          expect((await anonymousApi.post(adminPath, body)).status()).toBe(401);
          expect((await owner.api.post(adminPath, body)).status()).toBe(403);
          expect((await stranger.api.post(adminPath, body)).status()).toBe(403);
          expect(
            (
              await adminApi.post(
                `${containerResourcePath('owner', containerId)}/exec-sessions`,
                body,
              )
            ).status(),
          ).toBe(403);

          const session = await expectJson<ConsoleSession>(
            await adminApi.post(adminPath, body),
            201,
          );
          const marker = `admin-exec-${lease.input.name}`;
          const result = await executeThroughConsole(
            page,
            requireRuntimeEnv('E2E_BASE_URL'),
            session,
            adminSession.accessToken,
            `printf '${marker}'; exit\n`,
          );
          expect(result.exitCode).toBe(0);
          expect(result.output).toContain(marker);
        },
      );
    },
  );

  test(
    'api.containers.user-list-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.get.api-v2-containers',
      'api.containers.user-list-exact-contract',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'user-list',
        async ({ owner, stranger, lease }) => {
          const containerId = lease.requireContainerId();
          const ownerPath = `${containerCollectionPath('owner')}?serverId=${encodeURIComponent(
            seedState.servers[0].serverId,
          )}`;
          expect((await anonymousApi.get(ownerPath)).status()).toBe(401);

          const ownerContainers = await listContainersViaLane(
            ownerContainerLane(owner.api),
            seedState.servers[0].serverId,
          );
          expect(ownerContainers).toContainEqual(
            expect.objectContaining({ id: containerId, ownerId: owner.user.id }),
          );
          expect(ownerContainers.every((container) => container.ownerId === owner.user.id)).toBe(
            true,
          );
          expect(
            (
              await listContainersViaLane(
                ownerContainerLane(stranger.api),
                seedState.servers[0].serverId,
              )
            ).some((container) => container.id === containerId),
          ).toBe(false);
          expect(
            (
              await listContainersViaLane(
                ownerContainerLane(adminApi),
                seedState.servers[0].serverId,
              )
            ).some((container) => container.id === containerId),
          ).toBe(false);
          expect((await owner.api.get(containerCollectionPath('admin'))).status()).toBe(403);
          expect(
            (
              await listContainersViaLane(
                adminContainerLane(adminApi),
                seedState.servers[0].serverId,
              )
            ).some((container) => container.id === containerId),
          ).toBe(true);
        },
      );
    },
  );

  test(
    'api.containers.real-disk-limit-enforced',
    coverageCase(
      'containers.lifecycle-console.disk-limit',
      'api.containers.real-disk-limit-enforced',
    ),
    async ({ adminApi, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      const diskBytes = 32 * 1024 * 1024;
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'disk-limit',
        async ({ owner, lease, created, deadline }) => {
          expect(created.view.resources.diskBytes).toBe(diskBytes);
          expect(created.task.result).toEqual(
            expect.objectContaining({ quotaPaths: [expect.any(String), expect.any(String)] }),
          );
          const result = await executeOwnerShell(
            page,
            owner,
            lease,
            'set +e; out=$(dd if=/dev/zero of=/tmp/nyabase-disk-probe bs=1M count=64 conv=fsync 2>&1); rc=$?; printf \'RC=%s\\n%s\\n\' "$rc" "$out"; rm -f /tmp/nyabase-disk-probe; exit 0\n',
            deadline,
          );
          expect(result.exitCode).toBe(0);
          expect(result.output).toMatch(/RC=[1-9][0-9]*/);
          expect(result.output).toMatch(/No space left on device|Disk quota exceeded/i);
        },
        { ownerAccess: { diskBytes } },
      );
    },
  );

  test(
    'api.containers.mount-updates-immutable-with-real-mount',
    coverageCase(
      'containers.lifecycle-console.mount-updates',
      'api.containers.mount-updates-immutable-with-real-mount',
    ),
    async ({ adminApi, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'mount-update',
        async ({ owner, lease, created, deadline, mountLease }) => {
          expect(mountLease).not.toBeNull();
          expect(created.view.mounts).toHaveLength(1);
          expect(created.view.mounts[0]).toEqual(expect.objectContaining(mountLease!.mountInput));
          const marker = `mount-${lease.input.name}`;
          const write = await executeOwnerShell(
            page,
            owner,
            lease,
            `printf '${marker}' > '${mountLease!.containerPath}/e2e-marker'; cat '${mountLease!.containerPath}/e2e-marker'; exit\n`,
            deadline,
          );
          expect(write.exitCode).toBe(0);
          expect(write.output).toContain(marker);

          const beforeTasks = await listContainerTaskHistory(
            adminApi,
            lease.requireContainerId(),
            deadline,
          );
          await expectImmutableMountResponse(
            await owner.api.post(
              `${containerResourcePath('owner', lease.requireContainerId())}/actions/update-mounts`,
              {
                data: [],
                timeout: deadline.remaining('request immutable mount update', 30_000),
              },
            ),
          );
          const unchanged = await waitForContainerViaLane(
            lease.ownerLane,
            lease.requireContainerId(),
            'unchanged mounts after rejected update',
            (view) => JSON.stringify(view.mounts) === JSON.stringify(created.view.mounts),
            deadline,
          );
          expect(unchanged.runtime.runtimeId).toBe(created.view.runtime.runtimeId);
          const afterTasks = await listContainerTaskHistory(
            adminApi,
            lease.requireContainerId(),
            deadline,
          );
          expect(afterTasks.map((task) => task.id)).toEqual(beforeTasks.map((task) => task.id));
          const read = await executeOwnerShell(
            page,
            owner,
            lease,
            `cat '${mountLease!.containerPath}/e2e-marker'; exit\n`,
            deadline,
          );
          expect(read.exitCode).toBe(0);
          expect(read.output).toContain(marker);
        },
        { mount: { containerPath: '/data' } },
      );
    },
  );

  test(
    'api.containers.cross-user-runtime-and-api-isolation',
    coverageCase(
      'containers.lifecycle-console.cross-user-isolation',
      'api.containers.cross-user-runtime-and-api-isolation',
    ),
    async ({ adminApi, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'cross-user',
        async ({ owner, stranger, lease, newLease, deadline }) => {
          const strangerLease = newLease(stranger, 'stranger');
          const strangerCreated = await strangerLease.createRunning(deadline);
          const ownerId = lease.requireContainerId();
          const strangerId = strangerLease.requireContainerId();
          expect(strangerCreated.view.ownerId).toBe(stranger.user.id);
          expect(strangerCreated.view.runtime.runtimeId).not.toBe(lease.runtimeId);

          const ownerMarker = `owner-${lease.input.name}`;
          const strangerMarker = `stranger-${strangerLease.input.name}`;
          expect(
            (
              await executeOwnerShell(
                page,
                owner,
                lease,
                `printf '${ownerMarker}' > /tmp/nyabase-isolation; cat /tmp/nyabase-isolation; exit\n`,
                deadline,
              )
            ).output,
          ).toContain(ownerMarker);
          expect(
            (
              await executeOwnerShell(
                page,
                stranger,
                strangerLease,
                `printf '${strangerMarker}' > /tmp/nyabase-isolation; cat /tmp/nyabase-isolation; exit\n`,
                deadline,
              )
            ).output,
          ).toContain(strangerMarker);
          expect(
            (
              await executeOwnerShell(
                page,
                owner,
                lease,
                'cat /tmp/nyabase-isolation; exit\n',
                deadline,
              )
            ).output,
          ).toContain(ownerMarker);
          expect(
            (
              await executeOwnerShell(
                page,
                stranger,
                strangerLease,
                'cat /tmp/nyabase-isolation; exit\n',
                deadline,
              )
            ).output,
          ).toContain(strangerMarker);

          expect((await stranger.api.get(containerResourcePath('owner', ownerId))).status()).toBe(
            403,
          );
          expect((await owner.api.get(containerResourcePath('owner', strangerId))).status()).toBe(
            403,
          );
          expect(
            (
              await stranger.api.post(`${containerResourcePath('owner', ownerId)}/exec-sessions`, {
                data: { shell: '/bin/sh', tty: false },
              })
            ).status(),
          ).toBe(403);
          expect(
            (
              await owner.api.post(`${containerResourcePath('owner', strangerId)}/actions/restart`)
            ).status(),
          ).toBe(403);
          const ownerList = await listContainersViaLane(lease.ownerLane, undefined, deadline);
          const strangerList = await listContainersViaLane(
            strangerLease.ownerLane,
            undefined,
            deadline,
          );
          expect(ownerList.some((view) => view.id === ownerId)).toBe(true);
          expect(ownerList.some((view) => view.id === strangerId)).toBe(false);
          expect(strangerList.some((view) => view.id === strangerId)).toBe(true);
          expect(strangerList.some((view) => view.id === ownerId)).toBe(false);
          const adminList = await listContainersViaLane(
            adminContainerLane(adminApi),
            seedState.servers[0].serverId,
            deadline,
          );
          expect(adminList).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: ownerId, ownerId: owner.user.id }),
              expect.objectContaining({ id: strangerId, ownerId: stranger.user.id }),
            ]),
          );
        },
        { strangerAccess: true },
      );
    },
  );

  test(
    'api.containers.admin-update-mounts-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-update-mounts',
      'api.containers.admin-update-mounts-exact-contract',
    ),
    async ({ adminApi, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-update-mounts',
        async ({ owner, stranger, lease, created, deadline, mountLease }) => {
          expect(mountLease).not.toBeNull();
          const containerId = lease.requireContainerId();
          const adminPath = `${containerResourcePath('admin', containerId)}/actions/update-mounts`;
          const ownerPath = `${containerResourcePath('owner', containerId)}/actions/update-mounts`;
          const body = { data: [] };
          const marker = `admin-mount-${lease.input.name}`;
          const written = await executeOwnerShell(
            page,
            owner,
            lease,
            `printf '${marker}' > '${mountLease!.containerPath}/exact-marker'; exit\n`,
            deadline,
          );
          expect(written.exitCode).toBe(0);
          const beforeTasks = await listContainerTaskHistory(adminApi, containerId, deadline);

          expect((await anonymousApi.post(adminPath, body)).status()).toBe(401);
          expect((await owner.api.post(adminPath, body)).status()).toBe(403);
          expect((await stranger.api.post(adminPath, body)).status()).toBe(403);
          expect((await adminApi.post(ownerPath, body)).status()).toBe(403);
          await expectImmutableMountResponse(
            await adminApi.post(adminPath, {
              ...body,
              timeout: deadline.remaining('invoke exact admin update-mounts route', 30_000),
            }),
          );

          const readback = await waitForContainerViaLane(
            lease.adminLane,
            containerId,
            'admin rejected mount update readback',
            (view) => JSON.stringify(view.mounts) === JSON.stringify(created.view.mounts),
            deadline,
          );
          expect(readback.runtime.runtimeId).toBe(created.view.runtime.runtimeId);
          const afterTasks = await listContainerTaskHistory(adminApi, containerId, deadline);
          expect(afterTasks.map((task) => task.id)).toEqual(beforeTasks.map((task) => task.id));
          const markerRead = await executeOwnerShell(
            page,
            owner,
            lease,
            `cat '${mountLease!.containerPath}/exact-marker'; exit\n`,
            deadline,
          );
          expect(markerRead.output).toContain(marker);
        },
        { mount: { containerPath: '/data' } },
      );
    },
  );

  test(
    'api.containers.user-update-mounts-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.post.api-v2-containers-by-containerid-actions-update-mounts',
      'api.containers.user-update-mounts-exact-contract',
    ),
    async ({ adminApi, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'user-update-mounts',
        async ({ owner, stranger, lease, created, deadline, mountLease }) => {
          expect(mountLease).not.toBeNull();
          const containerId = lease.requireContainerId();
          const ownerPath = `${containerResourcePath('owner', containerId)}/actions/update-mounts`;
          const adminPath = `${containerResourcePath('admin', containerId)}/actions/update-mounts`;
          const body = { data: [] };
          const marker = `user-mount-${lease.input.name}`;
          expect(
            (
              await executeOwnerShell(
                page,
                owner,
                lease,
                `printf '${marker}' > '${mountLease!.containerPath}/exact-marker'; exit\n`,
                deadline,
              )
            ).exitCode,
          ).toBe(0);
          const beforeTasks = await listContainerTaskHistory(adminApi, containerId, deadline);

          expect((await anonymousApi.post(ownerPath, body)).status()).toBe(401);
          expect((await stranger.api.post(ownerPath, body)).status()).toBe(403);
          expect((await adminApi.post(ownerPath, body)).status()).toBe(403);
          expect((await owner.api.post(adminPath, body)).status()).toBe(403);
          await expectImmutableMountResponse(
            await owner.api.post(ownerPath, {
              ...body,
              timeout: deadline.remaining('invoke exact user update-mounts route', 30_000),
            }),
          );

          const readback = await waitForContainerViaLane(
            lease.ownerLane,
            containerId,
            'owner rejected mount update readback',
            (view) => JSON.stringify(view.mounts) === JSON.stringify(created.view.mounts),
            deadline,
          );
          expect(readback.ownerId).toBe(owner.user.id);
          const afterTasks = await listContainerTaskHistory(adminApi, containerId, deadline);
          expect(afterTasks.map((task) => task.id)).toEqual(beforeTasks.map((task) => task.id));
          const markerRead = await executeOwnerShell(
            page,
            owner,
            lease,
            `cat '${mountLease!.containerPath}/exact-marker'; exit\n`,
            deadline,
          );
          expect(markerRead.output).toContain(marker);
        },
        { mount: { containerPath: '/data' } },
      );
    },
  );

  test(
    'api.containers.ssh-key-rotation-reconciles-real-runtime',
    coverageCase(
      'containers.lifecycle-console.ssh-reconciliation',
      'api.containers.ssh-key-rotation-reconciles-real-runtime',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState, topologyProvider }) => {
      // Persona/image setup precedes the explicit 420s behavior deadline and
      // cleanup owns another 420s deadline. Preserve a separate setup margin
      // so the hard Playwright timeout cannot preempt provider cleanup.
      test.setTimeout(1_200_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'ssh-rotation',
        async ({ owner, lease, deadline }) => {
          const containerId = lease.requireContainerId();
          const initial = await waitForSshReady(lease.ownerLane, containerId, deadline);
          const keyPath = `/api/admin/users/${owner.user.id}/internal-ssh-key`;
          const before = await expectJson<{
            userId: string;
            publicKey: string;
            fingerprint: string;
            generation: number;
          }>(await adminApi.get(keyPath));
          expect(initial.ssh.appliedInternalKeyGeneration).toBe(before.generation);
          const oldTaskIds = new Set(
            (await listContainerTaskHistory(adminApi, containerId, deadline)).map(
              (task) => task.id,
            ),
          );

          const rotated = await expectJson<{
            userId: string;
            publicKey: string;
            fingerprint: string;
            generation: number;
            privateKey: string;
          }>(
            await adminApi.post(`${keyPath}/rotate`, {
              timeout: deadline.remaining(`rotate key for ${owner.user.id}`, 30_000),
            }),
            201,
          );
          expect(rotated.userId).toBe(owner.user.id);
          expect(rotated.generation).toBe(before.generation + 1);
          expect(rotated.publicKey).not.toBe(before.publicKey);
          const queued = await waitForNewContainerTask(
            adminApi,
            containerId,
            'container.ssh.ensure',
            oldTaskIds,
            deadline,
          );
          const task = await waitForAgentTask(adminApi, queued.id, {
            kind: 'container.ssh.ensure',
            resourceId: containerId,
            timeoutMs: deadline.remaining(`settle rotated SSH generation ${rotated.generation}`),
          });
          expect(task.requestedBy).toBe(owner.user.id);
          expect(task.result).toEqual(
            expect.objectContaining({
              containerId,
              runtimeId: initial.runtime.runtimeId,
              ssh: expect.objectContaining({
                enabled: true,
                appliedKeyGeneration: rotated.generation,
                hostKeyFingerprint: expect.any(String),
              }),
            }),
          );
          const converged = await waitForSshReady(
            lease.ownerLane,
            containerId,
            deadline,
            rotated.generation,
          );
          expect(converged.runtime.runtimeId).toBe(initial.runtime.runtimeId);
          const node = seedState.servers.find(
            (candidate) => candidate.serverId === converged.serverId,
          );
          if (!node) throw new Error(`SSH target belongs to unknown Server ${converged.serverId}`);
          const runtimeId = converged.runtime.runtimeId;
          const expectedIp = converged.runtime.ip;
          const expectedHostKeyFingerprint = converged.ssh.hostKeyFingerprint;
          if (!runtimeId || !expectedIp || !expectedHostKeyFingerprint) {
            throw new Error(`Container ${containerId} lacks exact SSH runtime evidence`);
          }
          const marker = `ssh-${randomUUID()}`;
          let rotatedPrivateKey: string | null = rotated.privateKey;
          rotated.privateKey = '';
          try {
            const proof = await probeContainerSsh(topologyProvider, {
              runId: seedState.runId,
              nodeKey: node.key,
              containerId,
              runtimeId,
              expectedIp,
              expectedHostKeyFingerprint,
              expectedClientKeyFingerprint: rotated.fingerprint,
              privateKey: rotatedPrivateKey,
              marker,
            });
            expect(proof).toEqual(
              expect.objectContaining({
                runId: seedState.runId,
                nodeKey: node.key,
                serverId: converged.serverId,
                containerId,
                runtimeId,
                targetIp: expectedIp,
                remoteUser: 'root',
                remotePort: 22,
                clientKeyFingerprint: rotated.fingerprint,
                hostKeyFingerprint: expectedHostKeyFingerprint,
                marker,
                authenticated: true,
                privateKeyMode: '600',
                privateKeyRemoved: true,
              }),
            );
          } finally {
            rotatedPrivateKey = null;
          }
        },
        { sshEnabledImage: true, operationTimeoutMs: 420_000, cleanupTimeoutMs: 420_000 },
      );
    },
  );

  test(
    'api.containers.admin-reconcile-ssh-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.post.api-admin-v2-containers-by-containerid-actions-reconcile-ssh',
      'api.containers.admin-reconcile-ssh-exact-contract',
    ),
    async ({ adminApi, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(900_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'admin-reconcile-ssh',
        async ({ owner, stranger, lease, deadline }) => {
          const containerId = lease.requireContainerId();
          const initial = await waitForSshReady(lease.ownerLane, containerId, deadline);
          const adminPath = `${containerResourcePath('admin', containerId)}/actions/reconcile-ssh`;
          const ownerPath = `${containerResourcePath('owner', containerId)}/actions/reconcile-ssh`;
          expect((await anonymousApi.post(adminPath)).status()).toBe(401);
          expect((await owner.api.post(adminPath)).status()).toBe(403);
          expect((await stranger.api.post(adminPath)).status()).toBe(403);
          expect((await adminApi.post(ownerPath)).status()).toBe(403);

          const task = await settleContainerActionViaLane(
            lease.adminLane,
            adminApi,
            containerId,
            'reconcile-ssh',
            deadline,
          );
          expect(task).toEqual(
            expect.objectContaining({
              requestedBy: seedState.adminUserId,
              result: expect.objectContaining({
                containerId,
                runtimeId: initial.runtime.runtimeId,
                ssh: expect.objectContaining({ enabled: true }),
              }),
            }),
          );
          const reconciled = await waitForSshReady(
            lease.adminLane,
            containerId,
            deadline,
            initial.ssh.appliedInternalKeyGeneration ?? undefined,
          );
          expect(reconciled.ownerId).toBe(owner.user.id);
          const marker = `admin-reconcile-${lease.input.name}`;
          const consoleResult = await executeOwnerShell(
            page,
            owner,
            lease,
            `printf '${marker}'; exit\n`,
            deadline,
          );
          expect(consoleResult.output).toContain(marker);
        },
        { sshEnabledImage: true, operationTimeoutMs: 420_000, cleanupTimeoutMs: 420_000 },
      );
    },
  );

  test(
    'api.containers.user-reconcile-ssh-exact-contract',
    coverageCase(
      'containers.lifecycle-console.http.post.api-v2-containers-by-containerid-actions-reconcile-ssh',
      'api.containers.user-reconcile-ssh-exact-contract',
    ),
    async ({ adminApi, anonymousApi, page, trackedApiFactory, seedState }) => {
      test.setTimeout(900_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'user-reconcile-ssh',
        async ({ owner, stranger, lease, deadline }) => {
          const containerId = lease.requireContainerId();
          const initial = await waitForSshReady(lease.ownerLane, containerId, deadline);
          const ownerPath = `${containerResourcePath('owner', containerId)}/actions/reconcile-ssh`;
          const adminPath = `${containerResourcePath('admin', containerId)}/actions/reconcile-ssh`;
          expect((await anonymousApi.post(ownerPath)).status()).toBe(401);
          expect((await stranger.api.post(ownerPath)).status()).toBe(403);
          expect((await adminApi.post(ownerPath)).status()).toBe(403);
          expect((await owner.api.post(adminPath)).status()).toBe(403);

          const task = await settleContainerActionViaLane(
            lease.ownerLane,
            adminApi,
            containerId,
            'reconcile-ssh',
            deadline,
          );
          expect(task).toEqual(
            expect.objectContaining({
              requestedBy: owner.user.id,
              result: expect.objectContaining({
                containerId,
                runtimeId: initial.runtime.runtimeId,
                ssh: expect.objectContaining({ enabled: true }),
              }),
            }),
          );
          const reconciled = await waitForSshReady(
            lease.ownerLane,
            containerId,
            deadline,
            initial.ssh.appliedInternalKeyGeneration ?? undefined,
          );
          expect(reconciled.ownerId).toBe(owner.user.id);
          const marker = `user-reconcile-${lease.input.name}`;
          const consoleResult = await executeOwnerShell(
            page,
            owner,
            lease,
            `printf '${marker}'; exit\n`,
            deadline,
          );
          expect(consoleResult.output).toContain(marker);
        },
        { sshEnabledImage: true, operationTimeoutMs: 420_000, cleanupTimeoutMs: 420_000 },
      );
    },
  );

  test(
    'api.containers.runtime-drift-detected-after-exact-provider-removal',
    coverageCase(
      'containers.lifecycle-console.runtime-drift',
      'api.containers.runtime-drift-detected-after-exact-provider-removal',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState, topologyProvider }) => {
      test.setTimeout(720_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'runtime-drift',
        async ({ owner, lease, created, deadline }) => {
          const containerId = lease.requireContainerId();
          const runtimeId = created.view.runtime.runtimeId;
          if (!runtimeId) throw new Error(`Container ${containerId} has no exact runtime identity`);
          const node = seedState.servers.find(
            (server) => server.serverId === created.view.serverId,
          );
          if (!node) throw new Error(`Container ${containerId} belongs to an unknown seed node`);
          const beforeTasks = await listContainerTaskHistory(adminApi, containerId, deadline);

          const removed = await controlProviderFault(topologyProvider, {
            fault: 'containerRuntimeDrift',
            runId: seedState.runId,
            nodeKey: node.key,
            action: 'remove',
            containerId,
            runtimeId,
          });
          expect(removed).toEqual(
            expect.objectContaining({
              serverId: created.view.serverId,
              containerId,
              runtimeId,
              physicalAbsent: true,
            }),
          );
          const probe = await controlProviderFault(topologyProvider, {
            fault: 'containerRuntimeDrift',
            runId: seedState.runId,
            nodeKey: node.key,
            action: 'probe',
            containerId,
            runtimeId,
          });
          expect(probe.physicalAbsent).toBe(true);
          expect(probe.serverId).toBe(created.view.serverId);

          const reconciled = await waitForContainerViaLane(
            lease.adminLane,
            containerId,
            'durable runtime_missing reconciliation after authoritative Agent report',
            (view) =>
              view.failureCode === 'runtime_missing' &&
              view.activeTask === null &&
              view.runtime.runtimeId === runtimeId &&
              view.runtime.status === 'unknown' &&
              view.actions.delete?.enabled === true &&
              view.actions.console?.enabled === false,
            deadline,
          );
          expect(reconciled.failureReason).toBe(
            'The container operation failed; retry it or contact an administrator',
          );
          expect(reconciled.failureReason).not.toContain(runtimeId);
          expect(reconciled.runtime.status).toBe('unknown');
          expect(reconciled.actions.start?.enabled).toBe(false);
          expect(reconciled.actions.stop?.enabled).toBe(false);
          expect(reconciled.actions.restart?.enabled).toBe(false);
          const deniedConsole = await owner.api.post(
            `${containerResourcePath('owner', containerId)}/exec-sessions`,
            {
              data: { shell: '/bin/sh', tty: false },
              timeout: deadline.remaining('prove Console fails closed after runtime drift', 30_000),
            },
          );
          expect(deniedConsole.status()).toBe(403);
          const afterReconcileTasks = await listContainerTaskHistory(
            adminApi,
            containerId,
            deadline,
          );
          expect(afterReconcileTasks.map((task) => task.id)).toEqual(
            beforeTasks.map((task) => task.id),
          );

          const deletion = await lease.cleanup(deadline);
          expect(deletion).toEqual(
            expect.objectContaining({
              kind: 'container.delete',
              requestedBy: owner.user.id,
              result: expect.objectContaining({
                containerId,
                runtimeId: null,
                quotaPaths: [expect.any(String), expect.any(String)],
              }),
            }),
          );
          expect(
            await controlProviderFault(topologyProvider, {
              fault: 'containerRuntimeDrift',
              runId: seedState.runId,
              nodeKey: node.key,
              action: 'probe',
              containerId,
              runtimeId,
            }),
          ).toEqual(expect.objectContaining({ physicalAbsent: true }));
        },
        { operationTimeoutMs: 420_000, cleanupTimeoutMs: 300_000 },
      );
    },
  );

  test(
    'api.containers.name-and-capacity-conflicts @slow',
    coverageCase(
      'containers.lifecycle-console.name-and-capacity-conflicts',
      'api.containers.name-and-capacity-conflicts',
    ),
    async ({ adminApi, anonymousApi, trackedApiFactory, seedState, topologyProvider }) => {
      test.setTimeout(2_100_000);
      await withContainerScenario(
        { adminApi, anonymousApi, trackedApiFactory, seedState },
        'name-capacity',
        async ({ owner, lease, created, newLease, deadline }) => {
          const server = seedState.servers[0];
          const serverId = server.serverId;
          const initialId = lease.requireContainerId();
          const initialInventory = await listContainersViaLane(
            adminContainerLane(adminApi),
            serverId,
            deadline,
          );
          expect(initialInventory).toHaveLength(1);
          expect(initialInventory[0].id).toBe(initialId);

          const duplicate = await owner.api.post(containerCollectionPath('owner'), {
            data: {
              serverId,
              imageId: lease.input.imageId,
              name: lease.input.name,
            },
            timeout: deadline.remaining('submit duplicate container name', 30_000),
          });
          expect(duplicate.status()).toBe(409);
          const duplicateBody = await expectJson<{ message: string }>(duplicate, 409);
          expect(duplicateBody.message).toMatch(/name|already exists/i);
          expect(
            (await listContainersViaLane(adminContainerLane(adminApi), serverId, deadline)).map(
              (container) => container.id,
            ),
          ).toEqual([initialId]);

          const additional: ContainerLease[] = [];
          const createTasks: AgentTaskView[] = [];
          for (let index = 1; index < 64; index += 1) {
            const next = newLease(owner, `capacity-${index}`);
            additional.push(next);
            const running = await next.createRunning(deadline);
            createTasks.push(running.task);
          }
          expect(createTasks).toHaveLength(63);
          expect(createTasks.every((task) => task.kind === 'container.create')).toBe(true);
          expect(createTasks.every((task) => task.status === 'succeeded')).toBe(true);
          expect(
            createTasks.every(
              (task) =>
                typeof (task.result as { runtimeId?: unknown } | null)?.runtimeId === 'string',
            ),
          ).toBe(true);

          const expectedIds = new Set([
            initialId,
            ...additional.map((candidate) => candidate.requireContainerId()),
          ]);
          expect(expectedIds.size).toBe(64);
          const realInventory = await waitForRealContainerSet(
            adminApi,
            serverId,
            expectedIds,
            deadline,
          );
          expect(realInventory).toHaveLength(64);
          expect(new Set(realInventory.map((container) => container.ownerId))).toEqual(
            new Set([owner.user.id]),
          );

          const expectedCreateTaskIds = new Set([
            created.task.id,
            ...createTasks.map((task) => task.id),
          ]);
          expect(expectedCreateTaskIds.size).toBe(64);
          const beforeRejection = await captureContainerCapacitySnapshot(
            adminApi,
            topologyProvider,
            seedState.runId,
            serverId,
            server.key,
            deadline,
          );
          expect(beforeRejection.containerIds).toEqual([...expectedIds].sort());
          const expectedRuntimeIds = realInventory
            .map((container) => container.runtime.runtimeId!)
            .sort();
          expect(beforeRejection.productRuntimeIds).toEqual(expectedRuntimeIds);
          expect(beforeRejection.activeRuntimeIds).toEqual(expectedRuntimeIds);
          expect(beforeRejection.allRuntimeIds).toEqual(expectedRuntimeIds);
          const observedCreateTasks = beforeRejection.tasks.filter((task) =>
            expectedCreateTaskIds.has(task.id),
          );
          expect(new Set(observedCreateTasks.map((task) => task.id))).toEqual(
            expectedCreateTaskIds,
          );
          expect(
            observedCreateTasks.every(
              (task) =>
                task.kind === 'container.create' &&
                task.status === 'succeeded' &&
                expectedIds.has(task.resourceId) &&
                task.serverId === serverId,
            ),
          ).toBe(true);
          const beforeRuntimeObservedAt = await getServerRuntimeObservedAt(
            adminApi,
            serverId,
            deadline,
          );

          const rejectedName = uniqueContainerLeaseName('capacity-65');
          const overCapacity = await owner.api.post(containerCollectionPath('owner'), {
            data: {
              serverId,
              imageId: lease.input.imageId,
              name: rejectedName,
            },
            timeout: deadline.remaining('submit sixty-fifth managed container', 30_000),
          });
          expect(overCapacity.status()).toBe(409);
          const capacityBody = await expectJson<{ code: string; message: string }>(
            overCapacity,
            409,
          );
          expect(capacityBody.code).toBe('SERVER_CONTAINER_CAPACITY_REACHED');
          expect(capacityBody.message).toContain('64');

          const immediatelyAfter = await captureContainerCapacitySnapshot(
            adminApi,
            topologyProvider,
            seedState.runId,
            serverId,
            server.key,
            deadline,
          );
          expectCapacitySnapshotUnchanged(
            beforeRejection,
            immediatelyAfter,
            'immediately after capacity rejection',
          );

          const firstRuntimeObservedAt = await waitForServerRuntimeObservationAdvance(
            adminApi,
            serverId,
            beforeRuntimeObservedAt,
            deadline,
          );
          const afterFirstAuthoritativeReport = await captureContainerCapacitySnapshot(
            adminApi,
            topologyProvider,
            seedState.runId,
            serverId,
            server.key,
            deadline,
          );
          expectCapacitySnapshotUnchanged(
            beforeRejection,
            afterFirstAuthoritativeReport,
            'after first authoritative runtime report',
          );

          await waitForServerRuntimeObservationAdvance(
            adminApi,
            serverId,
            firstRuntimeObservedAt,
            deadline,
          );
          const afterSecondAuthoritativeReport = await captureContainerCapacitySnapshot(
            adminApi,
            topologyProvider,
            seedState.runId,
            serverId,
            server.key,
            deadline,
          );
          expectCapacitySnapshotUnchanged(
            beforeRejection,
            afterSecondAuthoritativeReport,
            'after second authoritative runtime report',
          );
          expect(
            (await listContainersViaLane(adminContainerLane(adminApi), serverId, deadline)).some(
              (container) => container.name === rejectedName,
            ),
          ).toBe(false);
        },
        {
          operationTimeoutMs: 900_000,
          cleanupTimeoutMs: 780_000,
        },
      );
    },
  );

  test(
    'api.containers.cpu-scope-rejects-gpu-create-field',
    coverageCase(
      'containers.lifecycle-console.gpu-field-rejected-cpu-scope',
      'api.containers.cpu-scope-rejects-gpu-create-field',
    ),
    async ({ adminApi }) => {
      const response = await adminApi.post('/api/v2/containers', {
        data: {
          serverId: 'not-selected-before-validation',
          imageId: 'not-selected-before-validation',
          name: 'gpu-request-must-fail',
          gpuIndices: [0],
        },
      });
      expect(response.status()).toBe(400);
      const body = await response.text();
      expect(body).toContain('gpuIndices');
    },
  );
});

async function settleAction(
  api: Parameters<typeof requestContainerAction>[0],
  containerId: string,
  action: 'start' | 'stop' | 'restart',
  kind: string,
): Promise<AgentTaskView> {
  const ref = await requestContainerAction(api, containerId, action);
  return waitForAgentTask(api, ref.taskId, { kind, resourceId: containerId });
}
