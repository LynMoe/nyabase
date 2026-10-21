import { describe, expect, it } from 'vitest';
import type { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { HttpProxySnapshotService } from './http-proxy-snapshot.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('HttpProxySnapshotService (PostgreSQL)', () => {
  it('builds snapshots on a freshly migrated database and advances the generation', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const config = { keyEncryptionSecret: () => 'k'.repeat(32) } as unknown as NyabaseConfigService;
      const service = new HttpProxySnapshotService(new PgTransactionManager(database), config);

      const first = await service.buildSnapshot();
      const second = await service.buildSnapshot();

      expect(first.generation).toBe(1);
      expect(first.routes).toEqual([]);
      expect(second.generation).toBe(2);
      const state = await database
        .selectFrom('interaction.http_proxy_snapshot_state')
        .select('generation')
        .executeTakeFirstOrThrow();
      expect(Number(state.generation)).toBe(2);
    });
  });
});
