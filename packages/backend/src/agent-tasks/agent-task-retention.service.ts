import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';
import { WorkflowRepository } from './workflow.repository.js';

export const AGENT_TASK_MIN_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MAX_AGENT_TASKS_PER_RETENTION_WINDOW = 16_384;
export const MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW = 4_096;
export const MAX_NON_SAFETY_AGENT_TASKS_PER_RETENTION_WINDOW = 8_192;
export const MAX_AGENT_TASK_ROWS_HARD = 262_144;

const RETENTION_INTERVAL_MS = 60_000;
const RETENTION_BATCH_SIZE = 256;
const MAX_RETENTION_SCAN_PER_PASS = 4_096;

/** Bounded purge of terminal workflow history that has no retained claims. */
@Injectable()
export class AgentTaskRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTaskRetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setImmediate> | null = null;
  private processing: Promise<{ scanned: number; deleted: number }> | null = null;
  private stopped = false;

  constructor(
    private readonly workflow: WorkflowRepository,
    private readonly runtimeRole: RuntimeRoleService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeRole.runsWorker()) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), RETENTION_INTERVAL_MS);
    this.timer.unref?.();
    this.wake();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearImmediate(this.wakeTimer);
    this.timer = null;
    this.wakeTimer = null;
    await this.processing;
  }

  wake(): void {
    if (this.stopped || !this.runtimeRole.runsWorker() || this.wakeTimer) return;
    this.wakeTimer = setImmediate(() => {
      this.wakeTimer = null;
      if (!this.stopped) void this.process();
    });
  }

  async process(): Promise<{ scanned: number; deleted: number }> {
    if (this.stopped || !this.runtimeRole.runsWorker()) {
      return { scanned: 0, deleted: 0 };
    }
    if (this.processing) return this.processing;
    const processing = this.processPass();
    this.processing = processing;
    try {
      return await processing;
    } finally {
      if (this.processing === processing) this.processing = null;
    }
  }

  private async processPass(): Promise<{ scanned: number; deleted: number }> {
    try {
      let deleted = 0;
      while (!this.stopped && deleted < MAX_RETENTION_SCAN_PER_PASS) {
        const count = await this.workflow.purgeTerminalRetention(
          AGENT_TASK_MIN_RETENTION_MS,
          RETENTION_BATCH_SIZE,
        );
        deleted += count;
        if (count < RETENTION_BATCH_SIZE) break;
      }
      return { scanned: deleted, deleted };
    } catch (error) {
      this.logger.warn(`Agent task retention scan failed: ${this.errorMessage(error)}`);
      return { scanned: 0, deleted: 0 };
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
