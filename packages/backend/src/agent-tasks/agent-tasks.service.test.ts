import { AgentTaskKind, AgentTaskStatus, ServerStatus } from '@nyabase/common';
import { IsNull, type EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import {
  AgentTasksService,
  MAX_AGENT_TASK_INCOMPLETE_RESULTS,
} from './agent-tasks.service.js';
import {
  MAX_AGENT_TASK_ROWS_HARD,
  MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW,
} from './agent-task-retention.service.js';

describe('AgentTasksService startup payload boundary', () => {
  it('does not decrypt a staged RemoteFS result after its encryption key is lost', async () => {
    const forDispatch = vi.fn(() => {
      throw new Error('cannot decrypt RemoteFS secret');
    });
    const staged = {
      ...startupTask(AgentTaskKind.RemoteFsEnsure),
      agentResultJson: {
        status: 'failed',
        error: { code: 'MOUNT_FAILED', message: 'mount failed' },
        observed: { id: 'resource-a', mounted: false },
      },
    } as AgentTaskEntity;
    const find = vi.fn()
      .mockResolvedValueOnce([{ id: staged.id }])
      .mockResolvedValueOnce([]);
    const findOneBy = vi.fn().mockResolvedValue(staged);
    const service = new AgentTasksService(
      {} as never,
      {} as never,
      {} as never,
      { forDispatch } as never,
      { find, findOneBy } as never,
    );

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true },
      where: expect.objectContaining({
        status: AgentTaskStatus.Pending,
        agentResultJson: expect.objectContaining({ _type: 'isNull' }),
      }),
      order: { id: 'ASC' },
      take: 128,
    }));
    expect(forDispatch).not.toHaveBeenCalled();
  });

  it('stages a corrupt never-dispatched payload and continues startup', async () => {
    const task = startupTask(AgentTaskKind.ContainerStart);
    const update = vi.fn().mockResolvedValue(undefined);
    const manager = {
      findOne: vi.fn().mockResolvedValue(task),
      update,
    };
    const dataSource = {
      options: { type: 'postgres' },
      transaction: vi.fn(async (_isolation: string, work: (value: unknown) => Promise<unknown>) => work(manager)),
    };
    const find = vi.fn()
      .mockResolvedValueOnce([{ id: task.id }])
      .mockResolvedValueOnce([]);
    const findOneBy = vi.fn().mockResolvedValue(task);
    const blockServer = vi.fn();
    const service = new AgentTasksService(
      dataSource as never,
      {} as never,
      {} as never,
      { forDispatch: vi.fn(() => { throw new Error('corrupt durable payload'); }) } as never,
      { find, findOneBy } as never,
      { blockServer } as never,
    );

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledWith(AgentTaskEntity, task.id, expect.objectContaining({
      failureStage: 'dispatch',
      agentResultJson: expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'DISPATCH_PAYLOAD_INVALID' }),
      }),
    }));
  });

  it('durably fail-stops the exact task at startup when a corrupt payload may already have been dispatched', async () => {
    const task = {
      ...startupTask(AgentTaskKind.ContainerStart),
      dispatchAttemptCount: 1,
      startedAt: new Date('2026-07-15T00:00:00.000Z'),
      lastSentAt: new Date('2026-07-15T00:00:00.000Z'),
    } as AgentTaskEntity;
    const update = vi.fn().mockResolvedValue(undefined);
    const manager = {
      findOne: vi.fn().mockResolvedValue(task),
      update,
    };
    const dataSource = {
      options: { type: 'postgres' },
      transaction: vi.fn(async (_isolation: string, work: (value: unknown) => Promise<unknown>) => work(manager)),
    };
    const find = vi.fn()
      .mockResolvedValueOnce([{ id: task.id }])
      .mockResolvedValueOnce([]);
    const findOneBy = vi.fn().mockResolvedValue(task);
    const blockServer = vi.fn();
    const service = new AgentTasksService(
      dataSource as never,
      {} as never,
      {} as never,
      { forDispatch: vi.fn(() => { throw new Error('corrupt durable payload'); }) } as never,
      { find, findOneBy } as never,
      { blockServer } as never,
    );

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledWith(AgentTaskEntity, task.id, expect.objectContaining({
      status: AgentTaskStatus.Failed,
      errorJson: expect.objectContaining({
        code: 'AGENT_TASK_PAYLOAD_CORRUPT_OUTCOME_UNKNOWN',
      }),
    }));
    expect(update).toHaveBeenCalledWith(expect.anything(), task.serverId, expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));
    expect(blockServer).toHaveBeenCalledWith(
      task.serverId,
      expect.stringContaining('payload corruption'),
    );
  });
});

describe('AgentTasksService supersede commit barrier', () => {
  it('only supersedes never-dispatched tasks and leaves sent or staged work locked', async () => {
    const unresolved = {
      id: 'task-unresolved',
      status: AgentTaskStatus.Pending,
      agentResultJson: null,
    } as unknown as AgentTaskEntity;
    const find = vi.fn(async (_entity, options) => {
      expect(options).toMatchObject({
        select: { id: true },
        order: { id: 'ASC' },
        take: 2,
      });
      expect(options.where).toMatchObject({
        serverId: 'server-a',
        resourceType: 'container',
        resourceId: 'container-a',
        status: AgentTaskStatus.Pending,
        agentResultJson: IsNull(),
        startedAt: IsNull(),
        lastSentAt: IsNull(),
      });
      return [unresolved];
    });
    const update = vi.fn().mockResolvedValue(undefined);
    const releaseTask = vi.fn().mockResolvedValue(undefined);
    const service = new AgentTasksService(
      {} as never,
      {} as never,
      { releaseTask } as never,
      {} as never,
      {} as never,
    );

    const superseded = await service.supersedePendingForResourceInTransaction(
      { find, update } as unknown as EntityManager,
      {
        serverId: 'server-a',
        resourceType: 'container',
        resourceId: 'container-a',
        reason: 'new desired state',
      },
    );

    expect(superseded).toEqual(['task-unresolved']);
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(expect.anything(), 'task-unresolved', expect.objectContaining({
      status: AgentTaskStatus.Failed,
      errorJson: { code: 'TASK_SUPERSEDED', message: 'new desired state' },
    }));
    expect(releaseTask).toHaveBeenCalledWith('task-unresolved', expect.anything());
  });

  it('fails closed when multiple undispatched tasks claim one logical resource', async () => {
    const find = vi.fn().mockResolvedValue([
      { id: 'task-a' },
      { id: 'task-b' },
    ]);
    const update = vi.fn();
    const releaseTask = vi.fn();
    const service = new AgentTasksService(
      {} as never,
      {} as never,
      { releaseTask } as never,
      {} as never,
      {} as never,
    );

    await expect(service.supersedePendingForResourceInTransaction(
      { find, update } as unknown as EntityManager,
      {
        serverId: 'server-a',
        resourceType: 'container',
        resourceId: 'container-a',
        reason: 'new desired state',
      },
    )).rejects.toMatchObject({
      response: { code: 'AGENT_TASK_SUPERSEDE_OWNER_CONFLICT' },
    });
    expect(update).not.toHaveBeenCalled();
    expect(releaseTask).not.toHaveBeenCalled();
  });
});

describe('AgentTasksService server ownership fence', () => {
  it('rejects enqueue inside the transaction when the target server was deleted', async () => {
    const insertForTask = vi.fn();
    const service = new AgentTasksService(
      {} as never,
      { generic: vi.fn(() => 'image:server-deleted:image-a') } as never,
      { insertForTask } as never,
      { forWirePayload: vi.fn((_, payload) => payload) } as never,
      {} as never,
    );
    const manager = {
      findOneBy: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
    } as unknown as EntityManager;

    await expect(service.enqueueInTransaction(manager, {
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: 'server-deleted',
      resourceType: 'image',
      resourceId: 'image-a',
      requestedBy: null,
      payload: { dockerRef: 'example.invalid/image:a' },
    })).rejects.toThrow('Server not found');

    expect((manager as unknown as { save: ReturnType<typeof vi.fn> }).save).not.toHaveBeenCalled();
    expect(insertForTask).not.toHaveBeenCalled();
  });

  it('rejects new durable physical intents while the Agent server is quarantined', async () => {
    const insertForTask = vi.fn();
    const service = new AgentTasksService(
      {} as never,
      { generic: vi.fn(() => 'image:server-a:image-a') } as never,
      { insertForTask } as never,
      { forWirePayload: vi.fn((_, payload) => payload) } as never,
      {} as never,
    );
    const manager = {
      findOneBy: vi.fn().mockResolvedValue({
        id: 'server-a',
        status: ServerStatus.AgentQuarantined,
      }),
      save: vi.fn(),
    } as unknown as EntityManager;

    await expect(service.enqueueInTransaction(manager, {
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: 'server-a',
      resourceType: 'image',
      resourceId: 'image-a',
      requestedBy: null,
      payload: { imageId: 'image-a', dockerRef: 'example.invalid/image:a' },
    })).rejects.toMatchObject({ response: { code: 'AGENT_SERVER_QUARANTINED' } });

    expect((manager as unknown as { save: ReturnType<typeof vi.fn> }).save).not.toHaveBeenCalled();
    expect(insertForTask).not.toHaveBeenCalled();
  });

  it.each([
    [
      'rolling retention window',
      [0, 0, 0, MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW, MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW],
      'AGENT_TASK_RETENTION_WINDOW_CAPACITY_REACHED',
    ],
    [
      'hard storage bound',
      [0, 0, 0, 0, MAX_AGENT_TASK_ROWS_HARD],
      'AGENT_TASK_STORAGE_CAPACITY_REACHED',
    ],
  ])('fails closed at the %s before persisting another task', async (_label, counts, code) => {
    const insertForTask = vi.fn();
    const service = new AgentTasksService(
      {} as never,
      { generic: vi.fn(() => 'image:server-a:image-a') } as never,
      { insertForTask } as never,
      { forWirePayload: vi.fn((_, payload) => payload) } as never,
      {} as never,
    );
    const count = vi.fn();
    for (const value of counts) count.mockResolvedValueOnce(value);
    const manager = {
      findOneBy: vi.fn().mockResolvedValue({ id: 'server-a', status: ServerStatus.Online }),
      count,
      save: vi.fn(),
    } as unknown as EntityManager;

    await expect(service.enqueueInTransaction(manager, {
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: 'server-a',
      resourceType: 'image',
      resourceId: 'image-a',
      requestedBy: null,
      payload: { imageId: 'image-a', dockerRef: 'example.invalid/image:a' },
    })).rejects.toMatchObject({ response: expect.objectContaining({ code }) });

    expect((manager as unknown as { save: ReturnType<typeof vi.fn> }).save).not.toHaveBeenCalled();
    expect(insertForTask).not.toHaveBeenCalled();
  });
});

describe('AgentTasksService network dispatch fence', () => {
  it('never dispatches a create whose immutable assigned IP differs from its exact claim', async () => {
    const task = {
      ...startupTask(AgentTaskKind.ContainerCreate),
      id: 'task-create-a',
      resourceId: 'container-a',
      payloadJson: {
        containerId: 'container-a',
        specGeneration: 1,
        quotaGeneration: 1,
        dockerRoot: '/var/lib/docker',
        ownerId: 'user-a',
        numericOwnerId: 1001,
        imageDockerRef: 'image:a',
        imageDockerId: 'sha256:image-a',
        imageId: 'image-a',
        assignedIp: '10.0.0.9',
        name: 'work',
        cpuMillis: 1000,
        memBytes: 1024,
        diskBytes: 1024,
        mounts: [],
      },
    } as AgentTaskEntity;
    const update = vi.fn().mockResolvedValue({ affected: 1 });
    const manager = {
      findOne: vi.fn()
        .mockResolvedValueOnce(task)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          address: '10.0.0.8',
          networkKey: '10.0.0.0/24',
          ownerKind: 'container',
          ownerId: 'container-a',
          serverId: 'server-a',
          state: 'active',
        }),
      findOneBy: vi.fn().mockResolvedValue({
        id: 'server-a',
        status: ServerStatus.Online,
        macvlanCidr: '10.0.0.0/24',
      }),
      count: vi.fn().mockResolvedValue(1),
      existsBy: vi.fn().mockResolvedValue(false),
      update,
    };
    const dataSource = {
      options: { type: 'postgres' },
      transaction: vi.fn(async (_level: string, work: (value: unknown) => Promise<unknown>) => work(manager)),
    };
    const service = new AgentTasksService(
      dataSource as never,
      {} as never,
      {} as never,
      { forDispatch: vi.fn((value: AgentTaskEntity) => value.payloadJson) } as never,
      {} as never,
    );

    await expect(service.markSentAndBuild(task.id)).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith(AgentTaskEntity, task.id, expect.objectContaining({
      errorJson: expect.objectContaining({ code: 'NETWORK_ACTIVATION_FROZEN' }),
    }));
    expect(update).not.toHaveBeenCalledWith(AgentTaskEntity, task.id, expect.objectContaining({
      lastSentAt: expect.any(Date),
    }));
  });

  it('freezes activation while a shared-network peer has untrusted inventory', async () => {
    const task = {
      ...startupTask(AgentTaskKind.ContainerStart),
      id: 'task-start-a',
      resourceId: 'container-a',
      payloadJson: { containerId: 'container-a', runtimeId: 'runtime-a' },
    } as AgentTaskEntity;
    const update = vi.fn().mockResolvedValue({ affected: 1 });
    const manager = {
      findOne: vi.fn()
        .mockResolvedValueOnce(task)
        .mockResolvedValueOnce(null),
      findOneBy: vi.fn().mockResolvedValue({
        id: 'server-a',
        status: ServerStatus.Online,
        macvlanCidr: '10.0.0.0/24',
      }),
      existsBy: vi.fn().mockResolvedValue(true),
      update,
    };
    const dataSource = {
      options: { type: 'postgres' },
      transaction: vi.fn(async (_level: string, work: (value: unknown) => Promise<unknown>) => work(manager)),
    };
    const service = new AgentTasksService(
      dataSource as never,
      {} as never,
      {} as never,
      { forDispatch: vi.fn((value: AgentTaskEntity) => value.payloadJson) } as never,
      {} as never,
    );

    await expect(service.markSentAndBuild(task.id)).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith(AgentTaskEntity, task.id, expect.objectContaining({
      errorJson: expect.objectContaining({
        code: 'NETWORK_ACTIVATION_FROZEN',
        message: expect.stringContaining('shared macvlan'),
      }),
    }));
  });
});

describe('AgentTasksService never-dispatched evidence', () => {
  it('stages no-effect dispatch evidence without claiming physical absence', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const task = {
      id: 'task-a',
      kind: AgentTaskKind.ContainerStart,
      serverId: 'server-a',
      resourceId: 'container-a',
      payloadHash: 'hash-a',
      // This path must remain terminal even when the durable payload itself is
      // the poison value that failed before the first dispatch.
      payloadJson: 'corrupt-payload' as never,
      status: AgentTaskStatus.Pending,
      agentResultJson: null,
      dispatchAttemptCount: 0,
      startedAt: null,
      lastSentAt: null,
    } as unknown as AgentTaskEntity;
    const manager = {
      findOne: vi.fn().mockResolvedValue(task),
      update,
    };
    const dataSource = {
      options: { type: 'postgres' },
      transaction: vi.fn(async (_isolation: string, work: (value: unknown) => Promise<unknown>) => work(manager)),
    };
    const service = new AgentTasksService(
      dataSource as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.stageNeverDispatchedPayloadFailure(
      task.id,
      new Error('cannot encode payload'),
    )).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith(AgentTaskEntity, task.id, expect.objectContaining({
      failureStage: 'dispatch',
      agentResultJson: {
        status: 'failed',
        error: {
          code: 'DISPATCH_PAYLOAD_INVALID',
          message: 'cannot encode payload',
        },
        observed: {
          containerId: 'container-a',
          applied: false,
          reason: 'never_dispatched',
        },
      },
    }));
  });
});

describe('AgentTasksService exhaustion admission boundary', () => {
  it('expires only normal never-started work and preserves queued reconciliation and safety authority', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const service = new AgentTasksService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { find } as never,
    );

    await expect(service.failExhaustedTasks(new Date('2026-07-16T00:00:00.000Z')))
      .resolves.toEqual({ taskIds: [], serverIds: [] });

    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: AgentTaskStatus.Pending,
        admissionClass: 'normal',
        startedAt: expect.objectContaining({ _type: 'isNull' }),
      }),
    }));
  });

  it('blocks process-local routes immediately after an uncertain task exhausts', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    const task = {
      ...startupTask(AgentTaskKind.ContainerStart),
      startedAt: new Date('2026-07-15T23:00:00.000Z'),
      retryWindowStartedAt: new Date('2026-07-15T23:00:00.000Z'),
      incompleteResultCount: MAX_AGENT_TASK_INCOMPLETE_RESULTS,
      dispatchAttemptCount: 4,
    } as AgentTaskEntity;
    const find = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([]);
    const update = vi.fn().mockResolvedValue({ affected: 1 });
    const manager = {
      findOneBy: vi.fn().mockResolvedValue(task),
      update,
    };
    const dataSource = {
      options: { type: 'postgres' },
      transaction: vi.fn(async (_isolation: string, work: (value: unknown) => Promise<unknown>) => work(manager)),
    };
    const blockServer = vi.fn();
    const service = new AgentTasksService(
      dataSource as never,
      {} as never,
      {} as never,
      {} as never,
      { find } as never,
      { blockServer } as never,
    );

    await expect(service.failExhaustedTasks(now)).resolves.toEqual({
      taskIds: [task.id],
      serverIds: [task.serverId],
    });
    expect(update).toHaveBeenCalledWith(ServerEntity, task.serverId, expect.objectContaining({
      status: ServerStatus.AgentQuarantined,
    }));
    expect(blockServer).toHaveBeenCalledWith(
      task.serverId,
      expect.stringContaining('outcome deadline exhausted'),
    );
  });
});

function startupTask(kind: AgentTaskKind): AgentTaskEntity {
  return {
    id: 'task-startup-a',
    kind,
    serverId: 'server-a',
    resourceType: kind === AgentTaskKind.RemoteFsEnsure ? 'remote-fs' : 'container',
    resourceId: 'resource-a',
    requestedBy: null,
    requestJson: null,
    payloadJson: 'corrupt-payload',
    payloadHash: 'a'.repeat(64),
    admissionClass: 'normal',
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
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
    startedAt: null,
    lastSentAt: null,
    completedAt: null,
  };
}
