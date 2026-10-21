import { Capability, SystemGroupKey, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import {
  addMember,
  grantBackend,
  grantPool,
  grantServer,
  seedBackend,
  seedGroup,
  seedPool,
  seedServer,
  seedUser,
} from './access.pg-test-helper.js';
import { AccessResolverService } from './access-resolver.service.js';
import {
  assertActorHolds,
  assertActorMayAdminister,
  assertNotLastAdministrator,
} from './administration.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('administration rules (R7 and the last-administrator guard)', () => {
  async function actorWith(
    database: Parameters<typeof seedUser>[0],
    capabilities: Capability[],
  ): Promise<string> {
    const actor = await seedUser(database);
    const group = await seedGroup(database, { capabilities });
    await addMember(database, group, actor);
    return actor;
  }

  it('lets an actor administer only users whose capabilities are a subset of its own', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actor = await actorWith(database, [Capability.ManageUsers, Capability.ViewAudit]);
      const modest = await seedUser(database);
      const modestGroup = await seedGroup(database, { capabilities: [Capability.ViewAudit] });
      await addMember(database, modestGroup, modest);
      const powerful = await seedUser(database);
      const powerfulGroup = await seedGroup(database, {
        capabilities: [Capability.ViewAudit, Capability.ManageServers],
      });
      await addMember(database, powerfulGroup, powerful);
      const plain = await seedUser(database);

      await database.transaction().execute(async (transaction) => {
        await assertActorMayAdminister(transaction, actor, modest);
        await assertActorMayAdminister(transaction, actor, plain);
        await expect(assertActorMayAdminister(transaction, actor, powerful)).rejects.toMatchObject({
          response: {
            code: 'PRIVILEGE_ESCALATION_DENIED',
            missingCapabilities: [Capability.ManageServers],
          },
        });
      });
    });
  });

  it('needs ManageUsers at all, from the actor itself', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actor = await actorWith(database, [Capability.ManageGroups]);
      const target = await seedUser(database);
      await database.transaction().execute(async (transaction) => {
        await expect(assertActorMayAdminister(transaction, actor, target)).rejects.toMatchObject({
          response: { missingCapabilities: [Capability.ManageUsers] },
        });
      });
    });
  });

  it('also needs ManageGrants when the target holds a resource grant, direct or through a group', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actor = await actorWith(database, [Capability.ManageUsers]);
      const server = await seedServer(database);
      const pool = await seedPool(database, server);
      const backend = await seedBackend(database);

      const direct = await seedUser(database);
      await grantServer(database, { user: direct }, server);
      const viaGroupServer = await seedUser(database);
      const groupWithServer = await seedGroup(database);
      await addMember(database, groupWithServer, viaGroupServer);
      await grantServer(database, { group: groupWithServer }, server);
      const viaPool = await seedUser(database);
      await grantPool(database, { user: viaPool }, pool);
      const viaGroupBackend = await seedUser(database);
      const groupWithBackend = await seedGroup(database);
      await addMember(database, groupWithBackend, viaGroupBackend);
      await grantBackend(database, { group: groupWithBackend }, backend, 10);

      await database.transaction().execute(async (transaction) => {
        for (const target of [direct, viaGroupServer, viaPool, viaGroupBackend]) {
          await expect(assertActorMayAdminister(transaction, actor, target)).rejects.toMatchObject({
            response: { missingCapabilities: [Capability.ManageGrants] },
          });
        }
      });

      const grantor = await actorWith(database, [Capability.ManageUsers, Capability.ManageGrants]);
      await database.transaction().execute(async (transaction) => {
        for (const target of [direct, viaGroupServer, viaPool, viaGroupBackend]) {
          await assertActorMayAdminister(transaction, grantor, target);
        }
      });
    });
  });

  it('counts expired grants too: holding a resource grant is about the record, not coverage', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actor = await actorWith(database, [Capability.ManageUsers]);
      const server = await seedServer(database);
      const target = await seedUser(database);
      await grantServer(database, { user: target }, server, {
        expiresAt: new Date(Date.now() - 86_400_000),
      });
      await database.transaction().execute(async (transaction) => {
        await expect(assertActorMayAdminister(transaction, actor, target)).rejects.toMatchObject({
          response: { missingCapabilities: [Capability.ManageGrants] },
        });
      });
    });
  });

  it('reads the actor capabilities inside the transaction and ignores inactive actors', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actor = await actorWith(database, [Capability.ManageGrants]);
      await database.transaction().execute(async (transaction) => {
        await expect(assertActorHolds(transaction, actor, [Capability.ManageGrants]))
          .resolves.toEqual(new Set([Capability.ManageGrants]));
      });
      await database.updateTable('iam.users')
        .set({ status: UserStatus.Disabled })
        .where('id', '=', actor)
        .execute();
      await database.transaction().execute(async (transaction) => {
        await expect(assertActorHolds(transaction, actor, [Capability.ManageGrants]))
          .rejects.toMatchObject({ response: { code: 'PRIVILEGE_ESCALATION_DENIED' } });
      });
    });
  });

  it('protects the final active administrator and ignores inactive ones', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const admins = await seedGroup(database, {
        name: 'Administrators',
        system: SystemGroupKey.Administrators,
        capabilities: Object.values(Capability),
      });
      const last = await seedUser(database);
      const disabled = await seedUser(database, undefined, UserStatus.Disabled);
      await addMember(database, admins, last);
      await addMember(database, admins, disabled);

      await database.transaction().execute(async (transaction) => {
        await expect(assertNotLastAdministrator(transaction, last)).rejects.toMatchObject({
          response: { code: 'LAST_ACTIVE_ADMINISTRATOR' },
        });
        // Removing someone who is not the last active administrator is fine.
        await assertNotLastAdministrator(transaction, disabled);
      });

      const second = await seedUser(database);
      await addMember(database, admins, second);
      await database.transaction().execute(async (transaction) => {
        await assertNotLastAdministrator(transaction, last);
      });
    });
  });

  it('serialises concurrent removals so two administrators cannot both leave', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const admins = await seedGroup(database, {
        name: 'Administrators',
        system: SystemGroupKey.Administrators,
        capabilities: Object.values(Capability),
      });
      const a = await seedUser(database);
      const b = await seedUser(database);
      await addMember(database, admins, a);
      await addMember(database, admins, b);

      const remove = (userId: string) => database.transaction().execute(async (transaction) => {
        await assertNotLastAdministrator(transaction, userId);
        await transaction.deleteFrom('iam.group_members')
          .where('group_id', '=', admins)
          .where('user_id', '=', userId)
          .execute();
      });
      const results = await Promise.allSettled([remove(a), remove(b)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const remaining = await database.selectFrom('iam.group_members')
        .select('user_id')
        .where('group_id', '=', admins)
        .execute();
      expect(remaining).toHaveLength(1);
    });
  });

  it('projects the same rules for the UI from the database', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const resolver = new AccessResolverService(database, transactions);
      const actor = await actorWith(database, [Capability.ManageUsers, Capability.ManageGroups]);
      const server = await seedServer(database);
      const granted = await seedUser(database);
      await grantServer(database, { user: granted }, server);

      const actions = await resolver.administrationActions(actor);
      expect(actions.users[granted]?.canAdminister).toMatchObject({
        allowed: false,
        missingCapabilities: [Capability.ManageGrants],
      });
      expect(actions.createGroup.allowed).toBe(true);
    });
  });
});
