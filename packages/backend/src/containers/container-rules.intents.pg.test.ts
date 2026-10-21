import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';
import { insertServerFixture } from '../reconcile/server-fixture.test-helper.js';
import { createContainerIntent, settleContainerIntent } from './container-rules.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('container intent settlement (PostgreSQL)', () => {
  it('does not settle restart intents when a later desired-state revision succeeds', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const resourceId = randomUUID();
      const repository = new IntentRepository(database, noopWake());
      const restart = await createContainerIntent(repository, {
        kind: IntentKind.ContainerPower,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetRevision: 1,
        request: { action: 'restart' },
        baseline: { startedAt: '2026-01-01T00:00:00.000Z' },
      });
      const update = await createContainerIntent(repository, {
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetRevision: 2,
        request: { cpu: true },
      });

      await settleContainerIntent(repository, update, 2, {
        outcome: 'succeeded',
        placementServerId: serverId,
      });
      const statuses = async () => Object.fromEntries((await database
        .selectFrom('control.intents')
        .select(['id', 'status'])
        .where('resource_id', '=', resourceId)
        .execute()).map((row) => [row.id, row.status]));
      await expect(statuses()).resolves.toEqual({
        [restart.id]: 'pending',
        [update.id]: 'succeeded',
      });

      await settleContainerIntent(repository, restart, 1, {
        outcome: 'succeeded',
        placementServerId: serverId,
      });
      await expect(statuses()).resolves.toEqual({
        [restart.id]: 'succeeded',
        [update.id]: 'succeeded',
      });
    });
  });

  it('persists the restart baseline and rejects one on other container intents', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await insertServerFixture(database);
      const repository = new IntentRepository(database, noopWake());
      const resourceId = randomUUID();
      const restart = await createContainerIntent(repository, {
        kind: IntentKind.ContainerPower,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetRevision: 1,
        request: { action: 'restart' },
        baseline: { startedAt: null },
      });
      expect(restart.baseline).toEqual({ startedAt: null });
      await expect(createContainerIntent(repository, {
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetRevision: 2,
        baseline: { startedAt: null },
      })).rejects.toThrow('Only restart intents may carry a baseline');
    });
  });
});
