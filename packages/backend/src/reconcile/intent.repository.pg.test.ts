import { randomUUID } from 'node:crypto';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { IntentRepository } from './intent.repository.js';
import { noopWake } from './reconcile-wake.test-helper.js';
import { insertServerFixture } from './server-fixture.test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('IntentRepository empty resourceIds (PostgreSQL)', () => {
  it('does not compile IN () for list or listPending', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new IntentRepository(database, noopWake());
      await expect(repository.list({
        resourceType: IntentResourceType.ImageAssignment,
        resourceIds: [],
      })).resolves.toEqual({ items: [], nextCursor: null });
      await expect(repository.listPending({
        resourceIds: [],
      })).resolves.toEqual({ items: [], nextCursor: null });
    });
  });
});

describePg('IntentRepository busy streak (PostgreSQL)', () => {
  const create = async (
    repository: IntentRepository,
    serverId: string,
    targetRevision = 1,
  ) => repository.createPending({
    kind: IntentKind.ContainerUpdate,
    resourceType: IntentResourceType.Container,
    resourceId: randomUUID(),
    serverId,
    targetRevision,
    request: {},
  });

  it('counts per intent inside the window and restarts once the window has passed', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const repository = new IntentRepository(database, noopWake());
      const first = await create(repository, serverId);
      const other = await create(repository, serverId);
      const read = (id: string) => database
        .selectFrom('control.intents')
        .select(['busy_attempts', 'busy_since'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      await expect(read(first.id)).resolves.toEqual({ busy_attempts: 0, busy_since: null });
      expect(await repository.recordBusyAttempt(first.id, 300_000)).toBe(1);
      const started = (await read(first.id)).busy_since!;
      expect(await repository.recordBusyAttempt(first.id, 300_000)).toBe(2);
      expect(await repository.recordBusyAttempt(first.id, 300_000)).toBe(3);
      // The window is anchored on the first strike of the streak.
      expect((await read(first.id)).busy_since!.getTime()).toBe(started.getTime());
      // A different intent keeps its own streak.
      expect(await repository.recordBusyAttempt(other.id, 300_000)).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await repository.recordBusyAttempt(first.id, 30)).toBe(1);
      expect((await read(first.id)).busy_since!.getTime()).toBeGreaterThan(started.getTime());
    });
  });

  it('clears the streak on reset and ignores settled intents', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const repository = new IntentRepository(database, noopWake());
      const intent = await create(repository, serverId);
      await repository.recordBusyAttempt(intent.id, 300_000);
      await repository.recordBusyAttempt(intent.id, 300_000);
      await repository.resetBusyAttempts(intent.id);
      await expect(database
        .selectFrom('control.intents')
        .select(['busy_attempts', 'busy_since'])
        .where('id', '=', intent.id)
        .executeTakeFirstOrThrow()).resolves.toEqual({ busy_attempts: 0, busy_since: null });

      await repository.settleOne(intent.id, { outcome: 'succeeded' });
      expect(await repository.recordBusyAttempt(intent.id, 300_000)).toBe(0);
    });
  });

  it('rejects a busy streak with a count but no start time', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const repository = new IntentRepository(database, noopWake());
      const intent = await create(repository, serverId);
      await expect(database
        .updateTable('control.intents')
        .set({ busy_attempts: 2 })
        .where('id', '=', intent.id)
        .execute()).rejects.toThrow(/intents_busy_shape_check/);
    });
  });
});

describePg('IntentRepository retention and queue helpers (PostgreSQL)', () => {
  it('prunes old settled intents but keeps pending ones and the newest per resource', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const repository = new IntentRepository(database, noopWake());
      const resourceId = randomUUID();
      const make = async (targetRevision: number) => repository.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetRevision,
        request: {},
      });
      const oldSucceeded = await make(1);
      const oldFailed = await make(2);
      const oldPending = await make(3);
      const newestSettled = await make(4);
      await repository.settleOne(oldSucceeded.id, { outcome: 'succeeded' });
      await repository.settleOne(oldFailed.id, {
        outcome: 'failed',
        failure: { code: 'X', message: 'x' },
      });
      await repository.settleOne(newestSettled.id, { outcome: 'succeeded' });
      await database.updateTable('control.intents')
        .set({ created_at: new Date(Date.now() - 40 * 24 * 60 * 60_000) })
        .where('resource_id', '=', resourceId)
        .execute();
      // Keep creation order: the newest intent stays the newest.
      await database.updateTable('control.intents')
        .set({ created_at: new Date(Date.now() - 39 * 24 * 60 * 60_000) })
        .where('id', '=', newestSettled.id)
        .execute();

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      expect(await repository.pruneSettled(cutoff, 1)).toBe(1);
      expect(await repository.pruneSettled(cutoff)).toBe(1);
      expect(await repository.pruneSettled(cutoff)).toBe(0);
      const left = await database.selectFrom('control.intents').select('id')
        .where('resource_id', '=', resourceId).orderBy('target_revision').execute();
      expect(left.map((row) => row.id)).toEqual([oldPending.id, newestSettled.id]);
    });
  });

  it('reports the earliest future retry and excludes ids from a pending page', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const repository = new IntentRepository(database, noopWake());
      const create = () => repository.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: randomUUID(),
        serverId,
        targetRevision: 1,
        request: {},
      });
      const first = await create();
      const second = await create();
      expect(await repository.nextRetryAt()).toBeNull();
      const at = new Date(Date.now() + 60_000);
      await repository.scheduleRetry(first.id, at);
      expect((await repository.nextRetryAt())?.getTime()).toBe(at.getTime());
      const page = await repository.listPending({ readyAt: new Date(), excludeIds: [second.id] });
      expect(page.items).toEqual([]);
    });
  });
});
