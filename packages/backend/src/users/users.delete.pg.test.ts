import { Capability, SystemGroupKey, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { testActor } from '../iam/actor.test-helper.js';
import {
  addMember,
  grantServer,
  seedContainer,
  seedGroup,
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
      const context = await usersPgFixture(fixture, {
        actorCapabilities: [Capability.ManageUsers],
      });
      const serverId = await seedServer(fixture.database);
      await seedContainer(fixture.database, {
        ownerId: context.userId,
        serverId,
        poolId: await seedPool(fixture.database, serverId),
        imageId: await seedImage(fixture.database),
      });
      const actor = testActor(context.actorId, Capability.ManageUsers);

      await expect(context.users.deleteUserPermanently(actor, context.userId)).rejects.toMatchObject({
        status: 409,
        response: { code: 'USER_HAS_RESOURCES', resourceKind: 'container' },
      });
      expect((await fixture.database.selectFrom('iam.users').select('status')
        .where('id', '=', context.userId).executeTakeFirstOrThrow()).status).toBe(UserStatus.Active);
    });
  });

  it('deletes credentials, memberships, grants and ledger rows, and marks the user deleted', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, {
        actorCapabilities: [Capability.ManageUsers, Capability.ManageGrants],
      });
      const { database } = fixture;
      const serverId = await seedServer(database);
      await grantServer(database, { user: context.userId }, serverId);
      await addMember(database, await seedGroup(database), context.userId);
      await database.insertInto('control.access_lapses').values({
        user_id: context.userId, resource_kind: 'server', resource_id: serverId, lapsed_at: new Date(),
      }).execute();
      const actor = testActor(context.actorId, Capability.ManageUsers, Capability.ManageGrants);

      await expect(context.users.deleteUserPermanently(actor, context.userId))
        .resolves.toEqual({ deleted: true });

      expect((await database.selectFrom('iam.users').select('status')
        .where('id', '=', context.userId).executeTakeFirstOrThrow()).status).toBe(UserStatus.Deleted);
      expect(await database.selectFrom('iam.server_grants').select('id').execute()).toEqual([]);
      expect(await database.selectFrom('iam.group_members').select('id')
        .where('user_id', '=', context.userId).execute()).toEqual([]);
      expect(await database.selectFrom('control.access_lapses').select('user_id').execute()).toEqual([]);
      await expect(context.users.deleteUserPermanently(actor, context.userId))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  it('applies the administration hierarchy: a target with grants needs ManageGrants', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, { actorCapabilities: [Capability.ManageUsers] });
      await grantServer(fixture.database, { user: context.userId }, await seedServer(fixture.database));

      await expect(context.users.deleteUserPermanently(
        testActor(context.actorId, Capability.ManageUsers),
        context.userId,
      )).rejects.toMatchObject({ response: { missingCapabilities: [Capability.ManageGrants] } });
    });
  });

  it('keeps the final active administrator', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, {
        actorCapabilities: Object.values(Capability),
      });
      const admins = await seedGroup(fixture.database, {
        name: 'Administrators',
        system: SystemGroupKey.Administrators,
        capabilities: Object.values(Capability),
      });
      const lastAdmin = await seedUser(fixture.database);
      await addMember(fixture.database, admins, lastAdmin);

      await expect(context.users.deleteUserPermanently(
        testActor(context.actorId, ...Object.values(Capability)),
        lastAdmin,
      )).rejects.toMatchObject({ response: { code: 'LAST_ACTIVE_ADMINISTRATOR' } });
    });
  });
});
