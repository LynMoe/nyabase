import { AgentTaskKind, ContainerPhase, ServerStatus } from '@nyabase/common';
import type { EntityManager } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { AgentTaskFinalizerService } from './agent-task-finalizer.service.js';

describe('AgentTaskFinalizerService managed failures', () => {
  let manager: {
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    findOneBy: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };
  let service: AgentTaskFinalizerService;

  beforeEach(() => {
    manager = {
      update: vi.fn(),
      delete: vi.fn(),
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockImplementation(async (entity) => entity === QuotaDesiredEntity
        ? {
            id: 'quota-a', serverId: 'server-a', userId: 'user-a', generation: 2,
            numericUserId: 42, limitBytes: 8192, lastTaskId: 'quota-task-a',
          }
        : {
            id: 'assignment-a',
            remoteFsMountId: 'resource-a',
            serverId: 'server-a',
            desiredState: 'active',
            lastTaskId: 'task-a',
          }),
      findOneBy: vi.fn().mockImplementation(async (entity) => {
        if (entity === ContainerEntity) {
          return { id: 'resource-a', serverId: 'server-a' };
        }
        if (entity === ContainerDesiredSpecEntity) {
          return { containerId: 'resource-a', generation: 1 };
        }
        if (entity === ContainerLifecycleEntity) {
          return {
            containerId: 'resource-a',
            phase: ContainerPhase.Updating,
            boundRuntimeId: null,
            activeTaskId: 'task-a',
          };
        }
        if (entity === DataDirectoryEntity) {
          return {
            id: 'resource-a',
            serverId: 'server-a',
            sourceKind: 'local',
            userId: 'user-a',
            sourceId: 'disk-a',
            sourceIdentity: 'xfs-a',
            desiredState: 'creating',
            generation: 1,
            lastTaskId: 'task-a',
          };
        }
        if (entity === RemoteFsMountEntity) {
          return {
            id: 'resource-a',
            type: 'nfs',
            hostMountPoint: '/mnt/remote-a',
            options: '',
            params: { type: 'nfs', nfsServer: 'nfs.example', exportPath: '/data', version: '4.2' },
            desiredState: 'active',
            generation: 1,
          };
        }
        return null;
      }),
    };
    service = new AgentTaskFinalizerService();
  });

  it('binds an observed partial runtime and leaves container.create visibly Failed', async () => {
    mockContainerPhase(ContainerPhase.Provisioning);
    await service.applyFailed(
      manager as unknown as EntityManager,
      task(AgentTaskKind.ContainerCreate),
      { code: 'CREATE_FAILED', message: 'create failed' },
      {
        runtimeId: 'runtime-partial',
        containerId: 'resource-a',
        serverId: 'server-a',
        running: false,
        runtimeSpecHash: 'a'.repeat(64),
        quotaPaths: ['/var/lib/nyabase-docker/overlay/upper', '/var/lib/nyabase-docker/overlay/work'],
      },
    );

    expect(manager.update).toHaveBeenCalledWith(
      ContainerLifecycleEntity,
      'resource-a',
      expect.objectContaining({
        phase: ContainerPhase.Failed,
        boundRuntimeId: 'runtime-partial',
        activeTaskId: null,
        failureCode: 'CREATE_FAILED',
      }),
    );
  });

  it('does not choose a runtime when observation reports duplicate runtime ids', async () => {
    mockContainerPhase(ContainerPhase.Provisioning);
    await service.applyFailed(
      manager as unknown as EntityManager,
      task(AgentTaskKind.ContainerCreate),
      { code: 'RUNTIME_AMBIGUOUS', message: 'duplicate runtimes' },
      { runtimeId: 'runtime-a', runtimeIds: ['runtime-a', 'runtime-b'] },
    );

    const update = manager.update.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(update.phase).toBe(ContainerPhase.Failed);
    expect(update).not.toHaveProperty('boundRuntimeId');
  });

  it('does not bind or persist cleanup paths from terminal no-touch evidence', async () => {
    mockContainerPhase(ContainerPhase.Provisioning);
    await service.applyFailed(
      manager as unknown as EntityManager,
      task(AgentTaskKind.ContainerCreate),
      { code: 'PRECONDITION_FAILED', message: 'no touch' },
      {
        containerId: 'resource-a',
        runtimeId: 'runtime-other',
        applied: false,
        quotaPaths: ['/var/lib/nyabase-docker/other/upper', '/var/lib/nyabase-docker/other/work'],
      },
    );

    const update = manager.update.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(update).not.toHaveProperty('boundRuntimeId');
    expect(update).not.toHaveProperty('quotaPathsJson');
  });

  it('binds the unique runtime recorded by a nested safety rollback', async () => {
    mockContainerPhase(ContainerPhase.Provisioning);
    await service.applyFailed(
      manager as unknown as EntityManager,
      task(AgentTaskKind.ContainerCreate),
      { code: 'CREATE_FAILED', message: 'create failed' },
      {
        quotaPaths: ['/var/lib/nyabase-docker/overlay/upper', '/var/lib/nyabase-docker/overlay/work'],
        safetyRollback: {
          runtimeId: 'runtime-partial',
          containerId: 'resource-a',
          serverId: 'server-a',
          running: false,
          runtimeSpecHash: 'a'.repeat(64),
        },
      },
    );

    expect(manager.update).toHaveBeenCalledWith(
      ContainerLifecycleEntity,
      'resource-a',
      expect.objectContaining({ boundRuntimeId: 'runtime-partial' }),
    );
  });

  it.each([
    AgentTaskKind.ContainerStart,
    AgentTaskKind.ContainerStop,
    AgentTaskKind.ContainerRestart,
    AgentTaskKind.ContainerDelete,
    AgentTaskKind.ContainerSshEnsure,
  ])('marks %s failure as Failed rather than returning to Active', async (kind) => {
    if (kind === AgentTaskKind.ContainerDelete) mockContainerPhase(ContainerPhase.Deleting);
    await service.applyFailed(
      manager as unknown as EntityManager,
      task(kind),
      { code: 'ACTION_FAILED', message: 'action failed' },
      null,
    );

    expect(manager.update).toHaveBeenCalledWith(
      ContainerLifecycleEntity,
      'resource-a',
      expect.objectContaining({ phase: ContainerPhase.Failed, activeTaskId: null }),
    );
  });

  it('returns a pre-application SSH runtime stop to Active without changing desired power', async () => {
    await service.applyFailed(
      manager as unknown as EntityManager,
      {
        ...task(AgentTaskKind.ContainerSshEnsure),
        payloadJson: { containerId: 'resource-a', runtimeId: 'runtime-a' },
      } as AgentTaskEntity,
      { code: 'container_ssh_runtime_stopped', message: 'runtime stopped before SSH convergence' },
      {
        applied: false,
        runtimeId: 'runtime-a',
        containerId: 'resource-a',
        serverId: 'server-a',
        running: false,
        safetyRollback: {
          runtimeId: 'runtime-a',
          containerId: 'resource-a',
          serverId: 'server-a',
          running: false,
        },
      },
    );

    expect(manager.update).toHaveBeenCalledWith(
      ContainerLifecycleEntity,
      'resource-a',
      expect.objectContaining({
        phase: ContainerPhase.Active,
        activeTaskId: null,
        failureCode: null,
      }),
    );
    expect(manager.update).not.toHaveBeenCalledWith(
      ContainerDesiredSpecEntity,
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    {
      errorCode: 'container_ssh_incomplete',
      observed: {
        safetyRollback: {
          runtimeId: 'runtime-a', containerId: 'resource-a', serverId: 'server-a', running: false,
        },
      },
    },
    {
      errorCode: 'container_ssh_runtime_stopped',
      observed: {
        applied: false,
        safetyRollback: {
          runtimeId: 'runtime-other', containerId: 'resource-a', serverId: 'server-a', running: false,
        },
      },
    },
    {
      errorCode: 'container_ssh_runtime_stopped',
      observed: {
        applied: false,
        runtimeId: 'runtime-other',
        containerId: 'resource-a',
        serverId: 'server-a',
        running: false,
        safetyRollback: {
          runtimeId: 'runtime-a', containerId: 'resource-a', serverId: 'server-a', running: false,
        },
      },
    },
  ])('keeps actual or mismatched SSH safety-stop evidence failed ($errorCode)', async ({
    errorCode,
    observed,
  }) => {
    await service.applyFailed(
      manager as unknown as EntityManager,
      {
        ...task(AgentTaskKind.ContainerSshEnsure),
        payloadJson: { containerId: 'resource-a', runtimeId: 'runtime-a' },
      } as AgentTaskEntity,
      { code: errorCode, message: 'SSH convergence failed' },
      observed,
    );

    expect(manager.update).toHaveBeenCalledWith(
      ContainerLifecycleEntity,
      'resource-a',
      expect.objectContaining({ phase: ContainerPhase.Failed, failureCode: errorCode }),
    );
    expect(manager.update).toHaveBeenCalledWith(
      ContainerDesiredSpecEntity,
      { containerId: 'resource-a' },
      expect.objectContaining({ powerIntent: 'stopped' }),
    );
  });

  it('does not classify runtime-less SSH task identity as an exact pre-application stop', async () => {
    await service.applyFailed(
      manager as unknown as EntityManager,
      {
        ...task(AgentTaskKind.ContainerSshEnsure),
        payloadJson: { containerId: 'resource-a' },
      } as AgentTaskEntity,
      { code: 'container_ssh_runtime_stopped', message: 'SSH convergence failed' },
      {
        applied: false,
        containerId: 'resource-a',
        serverId: 'server-a',
        running: false,
        safetyRollback: {
          containerId: 'resource-a', serverId: 'server-a', running: false,
        },
      },
    );

    expect(manager.update).toHaveBeenCalledWith(
      ContainerLifecycleEntity,
      'resource-a',
      expect.objectContaining({ phase: ContainerPhase.Failed }),
    );
  });

  it('finalizes a corrupt never-dispatched container payload without inferring power state', async () => {
    mockContainerPhase(ContainerPhase.Updating);
    const dispatchTask = {
      ...task(AgentTaskKind.ContainerStart),
      payloadJson: 'corrupt-payload',
      failureStage: 'dispatch',
    } as AgentTaskEntity;
    await service.applyFailed(
      manager as unknown as EntityManager,
      dispatchTask,
      { code: 'DISPATCH_PAYLOAD_INVALID', message: 'cannot encode payload' },
      { containerId: 'resource-a', applied: false, reason: 'never_dispatched' },
    );

    expect(manager.update).toHaveBeenCalledWith(
      ContainerLifecycleEntity,
      'resource-a',
      expect.objectContaining({ phase: ContainerPhase.Failed, activeTaskId: null }),
    );
    expect(manager.update).not.toHaveBeenCalledWith(
      ContainerDesiredSpecEntity,
      expect.anything(),
      expect.anything(),
    );
  });

  it('finalizes a corrupt never-dispatched DataDir payload from projection ownership', async () => {
    mockDataDirState('creating');
    const dispatchTask = {
      ...task(AgentTaskKind.DataDirEnsure),
      payloadJson: 'corrupt-payload',
      failureStage: 'dispatch',
    } as AgentTaskEntity;

    await service.applyFailed(
      manager as unknown as EntityManager,
      dispatchTask,
      { code: 'DISPATCH_PAYLOAD_INVALID', message: 'cannot encode payload' },
      { expectedResourceId: 'resource-a', applied: false, reason: 'never_dispatched' },
    );

    expect(manager.update).toHaveBeenCalledWith(
      DataDirectoryEntity,
      'resource-a',
      expect.objectContaining({ desiredState: 'failed' }),
    );
  });

  it('rejects forged never-dispatched evidence when the task records a prior send', async () => {
    const dispatchTask = {
      ...task(AgentTaskKind.ContainerStart),
      payloadJson: 'corrupt-payload',
      failureStage: 'dispatch',
      dispatchAttemptCount: 1,
      startedAt: new Date('2026-07-15T00:00:00.000Z'),
      lastSentAt: new Date('2026-07-15T00:00:00.000Z'),
    } as AgentTaskEntity;

    await expect(service.applyFailed(
      manager as unknown as EntityManager,
      dispatchTask,
      { code: 'DISPATCH_PAYLOAD_INVALID', message: 'cannot encode payload' },
      { containerId: 'resource-a', applied: false, reason: 'never_dispatched' },
    )).rejects.toThrow(/prior send/);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('does not mutate a durable container projection for runtime drift cleanup results', async () => {
    const quotaPaths = ['/docker/overlay/upper', '/docker/overlay/work'];
    const cleanup = {
      ...task(AgentTaskKind.ContainerRuntimeAbsent),
      resourceId: 'runtime-extra',
      payloadJson: {
        runtimeId: 'runtime-extra', containerId: 'resource-a', serverId: 'server-a',
        specGeneration: '3', runtimeSpecHash: 'a'.repeat(64), quotaPaths,
        observedIp: '10.0.0.55',
      },
    };
    manager.find.mockResolvedValueOnce([
      {
        id: 'claim-old',
        address: '10.0.0.54',
        cleanupPayloadJson: { ...cleanup.payloadJson, observedIp: '10.0.0.54' },
      },
      {
        id: 'claim-current',
        address: '10.0.0.55',
        cleanupPayloadJson: cleanup.payloadJson,
      },
    ]);

    await service.applySucceeded(manager as unknown as EntityManager, cleanup, {
      containerId: 'resource-a', runtimeId: null,
    });
    await service.applyFailed(manager as unknown as EntityManager, cleanup, {
      code: 'identity_changed', message: 'identity changed',
    }, { applied: false });

    expect(manager.update).toHaveBeenCalledTimes(3);
    expect(manager.update).toHaveBeenCalledWith(
      NetworkAddressClaimEntity,
      'claim-old',
      { state: 'releasing', reusableAt: expect.any(Date) },
    );
    expect(manager.update).toHaveBeenCalledWith(
      NetworkAddressClaimEntity,
      'claim-current',
      { state: 'releasing', reusableAt: expect.any(Date) },
    );
    expect(manager.update).toHaveBeenCalledWith(
      ServerEntity,
      'server-a',
      { status: ServerStatus.AgentQuarantined },
    );
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('rejects runtime cleanup claims whose immutable runtime identity conflicts', async () => {
    const payloadJson = {
      runtimeId: 'runtime-extra', containerId: 'resource-a', serverId: 'server-a',
      specGeneration: '3', runtimeSpecHash: 'a'.repeat(64),
      quotaPaths: ['/docker/overlay/upper', '/docker/overlay/work'],
      observedIp: '10.0.0.55',
    };
    const cleanup = {
      ...task(AgentTaskKind.ContainerRuntimeAbsent),
      resourceId: 'runtime-extra',
      payloadJson,
    };
    manager.find.mockResolvedValueOnce([
      {
        id: 'claim-current',
        address: '10.0.0.55',
        cleanupPayloadJson: payloadJson,
      },
      {
        id: 'claim-conflict',
        address: '10.0.0.56',
        cleanupPayloadJson: {
          ...payloadJson,
          observedIp: '10.0.0.56',
          runtimeSpecHash: 'b'.repeat(64),
        },
      },
    ]);

    await expect(service.applySucceeded(
      manager as unknown as EntityManager,
      cleanup,
      { containerId: 'resource-a', runtimeId: null },
    )).rejects.toThrow(/conflicts with address claim claim-conflict/);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('marks a failed RemoteFS ensure assignment failed so bootstrap excludes it', async () => {
    await service.applyFailed(
      manager as unknown as EntityManager,
      task(AgentTaskKind.RemoteFsEnsure),
      { code: 'MOUNT_CONFLICT', message: 'unexpected mount source' },
      null,
    );

    expect(manager.update).toHaveBeenCalledWith(
      RemoteFsServerAssignmentEntity,
      { id: 'assignment-a' },
      { desiredState: 'failed', lastTaskId: 'task-a' },
    );
  });

  it('marks a terminal DataDir delete failure retryable without reactivating it', async () => {
    mockDataDirState('removing');
    await service.applyFailed(
      manager as unknown as EntityManager,
      task(AgentTaskKind.DataDirAbsent),
      { code: 'ABSENT_CONFLICT', message: 'physical state is ambiguous' },
      null,
    );

    expect(manager.update).toHaveBeenCalledWith(
      DataDirectoryEntity,
      'resource-a',
      expect.objectContaining({ desiredState: 'failed' }),
    );
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('does not reactivate RemoteFS absent after a fail-closed terminal result', async () => {
    manager.findOne.mockResolvedValue({
      id: 'assignment-a',
      remoteFsMountId: 'resource-a',
      serverId: 'server-a',
      desiredState: 'removing',
      lastTaskId: 'task-a',
    });
    await service.applyFailed(
      manager as unknown as EntityManager,
      task(AgentTaskKind.RemoteFsAbsent),
      { code: 'ABSENT_CONFLICT', message: 'physical state is ambiguous' },
      null,
    );

    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('finalizes quota only when the task still owns the exact durable desired generation', async () => {
    const quotaTask = {
      ...task(AgentTaskKind.QuotaEnsure),
      resourceId: 'user-a',
      payloadJson: { generation: 3, numericUserId: 1001, diskBytes: 4096 },
    } as AgentTaskEntity;
    manager.findOne.mockImplementation(async (entity) => entity === QuotaDesiredEntity
      ? {
          id: 'quota-a', serverId: 'server-a', userId: 'user-a', generation: 3,
          numericUserId: 1001, limitBytes: 4096, lastTaskId: 'task-a',
        }
      : null);

    await expect(service.applySucceeded(
      manager as unknown as EntityManager,
      quotaTask,
      { numericUserId: 1001, hardLimitBytes: 4096 },
    )).resolves.toBeUndefined();

    manager.findOne.mockResolvedValueOnce({
      id: 'quota-a', serverId: 'server-a', userId: 'user-a', generation: 4,
      numericUserId: 1001, limitBytes: 1024, lastTaskId: 'task-new',
    });
    await expect(service.applySucceeded(
      manager as unknown as EntityManager,
      quotaTask,
      { numericUserId: 1001, hardLimitBytes: 4096 },
    )).rejects.toThrow(/no longer matches/);
  });

  it('never reconstructs a missing container projection from a stale create result', async () => {
    manager.findOneBy.mockImplementation(async (entity) => {
      if (entity === ContainerEntity) return null;
      if (entity === ContainerDesiredSpecEntity) return { containerId: 'resource-a', generation: 1 };
      if (entity === ContainerLifecycleEntity) {
        return {
          containerId: 'resource-a', phase: ContainerPhase.Provisioning, activeTaskId: 'task-a',
        };
      }
      return null;
    });

    await expect(service.applySucceeded(
      manager as unknown as EntityManager,
      task(AgentTaskKind.ContainerCreate),
      {
        runtimeId: 'runtime-a',
        runtimeSpecHash: 'a'.repeat(64),
        quotaPaths: ['/var/lib/nyabase-docker/overlay/upper', '/var/lib/nyabase-docker/overlay/work'],
      },
    )).rejects.toThrow(/projection is missing/);
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('rejects a container result when another task owns the lifecycle', async () => {
    mockContainerPhase(ContainerPhase.Updating, 'task-new');
    await expect(service.applyFailed(
      manager as unknown as EntityManager,
      task(AgentTaskKind.ContainerStart),
      { code: 'STALE', message: 'stale result' },
      { containerId: 'resource-a', running: false },
    )).rejects.toThrow(/no longer owns/);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('rejects a DataDir result when another generation owns the projection', async () => {
    mockDataDirState('creating', 'task-new');
    await expect(service.applySucceeded(
      manager as unknown as EntityManager,
      task(AgentTaskKind.DataDirEnsure),
      { expectedResourceId: 'resource-a', present: true },
    )).rejects.toThrow(/no longer owns/);
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
  });

  function mockContainerPhase(phase: ContainerPhase, activeTaskId = 'task-a'): void {
    const original = manager.findOneBy.getMockImplementation() as
      | ((...args: unknown[]) => unknown)
      | undefined;
    manager.findOneBy.mockImplementation(async (entity, where) => {
      if (entity === ContainerLifecycleEntity) {
        return {
          containerId: 'resource-a', phase, boundRuntimeId: null, activeTaskId,
        };
      }
      return original?.(entity, where);
    });
  }

  function mockDataDirState(
    desiredState: 'creating' | 'removing',
    lastTaskId = 'task-a',
  ): void {
    const original = manager.findOneBy.getMockImplementation() as
      | ((...args: unknown[]) => unknown)
      | undefined;
    manager.findOneBy.mockImplementation(async (entity, where) => {
      if (entity === DataDirectoryEntity) {
        return {
          id: 'resource-a',
          serverId: 'server-a',
          sourceKind: 'local',
          userId: 'user-a',
          sourceId: 'disk-a',
          sourceIdentity: 'xfs-a',
          desiredState,
          generation: 1,
          lastTaskId,
        };
      }
      return original?.(entity, where);
    });
  }
});

function task(kind: AgentTaskKind): AgentTaskEntity {
  const isContainer = [
    AgentTaskKind.ContainerCreate,
    AgentTaskKind.ContainerStart,
    AgentTaskKind.ContainerStop,
    AgentTaskKind.ContainerRestart,
    AgentTaskKind.ContainerDelete,
    AgentTaskKind.ContainerSshEnsure,
  ].includes(kind);
  const isDataDir = kind === AgentTaskKind.DataDirEnsure || kind === AgentTaskKind.DataDirAbsent;
  return {
    id: 'task-a',
    kind,
    serverId: 'server-a',
    resourceType: isContainer ? 'container' : isDataDir ? 'datadir' : 'resource',
    resourceId: 'resource-a',
    payloadHash: 'a'.repeat(64),
    status: 'pending',
    failureStage: null,
    agentResultJson: null,
    dispatchAttemptCount: 0,
    startedAt: null,
    lastSentAt: null,
    payloadJson: isContainer
      ? { containerId: 'resource-a', ...(kind === AgentTaskKind.ContainerCreate ? { specGeneration: 1 } : {}) }
      : isDataDir
        ? {
          resourceId: 'resource-a', generation: 1, diskId: 'disk-a', sourceIdentity: 'xfs-a',
          ...(kind === AgentTaskKind.DataDirEnsure
            ? { numericUserId: 42, quotaGeneration: 2, diskBytes: 8192, uid: 1001, quotaRequired: true }
            : { numericUserId: 42 }),
        }
        : null,
    requestJson: kind === AgentTaskKind.RemoteFsEnsure
      ? {
          scope: 'assign',
          mount: {
            id: 'resource-a',
            type: 'nfs',
            hostMountPoint: '/mnt/remote-a',
            options: '',
            params: { type: 'nfs', nfsServer: 'nfs.example', exportPath: '/data', version: '4.2' },
            generation: 1,
          },
        }
      : kind === AgentTaskKind.RemoteFsAbsent
        ? { scope: 'assignment' }
        : null,
  } as AgentTaskEntity;
}
