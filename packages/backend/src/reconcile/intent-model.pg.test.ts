import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { runsDespiteAttention, runsDespiteAttentionSql } from './intent-model.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('runsDespiteAttentionSql', () => {
  it('agrees with the worker\'s runsDespiteAttention on every request shape', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const requests: Array<Record<string, unknown> | null> = [
        null,
        {},
        { operation: 'sync_user_ssh_keys' },
        { retryOf: '7d0c4c9e-8c1e-4d3a-9e0f-1c2b3a4d5e6f' },
        { retryOf: '' },
        { retryOf: 42 },
        { retryOf: null },
        { despiteAttention: true },
        { despiteAttention: 'true' },
        { despiteAttention: false },
        { despiteAttention: 1 },
        { operation: 'detach_volume', attachmentId: 'a', despiteAttention: true },
        { retryOf: '', despiteAttention: true },
      ];
      for (const request of requests) {
        const json = request === null ? null : JSON.stringify(request);
        const { rows } = await sql<{ runs: boolean }>`
          SELECT ${runsDespiteAttentionSql(sql`${json}::jsonb`)} AS runs
        `.execute(database);
        expect({ request, runs: rows[0]?.runs }).toEqual({ request, runs: runsDespiteAttention(request) });
      }
    });
  });
});
