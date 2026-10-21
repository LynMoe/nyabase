import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { ReconcileClaimRepository } from '../reconcile/reconcile-claim.repository.js';
import { insertServerFixture } from '../reconcile/server-fixture.test-helper.js';
import { GrantExpiryEnforcementRepository } from './grant-expiry-enforcement.repository.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describe('GrantExpiryEnforcementRepository completion decisions', () => {
  it('is due until the phase has completed', () => {
    const done = new Date('2026-06-01T00:00:00.000Z');
    expect(GrantExpiryEnforcementRepository.isDueForWork('grace', undefined)).toBe(true);
    expect(GrantExpiryEnforcementRepository.isDueForWork('grace', {
      grace_stopped_at: done,
      purged_at: null,
    })).toBe(false);
    expect(GrantExpiryEnforcementRepository.isDueForWork('lost', {
      grace_stopped_at: done,
      purged_at: null,
    })).toBe(true);
    expect(GrantExpiryEnforcementRepository.isDueForWork('lost', {
      grace_stopped_at: done,
      purged_at: done,
    })).toBe(false);
  });
});

describePg('GrantExpiryEnforcementRepository leases (PostgreSQL)', () => {
  async function setup(database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database']) {
    const serverId = await insertServerFixture(database);
    const userId = randomUUID();
    await database.insertInto('iam.users').values({
      id: userId,
      numeric_id: 1,
      username: `u-${userId.slice(0, 8)}`,
      password_hash: 'x',
      display_name: 'u',
      status: 'active',
      auth_version: 0,
      authz_version: 0,
    }).execute();
    const claims = new ReconcileClaimRepository(database);
    const repository = new GrantExpiryEnforcementRepository(
      database,
      new PgTransactionManager(database),
      claims,
    );
    return { serverId, userId, claims, repository, covering: new Date('2026-06-01T00:00:00.000Z') };
  }

  const leaseRows = (
    database: Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'],
  ) => database.selectFrom('control.reconcile_claims').selectAll().execute();

  it('takes a single-owner reconcile claim keyed by user and server', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, userId, repository, covering } = await setup(database);
      const first = await repository.claim('grace', userId, serverId, covering, 'worker-a');
      expect(first).not.toBeNull();
      expect(await repository.claim('grace', userId, serverId, covering, 'worker-b')).toBeNull();
      expect(await repository.claim('lost', userId, serverId, covering, 'worker-b')).toBeNull();
      expect(await leaseRows(database)).toEqual([expect.objectContaining({
        resource_type: 'grant_expiry',
        resource_id: userId,
        placement_server_id: serverId,
        server_id: serverId,
        worker_id: 'worker-a',
      })]);
      await repository.release(first!);
      expect(await leaseRows(database)).toEqual([]);
      const second = await repository.claim('grace', userId, serverId, covering, 'worker-b');
      expect(second).not.toBeNull();
      await repository.release(second!);
    });
  });

  it('completes a phase once and then refuses further claims for it', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, userId, repository, covering } = await setup(database);
      const manager = new PgTransactionManager(database);
      const claim = (await repository.claim('grace', userId, serverId, covering, 'worker-a'))!;
      await expect(manager.run((tx) => repository.completeGraceInTransaction(tx, claim)))
        .resolves.toBe(true);
      await expect(manager.run((tx) => repository.completeGraceInTransaction(tx, claim)))
        .resolves.toBe(false);
      await repository.release(claim);
      expect(await repository.claim('grace', userId, serverId, covering, 'worker-b')).toBeNull();
      // Completing grace does not complete the lost phase.
      const lost = await repository.claim('lost', userId, serverId, covering, 'worker-b');
      expect(lost).not.toBeNull();
      await expect(repository.completeLost(lost!)).resolves.toBe(true);
      await repository.release(lost!);
      expect(await repository.claim('lost', userId, serverId, covering, 'worker-c')).toBeNull();
      expect(await leaseRows(database)).toEqual([]);
    });
  });

  it('recovers from a crashed owner once its lease expires and fences the old owner', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, userId, repository, covering } = await setup(database);
      const crashed = (await repository.claim('lost', userId, serverId, covering, 'worker-a'))!;
      // The crashed worker never renews or releases; stop its timer, keep its row.
      crashed.lease.stop();
      expect(await repository.claim('lost', userId, serverId, covering, 'worker-b')).toBeNull();

      await database.updateTable('control.reconcile_claims')
        .set({ lease_expires_at: new Date(Date.now() - 1_000) })
        .execute();
      const recovered = await repository.claim('lost', userId, serverId, covering, 'worker-b');
      expect(recovered).not.toBeNull();
      expect((await leaseRows(database))[0]?.worker_id).toBe('worker-b');

      // The old owner woke up late: its completion must not land.
      await expect(repository.completeLost(crashed)).resolves.toBe(false);
      await expect(repository.completeLost(recovered!)).resolves.toBe(true);
      await repository.release(recovered!);
    });
  });

  it('does not complete after the lease has expired even without a new owner', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, userId, repository, covering } = await setup(database);
      const claim = (await repository.claim('lost', userId, serverId, covering, 'worker-a'))!;
      claim.lease.stop();
      await database.updateTable('control.reconcile_claims')
        .set({ lease_expires_at: new Date(Date.now() - 1_000) })
        .execute();
      await expect(repository.completeLost(claim)).resolves.toBe(false);
    });
  });

  it('keeps leases for different servers of one user independent', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, userId, repository, covering } = await setup(database);
      const otherServer = await insertServerFixture(database);
      const a = await repository.claim('grace', userId, serverId, covering, 'worker-a');
      const b = await repository.claim('grace', userId, otherServer, covering, 'worker-b');
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      await repository.release(a!);
      await repository.release(b!);
    });
  });
});
