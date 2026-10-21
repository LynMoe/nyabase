import { Capability, SystemGroupKey, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR_USERNAME } from '../iam/actor.js';
import { addMember, seedUser } from '../iam/access.pg-test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import {
  pickSystemActorNumericId,
  SYSTEM_ACTOR_DISPLAY_NAME,
  SYSTEM_ACTOR_PREFERRED_NUMERIC_ID,
  SystemGroupsService,
} from './system-groups.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describe('pickSystemActorNumericId', () => {
  it('prefers 4096 when free', () => {
    expect(pickSystemActorNumericId([1, 100, 1001, 3001])).toBe(SYSTEM_ACTOR_PREFERRED_NUMERIC_ID);
  });

  it('picks the highest unused id that avoids common test numeric ids', () => {
    expect(pickSystemActorNumericId([4096, 1, 100, 1001, 3001])).toBe(4095);
    expect(pickSystemActorNumericId([4096, 4095, 3001])).toBe(4094);
  });
});

describePg('SystemGroupsService', () => {
  const service = (database: Parameters<typeof seedUser>[0]) =>
    new SystemGroupsService(database, new PgTransactionManager(database));

  it('seeds Administrators (everything), Operators (operations subset) and Users (nothing)', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const groups = await service(database).ensureSystemGroups();

      expect([...groups.admins.capabilities].sort()).toEqual(Object.values(Capability).sort());
      expect(groups.operators.capabilities).toEqual(expect.arrayContaining([
        Capability.ManageServers,
        Capability.ManageContainersAny,
        Capability.ManageGrants,
      ]));
      expect(groups.operators.capabilities).not.toContain(Capability.ManageUsers);
      expect(groups.operators.capabilities).not.toContain(Capability.ManageGroups);
      expect(groups.users.capabilities).toEqual([]);
      expect([groups.admins, groups.operators, groups.users].every((group) => group.isSystem)).toBe(true);
    });
  });

  it('creates a login-disabled nyabase-system actor outside every group', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      await service(database).ensureSystemGroups();
      const actor = await database.selectFrom('iam.users')
        .selectAll()
        .where('username', '=', SYSTEM_ACTOR_USERNAME)
        .executeTakeFirstOrThrow();
      expect(actor).toMatchObject({
        display_name: SYSTEM_ACTOR_DISPLAY_NAME,
        status: UserStatus.Disabled,
        numeric_id: SYSTEM_ACTOR_PREFERRED_NUMERIC_ID,
      });
      expect(actor.password_hash).toMatch(/^\$argon2id\$/);
      expect(await database.selectFrom('iam.group_members').select('id')
        .where('user_id', '=', actor.id).execute()).toEqual([]);
    });
  });

  it('is idempotent, strips system-group membership from the actor, and repairs drifted capabilities', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const groups = service(database);
      const first = await groups.ensureSystemGroups();
      const actor = await database.selectFrom('iam.users').select('id')
        .where('username', '=', SYSTEM_ACTOR_USERNAME).executeTakeFirstOrThrow();
      await addMember(database, first.admins.id, actor.id);
      await database.updateTable('iam.groups').set({ capabilities: [] })
        .where('id', '=', first.operators.id).execute();

      const second = await groups.ensureSystemGroups();

      expect(second.admins.id).toBe(first.admins.id);
      expect(await database.selectFrom('iam.users').select('id')
        .where('username', '=', SYSTEM_ACTOR_USERNAME).execute()).toHaveLength(1);
      expect(await database.selectFrom('iam.group_members').select('id')
        .where('user_id', '=', actor.id).execute()).toEqual([]);
      expect(second.operators.capabilities.length).toBeGreaterThan(0);
      expect(second.operators.revision).toBe(first.operators.revision + 1);
    });
  });

  it('does not take numeric ids 1, 100, 1001, or 3001 when 4096 is occupied', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const occupied = await seedUser(database, 'occupied-high');
      await database.updateTable('iam.users').set({ numeric_id: 4096 }).where('id', '=', occupied).execute();

      await service(database).ensureSystemGroups();
      const actor = await database.selectFrom('iam.users').select('numeric_id')
        .where('username', '=', SYSTEM_ACTOR_USERNAME).executeTakeFirstOrThrow();
      expect([1, 100, 1001, 3001, 4096]).not.toContain(actor.numeric_id);
      expect(actor.numeric_id).toBe(4095);
    });
  });

  it('adds the bootstrap administrator to Administrators once', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const groups = service(database);
      const { admins } = await groups.ensureSystemGroups();
      const adminId = await seedUser(database, 'admin');

      await groups.ensureUserInSystemGroup(SystemGroupKey.Administrators, adminId);
      await groups.ensureUserInSystemGroup(SystemGroupKey.Administrators, adminId);
      expect(await database.selectFrom('iam.group_members').select('user_id')
        .where('group_id', '=', admins.id).execute()).toEqual([{ user_id: adminId }]);
    });
  });
});
