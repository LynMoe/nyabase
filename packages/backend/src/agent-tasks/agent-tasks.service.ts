import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AgentTaskKind,
  Capability,
  type AgentTaskDto,
  type UserAgentTaskDto,
} from '@nyabase/common';
import { AGENT_TASK_MIN_RETENTION_MS } from './agent-task-retention.service.js';
import {
  AGENT_TASK_RESOURCE_TYPE_BY_KIND,
  MAX_AGENT_TASK_WIRE_BYTES,
} from './agent-task-durable-contract.js';
import {
  WorkflowRepository,
  type WorkflowTaskRecord,
  type WorkflowTaskSummary,
} from './workflow.repository.js';

export { MAX_AGENT_TASK_WIRE_BYTES } from './agent-task-durable-contract.js';
export const MAX_AGENT_TASK_REQUEST_BYTES = MAX_AGENT_TASK_WIRE_BYTES;
export const MAX_PENDING_AGENT_TASKS_PER_SERVER = 1024;
export const MAX_PENDING_AGENT_TASKS_GLOBAL = 4096;
export const MAX_RECONCILIATION_TASKS_PER_SERVER = 2048;
export const MAX_RECONCILIATION_TASKS_GLOBAL = 8192;
export const MAX_SAFETY_TASKS_PER_SERVER = 1024;
export const MAX_ALL_TASKS_PER_SERVER =
  MAX_RECONCILIATION_TASKS_PER_SERVER + MAX_SAFETY_TASKS_PER_SERVER;
export const AGENT_TASK_RESEND_INTERVAL_MS = 5_000;
export const MIN_AGENT_TASK_DISPATCH_DEFER_MS = 2_000;
export const MAX_AGENT_TASK_INCOMPLETE_RESULTS = 12;
export const MAX_AGENT_TASK_UNCERTAIN_AGE_MS = 45 * 60_000;
export const MAX_AGENT_TASK_UNSTARTED_AGE_MS = 15 * 60_000;

export class PermanentTaskPayloadError extends Error {
  constructor(
    readonly taskId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PermanentTaskPayloadError';
  }
}

/** REST history projection over the sole PostgreSQL workflow authority. */
@Injectable()
export class AgentTasksService {
  constructor(private readonly workflow: WorkflowRepository) {}

  async getForUser(userId: string, taskId: string): Promise<UserAgentTaskDto> {
    const task = await this.workflow.findTask(taskId);
    if (!task || task.requestedBy !== userId) throw new NotFoundException('Task not found');
    return toUserDto(task);
  }

  async getForAdmin(
    taskId: string,
    capabilities: ReadonlySet<Capability>,
  ): Promise<AgentTaskDto> {
    const task = await this.workflow.findTask(taskId);
    if (!task || !canReadAdminTaskEvidence(task, capabilities)) {
      throw new NotFoundException('Task not found');
    }
    return toAdminDto(task, true);
  }

  async listForUser(
    userId: string,
    filters: TaskFilters = {},
  ): Promise<UserAgentTaskDto[]> {
    return (await this.workflow.listTasks({ ...filters, requestedBy: userId }))
      .map(toUserDto);
  }

  async listForAdmin(
    capabilities: ReadonlySet<Capability>,
    filters: TaskFilters = {},
  ): Promise<AgentTaskDto[]> {
    const scopes = adminTaskEvidenceScopes(capabilities);
    if (scopes.length === 0) return [];
    return (await this.workflow.listTasks({ ...filters, scopes }))
      .map((task) => toAdminDto(task, false));
  }

  async listPurposeSafe(filters: TaskFilters = {}): Promise<UserAgentTaskDto[]> {
    return (await this.workflow.listTasks(filters)).map(toUserDto);
  }
}

interface TaskFilters {
  resourceType?: string;
  resourceId?: string;
  serverId?: string;
  limit?: number;
}

interface AdminTaskEvidenceScope {
  capability: Capability;
  resourceType: string;
  kinds: readonly AgentTaskKind[];
}

const ADMIN_TASK_EVIDENCE_SCOPES: readonly AdminTaskEvidenceScope[] = [
  {
    capability: Capability.ManageContainersAny,
    resourceType: AGENT_TASK_RESOURCE_TYPE_BY_KIND[AgentTaskKind.ContainerCreate],
    kinds: [
      AgentTaskKind.ContainerCreate,
      AgentTaskKind.ContainerStart,
      AgentTaskKind.ContainerStop,
      AgentTaskKind.ContainerRestart,
      AgentTaskKind.ContainerDelete,
      AgentTaskKind.ContainerSshEnsure,
    ],
  },
  {
    capability: Capability.ManageContainersAny,
    resourceType: AGENT_TASK_RESOURCE_TYPE_BY_KIND[AgentTaskKind.DataDirEnsure],
    kinds: [AgentTaskKind.DataDirEnsure, AgentTaskKind.DataDirAbsent],
  },
  {
    capability: Capability.ManageServers,
    resourceType: AGENT_TASK_RESOURCE_TYPE_BY_KIND[AgentTaskKind.ContainerRuntimeAbsent],
    kinds: [AgentTaskKind.ContainerRuntimeAbsent],
  },
  {
    capability: Capability.ManageServers,
    resourceType: AGENT_TASK_RESOURCE_TYPE_BY_KIND[AgentTaskKind.RemoteFsEnsure],
    kinds: [AgentTaskKind.RemoteFsEnsure, AgentTaskKind.RemoteFsAbsent],
  },
  {
    capability: Capability.ManageGrants,
    resourceType: AGENT_TASK_RESOURCE_TYPE_BY_KIND[AgentTaskKind.QuotaEnsure],
    kinds: [AgentTaskKind.QuotaEnsure],
  },
  {
    capability: Capability.ManageImages,
    resourceType: AGENT_TASK_RESOURCE_TYPE_BY_KIND[AgentTaskKind.ImageEnsurePresent],
    kinds: [AgentTaskKind.ImageEnsurePresent, AgentTaskKind.ImageEnsureAbsent],
  },
];

function adminTaskEvidenceScopes(
  capabilities: ReadonlySet<Capability>,
): readonly AdminTaskEvidenceScope[] {
  return ADMIN_TASK_EVIDENCE_SCOPES.filter((scope) => capabilities.has(scope.capability));
}

function canReadAdminTaskEvidence(
  task: Pick<WorkflowTaskRecord, 'kind' | 'resourceType'>,
  capabilities: ReadonlySet<Capability>,
): boolean {
  return adminTaskEvidenceScopes(capabilities).some((scope) =>
    scope.resourceType === task.resourceType
    && scope.kinds.includes(task.kind as AgentTaskKind));
}

function retentionUntil(task: Pick<WorkflowTaskRecord, 'completedAt'>): string | null {
  return task.completedAt
    ? new Date(task.completedAt.getTime() + AGENT_TASK_MIN_RETENTION_MS).toISOString()
    : null;
}

function toUserDto(
  task: WorkflowTaskRecord | WorkflowTaskSummary,
): UserAgentTaskDto {
  return {
    id: task.id,
    kind: task.kind as AgentTaskKind,
    status: task.status,
    resourceType: task.resourceType,
    resourceId: task.resourceId,
    serverId: task.serverId,
    error: requesterSafeError(task.error, task.failureStage),
    failureStage: task.failureStage,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    lastSentAt: task.lastSentAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    retentionUntil: retentionUntil(task),
  };
}

function toAdminDto(task: WorkflowTaskRecord | WorkflowTaskSummary, details: boolean): AgentTaskDto {
  const record = task as WorkflowTaskRecord;
  return {
    id: task.id,
    kind: task.kind as AgentTaskKind,
    status: task.status,
    resourceType: task.resourceType,
    resourceId: task.resourceId,
    serverId: task.serverId,
    requestedBy: task.requestedBy,
    request: details && 'request' in task ? redactCredential(record.request) : null,
    agentResult: details && 'agentResult' in task ? record.agentResult : null,
    result: details && 'result' in task ? record.result : null,
    error: task.error,
    failureStage: task.failureStage,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    lastSentAt: task.lastSentAt?.toISOString() ?? null,
    payloadHash: task.payloadHash,
    dispatchAttemptCount: task.dispatchAttemptCount,
    completedAt: task.completedAt?.toISOString() ?? null,
    retentionUntil: retentionUntil(task),
  };
}

function requesterSafeError(
  raw: unknown,
  stage: WorkflowTaskRecord['failureStage'],
): UserAgentTaskDto['error'] {
  if (!raw) return null;
  if (stage === 'dispatch') {
    return { code: 'TASK_DISPATCH_FAILED', message: 'The task could not be sent to the server' };
  }
  if (stage === 'agent') {
    return { code: 'TASK_EXECUTION_FAILED', message: 'The server could not complete the task' };
  }
  if (stage === 'finalizer') {
    return {
      code: 'TASK_FINALIZATION_FAILED',
      message: 'The server completed the task, but control-plane finalization failed',
    };
  }
  return { code: 'TASK_FAILED', message: 'The task failed' };
}

function redactCredential(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredential);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'secret')
      .map(([key, entry]) => [key, redactCredential(entry)]),
  );
}
