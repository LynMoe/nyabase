import type { AgentCommandKind, CommandHookName, OperationKind } from '@nyabase/common';
import type { CommandHookCommand } from '../operations/operation-types.js';

export interface CommandHookContext {
  operationId: string;
  operationKind: OperationKind;
  commandKind: AgentCommandKind | string;
  serverId: string;
  resourceType: string;
  resourceId: string;
  request: unknown | null;
  payload: unknown | null;
  mainResult: unknown | null;
  requestedBy: string | null;
}

export interface CommandHook {
  name: CommandHookName;
  appliesTo(context: CommandHookContext): Promise<boolean> | boolean;
  resourceKeys(context: CommandHookContext): Promise<string[]> | string[];
  buildCommand(context: CommandHookContext): Promise<CommandHookCommand | null>;
  mergeResult(context: CommandHookContext, result: unknown): Promise<void>;
}
