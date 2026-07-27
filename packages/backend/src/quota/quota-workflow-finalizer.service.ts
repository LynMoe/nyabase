import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AgentTaskKind,
  AgentTaskStatus,
  UserStatus,
} from '@nyabase/common';
import type { Transaction } from 'kysely';
import {
  WorkflowFinalizerRegistry,
  type WorkflowTerminalResult,
} from '../agent-tasks/workflow-finalizer.registry.js';
import type { WorkflowTaskRecord } from '../agent-tasks/workflow.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { StorageRepository } from '../storage/storage.repository.js';

@Injectable()
export class QuotaWorkflowFinalizerService
implements OnModuleInit, OnModuleDestroy {
  private unregister: (() => void) | null = null;

  constructor(
    private readonly registry: WorkflowFinalizerRegistry,
    private readonly storage: StorageRepository,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(
      AgentTaskKind.QuotaEnsure,
      async (transaction, task, result) => this.finalize(transaction, task, result),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = null;
  }

  private async finalize(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    terminal: WorkflowTerminalResult,
  ) {
    const payload = record(task.payload);
    const quota = await this.storage.findQuotaDesired(
      task.serverId,
      task.resourceId,
      transaction,
    );
    if (
      !quota
      || quota.lastTaskId !== task.id
      || quota.generation !== number(payload.generation)
      || quota.numericUserId !== number(payload.numericUserId)
      || quota.limitBytes !== number(payload.diskBytes)
    ) {
      throw new Error(`quota.ensure task ${task.id} no longer owns its durable projection`);
    }
    if (terminal.status === 'succeeded') {
      await this.finalizeDeletingUser(transaction, task);
      return {
          status: AgentTaskStatus.Succeeded,
          result: terminal.result,
          releaseClaims: true,
        } as const;
    }
    return {
      status: AgentTaskStatus.Failed,
      error: terminal.error,
      failureStage: 'agent',
      releaseClaims: true,
    } as const;
  }

  private async finalizeDeletingUser(
    transaction: Transaction<NyabaseDatabase>,
    currentTask: WorkflowTaskRecord,
  ): Promise<void> {
    const user = await transaction.selectFrom('iam.users')
      .select(['id', 'status'])
      .where('id', '=', currentTask.resourceId)
      .executeTakeFirst();
    if (user?.status !== UserStatus.Deleting) return;
    if (await transaction.selectFrom('control.authorization_dependencies')
      .select('id')
      .where('user_id', '=', user.id)
      .executeTakeFirst()) {
      throw new Error(`deleting user ${user.id} regained a durable resource dependency`);
    }
    const desired = await transaction.selectFrom('control.quota_desired')
      .selectAll()
      .where('user_id', '=', user.id)
      .execute();
    for (const quota of desired) {
      if (!quota.last_task_id || Number(quota.limit_bytes) !== 0) {
        throw new Error(`deleting user ${user.id} has non-zero durable quota intent`);
      }
      if (quota.last_task_id === currentTask.id) continue;
      const proof = await transaction.selectFrom('workflow.tasks')
        .select(['status', 'payload_json'])
        .where('id', '=', quota.last_task_id)
        .executeTakeFirst();
      const payload = record(proof?.payload_json);
      if (
        proof?.status !== AgentTaskStatus.Succeeded
        || number(payload.generation) !== quota.generation
        || number(payload.numericUserId) !== quota.numeric_user_id
        || number(payload.diskBytes) !== 0
      ) {
        return;
      }
    }
    await Promise.all([
      transaction.deleteFrom('iam.refresh_tokens').where('user_id', '=', user.id).execute(),
      transaction.deleteFrom('iam.api_tokens').where('user_id', '=', user.id).execute(),
      transaction.deleteFrom('iam.ssh_public_keys').where('user_id', '=', user.id).execute(),
      transaction.deleteFrom('iam.user_internal_ssh_keys').where('user_id', '=', user.id).execute(),
      transaction.deleteFrom('iam.group_members').where('user_id', '=', user.id).execute(),
      transaction.deleteFrom('iam.server_grants').where('user_id', '=', user.id).execute(),
      transaction.deleteFrom('iam.image_grants').where('user_id', '=', user.id).execute(),
      transaction.deleteFrom('iam.mount_source_grants').where('user_id', '=', user.id).execute(),
    ]);
    await transaction.deleteFrom('control.quota_desired')
      .where('user_id', '=', user.id)
      .execute();
    await transaction.updateTable('iam.users')
      .set({
        status: UserStatus.Deleted,
        updated_at: new Date(),
      })
      .where('id', '=', user.id)
      .where('status', '=', UserStatus.Deleting)
      .executeTakeFirstOrThrow();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
