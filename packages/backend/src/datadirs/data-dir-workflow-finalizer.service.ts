import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AgentTaskKind, AgentTaskStatus } from '@nyabase/common';
import type { Transaction } from 'kysely';
import {
  WorkflowFinalizerRegistry,
  type WorkflowFinalizerHandler,
  type WorkflowTerminalResult,
} from '../agent-tasks/workflow-finalizer.registry.js';
import type { WorkflowTaskRecord } from '../agent-tasks/workflow.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { StorageRepository } from '../storage/storage.repository.js';

@Injectable()
export class DataDirWorkflowFinalizerService
implements OnModuleInit, OnModuleDestroy {
  private unregister: Array<() => void> = [];

  constructor(
    private readonly registry: WorkflowFinalizerRegistry,
    private readonly storage: StorageRepository,
  ) {}

  onModuleInit(): void {
    this.unregister = [
      this.registry.register(
        AgentTaskKind.DataDirEnsure,
        this.handler('creating'),
      ),
      this.registry.register(
        AgentTaskKind.DataDirAbsent,
        this.handler('removing'),
      ),
    ];
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregister.splice(0)) unregister();
  }

  private handler(
    expectedState: 'creating' | 'removing',
  ): WorkflowFinalizerHandler {
    return (transaction, task, result) =>
      this.finalize(transaction, task, result, expectedState);
  }

  private async finalize(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    terminal: WorkflowTerminalResult,
    expectedState: 'creating' | 'removing',
  ) {
    const row = await this.requireCurrent(
      transaction,
      task,
      expectedState,
    );
    if (terminal.status === 'succeeded') {
      if (task.kind === AgentTaskKind.DataDirEnsure) {
        const transitioned = await this.storage.transitionDataDirectory(
          row.id,
          row.generation,
          ['creating'],
          {
            desiredState: 'active',
            generation: row.generation,
            lastTaskId: task.id,
          },
          transaction,
        );
        if (!transitioned) throw new Error(`datadir task ${task.id} lost its projection fence`);
      } else if (!await this.storage.deleteDataDirectory(
        row.id,
        row.generation,
        transaction,
      )) {
        throw new Error(`datadir task ${task.id} lost its deletion fence`);
      }
      return {
        status: AgentTaskStatus.Succeeded,
        result: terminal.result,
        releaseClaims: true,
      } as const;
    }

    const transitioned = await this.storage.transitionDataDirectory(
      row.id,
      row.generation,
      [expectedState],
      {
        desiredState: 'failed',
        generation: row.generation,
        lastTaskId: task.id,
      },
      transaction,
    );
    if (!transitioned) throw new Error(`datadir task ${task.id} lost its failure fence`);
    return {
      status: AgentTaskStatus.Failed,
      error: terminal.error,
      failureStage: 'agent',
      releaseClaims: true,
    } as const;
  }

  private async requireCurrent(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    desiredState: 'creating' | 'removing',
  ) {
    const row = await this.storage.findDataDirectoryById(
      task.resourceId,
      transaction,
    );
    if (
      !row
      || row.lastTaskId !== task.id
      || row.desiredState !== desiredState
      || (row.sourceKind === 'local' && row.serverId !== task.serverId)
    ) {
      throw new Error(`datadir task ${task.id} no longer owns its durable projection`);
    }
    const payload = record(task.payload);
    const generation = number(payload.generation);
    if (
      generation === null
      || row.generation !== generation
      || string(payload.resourceId) !== task.resourceId
      || string(payload.diskId) !== row.sourceId
      || string(payload.sourceIdentity) !== row.sourceIdentity
    ) {
      throw new Error(`datadir task ${task.id} no longer owns its durable generation`);
    }
    if (desiredState === 'creating' && row.sourceKind === 'local') {
      const quota = await this.storage.findQuotaDesired(
        task.serverId,
        row.userId,
        transaction,
      );
      if (
        !quota
        || !quota.lastTaskId
        || quota.generation !== number(payload.quotaGeneration)
        || quota.numericUserId !== number(payload.numericUserId)
        || quota.limitBytes !== number(payload.diskBytes)
      ) {
        throw new Error(`datadir task ${task.id} no longer matches durable quota intent`);
      }
    }
    return row;
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
