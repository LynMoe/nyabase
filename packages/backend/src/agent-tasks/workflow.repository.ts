import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  AgentTaskKind,
  AgentTaskStatus,
  ServerStatus,
  canonicalJson,
  type TaskResultPayload,
} from '@nyabase/common';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import type {
  WorkflowAgentSessionTable,
  WorkflowExecSessionTable,
  WorkflowTaskTable,
} from './workflow-database.types.js';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';
import {
  validateDurableAgentTaskIdentity,
  validateDurableAgentTaskRowIdentity,
} from './agent-task-durable-contract.js';
import { validateTerminalAgentResult } from './agent-task-result-validator.js';
import type { AgentTaskRecord } from '../domain/domain-records.js';
import { FailStopService } from '../common/fail-stop.service.js';
import { AgentSessionLockDatabase } from './agent-session-lock-database.js';

const DEFAULT_DISPATCH_LEASE_MS = 15_000;
const DEFAULT_AGENT_SESSION_LEASE_MS = 45_000;
const DEFAULT_FINALIZER_LEASE_MS = 30_000;
const DEFAULT_OUTBOX_LEASE_MS = 15_000;
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

export type WorkflowExecutor =
  | Kysely<NyabaseDatabase>
  | Transaction<NyabaseDatabase>;

export interface WorkflowTaskRecord {
  id: string;
  commandId: string;
  kind: string;
  serverId: string;
  resourceType: string;
  resourceId: string;
  requestedBy: string | null;
  request: unknown | null;
  payload: unknown;
  payloadHash: string;
  admissionClass: 'normal' | 'reconciliation' | 'safety';
  status: AgentTaskStatus;
  failureStage: 'dispatch' | 'agent' | 'finalizer' | null;
  generation: number;
  agentResult: unknown | null;
  result: unknown | null;
  error: unknown | null;
  dispatchAttemptCount: number;
  incompleteResultCount: number;
  finalizerAttemptCount: number;
  createdAt: Date;
  startedAt: Date | null;
  lastSentAt: Date | null;
  completedAt: Date | null;
}

export type WorkflowTaskSummary = Pick<
  WorkflowTaskRecord,
  | 'id'
  | 'kind'
  | 'serverId'
  | 'resourceType'
  | 'resourceId'
  | 'requestedBy'
  | 'status'
  | 'failureStage'
  | 'error'
  | 'payloadHash'
  | 'dispatchAttemptCount'
  | 'createdAt'
  | 'startedAt'
  | 'lastSentAt'
  | 'completedAt'
>;

export interface DispatchClaim {
  task: WorkflowTaskRecord;
  claimToken: string;
  generation: number;
  leaseExpiresAt: Date;
  agentSessionId: string;
  agentSessionGeneration: number;
  gatewayId: string;
}

export interface FinalizerClaim {
  task: WorkflowTaskRecord;
  claimToken: string;
  generation: number;
  leaseExpiresAt: Date;
}

export interface AcceptedAgentResult {
  accepted: boolean;
  terminal: boolean;
  taskId: string;
  payloadHash: string;
  finalizerPending: boolean;
  serverQuarantined?: boolean;
}

export interface OutboxClaim {
  id: string;
  topic: string;
  partitionKey: string;
  payload: unknown;
  claimToken: string;
}

export interface ReconcileClaim {
  id: string;
  dedupeKey: string;
  serverId: string | null;
  resourceType: string;
  resourceId: string;
  reason: string;
  payload: unknown;
  attemptCount: number;
  claimToken: string;
}

export interface WorkflowFinalizerOutcome {
  status: AgentTaskStatus.Succeeded | AgentTaskStatus.Failed;
  result?: unknown;
  error?: unknown;
  failureStage?: 'agent' | 'finalizer';
  releaseClaims: boolean;
}

export type WorkflowAgentSessionState = 'admitted' | 'ready' | 'retired';

export interface WorkflowAgentSessionRecord {
  id: string;
  serverId: string;
  generation: number;
  state: WorkflowAgentSessionState;
  hostFingerprint: string;
  configFingerprint: string;
  admittedAt: Date;
  readyAt: Date | null;
  lastSeenAt: Date;
  retiredAt: Date | null;
  retireReason: string | null;
  gatewayId: string;
  consolePublicUrl: string;
  leaseExpiresAt: Date;
}

export interface WorkflowExecSessionRecord {
  id: string;
  serverId: string;
  userId: string;
  containerId: string;
  runtimeId: string;
  authorizationKind: 'container-owner' | 'manage-containers-any';
  agentSessionId: string;
  agentSessionGeneration: number;
  gatewayId: string;
  consolePublicUrl: string;
  state: 'unclaimed' | 'claimed' | 'closed';
  claimedByGatewayId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export type WorkflowAgentObservationKind =
  | 'hello'
  | 'heartbeat'
  | 'state_report'
  | 'inventory_fault'
  | 'task_result'
  | 'metrics';

export interface WorkflowAgentObservationResult {
  accepted: boolean;
  duplicate: boolean;
  session: WorkflowAgentSessionRecord;
  payloadHash: string;
}

@Injectable()
export class WorkflowRepository {
  private readonly agentSessionLockTails = new Map<string, Promise<void>>();
  private readonly agentSessionLockDepth = new Map<string, number>();

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    @Optional()
    private readonly payloadCodec?: AgentTaskPayloadCodecService,
    private readonly failStop?: FailStopService,
    private readonly sessionLocks?: AgentSessionLockDatabase,
  ) {}

  findTask(
    id: string,
    executor: WorkflowExecutor = this.database,
  ): Promise<WorkflowTaskRecord | null> {
    return executor
      .selectFrom('workflow.tasks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
      .then((row) => row ? toTask(row) : null);
  }

  async findTasks(
    ids: readonly string[],
    executor: WorkflowExecutor = this.database,
  ): Promise<Map<string, WorkflowTaskRecord>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return new Map();
    const rows = await executor
      .selectFrom('workflow.tasks')
      .selectAll()
      .where('id', 'in', uniqueIds)
      .execute();
    return new Map(rows.map((row) => {
      const task = toTask(row);
      return [task.id, task];
    }));
  }

  async listTasks(
    filters: {
      requestedBy?: string;
      resourceType?: string;
      resourceId?: string;
      serverId?: string;
      limit?: number;
      scopes?: readonly {
        resourceType: string;
        kinds: readonly AgentTaskKind[];
      }[];
    } = {},
  ): Promise<WorkflowTaskSummary[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(filters.limit ?? 50)));
    let query = this.database
      .selectFrom('workflow.tasks')
      .select([
        'id',
        'kind',
        'server_id',
        'resource_type',
        'resource_id',
        'requested_by',
        'status',
        'failure_stage',
        'error_json',
        'payload_hash',
        'dispatch_attempt_count',
        'created_at',
        'started_at',
        'last_sent_at',
        'completed_at',
      ]);
    if (filters.requestedBy) query = query.where('requested_by', '=', filters.requestedBy);
    if (filters.resourceType) query = query.where('resource_type', '=', filters.resourceType);
    if (filters.resourceId) query = query.where('resource_id', '=', filters.resourceId);
    if (filters.serverId) query = query.where('server_id', '=', filters.serverId);
    if (filters.scopes) {
      if (filters.scopes.length === 0) return [];
      const scopes = filters.scopes;
      query = query.where((expression) => expression.or(
        scopes.map((scope) => expression.and([
          expression('resource_type', '=', scope.resourceType),
          expression('kind', 'in', [...scope.kinds]),
        ])),
      ));
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      serverId: row.server_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      requestedBy: row.requested_by,
      status: row.status as AgentTaskStatus,
      failureStage: row.failure_stage as WorkflowTaskRecord['failureStage'],
      error: row.error_json,
      payloadHash: row.payload_hash,
      dispatchAttemptCount: row.dispatch_attempt_count,
      createdAt: asDate(row.created_at),
      startedAt: nullableDate(row.started_at),
      lastSentAt: nullableDate(row.last_sent_at),
      completedAt: nullableDate(row.completed_at),
    }));
  }

  /**
   * Establishes one durable current Agent generation for a physical Server.
   * A different current session never gets replaced implicitly.
   */
  admitAgentSession(input: {
    id: string;
    serverId: string;
    sessionToken: string;
    hostFingerprint: string;
    configFingerprint: string;
    gatewayId?: string;
    consolePublicUrl?: string;
    now?: Date;
  }): Promise<WorkflowAgentSessionRecord> {
    const hostFingerprint = boundedIdentity(
      input.hostFingerprint,
      'host fingerprint',
    );
    const configFingerprint = boundedIdentity(
      input.configFingerprint,
      'config fingerprint',
    );
    if (!input.gatewayId) {
      throw new ConflictException({
        code: 'AGENT_GATEWAY_ID_REQUIRED',
        message: 'Agent session admission requires an exact Gateway owner',
      });
    }
    const gatewayId = boundedIdentity(input.gatewayId, 'gateway id');
    const consolePublicUrl = input.consolePublicUrl ?? '';
    const sessionTokenHash = createHash('sha256')
      .update(input.sessionToken)
      .digest('hex');
    return this.transactions.run(async (transaction) => {
      await this.lockAgentSessionFence(transaction, input.serverId);
      const now = await this.databaseClock(transaction);
      const leaseExpiresAt = new Date(
        now.getTime() + DEFAULT_AGENT_SESSION_LEASE_MS,
      );
      const server = await transaction
        .selectFrom('infra.servers')
        .select(['id', 'status'])
        .where('id', '=', input.serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!server) {
        throw new ConflictException({
          code: 'AGENT_SESSION_SERVER_MISSING',
          message: 'Agent session Server no longer exists',
        });
      }
      if (server.status === ServerStatus.AgentQuarantined) {
        throw new ConflictException({
          code: 'AGENT_SESSION_SERVER_QUARANTINED',
          message: 'Agent session cannot be admitted while the Server is quarantined',
        });
      }

      let current = await transaction
        .selectFrom('workflow.agent_sessions')
        .selectAll()
        .where('server_id', '=', input.serverId)
        .where('state', 'in', ['admitted', 'ready'])
        .forUpdate()
        .executeTakeFirst();
      if (
        current
        && asDate(current.lease_expires_at).getTime() <= now.getTime()
      ) {
        await transaction
          .updateTable('workflow.exec_sessions')
          .set({
            state: 'closed',
            closed_at: now,
            close_reason: 'Agent session ownership lease expired',
            expires_at: now,
          })
          .where('agent_session_id', '=', current.id)
          .where(
            'agent_session_generation',
            '=',
            current.generation,
          )
          .where('gateway_id', '=', current.gateway_id)
          .where('state', 'in', ['unclaimed', 'claimed'])
          .execute();
        await transaction
          .updateTable('workflow.agent_sessions')
          .set({
            state: 'retired',
            retired_at: now,
            retire_reason: 'Gateway ownership lease expired',
            last_seen_at: now,
          })
          .where('id', '=', current.id)
          .where('state', 'in', ['admitted', 'ready'])
          .executeTakeFirstOrThrow();
        current = undefined;
      }
      if (current) {
        if (
          current.id === input.id
          && current.gateway_id === gatewayId
          && current.console_public_url === consolePublicUrl
          && current.session_token_hash === sessionTokenHash
          && current.host_fingerprint === hostFingerprint
          && current.config_fingerprint === configFingerprint
        ) {
          await transaction
            .updateTable('workflow.agent_sessions')
            .set({ last_seen_at: now, lease_expires_at: leaseExpiresAt })
            .where('id', '=', current.id)
            .where('state', 'in', ['admitted', 'ready'])
            .executeTakeFirstOrThrow();
          return toAgentSession({
            ...current,
            last_seen_at: now,
            lease_expires_at: leaseExpiresAt,
          });
        }
        throw new ConflictException({
          code: 'AGENT_SESSION_ALREADY_CURRENT',
          message: 'Another Agent session generation is still authoritative',
        });
      }

      const previous = await transaction
        .selectFrom('workflow.agent_sessions')
        .select(({ fn }) => fn.max('generation').as('generation'))
        .where('server_id', '=', input.serverId)
        .executeTakeFirst();
      const generation = Number(previous?.generation ?? 0) + 1;
      const inserted = await transaction
        .insertInto('workflow.agent_sessions')
        .values({
          id: input.id,
          server_id: input.serverId,
          generation,
          session_token_hash: sessionTokenHash,
          state: 'admitted',
          host_fingerprint: hostFingerprint,
          config_fingerprint: configFingerprint,
          gateway_id: gatewayId,
          console_public_url: consolePublicUrl,
          lease_expires_at: leaseExpiresAt,
          admitted_at: now,
          ready_at: null,
          last_seen_at: now,
          retired_at: null,
          retire_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toAgentSession(inserted);
    });
  }

  markAgentSessionReady(
    serverId: string,
    sessionId: string,
    generation?: number,
    gatewayId?: string,
    _now = new Date(),
    runtimeReady = true,
  ): Promise<WorkflowAgentSessionRecord | null> {
    if (!generation || !gatewayId) return Promise.resolve(null);
    return this.transactions.run(async (transaction) => {
      const now = await this.databaseClock(transaction);
      const leaseExpiresAt = new Date(
        now.getTime() + DEFAULT_AGENT_SESSION_LEASE_MS,
      );
      const current = await transaction
        .selectFrom('workflow.agent_sessions')
        .selectAll()
        .where('id', '=', sessionId)
        .where('server_id', '=', serverId)
        .where('generation', '=', String(generation))
        .where('gateway_id', '=', gatewayId)
        .where('state', 'in', ['admitted', 'ready'])
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return null;
      if (current.state === 'ready') {
        await transaction
          .updateTable('workflow.agent_sessions')
          .set({ last_seen_at: now, lease_expires_at: leaseExpiresAt })
          .where('id', '=', sessionId)
          .where('state', '=', 'ready')
          .execute();
        await transaction
          .updateTable('workflow.agent_runtime_projections')
          .set({ runtime_ready: runtimeReady })
          .where('server_id', '=', serverId)
          .where('session_id', '=', sessionId)
          .where('session_generation', '=', String(generation))
          .where('gateway_id', '=', gatewayId)
          .execute();
        return toAgentSession({
          ...current,
          last_seen_at: now,
          lease_expires_at: leaseExpiresAt,
        });
      }
      const ready = await transaction
        .updateTable('workflow.agent_sessions')
        .set({
          state: 'ready',
          ready_at: now,
          last_seen_at: now,
          lease_expires_at: leaseExpiresAt,
        })
        .where('id', '=', sessionId)
        .where('server_id', '=', serverId)
        .where('state', '=', 'admitted')
        .returningAll()
        .executeTakeFirst();
      if (ready) {
        await transaction
          .updateTable('workflow.agent_runtime_projections')
          .set({ runtime_ready: runtimeReady })
          .where('server_id', '=', serverId)
          .where('session_id', '=', sessionId)
          .where('session_generation', '=', String(generation))
          .where('gateway_id', '=', gatewayId)
          .execute();
      }
      return ready ? toAgentSession(ready) : null;
    });
  }

  retireAgentSession(
    serverId: string,
    sessionId: string,
    reason: string,
    now?: Date,
  ): Promise<boolean> {
    const retireReason = boundedDiagnostic(reason);
    return this.transactions.run(async (transaction) => {
      const effectiveNow = now ?? await this.databaseClock(transaction);
      await this.lockAgentSessionFence(transaction, serverId);
      const result = await transaction
        .updateTable('workflow.agent_sessions')
        .set({
          state: 'retired',
          retired_at: effectiveNow,
          retire_reason: retireReason,
          last_seen_at: effectiveNow,
        })
        .where('id', '=', sessionId)
        .where('server_id', '=', serverId)
        .where('state', 'in', ['admitted', 'ready'])
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    });
  }

  /**
   * Retires one exact generation and applies every durable no-owner cleanup
   * before releasing the same per-Server takeover fence. A successor cannot
   * become current between retirement and liveness/route revocation.
   */
  retireAgentSessionWithCleanup<T>(
    input: {
      serverId: string;
      sessionId: string;
      sessionGeneration: number;
      gatewayId: string;
    },
    reason: string,
    cleanup: (transaction: Transaction<NyabaseDatabase>) => Promise<T>,
    now?: Date,
  ): Promise<{ retired: boolean; cleanup: T | null }> {
    const retireReason = boundedDiagnostic(reason);
    return this.transactions.run(async (transaction) => {
      const effectiveNow = now ?? await this.databaseClock(transaction);
      await this.lockAgentSessionFence(transaction, input.serverId);
      const retired = await transaction
        .updateTable('workflow.agent_sessions')
        .set({
          state: 'retired',
          retired_at: effectiveNow,
          retire_reason: retireReason,
          last_seen_at: effectiveNow,
        })
        .where('id', '=', input.sessionId)
        .where('server_id', '=', input.serverId)
        .where('generation', '=', String(input.sessionGeneration))
        .where('gateway_id', '=', input.gatewayId)
        .where('state', 'in', ['admitted', 'ready'])
        .executeTakeFirst();
      if (Number(retired.numUpdatedRows) !== 1) {
        return { retired: false, cleanup: null };
      }
      await transaction
        .updateTable('workflow.agent_runtime_projections')
        .set({ runtime_ready: false })
        .where('server_id', '=', input.serverId)
        .where('session_id', '=', input.sessionId)
        .where('session_generation', '=', String(input.sessionGeneration))
        .where('gateway_id', '=', input.gatewayId)
        .execute();
      await transaction
        .updateTable('workflow.exec_sessions')
        .set({
          state: 'closed',
          closed_at: now,
          close_reason: retireReason,
        })
        .where('agent_session_id', '=', input.sessionId)
        .where('agent_session_generation', '=', String(input.sessionGeneration))
        .where('gateway_id', '=', input.gatewayId)
        .where('state', 'in', ['unclaimed', 'claimed'])
        .execute();
      return {
        retired: true,
        cleanup: await cleanup(transaction),
      };
    });
  }

  findCurrentAgentSession(
    serverId: string,
    executor: WorkflowExecutor = this.database,
  ): Promise<WorkflowAgentSessionRecord | null> {
    return executor
      .selectFrom('workflow.agent_sessions')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('state', 'in', ['admitted', 'ready'])
      .executeTakeFirst()
      .then((row) => row ? toAgentSession(row) : null);
  }

  runWithAgentSessionFence<T>(
    input: {
      serverId: string;
      sessionId: string;
      sessionGeneration: number;
      gatewayId: string;
    },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.withAgentSessionAdvisoryLock(input.serverId, async (connection) => {
      const exact = {
        serverId: input.serverId,
        id: input.sessionId,
        generation: input.sessionGeneration,
        gatewayId: input.gatewayId,
      };
      if (!await this.hasExactAgentSession(connection, exact, ['admitted', 'ready'])) {
        throw staleAgentSessionError();
      }
      // Deliberately no database transaction remains open while the report or
      // heartbeat applies its independently atomic domain mutations.
      const result = await work();
      if (!await this.hasExactAgentSession(connection, exact, ['admitted', 'ready'])) {
        throw staleAgentSessionError();
      }
      return result;
    });
  }

  runWithAgentSessionMutationFence<T>(
    serverId: string,
    reason: string,
    work: (transaction: Transaction<NyabaseDatabase>) => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    const retireReason = boundedDiagnostic(reason);
    return this.transactions.run(async (transaction) => {
      await this.lockAgentSessionFence(transaction, serverId);
      await transaction
        .updateTable('workflow.agent_sessions')
        .set({
          state: 'retired',
          retired_at: now,
          retire_reason: retireReason,
          last_seen_at: now,
        })
        .where('server_id', '=', serverId)
        .where('state', 'in', ['admitted', 'ready'])
        .execute();
      await transaction
        .updateTable('workflow.agent_runtime_projections')
        .set({ runtime_ready: false })
        .where('server_id', '=', serverId)
        .execute();
      return work(transaction);
    });
  }

  /**
   * Records immutable, monotonically sequenced evidence only for the exact
   * current session. An exact replay is idempotent; stale or changed evidence
   * is rejected without advancing liveness.
   */
  recordAgentObservation(input: {
    serverId: string;
    sessionId: string;
    sessionGeneration?: number;
    gatewayId?: string;
    sequence: number;
    kind: WorkflowAgentObservationKind;
    payload?: unknown;
    now?: Date;
  }): Promise<WorkflowAgentObservationResult> {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new ConflictException({
        code: 'AGENT_OBSERVATION_SEQUENCE_INVALID',
        message: 'Agent observation sequence must be a non-negative safe integer',
      });
    }
    const payload = input.payload === undefined ? null : jsonValue(input.payload);
    const encoded = canonicalJson(payload);
    if (Buffer.byteLength(encoded) > 1024 * 1024) {
      throw new ConflictException({
        code: 'AGENT_OBSERVATION_TOO_LARGE',
        message: 'Agent observation exceeds 1 MiB',
      });
    }
    const payloadHash = createHash('sha256').update(encoded).digest('hex');
    if (!input.sessionGeneration || !input.gatewayId) {
      throw new ConflictException({
        code: 'AGENT_SESSION_BINDING_REQUIRED',
        message: 'Agent observation requires the exact Gateway session generation',
      });
    }
    const sessionGeneration = input.sessionGeneration;
    const gatewayId = input.gatewayId;
    return this.transactions.run(async (transaction) => {
      const now = await this.databaseClock(transaction);
      const leaseExpiresAt = new Date(
        now.getTime() + DEFAULT_AGENT_SESSION_LEASE_MS,
      );
      const session = await transaction
        .selectFrom('workflow.agent_sessions')
        .selectAll()
        .where('id', '=', input.sessionId)
        .where('server_id', '=', input.serverId)
        .where('generation', '=', String(sessionGeneration))
        .where('gateway_id', '=', gatewayId)
        .where('state', 'in', ['admitted', 'ready'])
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!session) {
        throw new ConflictException({
          code: 'AGENT_SESSION_STALE',
          message: 'Agent observation does not belong to the current session',
        });
      }

      const exact = await transaction
        .selectFrom('workflow.agent_observations')
        .select(['payload_hash', 'payload_json'])
        .where('session_id', '=', input.sessionId)
        .where('sequence', '=', String(input.sequence))
        .where('kind', '=', input.kind)
        .executeTakeFirst();
      if (exact) {
        if (
          exact.payload_hash !== payloadHash
          || canonicalJson(exact.payload_json) !== encoded
        ) {
          throw new ConflictException({
            code: 'AGENT_OBSERVATION_CONFLICT',
            message: 'Agent observation replay conflicts with immutable evidence',
          });
        }
        await transaction
          .updateTable('workflow.agent_sessions')
          .set({ last_seen_at: now, lease_expires_at: leaseExpiresAt })
          .where('id', '=', input.sessionId)
          .where('state', 'in', ['admitted', 'ready'])
          .executeTakeFirstOrThrow();
        return {
          accepted: true,
          duplicate: true,
          session: toAgentSession({
            ...session,
            last_seen_at: now,
            lease_expires_at: leaseExpiresAt,
          }),
          payloadHash,
        };
      }

      const latest = await transaction
        .selectFrom('workflow.agent_observations')
        .select(({ fn }) => fn.max('sequence').as('sequence'))
        .where('session_id', '=', input.sessionId)
        .where('kind', '=', input.kind)
        .executeTakeFirst();
      if (
        latest?.sequence !== null
        && latest?.sequence !== undefined
        && Number(latest.sequence) >= input.sequence
      ) {
        throw new ConflictException({
          code: 'AGENT_OBSERVATION_STALE',
          message: 'Agent observation sequence did not advance',
        });
      }

      await transaction
        .insertInto('workflow.agent_observations')
        .values({
          server_id: input.serverId,
          session_id: input.sessionId,
          sequence: input.sequence,
          kind: input.kind,
          payload_hash: payloadHash,
          payload_json: JSON.stringify(payload),
        })
        .executeTakeFirstOrThrow();
      if (input.kind === 'hello') {
        await transaction
          .insertInto('workflow.agent_runtime_projections')
          .values({
            server_id: input.serverId,
            session_id: input.sessionId,
            session_generation: sessionGeneration,
            gateway_id: gatewayId,
            state_sequence: 0,
            runtime_ready: false,
            hello_json: JSON.stringify(payload),
            state_report_json: null,
            docker_daemon_json: null,
            hello_observed_at: now,
            state_observed_at: null,
          })
          .onConflict((conflict) => conflict.column('server_id').doUpdateSet({
            session_id: input.sessionId,
            session_generation: sessionGeneration,
            gateway_id: gatewayId,
            state_sequence: 0,
            runtime_ready: false,
            hello_json: JSON.stringify(payload),
            state_report_json: null,
            docker_daemon_json: null,
            hello_observed_at: now,
            state_observed_at: null,
          }))
          .execute();
      }
      await transaction
        .updateTable('workflow.agent_sessions')
        .set({ last_seen_at: now, lease_expires_at: leaseExpiresAt })
        .where('id', '=', input.sessionId)
        .where('state', 'in', ['admitted', 'ready'])
        .executeTakeFirstOrThrow();
      return {
        accepted: true,
        duplicate: false,
        session: toAgentSession({
          ...session,
          last_seen_at: now,
          lease_expires_at: leaseExpiresAt,
        }),
        payloadHash,
      };
    });
  }

  renewAgentSession(
    input: {
      serverId: string;
      sessionId: string;
      sessionGeneration: number;
      gatewayId: string;
    },
    _now = new Date(),
  ): Promise<boolean> {
    return this.database
      .updateTable('workflow.agent_sessions')
      .set({
        last_seen_at: sql<Date>`clock_timestamp()`,
        lease_expires_at: sql<Date>`
          clock_timestamp() + (${DEFAULT_AGENT_SESSION_LEASE_MS} * interval '1 millisecond')
        `,
      })
      .where('id', '=', input.sessionId)
      .where('server_id', '=', input.serverId)
      .where('generation', '=', String(input.sessionGeneration))
      .where('gateway_id', '=', input.gatewayId)
      .where('state', 'in', ['admitted', 'ready'])
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst()
      .then((result) => Number(result.numUpdatedRows) === 1);
  }

  publishAgentRuntimeProjection(input: {
    serverId: string;
    sessionId: string;
    sessionGeneration: number;
    gatewayId: string;
    sequence: number;
    stateReport: unknown;
    observedAt?: Date;
    runtimeReady?: boolean;
  }): Promise<boolean> {
    const observedAt = input.observedAt ?? new Date();
    return this.transactions.run(async (transaction) => {
      const current = await transaction
        .selectFrom('workflow.agent_sessions')
        .select('id')
        .where('id', '=', input.sessionId)
        .where('server_id', '=', input.serverId)
        .where('generation', '=', String(input.sessionGeneration))
        .where('gateway_id', '=', input.gatewayId)
        .where('state', 'in', ['admitted', 'ready'])
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return false;
      const result = await transaction
        .updateTable('workflow.agent_runtime_projections')
        .set({
          state_sequence: input.sequence,
          runtime_ready: input.runtimeReady ?? true,
          state_report_json: JSON.stringify(jsonValue(input.stateReport)),
          state_observed_at: observedAt,
        })
        .where('server_id', '=', input.serverId)
        .where('session_id', '=', input.sessionId)
        .where('session_generation', '=', String(input.sessionGeneration))
        .where('gateway_id', '=', input.gatewayId)
        .where('state_sequence', '<=', String(input.sequence))
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    });
  }

  publishAgentDockerDaemonProjection(input: {
    serverId: string;
    sessionId: string;
    sessionGeneration: number;
    gatewayId: string;
    status: unknown;
  }): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      const current = await transaction
        .selectFrom('workflow.agent_sessions')
        .select('id')
        .where('id', '=', input.sessionId)
        .where('server_id', '=', input.serverId)
        .where('generation', '=', String(input.sessionGeneration))
        .where('gateway_id', '=', input.gatewayId)
        .where('state', 'in', ['admitted', 'ready'])
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return false;
      const result = await transaction
        .updateTable('workflow.agent_runtime_projections')
        .set({
          docker_daemon_json: JSON.stringify(jsonValue(input.status)),
        })
        .where('server_id', '=', input.serverId)
        .where('session_id', '=', input.sessionId)
        .where('session_generation', '=', String(input.sessionGeneration))
        .where('gateway_id', '=', input.gatewayId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    });
  }

  registerExecSession(
    input: {
      id: string;
      serverId: string;
      userId: string;
      containerId: string;
      runtimeId: string;
      authorizationKind: 'container-owner' | 'manage-containers-any';
      agentSessionId: string;
      agentSessionGeneration: number;
      gatewayId: string;
    },
    _now = new Date(),
  ): Promise<WorkflowExecSessionRecord> {
    return this.transactions.run(async (transaction) => {
      const now = await this.databaseClock(transaction);
      const expiresAt = new Date(now.getTime() + 60_000);
      await sql`
        select pg_advisory_xact_lock(
          hashtext('nyabase-exec-session-user'),
          hashtext(${input.userId})
        )
      `.execute(transaction);
      await sql`
        select pg_advisory_xact_lock(
          hashtext('nyabase-exec-session-server'),
          hashtext(${input.serverId})
        )
      `.execute(transaction);
      await transaction
        .updateTable('workflow.exec_sessions')
        .set({
          state: 'closed',
          closed_at: now,
          close_reason: 'Exec session admission expired',
        })
        .where('state', 'in', ['unclaimed', 'claimed'])
        .where('expires_at', '<=', sql<Date>`clock_timestamp()`)
        .execute();
      await this.assertExactAgentSession(transaction, {
        serverId: input.serverId,
        id: input.agentSessionId,
        generation: input.agentSessionGeneration,
        gatewayId: input.gatewayId,
      }, ['ready']);
      const counts = await transaction
        .selectFrom('workflow.exec_sessions')
        .select(({ fn }) => [
          fn.countAll<string>().filterWhere('state', 'in', ['unclaimed', 'claimed']).as('global'),
          fn.countAll<string>()
            .filterWhere('state', 'in', ['unclaimed', 'claimed'])
            .filterWhere('user_id', '=', input.userId)
            .as('user'),
          fn.countAll<string>()
            .filterWhere('state', 'in', ['unclaimed', 'claimed'])
            .filterWhere('server_id', '=', input.serverId)
            .as('server'),
        ])
        .where('expires_at', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirstOrThrow();
      if (Number(counts.global) >= 64
        || Number(counts.user) >= 8
        || Number(counts.server) >= 16) {
        throw new ConflictException({
          code: 'EXEC_SESSION_CAPACITY_REACHED',
          message: 'Durable exec session capacity reached',
        });
      }
      const row = await transaction
        .insertInto('workflow.exec_sessions')
        .values({
          id: input.id,
          server_id: input.serverId,
          user_id: input.userId,
          container_id: input.containerId,
          runtime_id: input.runtimeId,
          authorization_kind: input.authorizationKind,
          agent_session_id: input.agentSessionId,
          agent_session_generation: input.agentSessionGeneration,
          gateway_id: input.gatewayId,
          console_public_url: '',
          state: 'unclaimed',
          claimed_by_gateway_id: null,
          last_activity_at: now,
          expires_at: expiresAt,
          closed_at: null,
          close_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toExecSession(row);
    });
  }

  createExecSessionIntentInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    input: {
      id: string;
      serverId: string;
      userId: string;
      containerId: string;
      runtimeId: string;
      authorizationKind: 'container-owner' | 'manage-containers-any';
    },
  ): Promise<WorkflowExecSessionRecord> {
    return (async () => {
      const now = await this.databaseClock(transaction);
      await sql`
        select pg_advisory_xact_lock(
          hashtext('nyabase-exec-session-user'),
          hashtext(${input.userId})
        )
      `.execute(transaction);
      await sql`
        select pg_advisory_xact_lock(
          hashtext('nyabase-exec-session-server'),
          hashtext(${input.serverId})
        )
      `.execute(transaction);
      const owner = await transaction
        .selectFrom('workflow.agent_sessions')
        .select(['id', 'generation', 'gateway_id', 'console_public_url'])
        .where('server_id', '=', input.serverId)
        .where('state', '=', 'ready')
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (!owner) {
        throw new ConflictException({
          code: 'AGENT_SESSION_STALE',
          message: 'No exact ready Agent generation can own the exec intent',
        });
      }
      await transaction
        .updateTable('workflow.exec_sessions')
        .set({
          state: 'closed',
          closed_at: now,
          close_reason: 'Exec session admission expired',
        })
        .where('state', 'in', ['unclaimed', 'claimed'])
        .where('expires_at', '<=', sql<Date>`clock_timestamp()`)
        .execute();
      const active = await transaction
        .selectFrom('workflow.exec_sessions')
        .select(['user_id', 'server_id'])
        .where('state', 'in', ['unclaimed', 'claimed'])
        .where('expires_at', '>', sql<Date>`clock_timestamp()`)
        .execute();
      if (
        active.length >= 64
        || active.filter((row) => row.user_id === input.userId).length >= 8
        || active.filter((row) => row.server_id === input.serverId).length >= 16
      ) {
        throw new ConflictException({
          code: 'EXEC_SESSION_CAPACITY_REACHED',
          message: 'Durable exec session capacity reached',
        });
      }
      const row = await transaction
        .insertInto('workflow.exec_sessions')
        .values({
          id: input.id,
          server_id: input.serverId,
          user_id: input.userId,
          container_id: input.containerId,
          runtime_id: input.runtimeId,
          authorization_kind: input.authorizationKind,
          agent_session_id: owner.id,
          agent_session_generation: owner.generation,
          gateway_id: owner.gateway_id,
          console_public_url: owner.console_public_url,
          state: 'unclaimed',
          claimed_by_gateway_id: null,
          last_activity_at: now,
          expires_at: new Date(now.getTime() + 60_000),
          closed_at: null,
          close_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toExecSession(row);
    })();
  }

  findExecSessionForAgent(
    sessionId: string,
    input: {
      serverId: string;
      agentSessionId: string;
      agentSessionGeneration: number;
      gatewayId: string;
    },
  ): Promise<WorkflowExecSessionRecord | null> {
    return this.database
      .selectFrom('workflow.exec_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('server_id', '=', input.serverId)
      .where('agent_session_id', '=', input.agentSessionId)
      .where(
        'agent_session_generation',
        '=',
        String(input.agentSessionGeneration),
      )
      .where('gateway_id', '=', input.gatewayId)
      .where('state', '=', 'unclaimed')
      .where('expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst()
      .then((row) => row ? toExecSession(row) : null);
  }

  claimExecSession(
    sessionId: string,
    userId: string,
    consoleGatewayId: string,
    agentGatewayId: string,
    _now = new Date(),
  ): Promise<WorkflowExecSessionRecord | null> {
    return this.transactions.run(async (transaction) => {
      const now = await this.databaseClock(transaction);
      const row = await transaction
        .updateTable('workflow.exec_sessions')
        .set({
          state: 'claimed',
          claimed_by_gateway_id: consoleGatewayId,
          last_activity_at: now,
          expires_at: new Date(now.getTime() + 30 * 60_000),
        })
        .where('id', '=', sessionId)
        .where('user_id', '=', userId)
        .where('gateway_id', '=', agentGatewayId)
        .where('state', '=', 'unclaimed')
        .where('expires_at', '>', sql<Date>`clock_timestamp()`)
        .where((expression) => expression.exists(
          expression.selectFrom('workflow.agent_sessions as session')
            .select('session.id')
            .whereRef('session.id', '=', 'workflow.exec_sessions.agent_session_id')
            .whereRef(
              'session.generation',
              '=',
              'workflow.exec_sessions.agent_session_generation',
            )
            .whereRef('session.gateway_id', '=', 'workflow.exec_sessions.gateway_id')
            .where('session.state', '=', 'ready')
            .where('session.lease_expires_at', '>', sql<Date>`clock_timestamp()`),
        ))
        .returningAll()
        .executeTakeFirst();
      return row ? toExecSession(row) : null;
    });
  }

  touchExecSession(
    sessionId: string,
    consoleGatewayId: string,
    _now = new Date(),
  ): Promise<boolean> {
    return this.database
      .updateTable('workflow.exec_sessions')
      .set({
        last_activity_at: sql<Date>`clock_timestamp()`,
        expires_at: sql<Date>`
          clock_timestamp() + interval '30 minutes'
        `,
      })
      .where('id', '=', sessionId)
      .where('state', '=', 'claimed')
      .where('claimed_by_gateway_id', '=', consoleGatewayId)
      .where('expires_at', '>', sql<Date>`clock_timestamp()`)
      .where((expression) => expression.exists(
        expression.selectFrom('workflow.agent_sessions as session')
          .select('session.id')
          .whereRef('session.id', '=', 'workflow.exec_sessions.agent_session_id')
          .whereRef(
            'session.generation',
            '=',
            'workflow.exec_sessions.agent_session_generation',
          )
          .whereRef('session.gateway_id', '=', 'workflow.exec_sessions.gateway_id')
          .where('session.state', '=', 'ready')
          .where('session.lease_expires_at', '>', sql<Date>`clock_timestamp()`),
      ))
      .executeTakeFirst()
      .then((result) => Number(result.numUpdatedRows) === 1);
  }

  closeExecSession(
    sessionId: string,
    reason: string,
    _now = new Date(),
  ): Promise<boolean> {
    return this.database
      .updateTable('workflow.exec_sessions')
      .set({
        state: 'closed',
        closed_at: sql<Date>`clock_timestamp()`,
        close_reason: boundedDiagnostic(reason),
      })
      .where('id', '=', sessionId)
      .where('state', 'in', ['unclaimed', 'claimed'])
      .executeTakeFirst()
      .then((result) => Number(result.numUpdatedRows) === 1);
  }

  acceptExecLogChunk(
    sessionId: string,
    input: {
      serverId: string;
      agentSessionId: string;
      agentSessionGeneration: number;
      gatewayId: string;
    },
  ): Promise<boolean> {
    return this.database
      .updateTable('workflow.exec_sessions')
      .set({
        last_activity_at: sql<Date>`clock_timestamp()`,
        expires_at: sql<Date>`clock_timestamp() + interval '30 minutes'`,
      })
      .where('id', '=', sessionId)
      .where('server_id', '=', input.serverId)
      .where('agent_session_id', '=', input.agentSessionId)
      .where(
        'agent_session_generation',
        '=',
        String(input.agentSessionGeneration),
      )
      .where('gateway_id', '=', input.gatewayId)
      .where('state', 'in', ['unclaimed', 'claimed'])
      .where('expires_at', '>', sql<Date>`clock_timestamp()`)
      .where((expression) => expression.exists(
        expression.selectFrom('workflow.agent_sessions as session')
          .select('session.id')
          .where('session.id', '=', input.agentSessionId)
          .where('session.server_id', '=', input.serverId)
          .where('session.generation', '=', String(input.agentSessionGeneration))
          .where('session.gateway_id', '=', input.gatewayId)
          .where('session.state', '=', 'ready')
          .where('session.lease_expires_at', '>', sql<Date>`clock_timestamp()`),
      ))
      .executeTakeFirst()
      .then((result) => Number(result.numUpdatedRows) === 1);
  }

  /**
   * Claims one due physical task while holding the durable per-server lane.
   * SKIP LOCKED prevents a slow Server from blocking unrelated Server workers.
   */
  claimNextDispatch(
    serverId: string,
    workerId: string,
    options: {
      now?: Date;
      leaseMs?: number;
      allowedKinds?: readonly AgentTaskKind[];
      agentSession?: {
        id: string;
        generation: number;
        gatewayId: string;
      };
    } = {},
  ): Promise<DispatchClaim | null> {
    if (options.allowedKinds?.length === 0) return Promise.resolve(null);
    const agentSession = options.agentSession;
    if (!agentSession) return Promise.resolve(null);
    return this.transactions.run(async (transaction) => {
      const now = options.now ?? await this.databaseClock(transaction);
      const leaseExpiresAt = new Date(
        now.getTime() + (options.leaseMs ?? DEFAULT_DISPATCH_LEASE_MS),
      );
      await this.lockAgentSessionFence(transaction, serverId);
      const currentSession = await transaction
        .selectFrom('workflow.agent_sessions')
        .select(['id', 'generation', 'gateway_id'])
        .where('id', '=', agentSession.id)
        .where('server_id', '=', serverId)
        .where('generation', '=', String(agentSession.generation))
        .where('gateway_id', '=', agentSession.gatewayId)
        .where('state', '=', 'ready')
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!currentSession) return null;
      const server = await transaction
        .selectFrom('infra.servers')
        .select(['id', 'status'])
        .where('id', '=', serverId)
        .executeTakeFirst();
      if (!server || server.status !== ServerStatus.Online) return null;

      await transaction
        .insertInto('workflow.server_execution_lanes')
        .values({
          server_id: serverId,
          generation: 0,
          task_id: null,
          task_generation: null,
          claim_token: null,
          claimed_by: null,
          lease_expires_at: null,
        })
        .onConflict((conflict) => conflict.column('server_id').doNothing())
        .execute();
      const lane = await transaction
        .selectFrom('workflow.server_execution_lanes')
        .selectAll()
        .where('server_id', '=', serverId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        lane.task_id
        && lane.lease_expires_at
        && asDate(lane.lease_expires_at).getTime() > now.getTime()
      ) return null;

      if (lane.task_id && lane.claim_token) {
        await transaction
          .updateTable('workflow.task_attempts')
          .set({
            state: 'abandoned',
            finished_at: sql<Date>`clock_timestamp()`,
            diagnostic_json: JSON.stringify({
              code: 'DISPATCH_LEASE_EXPIRED',
              message: 'Worker claim expired before terminal Agent evidence',
            }),
          })
          .where('task_id', '=', lane.task_id)
          .where('claim_token', '=', lane.claim_token)
          .where('state', 'in', ['claimed', 'sent'])
          .execute();
        await transaction
          .updateTable('workflow.tasks')
          .set({
            dispatch_claim_token: null,
            dispatch_claimed_by: null,
            dispatch_lease_expires_at: null,
          })
          .where('id', '=', lane.task_id)
          .where('dispatch_claim_token', '=', lane.claim_token)
          .execute();
      }

      let taskQuery = transaction
        .selectFrom('workflow.tasks')
        .selectAll()
        .where('server_id', '=', serverId)
        .where('status', '=', AgentTaskStatus.Pending)
        .where('agent_result_json', 'is', null)
        .where('dispatch_claim_token', 'is', null);
      if (options.allowedKinds) {
        taskQuery = taskQuery.where('kind', 'in', [...options.allowedKinds]);
      }
      const task = await taskQuery
        .where((expression) => expression.or([
          expression('next_dispatch_at', 'is', null),
          expression('next_dispatch_at', '<=', now),
        ]))
        .orderBy(sql`case admission_class
          when 'safety' then 0
          when 'reconciliation' then 1
          else 2 end`)
        .orderBy('created_at')
        .orderBy('id')
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!task) {
        await this.clearLane(transaction, serverId);
        return null;
      }

      const claimToken = randomUUID();
      const generation = Number(task.generation);
      const attemptNo = task.dispatch_attempt_count + 1;
      await transaction
        .updateTable('workflow.tasks')
        .set({
          dispatch_claim_token: claimToken,
          dispatch_claimed_by: workerId,
          dispatch_lease_expires_at: leaseExpiresAt,
          next_dispatch_at: null,
          dispatch_attempt_count: attemptNo,
          failure_stage: null,
          error_json: null,
        })
        .where('id', '=', task.id)
        .where('generation', '=', String(generation))
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('workflow.task_attempts')
        .values({
          task_id: task.id,
          task_generation: generation,
          attempt_no: attemptNo,
          claim_token: claimToken,
          claimed_by: workerId,
          state: 'claimed',
          sent_at: null,
          finished_at: null,
          diagnostic_json: null,
          agent_session_id: currentSession.id,
          agent_session_generation: currentSession.generation,
          gateway_id: currentSession.gateway_id,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('workflow.server_execution_lanes')
        .set({
          generation: sql`generation + 1`,
          task_id: task.id,
          task_generation: generation,
          claim_token: claimToken,
          claimed_by: workerId,
          lease_expires_at: leaseExpiresAt,
        })
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow();
      const claimed = await transaction
        .selectFrom('workflow.tasks')
        .selectAll()
        .where('id', '=', task.id)
        .executeTakeFirstOrThrow();
      return {
        task: toTask(claimed),
        claimToken,
        generation,
        leaseExpiresAt,
        agentSessionId: currentSession.id,
        agentSessionGeneration: Number(currentSession.generation),
        gatewayId: currentSession.gateway_id,
      };
    });
  }

  markDispatchSent(
    taskId: string,
    claimToken: string,
    agentSession?: {
      id: string;
      generation: number;
      gatewayId: string;
    },
    sentAt?: Date,
  ): Promise<boolean> {
    if (!agentSession) return Promise.resolve(false);
    return this.transactions.run(async (transaction) => {
      const effectiveSentAt = sentAt ?? await this.databaseClock(transaction);
      const attempt = await transaction
        .selectFrom('workflow.task_attempts as attempt')
        .innerJoin(
          'workflow.agent_sessions as session',
          'session.id',
          'attempt.agent_session_id',
        )
        .select('attempt.id')
        .where('attempt.task_id', '=', taskId)
        .where('attempt.claim_token', '=', claimToken)
        .where('attempt.agent_session_id', '=', agentSession.id)
        .where('attempt.agent_session_generation', '=', String(agentSession.generation))
        .where('attempt.gateway_id', '=', agentSession.gatewayId)
        .where('attempt.state', '=', 'claimed')
        .where('session.generation', '=', String(agentSession.generation))
        .where('session.gateway_id', '=', agentSession.gatewayId)
        .where('session.state', '=', 'ready')
        .where('session.lease_expires_at', '>', effectiveSentAt)
        .forUpdate('attempt')
        .forUpdate('session')
        .executeTakeFirst();
      if (!attempt) return false;
      const taskUpdate = await transaction
        .updateTable('workflow.tasks')
        .set({
          started_at: sql<Date>`coalesce(started_at, ${effectiveSentAt})`,
          retry_window_started_at:
            sql<Date>`coalesce(retry_window_started_at, ${effectiveSentAt})`,
          last_sent_at: effectiveSentAt,
          dispatch_lease_expires_at: new Date(
            effectiveSentAt.getTime() + DEFAULT_DISPATCH_LEASE_MS,
          ),
        })
        .where('id', '=', taskId)
        .where('dispatch_claim_token', '=', claimToken)
        .where('status', '=', AgentTaskStatus.Pending)
        .where('agent_result_json', 'is', null)
        .executeTakeFirst();
      if (Number(taskUpdate.numUpdatedRows) !== 1) return false;
      await transaction
        .updateTable('workflow.task_attempts')
        .set({ state: 'sent', sent_at: effectiveSentAt })
        .where('task_id', '=', taskId)
        .where('claim_token', '=', claimToken)
        .where('state', '=', 'claimed')
        .execute();
      return true;
    });
  }

  markDispatchSentAndSend(
    taskId: string,
    claimToken: string,
    agentSession: {
      serverId: string;
      id: string;
      generation: number;
      gatewayId: string;
    },
    send: () => boolean,
  ): Promise<boolean> {
    return this.runWithAgentSessionSendFence(agentSession, async (connection) => {
      // Capture only after the session-level lock has been acquired. A claim
      // that waited past the Agent lease must never be marked or enqueued.
      const sentAt = await this.databaseClock(connection);
      const marked = await connection.transaction().execute(async (transaction) => {
        const attempt = await transaction
          .selectFrom('workflow.task_attempts as attempt')
          .innerJoin(
            'workflow.agent_sessions as session',
            'session.id',
            'attempt.agent_session_id',
          )
          .select('attempt.id')
          .where('attempt.task_id', '=', taskId)
          .where('attempt.claim_token', '=', claimToken)
          .where('attempt.agent_session_id', '=', agentSession.id)
          .where('attempt.agent_session_generation', '=', String(agentSession.generation))
          .where('attempt.gateway_id', '=', agentSession.gatewayId)
          .where('attempt.state', '=', 'claimed')
          .where('session.server_id', '=', agentSession.serverId)
          .where('session.generation', '=', String(agentSession.generation))
          .where('session.gateway_id', '=', agentSession.gatewayId)
          .where('session.state', '=', 'ready')
          .where('session.lease_expires_at', '>', sentAt)
          .forUpdate('attempt')
          .forUpdate('session')
          .executeTakeFirst();
        if (!attempt) return false;
        const task = await transaction
          .updateTable('workflow.tasks')
          .set({
            started_at: sql<Date>`coalesce(started_at, ${sentAt})`,
            retry_window_started_at:
              sql<Date>`coalesce(retry_window_started_at, ${sentAt})`,
            last_sent_at: sentAt,
            dispatch_lease_expires_at: new Date(
              sentAt.getTime() + DEFAULT_DISPATCH_LEASE_MS,
            ),
          })
          .where('id', '=', taskId)
          .where('dispatch_claim_token', '=', claimToken)
          .where('status', '=', AgentTaskStatus.Pending)
          .where('agent_result_json', 'is', null)
          .executeTakeFirst();
        if (Number(task.numUpdatedRows) !== 1) return false;
        await transaction
          .updateTable('workflow.task_attempts')
          .set({ state: 'sent', sent_at: sentAt })
          .where('task_id', '=', taskId)
          .where('claim_token', '=', claimToken)
          .where('state', '=', 'claimed')
          .executeTakeFirstOrThrow();
        return true;
      });
      return marked && send();
    }).then((result) => result ?? false);
  }

  runWithAgentSessionSendFence<T>(
    input: {
      serverId: string;
      id: string;
      generation: number;
      gatewayId: string;
    },
    work: (connection: Kysely<NyabaseDatabase>) => Promise<T> | T,
  ): Promise<T | null> {
    return this.withAgentSessionAdvisoryLock(input.serverId, async (connection) => {
      if (!await this.hasExactAgentSession(connection, input, ['ready'])) return null;
      return work(connection);
    });
  }

  runWithExecSessionSendFence<T>(
    input: {
      sessionId: string;
      consoleGatewayId: string;
      serverId: string;
      agentSessionId: string;
      agentSessionGeneration: number;
      agentGatewayId: string;
    },
    work: () => Promise<T> | T,
  ): Promise<T | null> {
    return this.withAgentSessionAdvisoryLock(input.serverId, async (connection) => {
      const exact = await connection
        .selectFrom('workflow.exec_sessions as exec')
        .innerJoin(
          'workflow.agent_sessions as session',
          'session.id',
          'exec.agent_session_id',
        )
        .select('exec.id')
        .where('exec.id', '=', input.sessionId)
        .where('exec.server_id', '=', input.serverId)
        .where('exec.agent_session_id', '=', input.agentSessionId)
        .where(
          'exec.agent_session_generation',
          '=',
          String(input.agentSessionGeneration),
        )
        .where('exec.gateway_id', '=', input.agentGatewayId)
        .where('exec.state', '=', 'claimed')
        .where('exec.claimed_by_gateway_id', '=', input.consoleGatewayId)
        .where('exec.expires_at', '>', sql<Date>`clock_timestamp()`)
        .where('session.server_id', '=', input.serverId)
        .where('session.generation', '=', String(input.agentSessionGeneration))
        .where('session.gateway_id', '=', input.agentGatewayId)
        .where('session.state', '=', 'ready')
        .where('session.lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (!exact) return null;
      return work();
    });
  }

  runWithExecSessionOwnerFence<T>(
    input: {
      sessionId: string;
      serverId: string;
      agentSessionId: string;
      agentSessionGeneration: number;
      agentGatewayId: string;
    },
    work: () => Promise<T> | T,
  ): Promise<T | null> {
    return this.withAgentSessionAdvisoryLock(input.serverId, async (connection) => {
      const exact = await connection
        .selectFrom('workflow.exec_sessions as exec')
        .innerJoin(
          'workflow.agent_sessions as session',
          'session.id',
          'exec.agent_session_id',
        )
        .select('exec.id')
        .where('exec.id', '=', input.sessionId)
        .where('exec.server_id', '=', input.serverId)
        .where('exec.agent_session_id', '=', input.agentSessionId)
        .where(
          'exec.agent_session_generation',
          '=',
          String(input.agentSessionGeneration),
        )
        .where('exec.gateway_id', '=', input.agentGatewayId)
        .where('exec.state', 'in', ['unclaimed', 'claimed'])
        .where('exec.expires_at', '>', sql<Date>`clock_timestamp()`)
        .where('session.server_id', '=', input.serverId)
        .where('session.generation', '=', String(input.agentSessionGeneration))
        .where('session.gateway_id', '=', input.agentGatewayId)
        .where('session.state', '=', 'ready')
        .where('session.lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (!exact) return null;
      return work();
    });
  }

  failNeverSentDispatchClaim(
    taskId: string,
    generation: number,
    claimToken: string,
    error: unknown,
    now = new Date(),
  ): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      const task = await transaction
        .selectFrom('workflow.tasks')
        .select(['server_id'])
        .where('id', '=', taskId)
        .where('generation', '=', String(generation))
        .where('dispatch_claim_token', '=', claimToken)
        .where('status', '=', AgentTaskStatus.Pending)
        .where('agent_result_json', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!task) return false;
      const result = await transaction
        .updateTable('workflow.tasks')
        .set({
          status: AgentTaskStatus.Failed,
          failure_stage: 'dispatch',
          error_json: JSON.stringify({
            code: 'DISPATCH_PAYLOAD_INVALID',
            message: errorMessage(error).slice(0, 2048),
          }),
          completed_at: sql<Date>`clock_timestamp()`,
          dispatch_claim_token: null,
          dispatch_claimed_by: null,
          dispatch_lease_expires_at: null,
        })
        .where('id', '=', taskId)
        .where('generation', '=', String(generation))
        .where('dispatch_claim_token', '=', claimToken)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return false;
      await transaction
        .deleteFrom('workflow.resource_claims')
        .where('task_id', '=', taskId)
        .where('task_generation', '=', String(generation))
        .execute();
      await transaction
        .updateTable('workflow.task_attempts')
        .set({
          state: 'abandoned',
          finished_at: sql<Date>`clock_timestamp()`,
          diagnostic_json: JSON.stringify({
            code: 'DISPATCH_PAYLOAD_INVALID',
            message: errorMessage(error).slice(0, 2048),
          }),
        })
        .where('task_id', '=', taskId)
        .where('claim_token', '=', claimToken)
        .where('state', '=', 'claimed')
        .execute();
      await this.clearLane(
        transaction,
        task.server_id,
        taskId,
        claimToken,
      );
      return true;
    });
  }

  /**
   * Stores terminal evidence and releases the physical lane before returning.
   * The caller may ACK only after this promise resolves.
   */
  acceptAgentResult(
    serverId: string,
    result: TaskResultPayload,
    agentSession?: {
      id: string;
      generation: number;
      gatewayId: string;
    },
    now?: Date,
  ): Promise<AcceptedAgentResult> {
    if (!agentSession) {
      return Promise.reject(new ConflictException({
        code: 'AGENT_SESSION_STALE',
        message: 'Task result is missing its exact Agent generation binding',
      }));
    }
    return this.transactions.run(async (transaction) => {
      const effectiveNow = now ?? await this.databaseClock(transaction);
      await this.lockAgentSessionFence(transaction, serverId);
      const currentSession = await transaction
        .selectFrom('workflow.agent_sessions')
        .select('id')
        .where('id', '=', agentSession.id)
        .where('server_id', '=', serverId)
        .where('generation', '=', String(agentSession.generation))
        .where('gateway_id', '=', agentSession.gatewayId)
        .where('state', '=', 'ready')
        .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!currentSession) {
        throw new ConflictException({
          code: 'AGENT_SESSION_STALE',
          message: 'Task result does not belong to the current Agent generation',
        });
      }
      const row = await transaction
        .selectFrom('workflow.tasks')
        .selectAll()
        .where('id', '=', result.taskId)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.server_id !== serverId) {
        throw new ConflictException({
          code: 'TASK_RESULT_UNKNOWN',
          message: 'Task result does not belong to the authenticated Server',
        });
      }
      if (row.payload_hash !== result.payloadHash) {
        throw new ConflictException({
          code: 'TASK_RESULT_CONFLICT',
          message: 'Task result payload hash does not match durable intent',
        });
      }
      if (row.started_at === null) {
        throw new ConflictException({
          code: 'TASK_NOT_DISPATCHED',
          message: 'Agent cannot certify a task that Backend never dispatched',
        });
      }
      const attempt = row.dispatch_claim_token
        ? await transaction
          .selectFrom('workflow.task_attempts')
          .select(['id', 'state'])
          .where('task_id', '=', row.id)
          .where('claim_token', '=', row.dispatch_claim_token)
          .where('agent_session_id', '=', agentSession.id)
          .where('agent_session_generation', '=', String(agentSession.generation))
          .where('gateway_id', '=', agentSession.gatewayId)
          .where('state', 'in', ['claimed', 'sent', 'result_received'])
          .forUpdate()
          .executeTakeFirst()
        : row.agent_result_hash
          ? await transaction
            .selectFrom('workflow.task_attempts')
            .select(['id', 'state'])
            .where('task_id', '=', row.id)
            .where('agent_session_id', '=', agentSession.id)
            .where('agent_session_generation', '=', String(agentSession.generation))
            .where('gateway_id', '=', agentSession.gatewayId)
            .where('state', '=', 'result_received')
            .orderBy('id', 'desc')
            .forUpdate()
            .executeTakeFirst()
          : null;
      if (!attempt) {
        throw new ConflictException({
          code: 'TASK_RESULT_SESSION_MISMATCH',
          message: 'Task result is not bound to this Agent dispatch generation',
        });
      }
      const terminal = result.status !== 'incomplete';
      if (terminal) this.validateTerminalResult(row, result);
      const evidence = agentEvidence(result);
      const evidenceHash = sha256(evidence);
      if (row.agent_result_hash) {
        if (row.agent_result_hash !== evidenceHash) {
          throw new ConflictException({
            code: 'TASK_RESULT_CONFLICT',
            message: 'Task already has different immutable Agent evidence',
          });
        }
        return {
          accepted: true,
          terminal: true,
          taskId: row.id,
          payloadHash: row.payload_hash,
          finalizerPending: row.status === AgentTaskStatus.Pending,
        };
      }
      if (attempt.state === 'result_received') {
        throw new ConflictException({
          code: 'TASK_RESULT_SESSION_MISMATCH',
          message: 'Task result does not belong to an active Agent dispatch attempt',
        });
      }
      if (row.status !== AgentTaskStatus.Pending) {
        throw new ConflictException({
          code: 'TASK_RESULT_CONFLICT',
          message: 'Terminal task has no replayable immutable Agent evidence',
        });
      }

      if (!terminal) {
        if (isUnsafeIncomplete(row, result)) {
          const diagnostic = {
            code: 'AGENT_QUOTA_OUTCOME_UNSAFE',
            message:
              'Agent could not prove the durable quota limit; server is quarantined and the exact task claim is retained',
            cause: result.error,
          };
          await this.failStopTask(
            transaction,
            row,
            diagnostic,
            effectiveNow,
          );
          await this.finishAttempt(
            transaction,
            row.id,
            row.dispatch_claim_token,
            effectiveNow,
            evidence,
          );
          return {
            accepted: true,
            terminal: true,
            taskId: row.id,
            payloadHash: row.payload_hash,
            finalizerPending: false,
            serverQuarantined: true,
          };
        }
        const delayMs = Math.min(
          60_000,
          1_000 * (2 ** Math.min(Math.max(row.dispatch_attempt_count - 1, 0), 6)),
        );
        await transaction
          .updateTable('workflow.tasks')
          .set({
            last_sent_at: null,
            next_dispatch_at: new Date(effectiveNow.getTime() + delayMs),
            incomplete_result_count: row.incomplete_result_count + 1,
            error_json: JSON.stringify(result.error),
            dispatch_claim_token: null,
            dispatch_claimed_by: null,
            dispatch_lease_expires_at: null,
          })
          .where('id', '=', row.id)
          .where('generation', '=', row.generation)
          .executeTakeFirstOrThrow();
        await this.finishAttempt(
          transaction,
          row.id,
          row.dispatch_claim_token,
          effectiveNow,
          evidence,
        );
        await this.clearLane(
          transaction,
          serverId,
          row.id,
          row.dispatch_claim_token,
        );
        await this.insertOutbox(transaction, 'dispatch', serverId, {
          type: 'task.retry_due',
          taskId: row.id,
          serverId,
        }, new Date(effectiveNow.getTime() + delayMs));
        return {
          accepted: false,
          terminal: false,
          taskId: row.id,
          payloadHash: row.payload_hash,
          finalizerPending: false,
        };
      }

      if (isUnsafeTerminalFailure(row, result)) {
        const diagnostic = unsafeTerminalDiagnostic(row, result);
        await this.failStopTask(
          transaction,
          row,
          diagnostic,
          effectiveNow,
          evidence,
          evidenceHash,
        );
        await this.finishAttempt(
          transaction,
          row.id,
          row.dispatch_claim_token,
          effectiveNow,
          evidence,
        );
        return {
          accepted: true,
          terminal: true,
          taskId: row.id,
          payloadHash: row.payload_hash,
          finalizerPending: false,
          serverQuarantined: true,
        };
      }

      await transaction
        .updateTable('workflow.tasks')
        .set({
          agent_result_json: JSON.stringify(evidence),
          agent_result_hash: evidenceHash,
          result_received_at: sql<Date>`clock_timestamp()`,
          finalizer_attempt_count: 0,
          finalizer_retry_at: null,
          failure_stage: null,
          error_json: null,
          dispatch_claim_token: null,
          dispatch_claimed_by: null,
          dispatch_lease_expires_at: null,
        })
        .where('id', '=', row.id)
        .where('generation', '=', row.generation)
        .where('agent_result_json', 'is', null)
        .executeTakeFirstOrThrow();
      await this.finishAttempt(
        transaction,
        row.id,
        row.dispatch_claim_token,
        effectiveNow,
        evidence,
      );
      await this.clearLane(
        transaction,
        serverId,
        row.id,
        row.dispatch_claim_token,
      );
      return {
        accepted: true,
        terminal: true,
        taskId: row.id,
        payloadHash: row.payload_hash,
        finalizerPending: true,
      };
    });
  }

  /**
   * Atomically terminalizes bindable invalid evidence, revokes Server
   * admission, retires the current Agent generation, and retains claims.
   */
  quarantineInvalidAgentResult(
    serverId: string,
    result: Pick<TaskResultPayload, 'taskId' | 'payloadHash'>,
    diagnostic: unknown,
    agentSession: {
      id: string;
      generation: number;
      gatewayId: string;
    },
    now = new Date(),
  ): Promise<string | null> {
    return this.transactions.run(async (transaction) => {
      await this.lockAgentSessionFence(transaction, serverId);
      await this.assertExactAgentSession(
        transaction,
        {
          serverId,
          id: agentSession.id,
          generation: agentSession.generation,
          gatewayId: agentSession.gatewayId,
        },
        ['admitted', 'ready'],
      );
      const server = await transaction
        .selectFrom('infra.servers')
        .select('id')
        .where('id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!server) return null;
      const row = await transaction
        .selectFrom('workflow.tasks')
        .selectAll()
        .where('id', '=', result.taskId)
        .forUpdate()
        .executeTakeFirst();
      const bound = row
        && row.server_id === serverId
        && row.payload_hash === result.payloadHash
        && row.status === AgentTaskStatus.Pending
        && row.agent_result_json === null
        && row.started_at !== null
        ? row
        : null;
      if (bound) {
        await this.failStopTask(
          transaction,
          bound,
          {
            code: 'INVALID_AGENT_RESULT',
            message:
              'Agent returned invalid terminal evidence; Server is quarantined and the exact task claim is retained',
            details: boundedJsonDiagnostic(diagnostic),
          },
          now,
        );
        await this.finishAttempt(
          transaction,
          bound.id,
          bound.dispatch_claim_token,
          now,
          boundedJsonDiagnostic(diagnostic),
        );
      } else {
        await this.quarantineServerAndSessions(
          transaction,
          serverId,
          'Authenticated Agent returned invalid or unbound task evidence',
          now,
        );
      }
      return bound?.id ?? null;
    });
  }

  /** Fail-stop an authenticated Agent protocol violation without guessing task identity. */
  quarantineAgentProtocolFault(
    serverId: string,
    diagnostic: unknown,
    agentSession: {
      id: string;
      generation: number;
      gatewayId: string;
    },
    now = new Date(),
  ): Promise<void> {
    return this.transactions.run(async (transaction) => {
      await this.lockAgentSessionFence(transaction, serverId);
      await this.assertExactAgentSession(
        transaction,
        {
          serverId,
          id: agentSession.id,
          generation: agentSession.generation,
          gatewayId: agentSession.gatewayId,
        },
        ['admitted', 'ready'],
      );
      const server = await transaction
        .selectFrom('infra.servers')
        .select('id')
        .where('id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!server) return;
      await this.quarantineServerAndSessions(
        transaction,
        serverId,
        `Authenticated Agent violated the protocol: ${errorMessage(diagnostic)}`,
        now,
      );
    });
  }

  quarantineAgentInventoryFault(
    input: {
      serverId: string;
      id: string;
      generation: number;
      gatewayId: string;
    },
    message: string,
    options: { preserveExisting?: boolean } = {},
    now = new Date(),
  ): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      await this.lockAgentSessionFence(transaction, input.serverId);
      await this.assertExactAgentSession(
        transaction,
        input,
        ['admitted', 'ready'],
      );
      const current = await transaction
        .selectFrom('infra.servers')
        .select(['id', 'status'])
        .where('id', '=', input.serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return false;
      if (!(options.preserveExisting && current.status === ServerStatus.AgentQuarantined)) {
        await transaction
          .updateTable('infra.servers')
          .set({
            status: ServerStatus.AgentQuarantined,
            quarantine_code: 'AGENT_INVENTORY_FAULT',
            quarantine_message: boundedDiagnostic(message),
            last_seen_at: now,
            revision: sql`revision + 1`,
          })
          .where('id', '=', input.serverId)
          .executeTakeFirstOrThrow();
      }
      await transaction
        .updateTable('workflow.agent_sessions')
        .set({
          state: 'retired',
          retired_at: now,
          retire_reason: boundedDiagnostic(message),
          last_seen_at: now,
        })
        .where('id', '=', input.id)
        .where('server_id', '=', input.serverId)
        .where('generation', '=', String(input.generation))
        .where('gateway_id', '=', input.gatewayId)
        .where('state', 'in', ['admitted', 'ready'])
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('workflow.agent_runtime_projections')
        .set({ runtime_ready: false })
        .where('server_id', '=', input.serverId)
        .where('session_id', '=', input.id)
        .where('session_generation', '=', String(input.generation))
        .where('gateway_id', '=', input.gatewayId)
        .execute();
      return true;
    });
  }

  retryAgentQuarantine(
    serverId: string,
    beforeCommit?: (
      transaction: Transaction<NyabaseDatabase>,
      taskIds: readonly string[],
    ) => Promise<void>,
    now?: Date,
  ): Promise<string[]> {
    return this.transactions.run(async (transaction) => {
      const effectiveNow = now ?? await this.databaseClock(transaction);
      const server = await transaction
        .selectFrom('infra.servers')
        .select(['id', 'status', 'quarantine_code'])
        .where('id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!server) {
        throw new ConflictException({
          code: 'AGENT_SESSION_SERVER_MISSING',
          message: 'Quarantined Server no longer exists',
        });
      }
      if (server.status !== ServerStatus.AgentQuarantined) {
        throw new ConflictException({
          code: 'AGENT_NOT_QUARANTINED',
          message: 'Server has no Agent quarantine to retry',
        });
      }
      if (server.quarantine_code === 'AGENT_INVENTORY_FAULT') {
        const taskIds: string[] = [];
        if (beforeCommit) await beforeCommit(transaction, taskIds);
        await transaction
          .updateTable('infra.servers')
          .set({
            status: ServerStatus.Unknown,
            quarantine_code: null,
            quarantine_message: null,
          })
          .where('id', '=', serverId)
          .where('status', '=', ServerStatus.AgentQuarantined)
          .where('quarantine_code', '=', 'AGENT_INVENTORY_FAULT')
          .executeTakeFirstOrThrow();
        return taskIds;
      }
      if (server.quarantine_code !== 'AGENT_TASK_FAIL_STOP') {
        throw new ConflictException({
          code: 'AGENT_NOT_QUARANTINED',
          message: 'Server has no retryable Agent quarantine',
        });
      }
      const authority = await transaction
        .selectFrom('workflow.resource_claims as claim')
        .innerJoin('workflow.tasks as task', 'task.id', 'claim.task_id')
        .select([
          'task.id',
          'task.command_id',
          'task.generation',
          'task.status',
          'task.failure_stage',
          'task.error_json',
          'task.payload_json',
          'task.payload_hash',
          'task.kind',
          'task.server_id',
          'task.resource_type',
          'task.resource_id',
          'task.requested_by',
          'task.request_json',
          'task.admission_class',
          'task.agent_result_json',
          'task.agent_result_hash',
          'task.result_json',
          'task.dispatch_attempt_count',
          'task.incomplete_result_count',
          'task.finalizer_attempt_count',
          'task.retry_window_started_at',
          'task.next_dispatch_at',
          'task.started_at',
          'task.last_sent_at',
          'task.result_received_at',
          'task.finalizer_retry_at',
          'task.completed_at',
          'task.dispatch_claim_token',
          'task.dispatch_claimed_by',
          'task.dispatch_lease_expires_at',
          'task.finalizer_claim_token',
          'task.finalizer_claimed_by',
          'task.finalizer_lease_expires_at',
          'task.created_at',
          'task.updated_at',
        ])
        .where('claim.server_id', '=', serverId)
        .whereRef('claim.task_generation', '=', 'task.generation')
        .orderBy('task.id')
        .limit(129)
        .forUpdate('task')
        .execute();
      const unique = [...new Map(authority.map((row) => [row.id, row])).values()];
      if (unique.length === 0 || authority.length > 128) {
        throw new ConflictException({
          code: 'AGENT_QUARANTINE_AUTHORITY_INVALID',
          message: authority.length === 0
            ? 'Quarantine has no retained task claim authority'
            : 'Quarantine retry authority exceeds the bounded limit',
        });
      }
      for (const row of unique) {
        if (
          row.server_id !== serverId
          || row.status !== AgentTaskStatus.Failed
          || row.failure_stage !== 'agent'
          || !isRetryableFailStopDiagnostic(row.error_json)
        ) {
          throw new ConflictException({
            code: 'AGENT_QUARANTINE_AUTHORITY_INVALID',
            message: `Retained claim for task ${row.id} is not retryable fail-stop authority`,
          });
        }
        this.validateDurablePayload(row);
      }
      const taskIds = unique.map((row) => row.id).sort();
      if (beforeCommit) await beforeCommit(transaction, taskIds);
      for (const row of unique) {
        await transaction
          .updateTable('workflow.tasks')
          .set({
            status: AgentTaskStatus.Pending,
            admission_class: 'safety',
            failure_stage: null,
            agent_result_json: null,
            agent_result_hash: null,
            result_received_at: null,
            result_json: null,
            error_json: null,
            incomplete_result_count: 0,
            finalizer_attempt_count: 0,
            retry_window_started_at: null,
            next_dispatch_at: null,
            last_sent_at: null,
            finalizer_retry_at: null,
            completed_at: null,
            dispatch_claim_token: null,
            dispatch_claimed_by: null,
            dispatch_lease_expires_at: null,
            finalizer_claim_token: null,
            finalizer_claimed_by: null,
            finalizer_lease_expires_at: null,
          })
          .where('id', '=', row.id)
          .where('generation', '=', row.generation)
          .where('status', '=', AgentTaskStatus.Failed)
          .executeTakeFirstOrThrow();
        await this.insertOutbox(transaction, 'dispatch', serverId, {
          type: 'task.quarantine_retry',
          taskId: row.id,
          serverId,
          generation: Number(row.generation),
        }, effectiveNow);
      }
      await transaction
        .updateTable('infra.servers')
        .set({
          status: ServerStatus.Unknown,
          quarantine_code: null,
          quarantine_message: null,
        })
        .where('id', '=', serverId)
        .where('status', '=', ServerStatus.AgentQuarantined)
        .executeTakeFirstOrThrow();
      return taskIds;
    });
  }

  hasRetainedWorkflowAuthority(serverId: string): Promise<boolean> {
    return this.database
      .selectFrom('workflow.resource_claims')
      .select('resource_key')
      .where('server_id', '=', serverId)
      .limit(1)
      .executeTakeFirst()
      .then(Boolean);
  }

  async enqueueReconcileInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    input: {
      dedupeKey: string;
      serverId?: string | null;
      resourceType: string;
      resourceId: string;
      reason: string;
      payload?: unknown;
      dueAt?: Date;
    },
  ): Promise<string> {
    const dedupeKey = boundedIdentity(input.dedupeKey, 'reconcile dedupe key');
    const resourceType = boundedIdentity(input.resourceType, 'reconcile resource type');
    const resourceId = boundedIdentity(input.resourceId, 'reconcile resource id');
    const reason = boundedDiagnostic(input.reason);
    const payload = jsonValue(input.payload ?? {});
    const dueAt = input.dueAt ?? await this.databaseClock(transaction);
    const existing = await transaction
      .selectFrom('workflow.reconcile_queue')
      .select(['id', 'status'])
      .where('dedupe_key', '=', dedupeKey)
      .forUpdate()
      .executeTakeFirst();
    if (existing) {
      if (existing.status !== 'claimed') {
        await transaction
          .updateTable('workflow.reconcile_queue')
          .set({
            server_id: input.serverId ?? null,
            resource_type: resourceType,
            resource_id: resourceId,
            reason,
            payload_json: JSON.stringify(payload),
            status: 'pending',
            due_at: dueAt,
            claim_token: null,
            claimed_by: null,
            lease_expires_at: null,
            last_error_json: null,
          })
          .where('id', '=', existing.id)
          .executeTakeFirstOrThrow();
      }
      return existing.id;
    }
    const id = randomUUID();
    await transaction
      .insertInto('workflow.reconcile_queue')
      .values({
        id,
        dedupe_key: dedupeKey,
        server_id: input.serverId ?? null,
        resource_type: resourceType,
        resource_id: resourceId,
        reason,
        payload_json: JSON.stringify(payload),
        status: 'pending',
        attempt_count: 0,
        due_at: dueAt,
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
        last_error_json: null,
      })
      .executeTakeFirstOrThrow();
    return id;
  }

  claimReconcile(
    workerId: string,
    limit = 16,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<ReconcileClaim[]> {
    return this.transactions.run(async (transaction) => {
      const now = options.now ?? await this.databaseClock(transaction);
      const leaseExpiresAt = new Date(
        now.getTime() + (options.leaseMs ?? DEFAULT_FINALIZER_LEASE_MS),
      );
      const rows = await transaction
        .selectFrom('workflow.reconcile_queue')
        .selectAll()
        .where((expression) => expression.or([
          expression.and([
            expression('status', 'in', ['pending', 'failed']),
            expression('due_at', '<=', now),
          ]),
          expression.and([
            expression('status', '=', 'claimed'),
            expression('lease_expires_at', '<=', now),
          ]),
        ]))
        .orderBy('due_at')
        .orderBy('id')
        .limit(Math.max(1, Math.min(128, Math.trunc(limit))))
        .forUpdate()
        .skipLocked()
        .execute();
      const claims: ReconcileClaim[] = [];
      for (const row of rows) {
        const claimToken = randomUUID();
        await transaction
          .updateTable('workflow.reconcile_queue')
          .set({
            status: 'claimed',
            attempt_count: row.attempt_count + 1,
            claim_token: claimToken,
            claimed_by: workerId,
            lease_expires_at: leaseExpiresAt,
          })
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        claims.push({
          id: row.id,
          dedupeKey: row.dedupe_key,
          serverId: row.server_id,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          reason: row.reason,
          payload: row.payload_json,
          attemptCount: row.attempt_count + 1,
          claimToken,
        });
      }
      return claims;
    });
  }

  completeReconcile(id: string, claimToken: string): Promise<boolean> {
    return this.database
      .updateTable('workflow.reconcile_queue')
      .set({
        status: 'completed',
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
        last_error_json: null,
      })
      .where('id', '=', id)
      .where('status', '=', 'claimed')
      .where('claim_token', '=', claimToken)
      .executeTakeFirst()
      .then((result) => Number(result.numUpdatedRows) === 1);
  }

  deferReconcile(
    id: string,
    claimToken: string,
    error: unknown,
    dueAt: Date | { afterMs: number },
  ): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      const effectiveDueAt = await this.resolveDatabaseSchedule(transaction, dueAt);
      const result = await transaction
        .updateTable('workflow.reconcile_queue')
        .set({
          status: 'failed',
          due_at: effectiveDueAt,
          claim_token: null,
          claimed_by: null,
          lease_expires_at: null,
          last_error_json: JSON.stringify(boundedJsonDiagnostic(error)),
        })
        .where('id', '=', id)
        .where('status', '=', 'claimed')
        .where('claim_token', '=', claimToken)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    });
  }

  claimFinalizers(
    workerId: string,
    limit = 16,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<FinalizerClaim[]> {
    return this.transactions.run(async (transaction) => {
      const now = options.now ?? await this.databaseClock(transaction);
      const leaseExpiresAt = new Date(
        now.getTime() + (options.leaseMs ?? DEFAULT_FINALIZER_LEASE_MS),
      );
      const rows = await transaction
        .selectFrom('workflow.tasks')
        .selectAll()
        .where('status', '=', AgentTaskStatus.Pending)
        .where('agent_result_json', 'is not', null)
        .where((expression) => expression.or([
          expression('finalizer_retry_at', 'is', null),
          expression('finalizer_retry_at', '<=', now),
        ]))
        .where((expression) => expression.or([
          expression('finalizer_claim_token', 'is', null),
          expression('finalizer_lease_expires_at', '<=', now),
        ]))
        .orderBy('result_received_at')
        .orderBy('id')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      const claims: FinalizerClaim[] = [];
      for (const row of rows) {
        const claimToken = randomUUID();
        await transaction
          .updateTable('workflow.tasks')
          .set({
            finalizer_claim_token: claimToken,
            finalizer_claimed_by: workerId,
            finalizer_lease_expires_at: leaseExpiresAt,
            finalizer_attempt_count: row.finalizer_attempt_count + 1,
          })
          .where('id', '=', row.id)
          .where('generation', '=', row.generation)
          .executeTakeFirstOrThrow();
        claims.push({
          task: toTask({
            ...row,
            finalizer_attempt_count: row.finalizer_attempt_count + 1,
          }),
          claimToken,
          generation: Number(row.generation),
          leaseExpiresAt,
        });
      }
      return claims;
    });
  }

  completeFinalizer(
    taskId: string,
    generation: number,
    claimToken: string,
    outcome: WorkflowFinalizerOutcome,
    now = new Date(),
  ): Promise<boolean> {
    return this.transactions.run((transaction) =>
      this.completeFinalizerInTransaction(
        transaction,
        taskId,
        generation,
        claimToken,
        outcome,
        now,
      ));
  }

  /**
   * Lets a domain finalizer apply its projection and terminalize the task in
   * the same caller-owned PostgreSQL transaction.
   */
  async completeFinalizerInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    taskId: string,
    generation: number,
    claimToken: string,
    outcome: WorkflowFinalizerOutcome,
    now = new Date(),
  ): Promise<boolean> {
    const update = await transaction
        .updateTable('workflow.tasks')
        .set({
          status: outcome.status,
          failure_stage: outcome.failureStage ?? null,
          result_json: json(outcome.result),
          error_json: json(outcome.error),
          completed_at: sql<Date>`clock_timestamp()`,
          finalizer_claim_token: null,
          finalizer_claimed_by: null,
          finalizer_lease_expires_at: null,
          finalizer_retry_at: null,
        })
        .where('id', '=', taskId)
        .where('generation', '=', String(generation))
        .where('finalizer_claim_token', '=', claimToken)
        .where('status', '=', AgentTaskStatus.Pending)
        .where('agent_result_json', 'is not', null)
        .executeTakeFirst();
    if (Number(update.numUpdatedRows) !== 1) return false;
    if (outcome.releaseClaims) {
      await transaction
          .deleteFrom('workflow.resource_claims')
          .where('task_id', '=', taskId)
          .where('task_generation', '=', String(generation))
          .execute();
    }
    return true;
  }

  finalizeClaim<T>(
    claim: FinalizerClaim,
    applyProjection: (
      transaction: Transaction<NyabaseDatabase>,
      task: WorkflowTaskRecord,
    ) => Promise<{ outcome: WorkflowFinalizerOutcome; value: T }>,
  ): Promise<{ applied: boolean; value: T | null }> {
    return this.transactions.run(async (transaction) => {
      const row = await transaction
        .selectFrom('workflow.tasks')
        .selectAll()
        .where('id', '=', claim.task.id)
        .where('generation', '=', String(claim.generation))
        .where('finalizer_claim_token', '=', claim.claimToken)
        .where('status', '=', AgentTaskStatus.Pending)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { applied: false, value: null };
      const task = toTask(row);
      const projected = await applyProjection(transaction, task);
      const applied = await this.completeFinalizerInTransaction(
        transaction,
        task.id,
        claim.generation,
        claim.claimToken,
        projected.outcome,
      );
      if (!applied) {
        throw new ConflictException({
          code: 'FINALIZER_GENERATION_FENCE_LOST',
          message: 'Finalizer claim changed while applying its projection',
        });
      }
      return { applied: true, value: projected.value };
    });
  }

  deferFinalizer(
    taskId: string,
    generation: number,
    claimToken: string,
    error: unknown,
    retryAt: Date | { afterMs: number },
  ): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      const effectiveRetryAt = await this.resolveDatabaseSchedule(transaction, retryAt);
      const result = await transaction
        .updateTable('workflow.tasks')
        .set({
          failure_stage: 'finalizer',
          error_json: json(error),
          finalizer_retry_at: effectiveRetryAt,
          finalizer_claim_token: null,
          finalizer_claimed_by: null,
          finalizer_lease_expires_at: null,
        })
        .where('id', '=', taskId)
        .where('generation', '=', String(generation))
        .where('finalizer_claim_token', '=', claimToken)
        .where('status', '=', AgentTaskStatus.Pending)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    });
  }

  claimOutbox(
    workerId: string,
    limit = 64,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<OutboxClaim[]> {
    return this.transactions.run(async (transaction) => {
      const now = options.now ?? await this.databaseClock(transaction);
      const leaseExpiresAt = new Date(
        now.getTime() + (options.leaseMs ?? DEFAULT_OUTBOX_LEASE_MS),
      );
      const rows = await transaction
        .selectFrom('workflow.outbox')
        .selectAll()
        .where('available_at', '<=', now)
        .where((expression) => expression.or([
          expression('claim_token', 'is', null),
          expression('lease_expires_at', '<=', now),
        ]))
        .orderBy('id')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      const output: OutboxClaim[] = [];
      for (const row of rows) {
        const claimToken = randomUUID();
        await transaction
          .updateTable('workflow.outbox')
          .set({
            claim_token: claimToken,
            claimed_by: workerId,
            lease_expires_at: leaseExpiresAt,
          })
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        output.push({
          id: String(row.id),
          topic: row.topic,
          partitionKey: row.partition_key,
          payload: row.payload_json,
          claimToken,
        });
      }
      return output;
    });
  }

  completeOutboxClaims(
    claims: readonly Pick<OutboxClaim, 'id' | 'claimToken'>[],
  ): Promise<number> {
    if (claims.length === 0) return Promise.resolve(0);
    if (claims.length > 1_000) {
      throw new Error('Outbox completion batch exceeds 1000 claims');
    }
    return this.transactions.run(async (transaction) => {
      const result = await transaction
        .deleteFrom('workflow.outbox')
        .where((expression) => expression.or(
          claims.map((claim) => expression.and([
            expression('id', '=', claim.id),
            expression('claim_token', '=', claim.claimToken),
          ])),
        ))
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    });
  }

  async purgeTerminalRetention(
    retentionMs: number,
    limit = 1_000,
  ): Promise<number> {
    return this.transactions.run(async (transaction) => {
      const now = await this.databaseClock(transaction);
      return this.purgeTerminalBeforeInTransaction(
        transaction,
        new Date(now.getTime() - retentionMs),
        limit,
      );
    });
  }

  /** Test-only deterministic cutoff override; production uses DB time above. */
  purgeTerminalBeforeForTest(cutoff: Date, limit = 1_000): Promise<number> {
    return this.transactions.run((transaction) =>
      this.purgeTerminalBeforeInTransaction(transaction, cutoff, limit));
  }

  private async purgeTerminalBeforeInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    cutoff: Date,
    limit: number,
  ): Promise<number> {
    const ids = await transaction
        .selectFrom('workflow.tasks as task')
        .select(['task.id', 'task.command_id'])
        .where('task.completed_at', '<', cutoff)
        .where((expression) => expression.not(
          expression.exists(
            expression.selectFrom('workflow.resource_claims as claim')
              .select('claim.resource_key')
              .whereRef('claim.task_id', '=', 'task.id'),
          ),
        ))
        .orderBy('task.completed_at')
        .orderBy('task.id')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
    if (ids.length === 0) return 0;
    const result = await transaction
        .deleteFrom('workflow.tasks')
        .where('id', 'in', ids.map((row) => row.id))
        .executeTakeFirst();
    await transaction
        .deleteFrom('workflow.commands')
        .where('id', 'in', ids.map((row) => row.command_id))
        .execute();
    return Number(result.numDeletedRows);
  }

  private async failStopTask(
    transaction: Transaction<NyabaseDatabase>,
    row: Selectable<WorkflowTaskTable>,
    diagnostic: unknown,
    now: Date,
    evidence?: unknown,
    evidenceHash?: string,
  ): Promise<void> {
    await transaction
      .updateTable('workflow.tasks')
      .set({
        status: AgentTaskStatus.Failed,
        failure_stage: 'agent',
        agent_result_json: evidence === undefined ? null : JSON.stringify(evidence),
        agent_result_hash: evidence === undefined ? null : evidenceHash,
        result_received_at: evidence === undefined ? null : now,
        result_json: null,
        error_json: JSON.stringify(boundedJsonDiagnostic(diagnostic)),
        next_dispatch_at: null,
        last_sent_at: null,
        completed_at: sql<Date>`clock_timestamp()`,
        dispatch_claim_token: null,
        dispatch_claimed_by: null,
        dispatch_lease_expires_at: null,
        finalizer_claim_token: null,
        finalizer_claimed_by: null,
        finalizer_lease_expires_at: null,
      })
      .where('id', '=', row.id)
      .where('generation', '=', row.generation)
      .where('status', '=', AgentTaskStatus.Pending)
      .executeTakeFirstOrThrow();
    await this.clearLane(
      transaction,
      row.server_id,
      row.id,
      row.dispatch_claim_token,
    );
    await this.quarantineServerAndSessions(
      transaction,
      row.server_id,
      'Safety-critical Agent task evidence is unsafe; exact claims are retained',
      now,
    );
  }

  private async quarantineServerAndSessions(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    await this.lockAgentSessionFence(transaction, serverId);
    await transaction
      .updateTable('infra.servers')
      .set({
        status: ServerStatus.AgentQuarantined,
        quarantine_code: 'AGENT_TASK_FAIL_STOP',
        quarantine_message: boundedDiagnostic(reason),
      })
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('workflow.agent_sessions')
      .set({
        state: 'retired',
        retired_at: now,
        retire_reason: boundedDiagnostic(reason),
        last_seen_at: now,
      })
      .where('server_id', '=', serverId)
      .where('state', 'in', ['admitted', 'ready'])
      .execute();
  }

  private async finishAttempt(
    transaction: Transaction<NyabaseDatabase>,
    taskId: string,
    claimToken: string | null,
    now: Date,
    evidence: unknown,
  ): Promise<void> {
    if (!claimToken) return;
    await transaction
      .updateTable('workflow.task_attempts')
      .set({
        state: 'result_received',
        finished_at: sql<Date>`clock_timestamp()`,
        diagnostic_json: JSON.stringify(evidence),
      })
      .where('task_id', '=', taskId)
      .where('claim_token', '=', claimToken)
      .where('state', 'in', ['claimed', 'sent'])
      .execute();
  }

  private validateTerminalResult(
    row: Selectable<WorkflowTaskTable>,
    result: Exclude<TaskResultPayload, { status: 'incomplete' }>,
  ): void {
    try {
      const task = this.validateDurablePayload(row);
      const wireCandidate = this.payloadCodec
        ? this.payloadCodec.forWirePayload(task.kind, task.payloadJson)
        : task.payloadJson;
      const wirePayload = validateDurableAgentTaskIdentity(task, wireCandidate);
      validateTerminalAgentResult(task, result, { wirePayload });
    } catch (error) {
      throw new ConflictException({
        code: 'TASK_RESULT_SCHEMA_INVALID',
        message: 'Terminal Agent evidence does not match durable task intent',
        details: errorMessage(error).slice(0, 2048),
      });
    }
  }

  private validateDurablePayload(
    row: Selectable<WorkflowTaskTable>,
  ): AgentTaskRecord {
    const task = toAgentTaskRecord(row);
    try {
      validateDurableAgentTaskRowIdentity(task);
      const storedPayload = task.payloadJson;
      const wireCandidate = this.payloadCodec
        ? this.payloadCodec.forWirePayload(task.kind, storedPayload)
        : storedPayload;
      validateDurableAgentTaskIdentity(task, wireCandidate);
      return task;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ConflictException({
        code: 'TASK_PAYLOAD_IDENTITY_INVALID',
        message: 'Durable task payload does not match immutable task intent',
        details: errorMessage(error).slice(0, 2048),
      });
    }
  }

  private async clearLane(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
    taskId?: string,
    claimToken?: string | null,
  ): Promise<void> {
    let query = transaction
      .updateTable('workflow.server_execution_lanes')
      .set({
        task_id: null,
        task_generation: null,
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
      })
      .where('server_id', '=', serverId);
    if (taskId) query = query.where('task_id', '=', taskId);
    if (claimToken) query = query.where('claim_token', '=', claimToken);
    await query.execute();
  }

  private async lockAgentSessionFence(
    transaction: Transaction<NyabaseDatabase>,
    serverId: string,
  ): Promise<void> {
    await sql`
      select pg_advisory_xact_lock(
        hashtext('nyabase-agent-session'),
        hashtext(${serverId})
      )
    `.execute(transaction);
  }

  /**
   * A bounded, connection-scoped authority bridge. Transaction-scoped
   * takeover/mutation locks use the same key and therefore cannot interleave
   * while independently atomic report work or a synchronous WS enqueue runs.
   */
  private withAgentSessionAdvisoryLock<T>(
    serverId: string,
    work: (connection: Kysely<NyabaseDatabase>) => Promise<T>,
  ): Promise<T> {
    const depth = this.agentSessionLockDepth.get(serverId) ?? 0;
    if (depth >= 32) {
      return Promise.reject(new ConflictException({
        code: 'AGENT_SESSION_FENCE_CAPACITY_REACHED',
        message: 'Agent session fence queue is full',
      }));
    }
    this.agentSessionLockDepth.set(serverId, depth + 1);
    const previous = this.agentSessionLockTails.get(serverId) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const localSlot = new Promise<void>((resolve) => { releaseLocal = resolve; });
    const tail = previous.catch(() => undefined).then(() => localSlot);
    this.agentSessionLockTails.set(serverId, tail);
    return previous.catch(() => undefined).then(() => (
      (this.sessionLocks?.database ?? this.database).connection().execute(async (connection) => {
      let locked = false;
      await sql`set statement_timeout = '5s'`.execute(connection);
      try {
        await sql`
          select pg_advisory_lock(
            hashtext('nyabase-agent-session'),
            hashtext(${serverId})
          )
        `.execute(connection);
        locked = true;
        let rejectAuthority!: (error: Error) => void;
        let authorityFailed = false;
        const authority = new Promise<never>((_resolve, reject) => {
          rejectAuthority = reject;
        });
        const loseAuthority = (reason: string, cause?: unknown) => {
          if (authorityFailed) return;
          authorityFailed = true;
          rejectAuthority(new AgentAuthorityBridgeLostError(reason, { cause }));
        };
        let watchdogInFlight = false;
        const watchdog = setInterval(() => {
          if (watchdogInFlight) return;
          watchdogInFlight = true;
          void sql`select 1`.execute(connection).catch((error) => {
            loseAuthority(
              `Agent authority lock connection was lost for ${serverId}`,
              error,
            );
          }).finally(() => {
            watchdogInFlight = false;
          });
        }, 1_000);
        const deadline = setTimeout(() => {
          loseAuthority(
            `Agent authority bridge exceeded 30 seconds for ${serverId}`,
          );
        }, 30_000);
        try {
          return await Promise.race([work(connection), authority]);
        } catch (error) {
          if (error instanceof AgentAuthorityBridgeLostError) {
            if (this.failStop) this.failStop.terminate(error);
          }
          throw error;
        } finally {
          clearInterval(watchdog);
          clearTimeout(deadline);
        }
      } finally {
        try {
          if (locked) {
            await sql`
              select pg_advisory_unlock(
                hashtext('nyabase-agent-session'),
                hashtext(${serverId})
              )
            `.execute(connection);
          }
        } finally {
          await sql`reset statement_timeout`.execute(connection);
        }
      }
      })
    )).finally(() => {
      releaseLocal();
      const remaining = (this.agentSessionLockDepth.get(serverId) ?? 1) - 1;
      if (remaining <= 0) this.agentSessionLockDepth.delete(serverId);
      else this.agentSessionLockDepth.set(serverId, remaining);
      if (this.agentSessionLockTails.get(serverId) === tail) {
        this.agentSessionLockTails.delete(serverId);
      }
    });
  }

  private hasExactAgentSession(
    executor: Kysely<NyabaseDatabase>,
    input: {
      serverId: string;
      id: string;
      generation: number;
      gatewayId: string;
    },
    states: WorkflowAgentSessionState[],
  ): Promise<boolean> {
    return executor
      .selectFrom('workflow.agent_sessions')
      .select('id')
      .where('id', '=', input.id)
      .where('server_id', '=', input.serverId)
      .where('generation', '=', String(input.generation))
      .where('gateway_id', '=', input.gatewayId)
      .where('state', 'in', states)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst()
      .then(Boolean);
  }

  private async assertExactAgentSession(
    executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>,
    input: {
      serverId: string;
      id: string;
      generation: number;
      gatewayId: string;
    },
    states: WorkflowAgentSessionState[],
  ): Promise<void> {
    const current = await executor
      .selectFrom('workflow.agent_sessions')
      .select('id')
      .where('id', '=', input.id)
      .where('server_id', '=', input.serverId)
      .where('generation', '=', String(input.generation))
      .where('gateway_id', '=', input.gatewayId)
      .where('state', 'in', states)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    if (!current) throw staleAgentSessionError();
  }

  currentDatabaseTime(
    executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase> = this.database,
  ): Promise<Date> {
    return sql<{ now: Date }>`select clock_timestamp() as now`
      .execute(executor)
      .then((result) => asDate(result.rows[0]!.now));
  }

  private databaseClock(
    executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>,
  ): Promise<Date> {
    return this.currentDatabaseTime(executor);
  }

  private async resolveDatabaseSchedule(
    executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>,
    schedule: Date | { afterMs: number },
  ): Promise<Date> {
    if (schedule instanceof Date) return schedule;
    const now = await this.databaseClock(executor);
    const delayMs = Math.max(0, Math.min(86_400_000, Math.trunc(schedule.afterMs)));
    return new Date(now.getTime() + delayMs);
  }

  private async insertOutbox(
    transaction: Transaction<NyabaseDatabase>,
    topic: string,
    partitionKey: string,
    payload: unknown,
    availableAt?: Date,
  ): Promise<void> {
    const effectiveAvailableAt =
      availableAt ?? await this.databaseClock(transaction);
    await transaction
      .insertInto('workflow.outbox')
      .values({
        topic,
        partition_key: partitionKey,
        payload_json: JSON.stringify(payload),
        available_at: effectiveAvailableAt,
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
      })
      .executeTakeFirstOrThrow();
  }
}

function toTask(row: Selectable<WorkflowTaskTable>): WorkflowTaskRecord {
  return {
    id: row.id,
    commandId: row.command_id,
    kind: row.kind,
    serverId: row.server_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestedBy: row.requested_by,
    request: row.request_json,
    payload: row.payload_json,
    payloadHash: row.payload_hash,
    admissionClass: row.admission_class as WorkflowTaskRecord['admissionClass'],
    status: row.status as AgentTaskStatus,
    failureStage: row.failure_stage as WorkflowTaskRecord['failureStage'],
    generation: Number(row.generation),
    agentResult: row.agent_result_json,
    result: row.result_json,
    error: row.error_json,
    dispatchAttemptCount: row.dispatch_attempt_count,
    incompleteResultCount: row.incomplete_result_count,
    finalizerAttemptCount: row.finalizer_attempt_count,
    createdAt: asDate(row.created_at),
    startedAt: nullableDate(row.started_at),
    lastSentAt: nullableDate(row.last_sent_at),
    completedAt: nullableDate(row.completed_at),
  };
}

function toAgentSession(
  row: Selectable<WorkflowAgentSessionTable>,
): WorkflowAgentSessionRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    generation: Number(row.generation),
    state: row.state as WorkflowAgentSessionState,
    hostFingerprint: row.host_fingerprint,
    configFingerprint: row.config_fingerprint,
    admittedAt: asDate(row.admitted_at),
    readyAt: nullableDate(row.ready_at),
    lastSeenAt: asDate(row.last_seen_at),
    retiredAt: nullableDate(row.retired_at),
    retireReason: row.retire_reason,
    gatewayId: row.gateway_id,
    consolePublicUrl: row.console_public_url,
    leaseExpiresAt: asDate(row.lease_expires_at),
  };
}

function toExecSession(
  row: Selectable<WorkflowExecSessionTable>,
): WorkflowExecSessionRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    userId: row.user_id,
    containerId: row.container_id,
    runtimeId: row.runtime_id,
    authorizationKind:
      row.authorization_kind as WorkflowExecSessionRecord['authorizationKind'],
    agentSessionId: row.agent_session_id,
    agentSessionGeneration: Number(row.agent_session_generation),
    gatewayId: row.gateway_id,
    consolePublicUrl: row.console_public_url,
    state: row.state as WorkflowExecSessionRecord['state'],
    claimedByGatewayId: row.claimed_by_gateway_id,
    createdAt: asDate(row.created_at),
    expiresAt: asDate(row.expires_at),
  };
}

function toAgentTaskRecord(
  row: Selectable<WorkflowTaskTable>,
): AgentTaskRecord {
  return {
    id: row.id,
    kind: row.kind as AgentTaskKind,
    serverId: row.server_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestedBy: row.requested_by,
    requestJson: row.request_json,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    admissionClass: row.admission_class as AgentTaskRecord['admissionClass'],
    status: row.status as AgentTaskStatus,
    failureStage: row.failure_stage as AgentTaskRecord['failureStage'],
    agentResultJson: row.agent_result_json,
    dispatchAttemptCount: row.dispatch_attempt_count,
    incompleteResultCount: row.incomplete_result_count,
    retryWindowStartedAt: nullableDate(row.retry_window_started_at),
    nextDispatchAt: nullableDate(row.next_dispatch_at),
    finalizerAttemptCount: row.finalizer_attempt_count,
    finalizerRetryAt: nullableDate(row.finalizer_retry_at),
    resultJson: row.result_json,
    errorJson: row.error_json,
    createdAt: asDate(row.created_at),
    startedAt: nullableDate(row.started_at),
    lastSentAt: nullableDate(row.last_sent_at),
    completedAt: nullableDate(row.completed_at),
  };
}

function agentEvidence(result: TaskResultPayload): unknown {
  const value = jsonValue(result) as Record<string, unknown>;
  delete value.taskId;
  delete value.payloadHash;
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(jsonValue(value));
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, jsonValue(entry)]),
  );
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : asDate(value);
}

function staleAgentSessionError(): ConflictException {
  return new ConflictException({
    code: 'AGENT_SESSION_STALE',
    message: 'Agent work does not belong to the current Gateway generation',
  });
}

class AgentAuthorityBridgeLostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentAuthorityBridgeLostError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 2_048) {
    throw new ConflictException({
      code: 'AGENT_SESSION_IDENTITY_INVALID',
      message: `Agent ${label} must contain 1 to 2048 characters`,
    });
  }
  return normalized;
}

function boundedDiagnostic(value: string): string {
  const normalized = value.trim() || 'Agent session retired';
  return normalized.slice(0, 2_048);
}

function isUnsafeIncomplete(
  row: Selectable<WorkflowTaskTable>,
  result: Extract<TaskResultPayload, { status: 'incomplete' }>,
): boolean {
  return row.kind === AgentTaskKind.QuotaEnsure
    || UNSAFE_SHARED_QUOTA_INCOMPLETE_CODES.has(result.error.code);
}

function isUnsafeTerminalFailure(
  row: Selectable<WorkflowTaskTable>,
  result: Exclude<TaskResultPayload, { status: 'incomplete' }>,
): result is Extract<TaskResultPayload, { status: 'failed' }> {
  if (result.status !== 'failed') return false;
  const unsafeQuota = row.kind === AgentTaskKind.QuotaEnsure
    || UNSAFE_SHARED_QUOTA_FAILURE_CODES.has(result.error.code);
  const unsafeSafety = row.admission_class === 'safety'
    && row.kind !== AgentTaskKind.ContainerRuntimeAbsent;
  const safeStopCoordination = row.kind === AgentTaskKind.ContainerStop
    && SAFE_STOP_COORDINATION_FAILURE_CODES.has(result.error.code);
  return row.kind === AgentTaskKind.ContainerRuntimeAbsent
    || unsafeQuota
    || (unsafeSafety && !safeStopCoordination);
}

function unsafeTerminalDiagnostic(
  row: Selectable<WorkflowTaskTable>,
  result: Extract<TaskResultPayload, { status: 'failed' }>,
): unknown {
  const unsafeQuota = row.kind === AgentTaskKind.QuotaEnsure
    || UNSAFE_SHARED_QUOTA_FAILURE_CODES.has(result.error.code);
  if (unsafeQuota) {
    return {
      code: 'AGENT_QUOTA_OUTCOME_UNSAFE',
      message:
        'Agent could not prove the durable quota limit; Server is quarantined and the exact task claim is retained',
      cause: result.error,
    };
  }
  if (
    row.admission_class === 'safety'
    && row.kind !== AgentTaskKind.ContainerRuntimeAbsent
  ) {
    return {
      code: 'AGENT_SAFETY_OUTCOME_UNSAFE',
      message:
        'Agent could not converge a safety intent; Server is quarantined and the exact task claim is retained',
      cause: result.error,
    };
  }
  return result.error;
}

function boundedJsonDiagnostic(value: unknown): unknown {
  const normalized = jsonValue(value);
  const encoded = canonicalJson(normalized);
  if (Buffer.byteLength(encoded) <= 8_192) return normalized;
  return {
    message: errorMessage(value).slice(0, 2_048),
    truncated: true,
  };
}

function isRetryableFailStopDiagnostic(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const code = (value as { code?: unknown }).code;
  return code === 'INVALID_AGENT_RESULT'
    || code === 'AGENT_QUOTA_OUTCOME_UNSAFE'
    || code === 'AGENT_SAFETY_OUTCOME_UNSAFE'
    || typeof code === 'string';
}
