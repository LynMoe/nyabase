import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  ADMIN_INTENT_LIST_MAX,
  IntentKind,
  IntentResourceType,
  IntentStatus,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { retryPgTransaction } from '../persistence-pg/transaction.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import {
  RECONCILE_WAKE,
  type ReconcileWakePort,
} from './reconcile-wake.service.js';

export const INTENT_REPOSITORY = Symbol('INTENT_REPOSITORY');

export type IntentExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;
export type IntentResource = `${IntentResourceType}`;
export type TypedIntentKind = `${IntentKind}`;
export type IntentState = `${IntentStatus}`;

export interface IntentFailure {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface IntentRecord {
  readonly id: string;
  readonly kind: TypedIntentKind;
  readonly resourceType: IntentResource;
  readonly resourceId: string;
  readonly serverId: string | null;
  readonly requestedBy: string | null;
  readonly request: Record<string, unknown> | null;
  readonly targetGeneration: number;
  readonly baseline: Record<string, unknown> | null;
  readonly status: IntentState;
  readonly failureCode: string | null;
  readonly failure: IntentFailure | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly blockedByIntentId?: string | null;
}

export interface CreatePendingIntentInput {
  readonly id?: string;
  readonly kind: TypedIntentKind;
  readonly resourceType: IntentResource;
  readonly resourceId: string;
  readonly serverId?: string | null;
  readonly requestedBy?: string | null;
  readonly request?: Record<string, unknown> | null;
  readonly targetGeneration: number;
  readonly baseline?: Record<string, unknown> | null;
  readonly nextAttemptAt?: Date | string | null;
  readonly blockedByIntentId?: string | null;
}

export interface RetryIntentInput {
  readonly sourceIntentId: string;
  readonly kind: TypedIntentKind;
  readonly resourceType: IntentResource;
  readonly resourceId: string;
  readonly serverId?: string | null;
  readonly requestedBy?: string | null;
  readonly request?: Record<string, unknown> | null;
  readonly targetGeneration: number;
  readonly baseline?: Record<string, unknown> | null;
}

export type EnsurePendingIntentInput = CreatePendingIntentInput & {
  readonly reuseSettled?: boolean;
  readonly reuseFailed?: boolean;
};

export interface IntentPage {
  readonly items: readonly IntentRecord[];
  readonly nextCursor: string | null;
}

export interface IntentListOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: IntentState;
  readonly kind?: TypedIntentKind;
  readonly resourceType?: IntentResource;
  readonly resourceTypes?: readonly IntentResource[];
  readonly resourceId?: string;
  readonly resourceIds?: readonly string[];
  readonly serverId?: string;
  readonly readyAt?: Date;
}

export interface IntentSettleResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly superseded: number;
}

export interface PhysicalSettlement {
  readonly outcome: 'succeeded' | 'failed';
  readonly failure?: IntentFailure;
  readonly placementServerId?: string | null;
}

const KIND_RESOURCES: Readonly<Record<TypedIntentKind, readonly IntentResource[]>> = {
  [IntentKind.ContainerCreate]: [IntentResourceType.Container],
  [IntentKind.ContainerUpdate]: [IntentResourceType.Container],
  [IntentKind.ContainerPower]: [IntentResourceType.Container],
  [IntentKind.ContainerDelete]: [IntentResourceType.Container],
  [IntentKind.VolumeEnsure]: [IntentResourceType.Volume],
  [IntentKind.VolumeResize]: [IntentResourceType.Volume],
  [IntentKind.VolumeDestroy]: [IntentResourceType.Volume],
  [IntentKind.ImageAssignmentEnsure]: [IntentResourceType.ImageAssignment],
  [IntentKind.ImageAssignmentDelete]: [IntentResourceType.ImageAssignment],
  [IntentKind.ServerConnect]: [IntentResourceType.Server],
  [IntentKind.ServerPreflight]: [IntentResourceType.Server],
  [IntentKind.CertificateRotate]: [IntentResourceType.CertificateRotation],
};

const MAX_PAGE_SIZE = ADMIN_INTENT_LIST_MAX;
const MAX_JSON_BYTES = 8 * 1024;
const MAX_JSON_DEPTH = 5;
const MAX_JSON_KEYS = 64;

export function isRestartIntent(
  kind: TypedIntentKind | string,
  request: Record<string, unknown> | null | undefined,
): boolean {
  return kind === IntentKind.ContainerPower && request?.action === 'restart';
}

export function isUserRetryIntent(
  request: Record<string, unknown> | null | undefined,
): boolean {
  return typeof request?.retryOf === 'string' && request.retryOf.length > 0;
}

function assertKindResource(kind: TypedIntentKind, resourceType: IntentResource): void {
  if (!Object.prototype.hasOwnProperty.call(KIND_RESOURCES, kind)) {
    throw new Error(`Unsupported intent kind: ${kind}`);
  }
  if (!KIND_RESOURCES[kind].includes(resourceType)) {
    throw new Error(`Intent kind ${kind} cannot target ${resourceType}`);
  }
}

function assertResourceType(resourceType: IntentResource): void {
  if (!(Object.values(IntentResourceType) as string[]).includes(resourceType)) {
    throw new Error(`Unsupported intent resource type: ${resourceType}`);
  }
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Intent target generation must be a positive safe integer');
  }
}

function assertUuidLike(value: string, label: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    && !/^[0-9a-f]{32}$/i.test(value)
  ) {
    throw new Error(`${label} must be a UUID`);
  }
}

function boundedJsonValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) return '[truncated]';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return typeof value === 'string' ? value.slice(0, 1024) : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_JSON_KEYS).map((item) => boundedJsonValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, MAX_JSON_KEYS)) {
      output[key.slice(0, 256)] = boundedJsonValue(child, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 1024);
}

function boundedJsonObject(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const bounded = boundedJsonValue(value);
  if (!bounded || typeof bounded !== 'object' || Array.isArray(bounded)) return {};
  const text = JSON.stringify(bounded);
  if (Buffer.byteLength(text, 'utf8') <= MAX_JSON_BYTES) {
    return bounded as Record<string, unknown>;
  }
  return {
    truncated: true,
    preview: text.slice(0, MAX_JSON_BYTES - 64),
  };
}

function containsTrustToken(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTrustToken);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    if (key === 'trustTokenRef') return false;
    const normalizedKey = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
    if (normalizedKey === 'token' || normalizedKey.includes('trusttoken')) return true;
    return containsTrustToken(child);
  });
}

function boundedFailure(failure: IntentFailure): IntentFailure {
  const code = String(failure.code).slice(0, 128);
  const message = String(failure.message).slice(0, 4096);
  const details = boundedJsonObject(failure.details) ?? {};
  const result: IntentFailure = { code, message, details };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_JSON_BYTES) return result;
  return { code, message: message.slice(0, 1024), details: { truncated: true } };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8')
    .toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  if (cursor.length > 512) throw new Error('Intent cursor is too long');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid intent cursor');
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || typeof (parsed as { createdAt?: unknown }).createdAt !== 'string'
    || typeof (parsed as { id?: unknown }).id !== 'string'
  ) {
    throw new Error('Invalid intent cursor');
  }
  const createdAt = new Date((parsed as { createdAt: string }).createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error('Invalid intent cursor timestamp');
  assertUuidLike((parsed as { id: string }).id, 'Intent cursor id');
  return { createdAt, id: (parsed as { id: string }).id };
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function intentIdempotencyKey(targetGeneration: number, request: unknown): string {
  const object = objectValue(request);
  const explicit = object?.idempotencyKey;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return `key:${explicit}`;
  }
  const desiredHash = object?.desiredHash;
  if (typeof desiredHash === 'string' && desiredHash.length > 0) {
    return `hash:${desiredHash}`;
  }
  return `generation:${targetGeneration}`;
}

function mapFailure(
  code: string | null,
  value: unknown,
): IntentFailure | null {
  if (!code) return null;
  const json = objectValue(value);
  return boundedFailure({
    code,
    message: typeof json?.message === 'string' ? json.message : code,
    details: objectValue(json?.details) ?? undefined,
  });
}

function mapRow(row: {
  id: string;
  kind: string;
  resource_type: IntentResource;
  resource_id: string;
  server_id: string | null;
  requested_by: string | null;
  request_json: unknown;
  target_generation: number;
  baseline_json: unknown;
  status: IntentState;
  failure_code: string | null;
  failure_json: unknown;
  attempt_count: number;
  next_attempt_at: Date | string | null;
  created_at: Date | string;
  settled_at: Date | string | null;
  blocked_by_intent_id?: string | null;
}): IntentRecord {
  return {
    id: row.id,
    kind: row.kind as TypedIntentKind,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    serverId: row.server_id,
    requestedBy: row.requested_by,
    request: objectValue(row.request_json),
    targetGeneration: row.target_generation,
    baseline: objectValue(row.baseline_json),
    status: row.status,
    failureCode: row.failure_code,
    failure: mapFailure(row.failure_code, row.failure_json),
    attemptCount: row.attempt_count,
    nextAttemptAt: asDate(row.next_attempt_at)?.toISOString() ?? null,
    createdAt: asDate(row.created_at)?.toISOString() ?? new Date(0).toISOString(),
    settledAt: asDate(row.settled_at)?.toISOString() ?? null,
    blockedByIntentId: row.blocked_by_intent_id ?? null,
  };
}

@Injectable()
export class IntentRepository {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Optional() @Inject(RECONCILE_WAKE) private readonly wake?: ReconcileWakePort,
  ) {}

  async createPending(
    input: CreatePendingIntentInput,
    executor: IntentExecutor = this.database,
  ): Promise<IntentRecord> {
    assertKindResource(input.kind, input.resourceType);
    assertResourceType(input.resourceType);
    assertUuidLike(input.resourceId, 'Intent resource id');
    if (input.serverId) assertUuidLike(input.serverId, 'Intent server id');
    if (
      (input.resourceType === IntentResourceType.Container
        || input.resourceType === IntentResourceType.ImageAssignment
        || input.resourceType === IntentResourceType.Server)
      && !input.serverId
    ) {
      throw new Error(`${input.resourceType} intents require a server id`);
    }
    if (input.resourceType === IntentResourceType.CertificateRotation && input.serverId) {
      throw new Error('Certificate rotation intents cannot carry a server id');
    }
    if (input.resourceType === IntentResourceType.Volume) {
      if (input.kind === IntentKind.VolumeDestroy) {
        if (input.serverId) {
          throw new Error('Volume destroy intents cannot carry a server id');
        }
      } else {
        if (!input.serverId) {
          throw new Error('Volume intents require a server id');
        }
        const volume = await executor
          .selectFrom('control.volumes')
          .select(['server_id', 'shared_backend_id'])
          .where('id', '=', input.resourceId)
          .executeTakeFirst();
        if (volume?.shared_backend_id && input.kind === IntentKind.VolumeEnsure) {
          throw new Error('Shared volumes cannot enqueue volume.ensure');
        }
        if (volume && !volume.shared_backend_id && input.serverId !== volume.server_id) {
          throw new Error('Local volume intent server does not match the volume');
        }
        if (volume?.shared_backend_id) {
          const placement = await executor
            .selectFrom('control.volume_placements')
            .select('server_id')
            .where('volume_id', '=', input.resourceId)
            .where('server_id', '=', input.serverId)
            .executeTakeFirst();
          if (!placement) {
            throw new Error('Shared volume intent server does not match a placement');
          }
        }
      }
    }
    if (input.blockedByIntentId) {
      assertUuidLike(input.blockedByIntentId, 'Blocked-by intent id');
      if (input.blockedByIntentId === (input.id ?? '')) {
        throw new Error('An intent cannot block on itself');
      }
    }
    assertGeneration(input.targetGeneration);
    const id = input.id ?? randomUUID();
    assertUuidLike(id, 'Intent id');
    const request = boundedJsonObject(input.request);
    const baseline = boundedJsonObject(input.baseline);
    if (input.kind === IntentKind.ServerConnect) {
      const reference = input.request?.trustTokenRef;
      if (
        typeof reference !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference)
        || request?.trustTokenRef !== reference
      ) {
        throw new Error('Server connect intents require a persistable Redis trust-token reference');
      }
      if (containsTrustToken(input.request)) {
        throw new Error('Server connect intents cannot persist a trust token');
      }
    }
    const isRestart = isRestartIntent(input.kind, input.request);
    if (isRestart) {
      if (
        !input.baseline
        || Object.keys(input.baseline).some((key) => key !== 'startedAt')
        || !Object.prototype.hasOwnProperty.call(input.baseline, 'startedAt')
        || (
          input.baseline.startedAt !== null
          && typeof input.baseline.startedAt !== 'string'
        )
      ) {
        throw new Error('Restart intents require a startedAt baseline');
      }
    } else if (input.baseline) {
      throw new Error('Only restart intents may carry a baseline');
    }
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
        target_generation: input.targetGeneration,
        baseline_json: baseline ? JSON.stringify(baseline) : null,
        status: IntentStatus.Pending,
        failure_code: null,
        failure_json: null,
        attempt_count: 0,
        next_attempt_at: input.nextAttemptAt ?? null,
        blocked_by_intent_id: input.blockedByIntentId ?? null,
        settled_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.notifyReconcile(executor, {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      serverId: input.serverId ?? null,
    });
    this.wake?.wake({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      serverId: input.serverId ?? null,
      reason: 'intent',
    });
    return mapRow(row);
  }

  createRetry(
    input: RetryIntentInput,
    executor: IntentExecutor = this.database,
  ): Promise<IntentRecord> {
    assertUuidLike(input.sourceIntentId, 'Source intent id');
    return this.assertRetryable(input.sourceIntentId, executor).then(async () => {
      await this.releaseAttention(input.resourceType, input.resourceId, executor);
      await this.restoreVolumeResizeSize(input.kind, input.resourceId, input.request, executor);
      return this.createPending({
        ...input,
        id: randomUUID(),
        request: {
          ...(input.request ?? {}),
          retryOf: input.sourceIntentId,
        },
      }, executor);
    });
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
      throw new Error('Server connect retries require a fresh Redis trust-token reference');
    }
    const targetGeneration = await this.currentGeneration(source.resource_type, source.resource_id, executor)
      ?? source.target_generation;
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
      targetGeneration,
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

  private async currentGeneration(
    resourceType: string,
    resourceId: string,
    executor: IntentExecutor,
  ): Promise<number | null> {
    if (resourceType === IntentResourceType.Container) {
      const row = await executor.selectFrom('control.containers')
        .select('generation').where('id', '=', resourceId).executeTakeFirst();
      return row?.generation ?? null;
    }
    if (resourceType === IntentResourceType.Volume) {
      const row = await executor.selectFrom('control.volumes')
        .select('generation').where('id', '=', resourceId).executeTakeFirst();
      return row?.generation ?? null;
    }
    if (resourceType === IntentResourceType.ImageAssignment) {
      const row = await executor.selectFrom('infra.image_server_assignments')
        .select('generation').where('id', '=', resourceId).executeTakeFirst();
      return row?.generation ?? null;
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

  listForResource(
    resourceType: IntentResource,
    resourceId: string,
    options: Omit<IntentListOptions, 'resourceType' | 'resourceId'> = {},
    executor: IntentExecutor = this.database,
  ): Promise<IntentPage> {
    assertResourceType(resourceType);
    assertUuidLike(resourceId, 'Intent resource id');
    return this.list({ ...options, resourceType, resourceId }, executor);
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
      .where((expression) => expression.or([
        expression('blocked_by_intent_id', 'is', null),
        sql<boolean>`exists (
          select 1 from control.intents as pred
          where pred.id = control.intents.blocked_by_intent_id
            and pred.status = ${IntentStatus.Succeeded}
        )`,
      ]))
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
        () => this.database
          .transaction()
          .setIsolationLevel('serializable')
          .execute((transaction) => this.ensurePending(input, transaction)),
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
      .where('target_generation', '=', input.targetGeneration)
      .where('status', 'in', reuseStatuses)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
    if (input.serverId) {
      existingQuery = existingQuery.where('server_id', '=', input.serverId);
    } else {
      existingQuery = existingQuery.where('server_id', 'is', null);
    }
    const existingRows = await existingQuery.execute();
    const desiredIdempotencyKey = intentIdempotencyKey(input.targetGeneration, input.request);
    const matches = existingRows.filter((row) =>
      intentIdempotencyKey(row.target_generation, row.request_json) === desiredIdempotencyKey);
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

  async settleForObservedGeneration(
    resourceType: IntentResource,
    resourceId: string,
    observedGeneration: number,
    settlement: PhysicalSettlement,
    executor: IntentExecutor = this.database,
  ): Promise<IntentSettleResult> {
    assertResourceType(resourceType);
    assertUuidLike(resourceId, 'Intent resource id');
    assertGeneration(observedGeneration);
    if (settlement.outcome === 'failed' && !settlement.failure) {
      throw new Error('A failed settlement must include a failure');
    }
    const failure = settlement.failure ? boundedFailure(settlement.failure) : null;
    let pendingQuery = executor
      .selectFrom('control.intents')
      .select(['id', 'kind', 'request_json', 'target_generation'])
      .where('resource_type', '=', resourceType)
      .where('resource_id', '=', resourceId)
      .where('status', '=', IntentStatus.Pending)
      .where('target_generation', '<=', observedGeneration);
    pendingQuery = settlement.placementServerId
      ? pendingQuery.where('server_id', '=', settlement.placementServerId)
      : pendingQuery.where('server_id', 'is', null);
    const rows = await pendingQuery.forUpdate().execute();
    let succeeded = 0;
    let failed = 0;
    let superseded = 0;
    const settledIds: string[] = [];
    for (const row of rows) {
      if (isRestartIntent(row.kind, objectValue(row.request_json))) {
        continue;
      }
      const isCurrentGeneration = row.target_generation === observedGeneration;
      const status = settlement.outcome === 'succeeded'
        ? IntentStatus.Succeeded
        : IntentStatus.Failed;
      const rowFailure = settlement.outcome === 'failed' && isCurrentGeneration
        ? failure
        : settlement.outcome === 'failed'
          ? {
            code: 'SUPERSEDED_BY_FAILED_GENERATION',
            message: `Generation ${observedGeneration} failed before target generation ${row.target_generation} settled`,
            details: { observedGeneration, targetGeneration: row.target_generation },
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
      settledIds.push(row.id);
      if (status === IntentStatus.Succeeded && isCurrentGeneration) succeeded += 1;
      else if (status === IntentStatus.Succeeded) superseded += 1;
      else if (isCurrentGeneration) failed += 1;
      else superseded += 1;
    }
    await this.cascadeBlockedBy(executor, settledIds, settlement);
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
    if (result) {
      await this.cascadeBlockedBy(executor, [intentId], settlement);
    }
    return result !== undefined;
  }

  private async cascadeBlockedBy(
    executor: IntentExecutor,
    predecessorIds: readonly string[],
    settlement: PhysicalSettlement,
  ): Promise<void> {
    if (predecessorIds.length === 0) return;
    const dependents = await executor
      .selectFrom('control.intents')
      .select(['id', 'resource_type', 'resource_id', 'server_id'])
      .where('blocked_by_intent_id', 'in', [...predecessorIds])
      .where('status', '=', IntentStatus.Pending)
      .forUpdate()
      .execute();
    if (dependents.length === 0) return;
    if (settlement.outcome === 'failed') {
      const cascadeFailure = boundedFailure({
        code: 'VOLUME_PLACEMENT_FAILED',
        message: 'A required volume placement failed before this intent could run',
        details: { blockedByIntentIds: [...predecessorIds] },
      });
      for (const dependent of dependents) {
        await executor
          .updateTable('control.intents')
          .set({
            status: IntentStatus.Failed,
            failure_code: cascadeFailure.code,
            failure_json: JSON.stringify(cascadeFailure),
            next_attempt_at: null,
            settled_at: sql<Date>`clock_timestamp()`,
          })
          .where('id', '=', dependent.id)
          .where('status', '=', IntentStatus.Pending)
          .execute();
      }
    }
    const seen = new Set<string>();
    for (const dependent of dependents) {
      const key = `${dependent.resource_type}:${dependent.resource_id}:${dependent.server_id ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const payload = {
        resourceType: dependent.resource_type,
        resourceId: dependent.resource_id,
        serverId: dependent.server_id,
      };
      await this.notifyReconcile(executor, payload);
      this.wake?.wake({
        ...payload,
        reason: 'intent',
      });
    }
  }

  private async notifyReconcile(
    executor: IntentExecutor,
    payload: { resourceType: IntentResource; resourceId: string; serverId: string | null },
  ): Promise<void> {
    await sql`SELECT pg_notify(
      'nyabase_reconcile',
      ${JSON.stringify(payload).slice(0, 1800)}
    )`.execute(executor);
  }

  private async assertRetryable(
    sourceIntentId: string,
    executor: IntentExecutor,
  ): Promise<void> {
    const source = await executor
      .selectFrom('control.intents')
      .select(['id', 'status'])
      .where('id', '=', sourceIntentId)
      .executeTakeFirst();
    if (!source) throw new Error('Intent to retry was not found');
    if (source.status !== IntentStatus.Failed) {
      throw new Error('Only failed intents can be retried');
    }
  }
}

export function intentKindResources(): Readonly<Record<TypedIntentKind, readonly IntentResource[]>> {
  return KIND_RESOURCES;
}
