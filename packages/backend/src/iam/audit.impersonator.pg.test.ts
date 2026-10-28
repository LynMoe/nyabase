import { AuditAction, Role } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import type { MonotonicClock } from '../platform/monotonic-clock.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { runImpersonated } from '../platform/request-context.js';
import { seedUser } from './access.pg-test-helper.js';
import { AuditRepository } from './audit.repository.js';
import { AuditSnapshotResolver } from './audit-snapshot.resolver.js';
import { AuditService } from './audit.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL
  ? describe
  : describe.skip;

describePg('Audit impersonator attribution (PostgreSQL)', () => {
  it('records the administrator acting as the actor and finds the row under either id', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new AuditRepository(database, transactions);
      const service = new AuditService(
        repository,
        transactions,
        { get: () => 0 } as never,
        new AuditSnapshotResolver(),
        { now: () => 0 } as MonotonicClock,
      );
      const admin = await seedUser(database, 'root-admin', undefined, Role.Admin);
      const alice = await seedUser(database, 'alice');
      const bob = await seedUser(database, 'bob');

      const context = { userId: alice, impersonatorId: admin, active: true };
      await runImpersonated(context, async () => {
        await service.log(alice, AuditAction.CreateContainer, null, null);
        await service.log(bob, AuditAction.RestartContainer, null, null);
      });
      await service.log(alice, AuditAction.DeleteContainer, null, null);
      context.active = false;
      await runImpersonated(context, () => service.log(alice, AuditAction.StartContainer, null, null));

      const rows = (await repository.list(10, 0)).items;
      const byAction = new Map(rows.map((row) => [row.action, row]));
      expect(byAction.get(AuditAction.CreateContainer)).toMatchObject({
        actorId: alice,
        actorUsername: 'alice',
        impersonatorId: admin,
        impersonatorName: 'root-admin',
        impersonatorUsername: 'root-admin',
      });
      for (const action of [AuditAction.RestartContainer, AuditAction.DeleteContainer, AuditAction.StartContainer]) {
        expect(byAction.get(action), action).toMatchObject({
          impersonatorId: null,
          impersonatorName: null,
          impersonatorUsername: null,
        });
      }

      const asAdmin = await repository.list(10, 0, { actorId: admin });
      expect(asAdmin.total).toBe(1);
      expect(asAdmin.items.map((row) => row.action)).toEqual([AuditAction.CreateContainer]);
      const asAlice = await repository.list(10, 0, { actorId: alice, action: AuditAction.CreateContainer });
      expect(asAlice.total).toBe(1);
      expect((await repository.list(10, 0, { actorId: alice })).total).toBe(3);
    });
  });
});
