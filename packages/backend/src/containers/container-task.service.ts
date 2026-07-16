import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  AgentTaskKind,
  ContainerPhase,
  type AgentTaskRefResponse,
} from '@nyabase/common';
import { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';

export interface ContainerTaskRequest {
  containerId: string;
  serverId: string;
  requestedBy: string | null;
  kind: AgentTaskKind;
  request: unknown;
  payload: unknown;
  payloadInTransaction?: (manager: EntityManager) => Promise<unknown>;
  phase: ContainerPhase;
  nextDispatchAt?: Date;
  resourceKeys?: string[];
  beforeSave?: (manager: EntityManager, taskId: string) => Promise<void>;
}

@Injectable()
export class ContainerTaskService {
  constructor(
    private dataSource: DataSource,
    private tasks: AgentTasksService,
    private resourceKeys: ResourceKeyService,
    private proxySnapshots: ProxySnapshotNotifierService,
  ) {}

  async createContainerTask(
    manager: EntityManager,
    input: ContainerTaskRequest,
  ): Promise<AgentTaskRefResponse> {
    const payload = input.payloadInTransaction
      ? await input.payloadInTransaction(manager)
      : input.payload;
    return this.tasks.enqueueInTransaction(manager, {
      kind: input.kind,
      serverId: input.serverId,
      resourceType: 'container',
      resourceId: input.containerId,
      requestedBy: input.requestedBy,
      request: input.request,
      payload,
      nextDispatchAt: input.nextDispatchAt,
      resourceKeys: input.resourceKeys ?? [this.resourceKeys.container(input.containerId)],
      beforeCommit: async (taskManager, context) => {
        await input.beforeSave?.(taskManager, context.taskId);
        await taskManager.update(ContainerLifecycleEntity, input.containerId, {
          phase: input.phase,
          activeTaskId: context.taskId,
          lastTransitionAt: new Date(),
          failureReason: null,
          failureCode: null,
        });
      },
    });
  }

  async enqueueExistingContainerAction(
    input: Omit<ContainerTaskRequest, 'serverId'> & { serverId?: string },
  ): Promise<AgentTaskRefResponse> {
    const task = await runSerializedTransaction(this.dataSource, async (manager) => {
      const container = await manager.findOneByOrFail(ContainerEntity, { id: input.containerId });
      return this.createContainerTask(manager, {
        ...input,
        serverId: input.serverId ?? container.serverId,
      });
    });
    this.proxySnapshots.invalidate(`container ${input.containerId} ${input.kind} intent committed`);
    return task;
  }
}
