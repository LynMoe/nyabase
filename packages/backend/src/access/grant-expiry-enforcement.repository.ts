import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import {
  ReconcileClaimRepository,
  type LeaseGuard,
  type ReconcileClaim,
} from '../reconcile/reconcile-claim.repository.js';

export type GrantExpiryClaimPhase = 'grace' | 'lost';

export interface GrantExpiryClaim {
  userId: string;
  serverId: string;
  coveringExpiresAt: Date;
  phase: GrantExpiryClaimPhase;
  lease: LeaseGuard;
}

/**
 * Completion ledger for grant-expiry one-shot work. In-flight ownership is a
 * `reconcile_claims` lease (resource_type grant_expiry, resource_id user,
 * placement server), the same single-owner, expiring, renewable mechanism the
 * reconcile engine uses, so a crashed worker's claim simply expires.
 */
@Injectable()
export class GrantExpiryEnforcementRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly claims: ReconcileClaimRepository,
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
   * Reserve in-flight work for one (user, server) pair. Returns null when the
   * phase already completed or another worker holds an unexpired lease.
   */
  async claim(
    phase: GrantExpiryClaimPhase,
    userId: string,
    serverId: string,
    coveringExpiresAt: Date,
    workerId: string,
  ): Promise<GrantExpiryClaim | null> {
    await this.ensureRow(userId, serverId, coveringExpiresAt);
    const lease = await this.claims.claim({
      resourceType: 'grant_expiry',
      resourceId: userId,
      placementServerId: serverId,
      serverId,
      workerId,
    });
    if (!lease) return null;
    const claim: GrantExpiryClaim = {
      userId,
      serverId,
      coveringExpiresAt,
      phase,
      lease: this.claims.startLeaseGuard(lease),
    };
    const row = await this.database
      .selectFrom('control.grant_expiry_enforcement')
      .select(['grace_stopped_at', 'purged_at'])
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .where('covering_expires_at', '=', coveringExpiresAt)
      .executeTakeFirst();
    if (!GrantExpiryEnforcementRepository.isDueForWork(phase, row)) {
      await this.release(claim);
      return null;
    }
    return claim;
  }

  /** True while this worker still owns the unexpired lease; the row is locked until commit. */
  private async holdsLease(
    transaction: Transaction<NyabaseDatabase>,
    claim: GrantExpiryClaim,
  ): Promise<boolean> {
    const current = claim.lease.claim;
    const row = await transaction
      .selectFrom('control.reconcile_claims')
      .select('worker_id')
      .where('resource_type', '=', current.resourceType)
      .where('resource_id', '=', current.resourceId)
      .where('placement_server_id', '=', current.placementServerId)
      .where('worker_id', '=', current.workerId)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .forUpdate()
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Complete grace stop while holding the lease. Returns true when this claim
   * won completion (caller should write GrantExpired in the same TX).
   */
  async completeGraceInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    claim: GrantExpiryClaim,
  ): Promise<boolean> {
    return this.complete(transaction, claim, 'grace_stopped_at');
  }

  /** Complete lost purge while holding the lease. */
  async completeLostInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    claim: GrantExpiryClaim,
  ): Promise<boolean> {
    return this.complete(transaction, claim, 'purged_at');
  }

  async completeLost(claim: GrantExpiryClaim): Promise<boolean> {
    return this.transactions.run((transaction) =>
      this.completeLostInTransaction(transaction, claim));
  }

  private async complete(
    transaction: Transaction<NyabaseDatabase>,
    claim: GrantExpiryClaim,
    column: 'grace_stopped_at' | 'purged_at',
  ): Promise<boolean> {
    if (!await this.holdsLease(transaction, claim)) return false;
    const result = await transaction
      .updateTable('control.grant_expiry_enforcement')
      .set({
        [column]: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
      })
      .where('user_id', '=', claim.userId)
      .where('server_id', '=', claim.serverId)
      .where('covering_expires_at', '=', claim.coveringExpiresAt)
      .where(column, 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  /** Stop renewing and drop the lease so a failed attempt can be retried on the next pass. */
  async release(claim: GrantExpiryClaim): Promise<void> {
    claim.lease.stop();
    const current: ReconcileClaim = claim.lease.claim;
    await this.claims.release({
      resourceType: current.resourceType,
      resourceId: current.resourceId,
      placementServerId: current.placementServerId,
      workerId: current.workerId,
    });
  }

  /** True while the phase has not been completed for this covering grant. */
  static isDueForWork(
    phase: GrantExpiryClaimPhase,
    row: {
      grace_stopped_at: Date | null;
      purged_at: Date | null;
    } | undefined,
  ): boolean {
    return phase === 'grace'
      ? row?.grace_stopped_at == null
      : row?.purged_at == null;
  }
}
