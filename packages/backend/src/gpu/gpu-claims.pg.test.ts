import { describe, expect, it } from 'vitest';
import { seedContainer, seedImage, seedPool, seedServer, seedUser } from '../iam/access.pg-test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('GPU claims of a deleting container', () => {
  it('keep the card claimed until the container row is gone', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const imageId = await seedImage(database);
      const containerId = await seedContainer(database, { ownerId, serverId, poolId, imageId });
      await database.insertInto('control.container_gpu_claims')
        .values({ container_id: containerId, server_id: serverId, pci_address: '00000000:01:00.0' })
        .execute();
      const claims = () => database.selectFrom('control.container_gpu_claims')
        .select('container_id').execute();

      await database.updateTable('control.containers').set({ lifecycle_phase: 'deleting' })
        .where('id', '=', containerId).execute();
      expect(await claims()).toEqual([{ container_id: containerId }]);

      // The reconciler drops the row once the instance is deleted.
      await database.deleteFrom('control.containers').where('id', '=', containerId).execute();
      expect(await claims()).toEqual([]);
    });
  });
});
