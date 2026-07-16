import { createHash } from 'node:crypto';
import {
  AgentTaskKind,
  AgentTaskStatus,
  ServerStatus,
  canonicalJson,
} from '@nyabase/common';
import { DataSource, EntityManager } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { AgentTasksService } from './agent-tasks.service.js';

const SERVER_ID = 'server-quarantined';
const TASK_ID = 'task-quarantined';
const PAYLOAD = { dockerRef: 'example.invalid/image:latest' };

describe('Agent task invalid-result quarantine retry', () => {
  let dataSource: DataSource;
  let service: AgentTasksService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [ServerEntity, AgentTaskEntity, ResourceLockEntity, NetworkAddressClaimEntity],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save({
      id: SERVER_ID,
      name: 'Quarantined server',
      slug: 'quarantined-server',
      agentTokenHash: 'token-hash',
      hostFingerprint: null,
      agentConfigFingerprint: null,
      status: ServerStatus.AgentQuarantined,
      lastSeenAt: null,
    });
    await dataSource.getRepository(AgentTaskEntity).save({
      id: TASK_ID,
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: SERVER_ID,
      resourceType: 'image',
      resourceId: 'image-a',
      requestedBy: null,
      requestJson: null,
      payloadJson: PAYLOAD,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.ImageEnsurePresent, payload: PAYLOAD }))
        .digest('hex'),
      status: AgentTaskStatus.Failed,
      failureStage: 'agent',
      agentResultJson: null,
      dispatchAttemptCount: 1,
      nextDispatchAt: null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: null,
      errorJson: { code: 'INVALID_AGENT_RESULT', message: 'invalid result' },
      startedAt: new Date('2026-07-15T00:00:00.000Z'),
      lastSentAt: null,
      completedAt: new Date('2026-07-15T00:00:01.000Z'),
    });
    await dataSource.getRepository(ResourceLockEntity).save({
      resourceKey: 'image:image-a',
      taskId: TASK_ID,
      serverId: SERVER_ID,
    });
    service = new AgentTasksService(
      dataSource,
      {} as never,
      {} as never,
      {
        forDispatch: vi.fn((task: AgentTaskEntity) => task.payloadJson),
        forWirePayload: vi.fn((_kind: AgentTaskKind, payload: unknown) => payload),
      } as never,
      dataSource.getRepository(AgentTaskEntity),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('atomically restores the retained task to pending and keeps its lock', async () => {
    await expect(service.retryAgentQuarantine(SERVER_ID)).resolves.toEqual([TASK_ID]);

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.Unknown });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Pending,
        admissionClass: 'safety',
        failureStage: null,
        errorJson: null,
        completedAt: null,
        dispatchAttemptCount: 0,
      });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('reloads complete quarantine authority in batches of at most eight tasks', async () => {
    const template = await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID });
    const extraTasks = Array.from({ length: 8 }, (_, index) => ({
      ...template,
      id: `task-batch-${index}`,
      resourceId: `image-batch-${index}`,
      createdAt: new Date(template.createdAt.getTime() + index + 1),
    }));
    await dataSource.getRepository(AgentTaskEntity).save(extraTasks);
    await dataSource.getRepository(ResourceLockEntity).save(extraTasks.map((task) => ({
      resourceKey: `image:${task.resourceId}`,
      taskId: task.id,
      serverId: SERVER_ID,
    })));
    const find = vi.spyOn(EntityManager.prototype, 'find');

    await expect(service.retryAgentQuarantine(SERVER_ID)).resolves.toHaveLength(9);

    const batchSizes = find.mock.calls
      .filter(([entity]) => entity === AgentTaskEntity)
      .map(([, options]) => {
        const where = options?.where as { id?: { value?: unknown } } | undefined;
        return Array.isArray(where?.id?.value) ? where.id.value.length : 0;
      })
      .filter((size) => size > 0);
    expect(batchSizes).toEqual([8, 1]);
  });

  it('refuses to leave quarantine if the retained physical resource lock is missing', async () => {
    await dataSource.getRepository(ResourceLockEntity).delete({ taskId: TASK_ID });

    await expect(service.retryAgentQuarantine(SERVER_ID))
      .rejects.toMatchObject({ response: { code: 'AGENT_QUARANTINE_LOCK_MISSING' } });

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({ status: AgentTaskStatus.Failed });
  });

  it('retries only database finalization after finalizer exhaustion and never reopens physical dispatch', async () => {
    const evidence = { status: 'succeeded', result: { dockerId: 'sha256:a' } };
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: 12,
      errorJson: {
        code: 'FINALIZER_RETRY_EXHAUSTED',
        message: 'projection defect',
      },
    } as never);

    await expect(service.retryAgentQuarantine(SERVER_ID)).resolves.toEqual([TASK_ID]);

    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Pending,
        admissionClass: 'safety',
        failureStage: null,
        agentResultJson: evidence,
        dispatchAttemptCount: 1,
        finalizerAttemptCount: 0,
        finalizerRetryAt: null,
        errorJson: null,
        completedAt: null,
      });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('promotes every started Pending authority but leaves never-sent work ordinary', async () => {
    const originalStartedAt = new Date('2026-07-15T00:00:00.000Z');
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      status: AgentTaskStatus.Pending,
      failureStage: 'agent',
      dispatchAttemptCount: 9,
      incompleteResultCount: 12,
      retryWindowStartedAt: new Date('2026-07-15T00:00:00.000Z'),
      lastSentAt: new Date('2026-07-15T00:00:01.000Z'),
      nextDispatchAt: new Date('2026-07-15T00:01:00.000Z'),
      errorJson: { code: 'INTERRUPTED', message: 'old retry epoch' },
      startedAt: originalStartedAt,
      completedAt: null,
    } as never);
    const unstartedTaskId = 'task-never-sent';
    const unstartedPayload = { dockerRef: 'example.invalid/never-sent:latest' };
    await dataSource.getRepository(AgentTaskEntity).save({
      id: unstartedTaskId,
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: SERVER_ID,
      resourceType: 'image',
      resourceId: 'image-never-sent',
      requestedBy: null,
      requestJson: null,
      payloadJson: unstartedPayload,
      payloadHash: createHash('sha256')
        .update(canonicalJson({
          kind: AgentTaskKind.ImageEnsurePresent,
          payload: unstartedPayload,
        }))
        .digest('hex'),
      status: AgentTaskStatus.Pending,
      failureStage: null,
      agentResultJson: null,
      dispatchAttemptCount: 0,
      nextDispatchAt: null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: null,
      errorJson: null,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
    });
    await dataSource.getRepository(ResourceLockEntity).save({
      resourceKey: 'image:image-never-sent',
      taskId: unstartedTaskId,
      serverId: SERVER_ID,
    });

    await expect(service.retryAgentQuarantine(SERVER_ID)).resolves.toEqual([TASK_ID]);

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.Unknown });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Pending,
        admissionClass: 'safety',
        failureStage: null,
        dispatchAttemptCount: 0,
        incompleteResultCount: 0,
        retryWindowStartedAt: null,
        lastSentAt: null,
        nextDispatchAt: null,
        startedAt: originalStartedAt,
        errorJson: null,
      });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: unstartedTaskId }))
      .toMatchObject({
        status: AgentTaskStatus.Pending,
        admissionClass: 'normal',
        startedAt: null,
      });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);

    await expect(service.failExhaustedTasks(new Date('2026-07-20T00:00:00.000Z')))
      .resolves.toEqual({ taskIds: [], serverIds: [] });
    await dataSource.getRepository(ServerEntity).update(SERVER_ID, {
      status: ServerStatus.Online,
    });
    await expect(service.markSentAndBuild(TASK_ID)).resolves.toMatchObject({
      taskId: TASK_ID,
      kind: AgentTaskKind.ImageEnsurePresent,
    });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Pending,
        admissionClass: 'safety',
        dispatchAttemptCount: 1,
        incompleteResultCount: 0,
        startedAt: originalStartedAt,
        retryWindowStartedAt: expect.any(Date),
        lastSentAt: expect.any(Date),
      });
  });
});
