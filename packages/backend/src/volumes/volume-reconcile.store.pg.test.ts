import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';
import {
  seedBackend,
  seedBackendPool,
  seedServer,
  seedUser,
  seedVolume,
} from '../iam/access.pg-test-helper.js';
import { VolumeReconcileStore } from './volume-reconcile.store.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

async function volumeState(database: Kysely<NyabaseDatabase>, volumeId: string) {
  return database.selectFrom('control.volumes')
    .select(['needs_attention', 'failure_code', 'observed_revision'])
    .where('id', '=', volumeId)
    .executeTakeFirstOrThrow();
}

describePg('volume reconcile store', () => {
  it('a success on one placement does not clear the failure another placement recorded', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = await seedUser(database);
      const backendId = await seedBackend(database);
      const serverA = await seedServer(database);
      const serverB = await seedServer(database);
      const poolA = await seedBackendPool(database, serverA, backendId);
      const poolB = await seedBackendPool(database, serverB, backendId);
      const volumeId = await seedVolume(database, { ownerId, poolId: null, serverId: null, sharedBackendId: backendId });
      // Resized to revision 2: B verified it, A failed and parked the volume.
      await database.updateTable('control.volumes')
        .set({ revision: 2, needs_attention: true, failure_code: 'VOLUME_RESIZE_FAILED' })
        .where('id', '=', volumeId)
        .execute();
      await database.insertInto('control.volume_placements').values([
        { volume_id: volumeId, server_id: serverA, pool_id: poolA, catalog_state: 'present', observed_revision: 1 },
        { volume_id: volumeId, server_id: serverB, pool_id: poolB, catalog_state: 'present', observed_revision: 2 },
      ]).execute();
      const store = new VolumeReconcileStore(database, new IntentRepository(database, noopWake()));

      await store.markSucceeded(volumeId, 2);
      expect(await volumeState(database, volumeId)).toEqual({
        needs_attention: true,
        failure_code: 'VOLUME_RESIZE_FAILED',
        observed_revision: 1,
      });

      // Once A caught up too, the volume is reconciled; a stale revision never clears it.
      await database.updateTable('control.volume_placements')
        .set({ observed_revision: 2 })
        .where('volume_id', '=', volumeId)
        .execute();
      await store.markSucceeded(volumeId, 1);
      expect(await volumeState(database, volumeId)).toMatchObject({ needs_attention: true });
      await store.markSucceeded(volumeId, 2);
      expect(await volumeState(database, volumeId)).toEqual({
        needs_attention: false,
        failure_code: null,
        observed_revision: 2,
      });
    });
  });
});
