import { describe, expect, it } from 'vitest';
import {
  grantServer,
  seedContainer,
  seedImage,
  seedPool,
  seedServer,
  seedUser,
} from '../iam/access.pg-test-helper.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import type { Kysely } from 'kysely';
import { CpuSetService } from './cpu-sets.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

/** One socket, four cores, two threads each: siblings are id and id + 4. */
const TOPOLOGY = Array.from({ length: 8 }, (_, id) => ({ id, core: id % 4, socket: 0, numa: 0 }));

async function seed(database: Kysely<NyabaseDatabase>, reserved: number[] = []) {
  const serverId = await seedServer(database);
  await database
    .updateTable('infra.servers')
    .set({ cpu_topology: JSON.stringify(TOPOLOGY), reserved_cpus: reserved })
    .where('id', '=', serverId)
    .execute();
  const poolId = await seedPool(database, serverId);
  const imageId = await seedImage(database);
  return { serverId, poolId, imageId };
}

async function storedSets(database: Kysely<NyabaseDatabase>, serverId: string) {
  return database
    .selectFrom('control.user_cpu_sets')
    .select(['user_id', 'cpus'])
    .where('server_id', '=', serverId)
    .execute();
}

describePg('CpuSetService', () => {
  it('pins each limited user to an own set, keeps it, and previews without writing', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, poolId, imageId } = await seed(database, [0]);
      const service = new CpuSetService(database, new PgTransactionManager(database));
      const alice = await seedUser(database);
      const bob = await seedUser(database);
      await grantServer(database, { user: alice }, serverId, { cpuCores: 2 });
      await grantServer(database, { user: bob }, serverId, { cpuCores: 2 });
      await seedContainer(database, { ownerId: alice, serverId, poolId, imageId });
      await seedContainer(database, { ownerId: bob, serverId, poolId, imageId });

      const preview = await service.preview(serverId, alice);
      expect(preview).toHaveLength(2);
      expect(await storedSets(database, serverId)).toEqual([]);

      const aliceSet = await service.resolve(serverId, alice);
      expect(aliceSet).toEqual(preview);
      expect(aliceSet).not.toContain(0);
      const bobSet = await service.resolve(serverId, bob);
      expect(bobSet.filter((cpu) => aliceSet.includes(cpu))).toEqual([]);
      expect(await service.resolve(serverId, alice)).toEqual(aliceSet);
      expect(await storedSets(database, serverId)).toHaveLength(2);
    });
  });

  it('gives unlimited users every unreserved CPU and keeps a revoked user pinned', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, poolId, imageId } = await seed(database, [0, 4]);
      const service = new CpuSetService(database, new PgTransactionManager(database));
      const free = await seedUser(database);
      await grantServer(database, { user: free }, serverId, { cpuCores: null });
      expect(await service.resolve(serverId, free)).toEqual([1, 2, 3, 5, 6, 7]);

      const revoked = await seedUser(database);
      await grantServer(database, { user: revoked }, serverId, { cpuCores: 2 });
      await seedContainer(database, { ownerId: revoked, serverId, poolId, imageId });
      const pinned = await service.resolve(serverId, revoked);
      await database.deleteFrom('iam.server_grants').where('user_id', '=', revoked).execute();
      expect(await service.resolve(serverId, revoked)).toEqual(pinned);
    });
  });

  it('releases the sets of users who no longer run anything there', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, poolId, imageId } = await seed(database);
      const service = new CpuSetService(database, new PgTransactionManager(database));
      const busy = await seedUser(database);
      const gone = await seedUser(database);
      await grantServer(database, { user: busy }, serverId, { cpuCores: 1 });
      await grantServer(database, { user: gone }, serverId, { cpuCores: 1 });
      await seedContainer(database, { ownerId: busy, serverId, poolId, imageId });
      await service.resolve(serverId, busy);
      await service.resolve(serverId, gone);
      expect(await storedSets(database, serverId)).toHaveLength(2);

      await service.releaseIdle(serverId);
      expect((await storedSets(database, serverId)).map((row) => row.user_id)).toEqual([busy]);
    });
  });
});
