import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import { IncusError } from '../incus/index.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { IntentRepository } from './intent.repository.js';
import { ReconcileWorkerService } from './reconcile-worker.service.js';
import { noopWake } from './reconcile-wake.test-helper.js';
import { insertServerFixture } from './server-fixture.test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('ReconcileWorkerService PostgreSQL busy breaker', () => {
  it('keeps the busy streak on the intent row so a fresh worker still trips the breaker', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const resourceId = randomUUID();
      const repository = new IntentRepository(database, noopWake());
      const pending = await repository.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetRevision: 1,
        request: {},
      });
      // Backoff would hide the intent between passes; every pass re-reads it.
      const intents = Object.assign(Object.create(repository), {
        listPending: async () => ({
          items: [(await repository.findById(pending.id))!],
          nextCursor: null,
        }),
      }) as IntentRepository;
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
        intents,
        {
          reapExpired: vi.fn().mockResolvedValue(0),
          claim: vi.fn().mockResolvedValue({
            resourceType: 'container',
            resourceId,
            serverId,
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
      );
      const read = () => database
        .selectFrom('control.intents')
        .select(['status', 'busy_attempts', 'busy_since', 'failure_code', 'attempt_count'])
        .where('id', '=', pending.id)
        .executeTakeFirstOrThrow();

      const first = make();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await first.runOnce();
      }
      expect(reconciler.markFailure).not.toHaveBeenCalled();
      const midway = await read();
      expect(midway).toMatchObject({ status: 'pending', busy_attempts: 4, attempt_count: 4 });
      expect(midway.busy_since).toBeInstanceOf(Date);

      const second = make();
      await second.runOnce();

      expect(reconciler.markFailure).toHaveBeenCalledOnce();
      expect(reconciler.markFailure).toHaveBeenCalledWith(
        resourceId,
        expect.objectContaining({ code: 'RESOURCE_NEEDS_ATTENTION' }),
        true,
      );
      await expect(read()).resolves.toMatchObject({
        status: 'failed',
        busy_attempts: 5,
        failure_code: 'RESOURCE_NEEDS_ATTENTION',
      });
    });
  });
});
