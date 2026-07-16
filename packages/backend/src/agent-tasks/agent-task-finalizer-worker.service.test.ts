import { AgentTaskKind, AgentTaskStatus, ServerStatus } from '@nyabase/common';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import type { AgentTaskFinalizerService } from './agent-task-finalizer.service.js';
import {
  AgentTaskFinalizerWorkerService,
  MAX_FINALIZER_ATTEMPTS,
} from './agent-task-finalizer-worker.service.js';
import { ResourceLockService } from './resource-lock.service.js';
import type { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';

const TASK_ID = 'task-a';
const SERVER_ID = 'server-a';
const PAYLOAD_HASH = 'a'.repeat(64);

describe('AgentTaskFinalizerWorkerService', () => {
  let dataSource: DataSource;
  let tasks: Repository<AgentTaskEntity>;
  let locksRepo: Repository<ResourceLockEntity>;
  let resourceLocks: ResourceLockService;
  let finalizer: {
    applySucceeded: ReturnType<typeof vi.fn>;
    applyFailed: ReturnType<typeof vi.fn>;
  };
  let worker: AgentTaskFinalizerWorkerService;
  let notifyProxySnapshots: ReturnType<typeof vi.fn>;
  let blockServer: ReturnType<typeof vi.fn>;
  let accessCacheEpoch: AccessCacheEpochService;

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
    await dataSource.query('CREATE TABLE finalizer_markers (id TEXT PRIMARY KEY)');
    tasks = dataSource.getRepository(AgentTaskEntity);
    locksRepo = dataSource.getRepository(ResourceLockEntity);
    resourceLocks = new ResourceLockService(locksRepo);
    finalizer = { applySucceeded: vi.fn(), applyFailed: vi.fn() };
    notifyProxySnapshots = vi.fn().mockResolvedValue(undefined);
    blockServer = vi.fn();
    accessCacheEpoch = new AccessCacheEpochService();
    worker = new AgentTaskFinalizerWorkerService(
      dataSource,
      finalizer as unknown as AgentTaskFinalizerService,
      resourceLocks,
      {
        notify: notifyProxySnapshots,
        invalidate: vi.fn(),
        blockServer,
      } as unknown as ProxySnapshotNotifierService,
      accessCacheEpoch,
    );
  });

  afterEach(async () => {
    worker.onModuleDestroy();
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('atomically applies a staged success, terminates the task, and releases its lock', async () => {
    await insertStagedTask(tasks, locksRepo, {
      status: 'succeeded',
      result: {
        runtimeId: 'runtime-a',
        quotaPaths: ['/var/lib/nyabase-docker/upper', '/var/lib/nyabase-docker/work'],
      },
    });
    finalizer.applySucceeded.mockImplementation(async (manager: EntityManager) => {
      await manager.query('INSERT INTO finalizer_markers (id) VALUES (?)', ['applied']);
    });

    await expect(worker.process()).resolves.toBe(1);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Succeeded,
      failureStage: null,
      agentResultJson: {
        status: 'succeeded',
        result: {
          runtimeId: 'runtime-a',
          quotaPaths: ['/var/lib/nyabase-docker/upper', '/var/lib/nyabase-docker/work'],
        },
      },
      resultJson: {
        runtimeId: 'runtime-a',
        quotaPaths: ['/var/lib/nyabase-docker/upper', '/var/lib/nyabase-docker/work'],
      },
      errorJson: null,
      completedAt: expect.any(Date),
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
    expect(await markerIds()).toEqual([{ id: 'applied' }]);
  });

  it('rolls back a failed finalizer and retries only database finalization', async () => {
    await insertStagedTask(tasks, locksRepo, {
      status: 'succeeded',
      result: {
        runtimeId: 'runtime-a',
        quotaPaths: ['/var/lib/nyabase-docker/upper', '/var/lib/nyabase-docker/work'],
      },
    });
    finalizer.applySucceeded.mockImplementation(async (manager: EntityManager) => {
      await manager.query('INSERT INTO finalizer_markers (id) VALUES (?)', ['must-rollback']);
      throw new Error('projection unavailable');
    });

    await expect(worker.process()).resolves.toBe(0);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      failureStage: 'finalizer',
      agentResultJson: {
        status: 'succeeded',
        result: {
          runtimeId: 'runtime-a',
          quotaPaths: ['/var/lib/nyabase-docker/upper', '/var/lib/nyabase-docker/work'],
        },
      },
      resultJson: null,
      errorJson: {
        code: 'FINALIZER_RETRY_PENDING',
        message: 'projection unavailable',
      },
      completedAt: null,
    });
    expect(await markerIds()).toEqual([]);
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);

    finalizer.applySucceeded.mockImplementation(async (manager: EntityManager) => {
      await manager.query('INSERT INTO finalizer_markers (id) VALUES (?)', ['retried']);
    });
    await tasks.update(TASK_ID, { finalizerRetryAt: new Date(0) });
    await expect(worker.process()).resolves.toBe(1);
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Succeeded,
      failureStage: null,
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
    expect(await markerIds()).toEqual([{ id: 'retried' }]);
  });

  it('bounds non-Error finalizer diagnostics without traversing cyclic values', async () => {
    await insertStagedTask(tasks, locksRepo, {
      status: 'succeeded',
      result: { ok: true },
    });
    const cyclic: Record<string, unknown> & { toString: () => string } = {
      toString: () => 'x'.repeat(16_384),
    };
    cyclic.self = cyclic;
    finalizer.applySucceeded.mockRejectedValueOnce(cyclic);

    await expect(worker.process()).resolves.toBe(0);

    const task = await tasks.findOneByOrFail({ id: TASK_ID });
    const error = task.errorJson as { code: string; message: string; details: string };
    expect(error.code).toBe('FINALIZER_RETRY_PENDING');
    expect(error.message).toHaveLength(2_048);
    expect(error.details).toHaveLength(8_192);
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('keeps retry diagnostics durable when a rejected value cannot be stringified', async () => {
    await insertStagedTask(tasks, locksRepo, {
      status: 'succeeded',
      result: { ok: true },
    });
    finalizer.applySucceeded.mockRejectedValueOnce({
      toString: () => { throw new Error('toString failed'); },
    });

    await expect(worker.process()).resolves.toBe(0);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      errorJson: {
        code: 'FINALIZER_RETRY_PENDING',
        message: 'Unprintable finalizer error',
        details: 'Unprintable finalizer error',
      },
    });
  });

  it('scans only task identities before reloading each due finalizer row', async () => {
    const find = vi.spyOn(tasks, 'find');

    await expect(worker.process()).resolves.toBe(0);

    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true },
      take: 32,
    }));
  });

  it('rolls back terminal state and deletion when lock release fails', async () => {
    await insertStagedTask(tasks, locksRepo, {
      status: 'succeeded',
      result: { ok: true },
    });
    vi.spyOn(resourceLocks, 'releaseTask').mockImplementation(async (taskId, manager) => {
      if (!manager) throw new Error('transaction manager required');
      await manager.delete(ResourceLockEntity, { taskId });
      throw new Error('lock release interrupted');
    });

    await expect(worker.process()).resolves.toBe(0);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      failureStage: 'finalizer',
      agentResultJson: { status: 'succeeded', result: { ok: true } },
      resultJson: null,
      completedAt: null,
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('terminalizes an exhausted database finalizer, quarantines the server, and retains evidence and locks', async () => {
    const evidence = { status: 'succeeded', result: { dockerId: 'sha256:a' } };
    await insertStagedTask(tasks, locksRepo, evidence);
    await tasks.update(TASK_ID, {
      finalizerAttemptCount: MAX_FINALIZER_ATTEMPTS - 1,
    });
    finalizer.applySucceeded.mockRejectedValue(new Error('permanent projection defect'));

    await expect(worker.process()).resolves.toBe(0);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: MAX_FINALIZER_ATTEMPTS,
      finalizerRetryAt: null,
      errorJson: expect.objectContaining({ code: 'FINALIZER_RETRY_EXHAUSTED' }),
      completedAt: expect.any(Date),
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(blockServer).toHaveBeenCalledWith(
      SERVER_ID,
      `Agent task finalizer exhausted retries on ${SERVER_ID}`,
    );
  });

  it('passes managed-failure observation to the finalizer before terminal failure', async () => {
    const error = { code: 'CREATE_FAILED', message: 'create failed' };
    const observed = { runtimeId: 'runtime-partial', running: false };
    await insertStagedTask(tasks, locksRepo, { status: 'failed', error, observed });

    await expect(worker.process()).resolves.toBe(1);

    expect(finalizer.applyFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: TASK_ID }),
      error,
      observed,
    );
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'agent',
      errorJson: error,
      completedAt: expect.any(Date),
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
  });

  it.each([
    [AgentTaskKind.ContainerStart, 'container', 'container-a', { containerId: 'container-a', applied: false, reason: 'never_dispatched' }],
    [AgentTaskKind.DataDirEnsure, 'datadir', 'datadir-a', { expectedResourceId: 'datadir-a', applied: false, reason: 'never_dispatched' }],
  ])('commits corrupt never-dispatched %s as Failed and releases its lock', async (
    kind,
    resourceType,
    resourceId,
    observed,
  ) => {
    const error = { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' };
    await insertStagedTask(tasks, locksRepo, { status: 'failed', error, observed });
    await tasks.update(TASK_ID, {
      kind,
      resourceType,
      resourceId,
      payloadJson: 'corrupt-payload',
      failureStage: 'dispatch',
      dispatchAttemptCount: 0,
      startedAt: null,
      lastSentAt: null,
    });

    await expect(worker.process()).resolves.toBe(1);

    expect(finalizer.applyFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: TASK_ID,
        kind,
        resourceId,
        payloadJson: 'corrupt-payload',
        failureStage: 'dispatch',
      }),
      error,
      observed,
    );
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'dispatch',
      errorJson: error,
      completedAt: expect.any(Date),
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
  });

  it('preserves dispatch origin across a transient no-send finalizer retry', async () => {
    const error = { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' };
    const observed = { containerId: 'container-a', applied: false, reason: 'never_dispatched' };
    await insertStagedTask(tasks, locksRepo, { status: 'failed', error, observed });
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.ContainerStart,
      payloadJson: 'corrupt-payload',
      failureStage: 'dispatch',
      dispatchAttemptCount: 0,
      startedAt: null,
      lastSentAt: null,
    });
    finalizer.applyFailed.mockRejectedValueOnce(new Error('projection temporarily unavailable'));

    await expect(worker.process()).resolves.toBe(0);
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      failureStage: 'dispatch',
      finalizerAttemptCount: 1,
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);

    finalizer.applyFailed.mockResolvedValueOnce(undefined);
    await tasks.update(TASK_ID, { finalizerRetryAt: new Date(0) });
    await expect(worker.process()).resolves.toBe(1);
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'dispatch',
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
  });

  it('notifies proxy revocation after a committed container delete without coupling task success to delivery', async () => {
    await insertStagedTask(tasks, locksRepo, { status: 'succeeded', result: { present: false } });
    await tasks.update(TASK_ID, { kind: AgentTaskKind.ContainerDelete });
    notifyProxySnapshots.mockRejectedValueOnce(new Error('proxy unavailable'));

    await expect(worker.process()).resolves.toBe(1);

    expect(notifyProxySnapshots).toHaveBeenCalledTimes(1);
    expect(notifyProxySnapshots).toHaveBeenCalledWith('container container-a deleted');
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Succeeded,
      resultJson: { present: false },
      failureStage: null,
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
  });

  it('bumps the access cache epoch only after a RemoteFS finalizer commits', async () => {
    await insertStagedTask(tasks, locksRepo, { status: 'succeeded', result: { mounted: true } });
    await tasks.update(TASK_ID, { kind: AgentTaskKind.RemoteFsEnsure });
    finalizer.applySucceeded.mockRejectedValueOnce(new Error('projection unavailable'));

    await expect(worker.process()).resolves.toBe(0);
    expect(accessCacheEpoch.current()).toBe(0);

    finalizer.applySucceeded.mockResolvedValueOnce(undefined);
    await tasks.update(TASK_ID, { finalizerRetryAt: new Date(0) });
    await expect(worker.process()).resolves.toBe(1);
    expect(accessCacheEpoch.current()).toBe(1);
  });

  it('backs off poison finalizers and reaches later staged outcomes in the same bounded pass', async () => {
    for (let index = 0; index < 32; index += 1) {
      await insertStagedTaskRecord(tasks, locksRepo, `poison-${index}`, index);
    }
    await insertStagedTaskRecord(tasks, locksRepo, 'healthy', 32);
    finalizer.applySucceeded.mockImplementation(async (_manager, task: AgentTaskEntity) => {
      if (task.id.startsWith('poison-')) throw new Error('permanent projection bug');
    });

    await expect(worker.process()).resolves.toBe(1);

    expect(await tasks.findOneByOrFail({ id: 'healthy' })).toMatchObject({
      status: AgentTaskStatus.Succeeded,
      finalizerRetryAt: null,
    });
    const firstPoison = await tasks.findOneByOrFail({ id: 'poison-0' });
    expect(firstPoison).toMatchObject({
      status: AgentTaskStatus.Pending,
      failureStage: 'finalizer',
      finalizerAttemptCount: 1,
      finalizerRetryAt: expect.any(Date),
    });
    expect(firstPoison.finalizerRetryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await locksRepo.countBy({ taskId: 'healthy' })).toBe(0);
    expect(await locksRepo.countBy({ taskId: 'poison-0' })).toBe(1);
  });

  async function markerIds(): Promise<Array<{ id: string }>> {
    return dataSource.query('SELECT id FROM finalizer_markers ORDER BY id');
  }
});

async function insertStagedTaskRecord(
  tasks: Repository<AgentTaskEntity>,
  locks: Repository<ResourceLockEntity>,
  taskId: string,
  order: number,
): Promise<void> {
  await tasks.save(tasks.create({
    id: taskId,
    kind: AgentTaskKind.ImageEnsurePresent,
    serverId: SERVER_ID,
    resourceType: 'image',
    resourceId: `image-${taskId}`,
    requestedBy: 'user-a',
    requestJson: null,
    payloadJson: { dockerRef: `example.invalid/${taskId}` },
    payloadHash: PAYLOAD_HASH,
    status: AgentTaskStatus.Pending,
    failureStage: null,
    agentResultJson: { status: 'succeeded', result: { dockerId: taskId } },
    resultJson: null,
    errorJson: null,
    createdAt: new Date(Date.UTC(2026, 6, 15, 0, 0, 0, order)),
    startedAt: new Date('2026-07-15T00:00:00.000Z'),
    lastSentAt: new Date('2026-07-15T00:00:00.000Z'),
    completedAt: null,
  }));
  await locks.insert({
    resourceKey: `image:${taskId}`,
    taskId,
    serverId: SERVER_ID,
  });
}

async function insertStagedTask(
  tasks: Repository<AgentTaskEntity>,
  locks: Repository<ResourceLockEntity>,
  evidence: unknown,
): Promise<void> {
  await tasks.save(tasks.create({
    id: TASK_ID,
    kind: AgentTaskKind.ContainerCreate,
    serverId: SERVER_ID,
    resourceType: 'container',
    resourceId: 'container-a',
    requestedBy: 'user-a',
    requestJson: { name: 'container-a' },
    payloadJson: { runtimeId: 'runtime-a' },
    payloadHash: PAYLOAD_HASH,
    status: AgentTaskStatus.Pending,
    failureStage: null,
    agentResultJson: evidence,
    resultJson: null,
    errorJson: null,
    startedAt: new Date('2026-07-15T00:00:00.000Z'),
    lastSentAt: new Date('2026-07-15T00:00:00.000Z'),
    completedAt: null,
  }));
  await locks.insert({
    resourceKey: 'container:container-a',
    taskId: TASK_ID,
    serverId: SERVER_ID,
  });
}
