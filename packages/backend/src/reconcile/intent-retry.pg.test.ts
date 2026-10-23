import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { seedPool, seedServer, seedUser, seedVolume } from '../iam/access.pg-test-helper.js';
import { IntentRepository } from './intent.repository.js';
import { noopWake } from './reconcile-wake.test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

async function failedResize(
  repository: IntentRepository,
  input: { volumeId: string; serverId: string; requestedBy: string; sizeBytes: number },
): Promise<string> {
  const intent = await repository.createPending({
    kind: IntentKind.VolumeResize,
    resourceType: IntentResourceType.Volume,
    resourceId: input.volumeId,
    serverId: input.serverId,
    requestedBy: input.requestedBy,
    targetRevision: 1,
    request: { operation: 'resize', idempotencyKey: 'resize', sizeBytes: input.sizeBytes },
  });
  await repository.settleOne(intent.id, {
    outcome: 'failed',
    failure: { code: 'VOLUME_RESIZE_FAILED', message: 'failed', details: {} },
  });
  return intent.id;
}

async function sizeOf(database: Kysely<NyabaseDatabase>, volumeId: string): Promise<number> {
  const row = await database.selectFrom('control.volumes')
    .select('size_bytes')
    .where('id', '=', volumeId)
    .executeTakeFirstOrThrow();
  return Number(row.size_bytes);
}

describePg('intent retry', () => {
  it('never raises a volume past its current size, but retries a blocked shrink', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = await seedUser(database);
      const adminId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const volumeId = await seedVolume(database, { ownerId, poolId, serverId });
      const repository = new IntentRepository(database, noopWake());

      // Grown to 800 (failed, the row kept 800), then shrunk to 100 and the quota spent.
      const grow = await failedResize(repository, { volumeId, serverId, requestedBy: adminId, sizeBytes: 800 });
      await database.updateTable('control.volumes').set({ size_bytes: 100 }).where('id', '=', volumeId).execute();
      const retriedGrow = await repository.retry(grow, ownerId);
      expect(await sizeOf(database, volumeId)).toBe(100);
      // Attributed to whoever retried it, not to the original requester.
      expect(retriedGrow.requestedBy).toBe(ownerId);
      await repository.settleOne(retriedGrow.id, { outcome: 'succeeded' });

      // A shrink to 50 the usage blocked was reverted to 100; retrying asks for 50 again.
      const shrink = await failedResize(repository, { volumeId, serverId, requestedBy: ownerId, sizeBytes: 50 });
      const retriedShrink = await repository.retry(shrink, null);
      expect(await sizeOf(database, volumeId)).toBe(50);
      expect(retriedShrink.requestedBy).toBeNull();
      expect(retriedShrink.request).toMatchObject({ sizeBytes: 50, retryOf: shrink });
    });
  });
});
