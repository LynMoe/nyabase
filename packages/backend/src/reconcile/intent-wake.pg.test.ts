import { describe, expect, it } from 'vitest';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from './intent.repository.js';
import { ReconcileWakeService, type ReconcileWakePayload } from './reconcile-wake.service.js';
import { insertServerFixture } from './server-fixture.test-helper.js';
import { randomUUID } from 'node:crypto';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('intent wake is delivered only after commit', () => {
  it('wakes the worker after the creating transaction committed, never before or on rollback', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const wake = new ReconcileWakeService();
      const woken: Array<{ payload: ReconcileWakePayload; visible: boolean }> = [];
      wake.onWake((payload) => {
        // The listener runs synchronously from wake(); read through a
        // different connection to prove the intent is already committed.
        void database
          .selectFrom('control.intents')
          .select('id')
          .where('resource_id', '=', payload.resourceId!)
          .execute()
          .then((rows) => woken.push({ payload, visible: rows.length === 1 }));
      });
      const repository = new IntentRepository(database, wake);
      const transactions = new PgTransactionManager(database);
      const input = (resourceId: string) => ({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetRevision: 1,
        request: { safe: true },
      });

      const committedId = randomUUID();
      let wokenInsideTransaction = -1;
      await transactions.run(async (transaction) => {
        await repository.createPending(input(committedId), transaction);
        wokenInsideTransaction = woken.length;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(wokenInsideTransaction).toBe(0);

      const rolledBackId = randomUUID();
      await expect(transactions.run(async (transaction) => {
        await repository.createPending(input(rolledBackId), transaction);
        throw new Error('abort');
      })).rejects.toThrow('abort');

      const standaloneId = randomUUID();
      await repository.createPending(input(standaloneId));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(woken.map((entry) => entry.payload.resourceId).sort())
        .toEqual([committedId, standaloneId].sort());
      expect(woken.every((entry) => entry.visible)).toBe(true);
      expect(woken[0]!.payload).toMatchObject({ serverId, reason: 'intent' });
    });
  });
});
