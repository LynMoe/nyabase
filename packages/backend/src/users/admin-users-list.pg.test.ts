import { randomUUID } from 'node:crypto';
import { Capability, UserStatus } from '@nyabase/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { UsersService } from './users.service.js';
import { userRow, usersPgFixture } from './users.pg-test-helper.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('Admin user bulk projection query bound', () => {
  it('matches detail authorization semantics across every durable user state', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await usersPgFixture(fixture, {
        seedActor: false,
        seedTarget: false,
      });
      const groupId = randomUUID();
      await fixture.database.insertInto('iam.groups').values({
        id: groupId,
        name: 'State matrix',
        description: null,
        priority: 9,
        is_system: false,
        system_key: null,
        capabilities: [Capability.ManageUsers],
        revision: 1,
      }).execute();
      const states = [
        UserStatus.Active,
        UserStatus.Disabled,
        UserStatus.Deleting,
        UserStatus.Deleted,
      ];
      const rows = states.map((status, index) =>
        userRow(randomUUID(), index + 1, `state-${status}`, status));
      await fixture.database.insertInto('iam.users').values(rows).execute();
      await fixture.database.insertInto('iam.group_members').values(rows.map((row) => ({
        id: randomUUID(),
        group_id: groupId,
        user_id: row.id,
      }))).execute();

      const list = await context.users.listDtos();
      expect(list.map((user) => user.status)).toEqual([
        UserStatus.Active,
        UserStatus.Deleting,
        UserStatus.Disabled,
      ]);
      const active = list.find((user) => user.status === UserStatus.Active)!;
      await expect(context.users.toDto(
        await context.users.findById(active.id),
      )).resolves.toEqual(active);
      for (const status of [UserStatus.Disabled, UserStatus.Deleting]) {
        expect(list.find((user) => user.status === status)).toMatchObject({
          capabilities: [],
          groups: [],
        });
      }
      expect(list.some((user) => user.status === UserStatus.Deleted)).toBe(false);
    });
  });

  it('uses exactly two queries for both 128 and 4096 users on a one-connection pool', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const groupId = randomUUID();
      await fixture.database.insertInto('iam.groups').values({
        id: groupId,
        name: 'Bulk users',
        description: null,
        priority: 7,
        is_system: false,
        system_key: null,
        capabilities: [Capability.ManageUsers, Capability.ManageGroups],
        revision: 1,
      }).execute();

      let queryCount = 0;
      const pool = new Pool({ connectionString: fixture.connectionString, max: 1 });
      pool.on('error', () => undefined);
      const database = new Kysely<NyabaseDatabase>({
        dialect: new PostgresDialect({ pool }),
        log: (event) => {
          if (event.level === 'query') queryCount += 1;
        },
      });
      const service = new UsersService(
        database,
        new PgTransactionManager(database),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { get: vi.fn() } as never,
        {} as never,
      );
      try {
        const ids: string[] = [];
        for (let start = 0; start < 4_096; start += 256) {
          const rows = Array.from({ length: 256 }, (_, offset) => {
            const index = start + offset;
            const id = randomUUID();
            ids.push(id);
            return userRow(id, index + 1, `bulk-${String(index).padStart(4, '0')}`, UserStatus.Active);
          });
          await fixture.database.insertInto('iam.users').values(rows).execute();
          await fixture.database.insertInto('iam.group_members').values(rows.map((row) => ({
            id: randomUUID(),
            group_id: groupId,
            user_id: row.id,
          }))).execute();
          if (ids.length === 128) {
            throw new Error('Chunk size must permit the 128-user checkpoint');
          }
        }

        // Exercise the smaller shape in the same schema without weakening the
        // production query: temporarily tombstone the tail, then restore it.
        await fixture.database.updateTable('iam.users')
          .set({ status: UserStatus.Deleted })
          .where('id', 'in', ids.slice(128))
          .execute();
        queryCount = 0;
        const small = await service.listDtos();
        expect(queryCount).toBe(2);
        expect(small).toHaveLength(128);
        expect(small[0]).toMatchObject({
          capabilities: [Capability.ManageUsers, Capability.ManageGroups],
          groups: [{ id: groupId, priority: 7 }],
        });

        await fixture.database.updateTable('iam.users')
          .set({ status: UserStatus.Active })
          .where('id', 'in', ids.slice(128))
          .execute();
        queryCount = 0;
        const large = await service.listDtos();
        expect(queryCount).toBe(2);
        expect(large).toHaveLength(4_096);
        expect(large.at(-1)?.groups).toHaveLength(1);
      } finally {
        await database.destroy();
      }
    });
  }, 60_000);
});
