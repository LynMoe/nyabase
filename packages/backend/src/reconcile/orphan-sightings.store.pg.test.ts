import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { seedServer } from '../iam/access.pg-test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { OrphanSightingsStore } from './orphan-sightings.store.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('OrphanSightingsStore', () => {
  it('keeps the first sighting, forgets what is no longer seen and names only overdue orphans', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      const store = new OrphanSightingsStore(database);
      const a = { poolName: '', name: 'nyc-a' };
      const b = { poolName: '', name: 'nyc-b' };

      const first = await store.sight(serverId, 'instance', [a, b]);
      expect(first.fresh).toEqual(expect.arrayContaining([a, b]));
      expect(first.due).toEqual([]);

      // a was first seen long ago; b is still within the quarantine.
      await database.updateTable('control.orphan_sightings')
        .set({ first_seen_at: sql<Date>`clock_timestamp() - interval '8 days'` })
        .where('name', '=', 'nyc-a')
        .execute();
      const second = await store.sight(serverId, 'instance', [a, b]);
      expect(second.fresh).toEqual([]);
      expect(second.due).toEqual([a]);

      // b vanished (or got a row): its sighting is dropped, so a reappearance starts over.
      const third = await store.sight(serverId, 'instance', [a]);
      expect(third.due).toEqual([a]);
      expect(await database.selectFrom('control.orphan_sightings').select('name').orderBy('name').execute())
        .toEqual([{ name: 'nyc-a' }]);

      await store.forget(serverId, 'instance', a);
      expect(await store.sight(serverId, 'volume', [])).toEqual({ fresh: [], due: [] });
      expect(await database.selectFrom('control.orphan_sightings').select('name').execute()).toEqual([]);
    });
  });
});
