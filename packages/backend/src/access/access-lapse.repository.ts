import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import { GRANT_EXPIRY_GRACE_DAYS } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { AccessLapseResourceKind } from '../platform/persistence-pg/iam-authorization-database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { lockIamPolicy } from '../iam/administration.js';
import { hasGrantCoverage } from '../iam/effective-access.js';

export const ACCESS_LAPSE_GRACE_MS = GRANT_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000;

export interface LapseKey {
  userId: string;
  kind: AccessLapseResourceKind;
  resourceId: string;
}

/** A (user, resource) pair on which the user owns containers or volumes. */
export interface LapseCandidate extends LapseKey {
  /** The user currently holds merged coverage of the resource. */
  covered: boolean;
  /** Latest past `expires_at` of the (expired) merged coverage, if there is one. */
  expiredAt: Date | null;
  /** The ledger row, when the pair is in grace. */
  lapse: { lapsedAt: Date; stoppedAt: Date | null; purgedAt: Date | null } | null;
  /** Database clock at the time of the scan. */
  now: Date;
}

export function purgeDeadline(lapsedAt: Date): Date {
  return new Date(lapsedAt.getTime() + ACCESS_LAPSE_GRACE_MS);
}

/** What the processor still has to do for a candidate, in order of urgency. */
export type LapseWork = 'clear' | 'lapse' | 'stop' | 'purge' | 'none';

export function lapseWork(candidate: LapseCandidate): LapseWork {
  if (candidate.covered) return candidate.lapse ? 'clear' : 'none';
  if (!candidate.lapse) return 'lapse';
  const due = candidate.now.getTime() >= purgeDeadline(candidate.lapse.lapsedAt).getTime();
  if (due) return candidate.lapse.purgedAt === null ? 'purge' : 'none';
  return candidate.lapse.stoppedAt === null ? 'stop' : 'none';
}

/**
 * Every (user, resource) on which a user owns something: containers and local
 * volumes on a server, volumes on a storage pool, volumes on a shared backend.
 */
const OWNED = sql`
  SELECT DISTINCT user_id, kind, resource_id FROM (
    SELECT owner_id AS user_id, 'server' AS kind, server_id AS resource_id
    FROM control.containers
    UNION ALL
    SELECT owner_id, 'server', server_id
    FROM control.volumes WHERE shared_backend_id IS NULL AND server_id IS NOT NULL
    UNION ALL
    SELECT owner_id, 'storage_pool', pool_id
    FROM control.volumes WHERE shared_backend_id IS NULL AND pool_id IS NOT NULL
    UNION ALL
    SELECT owner_id, 'shared_backend', shared_backend_id
    FROM control.volumes WHERE shared_backend_id IS NOT NULL
  ) AS owned_rows
`;

interface CandidateRow {
  user_id: string;
  kind: AccessLapseResourceKind;
  resource_id: string;
  covered: boolean;
  expired_at: Date | null;
  lapsed_at: Date | null;
  stopped_at: Date | null;
  purged_at: Date | null;
  now: Date;
}

/**
 * Reads and writes the grace ledger (`control.access_lapses`). The ledger row
 * is the only state: `lapsed_at` is fixed when the row is created and never
 * moves; the row disappears when coverage returns or nothing is owned any more.
 */
@Injectable()
export class AccessLapseRepository {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
  ) {}

  /** Ledger rows for pairs that own nothing any more (resources purged or deleted). */
  async deleteStale(): Promise<number> {
    const result = await sql`
      DELETE FROM control.access_lapses AS lapse
      WHERE NOT EXISTS (
        SELECT 1 FROM (${OWNED}) AS owned
        WHERE owned.user_id = lapse.user_id
          AND owned.kind = lapse.resource_kind
          AND owned.resource_id = lapse.resource_id
      )
    `.execute(this.database);
    return Number(result.numAffectedRows ?? 0);
  }

  /** Pairs that are uncovered or already in grace, most overdue first. */
  async scan(): Promise<LapseCandidate[]> {
    return this.candidates(sql`WHERE NOT candidate.covered OR candidate.lapsed_at IS NOT NULL`);
  }

  /** Fresh state of one pair, or null when the user no longer owns anything on it. */
  async inspect(key: LapseKey): Promise<LapseCandidate | null> {
    const rows = await this.candidates(sql`
      WHERE candidate.user_id = ${key.userId}::uuid
        AND candidate.kind = ${key.kind}
        AND candidate.resource_id = ${key.resourceId}::uuid
    `);
    return rows[0] ?? null;
  }

  private async candidates(filter: RawBuilder<unknown>): Promise<LapseCandidate[]> {
    const result = await sql<CandidateRow>`
      WITH coverage AS (
        SELECT user_id, 'server' AS kind, server_id AS resource_id, expires_at
        FROM iam.merged_server_access
        UNION ALL
        SELECT user_id, 'storage_pool', pool_id, expires_at FROM iam.effective_pool_access
        UNION ALL
        SELECT user_id, 'shared_backend', shared_backend_id, expires_at
        FROM iam.merged_shared_backend_access
      ), candidate AS (
        SELECT owned.user_id, owned.kind, owned.resource_id,
               (coverage.user_id IS NOT NULL
                 AND (coverage.expires_at IS NULL OR coverage.expires_at > now())) AS covered,
               CASE WHEN coverage.expires_at <= now() THEN coverage.expires_at END AS expired_at,
               lapse.lapsed_at, lapse.stopped_at, lapse.purged_at
        FROM (${OWNED}) AS owned
        LEFT JOIN coverage
          ON coverage.user_id = owned.user_id
         AND coverage.kind = owned.kind
         AND coverage.resource_id = owned.resource_id
        LEFT JOIN control.access_lapses AS lapse
          ON lapse.user_id = owned.user_id
         AND lapse.resource_kind = owned.kind
         AND lapse.resource_id = owned.resource_id
      )
      SELECT candidate.user_id::text AS user_id, candidate.kind, candidate.resource_id::text AS resource_id,
             candidate.covered, candidate.expired_at, candidate.lapsed_at,
             candidate.stopped_at, candidate.purged_at, clock_timestamp() AS now
      FROM candidate
      ${filter}
      ORDER BY coalesce(candidate.lapsed_at, candidate.expired_at, clock_timestamp()), candidate.user_id,
               candidate.kind, candidate.resource_id
    `.execute(this.database);
    return result.rows.map((row) => ({
      userId: row.user_id,
      kind: row.kind,
      resourceId: row.resource_id,
      covered: row.covered,
      expiredAt: row.expired_at,
      lapse: row.lapsed_at
        ? { lapsedAt: row.lapsed_at, stoppedAt: row.stopped_at, purgedAt: row.purged_at }
        : null,
      now: row.now,
    }));
  }

  /**
   * Opens the grace for an uncovered pair. Coverage is re-read under the IAM
   * lock, so a grant committed since the scan wins. `lapsed_at` is the past
   * `expires_at` when the coverage expired, otherwise the detection time (a
   * revocation); an existing row is never touched. Returns null when the pair
   * is covered after all.
   */
  async openLapse(candidate: LapseCandidate): Promise<NonNullable<LapseCandidate['lapse']> | null> {
    return this.transactions.run(async (transaction) => {
      await lockIamPolicy(transaction);
      if (await this.isCovered(transaction, candidate)) return null;
      await sql`
        INSERT INTO control.access_lapses (user_id, resource_kind, resource_id, lapsed_at)
        VALUES (
          ${candidate.userId}::uuid, ${candidate.kind}, ${candidate.resourceId}::uuid,
          ${candidate.expiredAt ?? sql`clock_timestamp()`}
        )
        ON CONFLICT (user_id, resource_kind, resource_id) DO NOTHING
      `.execute(transaction);
      const row = await transaction.selectFrom('control.access_lapses')
        .select(['lapsed_at', 'stopped_at', 'purged_at'])
        .where('user_id', '=', candidate.userId)
        .where('resource_kind', '=', candidate.kind)
        .where('resource_id', '=', candidate.resourceId)
        .executeTakeFirstOrThrow();
      return { lapsedAt: row.lapsed_at, stoppedAt: row.stopped_at, purgedAt: row.purged_at };
    });
  }

  /** Coverage returned: cancel the grace. Containers stay as they are (not auto-started). */
  async clear(key: LapseKey): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      await lockIamPolicy(transaction);
      if (!await this.isCovered(transaction, key)) return false;
      const result = await transaction.deleteFrom('control.access_lapses')
        .where('user_id', '=', key.userId)
        .where('resource_kind', '=', key.kind)
        .where('resource_id', '=', key.resourceId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    });
  }

  /** Records the one-shot stop; `after` runs in the same transaction (audit). */
  markStopped(
    key: LapseKey,
    after: (transaction: Transaction<NyabaseDatabase>) => Promise<void>,
  ): Promise<boolean> {
    return this.mark(key, 'stopped_at', after);
  }

  markPurged(
    key: LapseKey,
    after: (transaction: Transaction<NyabaseDatabase>) => Promise<void>,
  ): Promise<boolean> {
    return this.mark(key, 'purged_at', after);
  }

  private mark(
    key: LapseKey,
    column: 'stopped_at' | 'purged_at',
    after: (transaction: Transaction<NyabaseDatabase>) => Promise<void>,
  ): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      const result = await transaction.updateTable('control.access_lapses')
        .set({ [column]: sql`clock_timestamp()` })
        .where('user_id', '=', key.userId)
        .where('resource_kind', '=', key.kind)
        .where('resource_id', '=', key.resourceId)
        .where(column, 'is', null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) return false;
      await after(transaction);
      return true;
    });
  }

  /** Coverage by grants, whatever the user's status: disabling never opens a lapse. */
  private isCovered(transaction: Transaction<NyabaseDatabase>, key: LapseKey): Promise<boolean> {
    return hasGrantCoverage(transaction, key);
  }
}
