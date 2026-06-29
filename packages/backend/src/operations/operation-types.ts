import type { EntityManager } from 'typeorm';
import type { AgentCommandKind, CommandHookName, OperationKind, OperationStatus } from '@nyabase/common';

export type UnlockReportKind = 'state' | 'data_dir' | null;

export interface OperationPersistContext {
  operationId: string;
  commandId: string;
}

export interface OperationCallbackContext extends OperationPersistContext {
  operationKind: OperationKind;
  commandKind: AgentCommandKind | string;
  serverId: string;
  resourceType: string;
  resourceId: string;
}

export interface CommandHookCommand {
  commandKind: AgentCommandKind;
  payload: unknown;
}

export interface CommandHookPlanEntry {
  name: CommandHookName;
  commandKind: AgentCommandKind;
  payload: unknown | null;
  snapshot: unknown | null;
}

export interface CommandHookResultEntry {
  name: CommandHookName;
  commandId: string;
  commandKind: AgentCommandKind;
  result: unknown;
  completedAt: string;
}

export interface EnqueueCommandInput<T = unknown> {
  kind: OperationKind;
  serverId: string;
  resourceType: string;
  resourceId: string;
  requestedBy: string | null;
  commandKind: AgentCommandKind | string;
  request?: unknown;
  payload: unknown;
  baseResourceKeys?: string[];
  unlockReportKind?: UnlockReportKind;
  beforeCommit?: (
    manager: EntityManager,
    context: OperationPersistContext,
  ) => Promise<void>;
  onAckSuccess?: (
    manager: EntityManager,
    result: T,
    context: OperationCallbackContext,
  ) => Promise<void>;
  onAckFailure?: (
    manager: EntityManager,
    error: unknown,
    context: OperationCallbackContext,
  ) => Promise<void>;
}

export interface EnqueueCommandResult<T = unknown> {
  ok: true;
  operationId: string;
  status: OperationStatus;
  result: T | null;
}
