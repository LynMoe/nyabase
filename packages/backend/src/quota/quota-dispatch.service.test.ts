import { AgentTaskKind, AgentTaskStatus, ServerStatus, UserStatus } from '@nyabase/common';
import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { ResourceLockService } from '../agent-tasks/resource-lock.service.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { QuotaDispatchService } from './quota-dispatch.service.js';

describe('QuotaDispatchService durable generations', () => {
  let dataSource: DataSource;
  let service: QuotaDispatchService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [ServerEntity, UserEntity, AgentTaskEntity, QuotaDesiredEntity, ResourceLockEntity],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save({
      id: 'server-a',
      name: 'Server A',
      slug: 'server-a',
      agentTokenHash: 'token-a',
      hostFingerprint: null,
      agentConfigFingerprint: null,
      status: ServerStatus.Unknown,
      lastSeenAt: null,
    });
    await dataSource.getRepository(UserEntity).save({
      id: 'user-a',
      numericId: 1001,
      username: 'user-a',
      passwordHash: 'hash',
      displayName: 'User A',
      status: UserStatus.Active,
    });
    const keys = new ResourceKeyService();
    const tasks = new AgentTasksService(
      dataSource,
      keys,
      new ResourceLockService(dataSource.getRepository(ResourceLockEntity)),
      {
        forWirePayload: (_kind: AgentTaskKind, payload: unknown) => payload,
        forDispatch: (task: AgentTaskEntity) => task.payloadJson,
      } as AgentTaskPayloadCodecService,
      dataSource.getRepository(AgentTaskEntity),
    );
    service = new QuotaDispatchService(dataSource, tasks, keys);
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('atomically supersedes only an undispatched generation and durably enqueues its successor', async () => {
    await service.apply(request(100));
    const first = await onlyPendingTask();
    expect(first.payloadJson).toMatchObject({ generation: 1, diskBytes: 100 });

    await service.apply(request(10));

    const desired = await dataSource.getRepository(QuotaDesiredEntity).findOneByOrFail({
      serverId: 'server-a', userId: 'user-a',
    });
    const tasks = await dataSource.getRepository(AgentTaskEntity).find({ order: { createdAt: 'ASC' } });
    expect(desired).toMatchObject({ generation: 2, limitBytes: 10, lastTaskId: expect.any(String) });
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      status: AgentTaskStatus.Failed,
      errorJson: { code: 'TASK_SUPERSEDED' },
    });
    expect(tasks[1]).toMatchObject({
      id: desired.lastTaskId,
      status: AgentTaskStatus.Pending,
      payloadJson: { generation: 2, diskBytes: 10 },
    });
  });

  it('rejects and rolls back a new desired limit while an older physical task may still finish', async () => {
    await service.apply(request(100));
    const first = await onlyPendingTask();
    await dataSource.getRepository(AgentTaskEntity).update(first.id, {
      dispatchAttemptCount: 1,
      startedAt: new Date(),
      lastSentAt: new Date(),
    });

    await expect(service.apply(request(10))).rejects.toBeInstanceOf(ConflictException);

    expect(await dataSource.getRepository(QuotaDesiredEntity).findOneByOrFail({
      serverId: 'server-a', userId: 'user-a',
    })).toMatchObject({ generation: 1, limitBytes: 100, lastTaskId: first.id });
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(1);
    expect(await dataSource.getRepository(ResourceLockEntity).count()).toBe(1);
  });

  it('accepts only the internal zero-limit drain while a user is deleting', async () => {
    await dataSource.getRepository(UserEntity).update('user-a', { status: UserStatus.Deleting });

    await expect(service.apply(request(10))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'USER_DELETING' }),
    });
    await expect(service.apply({ ...request(0), allowDeleting: true }))
      .resolves.toEqual(expect.any(String));

    expect(await dataSource.getRepository(QuotaDesiredEntity).findOneByOrFail({
      serverId: 'server-a', userId: 'user-a',
    })).toMatchObject({ limitBytes: 0, generation: 1 });
  });

  async function onlyPendingTask(): Promise<AgentTaskEntity> {
    return dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ status: AgentTaskStatus.Pending });
  }
});

function request(diskBytes: number) {
  return {
    serverId: 'server-a',
    userId: 'user-a',
    numericUserId: 1001,
    diskBytes,
    requestedBy: 'actor-a',
  };
}
