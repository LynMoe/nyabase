import { Inject, Injectable } from '@nestjs/common';
import {
  AgentCommandKind,
  CommandHookName,
} from '@nyabase/common';
import type { CommandHookPlanEntry } from '../operations/operation-types.js';
import type { CommandHook, CommandHookContext } from './command-hook.types.js';

export const COMMAND_HOOKS = Symbol('COMMAND_HOOKS');

const ORDERED_HOOKS: CommandHookName[] = [
  CommandHookName.ContainerMountsEnsure,
  CommandHookName.ContainerSshEnsure,
];

@Injectable()
export class CommandHookRegistry {
  private readonly hooksByName: Map<CommandHookName, CommandHook>;

  constructor(
    @Inject(COMMAND_HOOKS)
    hooks: CommandHook[],
  ) {
    this.hooksByName = new Map(hooks.map((hook) => [hook.name, hook]));
  }

  async plan(context: CommandHookContext): Promise<{
    hookPlan: CommandHookPlanEntry[];
    resourceKeys: string[];
  }> {
    const hookPlan: CommandHookPlanEntry[] = [];
    const resourceKeys: string[] = [];

    for (const name of ORDERED_HOOKS) {
      const hook = this.requiredHook(name);
      if (!await hook.appliesTo(context)) continue;
      resourceKeys.push(...await hook.resourceKeys(context));
      const command = await hook.buildCommand(context);
      hookPlan.push({
        name,
        commandKind: command?.commandKind ?? this.defaultCommandKind(name),
        payload: command?.payload ?? null,
        snapshot: {
          operationKind: context.operationKind,
          commandKind: context.commandKind,
          serverId: context.serverId,
          resourceType: context.resourceType,
          resourceId: context.resourceId,
          requestedBy: context.requestedBy,
        },
      });
    }

    return {
      hookPlan,
      resourceKeys,
    };
  }

  async buildCommand(
    entry: CommandHookPlanEntry,
    context: CommandHookContext,
  ): Promise<{ commandKind: AgentCommandKind; payload: unknown } | null> {
    const hook = this.requiredHook(entry.name);
    const command = await hook.buildCommand(context);
    if (command) return command;
    if (!entry.payload) return null;
    return {
      commandKind: entry.commandKind,
      payload: entry.payload,
    };
  }

  async mergeResult(
    entry: CommandHookPlanEntry,
    context: CommandHookContext,
    result: unknown,
  ): Promise<void> {
    await this.requiredHook(entry.name).mergeResult(context, result);
  }

  private requiredHook(name: CommandHookName): CommandHook {
    const hook = this.hooksByName.get(name);
    if (!hook) throw new Error(`Command hook provider missing: ${name}`);
    return hook;
  }

  private defaultCommandKind(name: CommandHookName): AgentCommandKind {
    switch (name) {
      case CommandHookName.ContainerMountsEnsure:
        return AgentCommandKind.RuntimeContainerMountsApply;
      case CommandHookName.ContainerSshEnsure:
        return AgentCommandKind.RuntimeContainerSshApply;
      default:
        throw new Error(`Unknown command hook name: ${name}`);
    }
  }
}
