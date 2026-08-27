import { randomUUID } from 'node:crypto';
import { Capability, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { UsersService } from './users.service.js';
import { userRow } from './users.pg-test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('Admin user bulk projection', () => {
  it('projects active, disabled, and deleting users while omitting tombstones', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const groupId = randomUUID();
      await fixture.database.insertInto('iam.groups').values({
        id: groupId,
        name: 'Projection group',
        description: null,
        priority: 7,
        is_system: false,
        system_key: null,
        capabilities: [Capability.ManageUsers],
        revision: 1,
      }).execute();
      const rows = [
        userRow(randomUUID(), 1001, 'listed-active', UserStatus.Active),
        userRow(randomUUID(), 1002, 'listed-disabled', UserStatus.Disabled),
        userRow(randomUUID(), 1003, 'listed-deleting', UserStatus.Deleting),
        userRow(randomUUID(), 1004, 'listed-deleted', UserStatus.Deleted),
      ];
      await fixture.database.insertInto('iam.users').values(rows).execute();
      await fixture.database.insertInto('iam.group_members').values(rows.map((row) => ({
        id: randomUUID(),
        group_id: groupId,
        user_id: row.id,
      }))).execute();

      const service = new UsersService(
        fixture.database,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
      );
      const listed = await service.listDtos();
      expect(listed.map((user) => user.username)).toEqual([
        'listed-active',
        'listed-deleting',
        'listed-disabled',
      ]);
      expect(listed.some((user) => user.status === UserStatus.Deleted)).toBe(false);
      expect(listed.find((user) => user.username === 'listed-active')?.capabilities)
        .toEqual([Capability.ManageUsers]);
    });
  });
});
