import { ConflictException } from '@nestjs/common';
import {
  AgentTaskKind,
  AgentTaskStatus,
  MAX_AGENT_TASK_RESULT_BYTES,
  ServerStatus,
  type TaskResultPayload,
} from '@nyabase/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { AGENT_TASK_FAIL_STOP_QUARANTINE_CODE } from '../entities/server.entity.js';
import type { AgentTaskFinalizerWorkerService } from './agent-task-finalizer-worker.service.js';
import { AgentTaskResultService } from './agent-task-result.service.js';

const TASK_ID = 'task-a';
const SERVER_ID = 'server-a';
const PAYLOAD_HASH = 'payload-hash-a';
const RESOURCE_KEY = 'image:image-a';

describe('AgentTaskResultService outcome staging', () => {
  let dataSource: DataSource;
  let tasks: Repository<AgentTaskEntity>;
  let locks: Repository<ResourceLockEntity>;
  let worker: { wake: ReturnType<typeof vi.fn> };
  let proxySnapshots: { blockServer: ReturnType<typeof vi.fn> };
  let service: AgentTaskResultService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [ServerEntity, AgentTaskEntity, ResourceLockEntity],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save({
      id: SERVER_ID, name: 'Server A', slug: 'server-a', agentTokenHash: 'token-a',
      hostFingerprint: null, agentConfigFingerprint: null,
      status: ServerStatus.Unknown, lastSeenAt: null,
    });
    await dataSource.getRepository(ServerEntity).save({
      id: 'server-b', name: 'Server B', slug: 'server-b', agentTokenHash: 'token-b',
      hostFingerprint: null, agentConfigFingerprint: null,
      status: ServerStatus.Unknown, lastSeenAt: null,
    });
    tasks = dataSource.getRepository(AgentTaskEntity);
    locks = dataSource.getRepository(ResourceLockEntity);
    worker = { wake: vi.fn() };
    proxySnapshots = { blockServer: vi.fn() };
    service = new AgentTaskResultService(
      dataSource,
      worker as unknown as AgentTaskFinalizerWorkerService,
      proxySnapshots as never,
    );
    await insertPendingTask(tasks, locks);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('durably stages the first success while the task stays pending and locked', async () => {
    await expect(service.handle(SERVER_ID, succeededResult(imageResult('sha256:a'))))
      .resolves.toEqual({ taskId: TASK_ID, payloadHash: PAYLOAD_HASH });

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      failureStage: null,
      agentResultJson: { status: 'succeeded', result: imageResult('sha256:a') },
      resultJson: null,
      errorJson: null,
      completedAt: null,
    });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(worker.wake).toHaveBeenCalledTimes(1);
  });

  it('quarantines an Agent that certifies a task Backend never dispatched', async () => {
    await tasks.update(TASK_ID, {
      startedAt: null,
      lastSentAt: null,
      dispatchAttemptCount: 0,
    });

    await expect(service.handle(SERVER_ID, succeededResult(imageResult('sha256:a'))))
      .rejects.toMatchObject({ response: { code: 'TASK_NOT_DISPATCHED' } });

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      agentResultJson: null,
    });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(worker.wake).not.toHaveBeenCalled();
  });

  it('stages immutable managed-failure evidence including observed state', async () => {
    await service.handle(SERVER_ID, failedResult('DOCKER_FAILED', 'docker failed'));

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      agentResultJson: {
        status: 'failed',
        error: { code: 'DOCKER_FAILED', message: 'docker failed' },
        observed: { dockerRef: 'example.invalid/image:a', present: false },
      },
      completedAt: null,
    });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('atomically terminalizes runtime cleanup failure, quarantines, and retains its exact lock', async () => {
    const quotaPaths = ['/docker/runtime-a/diff', '/docker/runtime-a/work'];
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.ContainerRuntimeAbsent,
      resourceType: 'container_runtime',
      resourceId: 'runtime-a',
      payloadJson: {
        containerId: 'container-a',
        runtimeId: 'runtime-a',
        serverId: SERVER_ID,
        observedIp: '10.0.0.9',
        specGeneration: '3',
        runtimeSpecHash: 'a'.repeat(64),
        numericOwnerId: 42,
        quotaPaths,
      },
    });
    await locks.delete({ taskId: TASK_ID });
    await locks.insert({
      resourceKey: 'container-runtime:server-a:runtime-a',
      taskId: TASK_ID,
      serverId: SERVER_ID,
    });

    await expect(service.handle(SERVER_ID, {
      taskId: TASK_ID,
      payloadHash: PAYLOAD_HASH,
      status: 'failed',
      error: { code: 'identity_changed', message: 'runtime labels changed' },
      observed: {
        applied: false,
        expectedRuntimeId: 'runtime-a',
        expectedContainerId: 'container-a',
        expectedServerId: SERVER_ID,
        expectedQuotaPaths: quotaPaths,
      },
    })).resolves.toEqual({ taskId: TASK_ID, payloadHash: PAYLOAD_HASH });

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'agent',
      errorJson: { code: 'identity_changed', message: 'runtime labels changed' },
      completedAt: expect.any(Date),
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(proxySnapshots.blockServer).toHaveBeenCalledWith(
      SERVER_ID,
      `safety-critical Agent task failed on ${SERVER_ID}`,
    );
    expect(worker.wake).not.toHaveBeenCalled();
  });

  it('fail-stops a quota mismatch so existing workloads cannot remain routable without enforcement', async () => {
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.QuotaEnsure,
      resourceType: 'quota',
      resourceId: 'user-a',
      payloadJson: {
        generation: 7,
        numericUserId: 42,
        diskBytes: 8192,
      },
    });

    await expect(service.handle(SERVER_ID, {
      taskId: TASK_ID,
      payloadHash: PAYLOAD_HASH,
      status: 'failed',
      error: { code: 'quota_mismatch', message: 'hard limit remained zero' },
      observed: { numericUserId: 42, hardLimitBytes: 0 },
    })).resolves.toEqual({ taskId: TASK_ID, payloadHash: PAYLOAD_HASH });

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'agent',
      agentResultJson: expect.objectContaining({ status: 'failed' }),
      errorJson: expect.objectContaining({ code: 'AGENT_QUOTA_OUTCOME_UNSAFE' }),
    });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({
        status: ServerStatus.AgentQuarantined,
        quarantineCode: 'AGENT_TASK_FAIL_STOP',
      });
    expect(proxySnapshots.blockServer).toHaveBeenCalledWith(
      SERVER_ID,
      `safety-critical Agent task failed on ${SERVER_ID}`,
    );
    expect(worker.wake).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: 'container_absent',
      observed: {
        containerId: 'container-a',
        expectedRuntimeId: 'runtime-a',
        present: false,
      },
    },
    {
      code: 'container_identity_duplicate',
      observed: {
        containerId: 'container-a',
        applied: false,
        runtimeIds: ['runtime-a', 'runtime-b'],
        runtimes: [
          { runtimeId: 'runtime-a', serverId: SERVER_ID, runtimeSpecHash: 'a'.repeat(64) },
          { runtimeId: 'runtime-b', serverId: SERVER_ID, runtimeSpecHash: 'b'.repeat(64) },
        ],
      },
    },
    {
      code: 'container_runtime_identity_conflict',
      observed: {
        containerId: 'container-a',
        applied: false,
        expectedRuntimeId: 'runtime-a',
        observedRuntimeId: 'runtime-b',
      },
    },
  ])('stages safe safety-stop coordination failure $code for finalization and cleanup progress', async ({ code, observed }) => {
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.ContainerStop,
      resourceType: 'container',
      resourceId: 'container-a',
      admissionClass: 'safety',
      payloadJson: {
        containerId: 'container-a',
        runtimeId: 'runtime-a',
        timeoutSeconds: 30,
      },
    });

    await expect(service.handle(SERVER_ID, {
      taskId: TASK_ID,
      payloadHash: PAYLOAD_HASH,
      status: 'failed',
      error: { code, message: 'fresh no-touch safety observation' },
      observed,
    })).resolves.toEqual({ taskId: TASK_ID, payloadHash: PAYLOAD_HASH });

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      agentResultJson: expect.objectContaining({ status: 'failed' }),
      completedAt: null,
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.Unknown });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(worker.wake).toHaveBeenCalledTimes(1);
    expect(proxySnapshots.blockServer).not.toHaveBeenCalled();
  });

  it('fail-stops a true safety-stop failure that proves the runtime remains running', async () => {
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.ContainerStop,
      resourceType: 'container',
      resourceId: 'container-a',
      admissionClass: 'safety',
      payloadJson: {
        containerId: 'container-a',
        runtimeId: 'runtime-a',
        timeoutSeconds: 30,
      },
    });

    await service.handle(SERVER_ID, {
      taskId: TASK_ID,
      payloadHash: PAYLOAD_HASH,
      status: 'failed',
      error: { code: 'container_stop_failed', message: 'runtime remains running' },
      observed: {
        containerId: 'container-a',
        runtimeId: 'runtime-a',
        serverId: SERVER_ID,
        running: true,
        applied: false,
      },
    });

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      errorJson: expect.objectContaining({ code: 'AGENT_SAFETY_OUTCOME_UNSAFE' }),
    });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(proxySnapshots.blockServer).toHaveBeenCalledTimes(1);
    expect(worker.wake).not.toHaveBeenCalled();
  });

  it('acknowledges an identical duplicate but rejects changed terminal evidence', async () => {
    const result = succeededResult(imageResult('sha256:a'));
    const first = await service.handle(SERVER_ID, result);
    await expect(service.handle(SERVER_ID, result)).resolves.toEqual(first);

    await expect(service.handle(SERVER_ID, succeededResult(imageResult('sha256:b'))))
      .rejects.toMatchObject({ response: { code: 'TASK_RESULT_CONFLICT' } });
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      agentResultJson: { status: 'succeeded', result: imageResult('sha256:a') },
    });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
  });

  it('records incomplete diagnostics, yields the server slot with backoff, and keeps locks', async () => {
    const before = Date.now();
    await expect(service.handle(SERVER_ID, {
      taskId: TASK_ID,
      payloadHash: PAYLOAD_HASH,
      status: 'incomplete',
      error: { code: 'INTERRUPTED', message: 'connection reset during ensure' },
    })).resolves.toBeNull();

    const task = await tasks.findOneByOrFail({ id: TASK_ID });
    expect(task).toMatchObject({
      status: AgentTaskStatus.Pending,
      agentResultJson: null,
      errorJson: { code: 'INTERRUPTED', message: 'connection reset during ensure' },
      completedAt: null,
    });
    expect(task.lastSentAt).toBeNull();
    expect(task.nextDispatchAt).toBeInstanceOf(Date);
    expect(task.nextDispatchAt!.getTime()).toBeGreaterThanOrEqual(before + 900);
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(worker.wake).not.toHaveBeenCalled();
  });

  it.each([
    [AgentTaskKind.QuotaEnsure, 'quota_observation_unavailable'],
    [AgentTaskKind.ContainerCreate, 'container_shared_quota_incomplete'],
    [AgentTaskKind.DataDirEnsure, 'data_dir_quota_unobservable'],
  ] as const)(
    'immediately fail-stops an unobservable quota boundary for %s',
    async (kind, code) => {
      await tasks.update(TASK_ID, { kind });

      await expect(service.handle(SERVER_ID, {
        taskId: TASK_ID,
        payloadHash: PAYLOAD_HASH,
        status: 'incomplete',
        error: { code, message: 'fresh quota observation failed' },
      })).resolves.toEqual({ taskId: TASK_ID, payloadHash: PAYLOAD_HASH });

      expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
        status: AgentTaskStatus.Failed,
        agentResultJson: null,
        failureStage: 'agent',
        errorJson: {
          code: 'AGENT_QUOTA_OUTCOME_UNSAFE',
          cause: { code, message: 'fresh quota observation failed' },
        },
        lastSentAt: null,
        nextDispatchAt: null,
        completedAt: expect.any(Date),
      });
      expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
      expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
        .toMatchObject({
          status: ServerStatus.AgentQuarantined,
          quarantineCode: AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
        });
      expect(proxySnapshots.blockServer).toHaveBeenCalledTimes(1);
      expect(worker.wake).not.toHaveBeenCalled();
    },
  );

  it('does not spend the uncertainty budget while an unbound delete waits for exact residual cleanup', async () => {
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.ContainerDelete,
      retryWindowStartedAt: new Date('2026-07-15T00:00:00.000Z'),
      incompleteResultCount: 11,
    });

    await expect(service.handle(SERVER_ID, {
      taskId: TASK_ID,
      payloadHash: PAYLOAD_HASH,
      status: 'incomplete',
      error: {
        code: 'container_delete_unbound_runtime_present',
        message: 'fresh inventory found a residual managed runtime',
      },
    })).resolves.toBeNull();

    const task = await tasks.findOneByOrFail({ id: TASK_ID });
    expect(task).toMatchObject({
      status: AgentTaskStatus.Pending,
      retryWindowStartedAt: null,
      incompleteResultCount: 0,
      errorJson: {
        code: 'container_delete_unbound_runtime_present',
      },
    });
    expect(task.lastSentAt).toBeNull();
    expect(task.nextDispatchAt).toBeInstanceOf(Date);
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it.each([
    {
      label: 'authenticated server',
      serverId: 'server-b',
      result: succeededResult(imageResult('sha256:a')),
      code: 'TASK_SERVER_CONFLICT',
    },
    {
      label: 'payload hash',
      serverId: SERVER_ID,
      result: {
        ...succeededResult(imageResult('sha256:a')),
        payloadHash: 'different-hash',
      } satisfies TaskResultPayload,
      code: 'TASK_PAYLOAD_HASH_CONFLICT',
    },
  ])('rejects a $label conflict without changing the task or lock', async ({ serverId, result, code }) => {
    let caught: unknown;
    try {
      await service.handle(serverId, result);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({ code });
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      agentResultJson: null,
      completedAt: null,
    });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(worker.wake).not.toHaveBeenCalled();
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: serverId }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
  });

  it('server-quarantines an unknown task result without guessing another task identity', async () => {
    await expect(service.handle(SERVER_ID, {
      ...succeededResult(imageResult('sha256:a')),
      taskId: 'unknown-task',
    })).rejects.toThrow('Agent task not found');

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      agentResultJson: null,
      errorJson: null,
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('durably fails and quarantines a kind-invalid success without releasing its lock', async () => {
    await expect(service.handle(SERVER_ID, succeededResult({ runtimeId: 'not-an-image-result' })))
      .rejects.toMatchObject({ response: { code: 'TASK_RESULT_SCHEMA_INVALID' } });

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'agent',
      agentResultJson: null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      errorJson: {
        code: 'INVALID_AGENT_RESULT',
        message: 'Agent returned an invalid terminal result; server is quarantined and the resource lock is retained',
      },
      completedAt: expect.any(Date),
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(worker.wake).not.toHaveBeenCalled();
  });

  it('rejects an oversized result, quarantines its server, and retains the exact lock', async () => {
    const oversized = succeededResult({
      ...imageResult('sha256:a'),
      diagnostic: 'x'.repeat(MAX_AGENT_TASK_RESULT_BYTES),
    } as never);

    await expect(service.handle(SERVER_ID, oversized))
      .rejects.toMatchObject({ response: { code: 'TASK_RESULT_SCHEMA_INVALID' } });

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'agent',
      agentResultJson: null,
      errorJson: expect.objectContaining({ code: 'INVALID_AGENT_RESULT' }),
      completedAt: expect.any(Date),
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
    expect(proxySnapshots.blockServer).toHaveBeenCalledWith(
      SERVER_ID,
      'Authenticated Agent returned invalid task evidence',
    );
    expect(worker.wake).not.toHaveBeenCalled();
  });

  it('durably quarantines an outer-schema-invalid result and binds it to the dispatched task', async () => {
    await expect(service.quarantineMalformedResult(
      SERVER_ID,
      {
        taskId: TASK_ID,
        payloadHash: PAYLOAD_HASH,
        status: 'failed',
        error: { code: 'broken', message: 'missing observed' },
      },
      { issues: [{ code: 'invalid_type', message: 'Required', path: ['observed'] }] },
    )).resolves.toBe(TASK_ID);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'agent',
      errorJson: {
        code: 'INVALID_AGENT_RESULT',
        details: {
          issues: [{ code: 'invalid_type', message: 'Required', path: ['observed'] }],
        },
      },
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('quarantines the server even when malformed evidence cannot be bound to a task', async () => {
    await tasks.update(TASK_ID, { startedAt: null, lastSentAt: null });

    await expect(service.quarantineMalformedResult(
      SERVER_ID,
      { status: 'failed', error: { code: 'broken', message: 'missing identity' } },
      new Error('taskId is required'),
    )).resolves.toBeNull();

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      failureStage: null,
      errorJson: null,
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await locks.countBy({ taskId: TASK_ID })).toBe(1);
  });
});

async function insertPendingTask(
  tasks: Repository<AgentTaskEntity>,
  locks: Repository<ResourceLockEntity>,
): Promise<void> {
  await tasks.save(tasks.create({
    id: TASK_ID,
    kind: AgentTaskKind.ImageEnsurePresent,
    serverId: SERVER_ID,
    resourceType: 'image',
    resourceId: 'image-a',
    requestedBy: 'user-a',
    requestJson: { imageId: 'image-a' },
    payloadJson: { imageId: 'image-a', dockerRef: 'example.invalid/image:a' },
    payloadHash: PAYLOAD_HASH,
    status: AgentTaskStatus.Pending,
    failureStage: null,
    agentResultJson: null,
    resultJson: null,
    errorJson: null,
    startedAt: new Date('2026-07-15T00:00:00.000Z'),
    lastSentAt: new Date('2026-07-15T00:00:00.000Z'),
    completedAt: null,
  }));
  await locks.insert({ resourceKey: RESOURCE_KEY, taskId: TASK_ID, serverId: SERVER_ID });
}

function succeededResult(
  result: Extract<TaskResultPayload, { status: 'succeeded' }>['result'],
): TaskResultPayload {
  return {
    taskId: TASK_ID,
    payloadHash: PAYLOAD_HASH,
    status: 'succeeded',
    result,
  };
}

function failedResult(code: string, message: string): TaskResultPayload {
  return {
    taskId: TASK_ID,
    payloadHash: PAYLOAD_HASH,
    status: 'failed',
    error: { code, message },
    observed: { dockerRef: 'example.invalid/image:a', present: false },
  };
}

function imageResult(dockerId: string) {
  return {
    imageId: 'image-a',
    dockerId,
    dockerRef: 'example.invalid/image:a',
  };
}
