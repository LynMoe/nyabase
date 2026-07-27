import { Inject, Injectable } from '@nestjs/common';
import type {
  Kysely,
  RawBuilder,
  Selectable,
  Transaction,
} from 'kysely';
import { sql } from 'kysely';
import type { AuditAction, AuditResourceSnapshotDto } from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import type { AuditEventTable } from './audit-database.types.js';

const RETENTION_BATCH_SIZE = 1_000;
const RETENTION_ADVISORY_LOCK = 1_856_214_885;
const RETENTION_ADVISORY_KEY = 4;
export const MAX_AUDIT_OFFSET = 100_000;

export type AuditExecutor =
  | Kysely<NyabaseDatabase>
  | Transaction<NyabaseDatabase>;

export interface AuditEvent {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorUsername: string | null;
  actorSnapshot: AuditResourceSnapshotDto | null;
  action: string;
  targetId: string | null;
  targetType: string | null;
  targetName: string | null;
  targetSnapshot: AuditResourceSnapshotDto | null;
  related: AuditResourceSnapshotDto[];
  payload: unknown;
  ts: Date;
}

export interface AppendAuditEvent {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorUsername: string | null;
  actorSnapshot: AuditResourceSnapshotDto | null;
  action: AuditAction;
  targetId: string | null;
  targetType: string | null;
  targetName: string | null;
  targetSnapshot: AuditResourceSnapshotDto | null;
  related: AuditResourceSnapshotDto[];
  payload: unknown;
}

export interface AuditListFilter {
  action?: string;
  actorId?: string;
  targetId?: string;
  targetType?: string;
}

export interface AuditPage {
  items: AuditEvent[];
  total: number;
}

@Injectable()
export class AuditRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
  ) {}

  async append(
    executor: AuditExecutor,
    event: AppendAuditEvent,
  ): Promise<AuditEvent> {
    return this.insert(executor, event, sql<Date>`clock_timestamp()`);
  }

  /** Test-only deterministic clock override; production callers use append(). */
  appendAtForTest(
    executor: AuditExecutor,
    event: AppendAuditEvent,
    occurredAt: Date,
  ): Promise<AuditEvent> {
    return this.insert(executor, event, occurredAt);
  }

  private async insert(
    executor: AuditExecutor,
    event: AppendAuditEvent,
    occurredAt: Date | RawBuilder<Date>,
  ): Promise<AuditEvent> {
    const row = await executor
      .insertInto('audit.events')
      .values({
        id: event.id,
        actor_id: event.actorId,
        actor_name: event.actorName,
        actor_username: event.actorUsername,
        actor_snapshot: json(event.actorSnapshot),
        action: event.action,
        target_id: event.targetId,
        target_type: event.targetType,
        target_name: event.targetName,
        target_snapshot: json(event.targetSnapshot),
        related: json(event.related)!,
        detail: json(event.payload),
        occurred_at: occurredAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAuditEvent(row);
  }

  async list(
    limit: number,
    offset: number,
    filter: AuditListFilter = {},
  ): Promise<AuditPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_AUDIT_OFFSET) {
      throw new RangeError(`audit offset must be between 0 and ${MAX_AUDIT_OFFSET}`);
    }
    let itemsQuery = this.database
      .selectFrom('audit.events')
      .selectAll();
    let countQuery = this.database
      .selectFrom('audit.events')
      .select((expression) => expression.fn.countAll<string>().as('count'));

    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) continue;
      const column = filterColumn(key as keyof AuditListFilter);
      itemsQuery = itemsQuery.where(column, '=', value);
      countQuery = countQuery.where(column, '=', value);
    }

    const [rows, count] = await Promise.all([
      itemsQuery
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map(toAuditEvent),
      total: Number(count.count),
    };
  }

  async findById(id: string): Promise<AuditEvent | null> {
    const row = await this.database
      .selectFrom('audit.events')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toAuditEvent(row) : null;
  }

  enforceRetention(options: {
    retentionDays: number;
    maxEntries: number;
    enforceAge: boolean;
    enforceCount: boolean;
  }): Promise<void> {
    return this.enforceRetentionWithClock(options);
  }

  /** Test-only deterministic clock override; production uses PostgreSQL time. */
  enforceRetentionAtForTest(
    options: {
      retentionDays: number;
      maxEntries: number;
      enforceAge: boolean;
      enforceCount: boolean;
    },
    now: Date,
  ): Promise<void> {
    return this.enforceRetentionWithClock(options, now);
  }

  private enforceRetentionWithClock(
    options: {
      retentionDays: number;
      maxEntries: number;
      enforceAge: boolean;
      enforceCount: boolean;
    },
    nowOverride?: Date,
  ): Promise<void> {
    return this.transactions.run(async (transaction) => {
      await sql`select pg_advisory_xact_lock(
        ${RETENTION_ADVISORY_LOCK},
        ${RETENTION_ADVISORY_KEY}
      )`.execute(transaction);

      const now = nowOverride ?? await this.databaseClock(transaction);
      let remainingBatch = RETENTION_BATCH_SIZE;
      if (options.enforceAge && options.retentionDays > 0) {
        const cutoff = new Date(
          now.getTime() - options.retentionDays * 24 * 60 * 60 * 1_000,
        );
        const expired = await transaction
          .selectFrom('audit.events')
          .select('id')
          .where('occurred_at', '<', cutoff)
          .orderBy('occurred_at', 'asc')
          .orderBy('id', 'asc')
          .limit(remainingBatch)
          .forUpdate()
          .skipLocked()
          .execute();
        if (expired.length > 0) {
          await transaction
            .deleteFrom('audit.events')
            .where('id', 'in', expired.map((row) => row.id))
            .execute();
          remainingBatch -= expired.length;
        }
      }

      if (
        remainingBatch <= 0
        || !options.enforceCount
        || options.maxEntries <= 0
      ) return;
      const countRow = await transaction
        .selectFrom('audit.events')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow();
      const overflow = Number(countRow.count) - options.maxEntries;
      if (overflow <= 0) return;
      const ids = await transaction
        .selectFrom('audit.events')
        .select('id')
        .orderBy('occurred_at', 'asc')
        .orderBy('id', 'asc')
        .limit(Math.min(remainingBatch, overflow))
        .forUpdate()
        .skipLocked()
        .execute();
      if (ids.length === 0) return;
      await transaction
        .deleteFrom('audit.events')
        .where('id', 'in', ids.map((row) => row.id))
        .execute();
    });
  }

  private async databaseClock(
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<Date> {
    const result = await sql<{ now: Date }>`
      SELECT clock_timestamp() AS now
    `.execute(transaction);
    const now = result.rows[0]?.now;
    if (!(now instanceof Date)) {
      throw new Error('PostgreSQL clock returned an invalid audit timestamp');
    }
    return now;
  }
}

function filterColumn(
  key: keyof AuditListFilter,
): 'action' | 'actor_id' | 'target_id' | 'target_type' {
  switch (key) {
    case 'action': return 'action';
    case 'actorId': return 'actor_id';
    case 'targetId': return 'target_id';
    case 'targetType': return 'target_type';
  }
}

function toAuditEvent(row: Selectable<AuditEventTable>): AuditEvent {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorUsername: row.actor_username,
    actorSnapshot: snapshot(row.actor_snapshot),
    action: row.action,
    targetId: row.target_id,
    targetType: row.target_type,
    targetName: row.target_name,
    targetSnapshot: snapshot(row.target_snapshot),
    related: snapshots(row.related),
    payload: row.detail,
    ts: asDate(row.occurred_at),
  };
}

function snapshots(value: unknown): AuditResourceSnapshotDto[] {
  return Array.isArray(value)
    ? value
      .map(snapshot)
      .filter((entry): entry is AuditResourceSnapshotDto => entry !== null)
    : [];
}

function snapshot(value: unknown): AuditResourceSnapshotDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === 'string' ? record.id : null,
    type: typeof record.type === 'string' ? record.type : null,
    name: typeof record.name === 'string' ? record.name : null,
    labels: labels(record.labels),
  };
}

function labels(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === 'string'
      || typeof entry === 'number'
      || typeof entry === 'boolean'
      || entry === null
    ) output[key] = entry;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}
