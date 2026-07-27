import { randomUUID } from 'node:crypto';
import {
  MAX_AGENT_XFS_PROJECTS,
  MAX_PLATFORM_ACTIVE_USERS,
  UserStatus,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { userRow, usersPgFixture } from './users.pg-test-helper.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('UsersService PostgreSQL terminal deleted state', () => {
  it('never reactivates or exposes a deleted tombstone', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, {
        seedActor: false,
        targetStatus: UserStatus.Deleted,
      });
      await expect(context.users.updateUser(context.userId, {
        status: UserStatus.Active,
        displayName: 'Resurrected',
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USER_DELETED' }),
      });
      expect(await fixture.database.selectFrom('iam.users').selectAll()
        .where('id', '=', context.userId).executeTakeFirstOrThrow())
        .toMatchObject({ status: UserStatus.Deleted, display_name: 'target' });
      await expect(context.users.findById(context.userId)).rejects.toMatchObject({ status: 404 });
      await expect(context.users.findAll()).resolves.toEqual([]);
      expect(context.proxySnapshots.notify).not.toHaveBeenCalled();
    });
  });

  it('keeps Disabled reversible and commits invalidation and snapshots on recovery', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, {
        seedActor: false,
        targetStatus: UserStatus.Disabled,
      });
      const committed = context.access.authorizationCommitted =
        vi.fn().mockResolvedValue(undefined);
      await expect(context.users.updateUser(context.userId, { status: UserStatus.Active }))
        .resolves.toMatchObject({ status: UserStatus.Active });
      expect(committed).toHaveBeenCalledWith([context.userId]);
      expect(context.proxySnapshots.notify).toHaveBeenCalledWith('user-updated');
    });
  });

  it('serializes concurrent activation at the fixed active-user capacity', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false, seedTarget: false });
      const activeRows = Array.from({ length: MAX_PLATFORM_ACTIVE_USERS - 1 }, (_, index) =>
        userRow(randomUUID(), 2_000 + index, `active-${index}`, UserStatus.Active));
      const candidateA = randomUUID();
      const candidateB = randomUUID();
      await fixture.database.insertInto('iam.users').values([
        ...activeRows,
        userRow(candidateA, 4_000, 'candidate-a', UserStatus.Disabled),
        userRow(candidateB, 4_001, 'candidate-b', UserStatus.Disabled),
      ]).execute();
      const results = await Promise.allSettled([
        context.users.updateUser(candidateA, { status: UserStatus.Active }),
        context.users.updateUser(candidateB, { status: UserStatus.Active }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await activeCount(fixture)).toBe(MAX_PLATFORM_ACTIVE_USERS);
    });
  });

  it('counts deleted tombstones against the lifetime XFS identity capacity', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false, seedTarget: false });
      await seedDeletedUsers(fixture, MAX_AGENT_XFS_PROJECTS);
      await expect(context.users.createUser({
        username: 'overflow-user',
        password: 'secret123',
        displayName: 'Overflow User',
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USER_LIFETIME_CAPACITY_REACHED' }),
      });
      expect(context.prepareUserKey).toHaveBeenCalledOnce();
      expect(context.savePreparedUserKeyInTransaction).not.toHaveBeenCalled();
    });
  });

  it('serializes concurrent creation at the lifetime identity capacity', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { seedActor: false, seedTarget: false });
      await seedDeletedUsers(fixture, MAX_AGENT_XFS_PROJECTS - 1);
      const results = await Promise.allSettled([
        context.users.createUser({
          username: 'last-a', password: 'secret123', displayName: 'Last A',
        }),
        context.users.createUser({
          username: 'last-b', password: 'secret123', displayName: 'Last B',
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({
        response: expect.objectContaining({ code: 'USER_LIFETIME_CAPACITY_REACHED' }),
      });
      expect(context.savePreparedUserKeyInTransaction).toHaveBeenCalledOnce();
    });
  });
});

async function activeCount(fixture: PostgresTestDatabase): Promise<number> {
  const row = await fixture.database.selectFrom('iam.users')
    .select((expression) => expression.fn.countAll<string>().as('count'))
    .where('status', '=', UserStatus.Active)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function seedDeletedUsers(
  fixture: PostgresTestDatabase,
  count: number,
): Promise<void> {
  for (let start = 0; start < count; start += 512) {
    const size = Math.min(512, count - start);
    await fixture.database.insertInto('iam.users').values(
      Array.from({ length: size }, (_, offset) => {
        const index = start + offset + 1;
        return userRow(randomUUID(), index, `deleted-${index}`, UserStatus.Deleted);
      }),
    ).execute();
  }
  await fixture.database.updateTable('iam.policy_state')
    .set({ next_numeric_user_id: count + 1 })
    .where('singleton', '=', true)
    .executeTakeFirstOrThrow();
}
