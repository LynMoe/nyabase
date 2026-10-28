import { randomUUID } from 'node:crypto';
import { AuditAction } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import {
  AuditRepository,
  type AppendAuditEvent,
} from './audit.repository.js';
import { AuditSnapshotResolver } from './audit-snapshot.resolver.js';
import type { MonotonicClock } from '../platform/monotonic-clock.js';
import { AuditService } from './audit.service.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const describePg = process.env.NYABASE_TEST_DATABASE_URL
  ? describe
  : describe.skip;

describePg('Audit retention PostgreSQL boundaries', () => {
  it('keeps the age and count boundaries while deleting strict overflow', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new AuditRepository(
        database,
        new PgTransactionManager(database),
      );
      const now = Date.now();
      const oldId = randomUUID();
      const insideCutoffId = randomUUID();
      const recentId = randomUUID();
      const countBoundaryId = randomUUID();
      const overflowId = randomUUID();

      await insertAuditRow(database, auditEvent(oldId, 'old'), new Date(now - 7 * DAY_MS - 60_000));
      await insertAuditRow(
        database,
        auditEvent(insideCutoffId, 'inside-cutoff'),
        new Date(now - 7 * DAY_MS + 60_000),
      );
      await insertAuditRow(database, auditEvent(recentId, 'recent'), new Date(now - 2 * 60 * 60 * 1_000));

      await repository.enforceRetention({
        retentionDays: 7,
        maxEntries: 3,
        enforceAge: true,
        enforceCount: true,
      });

      await expect(repository.findById(oldId)).resolves.toBeNull();
      await expect(repository.findById(insideCutoffId)).resolves.toBeDefined();
      expect((await repository.list(10, 0)).total).toBe(2);

      await insertAuditRow(
        database,
        auditEvent(countBoundaryId, 'count-boundary'),
        new Date(now - 60 * 60 * 1_000),
      );
      await repository.enforceRetention({
        retentionDays: 0,
        maxEntries: 3,
        enforceAge: false,
        enforceCount: true,
      });
      expect((await repository.list(10, 0)).total).toBe(3);
      await expect(repository.findById(insideCutoffId)).resolves.toBeDefined();

      await insertAuditRow(
        database,
        auditEvent(overflowId, 'overflow'),
        new Date(now - 30 * 60 * 1_000),
      );
      await repository.enforceRetention({
        retentionDays: 0,
        maxEntries: 3,
        enforceAge: false,
        enforceCount: true,
      });

      const remaining = await repository.list(10, 0);
      expect(remaining.total).toBe(3);
      expect(new Set(remaining.items.map((item) => item.id))).toEqual(
        new Set([recentId, countBoundaryId, overflowId]),
      );
      await expect(repository.findById(insideCutoffId)).resolves.toBeNull();
    });
  });

  it('runs append cleanup only after the caller transaction commits', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const service = auditService(repository, transactions, 0, 1);
      const retainedId = randomUUID();

      await insertAuditRow(database, auditEvent(retainedId, 'retained'), new Date('2026-08-07T00:00:00.000Z'));

      await expect(transactions.run(async (transaction) => {
        await service.append(
          transaction,
          null,
          AuditAction.CreateGrantBundle,
          null,
          null,
          { secret: 'rollback-secret' },
        );
        throw new Error('rollback');
      })).rejects.toThrow('rollback');

      await expect(repository.list(10, 0)).resolves.toMatchObject({
        total: 1,
        items: [expect.objectContaining({ id: retainedId })],
      });

      await transactions.run((transaction) => service.append(
        transaction,
        null,
        AuditAction.CreateGrantBundle,
        null,
        null,
        { secret: 'committed-secret' },
      ));

      await vi.waitFor(async () => {
        expect((await repository.list(10, 0)).total).toBe(1);
      });
      const committed = await repository.list(10, 0);
      expect(committed.items[0]?.id).not.toBe(retainedId);
      expect(committed.items[0]?.payload).toEqual({
        secret: '[REDACTED]',
      });
    });
  });

  it('does not hold the shared retention lock inside business transactions', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const service = auditService(repository, transactions, 0, 100);
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const holder = transactions.run(async (transaction) => {
        await sql`select pg_advisory_xact_lock(1856214885, 4)`.execute(transaction);
        locked();
        await released;
      });
      await lockTaken;

      // Would block until `release()` if append still enforced retention in-transaction.
      await transactions.run((transaction) => service.append(
        transaction,
        null,
        AuditAction.CreateGrantBundle,
        null,
        null,
      ));
      expect((await repository.list(10, 0)).total).toBe(1);
      release();
      await holder;
    });
  });

  it('enforces count retention for the post-commit log path', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const service = auditService(repository, transactions, 0, 1);

      await insertAuditRow(
        database,
        auditEvent(randomUUID(), 'before-log'),
        new Date('2026-08-07T00:00:00.000Z'),
      );
      await service.log(
        null,
        AuditAction.CreateGrantBundle,
        null,
        null,
        { token: 'log-secret' },
      );

      const events = await repository.list(10, 0);
      expect(events.total).toBe(1);
      expect(events.items[0]?.payload).toEqual({
        token: '[REDACTED]',
      });
    });
  });
});

function auditService(
  repository: AuditRepository,
  transactions: PgTransactionManager,
  retentionDays: number,
  maxEntries: number,
): AuditService {
  return new AuditService(
    repository,
    transactions,
    {
      get: (key: string) => {
        if (key === 'audit.retentionDays') return retentionDays;
        if (key === 'audit.retentionMaxEntries') return maxEntries;
        return undefined;
      },
    } as never,
    new AuditSnapshotResolver(),
    { now: () => 0 } as MonotonicClock,
  );
}

/** Deterministic timestamps need a direct insert; AuditRepository.append always uses the DB clock. */
async function insertAuditRow(
  database: Kysely<NyabaseDatabase>,
  event: AppendAuditEvent,
  occurredAt: Date,
): Promise<void> {
  await database.insertInto('audit.events').values({
    id: event.id,
    actor_id: event.actorId,
    actor_name: event.actorName,
    actor_username: event.actorUsername,
    actor_snapshot: null,
    action: event.action,
    target_id: event.targetId,
    target_type: event.targetType,
    target_name: event.targetName,
    target_snapshot: null,
    related: '[]',
    detail: null,
    occurred_at: occurredAt,
  }).execute();
}

function auditEvent(id: string, targetId: string): AppendAuditEvent {
  return {
    id,
    actorId: null,
    actorName: null,
    actorUsername: null,
    actorSnapshot: null,
    impersonatorId: null,
    impersonatorName: null,
    impersonatorUsername: null,
    action: AuditAction.CreateGrantBundle,
    targetId,
    targetType: 'grant_bundle',
    targetName: targetId,
    targetSnapshot: null,
    related: [],
    payload: null,
  };
}
