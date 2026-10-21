import { describe, expect, it, vi } from 'vitest';
import { UserStatus } from '@nyabase/common';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { usersPgFixture } from './users.pg-test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('UsersService terminal user states', () => {
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
      await expect(context.users.findById(context.userId)).rejects.toMatchObject({ status: 404 });
      await expect(context.users.findAll()).resolves.toEqual([]);
    });
  });

  it('keeps disabled users reversible and signals the access-lapse processor', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, {
        seedActor: false,
        targetStatus: UserStatus.Disabled,
      });
      const signalled = vi.fn();
      context.changes.onChange(signalled);
      await expect(context.users.updateUser(context.userId, {
        status: UserStatus.Active,
      })).resolves.toMatchObject({ status: UserStatus.Active });
      expect(signalled).toHaveBeenCalledTimes(1);
    });
  });
});
