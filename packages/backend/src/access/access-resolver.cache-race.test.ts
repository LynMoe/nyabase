import { randomUUID } from 'node:crypto';
import { Capability, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { AccessResolverService } from './access-resolver.service.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('AccessResolver PostgreSQL cache generation fence', () => {
  it('never returns an authority fill that started before invalidation', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const groupId = randomUUID();
      await database.insertInto('iam.users').values({
        id: userId,
        numeric_id: 1001,
        username: `cache-${userId.slice(0, 8)}`,
        password_hash: 'hash',
        display_name: 'Cache User',
        status: UserStatus.Active,
        auth_version: 1,
        authz_version: 1,
      }).execute();
      await database.insertInto('iam.groups').values({
        id: groupId,
        name: `Privileged ${groupId.slice(0, 8)}`,
        description: null,
        priority: 1,
        is_system: false,
        system_key: null,
        capabilities: [Capability.ManageUsers],
        revision: 1,
      }).execute();
      await database.insertInto('iam.group_members').values({
        id: randomUUID(),
        group_id: groupId,
        user_id: userId,
      }).execute();

      const canonical = new PgTransactionManager(database);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let oldReadFinished!: () => void;
      const oldRead = new Promise<void>((resolve) => { oldReadFinished = resolve; });
      let runs = 0;
      const transactions = {
        run: <T>(work: Parameters<PgTransactionManager['run']>[0]) => {
          runs += 1;
          const current = runs;
          return canonical.run(async (transaction) => {
            const value = await work(transaction);
            if (current === 1) {
              oldReadFinished();
              await gate;
            }
            return value;
          }) as Promise<T>;
        },
      } as PgTransactionManager;
      const epoch = new AccessCacheEpochService(database);
      const resolver = new AccessResolverService(
        database,
        transactions,
        { stateCache: { get: () => undefined } } as never,
        epoch,
      );

      const capabilities = resolver.userCapabilities(userId);
      await oldRead;
      await database.deleteFrom('iam.group_members')
        .where('user_id', '=', userId)
        .where('group_id', '=', groupId)
        .executeTakeFirstOrThrow();
      resolver.invalidateUser(userId);
      release();

      await expect(capabilities).resolves.toEqual(new Set());
      expect(runs).toBe(2);
    });
  });
});
