import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

const MIGRATION_NAME = /^(\d{6})_([a-z0-9][a-z0-9-]*)\.sql$/;
const ADVISORY_LOCK_NAMESPACE = 1_856_214_885;
const ADVISORY_LOCK_KEY = 1;
const LOCK_PROBE_QUERY_TIMEOUT_GRACE_MS = 250;

export interface SqlMigration {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
  executionMs: number;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: SqlMigration[];
}

export interface MigrationCompatibilityOptions {
  queryTimeoutMs?: number;
}

export interface MigrationLockOptions {
  lockTimeoutMs?: number;
  retryIntervalMs?: number;
}

type TimedQueryConfig = {
  text: string;
  values?: unknown[];
  query_timeout?: number;
};

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function discoverSqlMigrations(
  directory: string,
): Promise<SqlMigration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: SqlMigration[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = MIGRATION_NAME.exec(entry.name);
    if (!match) {
      if (entry.name.endsWith('.sql')) {
        throw new Error(
          `Invalid SQL migration name "${entry.name}"; expected NNNNNN_name.sql`,
        );
      }
      continue;
    }
    const path = join(directory, entry.name);
    const sql = await readFile(path, 'utf8');
    if (!sql.trim()) throw new Error(`SQL migration ${entry.name} is empty`);
    migrations.push({
      version: match[1],
      name: match[2],
      path,
      sql,
      checksum: checksum(sql),
    });
  }
  migrations.sort((left, right) => left.version.localeCompare(right.version));
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version === migrations[index].version) {
      throw new Error(`Duplicate SQL migration version ${migrations[index].version}`);
    }
  }
  return migrations;
}

export function assertFreshInitialMigrationManifest(
  migrations: SqlMigration[],
): void {
  if (
    migrations.length < 1
    || migrations[0]?.version !== '000001'
    || migrations[0]?.name !== 'initial'
  ) {
    throw new Error(
      'Nyabase requires exactly one fresh migration: 000001_initial.sql',
    );
  }
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS system');
  await client.query(`
    CREATE TABLE IF NOT EXISTS system.schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      execution_ms integer NOT NULL CHECK (execution_ms >= 0)
    )
  `);
}

async function loadApplied(
  client: PoolClient,
  options: MigrationCompatibilityOptions = {},
): Promise<AppliedMigration[]> {
  const config: TimedQueryConfig = {
    text: `
      SELECT version, name, checksum, applied_at, execution_ms
      FROM system.schema_migrations
      ORDER BY version
    `,
  };
  if (options.queryTimeoutMs !== undefined) {
    config.query_timeout = options.queryTimeoutMs;
  }
  const result = await client.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
    execution_ms: number;
  }>(config as never);
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    executionMs: row.execution_ms,
  }));
}

function validateApplied(
  migrations: SqlMigration[],
  applied: AppliedMigration[],
): SqlMigration[] {
  const available = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedVersions = new Set<string>();
  for (const [index, record] of applied.entries()) {
    const migration = available.get(record.version);
    if (!migration) {
      throw new Error(
        `Applied migration ${record.version}_${record.name} is missing from the application`,
      );
    }
    if (migration.name !== record.name || migration.checksum !== record.checksum.trim()) {
      throw new Error(
        `Applied migration ${record.version}_${record.name} no longer matches its SQL file`,
      );
    }
    if (migrations[index]?.version !== record.version) {
      throw new Error(
        `Applied migrations are not a contiguous prefix of the application manifest at `
        + `${record.version}_${record.name}`,
      );
    }
    appliedVersions.add(record.version);
  }
  return migrations.filter((migration) => !appliedVersions.has(migration.version));
}

async function loadAppliedReadOnly(
  client: PoolClient,
  options: MigrationCompatibilityOptions,
): Promise<AppliedMigration[]> {
  const tableConfig: TimedQueryConfig = {
    text: `SELECT to_regclass('system.schema_migrations')::text AS migration_table`,
  };
  if (options.queryTimeoutMs !== undefined) {
    tableConfig.query_timeout = options.queryTimeoutMs;
  }
  const table = await client.query<{ migration_table: string | null }>(
    tableConfig as never,
  );
  if (table.rows[0]?.migration_table !== 'system.schema_migrations') {
    throw new Error('PostgreSQL schema is not current: system.schema_migrations is missing');
  }
  return loadApplied(client, options);
}

/**
 * Read-only, exact image/database compatibility check.
 *
 * Unlike migrationStatus(), this function never creates the migration ledger.
 * It is therefore safe for startup/readiness when migration mutation is
 * disabled.
 */
export async function assertSqlMigrationCompatibility(
  pool: Pool,
  directory: string,
  options: MigrationCompatibilityOptions = {},
): Promise<MigrationStatus> {
  const migrations = await discoverSqlMigrations(directory);
  return assertSqlMigrationManifestCompatibility(pool, migrations, options);
}

export async function assertSqlMigrationManifestCompatibility(
  pool: Pool,
  migrations: SqlMigration[],
  options: MigrationCompatibilityOptions = {},
): Promise<MigrationStatus> {
  const client = await pool.connect();
  try {
    const applied = await loadAppliedReadOnly(client, options);
    const pending = validateApplied(migrations, applied);
    if (pending.length > 0) {
      throw new Error(
        `PostgreSQL schema is not current: pending migration(s): `
        + pending.map(({ version, name }) => `${version}_${name}`).join(', '),
      );
    }
    return { applied, pending };
  } finally {
    client.release();
  }
}

async function withMigrationLock<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options: MigrationLockOptions = {},
): Promise<T> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  const retryIntervalMs = options.retryIntervalMs ?? 50;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new Error('Migration lock timeout must be a positive integer');
  }
  if (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs <= 0) {
    throw new Error('Migration lock retry interval must be a positive integer');
  }
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    const deadline = performance.now() + lockTimeoutMs;
    while (!lockAcquired) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw migrationLockTimeout(lockTimeoutMs);

      let probeAcquired = false;
      try {
        const result = await client.query<{ locked: boolean }>({
          text: 'SELECT pg_try_advisory_lock($1, $2) AS locked',
          values: [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_KEY],
          // Keep the driver's query timer outside the logical lock deadline.
          // A final probe with only 1ms remaining must not win the race with
          // our stable migration-lock timeout semantics. The grace still
          // bounds a genuinely unresponsive connection.
          query_timeout:
            Math.ceil(remainingMs) + LOCK_PROBE_QUERY_TIMEOUT_GRACE_MS,
        } as never);
        probeAcquired = result.rows[0]?.locked === true;
      } catch (error) {
        if (isQueryReadTimeout(error)) {
          throw migrationLockTimeout(lockTimeoutMs, { cause: error });
        }
        throw error;
      }
      lockAcquired = probeAcquired;
      if (lockAcquired) break;
      const delayMs = Math.min(
        retryIntervalMs,
        Math.max(0, deadline - performance.now()),
      );
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return await work(client);
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        ADVISORY_LOCK_NAMESPACE,
        ADVISORY_LOCK_KEY,
      ]).catch(() => undefined);
    }
    client.release();
  }
}

function migrationLockTimeout(
  lockTimeoutMs: number,
  options?: ErrorOptions,
): Error {
  return new Error(
    `Timed out after ${lockTimeoutMs}ms waiting for PostgreSQL migration lock`,
    options,
  );
}

function isQueryReadTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'Query read timeout';
}

export async function migrationStatus(
  pool: Pool,
  directory: string,
  options: MigrationLockOptions = {},
): Promise<MigrationStatus> {
  return withMigrationLock(pool, async (client) => {
    await ensureMigrationTable(client);
    const migrations = await discoverSqlMigrations(directory);
    const applied = await loadApplied(client);
    return { applied, pending: validateApplied(migrations, applied) };
  }, options);
}

export async function runSqlMigrations(
  pool: Pool,
  directory: string,
  options: MigrationLockOptions = {},
): Promise<SqlMigration[]> {
  return withMigrationLock(pool, async (client) => {
    await ensureMigrationTable(client);
    const migrations = await discoverSqlMigrations(directory);
    const applied = await loadApplied(client);
    const pending = validateApplied(migrations, applied);
    const completed: SqlMigration[] = [];

    for (const migration of pending) {
      const startedAt = performance.now();
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
        await client.query(
          `INSERT INTO system.schema_migrations
            (version, name, checksum, execution_ms)
           VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.name, migration.checksum, executionMs],
        );
        await client.query('COMMIT');
        completed.push(migration);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(
          `SQL migration ${migration.version}_${migration.name} failed`,
          { cause: error },
        );
      }
    }
    return completed;
  }, options);
}
