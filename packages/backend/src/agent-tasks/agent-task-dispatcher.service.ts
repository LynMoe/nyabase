import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { TaskExecutePayload } from '@nyabase/common';
import {
  AGENT_TASK_RESEND_INTERVAL_MS,
  AgentTasksService,
  PermanentTaskPayloadError,
} from './agent-tasks.service.js';
import type { AgentTaskEntity } from '../entities/agent-task.entity.js';

const WORKER_INTERVAL_MS = 1_000;

export interface AgentTaskTransport {
  onlineServerIds(): string[];
  send(serverId: string, payload: TaskExecutePayload): void;
  quarantine?(serverId: string, reason: string): Promise<void>;
}

@Injectable()
export class AgentTaskDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTaskDispatcherService.name);
  private transport: AgentTaskTransport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setImmediate> | null = null;
  private processing = false;
  private nextServerOffset = 0;

  constructor(private tasks: AgentTasksService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.process().catch((error) =>
      this.handleWorkerError(error, 'dispatch')), WORKER_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearImmediate(this.wakeTimer);
  }

  registerTransport(transport: AgentTaskTransport): void {
    this.transport = transport;
    this.wake();
  }

  wake(): void {
    if (this.wakeTimer) return;
    this.wakeTimer = setImmediate(() => {
      this.wakeTimer = null;
      void this.process().catch((error) => {
        this.handleWorkerError(error, 'wake');
      });
    });
  }

  async process(): Promise<number> {
    if (this.processing || !this.transport) return 0;
    this.processing = true;
    try {
      let sent = 0;
      const exhausted = await this.tasks.failExhaustedTasks();
      const fences = await Promise.allSettled(exhausted.serverIds.map((serverId) =>
        this.transport!.quarantine?.(serverId, 'Agent task outcome deadline exhausted')));
      for (const [index, fence] of fences.entries()) {
        if (fence.status === 'rejected') {
          this.logger.warn(
            `Server ${exhausted.serverIds[index]} session fence failed after durable quarantine: ${this.errorMessage(fence.reason)}`,
          );
        }
      }
      const serverIds = this.rotatedServerIds(this.transport.onlineServerIds());
      const cutoff = new Date(Date.now() - AGENT_TASK_RESEND_INTERVAL_MS);
      for (const serverId of serverIds) {
        let task: AgentTaskEntity | null;
        try {
          task = await this.tasks.nextDueForDispatch(serverId, cutoff);
        } catch (error) {
          this.logger.warn(
            `Server ${serverId} dispatch selection failed: ${this.errorMessage(error)}`,
          );
          continue;
        }
        if (!task) continue;

        let payload: TaskExecutePayload | null;
        try {
          payload = await this.tasks.markSentAndBuild(task.id);
        } catch (error) {
          if (error instanceof PermanentTaskPayloadError) {
            const neverDispatched = task.startedAt === null
              && task.lastSentAt === null;
            if (neverDispatched) {
              await this.tasks.stageNeverDispatchedPayloadFailure(task.id, error);
              this.logger.error(`Task ${task.id} rejected before first dispatch: ${this.errorMessage(error)}`);
              continue;
            }
            const quarantinedServerId = await this.tasks.failPostDispatchPayloadCorruption(task.id, error);
            if (quarantinedServerId) {
              try {
                await this.transport.quarantine?.(
                  quarantinedServerId,
                  'Agent task payload is corrupt after physical dispatch',
                );
              } catch (fenceError) {
                this.logger.warn(
                  `Server ${quarantinedServerId} session fence failed after durable quarantine: ${this.errorMessage(fenceError)}`,
                );
              }
            }
            this.logger.error(
              `Task ${task.id} payload is corrupt after dispatch; task failed and server quarantined`,
            );
            continue;
          }
          await this.tasks.deferDispatchFailure(task.id, error).catch((diagnosticError) => {
            this.logger.warn(
              `Task ${task.id} dispatch diagnostic failed: ${this.errorMessage(diagnosticError)}`,
            );
          });
          this.logger.warn(`Task ${task.id} payload build deferred: ${this.errorMessage(error)}`);
          continue;
        }
        if (!payload) continue;
        try {
          this.transport.send(task.serverId, payload);
          sent += 1;
        } catch (error) {
          this.logger.debug(`Task ${task.id} send deferred: ${this.errorMessage(error)}`);
        }
      }
      return sent;
    } finally {
      this.processing = false;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private rotatedServerIds(serverIds: string[]): string[] {
    const unique = [...new Set(serverIds)];
    if (unique.length === 0) return [];
    const offset = this.nextServerOffset % unique.length;
    this.nextServerOffset = (offset + 1) % unique.length;
    return [...unique.slice(offset), ...unique.slice(0, offset)];
  }

  private handleWorkerError(error: unknown, source: string): void {
    this.logger.warn(`Agent task ${source} failed: ${this.errorMessage(error)}`);
  }
}
