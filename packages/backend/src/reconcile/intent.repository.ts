import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import {
  IntentKind,
  IntentResourceType,
  IntentStatus,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { retryPgTransaction } from '../platform/persistence-pg/transaction.js';
import { afterCommit, executeWithPostCommit } from '../platform/post-commit.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { ReconcileWakeService } from './reconcile-wake.service.js';

import {
  MAX_PAGE_SIZE,
  asDate,
  assertKindResource,
  assertResourceType,
  assertRevision,
  assertUuidLike,
  boundedFailure,
  boundedJsonObject,
  decodeCursor,
  encodeCursor,
  intentIdempotencyKey,
  mapRow,
  objectValue,
  type CreatePendingIntentInput,
  type EnsurePendingIntentInput,
  type IntentExecutor,
  type IntentListOptions,
  type IntentPage,
  type IntentRecord,
  type IntentResource,
  type IntentSettleResult,
  type PhysicalSettlement,
  type SettleOptions,
  type TypedIntentKind,
} from './intent-model.js';

export * from './intent-model.js';

@Injectable()
export class IntentRepository {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly wake: ReconcileWakeService,
  ) {}

  async createPending(
    input: CreatePendingIntentInput,
    executor: IntentExecutor = this.database,
  ): Promise<IntentRecord> {
    assertKindResource(input.kind, input.resourceType);
    assertResourceType(input.resourceType);
    assertUuidLike(input.resourceId, 'Intent resource id');
    if (input.serverId) assertUuidLike(input.serverId, 'Intent server id');
    assertRevision(input.targetRevision);
    const id = input.id ?? randomUUID();
    assertUuidLike(id, 'Intent id');
    const request = boundedJsonObject(input.request);
    const baseline = boundedJsonObject(input.baseline);
    const row = await executor
      .insertInto('control.intents')
      .values({
        id,
        kind: input.kind,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        server_id: input.serverId ?? null,
        requested_by: input.requestedBy ?? null,
        request_json: request ? JSON.stringify(request) : null,
        target_revision: input.targetRevision,
        baseline_json: baseline ? JSON.stringify(baseline) : null,
        status: IntentStatus.Pending,
        failure_code: null,
        failure_json: null,
        attempt_count: 0,
        next_attempt_at: input.nextAttemptAt ?? null,
        settled_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    afterCommit(executor, () => this.wake.wake({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      serverId: input.serverId ?? null,
      reason: 'intent',
    }));
    return mapRow(row);
  }

  async retry(
    sourceIntentId: string,
    executor: IntentExecutor = this.database,
  ): Promise<IntentRecord> {
    assertUuidLike(sourceIntentId, 'Source intent id');
    const source = await executor
      .selectFrom('control.intents')
      .selectAll()
      .where('id', '=', sourceIntentId)
      .executeTakeFirst();
    if (!source) throw new Error('Intent to retry was not found');
    if (source.status !== IntentStatus.Failed) {
      throw new Error('Only failed intents can be retried');
    }
    if (source.kind === IntentKind.ServerConnect) {
      throw new Error('Server connect retries require a fresh trust-token reference');
    }
    const targetRevision = await this.currentRevision(source.resource_type, source.resource_id, executor)
      ?? source.target_revision;
    const request = objectValue(source.request_json) ?? {};
    await this.releaseAttention(source.resource_type, source.resource_id, executor);
    await this.restoreVolumeResizeSize(source.kind, source.resource_id, request, executor);
    return this.createPending({
      kind: source.kind as TypedIntentKind,
      resourceType: source.resource_type,
      resourceId: source.resource_id,
      serverId: source.server_id,
      requestedBy: source.requested_by,
      request: {
        ...request,
        retryOf: sourceIntentId,
      },
      targetRevision,
      baseline: objectValue(source.baseline_json),
    }, executor);
  }

  private async restoreVolumeResizeSize(
    kind: string,
    resourceId: string,
    request: Record<string, unknown> | null | undefined,
    executor: IntentExecutor,
  ): Promise<void> {
    if (kind !== IntentKind.VolumeResize) return;
    const sizeBytes = request?.sizeBytes;
    if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      return;
    }
    await executor
      .updateTable('control.volumes')
      .set({ size_bytes: sizeBytes })
      .where('id', '=', resourceId)
      .where('lifecycle_phase', 'not in', ['deleting', 'failed'])
      .execute();
  }

  private async releaseAttention(
    resourceType: string,
    resourceId: string,
    executor: IntentExecutor,
  ): Promise<void> {
    if (resourceType === IntentResourceType.Volume) {
      await executor
        .updateTable('control.volumes')
        .set({ needs_attention: false, failure_code: null })
        .where('id', '=', resourceId)
        .where('lifecycle_phase', '!=', 'deleting')
        .execute();
      return;
    }
    if (resourceType === IntentResourceType.Container) {
      await executor
        .updateTable('control.containers')
        .set({ needs_attention: false, failure_code: null, failure_reason: null })
        .where('id', '=', resourceId)
        .execute();
      return;
    }
    if (resourceType === IntentResourceType.ImageAssignment) {
      await executor
        .updateTable('infra.image_server_assignments')
        .set({ needs_attention: false, failure_code: null, failure_reason: null })
        .where('id', '=', resourceId)
        .execute();
    }
  }

  private async currentRevision(
    resourceType: string,
    resourceId: string,
    executor: IntentExecutor,
  ): Promise<number | null> {
    if (resourceType === IntentResourceType.Container) {
      const row = await executor.selectFrom('control.containers')
        .select('revision').where('id', '=', resourceId).executeTakeFirst();
      return row?.revision ?? null;
    }
    if (resourceType === IntentResourceType.Volume) {
      const row = await executor.selectFrom('control.volumes')
        .select('revision').where('id', '=', resourceId).executeTakeFirst();
      return row?.revision ?? null;
    }
    if (resourceType === IntentResourceType.ImageAssignment) {
      const row = await executor.selectFrom('infra.image_server_assignments')
        .select('revision').where('id', '=', resourceId).executeTakeFirst();
      return row?.revision ?? null;
    }
    if (resourceType === IntentResourceType.Server) {
      const row = await executor.selectFrom('infra.servers')
        .select('revision').where('id', '=', resourceId).executeTakeFirst();
      return row ? Number(row.revision) : null;
    }
    return null;
  }

  async list(
    options: IntentListOptions = {},
    executor: IntentExecutor = this.database,
  ): Promise<IntentPage> {
    if (options.resourceType) assertResourceType(options.resourceType);
    if (options.resourceTypes) {
      for (const resourceType of options.resourceTypes) assertResourceType(resourceType);
    }
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new Error(`Intent page size must be between 1 and ${MAX_PAGE_SIZE}`);
    }
    if (options.resourceTypes && options.resourceTypes.length === 0) {
      return { items: [], nextCursor: null };
    }
    if (options.resourceIds && options.resourceIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    let query = executor
      .selectFrom('control.intents')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (options.status) query = query.where('status', '=', options.status);
    if (options.kind) query = query.where('kind', '=', options.kind);
    if (options.resourceType) query = query.where('resource_type', '=', options.resourceType);
    if (options.resourceTypes) {
      query = query.where('resource_type', 'in', [...options.resourceTypes]);
    }
    if (options.resourceId) query = query.where('resource_id', '=', options.resourceId);
    if (options.resourceIds) {
      query = query.where('resource_id', 'in', [...options.resourceIds]);
    }
    if (options.serverId) query = query.where('server_id', '=', options.serverId);
    if (options.requestedBy) query = query.where('requested_by', '=', options.requestedBy);
    if (options.readyAt) {
      query = query.where((expression) => expression.or([
        expression('next_attempt_at', 'is', null),
        expression('next_attempt_at', '<=', options.readyAt!),
      ]));
    }
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      query = query.where((expression) => expression.or([
        expression('created_at', '<', cursor.createdAt),
        expression.and([
          expression('created_at', '=', cursor.createdAt),
          expression('id', '<', cursor.id),
        ]),
      ]));
    }
    const rows = await query.execute();
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(mapRow),
      nextCursor: rows.length > limit && last
        ? encodeCursor(asDate(last.created_at) ?? new Date(0), last.id)
        : null,
    };
  }

  async findById(
    id: string,
    executor: IntentExecutor = this.database,
  ): Promise<IntentRecord | null> {
    const row = await executor
      .selectFrom('control.intents')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async listPending(
    options: Omit<IntentListOptions, 'status'> = {},
    executor: IntentExecutor = this.database,
  ): Promise<IntentPage> {
    if (options.resourceType) assertResourceType(options.resourceType);
    if (options.resourceTypes) {
      for (const resourceType of options.resourceTypes) assertResourceType(resourceType);
    }
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new Error(`Intent page size must be between 1 and ${MAX_PAGE_SIZE}`);
    }
    if (options.resourceTypes && options.resourceTypes.length === 0) {
      return { items: [], nextCursor: null };
    }
    if (options.resourceIds && options.resourceIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    let query = executor
      .selectFrom('control.intents')
      .selectAll()
      .where('status', '=', IntentStatus.Pending)
      .orderBy(sql`coalesce(next_attempt_at, created_at)`, 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit + 1);
    if (options.kind) query = query.where('kind', '=', options.kind);
    if (options.resourceType) query = query.where('resource_type', '=', options.resourceType);
    if (options.resourceTypes) {
      query = query.where('resource_type', 'in', [...options.resourceTypes]);
    }
    if (options.resourceId) query = query.where('resource_id', '=', options.resourceId);
    if (options.resourceIds) {
      query = query.where('resource_id', 'in', [...options.resourceIds]);
    }
    if (options.serverId) query = query.where('server_id', '=', options.serverId);
    if (options.readyAt) {
      query = query.where((expression) => expression.or([
        expression('next_attempt_at', 'is', null),
        expression('next_attempt_at', '<=', options.readyAt!),
      ]));
    }
    const rows = await query.execute();
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(mapRow),
      nextCursor: null,
    };
  }

  async ensurePending(
    input: EnsurePendingIntentInput,
    executor?: IntentExecutor,
  ): Promise<IntentRecord> {
    if (!executor) {
      return retryPgTransaction(
        () => executeWithPostCommit(
          this.database.transaction().setIsolationLevel('serializable'),
          (transaction) => this.ensurePending(input, transaction),
        ),
        { maxAttempts: 5, retryBaseDelayMs: 5 },
      );
    }
    assertKindResource(input.kind, input.resourceType);
    assertUuidLike(input.resourceId, 'Intent resource id');
    const reuseSettled = input.reuseSettled !== false;
    const reuseFailed = input.reuseFailed === true;
    const reuseStatuses = [
      IntentStatus.Pending,
      ...(reuseSettled ? [IntentStatus.Succeeded] : []),
      ...(reuseFailed ? [IntentStatus.Failed] : []),
    ];
    let existingQuery = executor
      .selectFrom('control.intents')
      .selectAll()
      .where('kind', '=', input.kind)
      .where('resource_type', '=', input.resourceType)
      .where('resource_id', '=', input.resourceId)
      .where('target_revision', '=', input.targetRevision)
      .where('status', 'in', reuseStatuses)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
    if (input.serverId) {
      existingQuery = existingQuery.where('server_id', '=', input.serverId);
    } else {
      existingQuery = existingQuery.where('server_id', 'is', null);
    }
    const existingRows = await existingQuery.execute();
    const desiredIdempotencyKey = intentIdempotencyKey(input.targetRevision, input.request);
    const matches = existingRows.filter((row) =>
      intentIdempotencyKey(row.target_revision, row.request_json) === desiredIdempotencyKey);
    const existing = matches.find((row) => row.status === IntentStatus.Pending)
      ?? (reuseSettled
        ? matches.find((row) => row.status === IntentStatus.Succeeded)
        : undefined)
      ?? (reuseFailed
        ? matches.find((row) => row.status === IntentStatus.Failed)
        : undefined);
    if (existing) return mapRow(existing);
    return this.createPending(input, executor);
  }

  async scheduleRetry(
    intentId: string,
    nextAttemptAt: Date,
    executor: IntentExecutor = this.database,
  ): Promise<boolean> {
    assertUuidLike(intentId, 'Intent id');
    const result = await executor
      .updateTable('control.intents')
      .set((values) => ({
        attempt_count: sql<number>`${values.ref('attempt_count')} + 1`,
        next_attempt_at: nextAttemptAt,
      }))
      .where('id', '=', intentId)
      .where('status', '=', IntentStatus.Pending)
      .returning('id')
      .executeTakeFirst();
    return result !== undefined;
  }

  /**
   * Counts one INSTANCE_BUSY failure on the intent. A streak older than
   * `windowMs` restarts at one. Returns the attempts inside the current window.
   */
  async recordBusyAttempt(
    intentId: string,
    windowMs: number,
    executor: IntentExecutor = this.database,
  ): Promise<number> {
    assertUuidLike(intentId, 'Intent id');
    const row = await executor
      .updateTable('control.intents')
      .set({
        busy_attempts: sql<number>`CASE
          WHEN busy_since IS NOT NULL
            AND busy_since > clock_timestamp() - ${windowMs} * interval '1 millisecond'
          THEN busy_attempts + 1 ELSE 1 END`,
        busy_since: sql<Date>`CASE
          WHEN busy_since IS NOT NULL
            AND busy_since > clock_timestamp() - ${windowMs} * interval '1 millisecond'
          THEN busy_since ELSE clock_timestamp() END`,
      })
      .where('id', '=', intentId)
      .where('status', '=', IntentStatus.Pending)
      .returning('busy_attempts')
      .executeTakeFirst();
    return row?.busy_attempts ?? 0;
  }

  /** Ends a busy streak: the intent was retried for a reason other than a busy instance. */
  async resetBusyAttempts(
    intentId: string,
    executor: IntentExecutor = this.database,
  ): Promise<void> {
    assertUuidLike(intentId, 'Intent id');
    await executor
      .updateTable('control.intents')
      .set({ busy_attempts: 0, busy_since: null })
      .where('id', '=', intentId)
      .where('busy_attempts', '>', 0)
      .execute();
  }

  async settleForObservedRevision(
    resourceType: IntentResource,
    resourceId: string,
    observedRevision: number,
    settlement: PhysicalSettlement,
    executor: IntentExecutor = this.database,
    options: SettleOptions = {},
  ): Promise<IntentSettleResult> {
    assertResourceType(resourceType);
    assertUuidLike(resourceId, 'Intent resource id');
    assertRevision(observedRevision);
    if (settlement.outcome === 'failed' && !settlement.failure) {
      throw new Error('A failed settlement must include a failure');
    }
    const failure = settlement.failure ? boundedFailure(settlement.failure) : null;
    let pendingQuery = executor
      .selectFrom('control.intents')
      .select(['id', 'kind', 'request_json', 'target_revision'])
      .where('resource_type', '=', resourceType)
      .where('resource_id', '=', resourceId)
      .where('status', '=', IntentStatus.Pending)
      .where('target_revision', '<=', observedRevision);
    pendingQuery = settlement.placementServerId
      ? pendingQuery.where('server_id', '=', settlement.placementServerId)
      : pendingQuery.where('server_id', 'is', null);
    const rows = await pendingQuery.forUpdate().execute();
    let succeeded = 0;
    let failed = 0;
    let superseded = 0;
    for (const row of rows) {
      if (options.keep?.({ kind: row.kind, request: objectValue(row.request_json) })) {
        continue;
      }
      const isCurrentRevision = row.target_revision === observedRevision;
      const status = settlement.outcome === 'succeeded'
        ? IntentStatus.Succeeded
        : IntentStatus.Failed;
      const rowFailure = settlement.outcome === 'failed' && isCurrentRevision
        ? failure
        : settlement.outcome === 'failed'
          ? {
            code: 'SUPERSEDED_BY_FAILED_REVISION',
            message: `Revision ${observedRevision} failed before target revision ${row.target_revision} settled`,
            details: { observedRevision, targetRevision: row.target_revision },
          }
          : null;
      await executor
        .updateTable('control.intents')
        .set({
          status,
          failure_code: status === IntentStatus.Failed ? rowFailure?.code ?? 'FAILED' : null,
          failure_json: status === IntentStatus.Failed && rowFailure
            ? JSON.stringify(boundedFailure(rowFailure))
            : null,
          next_attempt_at: null,
          settled_at: sql<Date>`clock_timestamp()`,
        })
        .where('id', '=', row.id)
        .where('status', '=', IntentStatus.Pending)
        .execute();
      if (status === IntentStatus.Succeeded && isCurrentRevision) succeeded += 1;
      else if (status === IntentStatus.Succeeded) superseded += 1;
      else if (isCurrentRevision) failed += 1;
      else superseded += 1;
    }
    return { succeeded, failed, superseded };
  }

  async settleOne(
    intentId: string,
    settlement: PhysicalSettlement,
    executor: IntentExecutor = this.database,
  ): Promise<boolean> {
    assertUuidLike(intentId, 'Intent id');
    if (settlement.outcome === 'failed' && !settlement.failure) {
      throw new Error('A failed settlement must include a failure');
    }
    const failure = settlement.failure ? boundedFailure(settlement.failure) : null;
    const status = settlement.outcome === 'succeeded'
      ? IntentStatus.Succeeded
      : IntentStatus.Failed;
    const result = await executor
      .updateTable('control.intents')
      .set({
        status,
        failure_code: status === IntentStatus.Failed ? failure?.code ?? 'FAILED' : null,
        failure_json: status === IntentStatus.Failed && failure
          ? JSON.stringify(failure)
          : null,
        next_attempt_at: null,
        settled_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', intentId)
      .where('status', '=', IntentStatus.Pending)
      .returning('id')
      .executeTakeFirst();
    return result !== undefined;
  }
}
