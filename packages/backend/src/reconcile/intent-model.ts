import { Buffer } from 'node:buffer';
import type { Kysely, Transaction } from 'kysely';
import {
  ADMIN_INTENT_LIST_MAX,
  IntentKind,
  IntentResourceType,
  IntentStatus,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

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
  readonly targetRevision: number;
  readonly baseline: Record<string, unknown> | null;
  readonly status: IntentState;
  readonly failureCode: string | null;
  readonly failure: IntentFailure | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

export interface CreatePendingIntentInput {
  readonly id?: string;
  readonly kind: TypedIntentKind;
  readonly resourceType: IntentResource;
  readonly resourceId: string;
  readonly serverId?: string | null;
  readonly requestedBy?: string | null;
  readonly request?: Record<string, unknown> | null;
  readonly targetRevision: number;
  readonly baseline?: Record<string, unknown> | null;
  readonly nextAttemptAt?: Date | string | null;
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
  readonly requestedBy?: string;
  readonly readyAt?: Date;
}

export interface IntentSettleResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly superseded: number;
}

export interface SettleOptions {
  /**
   * Pending intents this sweep must leave alone because their domain settles
   * them individually (for example a restart, which needs its own proof).
   */
  readonly keep?: (intent: {
    readonly kind: string;
    readonly request: Record<string, unknown> | null;
  }) => boolean;
}

export interface PhysicalSettlement {
  readonly outcome: 'succeeded' | 'failed';
  readonly failure?: IntentFailure;
  readonly placementServerId?: string | null;
}

export const KIND_RESOURCES: Readonly<Record<TypedIntentKind, readonly IntentResource[]>> = {
  [IntentKind.ContainerCreate]: [IntentResourceType.Container],
  [IntentKind.ContainerUpdate]: [IntentResourceType.Container],
  [IntentKind.ContainerPower]: [IntentResourceType.Container],
  [IntentKind.ContainerDelete]: [IntentResourceType.Container],
  [IntentKind.VolumeEnsure]: [IntentResourceType.Volume],
  [IntentKind.VolumeResize]: [IntentResourceType.Volume],
  [IntentKind.VolumeDestroy]: [IntentResourceType.Volume],
  [IntentKind.ImageAssignmentEnsure]: [IntentResourceType.ImageAssignment],
  [IntentKind.ImageAssignmentDelete]: [IntentResourceType.ImageAssignment],
  [IntentKind.ServerPreflight]: [IntentResourceType.Server],
};

export const MAX_PAGE_SIZE = ADMIN_INTENT_LIST_MAX;
const MAX_JSON_BYTES = 8 * 1024;
const MAX_JSON_DEPTH = 5;
const MAX_JSON_KEYS = 64;

export function isUserRetryIntent(
  request: Record<string, unknown> | null | undefined,
): boolean {
  return typeof request?.retryOf === 'string' && request.retryOf.length > 0;
}

export function assertKindResource(kind: TypedIntentKind, resourceType: IntentResource): void {
  if (!Object.prototype.hasOwnProperty.call(KIND_RESOURCES, kind)) {
    throw new Error(`Unsupported intent kind: ${kind}`);
  }
  if (!KIND_RESOURCES[kind].includes(resourceType)) {
    throw new Error(`Intent kind ${kind} cannot target ${resourceType}`);
  }
}

export function assertResourceType(resourceType: IntentResource): void {
  if (!(Object.values(IntentResourceType) as string[]).includes(resourceType)) {
    throw new Error(`Unsupported intent resource type: ${resourceType}`);
  }
}

export function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Intent target revision must be a positive safe integer');
  }
}

export function assertUuidLike(value: string, label: string): void {
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

export function boundedJsonObject(
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

export function intentFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): IntentFailure {
  return { code, message, details };
}

export function boundedFailure(failure: IntentFailure): IntentFailure {
  const code = String(failure.code).slice(0, 128);
  const message = String(failure.message).slice(0, 4096);
  const details = boundedJsonObject(failure.details) ?? {};
  const result: IntentFailure = { code, message, details };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_JSON_BYTES) return result;
  return { code, message: message.slice(0, 1024), details: { truncated: true } };
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8')
    .toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
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

export function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function objectValue(value: unknown): Record<string, unknown> | null {
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

export function intentIdempotencyKey(targetRevision: number, request: unknown): string {
  const object = objectValue(request);
  const explicit = object?.idempotencyKey;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return `key:${explicit}`;
  }
  const desiredHash = object?.desiredHash;
  if (typeof desiredHash === 'string' && desiredHash.length > 0) {
    return `hash:${desiredHash}`;
  }
  return `revision:${targetRevision}`;
}

export function mapFailure(
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

export function mapRow(row: {
  id: string;
  kind: string;
  resource_type: IntentResource;
  resource_id: string;
  server_id: string | null;
  requested_by: string | null;
  request_json: unknown;
  target_revision: number;
  baseline_json: unknown;
  status: IntentState;
  failure_code: string | null;
  failure_json: unknown;
  attempt_count: number;
  next_attempt_at: Date | string | null;
  created_at: Date | string;
  settled_at: Date | string | null;
}): IntentRecord {
  return {
    id: row.id,
    kind: row.kind as TypedIntentKind,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    serverId: row.server_id,
    requestedBy: row.requested_by,
    request: objectValue(row.request_json),
    targetRevision: row.target_revision,
    baseline: objectValue(row.baseline_json),
    status: row.status,
    failureCode: row.failure_code,
    failure: mapFailure(row.failure_code, row.failure_json),
    attemptCount: row.attempt_count,
    nextAttemptAt: asDate(row.next_attempt_at)?.toISOString() ?? null,
    createdAt: asDate(row.created_at)?.toISOString() ?? new Date(0).toISOString(),
    settledAt: asDate(row.settled_at)?.toISOString() ?? null,
  };
}
