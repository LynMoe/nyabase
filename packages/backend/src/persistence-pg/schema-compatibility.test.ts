import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSqlMigrationCompatibility,
  discoverSqlMigrations,
} from './migrator.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function migrationDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nyabase-pg-compatibility-'));
  roots.push(root);
  await writeFile(join(root, '000001_initial.sql'), 'SELECT 1;\n');
  return root;
}

async function appliedRow(directory: string) {
  const [migration] = await discoverSqlMigrations(directory);
  return {
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
    applied_at: new Date('2026-01-01T00:00:00Z'),
    execution_ms: 1,
  };
}

function poolWithRows(
  migrationTable: string | null,
  rows: Array<Record<string, unknown>>,
) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ migration_table: migrationTable }] })
    .mockResolvedValueOnce({ rows });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  return {
    pool: { connect } as unknown as Pool,
    connect,
    query,
    release,
  };
}

describe('exact PostgreSQL schema compatibility', () => {
  it('accepts only an exact applied manifest and bounds readiness queries', async () => {
    const directory = await migrationDirectory();
    const fake = poolWithRows(
      'system.schema_migrations',
      [await appliedRow(directory)],
    );

    await expect(assertSqlMigrationCompatibility(
      fake.pool,
      directory,
      { queryTimeoutMs: 2_500 },
    )).resolves.toMatchObject({ pending: [] });
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(fake.query).toHaveBeenCalledTimes(2);
    expect(fake.query.mock.calls.every(
      ([config]) => config.query_timeout === 2_500,
    )).toBe(true);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('fails closed without mutating an empty database when migrations are disabled', async () => {
    const directory = await migrationDirectory();
    const fake = poolWithRows(null, []);

    await expect(assertSqlMigrationCompatibility(fake.pool, directory))
      .rejects.toThrow('system.schema_migrations is missing');
    expect(fake.query).toHaveBeenCalledOnce();
    expect(String(fake.query.mock.calls[0][0].text)).not.toMatch(/\bCREATE\b/i);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('rejects pending, unknown, and checksum-mismatched manifests', async () => {
    const directory = await migrationDirectory();
    const pending = poolWithRows('system.schema_migrations', []);
    await expect(assertSqlMigrationCompatibility(pending.pool, directory))
      .rejects.toThrow('pending migration(s): 000001_initial');

    const mismatch = poolWithRows(
      'system.schema_migrations',
      [{ ...await appliedRow(directory), checksum: '0'.repeat(64) }],
    );
    await expect(assertSqlMigrationCompatibility(mismatch.pool, directory))
      .rejects.toThrow('no longer matches its SQL file');

    const unknown = poolWithRows('system.schema_migrations', [{
      ...await appliedRow(directory),
      version: '999999',
      name: 'unknown',
    }]);
    await expect(assertSqlMigrationCompatibility(unknown.pool, directory))
      .rejects.toThrow('is missing from the application');
  });

  it('rejects an applied manifest that skips an earlier migration', async () => {
    const directory = await migrationDirectory();
    await writeFile(join(directory, '000002_second.sql'), 'SELECT 2;\n');
    const migrations = await discoverSqlMigrations(directory);
    const fake = poolWithRows('system.schema_migrations', [{
      version: migrations[1].version,
      name: migrations[1].name,
      checksum: migrations[1].checksum,
      applied_at: new Date('2026-01-01T00:00:00Z'),
      execution_ms: 1,
    }]);

    await expect(assertSqlMigrationCompatibility(fake.pool, directory))
      .rejects.toThrow('not a contiguous prefix');
  });
});
