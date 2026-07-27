import { describe, expect, it } from 'vitest';
import { pgMigrationsDirectory } from './persistence-pg.module.js';
import { runSqlMigrations } from './migrator.js';
import { withPostgresTestDatabase } from './postgres-test-harness.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('PostgreSQL migration lock boundary', () => {
  it('times out lock contention and releases the waiting pool client', async () => {
    await withPostgresTestDatabase(async ({ pool }) => {
      const blocker = await pool.connect();
      try {
        await blocker.query('SELECT pg_advisory_lock($1, $2)', [1_856_214_885, 1]);
        const startedAt = performance.now();
        await expect(runSqlMigrations(
          pool,
          pgMigrationsDirectory(),
          { lockTimeoutMs: 120, retryIntervalMs: 10 },
        )).rejects.toThrow('waiting for PostgreSQL migration lock');
        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(pool.waitingCount).toBe(0);
        expect(pool.idleCount).toBeGreaterThanOrEqual(1);
      } finally {
        await blocker.query('SELECT pg_advisory_unlock($1, $2)', [1_856_214_885, 1]);
        blocker.release();
      }

      await expect(runSqlMigrations(
        pool,
        pgMigrationsDirectory(),
        { lockTimeoutMs: 500, retryIntervalMs: 10 },
      )).resolves.toEqual([]);
    });
  });

  it('keeps tight repeated deadlines on the migration timeout semantic', async () => {
    await withPostgresTestDatabase(async ({ pool }) => {
      const blocker = await pool.connect();
      try {
        await blocker.query('SELECT pg_advisory_lock($1, $2)', [1_856_214_885, 1]);
        const startedAt = performance.now();
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await expect(runSqlMigrations(
            pool,
            pgMigrationsDirectory(),
            { lockTimeoutMs: 15, retryIntervalMs: 10 },
          )).rejects.toThrow(
            'Timed out after 15ms waiting for PostgreSQL migration lock',
          );
          expect(pool.waitingCount).toBe(0);
        }
        expect(performance.now() - startedAt).toBeLessThan(2_000);
        expect(pool.idleCount).toBeGreaterThanOrEqual(1);
      } finally {
        await blocker.query('SELECT pg_advisory_unlock($1, $2)', [1_856_214_885, 1]);
        blocker.release();
      }

      await expect(runSqlMigrations(
        pool,
        pgMigrationsDirectory(),
        { lockTimeoutMs: 500, retryIntervalMs: 10 },
      )).resolves.toEqual([]);
    });
  });
});
