import { Role, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { testActor } from '../iam/actor.test-helper.js';
import {
  grantServer,
  seedContainer,
  grantPool,
  seedImage,
  seedPool,
  seedServer,
  seedUser,
} from '../iam/access.pg-test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { usersPgFixture } from './users.pg-test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('UsersService.deleteUserPermanently', () => {
  it('refuses while the user owns containers or volumes, and removes nothing', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      const serverId = await seedServer(fixture.database);
      await seedContainer(fixture.database, {
        ownerId: context.userId,
        serverId,
        poolId: await seedPool(fixture.database, serverId),
        imageId: await seedImage(fixture.database),
      });
      const actor = testActor(context.actorId, Role.Admin);

      await expect(context.users.deleteUserPermanently(actor, context.userId)).rejects.toMatchObject({
        status: 409,
        response: { code: 'USER_HAS_RESOURCES', resourceKind: 'container' },
      });
      expect((await fixture.database.selectFrom('iam.users').select('status')
        .where('id', '=', context.userId).executeTakeFirstOrThrow()).status).toBe(UserStatus.Active);
    });
  });

  it('deletes credentials, grants and ledger rows, and marks the user deleted', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      const { database } = fixture;
      const serverId = await seedServer(database);
      await grantServer(database, { user: context.userId }, serverId);
      await grantPool(database, { user: context.userId }, await seedPool(database, serverId), 10);
      await database.insertInto('control.access_lapses').values({
        user_id: context.userId, resource_kind: 'server', resource_id: serverId, lapsed_at: new Date(),
      }).execute();
      const actor = testActor(context.actorId, Role.Admin);

      await expect(context.users.deleteUserPermanently(actor, context.userId))
        .resolves.toEqual({ deleted: true });

      expect((await database.selectFrom('iam.users').select('status')
        .where('id', '=', context.userId).executeTakeFirstOrThrow()).status).toBe(UserStatus.Deleted);
      expect(await database.selectFrom('iam.server_grants').select('id').execute()).toEqual([]);
      expect(await database.selectFrom('iam.storage_pool_grants').select('id').execute()).toEqual([]);
      expect(await database.selectFrom('control.access_lapses').select('user_id').execute()).toEqual([]);
      await expect(context.users.deleteUserPermanently(actor, context.userId))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  it('needs the user admin role, re-checked in the transaction', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { actorRole: Role.User });

      await expect(context.users.deleteUserPermanently(
        testActor(context.actorId, Role.UserAdmin),
        context.userId,
      )).rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      expect((await fixture.database.selectFrom('iam.users').select('status')
        .where('id', '=', context.userId).executeTakeFirstOrThrow()).status).toBe(UserStatus.Active);
    });
  });

  it('lets a user admin delete users but not admins', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { actorRole: Role.UserAdmin });
      const actor = testActor(context.actorId, Role.UserAdmin);
      const admin = await seedUser(fixture.database, undefined, UserStatus.Active, Role.Admin);

      await expect(context.users.deleteUserPermanently(actor, admin))
        .rejects.toMatchObject({ response: { code: 'ADMINISTRATOR_PROTECTED' } });
      await expect(context.users.deleteUserPermanently(actor, context.userId))
        .resolves.toEqual({ deleted: true });
    });
  });

  it('keeps the final active administrator, and ignores disabled administrators', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture);
      await seedUser(fixture.database, undefined, UserStatus.Disabled, Role.Admin);
      const actor = testActor(context.actorId, Role.Admin);

      await expect(context.users.deleteUserPermanently(actor, context.actorId))
        .rejects.toMatchObject({ response: { code: 'LAST_ACTIVE_ADMINISTRATOR' } });

      const other = await seedUser(fixture.database, undefined, UserStatus.Active, Role.Admin);
      await expect(context.users.deleteUserPermanently(actor, other))
        .resolves.toEqual({ deleted: true });
      await expect(context.users.deleteUserPermanently(actor, context.actorId))
        .rejects.toMatchObject({ response: { code: 'LAST_ACTIVE_ADMINISTRATOR' } });
    });
  });
});
