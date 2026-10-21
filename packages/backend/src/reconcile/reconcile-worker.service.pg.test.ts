import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/index.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { ReconcileWorkerService } from './reconcile-worker.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('ReconcileWorkerService PostgreSQL busy breaker', () => {
  it('persists busy strikes so a fresh worker still trips the breaker', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const resourceId = randomUUID();
      const reconciler = {
        resourceType: 'container',
        supports: () => true,
        reconcile: vi.fn().mockRejectedValue(
          new IncusError('INSTANCE_BUSY', 'retry', { action: 'start' }),
        ),
        needsAttention: vi.fn().mockResolvedValue(false),
        markSucceeded: vi.fn().mockResolvedValue(undefined),
        markFailure: vi.fn().mockResolvedValue(undefined),
      };
      const registry = {
        all: () => [reconciler],
        forIntent: () => reconciler,
        forResource: () => reconciler,
        serverHealth: () => ({
          isCurrentServerIntent: vi.fn().mockResolvedValue(true),
          markServer: vi.fn().mockResolvedValue(undefined),
        }),
      };
      const make = () => new ReconcileWorkerService(
        {
          listPending: vi.fn().mockResolvedValue({
            items: [{
              id: randomUUID(),
              kind: 'container.update',
              resourceType: 'container',
              resourceId,
              serverId: randomUUID(),
              targetGeneration: 1,
              status: 'pending',
              attemptCount: 0,
              readyAt: new Date(),
              request: {},
              baseline: null,
            }],
            nextCursor: null,
          }),
          scheduleRetry: vi.fn().mockResolvedValue(undefined),
          settleForObservedGeneration: vi.fn().mockResolvedValue(undefined),
          settleOne: vi.fn().mockResolvedValue(true),
        } as never,
        {
          reapExpired: vi.fn().mockResolvedValue(0),
          claim: vi.fn().mockResolvedValue({
            resourceType: 'container',
            resourceId,
            serverId: null,
            workerId: 'pg-test',
            leaseExpiresAt: new Date(Date.now() + 60_000),
            claimedAt: new Date(),
          }),
          withLease: vi.fn(async (
            _claim: unknown,
            operation: (lease: { assertOwned: () => void }) => Promise<void>,
          ) => operation({ assertOwned: vi.fn() })),
        } as never,
        registry as never,
        { get: vi.fn().mockResolvedValue({}), listServerIds: vi.fn().mockResolvedValue([]) } as never,
        { onWake: vi.fn(() => () => undefined), wake: vi.fn() } as never,
        database,
      );

      const first = make();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await first.runOnce();
      }
      expect(reconciler.markFailure).not.toHaveBeenCalled();

      const second = make();
      await second.runOnce();

      const strikes = await database
        .selectFrom('control.reconcile_busy_strikes')
        .selectAll()
        .where('resource_type', '=', 'container')
        .where('resource_id', '=', resourceId)
        .execute();
      expect(strikes).toHaveLength(5);
      expect(reconciler.markFailure).toHaveBeenCalledOnce();
    });
  });
});
