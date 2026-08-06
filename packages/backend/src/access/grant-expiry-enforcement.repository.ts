import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';

/** Lease long enough for stop/purge enqueue, not full container drain. */
export const GRANT_EXPIRY_CLAIM_LEASE_MS = 3 * 60_000;

export type GrantExpiryClaimPhase = 'grace' | 'lost';

export interface GrantExpiryClaim {
  userId: string;
  serverId: string;
  coveringExpiresAt: Date;
  claimToken: string;
  phase: GrantExpiryClaimPhase;
}

/**
 * Multi-replica-safe lease claims for grant-expiry one-shot work.
 * Matches the outbox/finalizer pattern: claim_token + claimed_by + lease_expires_at.
 */
@Injectable()
export class GrantExpiryEnforcementRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
  ) {}

  async ensureRow(
    userId: string,
    serverId: string,
    coveringExpiresAt: Date,
  ): Promise<void> {
    await sql`
      INSERT INTO control.grant_expiry_enforcement (
        user_id, server_id, covering_expires_at
      ) VALUES (
        ${userId}::uuid, ${serverId}, ${coveringExpiresAt}
      )
      ON CONFLICT (user_id, server_id, covering_expires_at) DO NOTHING
    `.execute(this.database);
  }

  /**
   * Atomically reserve in-flight work. Returns null when already completed or
   * another worker holds an unexpired lease.
   */
  async claim(
    phase: GrantExpiryClaimPhase,
    userId: string,
    serverId: string,
    coveringExpiresAt: Date,
    workerId: string,
    leaseMs = GRANT_EXPIRY_CLAIM_LEASE_MS,
  ): Promise<GrantExpiryClaim | null> {
    await this.ensureRow(userId, serverId, coveringExpiresAt);
    const claimToken = randomUUID();
    const row = phase === 'grace'
      ? await sql<{ claim_token: string; covering_expires_at: Date }>`
          UPDATE control.grant_expiry_enforcement
          SET
            claim_token = ${claimToken}::uuid,
            claimed_by = ${workerId},
            lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
            updated_at = clock_timestamp()
          WHERE user_id = ${userId}::uuid
            AND server_id = ${serverId}
            AND covering_expires_at = ${coveringExpiresAt}
            AND grace_stopped_at IS NULL
            AND (
              claim_token IS NULL
              OR lease_expires_at <= clock_timestamp()
            )
          RETURNING claim_token, covering_expires_at
        `.execute(this.database)
      : await sql<{ claim_token: string; covering_expires_at: Date }>`
          UPDATE control.grant_expiry_enforcement
          SET
            claim_token = ${claimToken}::uuid,
            claimed_by = ${workerId},
            lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
            updated_at = clock_timestamp()
          WHERE user_id = ${userId}::uuid
            AND server_id = ${serverId}
            AND covering_expires_at = ${coveringExpiresAt}
            AND purged_at IS NULL
            AND (
              claim_token IS NULL
              OR lease_expires_at <= clock_timestamp()
            )
          RETURNING claim_token, covering_expires_at
        `.execute(this.database);
    const claimed = row.rows[0];
    if (!claimed) return null;
    return {
      userId,
      serverId,
      coveringExpiresAt: claimed.covering_expires_at,
      claimToken: claimed.claim_token,
      phase,
    };
  }

  /**
   * Complete grace stop while holding claim_token. Returns true when this
   * claim won completion (caller should write GrantExpired in the same TX).
   */
  async completeGraceInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    claim: GrantExpiryClaim,
  ): Promise<boolean> {
    const result = await transaction
      .updateTable('control.grant_expiry_enforcement')
      .set({
        grace_stopped_at: sql`clock_timestamp()`,
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
        updated_at: sql`clock_timestamp()`,
      })
      .where('user_id', '=', claim.userId)
      .where('server_id', '=', claim.serverId)
      .where('covering_expires_at', '=', claim.coveringExpiresAt)
      .where('claim_token', '=', claim.claimToken)
      .where('grace_stopped_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  /**
   * Complete lost purge while holding claim_token.
   */
  async completeLostInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    claim: GrantExpiryClaim,
  ): Promise<boolean> {
    const result = await transaction
      .updateTable('control.grant_expiry_enforcement')
      .set({
        purged_at: sql`clock_timestamp()`,
        claim_token: null,
        claimed_by: null,
        lease_expires_at: null,
        updated_at: sql`clock_timestamp()`,
      })
      .where('user_id', '=', claim.userId)
      .where('server_id', '=', claim.serverId)
      .where('covering_expires_at', '=', claim.coveringExpiresAt)
      .where('claim_token', '=', claim.claimToken)
      .where('purged_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async completeLost(claim: GrantExpiryClaim): Promise<boolean> {
    return this.transactions.run((transaction) =>
      this.completeLostInTransaction(transaction, claim));
  }

  /** True when incomplete and no unexpired foreign lease is held. */
  static isDueForWork(
    phase: GrantExpiryClaimPhase,
    row: {
      grace_stopped_at: Date | null;
      purged_at: Date | null;
      claim_token: string | null;
      lease_expires_at: Date | null;
    } | undefined,
    now: Date,
  ): boolean {
    if (phase === 'grace') {
      if (row?.grace_stopped_at != null) return false;
    } else if (row?.purged_at != null) {
      return false;
    }
    if (row?.claim_token == null) return true;
    const lease = row.lease_expires_at;
    if (lease == null) return true;
    return lease.getTime() <= now.getTime();
  }
}
