import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import { GRANT_EXPIRY_GRACE_DAYS } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { AccessLapseResourceKind } from '../platform/persistence-pg/iam-authorization-database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { lockIamPolicy } from '../iam/administration.js';
import {
  resolvePoolAccess,
  resolveServerAccess,
  resolveSharedBackendAccess,
} from '../iam/effective-access.js';

export const ACCESS_LAPSE_GRACE_MS = GRANT_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000;

export interface LapseKey {
  userId: string;
  kind: AccessLapseResourceKind;
  resourceId: string;
}

/** A (user, resource) pair on which the user owns containers or volumes. */
export interface LapseCandidate extends LapseKey {
  /** The user currently holds grant coverage of the resource (effective_*: active user, current grant). */
  covered: boolean;
  /**
   * The lapse is not (or no longer) enforced: on a server, a container of the
   * user there is meant to run; on a pool or backend, a volume of the user
   * there is still attached to a container.
   */
  exposed: boolean;
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
  // Enforce again whenever it is exposed: a container started, or a volume
  // re-attached, during the grace (an administrator override) must not
  // survive until the purge.
  return candidate.lapse.stoppedAt === null || candidate.exposed ? 'stop' : 'none';
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
  exposed: boolean;
  lapsed_at: Date | null;
  stopped_at: Date | null;
  purged_at: Date | null;
  now: Date;
}

/**
 * Reads and writes the grace ledger (`control.access_lapses`). The ledger row
 * is the only state: `lapsed_at` is the detection time, fixed when the row is
 * created and never moved; the row disappears when coverage returns or nothing is owned any more.
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
        -- Current coverage: a current grant held by an active user, so
        -- disabling a user loses coverage like a revocation does.
        SELECT user_id, 'server' AS kind, server_id AS resource_id
        FROM iam.effective_server_access
        UNION ALL
        SELECT user_id, 'storage_pool', pool_id FROM iam.effective_pool_access
        UNION ALL
        SELECT user_id, 'shared_backend', shared_backend_id
        FROM iam.effective_shared_backend_access
      ), exposed AS (
        -- Servers: a container (also one still provisioning) is meant to run.
        SELECT owner_id AS user_id, 'server' AS kind, server_id AS resource_id
        FROM control.containers
        WHERE power_intent = 'running' AND lifecycle_phase IN ('active', 'provisioning')
        UNION
        -- Pools and backends: a volume is attached to a container, running or
        -- not, or is still detaching from one with no intent left to unplug it
        -- (its detach failed: the reconciler deletes the row once it is gone).
        SELECT volume.owner_id, CASE WHEN volume.shared_backend_id IS NULL THEN 'storage_pool' ELSE 'shared_backend' END,
               coalesce(volume.shared_backend_id, volume.pool_id)
        FROM control.volume_attachments AS attachment
        JOIN control.volumes AS volume ON volume.id = attachment.volume_id
        JOIN control.containers AS container ON container.id = attachment.container_id
        WHERE container.lifecycle_phase <> 'deleting'
          AND (attachment.bind_state <> 'detaching' OR NOT EXISTS (
            SELECT 1 FROM control.intents AS intent
            WHERE intent.resource_type = 'container' AND intent.resource_id = container.id
              AND intent.status = 'pending'
          ))
      ), candidate AS (
        SELECT owned.user_id, owned.kind, owned.resource_id,
               (coverage.user_id IS NOT NULL) AS covered,
               (exposed.user_id IS NOT NULL) AS exposed,
               lapse.lapsed_at, lapse.stopped_at, lapse.purged_at
        FROM (${OWNED}) AS owned
        LEFT JOIN coverage
          ON coverage.user_id = owned.user_id
         AND coverage.kind = owned.kind
         AND coverage.resource_id = owned.resource_id
        LEFT JOIN exposed
          ON exposed.user_id = owned.user_id
         AND exposed.kind = owned.kind
         AND exposed.resource_id = owned.resource_id
        LEFT JOIN control.access_lapses AS lapse
          ON lapse.user_id = owned.user_id
         AND lapse.resource_kind = owned.kind
         AND lapse.resource_id = owned.resource_id
      )
      SELECT candidate.user_id::text AS user_id, candidate.kind, candidate.resource_id::text AS resource_id,
             candidate.covered, candidate.exposed, candidate.lapsed_at,
             candidate.stopped_at, candidate.purged_at, clock_timestamp() AS now
      FROM candidate
      ${filter}
      ORDER BY coalesce(candidate.lapsed_at, clock_timestamp()), candidate.user_id,
               candidate.kind, candidate.resource_id
    `.execute(this.database);
    return result.rows.map((row) => ({
      userId: row.user_id,
      kind: row.kind,
      resourceId: row.resource_id,
      covered: row.covered,
      exposed: row.exposed,
      lapse: row.lapsed_at
        ? { lapsedAt: row.lapsed_at, stoppedAt: row.stopped_at, purgedAt: row.purged_at }
        : null,
      now: row.now,
    }));
  }

  /**
   * Opens the grace for an uncovered pair. Coverage is re-read under the IAM
   * lock, so a grant committed since the scan wins. `lapsed_at` is always the
   * detection time (never inferred from old grant rows, which could backdate a
   * revocation and purge at once); an existing row is never touched. Returns
   * null when the pair is covered after all.
   */
  async openLapse(candidate: LapseCandidate): Promise<NonNullable<LapseCandidate['lapse']> | null> {
    return this.transactions.run(async (transaction) => {
      await lockIamPolicy(transaction);
      if (await this.isCovered(transaction, candidate)) return null;
      await sql`
        INSERT INTO control.access_lapses (user_id, resource_kind, resource_id, lapsed_at)
        VALUES (
          ${candidate.userId}::uuid, ${candidate.kind}, ${candidate.resourceId}::uuid,
          clock_timestamp()
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

  /**
   * Runs `purge` (which must only queue its deletes in the given transaction)
   * and records `purged_at`, both in one transaction that first takes the IAM
   * lock and re-reads coverage. A grant committed before the lock is seen and
   * cancels the purge; one committed later waits until every delete is queued
   * (queued deletes cannot be taken back, so the lock must span them). Read
   * committed on purpose: under a snapshot isolation the snapshot would date
   * from before the lock wait and miss a grant committed during it. Returns
   * false when the pair is covered or already purged.
   */
  async purgeIfUncovered(
    key: LapseKey,
    purge: (transaction: Transaction<NyabaseDatabase>) => Promise<void>,
  ): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      await lockIamPolicy(transaction);
      if (await this.isCovered(transaction, key)) return false;
      if (!await this.markIn(transaction, key, 'purged_at')) return false;
      await purge(transaction);
      return true;
    }, { isolationLevel: 'read committed' });
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
    return this.transactions.run(async (transaction) => {
      if (!await this.markIn(transaction, key, 'stopped_at')) return false;
      await after(transaction);
      return true;
    });
  }

  /** Sets the ledger timestamp once; false when the row is gone or already set. */
  private async markIn(
    transaction: Transaction<NyabaseDatabase>,
    key: LapseKey,
    column: 'stopped_at' | 'purged_at',
  ): Promise<boolean> {
    const result = await transaction.updateTable('control.access_lapses')
      .set({ [column]: sql`clock_timestamp()` })
      .where('user_id', '=', key.userId)
      .where('resource_kind', '=', key.kind)
      .where('resource_id', '=', key.resourceId)
      .where(column, 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Coverage right now, read without the IAM lock: a cheap last look before a
   * reversible enforcement (a stop, a detach), so a grant committed since the
   * scan does not hit the user's containers. Irreversible steps re-check under
   * the lock instead (`purgeIfUncovered`).
   */
  isCoveredNow(key: LapseKey): Promise<boolean> {
    return this.isCovered(this.database, key);
  }

  /** Current coverage of the pair (active user holding a current grant). */
  private async isCovered(
    transaction: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>,
    key: LapseKey,
  ): Promise<boolean> {
    const access = key.kind === 'server'
      ? await resolveServerAccess(transaction, key.userId, key.resourceId)
      : key.kind === 'storage_pool'
        ? await resolvePoolAccess(transaction, key.userId, key.resourceId)
        : await resolveSharedBackendAccess(transaction, key.userId, key.resourceId);
    return access !== null;
  }
}
