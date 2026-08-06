import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import {
  GrantExpiryEnforcementRepository,
} from './grant-expiry-enforcement.repository.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

async function seedUser(
  database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
  username: string,
): Promise<string> {
  const id = randomUUID();
  const maxNumeric = await database
    .selectFrom('iam.users')
    .select(({ fn }) => fn.max('numeric_id').as('max'))
    .executeTakeFirst();
  const numericId = Number(maxNumeric?.max ?? 0) + 1;
  await database
    .insertInto('iam.users')
    .values({
      id,
      numeric_id: numericId,
      username,
      password_hash: 'test-hash',
      display_name: username,
      status: 'active',
      auth_version: 0,
      authz_version: 0,
    })
    .execute();
  return id;
}

describePostgres('PostgreSQL grant expiry enforcement leases', () => {
  it('admits exactly one concurrent grace claim and completes by claim token', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new GrantExpiryEnforcementRepository(database, transactions);
      const userId = await seedUser(database, 'expiry-claim-a');
      const serverId = 'srv-expiry-a';
      const coveringExpiresAt = new Date('2026-01-01T00:00:00.000Z');

      const [first, second] = await Promise.all([
        repository.claim('grace', userId, serverId, coveringExpiresAt, 'worker-a'),
        repository.claim('grace', userId, serverId, coveringExpiresAt, 'worker-b'),
      ]);
      const winners = [first, second].filter(Boolean);
      expect(winners).toHaveLength(1);
      const claim = winners[0]!;

      const held = await database
        .selectFrom('control.grant_expiry_enforcement')
        .selectAll()
        .where('user_id', '=', userId)
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow();
      expect(held.claim_token).toBe(claim.claimToken);
      expect(held.grace_stopped_at).toBeNull();

      const completed = await transactions.run((transaction) =>
        repository.completeGraceInTransaction(transaction, claim));
      expect(completed).toBe(true);
      expect(await transactions.run((transaction) =>
        repository.completeGraceInTransaction(transaction, claim))).toBe(false);

      await expect(
        repository.claim('grace', userId, serverId, coveringExpiresAt, 'worker-c'),
      ).resolves.toBeNull();

      const done = await database
        .selectFrom('control.grant_expiry_enforcement')
        .selectAll()
        .where('user_id', '=', userId)
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow();
      expect(done.grace_stopped_at).not.toBeNull();
      expect(done.claim_token).toBeNull();
      expect(done.claimed_by).toBeNull();
      expect(done.lease_expires_at).toBeNull();
    });
  });

  it('allows reclaim after lease expiry and completes lost once', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new GrantExpiryEnforcementRepository(database, transactions);
      const userId = await seedUser(database, 'expiry-claim-b');
      const serverId = 'srv-expiry-b';
      const coveringExpiresAt = new Date('2026-02-01T00:00:00.000Z');

      const first = await repository.claim(
        'lost',
        userId,
        serverId,
        coveringExpiresAt,
        'worker-a',
        50,
      );
      expect(first).not.toBeNull();
      await expect(
        repository.claim('lost', userId, serverId, coveringExpiresAt, 'worker-b', 50),
      ).resolves.toBeNull();

      await sql`
        UPDATE control.grant_expiry_enforcement
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE user_id = ${userId}::uuid
          AND server_id = ${serverId}
      `.execute(database);

      const second = await repository.claim(
        'lost',
        userId,
        serverId,
        coveringExpiresAt,
        'worker-b',
        60_000,
      );
      expect(second).not.toBeNull();
      expect(second!.claimToken).not.toBe(first!.claimToken);

      expect(await repository.completeLost(second!)).toBe(true);
      expect(await repository.completeLost(second!)).toBe(false);
      expect(await repository.completeLost(first!)).toBe(false);

      await expect(
        repository.claim('lost', userId, serverId, coveringExpiresAt, 'worker-c'),
      ).resolves.toBeNull();
    });
  });

  it('isDueForWork respects active leases and completion sentinels', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(GrantExpiryEnforcementRepository.isDueForWork('grace', undefined, now)).toBe(true);
    expect(GrantExpiryEnforcementRepository.isDueForWork('grace', {
      grace_stopped_at: now,
      purged_at: null,
      claim_token: null,
      lease_expires_at: null,
    }, now)).toBe(false);
    expect(GrantExpiryEnforcementRepository.isDueForWork('grace', {
      grace_stopped_at: null,
      purged_at: null,
      claim_token: randomUUID(),
      lease_expires_at: new Date(now.getTime() + 60_000),
    }, now)).toBe(false);
    expect(GrantExpiryEnforcementRepository.isDueForWork('lost', {
      grace_stopped_at: now,
      purged_at: null,
      claim_token: randomUUID(),
      lease_expires_at: new Date(now.getTime() - 1),
    }, now)).toBe(true);
  });
});
