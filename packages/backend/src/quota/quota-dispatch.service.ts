import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AgentTaskKind, UserStatus } from '@nyabase/common';
import { DataSource, EntityManager } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';

export interface QuotaApplyRequest {
  serverId: string;
  userId: string;
  numericUserId: number;
  diskBytes: number;
  requestedBy: string | null;
  /** Reserved for the user-deletion drain; public grant paths must omit it. */
  allowDeleting?: boolean;
}

@Injectable()
export class QuotaDispatchService {
  constructor(
    private dataSource: DataSource,
    private tasks: AgentTasksService,
    private resourceKeys: ResourceKeyService,
  ) {}

  async apply(request: QuotaApplyRequest): Promise<string> {
    return runSerializedTransaction(this.dataSource, (manager) =>
      this.applyInTransaction(manager, request));
  }

  async applyInTransaction(manager: EntityManager, request: QuotaApplyRequest): Promise<string> {
    const [server, user] = await Promise.all([
      manager.findOneBy(ServerEntity, { id: request.serverId }),
      manager.findOneBy(UserEntity, { id: request.userId }),
    ]);
    if (!server) throw new NotFoundException('Server not found');
    if (!user) throw new NotFoundException('User not found');
    if (user.status === UserStatus.Deleted) {
      throw new ConflictException({
        code: 'USER_DELETED',
        message: 'A deleted user cannot receive quota intent',
        userId: request.userId,
      });
    }
    if (
      user.status === UserStatus.Deleting
      && (request.allowDeleting !== true || request.diskBytes !== 0)
    ) {
      throw new ConflictException({
        code: 'USER_DELETING',
        message: 'A deleting user accepts only its internal quota drain intent',
        userId: request.userId,
      });
    }
    if (user.numericId !== request.numericUserId) {
      throw new ConflictException(`User ${request.userId} numeric quota identity changed`);
    }
    const resourceKey = this.resourceKeys.quota(request.serverId, request.userId);
    await this.tasks.supersedePendingForResourceInTransaction(manager, {
      serverId: request.serverId,
      resourceType: 'quota',
      resourceId: request.userId,
      reason: 'A newer durable quota generation replaced this undispatched task',
    });

    // A sent/staged quota task or a container task may still own this shared
    // user quota. Never commit a new grant intent while an older physical
    // effect can still finish; the caller's business transaction must retry.
    const held = await manager.findOne(ResourceLockEntity, { where: { resourceKey } });
    if (held) {
      const owner = await manager.findOne(AgentTaskEntity, { where: { id: held.taskId } });
      throw new ConflictException({
        code: 'QUOTA_MUTATION_IN_PROGRESS',
        message: `Quota for user ${request.userId} is being reconciled by task ${held.taskId}`,
        taskKind: owner?.kind ?? null,
      });
    }

    const existing = await manager.findOne(QuotaDesiredEntity, {
      where: { serverId: request.serverId, userId: request.userId },
    });
    const generation = (existing?.generation ?? 0) + 1;
    const desired = manager.create(QuotaDesiredEntity, {
      id: existing?.id ?? uuidv4(),
      serverId: request.serverId,
      userId: request.userId,
      numericUserId: request.numericUserId,
      limitBytes: request.diskBytes,
      source: 'grant',
      generation,
      lastTaskId: null,
      createdAt: existing?.createdAt,
      updatedAt: new Date(),
    });
    await manager.save(QuotaDesiredEntity, desired);

    const task = await this.tasks.enqueueInTransaction(manager, {
      kind: AgentTaskKind.QuotaEnsure,
      serverId: request.serverId,
      resourceType: 'quota',
      resourceId: request.userId,
      requestedBy: request.requestedBy,
      payload: {
        generation,
        numericUserId: request.numericUserId,
        diskBytes: request.diskBytes,
      },
      request: {
        source: 'grant',
        generation,
        numericUserId: request.numericUserId,
        diskBytes: request.diskBytes,
      },
      resourceKeys: [resourceKey],
      beforeCommit: async (taskManager, context) => {
        await taskManager.update(QuotaDesiredEntity, desired.id, {
          lastTaskId: context.taskId,
          updatedAt: new Date(),
        });
      },
    });
    return task.taskId;
  }
}
