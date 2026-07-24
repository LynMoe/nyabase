import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentTaskKind,
  AgentTaskStatus,
  canonicalJson,
  MAX_AGENT_TASK_RESULT_BYTES,
  ServerStatus,
  type TaskAcceptedPayload,
  type TaskResultPayload,
} from '@nyabase/common';
import { isDeepStrictEqual } from 'node:util';
import { DataSource, EntityManager, IsNull, Not } from 'typeorm';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import {
  AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
  ServerEntity,
} from '../entities/server.entity.js';
import { AgentTaskFinalizerWorkerService } from './agent-task-finalizer-worker.service.js';
import { validateTerminalAgentResult } from './agent-task-result-validator.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';
import {
  validateDurableAgentTaskIdentity,
  validateDurableAgentTaskRowIdentity,
} from './agent-task-durable-contract.js';

const PROVEN_NO_EFFECT_COORDINATION_RESULTS = new Set([
  'container_delete_unbound_runtime_present',
]);

const UNSAFE_SHARED_QUOTA_FAILURE_CODES = new Set([
  'container_shared_quota_missing',
  'container_shared_quota_mismatch',
  'data_dir_quota_missing',
  'data_dir_quota_mismatch',
]);
const UNSAFE_SHARED_QUOTA_INCOMPLETE_CODES = new Set([
  'container_shared_quota_incomplete',
  'data_dir_quota_unobservable',
]);
const SAFE_STOP_COORDINATION_FAILURE_CODES = new Set([
  'container_absent',
  'container_identity_duplicate',
  'container_identity_mismatch',
  'container_runtime_identity_conflict',
]);

/**
 * Durably accepts the first terminal Agent outcome without applying domain
 * finalizers in the WebSocket message callback. Once staged, dispatcher
 * queries exclude the task, so physical execution cannot be repeated while a
 * database-only finalizer retry is outstanding.
 */
@Injectable()
export class AgentTaskResultService {
  constructor(
    private dataSource: DataSource,
    private finalizerWorker: AgentTaskFinalizerWorkerService,
    private payloadCodec: AgentTaskPayloadCodecService,
    private proxySnapshots: ProxySnapshotNotifierService = {
      blockServer: () => undefined,
    } as unknown as ProxySnapshotNotifierService,
  ) {}

  async handle(
    serverId: string,
    result: TaskResultPayload,
  ): Promise<TaskAcceptedPayload | null> {
    const resultBytes = Buffer.byteLength(canonicalJson(result));
    if (resultBytes > MAX_AGENT_TASK_RESULT_BYTES) {
      const error = new ConflictException({
        code: 'TASK_RESULT_SCHEMA_INVALID',
        message: `Agent task result exceeds ${MAX_AGENT_TASK_RESULT_BYTES} bytes`,
      });
      const quarantined = await this.recordValidationDiagnostic(serverId, result, error)
        .catch(() => false);
      if (quarantined) {
        this.proxySnapshots.blockServer(
          serverId,
          'Authenticated Agent returned invalid task evidence',
        );
      }
      throw error;
    }
    let accepted: TaskAcceptedPayload | null;
    let quarantineServerId: string | null = null;
    try {
      const committed = await runSerializedTransaction(this.dataSource, async (manager) => {
        const task = await this.loadAndValidate(manager, serverId, result);
        let wirePayload: unknown = null;
        try {
          // Every ingress outcome is bound to a known durable row before any
          // retry, quarantine, staging, projection, or lock decision.
          validateDurableAgentTaskRowIdentity(task);
          if (result.status !== 'incomplete') {
            wirePayload = validateDurableAgentTaskIdentity(
              task,
              this.payloadCodec.forDispatch(task),
            );
          }
        } catch (error) {
          throw new ConflictException({
            code: 'TASK_RESULT_SCHEMA_INVALID',
            message: 'Durable task payload identity no longer matches the dispatched task',
            details: error instanceof Error ? error.message : String(error),
          });
        }

        if (task.status === AgentTaskStatus.Failed && this.errorCode(task.errorJson) === 'TASK_SUPERSEDED') {
          // The successor intent is already durable. Ack a late result from the
          // old execution so the stateless Agent can discard its terminal cache;
          // never let stale evidence overwrite the successor projection.
          return { accepted: this.accepted(task), needsFinalizer: false, quarantineServerId: null };
        }

        if (result.status === 'incomplete') {
          const unsafeQuotaIncomplete = task.kind === AgentTaskKind.QuotaEnsure
            || UNSAFE_SHARED_QUOTA_INCOMPLETE_CODES.has(result.error.code);
          if (
            task.status === AgentTaskStatus.Pending
            && task.agentResultJson === null
          ) {
            if (unsafeQuotaIncomplete) {
              // setLimit may already have changed shared physical state while
              // Backend cannot prove the durable limit. Do not leave existing
              // workloads routable through the ordinary uncertainty window.
              // The immutable task and its locks remain the sole replay
              // authority for an explicit administrative retry.
              await manager.update(AgentTaskEntity, task.id, {
                status: AgentTaskStatus.Failed,
                agentResultJson: null,
                failureStage: 'agent',
                finalizerAttemptCount: 0,
                finalizerRetryAt: null,
                resultJson: null,
                errorJson: {
                  code: 'AGENT_QUOTA_OUTCOME_UNSAFE',
                  message: 'Agent could not prove the durable quota limit; server is quarantined and the exact task lock is retained',
                  cause: result.error,
                },
                lastSentAt: null,
                nextDispatchAt: null,
                completedAt: new Date(),
              } as never);
              await manager.update(ServerEntity, serverId, {
                status: ServerStatus.AgentQuarantined,
                quarantineCode: AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
                quarantineMessage: 'Disk quota enforcement cannot be observed; existing workloads are blocked until the same task is explicitly retried',
              });
              return {
                accepted: this.accepted(task),
                needsFinalizer: false,
                quarantineServerId: serverId,
              };
            }
            const provenNoEffectCoordination = PROVEN_NO_EFFECT_COORDINATION_RESULTS.has(
              result.error.code,
            );
            const delayMs = Math.min(
              60_000,
              1_000 * (2 ** Math.min(Math.max(task.dispatchAttemptCount - 1, 0), 6)),
            );
            await manager.update(AgentTaskEntity, task.id, {
              // The Agent has finished this attempt, so it no longer owns the
              // per-server execution slot. The task keeps every resource lock
              // and becomes dispatchable again after bounded backoff, while
              // unrelated locked-safe work on the same server may proceed.
              lastSentAt: null,
              nextDispatchAt: new Date(Date.now() + delayMs),
              failureStage: null,
              errorJson: result.error,
              // This code is emitted only after the Agent freshly observes a
              // residual managed runtime and performs no mutation. Backend
              // schedules exact safety cleanups first, so queueing behind them
              // is known coordination, not an ambiguous physical outcome.
              retryWindowStartedAt: provenNoEffectCoordination
                ? null
                : task.retryWindowStartedAt,
              incompleteResultCount: provenNoEffectCoordination
                ? 0
                : task.incompleteResultCount + 1,
            } as never);
          }
          return { accepted: null, needsFinalizer: false, quarantineServerId: null };
        }

        validateTerminalAgentResult(task, result, { wirePayload });

        const evidence = this.agentEvidence(result);
        if (
          task.status !== AgentTaskStatus.Pending
          || task.agentResultJson !== null
        ) {
          if (!isDeepStrictEqual(task.agentResultJson, evidence)) {
            throw new ConflictException({
              code: 'TASK_RESULT_CONFLICT',
              message: 'Task already has different immutable Agent evidence',
            });
          }
          return { accepted: this.accepted(task), needsFinalizer: false, quarantineServerId: null };
        }

        const unsafeQuotaFailure = result.status === 'failed'
          && (
            task.kind === AgentTaskKind.QuotaEnsure
            || UNSAFE_SHARED_QUOTA_FAILURE_CODES.has(result.error.code)
          );
        const unsafeSafetyFailure = result.status === 'failed'
          && task.admissionClass === 'safety'
          && task.kind !== AgentTaskKind.ContainerRuntimeAbsent;
        const safeStopCoordinationFailure = result.status === 'failed'
          && task.kind === AgentTaskKind.ContainerStop
          && SAFE_STOP_COORDINATION_FAILURE_CODES.has(result.error.code);
        if (
          result.status === 'failed'
          && (
            task.kind === AgentTaskKind.ContainerRuntimeAbsent
            || unsafeQuotaFailure
            || (unsafeSafetyFailure && !safeStopCoordinationFailure)
          )
        ) {
          // Runtime cleanup and quota enforcement failures are chosen
          // low-availability fail-stop boundaries.
          // Terminalize it and quarantine the server in the same transaction,
          // before the task can yield its physical slot. Its task lock and
          // address claim remain the exact replay authority.
          await manager.update(AgentTaskEntity, task.id, {
            status: AgentTaskStatus.Failed,
            agentResultJson: evidence,
            failureStage: 'agent',
            finalizerAttemptCount: 0,
            finalizerRetryAt: null,
            resultJson: null,
            errorJson: unsafeQuotaFailure
              ? {
                  code: 'AGENT_QUOTA_OUTCOME_UNSAFE',
                  message: 'Agent could not prove the durable quota limit; server is quarantined and the exact task lock is retained',
                  cause: result.error,
                }
              : unsafeSafetyFailure
                ? {
                    code: 'AGENT_SAFETY_OUTCOME_UNSAFE',
                    message: 'Agent could not converge a safety intent; server is quarantined and the exact task lock is retained',
                    cause: result.error,
                  }
              : result.error,
            lastSentAt: null,
            nextDispatchAt: null,
            completedAt: new Date(),
          } as never);
          await manager.update(ServerEntity, serverId, {
            status: ServerStatus.AgentQuarantined,
            quarantineCode: AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
            quarantineMessage: unsafeQuotaFailure
              ? 'Disk quota enforcement did not converge; existing workloads are blocked until the same task is explicitly retried'
              : unsafeSafetyFailure
                ? 'A safety convergence task failed; the same immutable task must be explicitly retried'
                : 'Unexpected runtime cleanup did not converge; exact cleanup authority and address claims are retained',
          });
          return {
            accepted: this.accepted(task),
            needsFinalizer: false,
            quarantineServerId: serverId,
          };
        }

        await manager.update(AgentTaskEntity, task.id, {
          agentResultJson: evidence,
          finalizerAttemptCount: 0,
          finalizerRetryAt: null,
          failureStage: null,
          errorJson: null,
        } as never);
        return { accepted: this.accepted(task), needsFinalizer: true, quarantineServerId: null };
      });
      accepted = committed.accepted;
      quarantineServerId = committed.quarantineServerId;
      if (committed.needsFinalizer) this.finalizerWorker.wake();
    } catch (error) {
      if (this.isResultValidationError(error)) {
        const quarantined = await this.recordValidationDiagnostic(serverId, result, error)
          .catch(() => false);
        if (quarantined) {
          this.proxySnapshots.blockServer(
            serverId,
            'Authenticated Agent returned invalid task evidence',
          );
        }
      } else if (this.isProtocolInvariantError(error)) {
        await this.quarantineProtocolFault(serverId, error).catch(() => undefined);
      }
      throw error;
    }

    if (quarantineServerId) {
      this.proxySnapshots.blockServer(
        quarantineServerId,
        `safety-critical Agent task failed on ${quarantineServerId}`,
      );
    }
    return accepted;
  }

  /**
   * Fail-stop an authenticated server when the outer task-result wire shape
   * is invalid. If the payload can be bound to the sole dispatched task, make
   * that orchestration failure visible while retaining its physical lock.
   * Otherwise quarantine only the server; an explicit retry may later clear
   * that fence without changing any task.
   */
  async quarantineMalformedResult(
    serverId: string,
    rawPayload: unknown,
    parseError: unknown,
  ): Promise<string | null> {
    const taskId = await runSerializedTransaction(this.dataSource, async (manager) => {
      const server = await manager.findOneBy(ServerEntity, { id: serverId });
      if (!server) throw new NotFoundException('Server not found');
      const task = await this.bindMalformedResultToTask(manager, serverId, rawPayload);
      if (task) {
        await this.markInvalidResultTask(
          manager,
          task,
          this.boundedDiagnostic(parseError),
        );
      }
      await manager.update(ServerEntity, serverId, {
        status: ServerStatus.AgentQuarantined,
      });
      return task?.id ?? null;
    });
    this.proxySnapshots.blockServer(
      serverId,
      'Authenticated Agent returned malformed task evidence',
    );
    return taskId;
  }

  /** Quarantine a broken authenticated Agent without guessing a task identity. */
  async quarantineProtocolFault(serverId: string, _error: unknown): Promise<void> {
    await runSerializedTransaction(this.dataSource, async (manager) => {
      await manager.update(ServerEntity, serverId, {
        status: ServerStatus.AgentQuarantined,
      });
    });
    this.proxySnapshots.blockServer(serverId, 'Authenticated Agent violated the protocol');
  }

  private async recordValidationDiagnostic(
    serverId: string,
    result: TaskResultPayload,
    error: ConflictException,
  ): Promise<boolean> {
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const server = await manager.findOneBy(ServerEntity, { id: serverId });
      if (!server) throw new NotFoundException('Server not found');
      const task = await manager.findOne(AgentTaskEntity, { where: { id: result.taskId } });
      if (
        task
        && task.serverId === serverId
        && task.payloadHash === result.payloadHash
        && task.status === AgentTaskStatus.Pending
        && task.agentResultJson === null
      ) {
        const response = error.getResponse();
        await this.markInvalidResultTask(manager, task, response);
      }
      await manager.update(ServerEntity, serverId, {
        status: ServerStatus.AgentQuarantined,
      });
    });
    return true;
  }

  private async bindMalformedResultToTask(
    manager: EntityManager,
    serverId: string,
    rawPayload: unknown,
  ): Promise<AgentTaskEntity | null> {
    const record = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? rawPayload as Record<string, unknown>
      : null;
    const rawTaskId = typeof record?.taskId === 'string' && record.taskId.length <= 128
      ? record.taskId
      : null;
    const rawPayloadHash = typeof record?.payloadHash === 'string' && record.payloadHash.length <= 128
      ? record.payloadHash
      : null;

    if (rawTaskId) {
      const exact = await manager.findOne(AgentTaskEntity, {
        select: {
          id: true,
          payloadHash: true,
          startedAt: true,
          lastSentAt: true,
        },
        where: {
          id: rawTaskId,
          serverId,
          status: AgentTaskStatus.Pending,
          agentResultJson: IsNull(),
        },
      });
      if (!exact || exact.startedAt === null) return null;
      // A matching immutable hash binds even when an earlier incomplete result
      // already yielded the dispatch slot. With a malformed/missing hash, bind
      // only while this exact task still owns the live slot.
      if (rawPayloadHash === exact.payloadHash || exact.lastSentAt !== null) return exact;
      return null;
    }

    // At most one physical task may own a server slot. Read two rows so a
    // corrupted duplicate owner is detected without materializing the whole
    // pending queue (whose payloads can each be large).
    const dispatched = await manager.find(AgentTaskEntity, {
      select: {
        id: true,
        payloadHash: true,
        startedAt: true,
        lastSentAt: true,
      },
      where: {
        serverId,
        status: AgentTaskStatus.Pending,
        agentResultJson: IsNull(),
        lastSentAt: Not(IsNull()),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: 2,
    });
    return dispatched.length === 1 ? dispatched[0] : null;
  }

  private async markInvalidResultTask(
    manager: EntityManager,
    task: AgentTaskEntity,
    details: unknown,
  ): Promise<void> {
    await manager.update(AgentTaskEntity, task.id, {
      // Invalid terminal evidence cannot safely drive a domain finalizer or
      // release the physical resource lock. Make the orchestration failure
      // visible and durable, then quarantine the whole server so this
      // deterministic Agent/backend contract defect cannot reconnect-loop.
      status: AgentTaskStatus.Failed,
      failureStage: 'agent',
      errorJson: {
        code: 'INVALID_AGENT_RESULT',
        message: 'Agent returned an invalid terminal result; server is quarantined and the resource lock is retained',
        details,
      },
      lastSentAt: null,
      nextDispatchAt: null,
      completedAt: new Date(),
    } as never);
  }

  private boundedDiagnostic(error: unknown): unknown {
    if (error && typeof error === 'object' && 'issues' in error) {
      const issues = (error as { issues?: unknown }).issues;
      if (Array.isArray(issues)) {
        return {
          issues: issues.slice(0, 16).map((issue) => {
            const record = issue && typeof issue === 'object'
              ? issue as Record<string, unknown>
              : {};
            return {
              code: typeof record.code === 'string' ? record.code.slice(0, 128) : 'invalid',
              message: typeof record.message === 'string' ? record.message.slice(0, 512) : 'Invalid result',
              path: Array.isArray(record.path)
                ? record.path.slice(0, 16).map((part) => String(part).slice(0, 128))
                : [],
            };
          }),
        };
      }
    }
    return {
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
    };
  }

  private isResultValidationError(error: unknown): error is ConflictException {
    if (!(error instanceof ConflictException)) return false;
    const response = error.getResponse();
    if (!response || typeof response !== 'object') return false;
    const code = (response as { code?: unknown }).code;
    return code === 'TASK_RESULT_SCHEMA_INVALID' || code === 'TASK_RESULT_IDENTITY_CONFLICT';
  }

  private isProtocolInvariantError(error: unknown): boolean {
    if (error instanceof NotFoundException) return true;
    if (!(error instanceof ConflictException)) return false;
    const response = error.getResponse();
    if (!response || typeof response !== 'object') return false;
    const code = (response as { code?: unknown }).code;
    return code === 'TASK_SERVER_CONFLICT'
      || code === 'TASK_PAYLOAD_HASH_CONFLICT'
      || code === 'TASK_RESULT_CONFLICT'
      || code === 'TASK_NOT_DISPATCHED';
  }

  private async loadAndValidate(
    manager: EntityManager,
    serverId: string,
    result: TaskResultPayload,
  ): Promise<AgentTaskEntity> {
    const task = await manager.findOne(AgentTaskEntity, { where: { id: result.taskId } });
    if (!task) throw new NotFoundException('Agent task not found');
    if (task.serverId !== serverId) {
      throw new ConflictException({
        code: 'TASK_SERVER_CONFLICT',
        message: 'Authenticated Agent does not own this task',
      });
    }
    if (task.payloadHash !== result.payloadHash) {
      throw new ConflictException({
        code: 'TASK_PAYLOAD_HASH_CONFLICT',
        message: 'Task payload hash does not match',
      });
    }
    if (
      task.status === AgentTaskStatus.Pending
      && task.agentResultJson === null
      && task.startedAt === null
    ) {
      throw new ConflictException({
        code: 'TASK_NOT_DISPATCHED',
        message: 'Agent cannot certify a task that Backend has never dispatched',
      });
    }
    return task;
  }

  private agentEvidence(
    result: Exclude<TaskResultPayload, { status: 'incomplete' }>,
  ): unknown {
    return result.status === 'succeeded'
      ? { status: 'succeeded', result: result.result }
      : {
          status: 'failed',
          error: result.error,
          observed: result.observed,
        };
  }

  private accepted(task: AgentTaskEntity): TaskAcceptedPayload {
    return { taskId: task.id, payloadHash: task.payloadHash };
  }

  private errorCode(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
}
