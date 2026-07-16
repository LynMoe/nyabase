import type { EntityManager } from 'typeorm';
import type { AgentTaskKind, AgentTaskStatus } from '@nyabase/common';

export interface AgentTaskPersistContext {
  taskId: string;
}

export interface EnqueueAgentTaskInput {
  kind: AgentTaskKind;
  serverId: string;
  resourceType: string;
  resourceId: string;
  requestedBy: string | null;
  request?: unknown;
  payload: unknown;
  resourceKeys?: string[];
  nextDispatchAt?: Date;
  /** Reserved bounded capacity for safety work derived from authoritative inventory. */
  admissionClass?: 'normal' | 'reconciliation' | 'safety';
  beforeCommit?: (
    manager: EntityManager,
    context: AgentTaskPersistContext,
  ) => Promise<void>;
}

export interface EnqueueAgentTaskResult {
  ok: true;
  taskId: string;
  status: AgentTaskStatus;
}
