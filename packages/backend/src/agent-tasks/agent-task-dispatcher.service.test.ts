import {
  AgentTaskKind,
  AgentTaskStatus,
  ServerStatus,
  canonicalJson,
  zCreateContainerRequest,
} from '@nyabase/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import {
  AgentTaskDispatcherService,
  type AgentTaskTransport,
} from './agent-task-dispatcher.service.js';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';
import {
  AgentTasksService,
  MAX_AGENT_TASK_REQUEST_BYTES,
  MAX_AGENT_TASK_WIRE_BYTES,
  MIN_AGENT_TASK_DISPATCH_DEFER_MS,
} from './agent-tasks.service.js';
import { ResourceKeyService } from './resource-key.service.js';
import { ResourceLockService } from './resource-lock.service.js';
import type { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';

describe('AgentTaskDispatcherService', () => {
  let dataSource: DataSource;
  let tasks: AgentTasksService;
  let dispatcher: AgentTaskDispatcherService;
  let onlineServerIds: string[];
  let send: ReturnType<typeof vi.fn<AgentTaskTransport['send']>>;
  let blockServer: ReturnType<typeof vi.fn>;
  let poisonTaskIds: Set<string>;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [ServerEntity, AgentTaskEntity, ResourceLockEntity],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save([
      {
        id: 'server-a', name: 'Server A', slug: 'server-a', agentTokenHash: 'token-a',
        hostFingerprint: null, agentConfigFingerprint: null,
        status: ServerStatus.Online, lastSeenAt: null,
      },
      {
        id: 'server-b', name: 'Server B', slug: 'server-b', agentTokenHash: 'token-b',
        hostFingerprint: null, agentConfigFingerprint: null,
        status: ServerStatus.Online, lastSeenAt: null,
      },
    ]);
    const taskRepo = dataSource.getRepository(AgentTaskEntity);
    const locks = new ResourceLockService(dataSource.getRepository(ResourceLockEntity));
    blockServer = vi.fn();
    poisonTaskIds = new Set();
    const payloadCodec = {
      forWirePayload: (_kind: AgentTaskKind, payload: unknown) => payload,
      forDispatch: (task: AgentTaskEntity) => {
        if (poisonTaskIds.has(task.id)) throw new Error('cannot decrypt payload');
        return task.payloadJson;
      },
    } as AgentTaskPayloadCodecService;
    tasks = new AgentTasksService(
      dataSource,
      new ResourceKeyService(),
      locks,
      payloadCodec,
      taskRepo,
      { blockServer } as unknown as ProxySnapshotNotifierService,
    );
    dispatcher = new AgentTaskDispatcherService(tasks);
    onlineServerIds = [];
    send = vi.fn<AgentTaskTransport['send']>();
    setTransport(dispatcher, {
      onlineServerIds: () => onlineServerIds,
      send,
    });
  });

  afterEach(async () => {
    dispatcher.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('keeps an offline-server task pending and unsent until that server is online', async () => {
    const taskId = await enqueueImageTask(tasks);

    await expect(dispatcher.process()).resolves.toBe(0);

    expect(send).not.toHaveBeenCalled();
    expect(await loadTask(dataSource, taskId)).toMatchObject({
      status: AgentTaskStatus.Pending,
      startedAt: null,
      lastSentAt: null,
    });
    expect(await lockCount(dataSource, taskId)).toBe(1);

    onlineServerIds = ['server-a'];
    await expect(dispatcher.process()).resolves.toBe(1);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('server-a', expect.objectContaining({
      taskId,
      kind: AgentTaskKind.ImageEnsurePresent,
      payload: { dockerRef: 'example.invalid/image:a' },
    }));
    expect(await loadTask(dataSource, taskId)).toMatchObject({
      status: AgentTaskStatus.Pending,
      startedAt: expect.any(Date),
      lastSentAt: expect.any(Date),
    });
    expect(await lockCount(dataSource, taskId)).toBe(1);
  });

  it('rejects an oversized wire payload before creating a task or resource lock', async () => {
    await expect(enqueueImageTask(tasks, 'image-large', 'x'.repeat(MAX_AGENT_TASK_WIRE_BYTES + 1)))
      .rejects.toMatchObject({ response: { code: 'AGENT_TASK_PAYLOAD_TOO_LARGE' } });
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(0);
    expect(await dataSource.getRepository(ResourceLockEntity).count()).toBe(0);
  });

  it('accepts maximum-shape create-container request metadata within the 1 MiB bound', async () => {
    const request = zCreateContainerRequest.parse({
      serverId: 'server-a',
      imageId: 'image-a',
      name: 'large-request',
      dataDirs: Array.from({ length: 64 }, (_, index) => ({
        sourceKind: 'remote' as const,
        sourceId: `source-${index}-${'s'.repeat(110)}`,
        dirName: `dir-${index}-${'d'.repeat(50)}`,
        containerPath: `/${'p'.repeat(4095)}`,
      })),
    });
    const requestBytes = Buffer.byteLength(canonicalJson(request));
    expect(requestBytes).toBeGreaterThan(64 * 1024);
    expect(requestBytes).toBeLessThanOrEqual(MAX_AGENT_TASK_REQUEST_BYTES);

    const created = await tasks.enqueue({
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: 'server-a',
      resourceType: 'image',
      resourceId: 'image-large-request',
      requestedBy: 'user-a',
      request,
      payload: { dockerRef: 'example.invalid/image:large-request' },
    });

    expect(await loadTask(dataSource, created.taskId)).toMatchObject({ requestJson: request });
    expect(await lockCount(dataSource, created.taskId)).toBe(1);
  });

  it('rejects oversized or cyclic request metadata before creating durable rows', async () => {
    const enqueue = (request: unknown) => tasks.enqueue({
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: 'server-a',
      resourceType: 'image',
      resourceId: 'image-request-boundary',
      requestedBy: 'user-a',
      request,
      payload: { dockerRef: 'example.invalid/image:request-boundary' },
    });

    await expect(enqueue({ diagnostic: 'x'.repeat(MAX_AGENT_TASK_REQUEST_BYTES + 1) }))
      .rejects.toMatchObject({ response: { code: 'AGENT_TASK_REQUEST_TOO_LARGE' } });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(enqueue(cyclic))
      .rejects.toMatchObject({ response: { code: 'INVALID_AGENT_TASK_REQUEST' } });

    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(0);
    expect(await dataSource.getRepository(ResourceLockEntity).count()).toBe(0);
  });

  it('bounds staged and deferred diagnostic messages in durable task JSON', async () => {
    const stagedTaskId = await enqueueImageTask(tasks, 'image-staged-diagnostic');
    await expect(tasks.stageNeverDispatchedPayloadFailure(
      stagedTaskId,
      new Error('s'.repeat(16_384)),
    )).resolves.toBe(true);
    const staged = await loadTask(dataSource, stagedTaskId);
    expect((staged.errorJson as { message: string }).message).toHaveLength(2_048);
    expect((staged.agentResultJson as { error: { message: string } }).error.message)
      .toHaveLength(2_048);

    const deferredTaskId = await enqueueImageTask(tasks, 'image-deferred-diagnostic');
    await tasks.deferDispatchFailure(deferredTaskId, {
      toString: () => 'd'.repeat(16_384),
    });
    const deferred = await loadTask(dataSource, deferredTaskId);
    expect((deferred.errorJson as { message: string }).message).toHaveLength(2_048);
  });

  it('resends the same pending task identity after the resend cutoff without creating a new task', async () => {
    const taskId = await enqueueImageTask(tasks);
    onlineServerIds = ['server-a'];

    await expect(dispatcher.process()).resolves.toBe(1);
    const firstPayload = send.mock.calls[0]?.[1];

    await expect(dispatcher.process()).resolves.toBe(0);
    expect(send).toHaveBeenCalledTimes(1);

    await dataSource.getRepository(AgentTaskEntity).update(taskId, {
      lastSentAt: new Date(Date.now() - 6_000),
    });
    await expect(dispatcher.process()).resolves.toBe(1);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toEqual(firstPayload);
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(1);
    expect(await loadTask(dataSource, taskId)).toMatchObject({
      status: AgentTaskStatus.Pending,
    });
    expect(await lockCount(dataSource, taskId)).toBe(1);
  });

  it('leaves a failed send pending and retries it after the resend cutoff', async () => {
    const taskId = await enqueueImageTask(tasks);
    onlineServerIds = ['server-a'];
    send.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });

    await expect(dispatcher.process()).resolves.toBe(0);

    expect(await loadTask(dataSource, taskId)).toMatchObject({
      status: AgentTaskStatus.Pending,
      lastSentAt: expect.any(Date),
    });
    expect(await lockCount(dataSource, taskId)).toBe(1);

    await dataSource.getRepository(AgentTaskEntity).update(taskId, {
      lastSentAt: new Date(Date.now() - 6_000),
    });
    await expect(dispatcher.process()).resolves.toBe(1);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBe('server-a');
    expect(send.mock.calls[1]?.[1]).toMatchObject({ taskId });
    expect(await loadTask(dataSource, taskId)).toMatchObject({
      status: AgentTaskStatus.Pending,
    });
  });

  it('never physically redispatches a pending task with a staged terminal outcome', async () => {
    const taskId = await enqueueImageTask(tasks);
    onlineServerIds = ['server-a'];
    await dataSource.getRepository(AgentTaskEntity).update(taskId, {
      agentResultJson: { status: 'succeeded', result: { imageId: 'sha256:a' } },
      lastSentAt: new Date(Date.now() - 60_000),
    });

    await expect(dispatcher.process()).resolves.toBe(0);

    expect(send).not.toHaveBeenCalled();
    expect(await loadTask(dataSource, taskId)).toMatchObject({
      status: AgentTaskStatus.Pending,
      agentResultJson: { status: 'succeeded', result: { imageId: 'sha256:a' } },
    });
    expect(await lockCount(dataSource, taskId)).toBe(1);
  });

  it('keeps at most one physically active task per server', async () => {
    const firstTaskId = await enqueueImageTask(tasks, 'image-first', 'example.invalid/first:latest');
    const secondTaskId = await enqueueImageTask(tasks, 'image-second', 'example.invalid/second:latest');
    onlineServerIds = ['server-a'];

    await expect(dispatcher.process()).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const activeTaskId = send.mock.calls[0]?.[1].taskId;
    expect([firstTaskId, secondTaskId]).toContain(activeTaskId);
    await expect(dispatcher.process()).resolves.toBe(0);

    await dataSource.getRepository(AgentTaskEntity).update(activeTaskId!, {
      agentResultJson: { status: 'succeeded', result: { imageId: 'sha256:first' } },
    });
    await expect(dispatcher.process()).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1].taskId).toBe(
      activeTaskId === firstTaskId ? secondTaskId : firstTaskId,
    );
  });

  it('durably quarantines duplicate physical owners and retains their tasks and locks', async () => {
    const firstTaskId = await enqueueImageTask(tasks, 'image-first', 'example.invalid/first:latest');
    const secondTaskId = await enqueueImageTask(tasks, 'image-second', 'example.invalid/second:latest');
    const sentAt = new Date(Date.now() - 10_000);
    await dataSource.getRepository(AgentTaskEntity).update(
      [firstTaskId, secondTaskId],
      { startedAt: sentAt, lastSentAt: sentAt, dispatchAttemptCount: 1 },
    );
    onlineServerIds = ['server-a'];

    await expect(dispatcher.process()).resolves.toBe(0);

    expect(send).not.toHaveBeenCalled();
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: 'server-a' }))
      .toMatchObject({
        status: ServerStatus.AgentQuarantined,
        quarantineCode: 'AGENT_TASK_FAIL_STOP',
        quarantineMessage: expect.stringContaining('physical execution slot'),
      });
    expect(await loadTask(dataSource, firstTaskId)).toMatchObject({
      status: AgentTaskStatus.Pending,
      lastSentAt: sentAt,
    });
    expect(await loadTask(dataSource, secondTaskId)).toMatchObject({
      status: AgentTaskStatus.Pending,
      lastSentAt: sentAt,
    });
    expect(await lockCount(dataSource, firstTaskId)).toBe(1);
    expect(await lockCount(dataSource, secondTaskId)).toBe(1);
    expect(blockServer).toHaveBeenCalledOnce();
    expect(blockServer).toHaveBeenCalledWith(
      'server-a',
      expect.stringContaining('duplicate Agent physical task owners'),
    );
  });

  it('does not quarantine a server when dispatch selection has a transient database failure', async () => {
    onlineServerIds = ['server-a'];
    vi.spyOn(tasks, 'nextDueForDispatch').mockRejectedValueOnce(new Error('database busy'));

    await expect(dispatcher.process()).resolves.toBe(0);

    expect(send).not.toHaveBeenCalled();
    expect(blockServer).not.toHaveBeenCalled();
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: 'server-a' }))
      .toMatchObject({ status: ServerStatus.Online, quarantineCode: null });
  });

  it('dispatches safety convergence before an older ordinary intent', async () => {
    const ordinaryTaskId = await enqueueImageTask(
      tasks,
      'image-ordinary',
      'example.invalid/ordinary:latest',
    );
    const safetyTaskId = (await tasks.enqueue({
      kind: AgentTaskKind.ImageEnsureAbsent,
      serverId: 'server-a',
      resourceType: 'image',
      resourceId: 'image-safety',
      requestedBy: null,
      payload: {
        imageId: 'image-safety',
        dockerRef: 'example.invalid/safety:latest',
      },
      admissionClass: 'safety',
    })).taskId;
    onlineServerIds = ['server-a'];

    await expect(dispatcher.process()).resolves.toBe(1);

    expect(send).toHaveBeenCalledWith('server-a', expect.objectContaining({
      taskId: safetyTaskId,
      kind: AgentTaskKind.ImageEnsureAbsent,
    }));
    expect(await loadTask(dataSource, ordinaryTaskId)).toMatchObject({ startedAt: null });
  });

  it('lets a later safety cleanup pass an older activation frozen at the next worker tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
    const activationTaskId = (await tasks.enqueue({
      kind: AgentTaskKind.ContainerStart,
      serverId: 'server-a',
      resourceType: 'container',
      resourceId: 'container-a',
      requestedBy: null,
      payload: {
        containerId: 'container-a',
        runtimeId: 'runtime-a',
        dockerRoot: '/var/lib/nyabase-docker',
        quotaGeneration: 1,
        numericOwnerId: 42,
        diskBytes: 1024,
        quotaPaths: [
          '/var/lib/nyabase-docker/overlay/upper-a',
          '/var/lib/nyabase-docker/overlay/work-a',
        ],
        mounts: [],
      },
      admissionClass: 'safety',
    })).taskId;
    const cleanupTaskId = (await tasks.enqueue({
      kind: AgentTaskKind.ContainerRuntimeAbsent,
      serverId: 'server-a',
      resourceType: 'container_runtime',
      resourceId: 'runtime-extra',
      requestedBy: null,
      payload: {
        runtimeId: 'runtime-extra',
        containerId: 'container-extra',
        serverId: 'server-a',
        specGeneration: '1',
        runtimeSpecHash: 'a'.repeat(64),
        quotaPaths: [
          '/var/lib/nyabase-docker/overlay/upper-extra',
          '/var/lib/nyabase-docker/overlay/work-extra',
        ],
        observedIp: '10.0.0.2',
      },
      admissionClass: 'safety',
    })).taskId;
    onlineServerIds = ['server-a'];

    await expect(dispatcher.process()).resolves.toBe(0);
    const frozen = await loadTask(dataSource, activationTaskId);
    expect(frozen).toMatchObject({
      startedAt: null,
      errorJson: expect.objectContaining({ code: 'NETWORK_ACTIVATION_FROZEN' }),
    });
    expect(frozen.nextDispatchAt?.getTime()).toBe(
      Date.now() + MIN_AGENT_TASK_DISPATCH_DEFER_MS,
    );

    vi.advanceTimersByTime(1_000);
    await expect(dispatcher.process()).resolves.toBe(1);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('server-a', expect.objectContaining({
      taskId: cleanupTaskId,
      kind: AgentTaskKind.ContainerRuntimeAbsent,
    }));
    expect(await loadTask(dataSource, activationTaskId)).toMatchObject({ startedAt: null });
  });

  it('lets a later task pass an older generic dispatch failure at the next worker tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
    const deferredTaskId = await enqueueImageTask(
      tasks,
      'image-deferred',
      'example.invalid/deferred:latest',
    );
    const nextTaskId = await enqueueImageTask(
      tasks,
      'image-next',
      'example.invalid/next:latest',
    );
    await tasks.deferDispatchFailure(deferredTaskId, new Error('temporary key service outage'));
    const deferred = await loadTask(dataSource, deferredTaskId);
    expect(deferred).toMatchObject({
      startedAt: null,
      dispatchAttemptCount: 1,
      errorJson: expect.objectContaining({ code: 'DISPATCH_RETRY_PENDING' }),
    });
    expect(deferred.nextDispatchAt?.getTime()).toBe(
      Date.now() + MIN_AGENT_TASK_DISPATCH_DEFER_MS,
    );
    onlineServerIds = ['server-a'];

    vi.advanceTimersByTime(1_000);
    await expect(dispatcher.process()).resolves.toBe(1);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('server-a', expect.objectContaining({
      taskId: nextTaskId,
      kind: AgentTaskKind.ImageEnsurePresent,
    }));
    expect(await loadTask(dataSource, deferredTaskId)).toMatchObject({ startedAt: null });
  });

  it('dispatches one highest-priority task per server despite another server having 1024 older safety tasks', async () => {
    await insertSafetyBacklog(dataSource, 'server-a', 1_024);
    const serverBTaskId = (await tasks.enqueue({
      kind: AgentTaskKind.ImageEnsureAbsent,
      serverId: 'server-b',
      resourceType: 'image',
      resourceId: 'image-server-b',
      requestedBy: null,
      payload: {
        imageId: 'image-server-b',
        dockerRef: 'example.invalid/server-b:latest',
      },
      admissionClass: 'safety',
    })).taskId;
    onlineServerIds = ['server-a', 'server-b'];
    const selection = vi.spyOn(tasks, 'nextDueForDispatch');

    await expect(dispatcher.process()).resolves.toBe(2);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([serverId]) => serverId)).toEqual(['server-a', 'server-b']);
    expect(send).toHaveBeenCalledWith('server-b', expect.objectContaining({
      taskId: serverBTaskId,
      kind: AgentTaskKind.ImageEnsureAbsent,
    }));
    expect(send.mock.calls.filter(([serverId]) => serverId === 'server-a')).toHaveLength(1);

    const sentTaskIds = send.mock.calls.map(([, payload]) => payload.taskId);
    await dataSource.getRepository(AgentTaskEntity).update(sentTaskIds, {
      agentResultJson: { status: 'succeeded', result: { imageId: null } },
    });
    selection.mockClear();
    send.mockClear();

    await expect(dispatcher.process()).resolves.toBe(1);

    expect(selection.mock.calls.map(([serverId]) => serverId)).toEqual(['server-b', 'server-a']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe('server-a');
  });

  it('isolates one poison payload per server round and eventually dispatches the next valid task', async () => {
    for (let index = 0; index < 32; index += 1) {
      const taskId = await enqueueImageTask(
        tasks,
        `image-poison-${index}`,
        `example.invalid/poison:${index}`,
      );
      poisonTaskIds.add(taskId);
    }
    const healthyTaskId = await enqueueImageTask(
      tasks,
      'image-healthy',
      'example.invalid/healthy:latest',
    );
    onlineServerIds = ['server-a'];

    for (let index = 0; index < 32; index += 1) {
      await expect(dispatcher.process()).resolves.toBe(0);
    }
    await expect(dispatcher.process()).resolves.toBe(1);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('server-a', expect.objectContaining({
      taskId: healthyTaskId,
      payload: { dockerRef: 'example.invalid/healthy:latest' },
    }));
    const poison = (await dataSource.getRepository(AgentTaskEntity).find())
      .find((task) => poisonTaskIds.has(task.id) && task.agentResultJson !== null);
    expect(poison).toBeDefined();
    expect(poison).toMatchObject({
      status: AgentTaskStatus.Pending,
      lastSentAt: null,
      nextDispatchAt: null,
      failureStage: 'dispatch',
      agentResultJson: {
        status: 'failed',
        error: {
          code: 'DISPATCH_PAYLOAD_INVALID',
          message: expect.stringContaining('cannot decrypt payload'),
        },
      },
    });
    expect(await lockCount(dataSource, poison!.id)).toBe(1);
  });

  it('fail-stops instead of releasing or bypassing a previously dispatched corrupt payload', async () => {
    const poisonTaskId = await enqueueImageTask(tasks, 'image-poison', 'example.invalid/poison:latest');
    const healthyTaskId = await enqueueImageTask(tasks, 'image-healthy', 'example.invalid/healthy:latest');
    onlineServerIds = ['server-a'];

    await expect(dispatcher.process()).resolves.toBe(1);
    expect(send.mock.calls[0]?.[1].taskId).toBe(poisonTaskId);

    poisonTaskIds.add(poisonTaskId);
    const quarantine = vi.fn().mockResolvedValue(undefined);
    setTransport(dispatcher, {
      onlineServerIds: () => onlineServerIds,
      send,
      quarantine,
    });
    await dataSource.getRepository(AgentTaskEntity).update(poisonTaskId, {
      lastSentAt: new Date(Date.now() - 6_000),
    });
    await expect(dispatcher.process()).resolves.toBe(0);

    expect(send).toHaveBeenCalledTimes(1);
    expect(await loadTask(dataSource, poisonTaskId)).toMatchObject({
      status: AgentTaskStatus.Failed,
      agentResultJson: null,
      errorJson: expect.objectContaining({
        code: 'AGENT_TASK_PAYLOAD_CORRUPT_OUTCOME_UNKNOWN',
      }),
    });
    expect(await lockCount(dataSource, poisonTaskId)).toBe(1);
    expect(await loadTask(dataSource, healthyTaskId)).toMatchObject({ startedAt: null });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: 'server-a' }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(quarantine).toHaveBeenCalledWith(
      'server-a',
      'Agent task payload is corrupt after physical dispatch',
    );
  });
});

function setTransport(
  dispatcher: AgentTaskDispatcherService,
  transport: AgentTaskTransport,
): void {
  // Avoid the background wake scheduled by registerTransport(); each assertion
  // drives one deterministic worker pass through process().
  (dispatcher as unknown as { transport: AgentTaskTransport }).transport = transport;
}

async function enqueueImageTask(
  tasks: AgentTasksService,
  resourceId = 'image-a',
  dockerRef = 'example.invalid/image:a',
): Promise<string> {
  const created = await tasks.enqueue({
    kind: AgentTaskKind.ImageEnsurePresent,
    serverId: 'server-a',
    resourceType: 'image',
    resourceId,
    requestedBy: 'user-a',
    payload: { dockerRef },
  });
  return created.taskId;
}

async function loadTask(dataSource: DataSource, taskId: string): Promise<AgentTaskEntity> {
  return dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: taskId });
}

async function lockCount(dataSource: DataSource, taskId: string): Promise<number> {
  return dataSource.getRepository(ResourceLockEntity).countBy({ taskId });
}

async function insertSafetyBacklog(
  dataSource: DataSource,
  serverId: string,
  count: number,
): Promise<void> {
  const createdAt = new Date(Date.now() - 60_000);
  const tasks: Partial<AgentTaskEntity>[] = [];
  const locks: Partial<ResourceLockEntity>[] = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(4, '0');
    const taskId = `task-${serverId}-${suffix}`;
    const imageId = `image-${serverId}-${suffix}`;
    const payload = {
      imageId,
      dockerRef: `example.invalid/${serverId}:${suffix}`,
    };
    tasks.push({
      id: taskId,
      kind: AgentTaskKind.ImageEnsureAbsent,
      serverId,
      resourceType: 'image',
      resourceId: imageId,
      requestedBy: null,
      requestJson: null,
      payloadJson: payload,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.ImageEnsureAbsent, payload }))
        .digest('hex'),
      admissionClass: 'safety',
      status: AgentTaskStatus.Pending,
      failureStage: null,
      agentResultJson: null,
      dispatchAttemptCount: 0,
      incompleteResultCount: 0,
      retryWindowStartedAt: null,
      nextDispatchAt: null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: null,
      errorJson: null,
      createdAt,
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
    });
    locks.push({
      resourceKey: `image:${serverId}:${imageId}`,
      taskId,
      serverId,
    });
  }
  await dataSource.getRepository(AgentTaskEntity).save(tasks, { chunk: 128 });
  await dataSource.getRepository(ResourceLockEntity).save(locks, { chunk: 128 });
}
