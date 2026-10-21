import { Capability, SystemGroupKey } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { AccessChangeNotifier } from '../iam/access-change-notifier.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
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
      new AccessResolverService(database, transactions),
      { append: async () => undefined } as never,
      changes,
    );
    return { service, signals: () => signals };
  }

  async function actorWith(
    database: Parameters<typeof seedUser>[0],
    capabilities: Capability[],
  ) {
    const userId = await seedUser(database);
    await addMember(database, await seedGroup(database, { capabilities }), userId);
    return testActor(userId, ...capabilities);
  }

  it('lists groups by name', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      await seedGroup(database, { name: 'beta' });
      await seedGroup(database, { name: 'alpha' });
      const groups = await service.findAll();
      expect(groups.map((group) => group.name)).toEqual(['alpha', 'beta']);
    });
  });

  it('only lets an actor hand out capabilities it holds itself', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      const manager = await actorWith(database, [Capability.ManageGroups]);

      await expect(service.create(manager, { name: 'ok', capabilities: [] }))
        .resolves.toMatchObject({ name: 'ok', capabilities: [] });
      await expect(service.create(manager, { name: 'too-much', capabilities: [Capability.ViewAudit] }))
        .rejects.toMatchObject({
          response: { code: 'PRIVILEGE_ESCALATION_DENIED', missingCapabilities: [Capability.ViewAudit] },
        });
      await expect(service.create(manager, { name: 'ok' })).rejects.toMatchObject({ status: 409 });
    });
  });

  it('guards revisions, system groups, and capability edits of groups that carry grants', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      const manager = await actorWith(database, [Capability.ManageGroups]);
      const grantor = await actorWith(database, [Capability.ManageGroups, Capability.ManageGrants]);
      const group = await service.create(manager, { name: 'plain' });

      await expect(service.update(manager, group.id, { description: 'x' }, 7))
        .rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
      await expect(service.update(manager, group.id, { description: 'x' }, group.revision))
        .resolves.toMatchObject({ description: 'x', revision: group.revision + 1 });

      const system = await seedGroup(database, {
        name: 'Users', system: SystemGroupKey.Users,
      });
      await expect(service.update(manager, system, { name: 'renamed' }, 1))
        .rejects.toMatchObject({ response: { code: 'SYSTEM_GROUP_METADATA_IMMUTABLE' } });

      const server = await seedServer(database);
      await grantServer(database, { group: group.id }, server);
      await expect(service.update(manager, group.id, { capabilities: [] }, group.revision + 1))
        .rejects.toMatchObject({ response: { missingCapabilities: [Capability.ManageGrants] } });
      await expect(service.update(grantor, group.id, { capabilities: [] }, group.revision + 1))
        .resolves.toMatchObject({ revision: group.revision + 2 });
    });
  });

  it('needs ManageGrants to change the members of a group that carries grants', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, signals } = setup(database);
      const manager = await actorWith(database, [Capability.ManageGroups]);
      const grantor = await actorWith(database, [Capability.ManageGroups, Capability.ManageGrants]);
      const group = await service.create(manager, { name: 'with-grants' });
      const user = await seedUser(database);
      await grantServer(database, { group: group.id }, await seedServer(database));

      await expect(service.addMember(manager, group.id, user))
        .rejects.toMatchObject({ response: { missingCapabilities: [Capability.ManageGrants] } });
      expect(signals()).toBe(0);
      await expect(service.addMember(grantor, group.id, user)).resolves.toEqual({ changed: true });
      await expect(service.addMember(grantor, group.id, user)).resolves.toEqual({ changed: false });
      expect(signals()).toBe(1);
      await expect(service.removeMember(manager, group.id, user))
        .rejects.toMatchObject({ response: { missingCapabilities: [Capability.ManageGrants] } });
      await expect(service.removeMember(grantor, group.id, user)).resolves.toEqual({ changed: true });
      expect(signals()).toBe(2);
    });
  });

  it('never refuses a removal because the user owns resources: it is a lapse', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, signals } = setup(database);
      const grantor = await actorWith(database, [Capability.ManageGroups, Capability.ManageGrants]);
      const owner = await seedUser(database);
      const group = await service.create(grantor, { name: 'covering' });
      const server = await seedServer(database);
      await service.addMember(grantor, group.id, owner);
      await grantServer(database, { group: group.id }, server);
      await seedContainer(database, {
        ownerId: owner,
        serverId: server,
        poolId: await seedPool(database, server),
        imageId: await seedImage(database),
        running: true,
      });
      const before = signals();

      await expect(service.removeMember(grantor, group.id, owner)).resolves.toEqual({ changed: true });
      expect(signals()).toBe(before + 1);
      await expect(service.addMember(grantor, group.id, owner)).resolves.toEqual({ changed: true });
      await expect(service.delete(grantor, group.id)).resolves.toEqual({ deleted: true });
      expect(signals()).toBe(before + 3);
      expect(await database.selectFrom('iam.server_grants').select('id').execute()).toEqual([]);
      expect(await database.selectFrom('control.containers').select('id').execute()).toHaveLength(1);
    });
  });

  it('refuses to delete a system group and needs ManageGrants to delete any group', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      const manager = await actorWith(database, [Capability.ManageGroups]);
      const grantor = await actorWith(database, [Capability.ManageGroups, Capability.ManageGrants]);
      const group = await service.create(manager, { name: 'doomed' });
      const system = await seedGroup(database, { name: 'Users', system: SystemGroupKey.Users });

      await expect(service.delete(manager, group.id))
        .rejects.toMatchObject({ response: { missingCapabilities: [Capability.ManageGrants] } });
      await expect(service.delete(grantor, system)).rejects.toMatchObject({ status: 403 });
      await expect(service.delete(grantor, group.id)).resolves.toEqual({ deleted: true });
      await expect(service.findById(group.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('protects the last active administrator from being removed from Administrators', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      const admins = await seedGroup(database, {
        name: 'Administrators',
        system: SystemGroupKey.Administrators,
        capabilities: Object.values(Capability),
      });
      const adminId = await seedUser(database);
      await addMember(database, admins, adminId);
      const admin = testActor(adminId, ...Object.values(Capability));

      await expect(service.removeMember(admin, admins, adminId))
        .rejects.toMatchObject({ response: { code: 'LAST_ACTIVE_ADMINISTRATOR' } });
      const second = await seedUser(database);
      await addMember(database, admins, second);
      await expect(service.removeMember(admin, admins, adminId)).resolves.toEqual({ changed: true });
    });
  });

  it('bumps the session generation when membership or group capabilities change', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service } = setup(database);
      const manager = await actorWith(database, [Capability.ManageGroups, Capability.ViewAudit]);
      const member = await seedUser(database);
      const group = await service.create(manager, { name: 'sessions' });
      const version = async () => (await database.selectFrom('iam.users')
        .select('auth_version').where('id', '=', member).executeTakeFirstOrThrow()).auth_version;

      const start = await version();
      await service.addMember(manager, group.id, member);
      expect(await version()).toBe(start + 1);
      await service.update(manager, group.id, { capabilities: [Capability.ViewAudit] }, group.revision);
      expect(await version()).toBe(start + 2);
      await service.update(manager, group.id, { description: 'only text' }, group.revision + 1);
      expect(await version()).toBe(start + 2);
      await service.removeMember(manager, group.id, member);
      expect(await version()).toBe(start + 3);
    });
  });
});
