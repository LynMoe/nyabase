import { randomUUID } from 'node:crypto';
import { Capability, UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { AccessResolverService } from './access-resolver.service.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('AccessResolver PostgreSQL external-work admission', () => {
  it('commits its authority transaction before remote acknowledgement settles', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      let finish!: (value: string) => void;
      const remote = new Promise<string>((resolve) => { finish = resolve; });
      const started = await context.resolver.startExternalWithActorCapabilities(
        context.actorId,
        [Capability.ManageServers],
        () => remote,
      );

      await expect(context.transactions.run(async (transaction) => {
        await transaction.updateTable('iam.users')
          .set({ display_name: 'Updated' })
          .where('id', '=', context.actorId)
          .executeTakeFirstOrThrow();
        return 'database-reused';
      })).resolves.toBe('database-reused');
      finish('remote-finished');
      await expect(started.completion).resolves.toBe('remote-finished');
    });
  });

  it('does not dispatch when a revocation commits ahead of queued admission', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      let deleted!: () => void;
      const deletionStaged = new Promise<void>((resolve) => { deleted = resolve; });
      let commit!: () => void;
      const commitGate = new Promise<void>((resolve) => { commit = resolve; });
      const revoke = context.transactions.run(async (transaction) => {
        await transaction.deleteFrom('iam.group_members')
          .where('user_id', '=', context.actorId)
          .where('group_id', '=', context.groupId)
          .executeTakeFirstOrThrow();
        deleted();
        await commitGate;
      });
      await deletionStaged;
      const start = vi.fn(async () => 'must-not-start');
      const admission = context.resolver.startExternalWithActorCapabilities(
        context.actorId,
        [Capability.ManageServers],
        start,
      );
      commit();
      await revoke;
      await expect(admission).rejects.toThrow(/cannot grant or administer/);
      expect(start).not.toHaveBeenCalled();
    });
  });
});

async function setup(fixture: PostgresTestDatabase) {
  const transactions = new PgTransactionManager(fixture.database);
  const actorId = randomUUID();
  const groupId = randomUUID();
  await fixture.database.insertInto('iam.users').values({
    id: actorId,
    numeric_id: 1001,
    username: `external-${actorId.slice(0, 8)}`,
    password_hash: 'unused',
    display_name: 'Actor',
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  }).execute();
  await fixture.database.insertInto('iam.groups').values({
    id: groupId,
    name: `Operators ${groupId.slice(0, 8)}`,
    description: null,
    priority: 1,
    is_system: false,
    system_key: null,
    capabilities: [Capability.ManageServers],
    revision: 1,
  }).execute();
  await fixture.database.insertInto('iam.group_members').values({
    id: randomUUID(),
    group_id: groupId,
    user_id: actorId,
  }).execute();
  const resolver = new AccessResolverService(
    fixture.database,
    transactions,
    { stateCache: { get: () => undefined } } as never,
    new AccessCacheEpochService(fixture.database),
  );
  return { transactions, resolver, actorId, groupId };
}
