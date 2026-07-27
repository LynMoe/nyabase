import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AgentTaskKind,
  AgentTaskStatus,
  parseAgentTaskPayload,
} from '@nyabase/common';
import { sql, type Transaction } from 'kysely';
import {
  WorkflowFinalizerRegistry,
  type WorkflowTerminalResult,
} from '../agent-tasks/workflow-finalizer.registry.js';
import type {
  WorkflowFinalizerOutcome,
  WorkflowTaskRecord,
} from '../agent-tasks/workflow.repository.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';

const IMAGE_KINDS = [
  AgentTaskKind.ImageEnsurePresent,
  AgentTaskKind.ImageEnsureAbsent,
] as const;

@Injectable()
export class ImageWorkflowFinalizerService
implements OnModuleInit, OnModuleDestroy {
  private unregister: Array<() => void> = [];

  constructor(
    private readonly registry: WorkflowFinalizerRegistry,
    private readonly infrastructure: InfrastructureRepository,
  ) {}

  onModuleInit(): void {
    this.unregister = IMAGE_KINDS.map((kind) => this.registry.register(
      kind,
      (transaction, task, result) =>
        this.finalize(transaction, task, result),
    ));
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregister.splice(0)) unregister();
  }

  private async finalize(
    transaction: Transaction<NyabaseDatabase>,
    task: WorkflowTaskRecord,
    terminal: WorkflowTerminalResult,
  ): Promise<WorkflowFinalizerOutcome> {
    const kind = task.kind as AgentTaskKind;
    if (!IMAGE_KINDS.includes(kind as typeof IMAGE_KINDS[number])) {
      throw new Error(`Unsupported Image Workflow finalizer ${task.kind}`);
    }
    const image = await this.infrastructure.lockImage(
      task.resourceId,
      transaction,
    );
    if (!image) {
      throw new Error(`Image task ${task.id} has no durable image authority`);
    }
    const payload = parseAgentTaskPayload(kind, task.payload) as {
      dockerRef: string;
      imageId?: string;
    };
    if (
      payload.dockerRef !== image.dockerImage
      || (payload.imageId !== undefined && payload.imageId !== image.id)
    ) throw new Error(`Image task ${task.id} no longer matches its durable image`);

    if (kind === AgentTaskKind.ImageEnsurePresent) {
      if (image.deleting) {
        throw new Error(`Image pull task ${task.id} lost its non-deleting authority`);
      }
    } else {
      const request = this.record(task.request);
      const generation = this.integer(request?.cleanupGeneration);
      if (
        !image.deleting
        || generation === null
        || generation !== image.cleanupGeneration
        || request?.dockerRef !== image.dockerImage
      ) throw new Error(`Image cleanup task ${task.id} lost its durable generation`);
      if (terminal.status === 'succeeded') {
        const unresolved = await transaction.selectFrom('workflow.tasks')
          .select('id')
          .where('kind', '=', AgentTaskKind.ImageEnsureAbsent)
          .where('resource_type', '=', 'image')
          .where('resource_id', '=', image.id)
          .where('id', '!=', task.id)
          .where('status', '!=', AgentTaskStatus.Succeeded)
          .where(sql<boolean>`COALESCE(
            CASE
              WHEN jsonb_typeof(request_json -> 'cleanupGeneration') = 'number'
              THEN (request_json ->> 'cleanupGeneration')::integer
              ELSE NULL
            END,
            ${generation}
          ) = ${generation}`)
          .limit(1)
          .executeTakeFirst();
        if (!unresolved) {
          await this.infrastructure.deleteImage(image.id, transaction);
        }
      }
    }
    return terminal.status === 'succeeded'
      ? {
          status: AgentTaskStatus.Succeeded,
          result: terminal.result,
          releaseClaims: true,
        }
      : {
          status: AgentTaskStatus.Failed,
          error: terminal.error,
          failureStage: 'agent',
          releaseClaims: true,
        };
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private integer(value: unknown): number | null {
    return Number.isInteger(value) ? value as number : null;
  }
}
