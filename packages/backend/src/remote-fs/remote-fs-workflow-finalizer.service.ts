import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AgentTaskKind, AgentTaskStatus } from '@nyabase/common';
import { isDeepStrictEqual } from 'node:util';
import type { Transaction } from 'kysely';
import {
  WorkflowFinalizerRegistry,
  type WorkflowTerminalResult,
} from '../agent-tasks/workflow-finalizer.registry.js';
import type { WorkflowTaskRecord } from '../agent-tasks/workflow.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { StorageRepository } from '../storage/storage.repository.js';

@Injectable()
export class RemoteFsWorkflowFinalizerService
implements OnModuleInit, OnModuleDestroy {
  private unregister: Array<() => void> = [];

  constructor(
    private readonly registry: WorkflowFinalizerRegistry,
    private readonly storage: StorageRepository,
  ) {}

  onModuleInit(): void {
    this.unregister = [
      this.registry.register(
        AgentTaskKind.RemoteFsEnsure,
        (transaction, task, result) =>
          this.finalizeEnsure(transaction, task, result),
      ),
      this.registry.register(
        AgentTaskKind.RemoteFsAbsent,
        (transaction, task, result) =>
          this.finalizeAbsent(transaction, task, result),
      ),
    ];
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregister.splice(0)) unregister();
  }

  private async finalizeEnsure(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    terminal: WorkflowTerminalResult,
  ) {
    await this.assertMountCurrent(transaction, task);
    const assignment = await this.requireAssignment(transaction, task);
    if (terminal.status === 'succeeded') {
      const transitioned = await this.storage.transitionAssignment(
        assignment.id,
        assignment.generation,
        ['ensuring'],
        {
          desiredState: 'active',
          generation: assignment.generation,
          lastTaskId: task.id,
        },
        transaction,
      );
      if (!transitioned) throw new Error(`remote_fs task ${task.id} lost its projection fence`);
      return {
        status: AgentTaskStatus.Succeeded,
        result: terminal.result,
        releaseClaims: true,
      } as const;
    }
    const transitioned = await this.storage.transitionAssignment(
      assignment.id,
      assignment.generation,
      ['ensuring', 'active', 'failed'],
      {
        desiredState: 'failed',
        generation: assignment.generation,
        lastTaskId: task.id,
      },
      transaction,
    );
    if (!transitioned) throw new Error(`remote_fs task ${task.id} lost its failure fence`);
    return {
      status: AgentTaskStatus.Failed,
      error: terminal.error,
      failureStage: 'agent',
      releaseClaims: true,
    } as const;
  }

  private async finalizeAbsent(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    terminal: WorkflowTerminalResult,
  ) {
    const request = record(task.request);
    if (request.scope !== 'assignment') {
      throw new Error('remote_fs.absent only supports assignment scope');
    }
    const assignment = await this.requireAssignment(
      transaction,
      task,
      'removing',
    );
    if (terminal.status === 'succeeded') {
      if (!await this.storage.deleteAssignment(
        assignment.id,
        assignment.generation,
        transaction,
      )) {
        throw new Error(`remote_fs task ${task.id} lost its deletion fence`);
      }
      return {
        status: AgentTaskStatus.Succeeded,
        result: terminal.result,
        releaseClaims: true,
      } as const;
    }
    // Preserve the old state machine: a failed unmount remains removing so an
    // explicit repair/retry cannot expose the assignment as usable.
    return {
      status: AgentTaskStatus.Failed,
      error: terminal.error,
      failureStage: 'agent',
      releaseClaims: true,
    } as const;
  }

  private async assertMountCurrent(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
  ): Promise<void> {
    const request = record(task.request);
    if (request.scope !== 'assign') {
      throw new Error('remote_fs.ensure only supports assignment scope');
    }
    const expected = record(request.mount);
    const current = await this.storage.findRemoteFsMount(
      task.resourceId,
      transaction,
    );
    if (!current || current.desiredState !== 'active') {
      throw new Error(`remote_fs.ensure mount ${task.resourceId} is missing or inactive`);
    }
    if (
      string(expected.type) !== current.type
      || string(expected.hostMountPoint) !== current.hostMountPoint
      || (typeof expected.options === 'string' ? expected.options : '') !== current.options
      || number(expected.generation) !== current.generation
      || !isDeepStrictEqual(expected.params, current.params)
    ) {
      throw new Error(
        `remote_fs.ensure mount ${task.resourceId} generation or physical spec changed`,
      );
    }
  }

  private async requireAssignment(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    desiredState?: 'ensuring' | 'active' | 'removing' | 'failed',
  ) {
    const assignment = await this.storage.findAssignment(
      task.resourceId,
      task.serverId,
      transaction,
    );
    if (
      !assignment
      || assignment.lastTaskId !== task.id
      || (desiredState !== undefined && assignment.desiredState !== desiredState)
    ) {
      throw new Error(`remote_fs task ${task.id} no longer owns its server assignment`);
    }
    return assignment;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
