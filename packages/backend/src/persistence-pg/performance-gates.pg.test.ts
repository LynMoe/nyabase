import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withPostgresTestDatabase } from './postgres-test-harness.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('PostgreSQL automated performance gates', () => {
  it('has a valid non-partial leading index for every foreign key', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const missing = await sql<{
        table_name: string;
        constraint_name: string;
        definition: string;
      }>`
        SELECT
          constraint_table::text AS table_name,
          constraint_name,
          definition
        FROM (
          SELECT
            constraint_row.conrelid::regclass AS constraint_table,
            constraint_row.conname AS constraint_name,
            pg_get_constraintdef(constraint_row.oid) AS definition,
            constraint_row.conkey AS foreign_key_columns
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.contype = 'f'
            AND constraint_row.connamespace IN (
              SELECT oid
              FROM pg_namespace
              WHERE nspname NOT IN ('pg_catalog', 'information_schema')
                AND nspname NOT LIKE 'pg_toast%'
            )
        ) AS foreign_key
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_index AS index_row
          WHERE index_row.indrelid = foreign_key.constraint_table
            AND index_row.indisvalid
            AND index_row.indisready
            AND index_row.indpred IS NULL
            AND index_row.indnkeyatts >= cardinality(foreign_key.foreign_key_columns)
            AND NOT EXISTS (
              SELECT 1
              FROM unnest(foreign_key.foreign_key_columns)
                WITH ORDINALITY AS key_column(attnum, position)
              WHERE (index_row.indkey::smallint[])[key_column.position - 1]
                IS DISTINCT FROM key_column.attnum
            )
        )
        ORDER BY table_name, constraint_name
      `.execute(database);

      expect(missing.rows, JSON.stringify(missing.rows, null, 2)).toEqual([]);
    });
  });

  it('indexes both bounded refresh-session cleanup predicates', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const indexes = await sql<{
        index_name: string;
        predicate: string | null;
      }>`
        SELECT
          index_row.indexrelid::regclass::text AS index_name,
          pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
        FROM pg_index AS index_row
        WHERE index_row.indrelid = 'iam.refresh_tokens'::regclass
          AND index_row.indexrelid IN (
            'iam.refresh_tokens_expiry_idx'::regclass,
            'iam.refresh_tokens_revoked_idx'::regclass
          )
        ORDER BY index_name
      `.execute(database);

      expect(indexes.rows).toEqual([
        { index_name: 'iam.refresh_tokens_expiry_idx', predicate: null },
        { index_name: 'iam.refresh_tokens_revoked_idx', predicate: 'revoked' },
      ]);

      await sql`
        INSERT INTO iam.users (
          id, numeric_id, username, password_hash, display_name, status
        )
        VALUES (
          '00000000-0000-0000-0000-000000000001',
          4000,
          'refresh-plan-user',
          'unused',
          'Refresh plan user',
          'active'
        )
      `.execute(database);
      await sql`
        INSERT INTO iam.refresh_tokens (
          id, user_id, hash, expires_at, revoked, created_at
        )
        SELECT
          (
            '00000000-0000-0000-0001-'
            || lpad(series.value::text, 12, '0')
          )::uuid,
          '00000000-0000-0000-0000-000000000001'::uuid,
          lpad(to_hex(series.value), 64, '0'),
          CASE WHEN series.value <= 10
            THEN clock_timestamp() - interval '1 hour'
            ELSE clock_timestamp() + interval '1 day'
          END,
          series.value BETWEEN 11 AND 20,
          clock_timestamp()
        FROM generate_series(1, 10000) AS series(value)
      `.execute(database);
      await sql`ANALYZE iam.refresh_tokens`.execute(database);

      const expiryPlan = await sql<Record<string, unknown>>`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT id
        FROM iam.refresh_tokens
        WHERE expires_at <= clock_timestamp()
        ORDER BY expires_at, id
        LIMIT 128
      `.execute(database);
      const revokedPlan = await sql<Record<string, unknown>>`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT id
        FROM iam.refresh_tokens
        WHERE revoked
        ORDER BY id
        LIMIT 128
      `.execute(database);
      expect(JSON.stringify(expiryPlan.rows)).toContain('refresh_tokens_expiry_idx');
      expect(JSON.stringify(revokedPlan.rows)).toContain('refresh_tokens_revoked_idx');
    });
  });

  it('uses an ordered index for target-id-only audit filtering', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      await sql`
        INSERT INTO audit.events (
          id, action, target_id, target_type, related, occurred_at
        )
        SELECT
          (
            '00000000-0000-0000-0002-'
            || lpad(series.value::text, 12, '0')
          )::uuid,
          'group.create',
          CASE WHEN series.value <= 10
            THEN 'rare-target'
            ELSE 'common-target-' || series.value::text
          END,
          'group',
          '[]'::jsonb,
          clock_timestamp() - series.value * interval '1 second'
        FROM generate_series(1, 10000) AS series(value)
      `.execute(database);
      await sql`ANALYZE audit.events`.execute(database);

      const plan = await sql<Record<string, unknown>>`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT *
        FROM audit.events
        WHERE target_id = 'rare-target'
        ORDER BY occurred_at DESC, id DESC
        LIMIT 100
      `.execute(database);
      expect(JSON.stringify(plan.rows)).toContain('audit_events_target_id_idx');
    });
  });
});
