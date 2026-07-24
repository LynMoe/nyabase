import { createHash } from 'node:crypto';
import {
  AgentTaskKind,
  AgentTaskStatus,
  MAX_AGENT_TASK_RESULT_BYTES,
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
const PAYLOAD_HASH = createHash('sha256')
  .update(canonicalJson({ kind: AgentTaskKind.ImageEnsurePresent, payload: PAYLOAD }))
  .digest('hex');

const NEVER_DISPATCHED_CASES = [
  [AgentTaskKind.ContainerCreate, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerStart, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerStop, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerRestart, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerSshEnsure, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerDelete, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerRuntimeAbsent, 'runtime-a', { expectedRuntimeId: 'runtime-a' }],
  [AgentTaskKind.DataDirEnsure, 'datadir-a', { expectedResourceId: 'datadir-a' }],
  [AgentTaskKind.DataDirAbsent, 'datadir-a', { expectedResourceId: 'datadir-a' }],
  [AgentTaskKind.RemoteFsEnsure, 'remote-a', { id: 'remote-a' }],
  [AgentTaskKind.RemoteFsAbsent, 'remote-a', { id: 'remote-a' }],
  [AgentTaskKind.QuotaEnsure, 'user-a', { resourceId: 'user-a' }],
  [AgentTaskKind.ImageEnsurePresent, 'image-a', { resourceId: 'image-a' }],
  [AgentTaskKind.ImageEnsureAbsent, 'image-a', { resourceId: 'image-a' }],
] as const;

describe('Agent task invalid-result quarantine retry', () => {
  let dataSource: DataSource;
  let service: AgentTasksService;
  let decodeWirePayload: (task: AgentTaskEntity) => unknown;

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
      payloadHash: PAYLOAD_HASH,
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
    decodeWirePayload = (task) => task.payloadJson;
    service = new AgentTasksService(
      dataSource,
      {} as never,
      {} as never,
      {
        forDispatch: vi.fn((task: AgentTaskEntity) => decodeWirePayload(task)),
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
    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).resolves.toEqual([TASK_ID]);

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

  it('does not open the mutation transaction when the authorization-aware fence refuses admission', async () => {
    const authorizeInTransaction = vi.fn();
    const runWithSessionFence = async <T>(_work: () => Promise<T>): Promise<T> => {
      throw new Error('authority revoked');
    };

    await expect(service.retryAgentQuarantine(
      SERVER_ID,
      authorizeInTransaction,
      runWithSessionFence,
    )).rejects.toThrow('authority revoked');

    expect(authorizeInTransaction).not.toHaveBeenCalled();
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({ status: AgentTaskStatus.Failed });
  });

  it('rechecks authority inside the mutation transaction after acquiring the Agent fence', async () => {
    const fenceInvocation = vi.fn();
    const runWithSessionFence = async <T>(work: () => Promise<T>): Promise<T> => {
      fenceInvocation();
      return work();
    };

    await expect(service.retryAgentQuarantine(
      SERVER_ID,
      async () => { throw new Error('authority revoked'); },
      runWithSessionFence,
    )).rejects.toThrow('authority revoked');

    expect(fenceInvocation).toHaveBeenCalledOnce();
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({ status: AgentTaskStatus.Failed });
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

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).resolves.toHaveLength(9);

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

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    ))
      .rejects.toMatchObject({ response: { code: 'AGENT_QUARANTINE_LOCK_MISSING' } });

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({ status: AgentTaskStatus.Failed });
  });

  it('retries only database finalization after finalizer exhaustion and never reopens physical dispatch', async () => {
    const evidence = {
      status: 'succeeded',
      result: {
        imageId: null,
        dockerId: 'sha256:a',
        dockerRef: PAYLOAD.dockerRef,
      },
    };
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: 12,
      errorJson: {
        code: 'FINALIZER_RETRY_EXHAUSTED',
        message: 'projection defect',
      },
    } as never);

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).resolves.toEqual([TASK_ID]);

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

  it('accepts finalizer evidence exactly at the reconstructed result byte limit', async () => {
    const evidence = stagedImageEvidenceAtWireBytes(MAX_AGENT_TASK_RESULT_BYTES);
    await stageFinalizerFailure(dataSource, evidence);

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).resolves.toEqual([TASK_ID]);

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.Unknown });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Pending,
        admissionClass: 'safety',
        agentResultJson: evidence,
        finalizerAttemptCount: 0,
        errorJson: null,
      });
  });

  it('keeps quarantine atomically unchanged for finalizer evidence one byte over the limit', async () => {
    const evidence = stagedImageEvidenceAtWireBytes(MAX_AGENT_TASK_RESULT_BYTES + 1);
    await stageFinalizerFailure(dataSource, evidence);

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).rejects.toMatchObject({
      response: { code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT' },
    });

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Failed,
        failureStage: 'finalizer',
        agentResultJson: evidence,
        finalizerAttemptCount: 12,
        errorJson: { code: 'FINALIZER_RETRY_EXHAUSTED' },
      });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it.each([
    [
      'task-kind semantic mismatch',
      {
        status: 'succeeded',
        result: {
          imageId: null,
          dockerId: 'sha256:a',
          dockerRef: 'example.invalid/wrong:latest',
        },
      },
    ],
    [
      'persisted task identity override',
      {
        taskId: 'other-task',
        status: 'succeeded',
        result: {
          imageId: null,
          dockerId: 'sha256:a',
          dockerRef: PAYLOAD.dockerRef,
        },
      },
    ],
    [
      'persisted payload hash override',
      {
        payloadHash: '0'.repeat(64),
        status: 'succeeded',
        result: {
          imageId: null,
          dockerId: 'sha256:a',
          dockerRef: PAYLOAD.dockerRef,
        },
      },
    ],
  ])('keeps quarantine and retained authority for corrupt staged evidence: %s', async (
    _case,
    evidence,
  ) => {
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: 12,
      errorJson: {
        code: 'FINALIZER_RETRY_EXHAUSTED',
        message: 'projection defect',
      },
    } as never);

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).rejects.toMatchObject({
      response: { code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT' },
    });

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Failed,
        failureStage: 'finalizer',
        agentResultJson: evidence,
        errorJson: { code: 'FINALIZER_RETRY_EXHAUSTED' },
      });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('retries repaired staged-corrupt evidence through the finalizer only', async () => {
    const repairedEvidence = {
      status: 'succeeded',
      result: {
        imageId: null,
        dockerId: 'sha256:repaired',
        dockerRef: PAYLOAD.dockerRef,
      },
    };
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      failureStage: 'finalizer',
      agentResultJson: repairedEvidence,
      finalizerAttemptCount: 1,
      errorJson: {
        code: 'STAGED_AGENT_RESULT_CORRUPT',
        message: 'evidence was repaired out of band',
      },
    } as never);

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).resolves.toEqual([TASK_ID]);

    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Pending,
        admissionClass: 'safety',
        failureStage: null,
        agentResultJson: repairedEvidence,
        dispatchAttemptCount: 1,
        finalizerAttemptCount: 0,
        errorJson: null,
        completedAt: null,
      });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('keeps quarantine when repaired evidence reinterprets a payload under its old hash', async () => {
    const tamperedPayload = { dockerRef: 'example.invalid/tampered:latest' };
    const evidence = {
      status: 'succeeded',
      result: {
        imageId: null,
        dockerId: 'sha256:tampered',
        dockerRef: tamperedPayload.dockerRef,
      },
    };
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      payloadJson: tamperedPayload,
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: 1,
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT', message: 'repair pending' },
    } as never);

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).rejects.toMatchObject({
      response: { code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT' },
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('keeps quarantine for a repaired wrong kind/resourceType tuple', async () => {
    const evidence = {
      status: 'succeeded',
      result: { imageId: null, dockerId: 'sha256:a', dockerRef: PAYLOAD.dockerRef },
    };
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      resourceType: 'container',
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: 1,
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT', message: 'repair pending' },
    } as never);

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).rejects.toMatchObject({
      response: { code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT' },
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it.each(NEVER_DISPATCHED_CASES)(
    'keeps quarantine for repaired exact no-send %s with a wrong row resourceType',
    async (kind, resourceId, identity) => {
      const evidence = {
        status: 'failed' as const,
        error: { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' },
        observed: { ...identity, applied: false, reason: 'never_dispatched' },
      };
      await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
        kind,
        resourceType: 'wrong-resource-type',
        resourceId,
        payloadJson: 'corrupt-payload',
        failureStage: 'finalizer',
        agentResultJson: evidence,
        finalizerAttemptCount: 12,
        errorJson: { code: 'FINALIZER_RETRY_EXHAUSTED', message: 'projection defect' },
        startedAt: null,
        lastSentAt: null,
      } as never);
      await expect(service.retryAgentQuarantine(
        SERVER_ID, async () => undefined, async (work) => work(),
      )).rejects.toMatchObject({
        response: { code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT' },
      });

      expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
        .toMatchObject({ status: ServerStatus.AgentQuarantined });
      expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
        .toMatchObject({
          status: AgentTaskStatus.Failed,
          failureStage: 'finalizer',
          agentResultJson: evidence,
          errorJson: { code: 'FINALIZER_RETRY_EXHAUSTED' },
        });
      expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
    },
  );

  it.each(NEVER_DISPATCHED_CASES.flatMap((entry) => [
    [...entry, 'foo', 'bar'] as const,
    [...entry, 'mounted', true] as const,
  ]))(
    'keeps quarantine for repaired exact-row no-send %s with extra evidence',
    async (kind, resourceId, identity, extraField, extraValue) => {
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
      const originalError = { code: 'FINALIZER_RETRY_EXHAUSTED', message: 'projection defect' };
      await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
        kind,
        resourceType: resourceTypeFor(kind),
        resourceId,
        payloadJson: 'corrupt-payload',
        failureStage: 'finalizer',
        agentResultJson: evidence,
        finalizerAttemptCount: 12,
        errorJson: originalError,
        startedAt: null,
        lastSentAt: null,
      } as never);
      await dataSource.getRepository(ResourceLockEntity).insert({
        resourceKey: `secondary:${kind}:${extraField}`,
        taskId: TASK_ID,
        serverId: SERVER_ID,
      });
      decodeWirePayload = () => {
        throw new Error('extra-key no-send payload codec must not run');
      };

      await expect(service.retryAgentQuarantine(
        SERVER_ID, async () => undefined, async (work) => work(),
      )).rejects.toMatchObject({
        response: { code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT' },
      });

      expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
        .toMatchObject({ status: ServerStatus.AgentQuarantined });
      expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
        .toMatchObject({
          status: AgentTaskStatus.Failed,
          failureStage: 'finalizer',
          agentResultJson: evidence,
          finalizerAttemptCount: 12,
          errorJson: originalError,
          startedAt: null,
          lastSentAt: null,
        });
      expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(2);
    },
  );

  it.each([
    ['serverId', '', 'empty'],
    ['serverId', 's'.repeat(129), 'overlong'],
    ['serverId', 'bad server', 'invalid-character'],
    ['resourceId', '', 'empty'],
    ['resourceId', 'r'.repeat(129), 'overlong'],
    ['resourceId', 'bad resource', 'invalid-character'],
  ] as const)('keeps quarantine for repaired no-send evidence with %s %s row identity', async (
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
    let expectedServerId = SERVER_ID;
    if (field === 'serverId') {
      expectedServerId = value;
      await dataSource.getRepository(ServerEntity).save({
        id: value,
        name: `Invalid ${label} server`,
        slug: `invalid-${label}-repair-server`,
        agentTokenHash: `token-${label}`,
        hostFingerprint: null,
        agentConfigFingerprint: null,
        status: ServerStatus.AgentQuarantined,
        lastSeenAt: null,
      });
      await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, { serverId: value });
      await dataSource.getRepository(ResourceLockEntity).update({ taskId: TASK_ID }, { serverId: value });
    }
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      kind: AgentTaskKind.ContainerStart,
      resourceType: 'container',
      resourceId,
      payloadJson: 'corrupt-payload',
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: 12,
      errorJson: { code: 'FINALIZER_RETRY_EXHAUSTED', message: 'projection defect' },
      startedAt: null,
      lastSentAt: null,
    } as never);

    await expect(service.retryAgentQuarantine(
      expectedServerId, async () => undefined, async (work) => work(),
    )).rejects.toMatchObject({
      response: { code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT' },
    });

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: expectedServerId }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Failed,
        failureStage: 'finalizer',
        agentResultJson: evidence,
        errorJson: { code: 'FINALIZER_RETRY_EXHAUSTED' },
      });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('preserves valid historical exact no-send evidence without invoking the payload codec', async () => {
    const evidence = {
      status: 'failed' as const,
      error: { code: 'DISPATCH_PAYLOAD_INVALID', message: 'corrupt durable payload' },
      observed: { resourceId: 'image-a', applied: false, reason: 'never_dispatched' },
    };
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      payloadJson: 'corrupt-payload',
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: 12,
      errorJson: { code: 'FINALIZER_RETRY_EXHAUSTED', message: 'projection defect' },
      startedAt: null,
      lastSentAt: null,
    } as never);
    decodeWirePayload = () => {
      throw new Error('historical no-send payload codec must not run');
    };

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).resolves.toEqual([TASK_ID]);

    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.Unknown });
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({
        status: AgentTaskStatus.Pending,
        admissionClass: 'safety',
        failureStage: 'dispatch',
        agentResultJson: evidence,
        errorJson: null,
      });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('keeps quarantine when the encrypted RemoteFS secret changed under its old wire hash', async () => {
    const originalWire = cephRemotePayload('b3JpZ2luYWwtc2VjcmV0');
    const stored = cephRemotePayload('enc-new');
    const evidence = {
      status: 'succeeded',
      result: { id: 'remote-a', hostMountPoint: originalWire.hostMountPoint },
    };
    await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
      kind: AgentTaskKind.RemoteFsEnsure,
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-a',
      payloadJson: stored,
      payloadHash: createHash('sha256')
        .update(canonicalJson({ kind: AgentTaskKind.RemoteFsEnsure, payload: originalWire }))
        .digest('hex'),
      failureStage: 'finalizer',
      agentResultJson: evidence,
      finalizerAttemptCount: 1,
      errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT', message: 'repair pending' },
    } as never);
    decodeWirePayload = () => cephRemotePayload('Y2hhbmdlZC1zZWNyZXQ=');

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).rejects.toMatchObject({
      response: { code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT' },
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
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
  ])('keeps quarantine for repaired DataDir evidence with an invalid %s path', async (_case, path) => {
    await stageDataDirRepair(dataSource, path);
    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).rejects.toMatchObject({
      response: { code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT' },
    });
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
    expect(await dataSource.getRepository(ResourceLockEntity).countBy({ taskId: TASK_ID })).toBe(1);
  });

  it('accepts repaired DataDir evidence at exactly 4096 path characters', async () => {
    await stageDataDirRepair(dataSource, dataDirBoundaryPath(4096));
    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).resolves.toEqual([TASK_ID]);
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: TASK_ID }))
      .toMatchObject({ status: AgentTaskStatus.Pending, agentResultJson: expect.any(Object) });
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

    await expect(service.retryAgentQuarantine(
      SERVER_ID, async () => undefined, async (work) => work(),
    )).resolves.toEqual([TASK_ID]);

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

type StagedImageEvidence = {
  status: 'succeeded';
  result: {
    imageId: null;
    dockerId: string;
    dockerRef: string;
    diagnostic: string;
  };
};

function stagedImageEvidenceAtWireBytes(targetBytes: number): StagedImageEvidence {
  const evidence: StagedImageEvidence = {
    status: 'succeeded',
    result: {
      imageId: null,
      dockerId: 'sha256:a',
      dockerRef: PAYLOAD.dockerRef,
      diagnostic: '',
    },
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

async function stageFinalizerFailure(
  dataSource: DataSource,
  evidence: StagedImageEvidence,
): Promise<void> {
  await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
    failureStage: 'finalizer',
    agentResultJson: evidence,
    finalizerAttemptCount: 12,
    errorJson: {
      code: 'FINALIZER_RETRY_EXHAUSTED',
      message: 'projection defect',
    },
  } as never);
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

async function stageDataDirRepair(dataSource: DataSource, path: string): Promise<void> {
  const payload = dataDirPayload();
  await dataSource.getRepository(AgentTaskEntity).update(TASK_ID, {
    kind: AgentTaskKind.DataDirEnsure,
    resourceType: 'datadir',
    resourceId: 'datadir-a',
    payloadJson: payload,
    payloadHash: createHash('sha256')
      .update(canonicalJson({ kind: AgentTaskKind.DataDirEnsure, payload }))
      .digest('hex'),
    failureStage: 'finalizer',
    agentResultJson: {
      status: 'failed',
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
    },
    finalizerAttemptCount: 1,
    errorJson: { code: 'STAGED_AGENT_RESULT_CORRUPT', message: 'repair pending' },
  } as never);
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

function resourceTypeFor(kind: AgentTaskKind): string {
  if (kind === AgentTaskKind.ContainerRuntimeAbsent) return 'container_runtime';
  if (kind === AgentTaskKind.DataDirEnsure || kind === AgentTaskKind.DataDirAbsent) return 'datadir';
  if (kind === AgentTaskKind.RemoteFsEnsure || kind === AgentTaskKind.RemoteFsAbsent) return 'remote_fs_mount';
  if (kind === AgentTaskKind.QuotaEnsure) return 'quota';
  if (kind === AgentTaskKind.ImageEnsurePresent || kind === AgentTaskKind.ImageEnsureAbsent) return 'image';
  return 'container';
}
