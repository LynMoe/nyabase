import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  AgentTaskStatus,
  AgentTaskKind,
  ServerStatus,
} from '@nyabase/common';
import { DataSource, IsNull, LessThanOrEqual, MoreThan, Not } from 'typeorm';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import {
  AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
  ServerEntity,
} from '../entities/server.entity.js';
import { AgentTaskFinalizerService } from './agent-task-finalizer.service.js';
import { ResourceLockService } from './resource-lock.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';
import {
  parseAndValidateStagedTerminalResult,
  STAGED_AGENT_RESULT_CORRUPT_CODE,
  StagedTerminalEvidenceError,
} from './agent-task-staged-result.js';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';

const WORKER_INTERVAL_MS = 1_000;
const FINALIZE_BATCH_SIZE = 32;
const MAX_FINALIZE_SCAN_PER_PASS = 256;
const FINALIZER_RETRY_BASE_MS = 1_000;
const FINALIZER_RETRY_MAX_MS = 60_000;
export const MAX_FINALIZER_ATTEMPTS = 12;

type FinalizeTaskOutcome =
  | { kind: 'skipped' }
  | { kind: 'finalized' }
  | { kind: 'staged-corrupt'; serverId: string; details: string };

/**
 * Applies staged Agent outcomes using database-only retries. A staged outcome
 * keeps the task pending and its resource locks held until this worker commits
 * the domain finalizer, terminal task state, and lock release atomically.
 */
@Injectable()
export class AgentTaskFinalizerWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTaskFinalizerWorkerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setImmediate> | null = null;
  private processing = false;

  constructor(
    private dataSource: DataSource,
    private finalizer: AgentTaskFinalizerService,
    private resourceLocks: ResourceLockService,
    private payloadCodec: AgentTaskPayloadCodecService,
    private proxySnapshots: ProxySnapshotNotifierService,
    private accessCacheEpoch: AccessCacheEpochService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.process().catch((error) => {
      this.logger.warn(`Agent task finalization scan failed: ${this.logErrorMessage(error)}`);
    }), WORKER_INTERVAL_MS);
    this.timer.unref?.();
    // Completes outcomes which were staged before a Backend process restart.
    this.wake();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearImmediate(this.wakeTimer);
  }

  wake(): void {
    if (this.wakeTimer) return;
    this.wakeTimer = setImmediate(() => {
      this.wakeTimer = null;
      void this.process().catch((error) => {
        this.logger.warn(`Agent task finalization wake failed: ${this.logErrorMessage(error)}`);
      });
    });
  }

  async process(): Promise<number> {
    if (this.processing) return 0;
    this.processing = true;
    try {
      let finalized = 0;
      let scanned = 0;
      while (scanned < MAX_FINALIZE_SCAN_PER_PASS) {
        const now = new Date();
        const take = Math.min(FINALIZE_BATCH_SIZE, MAX_FINALIZE_SCAN_PER_PASS - scanned);
        const tasks = await this.dataSource.getRepository(AgentTaskEntity).find({
          // finalizeTask reloads and verifies one complete row inside the
          // serialized transaction. The due-list scan needs identities only.
          select: { id: true },
          where: [
            {
              status: AgentTaskStatus.Pending,
              agentResultJson: Not(IsNull()),
              finalizerRetryAt: IsNull(),
            },
            {
              status: AgentTaskStatus.Pending,
              agentResultJson: Not(IsNull()),
              finalizerRetryAt: LessThanOrEqual(now),
            },
            {
              status: AgentTaskStatus.Pending,
              agentResultJson: Not(IsNull()),
              finalizerRetryAt: MoreThan(new Date(now.getTime() + FINALIZER_RETRY_MAX_MS)),
            },
          ],
          order: { finalizerRetryAt: 'ASC', createdAt: 'ASC' },
          take,
        });
        if (tasks.length === 0) break;
        scanned += tasks.length;
        for (const task of tasks) {
          try {
            const outcome = await this.finalizeTask(task.id);
            if (outcome.kind === 'finalized') {
              finalized += 1;
            } else if (outcome.kind === 'staged-corrupt') {
              // Process-local routing state follows the durable quarantine and
              // is deliberately updated only after its transaction commits.
              this.proxySnapshots.blockServer(
                outcome.serverId,
                `staged Agent evidence is corrupt on ${outcome.serverId}`,
              );
              this.logger.warn(
                `Task ${task.id} staged evidence failed closed: ${outcome.details}`,
              );
            }
          } catch (error) {
            let quarantinedServerId: string | null = null;
            try {
              quarantinedServerId = await this.recordRetryDiagnostic(task.id, error);
            } catch (diagnosticError) {
              this.logger.warn(
                `Task ${task.id} finalizer diagnostic failed: ${this.logErrorMessage(diagnosticError)}`,
              );
            }
            if (quarantinedServerId) {
              this.proxySnapshots.blockServer(
                quarantinedServerId,
                `Agent task finalizer exhausted retries on ${quarantinedServerId}`,
              );
            }
            this.logger.warn(
              `Task ${task.id} finalizer deferred: ${this.logErrorMessage(error)}`,
            );
          }
        }
        if (tasks.length < take) break;
      }
      return finalized;
    } finally {
      this.processing = false;
    }
  }

  private async finalizeTask(taskId: string): Promise<FinalizeTaskOutcome> {
    const committed = await runSerializedTransaction(this.dataSource, async (manager) => {
      const task = await manager.findOne(AgentTaskEntity, { where: { id: taskId } });
      if (
        !task
        || task.status !== AgentTaskStatus.Pending
        || task.agentResultJson === null
      ) return null;

      let result;
      try {
        result = parseAndValidateStagedTerminalResult(
          task,
          () => this.payloadCodec.forDispatch(task),
        );
      } catch (error) {
        if (!(error instanceof StagedTerminalEvidenceError)) throw error;
        // Corruption terminalization and Server admission revocation are one
        // serialized commit. A queued dispatcher can therefore observe only
        // the pre-corruption Online state or the post-commit quarantine, never
        // a Failed task on a still-dispatchable Server.
        await manager.update(AgentTaskEntity, task.id, {
          status: AgentTaskStatus.Failed,
          failureStage: task.failureStage === 'dispatch' ? 'dispatch' : 'finalizer',
          finalizerAttemptCount: (task.finalizerAttemptCount ?? 0) + 1,
          finalizerRetryAt: null,
          resultJson: null,
          errorJson: {
            code: STAGED_AGENT_RESULT_CORRUPT_CODE,
            message: 'Persisted terminal Agent evidence failed immutable task identity validation',
            details: error.message.slice(0, 2048),
          },
          completedAt: new Date(),
        } as never);
        await manager.update(ServerEntity, { id: task.serverId }, {
          status: ServerStatus.AgentQuarantined,
          quarantineCode: AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
          quarantineMessage: 'Persisted terminal Agent evidence is corrupt; task locks are retained until exact evidence is repaired',
        });
        return {
          stagedCorruption: {
            serverId: task.serverId,
            details: error.message.slice(0, 2048),
          },
          notifyProxyRevocation: false,
          resourceId: task.resourceId,
          invalidateAccessCache: false,
          quarantineServerId: null,
        };
      }
      if (result.status === 'succeeded') {
        await this.finalizer.applySucceeded(manager, task, result.result);
        await manager.update(AgentTaskEntity, task.id, {
          status: AgentTaskStatus.Succeeded,
          failureStage: null,
          finalizerRetryAt: null,
          resultJson: result.result,
          errorJson: null,
          completedAt: new Date(),
        } as never);
      } else {
        await this.finalizer.applyFailed(manager, task, result.error, result.observed);
        await manager.update(AgentTaskEntity, task.id, {
          status: AgentTaskStatus.Failed,
          failureStage: task.failureStage === 'dispatch' ? 'dispatch' : 'agent',
          finalizerRetryAt: null,
          resultJson: null,
          errorJson: result.error,
          completedAt: new Date(),
        } as never);
      }
      const retainRuntimeCleanupLock = task.kind === AgentTaskKind.ContainerRuntimeAbsent
        && result.status === 'failed';
      if (!retainRuntimeCleanupLock) {
        await this.resourceLocks.releaseTask(task.id, manager);
      }
      return {
        stagedCorruption: null,
        notifyProxyRevocation:
          task.kind === AgentTaskKind.ContainerDelete && result.status === 'succeeded',
        resourceId: task.resourceId,
        invalidateAccessCache:
          task.kind === AgentTaskKind.RemoteFsEnsure
          || task.kind === AgentTaskKind.RemoteFsAbsent,
        quarantineServerId: retainRuntimeCleanupLock ? task.serverId : null,
      };
    });
    if (!committed) return { kind: 'skipped' };
    if (committed.stagedCorruption) {
      return {
        kind: 'staged-corrupt',
        serverId: committed.stagedCorruption.serverId,
        details: committed.stagedCorruption.details,
      };
    }
    if (committed.quarantineServerId) {
      this.proxySnapshots.blockServer(
        committed.quarantineServerId,
        `runtime cleanup failed on ${committed.quarantineServerId}`,
      );
    }
    if (committed.invalidateAccessCache) {
      this.accessCacheEpoch.bump();
      this.proxySnapshots.invalidate(
        `RemoteFS ${committed.resourceId} assignment outcome finalized`,
      );
    }
    if (committed.notifyProxyRevocation) {
      await this.proxySnapshots.notify(`container ${committed.resourceId} deleted`).catch((error) => {
        // Notification is post-commit. It must never turn a durable success
        // back into a retry; proxy snapshot leases are the bounded fallback.
        this.logger.warn(
          `Proxy revocation notification failed after container delete commit: ${this.logErrorMessage(error)}`,
        );
      });
    }
    return { kind: 'finalized' };
  }

  private async recordRetryDiagnostic(taskId: string, error: unknown): Promise<string | null> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const task = await manager.findOne(AgentTaskEntity, { where: { id: taskId } });
      if (
        !task
        || task.status !== AgentTaskStatus.Pending
        || task.agentResultJson === null
      ) return null;
      const attempt = (task.finalizerAttemptCount ?? 0) + 1;
      if (attempt >= MAX_FINALIZER_ATTEMPTS) {
        await manager.update(AgentTaskEntity, task.id, {
          status: AgentTaskStatus.Failed,
          failureStage: task.failureStage === 'dispatch' ? 'dispatch' : 'finalizer',
          finalizerAttemptCount: attempt,
          finalizerRetryAt: null,
          errorJson: {
            code: 'FINALIZER_RETRY_EXHAUSTED',
            message: 'Database finalizer retry limit was exhausted; immutable Agent evidence and resource locks are retained',
            details: this.errorMessage(error).slice(0, 2048),
          },
          completedAt: new Date(),
        } as never);
        await manager.update(ServerEntity, task.serverId, {
          status: ServerStatus.AgentQuarantined,
        });
        return task.serverId;
      }
      const delayMs = Math.min(
        FINALIZER_RETRY_MAX_MS,
        FINALIZER_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 6)),
      );
      await manager.update(AgentTaskEntity, task.id, {
        finalizerAttemptCount: attempt,
        finalizerRetryAt: new Date(Date.now() + delayMs),
        // Preserve the only trusted marker for Backend-generated no-send
        // evidence. Otherwise one transient projection failure would turn the
        // retry back into the normal payload-dependent Agent path.
        failureStage: task.failureStage === 'dispatch' ? 'dispatch' : 'finalizer',
        errorJson: this.finalizerError(error),
        completedAt: null,
      } as never);
      return null;
    });
  }

  private finalizerError(error: unknown): { code: string; message: string; details?: unknown } {
    const message = this.errorMessage(error);
    let errorObject: Error | null = null;
    try {
      if (error instanceof Error) errorObject = error;
    } catch {
      errorObject = null;
    }
    if (errorObject) {
      let stack: string | undefined;
      try {
        stack = typeof errorObject.stack === 'string'
          ? errorObject.stack.slice(0, 8192)
          : undefined;
      } catch {
        stack = undefined;
      }
      return {
        code: 'FINALIZER_RETRY_PENDING',
        message: message.slice(0, 2048),
        details: stack,
      };
    }
    return {
      code: 'FINALIZER_RETRY_PENDING',
      message: message.slice(0, 2048),
      details: message.slice(0, 8192),
    };
  }

  private errorMessage(error: unknown): string {
    try {
      return error instanceof Error ? String(error.message) : String(error);
    } catch {
      return 'Unprintable finalizer error';
    }
  }

  private logErrorMessage(error: unknown): string {
    return this.errorMessage(error).slice(0, 2_048);
  }
}
