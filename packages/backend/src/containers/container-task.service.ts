import { Injectable } from '@nestjs/common';
import {
  AgentTaskStatus,
  type AgentTaskKind,
  type AgentTaskRefResponse,
  type UserAgentTaskDto,
} from '@nyabase/common';
import type { Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';

const TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type ContainerControlTransaction = Transaction<NyabaseDatabase>;

export interface ContainerTaskRequest {
  containerId: string;
  serverId: string;
  requestedBy: string | null;
  kind: AgentTaskKind;
  request: unknown;
  payload: unknown;
  nextDispatchAt?: Date;
  resourceKeys: string[];
  beforeCommit?: (
    transaction: ContainerControlTransaction,
    taskId: string,
  ) => Promise<void>;
}

/**
 * Container-owned adapter onto the canonical Workflow enqueue port. Both the
 * command/task/claims/outbox and Container desired-state callback use the
 * caller's exact Kysely transaction. No Redis, WS, RPC, or nested transaction
 * is permitted on this path.
 */
@Injectable()
export class ContainerTaskService {
  constructor(
    private readonly workflow: WorkflowEnqueuePort,
    private readonly workflowRepository: WorkflowRepository,
  ) {}

  async enqueueInTransaction(
    transaction: ContainerControlTransaction,
    input: ContainerTaskRequest,
  ): Promise<AgentTaskRefResponse> {
    const result = await this.workflow.enqueueInTransaction(transaction, {
      kind: input.kind,
      serverId: input.serverId,
      resourceType: 'container',
      resourceId: input.containerId,
      requestedBy: input.requestedBy,
      request: input.request,
      payload: input.payload,
      resourceKeys: input.resourceKeys,
      nextDispatchAt: input.nextDispatchAt,
      beforeCommit: async (sameTransaction, context) => {
        await input.beforeCommit?.(sameTransaction, context.taskId);
      },
    });
    return { ok: true, taskId: result.taskId, status: result.status };
  }

  async findPending(
    containerId: string,
    taskId: string | null,
  ): Promise<UserAgentTaskDto | null> {
    if (!taskId) return null;
    const task = await this.workflowRepository.findTask(taskId);
    if (
      !task
      || task.resourceType !== 'container'
      || task.resourceId !== containerId
      || task.status !== AgentTaskStatus.Pending
    ) return null;
    const completedAt = task.completedAt;
    return {
      id: task.id,
      kind: task.kind as AgentTaskKind,
      status: task.status,
      resourceType: task.resourceType,
      resourceId: task.resourceId,
      serverId: task.serverId,
      error: null,
      failureStage: task.failureStage,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString() ?? null,
      lastSentAt: task.lastSentAt?.toISOString() ?? null,
      completedAt: completedAt?.toISOString() ?? null,
      retentionUntil: completedAt
        ? new Date(completedAt.getTime() + TASK_RETENTION_MS).toISOString()
        : null,
    };
  }

  async findPendingMany(
    inputs: readonly {
      containerId: string;
      taskId: string | null;
    }[],
  ): Promise<Map<string, UserAgentTaskDto>> {
    const taskIds = inputs.flatMap(({ taskId }) => taskId ? [taskId] : []);
    const tasks = await this.workflowRepository.findTasks(taskIds);
    const pending = new Map<string, UserAgentTaskDto>();
    for (const { containerId, taskId } of inputs) {
      if (!taskId) continue;
      const task = tasks.get(taskId);
      if (
        !task
        || task.resourceType !== 'container'
        || task.resourceId !== containerId
        || task.status !== AgentTaskStatus.Pending
      ) continue;
      const completedAt = task.completedAt;
      pending.set(containerId, {
        id: task.id,
        kind: task.kind as AgentTaskKind,
        status: task.status,
        resourceType: task.resourceType,
        resourceId: task.resourceId,
        serverId: task.serverId,
        error: null,
        failureStage: task.failureStage,
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString() ?? null,
        lastSentAt: task.lastSentAt?.toISOString() ?? null,
        completedAt: completedAt?.toISOString() ?? null,
        retentionUntil: completedAt
          ? new Date(completedAt.getTime() + TASK_RETENTION_MS).toISOString()
          : null,
      });
    }
    return pending;
  }
}
