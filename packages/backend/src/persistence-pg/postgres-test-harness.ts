import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { NyabaseDatabase } from './database.types.js';
import { runSqlMigrations } from './migrator.js';
import { pgMigrationsDirectory } from './persistence-pg.module.js';

export interface PostgresTestDatabase {
  connectionString: string;
  pool: Pool;
  database: Kysely<NyabaseDatabase>;
}

function testDatabaseName(): string {
  return `nyabase_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
}

function identifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe PostgreSQL test database name');
  return `"${value}"`;
}

/**
 * Creates a disposable PostgreSQL database, applies the real checked-in SQL
 * migrations, and always drops it. The configured role must have CREATEDB.
 *
 * Tests opt in with NYABASE_TEST_DATABASE_URL so ordinary unit runs do not
 * silently depend on Docker. The same helper is reusable by every domain lane.
 */
export async function withPostgresTestDatabase<T>(
  work: (fixture: PostgresTestDatabase) => Promise<T>,
  baseConnectionString = process.env.NYABASE_TEST_DATABASE_URL,
): Promise<T> {
  if (!baseConnectionString) {
    throw new Error('NYABASE_TEST_DATABASE_URL is required for PostgreSQL integration tests');
  }
  const name = testDatabaseName();
  const adminUrl = new URL(baseConnectionString);
  adminUrl.pathname = '/postgres';
  const databaseUrl = new URL(baseConnectionString);
  databaseUrl.pathname = `/${name}`;

  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  let pool: Pool | undefined;
  let database: Kysely<NyabaseDatabase> | undefined;
  try {
    await admin.query(`CREATE DATABASE ${identifier(name)}`);
    pool = new Pool({ connectionString: databaseUrl.toString(), max: 8 });
    pool.on('error', () => undefined);
    // The final safety cleanup may terminate a lagging test connection after
    // its pool has begun shutdown. Keep that expected 57P01 event handled;
    // active query failures still reject their query promises normally.
    pool.on('connect', (client) => {
      client.on('error', () => undefined);
    });
    await runSqlMigrations(pool, pgMigrationsDirectory());
    database = new Kysely<NyabaseDatabase>({
      dialect: new PostgresDialect({ pool }),
    });
    return await work({
      connectionString: databaseUrl.toString(),
      pool,
      database,
    });
  } finally {
    if (database) await database.destroy().catch(() => undefined);
    else if (pool) await pool.end().catch(() => undefined);
    // pg Pool shutdown resolves as its clients begin closing. Give PostgreSQL
    // a short bounded window to observe those graceful disconnects before the
    // disposable-database fallback terminates anything still attached; racing
    // the two paths surfaces expected 57P01 socket errors as unhandled events.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const remaining = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      ).catch(() => ({ rows: [{ count: '0' }] }));
      if (remaining.rows[0]?.count === '0') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)}`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
