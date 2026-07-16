import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { v7 as uuidv7 } from 'uuid';
import {
  AgentTaskKind,
  AgentTaskStatus,
  MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER,
  ServerStatus,
  canonicalJson,
  parseAgentTaskPayload,
  zTaskResultPayload,
  type AgentTaskDto,
  type ContainerRuntimeAbsentTaskPayload,
  type TaskResultPayload,
} from '@nyabase/common';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import {
  AGENT_INVENTORY_FAULT_QUARANTINE_CODE,
  AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
  ServerEntity,
} from '../entities/server.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';
import { validateTerminalAgentResult } from './agent-task-result-validator.js';
import { ResourceKeyService } from './resource-key.service.js';
import { ResourceLockedException, ResourceLockService } from './resource-lock.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import {
  type EnqueueAgentTaskInput,
  type EnqueueAgentTaskResult,
} from './agent-task.types.js';
import { networkHasUntrustedInventory } from '../common/network-inventory-safety.js';
import {
  AGENT_TASK_MIN_RETENTION_MS,
  MAX_AGENT_TASK_ROWS_HARD,
  MAX_AGENT_TASKS_PER_RETENTION_WINDOW,
  MAX_NON_SAFETY_AGENT_TASKS_PER_RETENTION_WINDOW,
  MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW,
} from './agent-task-retention.service.js';

export const MAX_AGENT_TASK_WIRE_BYTES = 1024 * 1024;
// CreateContainerRequest may legitimately contain 64 mount paths of 4096
// bytes each. Keep metadata bounded, but use the same explicit 1 MiB envelope
// as the immutable Agent wire payload so the public request schema fits.
export const MAX_AGENT_TASK_REQUEST_BYTES = MAX_AGENT_TASK_WIRE_BYTES;
export const MAX_PENDING_AGENT_TASKS_PER_SERVER = 1024;
export const MAX_PENDING_AGENT_TASKS_GLOBAL = 4096;
export const MAX_RECONCILIATION_TASKS_PER_SERVER = 2048;
export const MAX_RECONCILIATION_TASKS_GLOBAL = 8192;
export const MAX_SAFETY_TASKS_PER_SERVER = 1024;
export const MAX_ALL_TASKS_PER_SERVER = MAX_RECONCILIATION_TASKS_PER_SERVER + MAX_SAFETY_TASKS_PER_SERVER;
export const AGENT_TASK_RESEND_INTERVAL_MS = 5_000;
// Keep a deferred head task ineligible for at least one complete dispatcher
// interval so another task in the same priority lane can make progress.
export const MIN_AGENT_TASK_DISPATCH_DEFER_MS = 2_000;
export const MAX_AGENT_TASK_INCOMPLETE_RESULTS = 12;
export const MAX_AGENT_TASK_UNCERTAIN_AGE_MS = 45 * 60_000;
export const MAX_AGENT_TASK_UNSTARTED_AGE_MS = 15 * 60_000;
const TASK_EXHAUSTION_BATCH = 128;
const STARTUP_PAYLOAD_SCAN_BATCH = 128;
// A retry needs the complete immutable task row. Eight legal 1 MiB requests
// plus eight legal 1 MiB payloads keep one recovery batch near 16 MiB.
const QUARANTINE_RETRY_BATCH_SIZE = 8;
const RETRYABLE_QUARANTINE_ERROR_CODES = [
  'INVALID_AGENT_RESULT',
  'AGENT_TASK_OUTCOME_UNKNOWN',
  'AGENT_TASK_PAYLOAD_CORRUPT_OUTCOME_UNKNOWN',
  'AGENT_QUOTA_OUTCOME_UNSAFE',
  'AGENT_SAFETY_OUTCOME_UNSAFE',
  'FINALIZER_RETRY_EXHAUSTED',
] as const;
const RETRYABLE_QUARANTINE_ERROR_CODE_SET = new Set<string>(
  RETRYABLE_QUARANTINE_ERROR_CODES,
);

export class PermanentTaskPayloadError extends Error {
  constructor(readonly taskId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentTaskPayloadError';
  }
}

@Injectable()
export class AgentTasksService implements OnModuleInit {
  constructor(
    private dataSource: DataSource,
    private resourceKeys: ResourceKeyService,
    private resourceLocks: ResourceLockService,
    private payloadCodec: AgentTaskPayloadCodecService,
    @InjectRepository(AgentTaskEntity)
    private tasksRepo: Repository<AgentTaskEntity>,
    private proxySnapshots: ProxySnapshotNotifierService = {
      blockServer: () => undefined,
    } as unknown as ProxySnapshotNotifierService,
  ) {}

  /**
   * Validate only rows which can still be dispatched. A staged Agent result is
   * already owned by the database-only finalizer and must not depend on the
   * payload encryption key remaining available.
   *
   * A payload defect before the first send proves that no physical mutation
   * happened, so stage the normal internal failure result and continue startup.
   * Once any send was attempted, payload corruption is ambiguous: terminalize
   * the exact task, retain its locks, and durably quarantine the server.
   */
  async onModuleInit(): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
      const pendingIds = await this.tasksRepo.find({
        select: { id: true },
        where: {
          status: AgentTaskStatus.Pending,
          agentResultJson: IsNull(),
          ...(cursor === null ? {} : { id: MoreThan(cursor) }),
        },
        order: { id: 'ASC' },
        take: STARTUP_PAYLOAD_SCAN_BATCH,
      });
      if (pendingIds.length === 0) break;
      for (const { id } of pendingIds) {
        // Load at most one bounded payload at a time. A startup scan may cover
        // thousands of legal 1 MiB tasks and must not retain a whole batch of
        // decoded JSON objects in memory.
        const task = await this.tasksRepo.findOneBy({ id });
        if (
          !task
          || task.status !== AgentTaskStatus.Pending
          || task.agentResultJson !== null
        ) continue;
        try {
          this.buildWirePayload(task);
        } catch (error) {
          if (!(error instanceof PermanentTaskPayloadError)) throw error;
          if (!this.isNeverDispatched(task)) {
            await this.failPostDispatchPayloadCorruption(task.id, error);
            continue;
          }
          if (await this.stageNeverDispatchedPayloadFailure(task.id, error)) continue;

          // A concurrent transaction may have staged/terminalized the same row.
          // That outcome is safe to leave to its owner. If it was dispatched in
          // the meantime, retain the fail-stop behavior because physical effect
          // is no longer provably absent.
          const current = await this.tasksRepo.findOneBy({ id: task.id });
          if (
            !current
            || current.status !== AgentTaskStatus.Pending
            || current.agentResultJson !== null
          ) continue;
          throw error;
        }
      }
      cursor = pendingIds[pendingIds.length - 1]!.id;
    }
  }

  async enqueue(input: EnqueueAgentTaskInput): Promise<EnqueueAgentTaskResult> {
    return runSerializedTransaction(this.dataSource, (manager) =>
      this.enqueueInTransaction(manager, input));
  }

  /**
   * Explicitly retry tasks retained after impossible Agent terminal evidence.
   * The caller must hold the Agent session fence. Locks are intentionally
   * preserved: replay reconciles the same immutable intent and is the only
   * operation allowed to leave the durable server quarantine.
   */
  async retryAgentQuarantine(serverId: string): Promise<string[]> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const server = await manager.findOneBy(ServerEntity, { id: serverId });
      if (!server) throw new NotFoundException('Server not found');
      if (server.status !== ServerStatus.AgentQuarantined) {
        throw new ConflictException({
          code: 'AGENT_NOT_QUARANTINED',
          message: 'Server has no invalid-result quarantine to retry',
        });
      }

      // Resource locks are the bounded durable replay-authority index. Never
      // materialize every historical Failed row: retained payloads may be up
      // to the wire limit and the result-retention window can contain many
      // unrelated terminal tasks.
      const authorityIds = await this.quarantineRetryAuthorityIds(manager, serverId);
      const authorityIdSet = new Set(authorityIds);
      const [retainedFailedIds, pendingStartedIds] = await Promise.all([
        this.retainedFailedAuthorityIds(manager, serverId),
        this.pendingStartedAuthorityIds(manager, serverId),
      ]);
      const expectedRetryIds = new Set([...retainedFailedIds, ...pendingStartedIds]);
      const missingAuthorityId = [...expectedRetryIds]
        .find((taskId) => !authorityIdSet.has(taskId));
      if (missingAuthorityId) {
        throw new ConflictException({
          code: 'AGENT_QUARANTINE_LOCK_MISSING',
          message: `Retained task ${missingAuthorityId} has no authoritative resource lock set`,
        });
      }

      await this.assertRuntimeCleanupClaimsValid(manager, serverId);
      const retryIds: string[] = [];
      for (let offset = 0; offset < authorityIds.length; offset += QUARANTINE_RETRY_BATCH_SIZE) {
        const batchIds = authorityIds.slice(offset, offset + QUARANTINE_RETRY_BATCH_SIZE);
        const tasks = await manager.find(AgentTaskEntity, {
          where: { id: In(batchIds) },
          order: { id: 'ASC' },
        });
        const tasksById = new Map(tasks.map((task) => [task.id, task]));
        const missingTaskId = batchIds.find((taskId) => !tasksById.has(taskId));
        if (missingTaskId) {
          throw new ConflictException({
            code: 'AGENT_QUARANTINE_TASK_MISSING',
            message: `Resource lock references missing Agent task ${missingTaskId}`,
          });
        }
        if (await manager.count(ResourceLockEntity, {
          where: { taskId: In(batchIds), serverId: Not(serverId) },
        }) > 0) {
          throw new ConflictException({
            code: 'AGENT_QUARANTINE_LOCK_SERVER_MISMATCH',
            message: 'Retained task authority contains a lock owned by another Server',
          });
        }

        for (const taskId of batchIds) {
          const task = tasksById.get(taskId)!;
          if (task.serverId !== serverId) {
            throw new ConflictException({
              code: 'AGENT_QUARANTINE_LOCK_SERVER_MISMATCH',
              message: `Retained task ${task.id} does not belong to Server ${serverId}`,
            });
          }
          const retryFailed = this.isRetryableQuarantineFailure(task);
          const pendingStarted = task.status === AgentTaskStatus.Pending
            && task.startedAt !== null;
          if (!retryFailed && task.status !== AgentTaskStatus.Pending) {
            throw new ConflictException({
              code: 'AGENT_QUARANTINE_AUTHORITY_INVALID',
              message: `Resource lock for task ${task.id} does not reference retryable authority`,
            });
          }
          if (!retryFailed && !pendingStarted) continue;

          // Refuse to leave quarantine if immutable dispatch input or staged
          // terminal evidence was corrupted. A started Pending task is just as
          // authoritative as the Failed task which triggered the quarantine.
          if (task.agentResultJson === null) this.buildWirePayload(task);
          else this.assertRetryableStagedResult(task);
          if (task.kind === AgentTaskKind.ContainerRuntimeAbsent) {
            await this.assertRetainedRuntimeCleanupTask(manager, task);
          }

          if (!retryFailed) {
            await manager.update(AgentTaskEntity, task.id, (task.agentResultJson === null
              ? {
                  // Explicit retry starts a fresh bounded uncertainty epoch.
                  // Keep startedAt as proof that physical dispatch once
                  // happened, but do not let an old quarantine interval make
                  // failExhaustedTasks immediately quarantine it again.
                  admissionClass: 'safety',
                  failureStage: null,
                  dispatchAttemptCount: 0,
                  incompleteResultCount: 0,
                  retryWindowStartedAt: null,
                  lastSentAt: null,
                  nextDispatchAt: null,
                  errorJson: null,
                  resultJson: null,
                  completedAt: null,
                }
              : {
                  // Physical work is already terminal. Preserve immutable
                  // evidence and let only the database finalizer retry.
                  admissionClass: 'safety',
                }) as never);
            retryIds.push(task.id);
            continue;
          }
          if (this.errorCode(task.errorJson) === 'FINALIZER_RETRY_EXHAUSTED') {
            await manager.update(AgentTaskEntity, task.id, {
              status: AgentTaskStatus.Pending,
              admissionClass: 'safety',
              failureStage: this.hasNeverDispatchedEvidence(task) ? 'dispatch' : null,
              finalizerAttemptCount: 0,
              finalizerRetryAt: null,
              resultJson: null,
              errorJson: null,
              completedAt: null,
            } as never);
          } else {
            await manager.update(AgentTaskEntity, task.id, {
              status: AgentTaskStatus.Pending,
              admissionClass: 'safety',
              failureStage: null,
              agentResultJson: null,
              finalizerAttemptCount: 0,
              finalizerRetryAt: null,
              resultJson: null,
              errorJson: null,
              dispatchAttemptCount: 0,
              incompleteResultCount: 0,
              retryWindowStartedAt: null,
              lastSentAt: null,
              nextDispatchAt: null,
              completedAt: null,
            } as never);
          }
          retryIds.push(task.id);
        }
      }
      if (
        retryIds.length !== expectedRetryIds.size
        || retryIds.some((taskId) => !expectedRetryIds.has(taskId))
      ) {
        throw new ConflictException({
          code: 'AGENT_QUARANTINE_AUTHORITY_INVALID',
          message: 'Retryable Agent task authority changed while leaving quarantine',
        });
      }
      await manager.update(ServerEntity, serverId, {
        status: ServerStatus.Unknown,
        ...(server.quarantineCode === AGENT_INVENTORY_FAULT_QUARANTINE_CODE
          ? {}
          : { quarantineCode: null, quarantineMessage: null }),
      });
      return retryIds.sort();
    });
  }

  /**
   * A corrupt immutable payload after any physical send is an explicit unknown
   * outcome, not a Backend crash loop. Preserve the exact task and lock set so
   * an administrator can repair/replay only this intent.
   */
  async failPostDispatchPayloadCorruption(
    taskId: string,
    error: unknown,
  ): Promise<string | null> {
    const serverId = await runSerializedTransaction(this.dataSource, async (manager) => {
      const task = await manager.findOne(AgentTaskEntity, { where: { id: taskId } });
      if (
        !task
        || task.status !== AgentTaskStatus.Pending
        || task.agentResultJson !== null
        || task.startedAt === null
      ) return null;
      await manager.update(AgentTaskEntity, task.id, {
        status: AgentTaskStatus.Failed,
        failureStage: 'agent',
        errorJson: {
          code: 'AGENT_TASK_PAYLOAD_CORRUPT_OUTCOME_UNKNOWN',
          message: 'Durable task payload is corrupt after physical dispatch; server is quarantined and locks are retained',
          details: this.errorMessage(error).slice(0, 2048),
        },
        lastSentAt: null,
        nextDispatchAt: null,
        completedAt: new Date(),
      } as never);
      await manager.update(ServerEntity, task.serverId, {
        status: ServerStatus.AgentQuarantined,
        quarantineCode: AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
        quarantineMessage: 'A dispatched task payload is corrupt; the immutable task and locks require explicit repair/retry',
      });
      return task.serverId;
    });
    if (serverId) {
      this.proxySnapshots.blockServer(
        serverId,
        `post-dispatch Agent task payload corruption on ${serverId}`,
      );
    }
    return serverId;
  }

  /**
   * Convert an indefinitely ambiguous physical attempt into an explicit
   * fail-stop outcome. Locks are retained because completion is unknown; an
   * administrator may replay only this same immutable task after repair.
   */
  async failExhaustedTasks(now = new Date()): Promise<{ taskIds: string[]; serverIds: string[] }> {
    const unstarted = await this.tasksRepo.find({
      select: { id: true, nextDispatchAt: true },
      where: {
        status: AgentTaskStatus.Pending,
        // Reconciliation and safety work may legitimately sit behind a large
        // immutable cleanup backlog. Only user-facing normal work has a
        // bounded never-started queue lifetime; failing safety work merely for
        // waiting would discard the exact convergence authority.
        admissionClass: 'normal',
        agentResultJson: IsNull(),
        startedAt: IsNull(),
        createdAt: LessThanOrEqual(new Date(now.getTime() - MAX_AGENT_TASK_UNSTARTED_AGE_MS)),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: TASK_EXHAUSTION_BATCH,
    });
    const noEffectTaskIds: string[] = [];
    for (const task of unstarted) {
      if (task.nextDispatchAt && task.nextDispatchAt.getTime() > now.getTime()) continue;
      if (await this.stageNeverDispatchedPayloadFailure(
        task.id,
        new Error('Agent task expired before its first physical dispatch'),
        'AGENT_TASK_NOT_DISPATCHED',
      )) {
        noEffectTaskIds.push(task.id);
      }
    }
    const base = {
      status: AgentTaskStatus.Pending,
      agentResultJson: IsNull(),
      retryWindowStartedAt: Not(IsNull()),
    } as const;
    const [attempted, aged] = await Promise.all([
      this.tasksRepo.find({
        select: { id: true },
        where: {
          ...base,
          incompleteResultCount: MoreThanOrEqual(MAX_AGENT_TASK_INCOMPLETE_RESULTS),
        },
        order: { retryWindowStartedAt: 'ASC', id: 'ASC' },
        take: TASK_EXHAUSTION_BATCH,
      }),
      this.tasksRepo.find({
        select: { id: true },
        where: {
          ...base,
          retryWindowStartedAt: LessThanOrEqual(new Date(now.getTime() - MAX_AGENT_TASK_UNCERTAIN_AGE_MS)),
        },
        order: { retryWindowStartedAt: 'ASC', id: 'ASC' },
        take: TASK_EXHAUSTION_BATCH,
      }),
    ]);
    const candidateIds = [...new Set([...attempted, ...aged].map((task) => task.id))]
      .slice(0, TASK_EXHAUSTION_BATCH);
    if (candidateIds.length === 0) return { taskIds: noEffectTaskIds, serverIds: [] };

    const outcome = await runSerializedTransaction(this.dataSource, async (manager) => {
      const taskIds: string[] = [];
      const serverIds = new Set<string>();
      for (const taskId of candidateIds) {
        // Re-check and process one complete task at a time under the serialized
        // transaction. The candidate scan above never decodes payload/result.
        const task = await manager.findOneBy(AgentTaskEntity, { id: taskId });
        if (
          !task
          || task.status !== AgentTaskStatus.Pending
          || task.agentResultJson !== null
          || task.retryWindowStartedAt === null
          || (
            task.incompleteResultCount < MAX_AGENT_TASK_INCOMPLETE_RESULTS
            && task.retryWindowStartedAt.getTime() > now.getTime() - MAX_AGENT_TASK_UNCERTAIN_AGE_MS
          )
        ) continue;
        await manager.update(AgentTaskEntity, task.id, {
          status: AgentTaskStatus.Failed,
          failureStage: 'agent',
          errorJson: {
            code: 'AGENT_TASK_OUTCOME_UNKNOWN',
            message: 'Agent task retry/response deadline was exhausted; server is quarantined and locks are retained',
            dispatchAttemptCount: task.dispatchAttemptCount,
            incompleteResultCount: task.incompleteResultCount,
          },
          lastSentAt: null,
          nextDispatchAt: null,
          completedAt: now,
        } as never);
        await manager.update(ServerEntity, task.serverId, {
          status: ServerStatus.AgentQuarantined,
          quarantineCode: AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
          quarantineMessage: 'An Agent task outcome deadline was exhausted; the immutable task and locks require explicit retry',
        });
        taskIds.push(task.id);
        serverIds.add(task.serverId);
      }
      return { taskIds: [...noEffectTaskIds, ...taskIds], serverIds: [...serverIds] };
    });
    for (const serverId of outcome.serverIds) {
      this.proxySnapshots.blockServer(
        serverId,
        `Agent task outcome deadline exhausted on ${serverId}`,
      );
    }
    return outcome;
  }

  async enqueueInTransaction(
    manager: EntityManager,
    input: EnqueueAgentTaskInput,
  ): Promise<EnqueueAgentTaskResult> {
    const server = await manager.findOneBy(ServerEntity, { id: input.serverId });
    if (!server) throw new NotFoundException('Server not found');
    if (server.status === ServerStatus.AgentQuarantined) {
      throw new ConflictException({
        code: 'AGENT_SERVER_QUARANTINED',
        message: 'Server is quarantined; repair the Agent and explicitly retry before creating new tasks',
        serverId: input.serverId,
      });
    }
    const requestJson = this.prepareRequestJson(input.request);
    const admissionClass = input.admissionClass ?? 'normal';
    const retentionWindowStart = new Date(Date.now() - AGENT_TASK_MIN_RETENTION_MS);
    const [serverPending, globalPending, serverSafety, recentTasks, totalTasks] = await Promise.all([
      manager.count(AgentTaskEntity, {
        where: { serverId: input.serverId, status: AgentTaskStatus.Pending },
      }),
      manager.count(AgentTaskEntity, { where: { status: AgentTaskStatus.Pending } }),
      manager.count(AgentTaskEntity, {
        where: {
          serverId: input.serverId,
          status: AgentTaskStatus.Pending,
          admissionClass: 'safety',
        },
      }),
      manager.count(AgentTaskEntity, {
        where: { createdAt: MoreThanOrEqual(retentionWindowStart) },
      }),
      manager.count(AgentTaskEntity),
    ]);
    if (totalTasks >= MAX_AGENT_TASK_ROWS_HARD) {
      throw new ServiceUnavailableException({
        code: 'AGENT_TASK_STORAGE_CAPACITY_REACHED',
        message: 'Durable Agent task storage reached its fail-closed hard bound',
      });
    }
    const retentionWindowLimit = admissionClass === 'safety'
      ? MAX_AGENT_TASKS_PER_RETENTION_WINDOW
      : admissionClass === 'reconciliation'
        ? MAX_NON_SAFETY_AGENT_TASKS_PER_RETENTION_WINDOW
        : MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW;
    if (recentTasks >= retentionWindowLimit) {
      throw new ServiceUnavailableException({
        code: 'AGENT_TASK_RETENTION_WINDOW_CAPACITY_REACHED',
        message: 'Agent task creation is temporarily rate-limited by the bounded result-retention window',
      });
    }
    const serverLimit = admissionClass === 'safety'
      ? MAX_ALL_TASKS_PER_SERVER
      : admissionClass === 'reconciliation'
        ? MAX_RECONCILIATION_TASKS_PER_SERVER
        : MAX_PENDING_AGENT_TASKS_PER_SERVER;
    const globalLimit = admissionClass === 'reconciliation'
        ? MAX_RECONCILIATION_TASKS_GLOBAL
        : MAX_PENDING_AGENT_TASKS_GLOBAL;
    const safetyFull = admissionClass === 'safety'
      && serverSafety >= MAX_SAFETY_TASKS_PER_SERVER;
    if (
      serverPending >= serverLimit
      || (admissionClass !== 'safety' && globalPending >= globalLimit)
      || safetyFull
    ) {
      throw new ServiceUnavailableException({
        code: 'AGENT_TASK_QUEUE_FULL',
        message: 'Durable Agent task queue capacity is exhausted',
        serverId: input.serverId,
      });
    }
    // UUIDv7 preserves enqueue order when SQLite timestamps share the same
    // millisecond, so the per-server dispatcher has a deterministic FIFO tie-break.
    const taskId = uuidv7();
    const resourceKeys = [...new Set(
      input.resourceKeys?.length
        ? input.resourceKeys
        : [this.resourceKeys.generic(input.serverId, input.resourceType, input.resourceId)],
    )].sort();
    const payload = this.parsePayload(input);
    const wirePayload = this.payloadCodec.forWirePayload(input.kind, payload);
    this.assertWirePayloadSize(input.kind, wirePayload);
    const payloadHash = this.payloadHash(input.kind, wirePayload);
    await manager.save(AgentTaskEntity, manager.create(AgentTaskEntity, {
      id: taskId,
      kind: input.kind,
      serverId: input.serverId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestedBy: input.requestedBy,
      requestJson,
      payloadJson: payload,
      payloadHash,
      admissionClass,
      status: AgentTaskStatus.Pending,
      failureStage: null,
      agentResultJson: null,
      dispatchAttemptCount: 0,
      incompleteResultCount: 0,
      retryWindowStartedAt: null,
      nextDispatchAt: input.nextDispatchAt ?? null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: null,
      errorJson: null,
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
    }));
    try {
      await this.resourceLocks.insertForTask(manager, {
        taskId,
        serverId: input.serverId,
        resourceKeys,
      });
    } catch (error) {
      // ResourceLockedException is raised before any lock insert. Remove the
      // just-created task so report-side callers may safely treat contention
      // as deferred without committing an unlocked phantom task.
      if (error instanceof ResourceLockedException) {
        await manager.delete(AgentTaskEntity, { id: taskId });
      }
      throw error;
    }
    await input.beforeCommit?.(manager, { taskId });
    return { ok: true, taskId, status: AgentTaskStatus.Pending };
  }

  /**
   * Replace an unresolved desired-state task inside the caller's serialized
   * transaction. The caller must update the domain projection and enqueue its
   * successor before commit, so there is never an unlocked ambiguous intent.
   */
  async supersedePendingForResourceInTransaction(
    manager: EntityManager,
    input: { serverId: string; resourceType: string; resourceId: string; reason: string },
  ): Promise<string[]> {
    const pending = await manager.find(AgentTaskEntity, {
      select: { id: true },
      where: {
        serverId: input.serverId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        status: AgentTaskStatus.Pending,
        // A staged Agent outcome is an immutable commit barrier: physical
        // execution is finished and only the Backend finalizer remains.  It
        // must retain its resource locks until that finalizer commits; a new
        // intent may retry after finalization, never overwrite this evidence.
        agentResultJson: IsNull(),
        // Supersession is only safe before any bytes could have reached the
        // Agent. Once dispatched, the old physical effect owns the lock until
        // its explicit terminal result is finalized.
        startedAt: IsNull(),
        lastSentAt: IsNull(),
      },
      order: { id: 'ASC' },
      // Resource locking admits at most one pending owner for one logical
      // resource. Read one extra identity so corruption fails closed without
      // scanning an attacker-sized duplicate set.
      take: 2,
    });
    if (pending.length > 1) {
      throw new ConflictException({
        code: 'AGENT_TASK_SUPERSEDE_OWNER_CONFLICT',
        message: 'Multiple undispatched tasks claim the same logical resource; repair durable task ownership before replacing intent',
        serverId: input.serverId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      });
    }
    for (const task of pending) {
      await manager.update(AgentTaskEntity, task.id, {
        status: AgentTaskStatus.Failed,
        failureStage: null,
        errorJson: { code: 'TASK_SUPERSEDED', message: input.reason.slice(0, 2048) },
        completedAt: new Date(),
        lastSentAt: null,
        nextDispatchAt: null,
      } as never);
      await this.resourceLocks.releaseTask(task.id, manager);
    }
    return pending.map((task) => task.id);
  }

  async getForUser(userId: string, taskId: string): Promise<AgentTaskDto> {
    const task = await this.tasksRepo.findOneBy({ id: taskId });
    if (!task || task.requestedBy !== userId) throw new NotFoundException('Task not found');
    return this.toDto(task);
  }

  async getForAdmin(taskId: string): Promise<AgentTaskDto> {
    const task = await this.tasksRepo.findOneBy({ id: taskId });
    if (!task) throw new NotFoundException('Task not found');
    return this.toDto(task);
  }

  async listForUser(
    userId: string,
    filters: { resourceType?: string; resourceId?: string; serverId?: string; limit?: number } = {},
  ): Promise<AgentTaskDto[]> {
    return this.list({ ...filters, requestedBy: userId });
  }

  async listForAdmin(
    filters: { resourceType?: string; resourceId?: string; serverId?: string; limit?: number } = {},
  ): Promise<AgentTaskDto[]> {
    return this.list(filters);
  }

  /** Return only the highest-priority due task for one physical Agent lane. */
  async nextDueForDispatch(
    serverId: string,
    cutoff: Date,
  ): Promise<AgentTaskEntity | null> {
    // Select only identities for the invariant check. A corrupt database must
    // not make the dispatcher materialize an unbounded set of task payloads.
    const inFlight = await this.tasksRepo.createQueryBuilder('task')
      .select(['task.id'])
      .where('task.server_id = :serverId', { serverId })
      .andWhere('task.status = :pending', { pending: AgentTaskStatus.Pending })
      .andWhere('task.agent_result_json IS NULL')
      .andWhere('task.last_sent_at IS NOT NULL')
      .orderBy('task.id', 'ASC')
      .limit(2)
      .getMany();
    if (inFlight.length > 1) {
      // A query failure is merely transient and propagates to the dispatcher.
      // Only a second bounded observation inside the serialized transaction is
      // authoritative enough to durably quarantine this physical lane.
      if (await this.quarantineDuplicatePhysicalOwners(serverId)) return null;
    }
    const now = new Date();
    const maxBackoffFuture = new Date(now.getTime() + 60_000);
    const maxSentFuture = new Date(now.getTime() + 5_000);
    return this.tasksRepo.createQueryBuilder('task')
      .where('task.status = :pending', { pending: AgentTaskStatus.Pending })
      .andWhere('task.agent_result_json IS NULL')
      .andWhere('task.server_id = :serverId', { serverId })
      // Exactly one sent-but-unanswered task owns the physical slot. A staged
      // DB finalizer or an incomplete task in backoff does not own that slot;
      // durable resource locks still prevent unsafe overlapping effects.
      .andWhere(`NOT EXISTS (
        SELECT 1 FROM agent_tasks active
        WHERE active.server_id = task.server_id
          AND active.status = :pending
          AND active.agent_result_json IS NULL
          AND active.last_sent_at IS NOT NULL
          AND active.id <> task.id
      )`)
      .andWhere(`(
        task.next_dispatch_at IS NULL
        OR task.next_dispatch_at <= :now
        OR task.next_dispatch_at > :maxBackoffFuture
      )`, {
        now,
        maxBackoffFuture,
      })
      .andWhere(`(
        task.last_sent_at IS NULL
        OR task.last_sent_at <= :cutoff
        OR task.last_sent_at > :maxSentFuture
      )`, { cutoff, maxSentFuture })
      // Safety convergence must preempt ordinary retries. Otherwise an older
      // incomplete intent can consume its uncertainty budget while the exact
      // cleanup that would make it succeed waits behind it.
      .orderBy(`CASE task.admission_class
        WHEN 'safety' THEN 0
        WHEN 'reconciliation' THEN 1
        ELSE 2
      END`, 'ASC')
      .addOrderBy('task.created_at', 'ASC')
      .addOrderBy('task.id', 'ASC')
      .limit(1)
      .getOne();
  }

  async markSentAndBuild(taskId: string): Promise<import('@nyabase/common').TaskExecutePayload | null> {
    const output = await runSerializedTransaction(this.dataSource, async (manager) => {
      const task = await manager.findOne(AgentTaskEntity, { where: { id: taskId } });
      if (
        !task
        || task.status !== AgentTaskStatus.Pending
        || task.agentResultJson !== null
      ) return null;
      const server = await manager.findOneBy(ServerEntity, { id: task.serverId });
      if (!server || server.status !== ServerStatus.Online) return null;
      const now = new Date();
      const maxBackoffFuture = now.getTime() + 60_000;
      if (
        task.nextDispatchAt
        && task.nextDispatchAt.getTime() > now.getTime()
        && task.nextDispatchAt.getTime() <= maxBackoffFuture
      ) return null;
      const resendCutoff = now.getTime() - AGENT_TASK_RESEND_INTERVAL_MS;
      const maxSentFuture = now.getTime() + AGENT_TASK_RESEND_INTERVAL_MS;
      if (
        task.lastSentAt
        && task.lastSentAt.getTime() > resendCutoff
        && task.lastSentAt.getTime() <= maxSentFuture
      ) return null;
      const physicalOwner = await manager.findOne(AgentTaskEntity, {
        where: {
          serverId: task.serverId,
          status: AgentTaskStatus.Pending,
          agentResultJson: IsNull(),
          lastSentAt: Not(IsNull()),
        },
      });
      if (physicalOwner && physicalOwner.id !== task.id) return null;
      const networkFreezeReason = await this.networkActivationFreezeReason(
        manager,
        task,
        server,
      );
      if (networkFreezeReason) {
        await manager.update(AgentTaskEntity, task.id, {
          nextDispatchAt: new Date(now.getTime() + MIN_AGENT_TASK_DISPATCH_DEFER_MS),
          failureStage: null,
          errorJson: {
            code: 'NETWORK_ACTIVATION_FROZEN',
            message: networkFreezeReason,
          },
        } as never);
        return null;
      }
      const wirePayload = this.buildWirePayload(task);
      await manager.update(AgentTaskEntity, task.id, {
        startedAt: task.startedAt ?? now,
        retryWindowStartedAt: task.retryWindowStartedAt ?? now,
        lastSentAt: now,
        dispatchAttemptCount: task.dispatchAttemptCount + 1,
        nextDispatchAt: null,
        failureStage: null,
        errorJson: null,
      } as never);
      return {
        taskId: task.id,
        kind: task.kind,
        payloadHash: task.payloadHash,
        payload: wirePayload as import('@nyabase/common').TaskExecutePayload['payload'],
      };
    });
    return output;
  }

  private async networkActivationFreezeReason(
    manager: EntityManager,
    task: AgentTaskEntity,
    server: ServerEntity,
  ): Promise<string | null> {
    if (
      task.kind !== AgentTaskKind.ContainerCreate
      && task.kind !== AgentTaskKind.ContainerStart
      && task.kind !== AgentTaskKind.ContainerRestart
    ) return null;
    if (!server.macvlanCidr) return 'Target Server has no authoritative network identity';
    if (await networkHasUntrustedInventory(manager, server.macvlanCidr)) {
      return 'A Server on the shared macvlan has no trusted authoritative inventory';
    }
    const claim = await manager.findOne(NetworkAddressClaimEntity, {
      where: {
        ownerKind: 'container',
        ownerId: task.resourceId,
        serverId: server.id,
        state: 'active',
      },
    });
    if (!claim || claim.networkKey !== server.macvlanCidr) {
      return `Container ${task.resourceId} has no exact active address claim on the target network`;
    }
    const claimants = await manager.count(NetworkAddressClaimEntity, {
      where: { address: claim.address, state: 'active' },
    });
    if (claimants !== 1) {
      return `Container ${task.resourceId} address ${claim.address} has ${claimants} active claimants`;
    }
    let payload: ReturnType<typeof parseAgentTaskPayload>;
    try {
      payload = parseAgentTaskPayload(task.kind, task.payloadJson);
    } catch {
      return `Container ${task.resourceId} activation payload is invalid`;
    }
    if (payload.containerId !== task.resourceId) {
      return `Container activation payload identity does not match ${task.resourceId}`;
    }
    if (
      task.kind === AgentTaskKind.ContainerCreate
      && parseAgentTaskPayload(AgentTaskKind.ContainerCreate, task.payloadJson).assignedIp !== claim.address
    ) {
      return `Container ${task.resourceId} create address does not match its exact active claim`;
    }
    return null;
  }

  /**
   * A deterministic payload defect discovered before the first send has a
   * proved no-effect outcome. Stage it for the normal database-only finalizer
   * so domain state, task failure, and lock release still commit atomically.
   */
  async stageNeverDispatchedPayloadFailure(
    taskId: string,
    error: unknown,
    code = 'DISPATCH_PAYLOAD_INVALID',
  ): Promise<boolean> {
    const outcome = await runSerializedTransaction(this.dataSource, async (manager) => {
      const task = await manager.findOne(AgentTaskEntity, { where: { id: taskId } });
      if (
        !task
        || task.status !== AgentTaskStatus.Pending
        || task.agentResultJson !== null
        || task.startedAt !== null
        || task.lastSentAt !== null
      ) return { staged: false, quarantineServerId: null as string | null };
      const taskError = {
        code,
        message: this.errorMessage(error).slice(0, 2048),
      };
      const unsafeQuota = task.kind === AgentTaskKind.QuotaEnsure;
      const unsafeSafetyIntent = task.admissionClass === 'safety';
      if (unsafeQuota || unsafeSafetyIntent) {
        const failStopCode = unsafeQuota
          ? 'AGENT_QUOTA_OUTCOME_UNSAFE'
          : 'AGENT_SAFETY_OUTCOME_UNSAFE';
        await manager.update(AgentTaskEntity, task.id, {
          status: AgentTaskStatus.Failed,
          failureStage: 'dispatch',
          agentResultJson: null,
          finalizerAttemptCount: 0,
          finalizerRetryAt: null,
          resultJson: null,
          errorJson: {
            code: failStopCode,
            message: unsafeQuota
              ? 'Quota intent could not be dispatched; existing workloads are blocked until the same immutable task is explicitly retried'
              : 'Safety intent could not be dispatched; the server is blocked and the exact convergence authority is retained for retry',
            cause: taskError,
          },
          nextDispatchAt: null,
          completedAt: new Date(),
        } as never);
        await manager.update(ServerEntity, task.serverId, {
          status: ServerStatus.AgentQuarantined,
          quarantineCode: AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
          quarantineMessage: unsafeQuota
            ? 'Disk quota enforcement was never dispatched; existing workloads are blocked until the same task is explicitly retried'
            : 'A safety task could not be dispatched; the same immutable task must be explicitly retried',
        });
        return { staged: true, quarantineServerId: task.serverId };
      }
      const observed = this.neverDispatchedObservation(task);
      const terminalResult = {
        taskId: task.id,
        payloadHash: task.payloadHash,
        status: 'failed',
        error: taskError,
        observed,
      } satisfies Extract<TaskResultPayload, { status: 'failed' }>;
      validateTerminalAgentResult(task, terminalResult, { source: 'dispatch' });
      await manager.update(AgentTaskEntity, task.id, {
        agentResultJson: {
          status: 'failed',
          error: taskError,
          observed,
        },
        failureStage: 'dispatch',
        finalizerAttemptCount: 0,
        finalizerRetryAt: null,
        nextDispatchAt: null,
        errorJson: taskError,
      } as never);
      return { staged: true, quarantineServerId: null as string | null };
    });
    if (outcome.quarantineServerId) {
      this.proxySnapshots.blockServer(
        outcome.quarantineServerId,
        `safety-critical task was never dispatched on ${outcome.quarantineServerId}`,
      );
    }
    return outcome.staged;
  }

  async deferDispatchFailure(taskId: string, error: unknown): Promise<void> {
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const task = await manager.findOne(AgentTaskEntity, { where: { id: taskId } });
      if (
        !task
        || task.status !== AgentTaskStatus.Pending
        || task.agentResultJson !== null
      ) return;
      await manager.update(AgentTaskEntity, task.id, {
        dispatchAttemptCount: task.dispatchAttemptCount + 1,
        lastSentAt: null,
        nextDispatchAt: new Date(
          Date.now() + Math.min(
            60_000,
            MIN_AGENT_TASK_DISPATCH_DEFER_MS * (2 ** Math.min(task.dispatchAttemptCount, 6)),
          ),
        ),
        failureStage: null,
        errorJson: {
          code: 'DISPATCH_RETRY_PENDING',
          message: this.errorMessage(error).slice(0, 2048),
        },
      } as never);
    });
  }

  /**
   * Re-check a corrupt physical lane and quarantine it in the same durable
   * transaction. The exact tasks and locks remain untouched for explicit
   * operator repair; the process-local route/session fence is established
   * only after the durable update commits.
   */
  private async quarantineDuplicatePhysicalOwners(serverId: string): Promise<boolean> {
    const ownerIds = await runSerializedTransaction(this.dataSource, async (manager) => {
      const owners = await manager.find(AgentTaskEntity, {
        select: { id: true },
        where: {
          serverId,
          status: AgentTaskStatus.Pending,
          agentResultJson: IsNull(),
          lastSentAt: Not(IsNull()),
        },
        order: { id: 'ASC' },
        take: 2,
      });
      if (owners.length < 2) return null;
      if (!await manager.existsBy(ServerEntity, { id: serverId })) return null;
      await manager.update(ServerEntity, serverId, {
        status: ServerStatus.AgentQuarantined,
        quarantineCode: AGENT_TASK_FAIL_STOP_QUARANTINE_CODE,
        quarantineMessage: 'Multiple pending Agent tasks claimed the same physical execution slot; tasks and locks require explicit repair',
      });
      return owners.map((task) => task.id);
    });
    if (!ownerIds) return false;
    this.proxySnapshots.blockServer(
      serverId,
      `duplicate Agent physical task owners on ${serverId}: ${ownerIds.join(', ')}`,
    );
    return true;
  }

  private payloadHash(kind: string, payload: unknown): string {
    return createHash('sha256')
      .update(canonicalJson({ kind, payload }))
      .digest('hex');
  }

  private buildWirePayload(task: AgentTaskEntity): unknown {
    try {
      const wireCandidate = this.payloadCodec.forDispatch(task);
      const wirePayload = this.jsonValue(parseAgentTaskPayload(task.kind, wireCandidate));
      this.assertWirePayloadSize(task.kind, wirePayload);
      if (this.payloadHash(task.kind, wirePayload) !== task.payloadHash) {
        throw new Error('wire payload hash does not match its durable identity');
      }
      return wirePayload;
    } catch (error) {
      if (error instanceof PermanentTaskPayloadError) throw error;
      throw new PermanentTaskPayloadError(
        task.id,
        `Task ${task.id} durable payload is invalid: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private neverDispatchedObservation(task: AgentTaskEntity): Record<string, unknown> {
    const noEffect = { applied: false, reason: 'never_dispatched' } as const;
    switch (task.kind) {
      case AgentTaskKind.ContainerCreate:
      case AgentTaskKind.ContainerStart:
      case AgentTaskKind.ContainerStop:
      case AgentTaskKind.ContainerRestart:
      case AgentTaskKind.ContainerDelete:
      case AgentTaskKind.ContainerSshEnsure:
        return { containerId: task.resourceId, ...noEffect };
      case AgentTaskKind.ContainerRuntimeAbsent: {
        return {
          expectedRuntimeId: task.resourceId,
          ...noEffect,
        };
      }
      case AgentTaskKind.DataDirEnsure:
      case AgentTaskKind.DataDirAbsent:
        return { expectedResourceId: task.resourceId, ...noEffect };
      case AgentTaskKind.RemoteFsEnsure:
      case AgentTaskKind.RemoteFsAbsent:
        return { id: task.resourceId, ...noEffect };
      case AgentTaskKind.QuotaEnsure:
      case AgentTaskKind.ImageEnsurePresent:
      case AgentTaskKind.ImageEnsureAbsent:
        return { resourceId: task.resourceId, ...noEffect };
    }
  }

  private isNeverDispatched(task: AgentTaskEntity): boolean {
    return task.status === AgentTaskStatus.Pending
      && task.agentResultJson === null
      && task.startedAt === null
      && task.lastSentAt === null;
  }

  private assertWirePayloadSize(kind: string, payload: unknown): void {
    const bytes = Buffer.byteLength(canonicalJson({ kind, payload }));
    if (bytes > MAX_AGENT_TASK_WIRE_BYTES) {
      throw new BadRequestException({
        code: 'AGENT_TASK_PAYLOAD_TOO_LARGE',
        message: `Agent task wire payload exceeds ${MAX_AGENT_TASK_WIRE_BYTES} bytes`,
      });
    }
  }

  private jsonValue(value: unknown): unknown {
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.map((entry) => this.jsonValue(entry));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, this.jsonValue(entry)]),
    );
  }

  private prepareRequestJson(request: unknown): unknown | null {
    if (request === undefined) return null;
    try {
      const value = this.jsonValue(request);
      const bytes = Buffer.byteLength(canonicalJson(value));
      if (bytes > MAX_AGENT_TASK_REQUEST_BYTES) {
        throw new BadRequestException({
          code: 'AGENT_TASK_REQUEST_TOO_LARGE',
          message: `Agent task request metadata exceeds ${MAX_AGENT_TASK_REQUEST_BYTES} bytes`,
        });
      }
      return value;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException({
        code: 'INVALID_AGENT_TASK_REQUEST',
        message: 'Agent task request metadata is not a bounded JSON value',
        details: this.errorMessage(error).slice(0, 1024),
      });
    }
  }

  private parsePayload(input: EnqueueAgentTaskInput): unknown {
    try {
      const storedCandidate = this.jsonValue(input.payload);
      const wireCandidate = this.payloadCodec.forWirePayload(input.kind, storedCandidate);
      const parsedWire = this.jsonValue(parseAgentTaskPayload(input.kind, wireCandidate));
      if (
        input.kind !== AgentTaskKind.RemoteFsEnsure
        && input.kind !== AgentTaskKind.RemoteFsAbsent
      ) return parsedWire;

      // RemoteFS credentials are encrypted at rest. Validate the decrypted wire
      // form, then restore only the encrypted secret into the schema-stripped
      // payload that is persisted.
      const stored = this.record(storedCandidate);
      const parsed = this.record(parsedWire);
      const storedParams = this.record(stored?.params);
      const parsedParams = this.record(parsed?.params);
      if (typeof storedParams?.secret === 'string' && parsedParams) {
        parsedParams.secret = storedParams.secret;
      }
      return parsedWire;
    } catch (error) {
      throw new BadRequestException({
        code: 'INVALID_AGENT_TASK_PAYLOAD',
        message: `Invalid payload for ${input.kind}`,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private errorCode(value: unknown): string | null {
    const record = this.record(value);
    return typeof record?.code === 'string' ? record.code : null;
  }

  private isRetryableQuarantineFailure(task: AgentTaskEntity): boolean {
    return task.status === AgentTaskStatus.Failed
      && (
        task.kind === AgentTaskKind.ContainerRuntimeAbsent
        || RETRYABLE_QUARANTINE_ERROR_CODE_SET.has(this.errorCode(task.errorJson) ?? '')
      );
  }

  private async quarantineRetryAuthorityIds(
    manager: EntityManager,
    serverId: string,
  ): Promise<string[]> {
    const rows = await manager.getRepository(ResourceLockEntity)
      .createQueryBuilder('lock')
      .select('lock.task_id', 'taskId')
      .where('lock.server_id = :serverId', { serverId })
      .groupBy('lock.task_id')
      .orderBy('lock.task_id', 'ASC')
      .limit(MAX_ALL_TASKS_PER_SERVER + 1)
      .getRawMany<{ taskId: string }>();
    return this.assertBoundedQuarantineAuthorityIds(
      rows.map((row) => row.taskId),
      'resource locks',
    );
  }

  private async retainedFailedAuthorityIds(
    manager: EntityManager,
    serverId: string,
  ): Promise<string[]> {
    const rows = await manager.getRepository(AgentTaskEntity)
      .createQueryBuilder('task')
      .select('task.id', 'taskId')
      .where('task.server_id = :serverId', { serverId })
      .andWhere('task.status = :status', { status: AgentTaskStatus.Failed })
      .andWhere(`(
        task.kind = :runtimeAbsent
        OR (
          task.error_json IS NOT NULL
          AND json_valid(task.error_json) = 1
          AND json_extract(task.error_json, '$.code') IN (:...errorCodes)
        )
      )`, {
        runtimeAbsent: AgentTaskKind.ContainerRuntimeAbsent,
        errorCodes: RETRYABLE_QUARANTINE_ERROR_CODES,
      })
      .orderBy('task.id', 'ASC')
      .limit(MAX_ALL_TASKS_PER_SERVER + 1)
      .getRawMany<{ taskId: string }>();
    return this.assertBoundedQuarantineAuthorityIds(
      rows.map((row) => row.taskId),
      'retained failed tasks',
    );
  }

  private async pendingStartedAuthorityIds(
    manager: EntityManager,
    serverId: string,
  ): Promise<string[]> {
    const rows = await manager.getRepository(AgentTaskEntity)
      .createQueryBuilder('task')
      .select('task.id', 'taskId')
      .where('task.server_id = :serverId', { serverId })
      .andWhere('task.status = :status', { status: AgentTaskStatus.Pending })
      .andWhere('task.started_at IS NOT NULL')
      .orderBy('task.id', 'ASC')
      .limit(MAX_ALL_TASKS_PER_SERVER + 1)
      .getRawMany<{ taskId: string }>();
    return this.assertBoundedQuarantineAuthorityIds(
      rows.map((row) => row.taskId),
      'started pending tasks',
    );
  }

  private assertBoundedQuarantineAuthorityIds(ids: string[], source: string): string[] {
    if (ids.length > MAX_ALL_TASKS_PER_SERVER) {
      throw new ConflictException({
        code: 'AGENT_QUARANTINE_AUTHORITY_LIMIT_EXCEEDED',
        message: `Server has more than ${MAX_ALL_TASKS_PER_SERVER} ${source}; repair the durable authority ledger before retry`,
      });
    }
    return ids;
  }

  private assertRetryableStagedResult(task: AgentTaskEntity): void {
    try {
      const evidence = this.record(task.agentResultJson);
      const result = zTaskResultPayload.parse({
        taskId: task.id,
        payloadHash: task.payloadHash,
        ...evidence,
      });
      if (result.status === 'incomplete') throw new Error('staged outcome is not terminal');
    } catch (error) {
      throw new ConflictException({
        code: 'AGENT_QUARANTINE_STAGED_RESULT_CORRUPT',
        message: `Retained finalizer task ${task.id} has invalid immutable Agent evidence`,
        details: this.errorMessage(error).slice(0, 1024),
      });
    }
  }

  private hasNeverDispatchedEvidence(task: AgentTaskEntity): boolean {
    const evidence = this.record(task.agentResultJson);
    const observed = this.record(evidence?.observed);
    return observed?.applied === false && observed.reason === 'never_dispatched';
  }

  private errorMessage(error: unknown): string {
    try {
      return error instanceof Error ? String(error.message) : String(error);
    } catch {
      return 'Unprintable Agent task error';
    }
  }

  private async assertRuntimeCleanupClaimsValid(
    manager: EntityManager,
    serverId: string,
  ): Promise<void> {
    const claims = await manager.find(NetworkAddressClaimEntity, {
      where: { ownerKind: 'runtime_cleanup', serverId, state: 'active' },
      order: { ownerId: 'ASC', address: 'ASC' },
      take: MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER + 1,
    });
    if (claims.length > MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER) {
      throw new ConflictException({
        code: 'AGENT_QUARANTINE_CLEANUP_CLAIM_CAPACITY_CORRUPT',
        message: `Server ${serverId} exceeds the bounded runtime cleanup claim authority`,
      });
    }
    const identityByRuntime = new Map<string, unknown>();
    for (const claim of claims) {
      let payload: ContainerRuntimeAbsentTaskPayload;
      try {
        payload = parseAgentTaskPayload(
          AgentTaskKind.ContainerRuntimeAbsent,
          claim.cleanupPayloadJson,
        ) as ContainerRuntimeAbsentTaskPayload;
      } catch {
        throw new ConflictException({
          code: 'AGENT_QUARANTINE_CLEANUP_CLAIM_CORRUPT',
          message: `Runtime cleanup claim ${claim.id} has invalid immutable evidence`,
        });
      }
      if (
        payload.runtimeId !== claim.ownerId
        || payload.serverId !== serverId
        || payload.observedIp !== claim.address
      ) {
        throw new ConflictException({
          code: 'AGENT_QUARANTINE_CLEANUP_CLAIM_CORRUPT',
          message: `Runtime cleanup claim ${claim.id} identity does not match its ledger row`,
        });
      }
      const identity = this.runtimeCleanupIdentity(payload);
      const previous = identityByRuntime.get(payload.runtimeId);
      if (previous !== undefined && !isDeepStrictEqual(previous, identity)) {
        throw new ConflictException({
          code: 'AGENT_QUARANTINE_CLEANUP_CLAIM_CORRUPT',
          message: `Runtime ${payload.runtimeId} has conflicting cleanup claim identities`,
        });
      }
      identityByRuntime.set(payload.runtimeId, identity);
    }
  }

  private async assertRetainedRuntimeCleanupTask(
    manager: EntityManager,
    task: AgentTaskEntity,
  ): Promise<void> {
    const payload = this.buildWirePayload(task) as ContainerRuntimeAbsentTaskPayload;
    const claims = await manager.find(NetworkAddressClaimEntity, {
      where: {
        ownerKind: 'runtime_cleanup',
        ownerId: payload.runtimeId,
        serverId: task.serverId,
        state: 'active',
      },
    });
    if (!claims.some((claim) => claim.address === payload.observedIp)) {
      throw new ConflictException({
        code: 'AGENT_QUARANTINE_CLEANUP_CLAIM_MISSING',
        message: `Retained runtime cleanup task ${task.id} has no claim for its observed address`,
      });
    }
    const expectedIdentity = this.runtimeCleanupIdentity(payload);
    for (const claim of claims) {
      const claimPayload = parseAgentTaskPayload(
        AgentTaskKind.ContainerRuntimeAbsent,
        claim.cleanupPayloadJson,
      ) as ContainerRuntimeAbsentTaskPayload;
      if (
        claim.address !== claimPayload.observedIp
        || !isDeepStrictEqual(this.runtimeCleanupIdentity(claimPayload), expectedIdentity)
      ) {
        throw new ConflictException({
          code: 'AGENT_QUARANTINE_CLEANUP_IDENTITY_CONFLICT',
          message: `Retained runtime cleanup task ${task.id} conflicts with address claim ${claim.id}`,
        });
      }
    }
  }

  private runtimeCleanupIdentity(payload: ContainerRuntimeAbsentTaskPayload): unknown {
    return {
      runtimeId: payload.runtimeId,
      containerId: payload.containerId,
      serverId: payload.serverId,
      specGeneration: payload.specGeneration,
      runtimeSpecHash: payload.runtimeSpecHash,
      quotaPaths: payload.quotaPaths,
    };
  }

  private toDto(task: AgentTaskEntity, includeDetails = true): AgentTaskDto {
    return {
      id: task.id,
      kind: task.kind,
      status: task.status,
      resourceType: task.resourceType,
      resourceId: task.resourceId,
      serverId: task.serverId,
      requestedBy: task.requestedBy,
      request: includeDetails ? task.requestJson : null,
      agentResult: includeDetails ? task.agentResultJson : null,
      result: includeDetails ? task.resultJson : null,
      error: task.errorJson,
      failureStage: task.failureStage,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString() ?? null,
      lastSentAt: task.lastSentAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      retentionUntil: task.completedAt
        ? new Date(task.completedAt.getTime() + AGENT_TASK_MIN_RETENTION_MS).toISOString()
        : null,
    };
  }

  private async list(filters: {
    requestedBy?: string;
    resourceType?: string;
    resourceId?: string;
    serverId?: string;
    limit?: number;
  }): Promise<AgentTaskDto[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(filters.limit ?? 50)));
    const query = this.tasksRepo.createQueryBuilder('task');
    if (filters.requestedBy) query.andWhere('task.requested_by = :requestedBy', { requestedBy: filters.requestedBy });
    if (filters.resourceType) query.andWhere('task.resource_type = :resourceType', { resourceType: filters.resourceType });
    if (filters.resourceId) query.andWhere('task.resource_id = :resourceId', { resourceId: filters.resourceId });
    if (filters.serverId) query.andWhere('task.server_id = :serverId', { serverId: filters.serverId });
    const rows = await query
      // History is a bounded summary. Full request/outcome evidence is fetched
      // only by the single-task endpoint, avoiding a 100-row amplification of
      // the legal 1 MiB request and payload envelopes.
      .select([
        'task.id',
        'task.kind',
        'task.status',
        'task.resourceType',
        'task.resourceId',
        'task.serverId',
        'task.requestedBy',
        'task.errorJson',
        'task.failureStage',
        'task.createdAt',
        'task.startedAt',
        'task.lastSentAt',
        'task.completedAt',
      ])
      .orderBy('task.created_at', 'DESC')
      .addOrderBy('task.id', 'DESC')
      .limit(limit)
      .getMany();
    return rows.map((task) => this.toDto(task, false));
  }
}
