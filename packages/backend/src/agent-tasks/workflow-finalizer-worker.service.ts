import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AgentTaskKind } from '@nyabase/common';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';
import {
  WorkflowFinalizerRegistry,
  type WorkflowTerminalResult,
} from './workflow-finalizer.registry.js';
import {
  WorkflowRepository,
  type FinalizerClaim,
} from './workflow.repository.js';

const FINALIZER_POLL_MS = 1_000;

@Injectable()
export class WorkflowFinalizerWorkerService
implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowFinalizerWorkerService.name);
  private readonly workerId = `workflow-finalizer:${process.pid}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing: Promise<number> | null = null;
  private stopped = false;

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly registry: WorkflowFinalizerRegistry,
    private readonly runtimeRole?: RuntimeRoleService,
  ) {}

  onModuleInit(): void {
    if (this.runtimeRole && !this.runtimeRole.runsWorker()) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.process(), FINALIZER_POLL_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.processing;
  }

  wake(): void {
    if (this.stopped || (this.runtimeRole && !this.runtimeRole.runsWorker())) return;
    void this.process();
  }

  async process(): Promise<number> {
    if (this.stopped) return 0;
    if (this.processing) return this.processing;
    const processing = this.processBatch();
    this.processing = processing;
    try {
      return await processing;
    } finally {
      if (this.processing === processing) this.processing = null;
    }
  }

  private async processBatch(): Promise<number> {
    try {
      const claims = await this.repository.claimFinalizers(this.workerId);
      let completed = 0;
      for (const claim of claims) {
        if (this.stopped) break;
        const handler = this.registry.get(claim.task.kind as AgentTaskKind);
        if (!handler) {
          await this.defer(claim, new Error(
            `No PostgreSQL finalizer registered for ${claim.task.kind}`,
          ));
          continue;
        }
        try {
          const result = terminalResult(claim);
          const finalized = await this.repository.finalizeClaim(
            claim,
            async (transaction, task) => {
              const outcome = await handler(transaction, task, result);
              return { outcome, value: undefined };
            },
          );
          if (finalized.applied) completed += 1;
        } catch (error) {
          await this.defer(claim, error);
        }
      }
      return completed;
    } catch (error) {
      this.logger.warn(`Workflow finalizer poll failed: ${errorMessage(error)}`);
      return 0;
    }
  }

  private async defer(claim: FinalizerClaim, error: unknown): Promise<void> {
    const attempt = claim.task.finalizerAttemptCount;
    const delay = Math.min(60_000, 1_000 * (2 ** Math.min(attempt, 6)));
    await this.repository.deferFinalizer(
      claim.task.id,
      claim.generation,
      claim.claimToken,
      error,
      { afterMs: delay },
    );
    this.logger.warn(
      `Workflow finalizer ${claim.task.id} deferred: ${errorMessage(error)}`,
    );
  }
}

function terminalResult(claim: FinalizerClaim): WorkflowTerminalResult {
  const evidence = claim.task.agentResult;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Workflow task has no terminal Agent evidence object');
  }
  return {
    ...(evidence as Record<string, unknown>),
    taskId: claim.task.id,
    payloadHash: claim.task.payloadHash,
  } as WorkflowTerminalResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
