import { createHash } from 'node:crypto';
import {
  AgentTaskKind,
  AgentTaskStatus,
  MAX_AGENT_TASK_RESULT_BYTES,
  ServerStatus,
  canonicalJson,
} from '@nyabase/common';
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
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { AgentTasksService } from './agent-tasks.service.js';

const TASK_ID = 'task-a';
const SERVER_ID = 'server-a';
const IMAGE_REF = 'example.invalid/image:latest';
const IMAGE_PAYLOAD = { dockerRef: IMAGE_REF };
const PAYLOAD_HASH = createHash('sha256')
  .update(canonicalJson({ kind: AgentTaskKind.ImageEnsurePresent, payload: IMAGE_PAYLOAD }))
  .digest('hex');

const NEVER_DISPATCHED_CASES = [
  [AgentTaskKind.ContainerCreate, 'container', 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerStart, 'container', 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerStop, 'container', 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerRestart, 'container', 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerSshEnsure, 'container', 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerDelete, 'container', 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerRuntimeAbsent, 'container_runtime', 'runtime-a', { expectedRuntimeId: 'runtime-a' }],
  [AgentTaskKind.DataDirEnsure, 'datadir', 'datadir-a', { expectedResourceId: 'datadir-a' }],
  [AgentTaskKind.DataDirAbsent, 'datadir', 'datadir-a', { expectedResourceId: 'datadir-a' }],
  [AgentTaskKind.RemoteFsEnsure, 'remote_fs_mount', 'remote-a', { id: 'remote-a' }],
  [AgentTaskKind.RemoteFsAbsent, 'remote_fs_mount', 'remote-a', { id: 'remote-a' }],
  [AgentTaskKind.QuotaEnsure, 'quota', 'user-a', { resourceId: 'user-a' }],
  [AgentTaskKind.ImageEnsurePresent, 'image', 'image-a', { resourceId: 'image-a' }],
  [AgentTaskKind.ImageEnsureAbsent, 'image', 'image-a', { resourceId: 'image-a' }],
] as const;

function stagedImageSuccess(dockerId = 'sha256:a', dockerRef = IMAGE_REF) {
  return {
    status: 'succeeded' as const,
    result: { imageId: null, dockerId, dockerRef },
  };
}

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
  let decodeWirePayload: (task: AgentTaskEntity) => unknown;

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
    decodeWirePayload = (task) => task.payloadJson;
    worker = new AgentTaskFinalizerWorkerService(
      dataSource,
      finalizer as unknown as AgentTaskFinalizerService,
      resourceLocks,
      { forDispatch: (task: AgentTaskEntity) => decodeWirePayload(task) } as never,
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
    const evidence = stagedImageSuccess();
    await insertStagedTask(tasks, locksRepo, evidence);
    finalizer.applySucceeded.mockImplementation(async (manager: EntityManager) => {
      await manager.query('INSERT INTO finalizer_markers (id) VALUES (?)', ['applied']);
    });

    await expect(worker.process()).resolves.toBe(1);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Succeeded,
      failureStage: null,
      agentResultJson: evidence,
      resultJson: evidence.result,
      errorJson: null,
      completedAt: expect.any(Date),
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
    expect(await markerIds()).toEqual([{ id: 'applied' }]);
  });

  it('accepts a staged result whose reconstructed wire form is exactly at the byte limit', async () => {
    const evidence = stagedImageEvidenceAtWireBytes(MAX_AGENT_TASK_RESULT_BYTES);
    await insertStagedTask(tasks, locksRepo, evidence);

    await expect(worker.process()).resolves.toBe(1);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Succeeded,
      agentResultJson: evidence,
      resultJson: evidence.result,
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .not.toMatchObject({ status: ServerStatus.AgentQuarantined });
  });

  it('atomically quarantines a staged result one byte over the reconstructed wire limit', async () => {
    const evidence = stagedImageEvidenceAtWireBytes(MAX_AGENT_TASK_RESULT_BYTES + 1);
    await insertStagedTask(tasks, locksRepo, evidence);

    await expect(worker.process()).resolves.toBe(0);

    expect(finalizer.applySucceeded).not.toHaveBeenCalled();
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      agentResultJson: evidence,
      resultJson: null,
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT' },
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
  });

  it.each([
    [
      'task-kind semantic mismatch',
      stagedImageSuccess('sha256:wrong-ref', 'example.invalid/other:latest'),
    ],
    [
      'persisted task identity override',
      { ...stagedImageSuccess('sha256:override'), taskId: 'other-task' },
    ],
    [
      'persisted payload hash override',
      { ...stagedImageSuccess('sha256:override-hash'), payloadHash: '0'.repeat(64) },
    ],
  ])('fail-stops immediately for %s without projecting or releasing authority', async (
    _case,
    evidence,
  ) => {
    await insertStagedTask(tasks, locksRepo, evidence);

    await expect(worker.process()).resolves.toBe(0);

    expect(finalizer.applySucceeded).not.toHaveBeenCalled();
    expect(finalizer.applyFailed).not.toHaveBeenCalled();
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: 1,
      finalizerRetryAt: null,
      errorJson: {
        code: 'STAGED_AGENT_RESULT_CORRUPT',
        message: 'Persisted terminal Agent evidence failed immutable task identity validation',
      },
      completedAt: expect.any(Date),
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(blockServer).toHaveBeenCalledWith(
      SERVER_ID,
      `staged Agent evidence is corrupt on ${SERVER_ID}`,
    );
  });

  it('rolls back a failed finalizer and retries only database finalization', async () => {
    const evidence = stagedImageSuccess();
    await insertStagedTask(tasks, locksRepo, evidence);
    finalizer.applySucceeded.mockImplementation(async (manager: EntityManager) => {
      await manager.query('INSERT INTO finalizer_markers (id) VALUES (?)', ['must-rollback']);
      throw new Error('projection unavailable');
    });

    await expect(worker.process()).resolves.toBe(0);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      failureStage: 'finalizer',
      agentResultJson: evidence,
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

  it('makes a FIFO-queued dispatch observe extra-key no-send quarantine from the same commit', async () => {
    const queuedTaskId = 'task-queued-after-corruption';
    const queuedPayload = { dockerRef: 'example.invalid/queued:latest' };
    await dataSource.getRepository(ServerEntity).update(SERVER_ID, {
      status: ServerStatus.Online,
    });
    const noSendEvidence = {
      status: 'failed' as const,
      error: { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' },
      observed: {
        resourceId: 'image-a',
        applied: false,
        reason: 'never_dispatched',
        mounted: true,
      },
    };
    await insertStagedTask(tasks, locksRepo, noSendEvidence);
    await tasks.update(TASK_ID, {
      resourceType: 'image',
      payloadJson: 'corrupt-payload',
      failureStage: 'dispatch',
      startedAt: null,
      lastSentAt: null,
    });
    await tasks.save(tasks.create({
      id: queuedTaskId,
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: SERVER_ID,
      resourceType: 'image',
      resourceId: 'image-queued',
      requestedBy: 'user-a',
      requestJson: null,
      payloadJson: queuedPayload,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.ImageEnsurePresent, payload: queuedPayload }))
        .digest('hex'),
      status: AgentTaskStatus.Pending,
      failureStage: null,
      agentResultJson: null,
      resultJson: null,
      errorJson: null,
      dispatchAttemptCount: 0,
      finalizerAttemptCount: 0,
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
    }));
    await locksRepo.insert({
      resourceKey: 'image:image-queued',
      taskId: queuedTaskId,
      serverId: SERVER_ID,
    });
    const tasksService = new AgentTasksService(
      dataSource,
      {} as never,
      resourceLocks,
      {
        forDispatch: (task: AgentTaskEntity) => task.payloadJson,
        forWirePayload: (_kind: AgentTaskKind, payload: unknown) => payload,
      } as never,
      tasks,
    );

    // Install the coordinator before wrapping transaction entry. The first
    // subsequent transaction is the finalizer transaction; pausing inside it
    // lets markSentAndBuild deterministically enqueue behind its FIFO lease.
    await runSerializedTransaction(dataSource, async () => undefined);
    const originalTransaction = dataSource.transaction.bind(dataSource);
    let firstTransaction = true;
    let resolveEntered!: () => void;
    let resolveRelease!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const release = new Promise<void>((resolve) => { resolveRelease = resolve; });
    vi.spyOn(dataSource, 'transaction').mockImplementation((async (...args: unknown[]) => {
      const isolation = typeof args[0] === 'function' ? null : args[0];
      const work = (typeof args[0] === 'function' ? args[0] : args[1]) as
        (manager: EntityManager) => Promise<unknown>;
      const wrapped = async (manager: EntityManager): Promise<unknown> => {
        if (firstTransaction) {
          firstTransaction = false;
          resolveEntered();
          await release;
        }
        return work(manager);
      };
      return isolation === null
        ? originalTransaction(wrapped)
        : originalTransaction(isolation as 'SERIALIZABLE', wrapped);
    }) as DataSource['transaction']);

    const finalization = worker.process();
    await entered;
    const queuedDispatch = tasksService.markSentAndBuild(queuedTaskId);
    await Promise.resolve();
    resolveRelease();

    await expect(finalization).resolves.toBe(0);
    await expect(queuedDispatch).resolves.toBeNull();
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await tasks.findOneByOrFail({ id: queuedTaskId })).toMatchObject({
      status: AgentTaskStatus.Pending,
      dispatchAttemptCount: 0,
      startedAt: null,
      lastSentAt: null,
    });
  });

  it('bounds non-Error finalizer diagnostics without traversing cyclic values', async () => {
    await insertStagedTask(tasks, locksRepo, stagedImageSuccess());
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
    await insertStagedTask(tasks, locksRepo, stagedImageSuccess());
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
    const evidence = stagedImageSuccess();
    await insertStagedTask(tasks, locksRepo, evidence);
    vi.spyOn(resourceLocks, 'releaseTask').mockImplementation(async (taskId, manager) => {
      if (!manager) throw new Error('transaction manager required');
      await manager.delete(ResourceLockEntity, { taskId });
      throw new Error('lock release interrupted');
    });

    await expect(worker.process()).resolves.toBe(0);

    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Pending,
      failureStage: 'finalizer',
      agentResultJson: evidence,
      resultJson: null,
      completedAt: null,
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('terminalizes an exhausted database finalizer, quarantines the server, and retains evidence and locks', async () => {
    const evidence = stagedImageSuccess();
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
    const error = { code: 'invalid_task_payload', message: 'invalid payload' };
    const observed = { applied: false, reason: 'invalid_payload' };
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
    decodeWirePayload = () => {
      throw new Error('no-send payload codec must not run');
    };

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

  it.each(NEVER_DISPATCHED_CASES)(
    'quarantines exact no-send %s with a wrong row resourceType before finalization',
    async (kind, _resourceType, resourceId, identity) => {
      const evidence = {
        status: 'failed' as const,
        error: { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' },
        observed: { ...identity, applied: false, reason: 'never_dispatched' },
      };
      await insertStagedTask(tasks, locksRepo, evidence);
      await tasks.update(TASK_ID, {
        kind,
        resourceType: 'wrong-resource-type',
        resourceId,
        payloadJson: 'corrupt-payload',
        failureStage: 'dispatch',
        startedAt: null,
        lastSentAt: null,
      });

      await expect(worker.process()).resolves.toBe(0);

      expect(finalizer.applySucceeded).not.toHaveBeenCalled();
      expect(finalizer.applyFailed).not.toHaveBeenCalled();
      expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
        status: AgentTaskStatus.Failed,
        failureStage: 'dispatch',
        agentResultJson: evidence,
        errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT' },
      });
      expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
      expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
        .toMatchObject({ status: ServerStatus.AgentQuarantined });
    },
  );

  it.each(NEVER_DISPATCHED_CASES.flatMap((entry) => [
    [...entry, 'foo', 'bar'] as const,
    [...entry, 'mounted', true] as const,
  ]))(
    'quarantines exact-row no-send %s with extra evidence before finalization',
    async (kind, resourceType, resourceId, identity, extraField, extraValue) => {
      const evidence = {
        status: 'failed' as const,
        error: { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' },
        observed: {
          ...identity,
          applied: false,
          reason: 'never_dispatched',
          [extraField]: extraValue,
        },
      };
      await insertStagedTask(tasks, locksRepo, evidence);
      await locksRepo.insert({
        resourceKey: `secondary:${kind}:${extraField}`,
        taskId: TASK_ID,
        serverId: SERVER_ID,
      });
      await tasks.update(TASK_ID, {
        kind,
        resourceType,
        resourceId,
        payloadJson: 'corrupt-payload',
        failureStage: 'dispatch',
        startedAt: null,
        lastSentAt: null,
      });
      decodeWirePayload = () => {
        throw new Error('extra-key no-send payload codec must not run');
      };

      await expect(worker.process()).resolves.toBe(0);

      expect(finalizer.applySucceeded).not.toHaveBeenCalled();
      expect(finalizer.applyFailed).not.toHaveBeenCalled();
      expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
        status: AgentTaskStatus.Failed,
        failureStage: 'dispatch',
        agentResultJson: evidence,
        errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT' },
      });
      expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(2);
      expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
        .toMatchObject({ status: ServerStatus.AgentQuarantined });
    },
  );

  it.each([
    ['serverId', '', 'empty'],
    ['serverId', 's'.repeat(129), 'overlong'],
    ['serverId', 'bad server', 'invalid-character'],
    ['resourceId', '', 'empty'],
    ['resourceId', 'r'.repeat(129), 'overlong'],
    ['resourceId', 'bad resource', 'invalid-character'],
  ] as const)('quarantines no-send evidence with %s %s row identity', async (
    field,
    value,
    label,
  ) => {
    const resourceId = field === 'resourceId' ? value : 'container-a';
    const evidence = {
      status: 'failed' as const,
      error: { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' },
      observed: { containerId: resourceId, applied: false, reason: 'never_dispatched' },
    };
    await insertStagedTask(tasks, locksRepo, evidence);
    let expectedServerId = SERVER_ID;
    if (field === 'serverId') {
      expectedServerId = value;
      await dataSource.getRepository(ServerEntity).save({
        id: value,
        name: `Invalid ${label} server`,
        slug: `invalid-${label}-server`,
        agentTokenHash: `token-${label}`,
        hostFingerprint: null,
        agentConfigFingerprint: null,
        status: ServerStatus.Unknown,
        lastSeenAt: null,
      });
      await tasks.update(TASK_ID, { serverId: value });
      await locksRepo.update({ taskId: TASK_ID }, { serverId: value });
    }
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.ContainerStart,
      resourceType: 'container',
      resourceId,
      payloadJson: 'corrupt-payload',
      failureStage: 'dispatch',
      startedAt: null,
      lastSentAt: null,
    });

    await expect(worker.process()).resolves.toBe(0);

    expect(finalizer.applyFailed).not.toHaveBeenCalled();
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      agentResultJson: evidence,
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT' },
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: expectedServerId }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
  });

  it('rejects never-dispatched evidence when durable markers prove a prior send', async () => {
    const error = { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' };
    const observed = { containerId: 'container-a', applied: false, reason: 'never_dispatched' };
    await insertStagedTask(tasks, locksRepo, { status: 'failed', error, observed });
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.ContainerStart,
      resourceType: 'container',
      resourceId: 'container-a',
      payloadJson: 'corrupt-payload',
      failureStage: 'dispatch',
      // insertStagedTask deliberately retains non-null startedAt/lastSentAt.
    });

    await expect(worker.process()).resolves.toBe(0);

    expect(finalizer.applyFailed).not.toHaveBeenCalled();
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      failureStage: 'dispatch',
      agentResultJson: { status: 'failed', error, observed },
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT' },
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it.each([
    ['4097 characters', dataDirBoundaryPath(4097)],
    ['NUL', `/bad\0root${DATA_DIR_SUFFIX}`],
    ['CR', `/bad\rroot${DATA_DIR_SUFFIX}`],
    ['LF', `/bad\nroot${DATA_DIR_SUFFIX}`],
    ['relative', `relative${DATA_DIR_SUFFIX}`],
    ['dot segment', `/root/../root${DATA_DIR_SUFFIX}`],
    ['duplicate separator', `/root//nested${DATA_DIR_SUFFIX}`],
    ['near suffix', '/root/.nyabase/dirs/datadir-a/data-near'],
    ['wrong resource', '/root/.nyabase/dirs/datadir-other/data'],
  ])('quarantines staged DataDir evidence with an invalid %s path', async (_case, path) => {
    const payload = dataDirPayload();
    const evidence = stagedDataDirFailure(path);
    await insertStagedTask(tasks, locksRepo, evidence);
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.DataDirEnsure,
      resourceType: 'datadir',
      resourceId: 'datadir-a',
      payloadJson: payload,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.DataDirEnsure, payload }))
        .digest('hex'),
    });

    await expect(worker.process()).resolves.toBe(0);
    expect(finalizer.applyFailed).not.toHaveBeenCalled();
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      agentResultJson: evidence,
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT' },
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('accepts staged DataDir evidence at exactly 4096 path characters', async () => {
    const payload = dataDirPayload();
    const evidence = stagedDataDirFailure(dataDirBoundaryPath(4096));
    await insertStagedTask(tasks, locksRepo, evidence);
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.DataDirEnsure,
      resourceType: 'datadir',
      resourceId: 'datadir-a',
      payloadJson: payload,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.DataDirEnsure, payload }))
        .digest('hex'),
    });

    await expect(worker.process()).resolves.toBe(1);
    expect(finalizer.applyFailed).toHaveBeenCalled();
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
  });

  it('quarantines an ordinary staged payload changed under its original hash', async () => {
    const tamperedPayload = { dockerRef: 'example.invalid/tampered:latest' };
    await insertStagedTask(
      tasks,
      locksRepo,
      stagedImageSuccess('sha256:tampered', tamperedPayload.dockerRef),
    );
    await tasks.update(TASK_ID, { payloadJson: tamperedPayload });

    await expect(worker.process()).resolves.toBe(0);
    expect(finalizer.applySucceeded).not.toHaveBeenCalled();
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT' },
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('quarantines a staged wrong kind/resourceType tuple before semantic projection', async () => {
    const evidence = stagedImageSuccess();
    await insertStagedTask(tasks, locksRepo, evidence);
    await tasks.update(TASK_ID, { resourceType: 'container' });

    await expect(worker.process()).resolves.toBe(0);
    expect(finalizer.applySucceeded).not.toHaveBeenCalled();
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      agentResultJson: evidence,
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT' },
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('quarantines an encrypted RemoteFS secret changed under its original wire hash', async () => {
    const originalWire = cephRemotePayload('b3JpZ2luYWwtc2VjcmV0');
    const stored = cephRemotePayload('enc-old');
    const changedStored = cephRemotePayload('enc-new');
    const evidence = {
      status: 'succeeded' as const,
      result: { id: 'remote-a', hostMountPoint: originalWire.hostMountPoint },
    };
    await insertStagedTask(tasks, locksRepo, evidence);
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.RemoteFsEnsure,
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-a',
      payloadJson: changedStored,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.RemoteFsEnsure, payload: originalWire }))
        .digest('hex'),
    });
    decodeWirePayload = (task) => {
      const payload = task.payloadJson as ReturnType<typeof cephRemotePayload>;
      return cephRemotePayload(
        payload.params.secret === stored.params.secret
          ? originalWire.params.secret
          : 'Y2hhbmdlZC1zZWNyZXQ=',
      );
    };

    await expect(worker.process()).resolves.toBe(0);
    expect(finalizer.applySucceeded).not.toHaveBeenCalled();
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Failed,
      agentResultJson: evidence,
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT' },
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('preserves dispatch origin across a transient no-send finalizer retry', async () => {
    const error = { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' };
    const observed = { containerId: 'container-a', applied: false, reason: 'never_dispatched' };
    await insertStagedTask(tasks, locksRepo, { status: 'failed', error, observed });
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.ContainerStart,
      resourceType: 'container',
      resourceId: 'container-a',
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
    const result = { containerId: 'container-a', runtimeId: null, quotaPaths: [] };
    const payload = {
      containerId: 'container-a',
      runtimeId: null,
      serverId: SERVER_ID,
      specGeneration: null,
      runtimeSpecHash: null,
      numericOwnerId: 42,
      quotaPaths: [],
    };
    await insertStagedTask(tasks, locksRepo, { status: 'succeeded', result });
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.ContainerDelete,
      resourceType: 'container',
      resourceId: 'container-a',
      payloadJson: payload,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.ContainerDelete, payload }))
        .digest('hex'),
    });
    notifyProxySnapshots.mockRejectedValueOnce(new Error('proxy unavailable'));

    await expect(worker.process()).resolves.toBe(1);

    expect(notifyProxySnapshots).toHaveBeenCalledTimes(1);
    expect(notifyProxySnapshots).toHaveBeenCalledWith('container container-a deleted');
    expect(await tasks.findOneByOrFail({ id: TASK_ID })).toMatchObject({
      status: AgentTaskStatus.Succeeded,
      resultJson: result,
      failureStage: null,
    });
    expect(await locksRepo.countBy({ taskId: TASK_ID })).toBe(0);
  });

  it('bumps the access cache epoch only after a RemoteFS finalizer commits', async () => {
    const hostMountPoint = '/mnt/remote-fs/remote-a';
    const payload = {
      id: 'remote-a',
      hostMountPoint,
      options: '',
      params: {
        type: 'nfs' as const,
        nfsServer: 'nfs.internal',
        exportPath: '/exports/a',
        version: '4' as const,
      },
    };
    await insertStagedTask(tasks, locksRepo, {
      status: 'succeeded',
      result: { id: 'remote-a', hostMountPoint },
    });
    await tasks.update(TASK_ID, {
      kind: AgentTaskKind.RemoteFsEnsure,
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-a',
      payloadJson: payload,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.RemoteFsEnsure, payload }))
        .digest('hex'),
    });
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
  const payload = { dockerRef: `example.invalid/${taskId}` };
  await tasks.save(tasks.create({
    id: taskId,
    kind: AgentTaskKind.ImageEnsurePresent,
    serverId: SERVER_ID,
    resourceType: 'image',
    resourceId: `image-${taskId}`,
    requestedBy: 'user-a',
    requestJson: null,
    payloadJson: payload,
    payloadHash: createHash('sha256')
      .update(canonicalJson({ kind: AgentTaskKind.ImageEnsurePresent, payload }))
      .digest('hex'),
    status: AgentTaskStatus.Pending,
    failureStage: null,
    agentResultJson: {
      status: 'succeeded',
      result: {
        imageId: null,
        dockerId: taskId,
        dockerRef: `example.invalid/${taskId}`,
      },
    },
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
    kind: AgentTaskKind.ImageEnsurePresent,
    serverId: SERVER_ID,
    resourceType: 'image',
    resourceId: 'image-a',
    requestedBy: 'user-a',
    requestJson: null,
    payloadJson: IMAGE_PAYLOAD,
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
    resourceKey: 'image:image-a',
    taskId: TASK_ID,
    serverId: SERVER_ID,
  });
}

function stagedImageEvidenceAtWireBytes(targetBytes: number): ReturnType<typeof stagedImageSuccess> & {
  result: ReturnType<typeof stagedImageSuccess>['result'] & { diagnostic: string };
} {
  const evidence = {
    ...stagedImageSuccess(),
    result: { ...stagedImageSuccess().result, diagnostic: '' },
  };
  const baseBytes = Buffer.byteLength(canonicalJson({
    ...evidence,
    taskId: TASK_ID,
    payloadHash: PAYLOAD_HASH,
  }));
  if (targetBytes < baseBytes) throw new Error('target result size is too small');
  evidence.result.diagnostic = 'x'.repeat(targetBytes - baseBytes);
  return evidence;
}

const DATA_DIR_SUFFIX = '/.nyabase/dirs/datadir-a/data';

function dataDirBoundaryPath(length: number): string {
  return `/${'a'.repeat(length - DATA_DIR_SUFFIX.length - 1)}${DATA_DIR_SUFFIX}`;
}

function dataDirPayload() {
  return {
    resourceId: 'datadir-a',
    generation: 1,
    diskId: 'disk-a',
    sourceIdentity: 'local:xfs:disk-a',
    quotaRequired: true,
    uid: 1001,
    numericUserId: 1001,
    quotaGeneration: 1,
    diskBytes: 4096,
  };
}

function stagedDataDirFailure(path: string) {
  return {
    status: 'failed' as const,
    error: { code: 'data_dir_conflict', message: 'observed physical conflict' },
    observed: {
      path,
      expectedResourceId: 'datadir-a',
      resourceId: null,
      exists: false,
      isDirectory: false,
      uid: null,
      gid: null,
    },
  };
}

function cephRemotePayload(secret: string) {
  return {
    id: 'remote-a',
    hostMountPoint: '/mnt/remote-fs/remote-a',
    options: '',
    params: {
      type: 'cephfs' as const,
      monHosts: 'ceph.internal',
      exportPath: '/exports/a',
      clientName: 'nyabase',
      secret,
    },
  };
}
