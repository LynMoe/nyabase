import { Role, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import { testActor } from '../iam/actor.test-helper.js';
import {
  grantServer,
  seedContainer,
  seedGroup,
  seedImage,
  seedPool,
  seedServer,
  seedUser,
} from '../iam/access.pg-test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { GroupsService } from './groups.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('GroupsService', () => {
  function setup(database: Parameters<typeof seedUser>[0]) {
    const transactions = new PgTransactionManager(database);
    const changes = new AccessChangeNotifier();
    let signals = 0;
    changes.onChange(() => { signals += 1; });
    const service = new GroupsService(
      database,
      transactions,
      { append: async () => undefined } as never,
      changes,
    );
    return { service, signals: () => signals };
  }

  async function actorWithRole(database: Parameters<typeof seedUser>[0], role: Role) {
    const userId = await seedUser(database, undefined, UserStatus.Active, role);
    return testActor(userId, role);
  }

  it('lists groups by name', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      await seedGroup(database, { name: 'beta' });
      await seedGroup(database, { name: 'alpha' });
      const groups = await service.findAll();
      expect(groups.map((group) => group.name)).toEqual(['alpha', 'beta']);
      expect(groups[0]).not.toHaveProperty('capabilities');
      expect(groups[0]).not.toHaveProperty('isSystem');
    });
  });

  it('managing groups needs the user admin role, re-checked in the transaction', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      const admin = await actorWithRole(database, Role.Admin);
      const userAdmin = await actorWithRole(database, Role.UserAdmin);
      const plain = await actorWithRole(database, Role.User);
      const group = await service.create(admin, { name: 'managed' });
      const member = await seedUser(database);

      await expect(service.create(plain, { name: 'nope' }))
        .rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      await expect(service.update(plain, group.id, { description: 'x' }, group.revision))
        .rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      await expect(service.addMember(plain, group.id, member))
        .rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      await expect(service.delete(plain, group.id))
        .rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      await expect(service.create(admin, { name: 'managed' })).rejects.toMatchObject({ status: 409 });

      // A user admin manages any group, including one with an admin in it.
      const managed = await service.create(userAdmin, { name: 'by-user-admin' });
      await service.addMember(userAdmin, managed.id, member);
      await service.addMember(userAdmin, managed.id, admin.userId!);
      await service.delete(userAdmin, managed.id);
    });
  });

  it('guards revisions', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      const admin = await actorWithRole(database, Role.Admin);
      const group = await service.create(admin, { name: 'plain' });

      await expect(service.update(admin, group.id, { description: 'x' }, 7))
        .rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
      await expect(service.update(admin, group.id, { description: 'x' }, group.revision))
        .resolves.toMatchObject({ description: 'x', revision: group.revision + 1 });
    });
  });

  it('signals coverage changes when members come and go, also for groups that carry grants', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, signals } = setup(database);
      const admin = await actorWithRole(database, Role.Admin);
      const group = await service.create(admin, { name: 'with-grants' });
      const user = await seedUser(database);
      await grantServer(database, { group: group.id }, await seedServer(database));

      await expect(service.addMember(admin, group.id, user)).resolves.toEqual({ changed: true });
      await expect(service.addMember(admin, group.id, user)).resolves.toEqual({ changed: false });
      expect(signals()).toBe(1);
      await expect(service.removeMember(admin, group.id, user)).resolves.toEqual({ changed: true });
      expect(signals()).toBe(2);
    });
  });

  it('never refuses a removal because the user owns resources: it is a lapse', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, signals } = setup(database);
      const admin = await actorWithRole(database, Role.Admin);
      const owner = await seedUser(database);
      const group = await service.create(admin, { name: 'covering' });
      const server = await seedServer(database);
      await service.addMember(admin, group.id, owner);
      await grantServer(database, { group: group.id }, server);
      await seedContainer(database, {
        ownerId: owner,
        serverId: server,
        poolId: await seedPool(database, server),
        imageId: await seedImage(database),
        running: true,
      });
      const before = signals();

      await expect(service.removeMember(admin, group.id, owner)).resolves.toEqual({ changed: true });
      expect(signals()).toBe(before + 1);
      await expect(service.addMember(admin, group.id, owner)).resolves.toEqual({ changed: true });
      await expect(service.delete(admin, group.id)).resolves.toEqual({ deleted: true });
      expect(signals()).toBe(before + 3);
      expect(await database.selectFrom('iam.server_grants').select('id').execute()).toEqual([]);
      expect(await database.selectFrom('control.containers').select('id').execute()).toHaveLength(1);
      await expect(service.findById(group.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('does not touch the session generation: group membership no longer carries authority', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      const admin = await actorWithRole(database, Role.Admin);
      const member = await seedUser(database);
      const group = await service.create(admin, { name: 'sessions' });
      const version = async () => (await database.selectFrom('iam.users')
        .select('auth_version').where('id', '=', member).executeTakeFirstOrThrow()).auth_version;

      const start = await version();
      await service.addMember(admin, group.id, member);
      await service.update(admin, group.id, { description: 'text' }, group.revision);
      await service.removeMember(admin, group.id, member);
      expect(await version()).toBe(start);
    });
  });
});
