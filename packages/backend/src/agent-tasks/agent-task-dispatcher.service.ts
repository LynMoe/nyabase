import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { TaskExecutePayload } from '@nyabase/common';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';
import { RedisDisposableAdapter } from '../runtime/redis-disposable.adapter.js';
import {
  WorkflowDispatchService,
  type WorkflowDispatch,
  type WorkflowAgentSessionBinding,
} from './workflow-dispatch.service.js';

const WORKER_INTERVAL_MS = 1_000;

export interface AgentTaskTransport {
  onlineSessions(): Array<{ serverId: string; session: WorkflowAgentSessionBinding }>;
  send(
    serverId: string,
    session: WorkflowAgentSessionBinding,
    payload: TaskExecutePayload,
  ): boolean;
  quarantine?(serverId: string, reason: string): Promise<void>;
}

/**
 * Gateway-local socket pump for the canonical PostgreSQL workflow queue.
 * PostgreSQL owns selection, leases and attempts; Redis only shortens wake-up
 * latency and may disappear without changing dispatch authority.
 */
@Injectable()
export class AgentTaskDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTaskDispatcherService.name);
  private transport: AgentTaskTransport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setImmediate> | null = null;
  private processing: Promise<number> | null = null;
  private nextServerOffset = 0;
  private unsubscribeRedis: (() => Promise<void>) | null = null;
  private redisSubscription: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly runtimeRole: RuntimeRoleService,
    private readonly redis: RedisDisposableAdapter,
    private readonly workflow: WorkflowDispatchService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeRole.servesGateway()) return;
    this.stopped = false;
    this.redisSubscription = this.redis
      .subscribe('dispatch', () => this.wake())
      .then(async (unsubscribe) => {
        if (this.stopped) {
          await unsubscribe();
          return;
        }
        this.unsubscribeRedis = unsubscribe;
      })
      .catch((error) => {
        this.handleWorkerError(error, 'Redis subscription');
      })
      .finally(() => {
        this.redisSubscription = null;
      });
    this.timer = setInterval(() => void this.process().catch((error) =>
      this.handleWorkerError(error, 'dispatch')), WORKER_INTERVAL_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearImmediate(this.wakeTimer);
    this.timer = null;
    this.wakeTimer = null;
    await this.redisSubscription;
    await this.unsubscribeRedis?.();
    this.unsubscribeRedis = null;
    await this.processing;
  }

  registerTransport(transport: AgentTaskTransport): void {
    this.transport = transport;
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    if (!this.runtimeRole.servesGateway()) {
      void this.redis.publish('dispatch', 'wake');
      return;
    }
    if (this.wakeTimer) return;
    this.wakeTimer = setImmediate(() => {
      this.wakeTimer = null;
      if (!this.stopped) void this.process();
    });
  }

  async process(): Promise<number> {
    if (this.stopped || !this.runtimeRole.servesGateway() || !this.transport) return 0;
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
      let sent = 0;
      const transport = this.transport;
      if (!transport) return 0;
      for (const binding of this.rotatedBindings(transport.onlineSessions())) {
        if (this.stopped) break;
        const { serverId, session } = binding;
        let dispatch: WorkflowDispatch | null;
        try {
          dispatch = await this.workflow.claimAndBuild(serverId, session);
        } catch (error) {
          this.logger.warn(
            `Server ${serverId} PostgreSQL dispatch deferred: ${this.errorMessage(error)}`,
          );
          continue;
        }
        if (!dispatch) continue;
        try {
          if (!await this.workflow.markSentAndSend(
            dispatch,
            () => transport.send(serverId, session, dispatch!.payload),
          )) {
            this.logger.warn(
              `Task ${dispatch.claim.task.id} lost its durable dispatch claim before send acknowledgement`,
            );
            continue;
          }
          sent += 1;
        } catch (error) {
          this.logger.debug(
            `Task ${dispatch.claim.task.id} send deferred: ${this.errorMessage(error)}`,
          );
        }
      }
      return sent;
    } catch (error) {
      this.handleWorkerError(error, 'dispatch');
      return 0;
    }
  }

  private rotatedBindings(
    bindings: Array<{ serverId: string; session: WorkflowAgentSessionBinding }>,
  ): Array<{ serverId: string; session: WorkflowAgentSessionBinding }> {
    const unique = [...new Map(bindings.map((binding) => [binding.serverId, binding])).values()];
    if (unique.length === 0) return [];
    const offset = this.nextServerOffset % unique.length;
    this.nextServerOffset = (offset + 1) % unique.length;
    return [...unique.slice(offset), ...unique.slice(0, offset)];
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private handleWorkerError(error: unknown, source: string): void {
    this.logger.warn(`Agent task ${source} failed: ${this.errorMessage(error)}`);
  }
}
