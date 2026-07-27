import { randomUUID } from 'node:crypto';
import { AuditAction } from '@nyabase/common';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AuditRepository } from './audit.repository.js';
import { PgAuditSnapshotResolver } from './audit-snapshot.resolver.js';
import { AuditService } from './audit.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL
  ? describe
  : describe.skip;

describePg('Audit PostgreSQL integration', () => {
  it('uses PostgreSQL time for append and production retention under app clock skew', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const service = auditService(repository, transactions);
      const before = await database.selectNoFrom((expression) =>
        expression.fn<Date>('clock_timestamp').as('now'))
        .executeTakeFirstOrThrow();

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(before.now.getTime() - 86_400_000));
        await service.log(null, AuditAction.CreateGroup, null, null);
        vi.setSystemTime(new Date(before.now.getTime() + 365 * 86_400_000));
        await service.log(null, AuditAction.CreateGroup, null, null);
        await repository.enforceRetention({
          retentionDays: 7,
          maxEntries: 0,
          enforceAge: true,
          enforceCount: false,
        });
      } finally {
        vi.useRealTimers();
      }

      const after = await database.selectNoFrom((expression) =>
        expression.fn<Date>('clock_timestamp').as('now'))
        .executeTakeFirstOrThrow();
      const events = await repository.list(10, 0);
      expect(events.items).toHaveLength(2);
      for (const event of events.items) {
        expect(event.ts.getTime()).toBeGreaterThanOrEqual(before.now.getTime());
        expect(event.ts.getTime()).toBeLessThanOrEqual(after.now.getTime());
      }
    });
  });

  it('appends immutable snapshots and supports stable paging and filters', async () => {
    await withPostgresTestDatabase(async ({ database, pool }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const service = auditService(repository, transactions);
      const actorId = randomUUID();
      const userId = randomUUID();
      const groupId = randomUUID();
      await seedUser(database, actorId, 1001, 'admin', '管理员');
      await seedUser(database, userId, 1002, 'lin', 'Lin');
      await seedGroup(database, groupId, 'Developers');

      await service.log(
        actorId,
        AuditAction.CreateGroup,
        groupId,
        'group',
        { name: 'Developers', password: 'never-store' },
      );
      await service.log(
        actorId,
        AuditAction.AddGroupMember,
        groupId,
        'group',
        { userId },
      );

      const filtered = await repository.list(10, 0, {
        action: AuditAction.AddGroupMember,
        actorId,
        targetType: 'group',
        targetId: groupId,
      });
      expect(filtered.total).toBe(1);
      expect(filtered.items[0]).toMatchObject({
        actorId,
        actorName: '管理员 (admin)',
        actorUsername: 'admin',
        actorSnapshot: {
          id: actorId,
          type: 'user',
          labels: { username: 'admin', numericId: 1001 },
        },
        targetId: groupId,
        targetName: 'Developers',
        targetSnapshot: {
          id: groupId,
          type: 'group',
          name: 'Developers',
        },
        related: expect.arrayContaining([
          expect.objectContaining({ id: groupId, type: 'group' }),
          expect.objectContaining({ id: userId, type: 'user' }),
        ]),
      });

      const page = await repository.list(1, 1);
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(1);
      await expect(repository.list(1, 100_001)).rejects.toBeInstanceOf(RangeError);
      const detail = await repository.findById(filtered.items[0]!.id);
      expect(detail?.payload).toEqual({ userId });

      await expect(pool.query(
        'UPDATE audit.events SET target_name = $1 WHERE id = $2',
        ['tampered', filtered.items[0]!.id],
      )).rejects.toMatchObject({ code: '55000' });
    });
  });

  it('keeps a caller business mutation and audit append in the same rollback boundary', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const service = auditService(repository, transactions);
      const groupId = randomUUID();

      await expect(transactions.run(async (transaction) => {
        await transaction
          .insertInto('iam.groups')
          .values(groupValues(groupId, 'Rollback Group'))
          .executeTakeFirstOrThrow();
        await service.append(
          transaction,
          null,
          AuditAction.CreateGroup,
          groupId,
          'group',
          { name: 'Rollback Group' },
        );
        throw new Error('rollback');
      })).rejects.toThrow('rollback');

      await expect(database
        .selectFrom('iam.groups')
        .select((expression) => expression.fn.countAll<string>().as('count'))
        .where('id', '=', groupId)
        .executeTakeFirstOrThrow()).resolves.toMatchObject({ count: '0' });
      await expect(repository.list(10, 0)).resolves.toMatchObject({
        total: 0,
        items: [],
      });

      await transactions.run(async (transaction) => {
        await transaction
          .insertInto('iam.groups')
          .values(groupValues(groupId, 'Committed Group'))
          .executeTakeFirstOrThrow();
        await service.append(
          transaction,
          null,
          AuditAction.CreateGroup,
          groupId,
          'group',
          { name: 'Committed Group' },
        );
      });
      expect((await repository.list(10, 0)).total).toBe(1);
    });
  });

  it('audits a non-UUID local mount-source delete without aborting PostgreSQL', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const service = auditService(repository, transactions);
      const sourceId = 'node-a-local';

      await transactions.run(async (transaction) => {
        await service.append(
          transaction,
          null,
          AuditAction.DeleteMountSourceGrant,
          sourceId,
          'mount_source',
          {
            scope: 'group',
            scopeId: randomUUID(),
            sourceKind: 'local',
            sourceId,
            serverId: randomUUID(),
          },
        );
        await expect(transaction
          .selectFrom('audit.events')
          .select('target_id')
          .where('target_id', '=', sourceId)
          .executeTakeFirst()).resolves.toMatchObject({ target_id: sourceId });
      });

      await expect(repository.list(10, 0)).resolves.toMatchObject({
        total: 1,
        items: [
          expect.objectContaining({
            action: AuditAction.DeleteMountSourceGrant,
            targetId: sourceId,
          }),
        ],
      });
    });
  });

  it('enforces age and count retention with deterministic oldest-first deletion', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const now = new Date('2026-07-25T12:00:00.000Z');
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const times = [
        new Date('2026-06-01T00:00:00.000Z'),
        new Date('2026-07-25T09:00:00.000Z'),
        new Date('2026-07-25T10:00:00.000Z'),
        new Date('2026-07-25T11:00:00.000Z'),
      ];
      for (let index = 0; index < ids.length; index += 1) {
        await repository.appendAtForTest(database, {
          id: ids[index]!,
          actorId: null,
          actorName: null,
          actorUsername: null,
          actorSnapshot: null,
          action: AuditAction.CreateGroup,
          targetId: `group-${index}`,
          targetType: 'group',
          targetName: `Group ${index}`,
          targetSnapshot: null,
          related: [],
          payload: null,
        }, times[index]!);
      }

      await repository.enforceRetentionAtForTest({
        retentionDays: 7,
        maxEntries: 2,
        enforceAge: true,
        enforceCount: true,
      }, now);

      const remaining = await repository.list(10, 0);
      expect(remaining.total).toBe(2);
      expect(remaining.items.map((item) => item.id)).toEqual([
        ids[3],
        ids[2],
      ]);
      await expect(repository.findById(ids[0]!)).resolves.toBeNull();
      await expect(repository.findById(ids[1]!)).resolves.toBeNull();
    });
  });

  it('bounds each retention pass and converges through repeated indexed batches', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      await sql`
        INSERT INTO audit.events (id, action, target_id, related, occurred_at)
        SELECT
          md5('audit-old-' || series.value::text)::uuid,
          'group.create',
          series.value::text,
          '[]'::jsonb,
          timestamp with time zone '2020-01-01 00:00:00+00'
        FROM generate_series(1, 1005) AS series(value)
      `.execute(database);
      await sql`
        INSERT INTO audit.events (id, action, target_id, related, occurred_at)
        SELECT
          md5('audit-recent-' || series.value::text)::uuid,
          'group.create',
          'recent-' || series.value::text,
          '[]'::jsonb,
          timestamp with time zone '2026-07-26 00:00:00+00'
        FROM generate_series(1, 10000) AS series(value)
      `.execute(database);
      await repository.append(database, {
        id: randomUUID(),
        actorId: null,
        actorName: null,
        actorUsername: null,
        actorSnapshot: null,
        action: AuditAction.CreateGroup,
        targetId: 'recent',
        targetType: 'group',
        targetName: 'Recent',
        targetSnapshot: null,
        related: [],
        payload: null,
      });

      await repository.enforceRetentionAtForTest({
        retentionDays: 7,
        maxEntries: 0,
        enforceAge: true,
        enforceCount: false,
      }, new Date('2026-07-27T00:00:00Z'));
      expect((await repository.list(2_000, 0)).total).toBe(10_006);
      await repository.enforceRetentionAtForTest({
        retentionDays: 7,
        maxEntries: 0,
        enforceAge: true,
        enforceCount: false,
      }, new Date('2026-07-27T00:00:00Z'));
      expect((await repository.list(2_000, 0)).total).toBe(10_001);

      await sql`ANALYZE audit.events`.execute(database);
      const plan = await sql<Record<string, unknown>>`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT id FROM audit.events
        WHERE occurred_at < timestamp with time zone '2026-07-20 00:00:00+00'
        ORDER BY occurred_at, id
        LIMIT 1000
      `.execute(database);
      expect(JSON.stringify(plan.rows)).toContain('audit_events_occurred_idx');
    });
  });

  it('skips concurrently locked retention rows instead of blocking the batch', async () => {
    await withPostgresTestDatabase(async ({ database, pool }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const now = new Date('2026-07-27T00:00:00Z');
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      for (let index = 0; index < ids.length; index += 1) {
        await repository.appendAtForTest(database, {
          id: ids[index]!,
          actorId: null,
          actorName: null,
          actorUsername: null,
          actorSnapshot: null,
          action: AuditAction.CreateGroup,
          targetId: `locked-${index}`,
          targetType: 'group',
          targetName: `Locked ${index}`,
          targetSnapshot: null,
          related: [],
          payload: null,
        }, new Date(`2020-01-01T00:00:0${index}.000Z`));
      }

      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT id FROM audit.events WHERE id = $1 FOR UPDATE',
          [ids[0]],
        );

        await repository.enforceRetentionAtForTest({
          retentionDays: 7,
          maxEntries: 0,
          enforceAge: true,
          enforceCount: false,
        }, now);

        expect((await repository.list(10, 0)).items.map((item) => item.id))
          .toEqual([ids[0]]);
        await blocker.query('COMMIT');
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
    });
  });
});

function auditService(
  repository: AuditRepository,
  transactions: PgTransactionManager,
): AuditService {
  return new AuditService(
    repository,
    transactions,
    {
      get: (key: string) =>
        key === 'audit.retentionDays' || key === 'audit.retentionMaxEntries'
          ? 0
          : undefined,
    } as never,
    new PgAuditSnapshotResolver(),
  );
}

async function seedUser(
  database: Kysely<NyabaseDatabase>,
  id: string,
  numericId: number,
  username: string,
  displayName: string,
): Promise<void> {
  await database
    .insertInto('iam.users')
    .values({
      id,
      numeric_id: numericId,
      username,
      password_hash: 'hash',
      display_name: displayName,
      status: 'active',
      auth_version: 0,
      authz_version: 0,
    })
    .executeTakeFirstOrThrow();
}

async function seedGroup(
  database: Kysely<NyabaseDatabase>,
  id: string,
  name: string,
): Promise<void> {
  await database
    .insertInto('iam.groups')
    .values(groupValues(id, name))
    .executeTakeFirstOrThrow();
}

function groupValues(id: string, name: string) {
  return {
    id,
    name,
    description: 'test group',
    priority: 0,
    is_system: false,
    system_key: null,
    capabilities: [],
    revision: 1,
  };
}
