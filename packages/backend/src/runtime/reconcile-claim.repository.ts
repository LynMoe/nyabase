import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { IntentResourceType } from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { retryPgTransaction } from '../persistence-pg/transaction.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import type { IntentResource } from './intent.repository.js';

export const RECONCILE_CLAIM_REPOSITORY = Symbol('RECONCILE_CLAIM_REPOSITORY');

export type ClaimExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

export const RECONCILE_LEASE_MS = 60_000;
export const RECONCILE_RENEWAL_MS = 20_000;
export const MAX_ACTIVE_CLAIMS_PER_SERVER = 8;
export const NO_PLACEMENT_SERVER_ID = '00000000-0000-4000-8000-000000000000';

export interface ClaimInput {
  readonly resourceType: IntentResource;
  readonly resourceId: string;
  readonly placementServerId: string;
  readonly serverId?: string | null;
  readonly workerId: string;
}

export interface ReconcileClaim {
  readonly resourceType: IntentResource;
  readonly resourceId: string;
  readonly placementServerId: string;
  readonly serverId: string | null;
  readonly workerId: string;
  readonly leaseExpiresAt: Date;
  readonly claimedAt: Date;
}

export interface LeaseGuard {
  readonly claim: ReconcileClaim;
  readonly lost: boolean;
  renew(): Promise<boolean>;
  assertOwned(): void;
  stop(): void;
}

function assertUuid(value: string, label: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    && !/^[0-9a-f]{32}$/i.test(value)
  ) {
    throw new Error(`${label} must be a UUID`);
  }
}

function mapClaim(row: {
  resource_type: IntentResource;
  resource_id: string;
  placement_server_id: string;
  server_id: string | null;
  worker_id: string;
  lease_expires_at: Date | string;
  claimed_at: Date | string;
}): ReconcileClaim {
  return {
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    placementServerId: row.placement_server_id,
    serverId: row.server_id,
    workerId: row.worker_id,
    leaseExpiresAt: new Date(row.lease_expires_at),
    claimedAt: new Date(row.claimed_at),
  };
}

@Injectable()
export class ReconcileClaimRepository {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  claim(input: ClaimInput, executor?: ClaimExecutor): Promise<ReconcileClaim | null> {
    if (!isReconcileResourceType(input.resourceType)) {
      throw new Error(`Unsupported reconcile resource type: ${input.resourceType}`);
    }
    assertUuid(input.resourceId, 'Claim resource id');
    assertUuid(input.placementServerId, 'Claim placement server id');
    if (input.serverId) assertUuid(input.serverId, 'Claim server id');
    if (!input.workerId || input.workerId.length > 128) {
      throw new Error('Claim worker id must be between 1 and 128 characters');
    }
    if (executor) return this.claimInTransaction(input, executor);
    return retryPgTransaction(
      () => this.database
        .transaction()
        .setIsolationLevel('serializable')
        .execute((transaction) => this.claimInTransaction(input, transaction)),
      { maxAttempts: 5, retryBaseDelayMs: 5 },
    );
  }

  private async claimInTransaction(
    input: ClaimInput,
    executor: ClaimExecutor,
  ): Promise<ReconcileClaim | null> {
    if (input.serverId) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reconcile-server:${input.serverId}`}, 0))`
        .execute(executor);
    }
    const placementLock = `reconcile-placement:${input.resourceType}:${input.resourceId}:${input.placementServerId}`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${placementLock}, 0))`.execute(executor);
    const current = await executor
      .selectFrom('control.reconcile_claims')
      .selectAll()
      .where('resource_type', '=', input.resourceType)
      .where('resource_id', '=', input.resourceId)
      .where('placement_server_id', '=', input.placementServerId)
      .forUpdate()
      .executeTakeFirst();

    if (current) {
      const active = new Date(current.lease_expires_at).getTime() > Date.now();
      if (active && current.worker_id !== input.workerId) return null;
      if (active) {
        const renewed = await executor
          .updateTable('control.reconcile_claims')
          .set({
            lease_expires_at: sql<Date>`clock_timestamp() + interval '60 seconds'`,
          })
          .where('resource_type', '=', input.resourceType)
          .where('resource_id', '=', input.resourceId)
          .where('placement_server_id', '=', input.placementServerId)
          .where('worker_id', '=', input.workerId)
          .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
          .returningAll()
          .executeTakeFirst();
        return renewed ? mapClaim(renewed) : null;
      }
      if (await this.serverAtCapacity(input.serverId ?? null, executor)) {
        return null;
      }
      const recycled = await executor
        .updateTable('control.reconcile_claims')
        .set({
          server_id: input.serverId ?? null,
          worker_id: input.workerId,
          lease_expires_at: sql<Date>`clock_timestamp() + interval '60 seconds'`,
          claimed_at: sql<Date>`clock_timestamp()`,
        })
        .where('resource_type', '=', input.resourceType)
        .where('resource_id', '=', input.resourceId)
        .where('placement_server_id', '=', input.placementServerId)
        .where('lease_expires_at', '<=', sql<Date>`clock_timestamp()`)
        .returningAll()
        .executeTakeFirst();
      return recycled ? mapClaim(recycled) : null;
    }

    if (await this.serverAtCapacity(input.serverId ?? null, executor)) {
      return null;
    }
    const inserted = await executor
      .insertInto('control.reconcile_claims')
      .values({
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        placement_server_id: input.placementServerId,
        server_id: input.serverId ?? null,
        worker_id: input.workerId,
        lease_expires_at: sql<Date>`clock_timestamp() + interval '60 seconds'`,
        claimed_at: sql<Date>`clock_timestamp()`,
      })
      .onConflict((conflict) => conflict
        .columns(['resource_type', 'resource_id', 'placement_server_id'])
        .doNothing())
      .returningAll()
      .executeTakeFirst();
    return inserted ? mapClaim(inserted) : null;
  }

  private async serverAtCapacity(
    serverId: string | null,
    executor: ClaimExecutor,
  ): Promise<boolean> {
    if (!serverId) return false;
    const result = await executor
      .selectFrom('control.reconcile_claims')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('server_id', '=', serverId)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirstOrThrow();
    return Number(result.count) >= MAX_ACTIVE_CLAIMS_PER_SERVER;
  }

  async renew(
    input: Pick<ClaimInput, 'resourceType' | 'resourceId' | 'placementServerId' | 'workerId'>,
    executor: ClaimExecutor = this.database,
  ): Promise<ReconcileClaim | null> {
    const row = await executor
      .updateTable('control.reconcile_claims')
      .set({ lease_expires_at: sql<Date>`clock_timestamp() + interval '60 seconds'` })
      .where('resource_type', '=', input.resourceType)
      .where('resource_id', '=', input.resourceId)
      .where('placement_server_id', '=', input.placementServerId)
      .where('worker_id', '=', input.workerId)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .returningAll()
      .executeTakeFirst();
    return row ? mapClaim(row) : null;
  }

  async release(
    input: Pick<ClaimInput, 'resourceType' | 'resourceId' | 'placementServerId' | 'workerId'>,
    executor: ClaimExecutor = this.database,
  ): Promise<boolean> {
    const result = await executor
      .deleteFrom('control.reconcile_claims')
      .where('resource_type', '=', input.resourceType)
      .where('resource_id', '=', input.resourceId)
      .where('placement_server_id', '=', input.placementServerId)
      .where('worker_id', '=', input.workerId)
      .returning('resource_id')
      .executeTakeFirst();
    return result !== undefined;
  }

  async reapExpired(executor: ClaimExecutor = this.database): Promise<number> {
    const result = await executor
      .deleteFrom('control.reconcile_claims')
      .where('lease_expires_at', '<=', sql<Date>`clock_timestamp()`)
      .returning('resource_id')
      .execute();
    return result.length;
  }

  startLeaseGuard(claim: ReconcileClaim): LeaseGuard {
    let current = claim;
    let lost = false;
    let timer: NodeJS.Timeout | undefined;
    const renew = async (): Promise<boolean> => {
      if (lost) return false;
      const next = await this.renew({
        resourceType: current.resourceType,
        resourceId: current.resourceId,
        placementServerId: current.placementServerId,
        workerId: current.workerId,
      });
      if (!next) {
        lost = true;
        return false;
      }
      current = next;
      return true;
    };
    timer = setInterval(() => {
      void renew().catch(() => {
        lost = true;
      });
    }, RECONCILE_RENEWAL_MS);
    timer.unref?.();
    return {
      get claim() {
        return current;
      },
      get lost() {
        return lost;
      },
      renew,
      assertOwned(): void {
        if (lost) throw new Error('RECONCILE_LEASE_LOST');
      },
      stop(): void {
        if (timer) clearInterval(timer);
        timer = undefined;
      },
    };
  }

  async withLease<T>(
    claim: ReconcileClaim,
    operation: (guard: LeaseGuard) => Promise<T>,
  ): Promise<T> {
    const guard = this.startLeaseGuard(claim);
    try {
      return await operation(guard);
    } finally {
      guard.stop();
      await this.release({
        resourceType: claim.resourceType,
        resourceId: claim.resourceId,
        placementServerId: claim.placementServerId,
        workerId: claim.workerId,
      });
    }
  }
}

export function isReconcileResourceType(value: string): value is IntentResource {
  return (Object.values(IntentResourceType) as string[]).includes(value);
}

