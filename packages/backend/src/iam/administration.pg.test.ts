import { Role, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { seedUser } from './access.pg-test-helper.js';
import { assertActorRole, assertCanAdministerUser, assertNotLastAdministrator } from './administration.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('administration rules (role re-check and the last-administrator guard)', () => {
  it('re-reads the actor role in the transaction: nested roles, active users only', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const user = await seedUser(database, undefined, UserStatus.Active, Role.User);
      const userAdmin = await seedUser(database, undefined, UserStatus.Active, Role.UserAdmin);
      const admin = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const disabledAdmin = await seedUser(database, undefined, UserStatus.Disabled, Role.Admin);

      await database.transaction().execute(async (transaction) => {
        await assertActorRole(transaction, user, Role.User);
        await expect(assertActorRole(transaction, user, Role.UserAdmin)).rejects
          .toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
        await assertActorRole(transaction, userAdmin, Role.UserAdmin);
        await expect(assertActorRole(transaction, userAdmin, Role.Admin)).rejects
          .toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
        await assertActorRole(transaction, admin, Role.Admin);
        await assertActorRole(transaction, admin, Role.UserAdmin);
        await expect(assertActorRole(transaction, disabledAdmin, Role.User)).rejects
          .toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
        await expect(assertActorRole(transaction, '00000000-0000-4000-8000-000000000000', Role.User))
          .rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      });
    });
  });

  it('lets user admins administer everyone but admins, and admins everyone', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const user = await seedUser(database, undefined, UserStatus.Active, Role.User);
      const userAdmin = await seedUser(database, undefined, UserStatus.Active, Role.UserAdmin);
      const otherUserAdmin = await seedUser(database, undefined, UserStatus.Active, Role.UserAdmin);
      const admin = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const otherAdmin = await seedUser(database, undefined, UserStatus.Active, Role.Admin);

      await database.transaction().execute(async (transaction) => {
        await assertCanAdministerUser(transaction, userAdmin, user);
        await assertCanAdministerUser(transaction, userAdmin, otherUserAdmin);
        await assertCanAdministerUser(transaction, userAdmin, userAdmin);
        await expect(assertCanAdministerUser(transaction, userAdmin, admin)).rejects
          .toMatchObject({ response: { code: 'ADMINISTRATOR_PROTECTED' } });
        await assertCanAdministerUser(transaction, admin, otherAdmin);
        await assertCanAdministerUser(transaction, admin, userAdmin);
        await expect(assertCanAdministerUser(transaction, user, otherUserAdmin)).rejects
          .toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      });
    });
  });

  it('sees a demotion committed after the route guard ran', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const admin = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      await database.updateTable('iam.users').set({ role: Role.User }).where('id', '=', admin).execute();
      await database.transaction().execute(async (transaction) => {
        await expect(assertActorRole(transaction, admin, Role.Admin)).rejects
          .toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      });
    });
  });

  it('protects the final active administrator and ignores inactive ones', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const last = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const disabled = await seedUser(database, undefined, UserStatus.Disabled, Role.Admin);
      const userAdmin = await seedUser(database, undefined, UserStatus.Active, Role.UserAdmin);

      await database.transaction().execute(async (transaction) => {
        await expect(assertNotLastAdministrator(transaction, last)).rejects.toMatchObject({
          response: { code: 'LAST_ACTIVE_ADMINISTRATOR' },
        });
        // Changing someone who is not an active administrator is fine.
        await assertNotLastAdministrator(transaction, disabled);
        await assertNotLastAdministrator(transaction, userAdmin);
      });

      const second = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      await database.transaction().execute(async (transaction) => {
        await assertNotLastAdministrator(transaction, last);
        await assertNotLastAdministrator(transaction, second);
      });
    });
  });

  it('serialises concurrent demotions so two administrators cannot both leave', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const a = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const b = await seedUser(database, undefined, UserStatus.Active, Role.Admin);

      const demote = (userId: string) => database.transaction().execute(async (transaction) => {
        await assertNotLastAdministrator(transaction, userId);
        await transaction.updateTable('iam.users')
          .set({ role: Role.User })
          .where('id', '=', userId)
          .execute();
      });
      const results = await Promise.allSettled([demote(a), demote(b)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const remaining = await database.selectFrom('iam.users')
        .select('id')
        .where('role', '=', Role.Admin)
        .execute();
      expect(remaining).toHaveLength(1);
    });
  });
});
