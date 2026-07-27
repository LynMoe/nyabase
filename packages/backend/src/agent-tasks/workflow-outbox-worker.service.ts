import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  RedisDisposableAdapter,
  type DisposableWakeTopic,
} from '../runtime/redis-disposable.adapter.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';
import { WorkflowRepository } from './workflow.repository.js';

const OUTBOX_POLL_MS = 5_000;

/**
 * Delivers only post-commit disposable wake hints. Durable work ownership
 * remains PostgreSQL; a missing Redis instance never loses a task.
 */
@Injectable()
export class WorkflowOutboxWorkerService
implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowOutboxWorkerService.name);
  private readonly workerId = `workflow-outbox:${process.pid}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing: Promise<number> | null = null;
  private stopped = false;

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly runtimeRole?: RuntimeRoleService,
    private readonly redis?: RedisDisposableAdapter,
  ) {}

  onModuleInit(): void {
    if (this.runtimeRole && !this.runtimeRole.runsWorker()) return;
    this.timer = setInterval(() => void this.process(), OUTBOX_POLL_MS);
    this.timer.unref?.();
    void this.process();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.processing;
  }

  async process(): Promise<number> {
    if (this.stopped || this.processing) return 0;
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
      const claims = await this.repository.claimOutbox(this.workerId);
      let published = 0;
      let redisAvailable = Boolean(this.redis);
      for (const claim of claims) {
        if (!redisAvailable || !this.redis) continue;
        try {
          const topic = wakeTopic(claim.topic);
          const delivered = await this.redis.publish(
            topic,
            JSON.stringify(claim.payload),
          );
          if (delivered) published += 1;
          else redisAvailable = false;
        } catch (error) {
          redisAvailable = false;
          this.logger.warn(
            `Workflow wake ${claim.id} publication failed: ${errorMessage(error)}`,
          );
        }
      }
      // These rows are disposable latency hints, not durable delivery
      // obligations. Complete the whole claimed batch in one transaction.
      // After the first Redis failure this poll skips the remaining publishes;
      // PostgreSQL polling still guarantees progress without N connect waits.
      const completed = await this.repository.completeOutboxClaims(claims);
      if (completed !== claims.length) {
        this.logger.warn(
          `Workflow outbox completed ${completed}/${claims.length} claimed hints`,
        );
      }
      return published;
    } catch (error) {
      this.logger.warn(`Workflow outbox poll failed: ${errorMessage(error)}`);
      return 0;
    }
  }
}

function wakeTopic(value: string): DisposableWakeTopic {
  switch (value) {
    case 'dispatch':
    case 'reconcile':
    case 'proxy-snapshot':
    case 'cache-invalidation':
      return value;
    default:
      throw new Error(`Unsupported workflow outbox topic ${value}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
