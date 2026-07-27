import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AgentTaskKind,
  AgentTaskStatus,
  ServerStatus,
  canonicalJson,
  parseAgentTaskPayload,
} from '@nyabase/common';
import type { SelectQueryBuilder, Transaction } from 'kysely';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import {
  AGENT_TASK_MIN_RETENTION_MS,
  MAX_AGENT_TASK_ROWS_HARD,
  MAX_AGENT_TASKS_PER_RETENTION_WINDOW,
  MAX_NON_SAFETY_AGENT_TASKS_PER_RETENTION_WINDOW,
  MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW,
} from './agent-task-retention.service.js';
import {
  MAX_AGENT_TASK_WIRE_BYTES,
  agentTaskPayloadHash,
  parseAndValidateAgentTaskWireIdentity,
  validateDurableAgentTaskRowIdentity,
} from './agent-task-durable-contract.js';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';
import { ResourceKeyService } from './resource-key.service.js';
import { ResourceLockedException } from './resource-lock.error.js';

export const MAX_AGENT_TASK_REQUEST_BYTES = MAX_AGENT_TASK_WIRE_BYTES;
export const MAX_PENDING_AGENT_TASKS_PER_SERVER = 1024;
export const MAX_PENDING_AGENT_TASKS_GLOBAL = 4096;
export const MAX_RECONCILIATION_TASKS_PER_SERVER = 2048;
export const MAX_RECONCILIATION_TASKS_GLOBAL = 8192;
export const MAX_SAFETY_TASKS_PER_SERVER = 1024;
export const MAX_ALL_TASKS_PER_SERVER =
  MAX_RECONCILIATION_TASKS_PER_SERVER + MAX_SAFETY_TASKS_PER_SERVER;

const WORKFLOW_ADVISORY_NAMESPACE = 1_856_214_885;
const WORKFLOW_GLOBAL_ADMISSION_KEY = 8;

export type WorkflowTransaction = Transaction<NyabaseDatabase>;

export interface WorkflowTaskPersistContext {
  commandId: string;
  taskId: string;
  generation: number;
}

export interface WorkflowEnqueueInput {
  kind: AgentTaskKind;
  serverId: string;
  resourceType: string;
  resourceId: string;
  requestedBy: string | null;
  request?: unknown;
  payload: unknown;
  resourceKeys?: string[];
  nextDispatchAt?: Date;
  admissionClass?: 'normal' | 'reconciliation' | 'safety';
  /**
   * Caller domain mutations and task creation share this exact transaction.
   * The callback must remain database-only: no Redis, WS, RPC, or network I/O.
   */
  beforeCommit?: (
    transaction: WorkflowTransaction,
    context: WorkflowTaskPersistContext,
  ) => Promise<void>;
}

export interface WorkflowEnqueueResult {
  ok: true;
  commandId: string;
  taskId: string;
  status: AgentTaskStatus.Pending;
  generation: 1;
}

export interface WorkflowResourceClaim {
  resourceKey: string;
  taskId: string;
  taskGeneration: number;
  serverId: string;
}

/**
 * Canonical caller-owned PostgreSQL enqueue boundary for Storage/Container
 * lanes. This class never opens a nested transaction and never wakes workers;
 * it writes a transactional outbox row for post-commit wake delivery.
 */
@Injectable()
export class WorkflowEnqueuePort {
  constructor(
    private readonly resourceKeys: ResourceKeyService,
    private readonly payloadCodec: AgentTaskPayloadCodecService,
  ) {}

  async enqueueInTransaction(
    transaction: WorkflowTransaction,
    input: WorkflowEnqueueInput,
  ): Promise<WorkflowEnqueueResult> {
    this.validateIdentity(input);
    const server = await transaction
      .selectFrom('infra.servers')
      .select(['id', 'status'])
      .where('id', '=', input.serverId)
      .executeTakeFirst();
    if (!server) throw new NotFoundException('Server not found');
    if (server.status === ServerStatus.AgentQuarantined) {
      throw new ConflictException({
        code: 'AGENT_SERVER_QUARANTINED',
        message:
          'Server is quarantined; repair the Agent and explicitly retry before creating new tasks',
        serverId: input.serverId,
      });
    }

    await sql`select pg_advisory_xact_lock(
      ${WORKFLOW_ADVISORY_NAMESPACE},
      ${WORKFLOW_GLOBAL_ADMISSION_KEY}
    )`.execute(transaction);
    await sql`select pg_advisory_xact_lock(
      ${WORKFLOW_ADVISORY_NAMESPACE},
      hashtext(${input.serverId})
    )`.execute(transaction);

    const admissionClass = input.admissionClass ?? 'normal';
    await this.assertCapacity(transaction, input.serverId, admissionClass);

    const commandId = uuidv7();
    const taskId = uuidv7();
    const requestJson = this.prepareRequest(input.request);
    const payloadJson = this.preparePayload(input);
    const wirePayload = this.payloadCodec.forWirePayload(input.kind, payloadJson);
    const payloadHash = agentTaskPayloadHash(input.kind, wirePayload);
    const resourceKeys = [...new Set(
      input.resourceKeys?.length
        ? input.resourceKeys
        : [this.resourceKeys.generic(
          input.serverId,
          input.resourceType,
          input.resourceId,
        )],
    )].sort();

    await transaction.insertInto('workflow.commands').values({
      id: commandId,
      kind: input.kind,
      server_id: input.serverId,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      requested_by: input.requestedBy,
      request_json: json(requestJson),
      admission_class: admissionClass,
    }).executeTakeFirstOrThrow();

    await transaction.insertInto('workflow.tasks').values({
      id: taskId,
      command_id: commandId,
      kind: input.kind,
      server_id: input.serverId,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      requested_by: input.requestedBy,
      request_json: json(requestJson),
      payload_json: json(payloadJson)!,
      payload_hash: payloadHash,
      admission_class: admissionClass,
      status: AgentTaskStatus.Pending,
      failure_stage: null,
      generation: 1,
      agent_result_json: null,
      agent_result_hash: null,
      result_json: null,
      error_json: null,
      dispatch_attempt_count: 0,
      incomplete_result_count: 0,
      finalizer_attempt_count: 0,
      retry_window_started_at: null,
      next_dispatch_at: input.nextDispatchAt ?? null,
      started_at: null,
      last_sent_at: null,
      result_received_at: null,
      finalizer_retry_at: null,
      completed_at: null,
      dispatch_claim_token: null,
      dispatch_claimed_by: null,
      dispatch_lease_expires_at: null,
      finalizer_claim_token: null,
      finalizer_claimed_by: null,
      finalizer_lease_expires_at: null,
    }).executeTakeFirstOrThrow();

    for (const resourceKey of resourceKeys) {
      const inserted = await transaction.insertInto('workflow.resource_claims').values({
          resource_key: resourceKey,
          task_id: taskId,
          task_generation: 1,
          server_id: input.serverId,
        })
        .onConflict((conflict) => conflict.column('resource_key').doNothing())
        .returning('resource_key')
        .executeTakeFirst();
      if (inserted) continue;
      const owner = await transaction
        .selectFrom('workflow.resource_claims')
        .select(['resource_key', 'task_id'])
        .where('resource_key', '=', resourceKey)
        .executeTakeFirstOrThrow();
      throw new ResourceLockedException([{
        resourceKey: owner.resource_key,
        taskId: owner.task_id,
      }]);
    }

    const context: WorkflowTaskPersistContext = {
      commandId,
      taskId,
      generation: 1,
    };
    await input.beforeCommit?.(transaction, context);
    await transaction.insertInto('workflow.outbox').values({
      topic: 'dispatch',
      partition_key: input.serverId,
      payload_json: JSON.stringify({
        type: 'task.enqueued',
        serverId: input.serverId,
        taskId,
        generation: 1,
      }),
      available_at: sql<Date>`clock_timestamp()`,
      claim_token: null,
      claimed_by: null,
      lease_expires_at: null,
    }).executeTakeFirstOrThrow();

    return {
      ok: true,
      commandId,
      taskId,
      status: AgentTaskStatus.Pending,
      generation: 1,
    };
  }

  /**
   * Supersedes only an intent which provably never crossed the Agent boundary.
   * A staged result or any send marker is an immutable commit barrier.
   */
  async supersedePendingForResourceInTransaction(
    transaction: WorkflowTransaction,
    input: {
      serverId: string;
      resourceType: string;
      resourceId: string;
      reason: string;
    },
  ): Promise<string[]> {
    const pending = await transaction
      .selectFrom('workflow.tasks')
      .select(['id', 'generation'])
      .where('server_id', '=', input.serverId)
      .where('resource_type', '=', input.resourceType)
      .where('resource_id', '=', input.resourceId)
      .where('status', '=', AgentTaskStatus.Pending)
      .where('agent_result_json', 'is', null)
      .where('started_at', 'is', null)
      .where('last_sent_at', 'is', null)
      .orderBy('id')
      .limit(2)
      .forUpdate()
      .execute();
    if (pending.length > 1) {
      throw new ConflictException({
        code: 'AGENT_TASK_SUPERSEDE_OWNER_CONFLICT',
        message:
          'Multiple undispatched tasks claim the same logical resource; repair durable task ownership before replacing intent',
        serverId: input.serverId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      });
    }
    for (const task of pending) {
      await transaction
        .updateTable('workflow.tasks')
        .set({
          status: AgentTaskStatus.Failed,
          failure_stage: null,
          error_json: JSON.stringify({
            code: 'TASK_SUPERSEDED',
            message: input.reason.slice(0, 2048),
          }),
          completed_at: sql<Date>`clock_timestamp()`,
        })
        .where('id', '=', task.id)
        .where('generation', '=', task.generation)
        .where('status', '=', AgentTaskStatus.Pending)
        .where('started_at', 'is', null)
        .where('last_sent_at', 'is', null)
        .where('agent_result_json', 'is', null)
        .executeTakeFirstOrThrow();
      await transaction
        .deleteFrom('workflow.resource_claims')
        .where('task_id', '=', task.id)
        .where('task_generation', '=', task.generation)
        .execute();
    }
    return pending.map((task) => task.id);
  }

  async findResourceClaims(
    transaction: WorkflowTransaction,
    resourceKeys: string[],
  ): Promise<WorkflowResourceClaim[]> {
    if (resourceKeys.length === 0) return [];
    const rows = await transaction
      .selectFrom('workflow.resource_claims')
      .select(['resource_key', 'task_id', 'task_generation', 'server_id'])
      .where('resource_key', 'in', [...new Set(resourceKeys)].sort())
      .orderBy('resource_key')
      .execute();
    return rows.map((row) => ({
      resourceKey: row.resource_key,
      taskId: row.task_id,
      taskGeneration: Number(row.task_generation),
      serverId: row.server_id,
    }));
  }

  private validateIdentity(input: WorkflowEnqueueInput): void {
    try {
      validateDurableAgentTaskRowIdentity(input);
    } catch (error) {
      throw new BadRequestException({
        code: 'INVALID_AGENT_TASK_IDENTITY',
        message: `Invalid durable identity for ${input.kind}`,
        details: errorMessage(error),
      });
    }
  }

  private prepareRequest(request: unknown): unknown | null {
    if (request === undefined) return null;
    try {
      const value = jsonValue(request);
      if (Buffer.byteLength(canonicalJson(value)) > MAX_AGENT_TASK_REQUEST_BYTES) {
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
        details: errorMessage(error).slice(0, 1024),
      });
    }
  }

  private preparePayload(input: WorkflowEnqueueInput): unknown {
    try {
      const storedCandidate = jsonValue(input.payload);
      const wireCandidate = this.payloadCodec.forWirePayload(
        input.kind,
        storedCandidate,
      );
      const parsedWire = jsonValue(parseAndValidateAgentTaskWireIdentity(
        input,
        parseAgentTaskPayload(input.kind, wireCandidate),
      ));
      if (
        input.kind !== AgentTaskKind.RemoteFsEnsure
        && input.kind !== AgentTaskKind.RemoteFsAbsent
      ) return parsedWire;

      const storedSecret = record(record(storedCandidate)?.params)?.secret;
      const parsedParams = record(record(parsedWire)?.params);
      if (typeof storedSecret === 'string' && parsedParams) {
        parsedParams.secret = storedSecret;
      }
      return parsedWire;
    } catch (error) {
      throw new BadRequestException({
        code: errorMessage(error).startsWith('Agent task wire payload exceeds ')
          ? 'AGENT_TASK_PAYLOAD_TOO_LARGE'
          : 'INVALID_AGENT_TASK_PAYLOAD',
        message: `Invalid payload for ${input.kind}`,
        details: errorMessage(error),
      });
    }
  }

  private async assertCapacity(
    transaction: WorkflowTransaction,
    serverId: string,
    admissionClass: 'normal' | 'reconciliation' | 'safety',
  ): Promise<void> {
    const retentionStart = sql<Date>`
      clock_timestamp()
      - (${AGENT_TASK_MIN_RETENTION_MS} * interval '1 millisecond')
    `;
    const [serverPending, globalPending, serverSafety, recent, total] =
      await Promise.all([
        count(transaction, (query) => query
          .where('server_id', '=', serverId)
          .where('status', '=', AgentTaskStatus.Pending)),
        count(transaction, (query) =>
          query.where('status', '=', AgentTaskStatus.Pending)),
        count(transaction, (query) => query
          .where('server_id', '=', serverId)
          .where('status', '=', AgentTaskStatus.Pending)
          .where('admission_class', '=', 'safety')),
        count(transaction, (query) =>
          query.where('created_at', '>=', retentionStart)),
        count(transaction, (query) => query),
      ]);
    if (total >= MAX_AGENT_TASK_ROWS_HARD) {
      throw new ServiceUnavailableException({
        code: 'AGENT_TASK_STORAGE_CAPACITY_REACHED',
        message: 'Durable Agent task storage reached its fail-closed hard bound',
      });
    }
    const retentionLimit = admissionClass === 'safety'
      ? MAX_AGENT_TASKS_PER_RETENTION_WINDOW
      : admissionClass === 'reconciliation'
        ? MAX_NON_SAFETY_AGENT_TASKS_PER_RETENTION_WINDOW
        : MAX_NORMAL_AGENT_TASKS_PER_RETENTION_WINDOW;
    if (recent >= retentionLimit) {
      throw new ServiceUnavailableException({
        code: 'AGENT_TASK_RETENTION_WINDOW_CAPACITY_REACHED',
        message:
          'Agent task creation is temporarily rate-limited by the bounded result-retention window',
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
    if (
      serverPending >= serverLimit
      || (admissionClass !== 'safety' && globalPending >= globalLimit)
      || (admissionClass === 'safety' && serverSafety >= MAX_SAFETY_TASKS_PER_SERVER)
    ) {
      throw new ServiceUnavailableException({
        code: 'AGENT_TASK_QUEUE_FULL',
        message: 'Durable Agent task queue capacity is exhausted',
        serverId,
      });
    }
  }
}

type WorkflowTaskQuery = SelectQueryBuilder<
  NyabaseDatabase,
  'workflow.tasks',
  Record<string, never>
>;

async function count(
  transaction: WorkflowTransaction,
  where: (query: WorkflowTaskQuery) => WorkflowTaskQuery,
): Promise<number> {
  const query = transaction.selectFrom('workflow.tasks') as WorkflowTaskQuery;
  const row = await where(query)
    .select((expression) => expression.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

function json(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
