import type { UserAgentTaskDto } from '@nyabase/common';
import type { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { AGENT_TASK_MIN_RETENTION_MS } from './agent-task-retention.service.js';

/** Project durable task evidence onto the requester-safe progress contract. */
export function toUserAgentTaskDto(task: AgentTaskEntity): UserAgentTaskDto {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    resourceType: task.resourceType,
    resourceId: task.resourceId,
    serverId: task.serverId,
    error: requesterSafeError(task.errorJson, task.failureStage),
    failureStage: task.failureStage,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    lastSentAt: task.lastSentAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    retentionUntil: task.completedAt
      ? new Date(task.completedAt.getTime() + AGENT_TASK_MIN_RETENTION_MS).toISOString()
      : null,
  };
}

function requesterSafeError(
  raw: unknown,
  stage: AgentTaskEntity['failureStage'],
): UserAgentTaskDto['error'] {
  if (!raw) return null;
  // Agent error codes are privileged evidence.  A syntactically tidy code can
  // still encode host/runtime details, so requester responses derive a fixed
  // code solely from the control-plane failure stage.
  const code = stage === 'dispatch'
    ? 'TASK_DISPATCH_FAILED'
    : stage === 'agent'
      ? 'TASK_EXECUTION_FAILED'
      : stage === 'finalizer'
        ? 'TASK_FINALIZATION_FAILED'
        : 'TASK_FAILED';
  const message = stage === 'dispatch'
    ? 'The task could not be sent to the server'
    : stage === 'agent'
      ? 'The server could not complete the task'
      : stage === 'finalizer'
        ? 'The server completed the task, but control-plane finalization failed'
        : 'The task failed';
  return { code, message };
}
