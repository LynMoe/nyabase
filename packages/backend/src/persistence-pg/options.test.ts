import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadPgPersistenceOptions,
  pgPersistenceOptionsFromConfig,
  redactDatabaseUrl,
} from './options.js';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';

describe('PostgreSQL persistence options', () => {
  it('requires an explicit PostgreSQL URL and never accepts a SQLite path', () => {
    expect(() => loadPgPersistenceOptions({})).toThrow('is required');
    expect(() => loadPgPersistenceOptions({
      DATABASE_URL: 'file:./nyabase.db',
    })).toThrow('postgresql://');
  });

  it.each([
    ['postgresql:///nyabase', 'hostname'],
    ['postgresql://db.internal/', 'database name'],
    ['postgresql://db.internal/one/two', 'database name'],
    ['postgresql://db.internal/nyabase#other', 'fragment'],
    ['postgresql://db.internal/nyabase\n', 'control characters'],
    [
      `postgresql://db.internal/${'a'.repeat(4_100)}`,
      'must not exceed 4096',
    ],
    [
      'postgresql://db.internal/nyabase?statement_timeout=0',
      'query parameter statement_timeout is not supported',
    ],
  ])('rejects non-canonical database URL %j', (url, message) => {
    expect(() => loadPgPersistenceOptions({ DATABASE_URL: url })).toThrow(message);
  });

  it('loads bounded pool and timeout settings', () => {
    const options = loadPgPersistenceOptions({
      DATABASE_URL: 'postgresql://nyabase:secret@db.internal/nyabase',
      DB_POOL_MAX: '12',
      PG_LOCK_TIMEOUT_MS: '2500',
      PG_READINESS_TIMEOUT_MS: '1750',
      PG_SSL_MODE: 'verify-full',
      DB_MIGRATIONS_RUN: '1',
    });

    expect(options).toMatchObject({
      poolMax: 12,
      lockTimeoutMs: 2500,
      readinessTimeoutMs: 1750,
      ssl: { rejectUnauthorized: true },
      runMigrationsOnStart: true,
    });
  });

  it('loads a private CA and explicit verification identity in verify-full mode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nyabase-pg-ca-'));
    const caFile = join(directory, 'root.pem');
    writeFileSync(caFile, 'test-private-ca\n');
    try {
      const options = loadPgPersistenceOptions({
        DATABASE_URL: 'postgresql://nyabase:secret@db.internal/nyabase',
        PG_SSL_MODE: 'verify-full',
        PG_SSL_CA_FILE: caFile,
        PG_SSL_SERVERNAME: 'postgres.service.internal',
      });
      expect(options.ssl).toMatchObject({
        rejectUnauthorized: true,
        ca: 'test-private-ca\n',
      });
      expect(options.ssl && options.ssl.checkServerIdentity).toBeTypeOf('function');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for unreadable CA files, ignored TLS settings, and URL overrides', () => {
    expect(() => loadPgPersistenceOptions({
      DATABASE_URL: 'postgresql://nyabase:secret@db.internal/nyabase',
      PG_SSL_MODE: 'verify-full',
      PG_SSL_CA_FILE: '/definitely/missing/nyabase-ca.pem',
    })).toThrow('PG_SSL_CA_FILE could not be read');

    expect(() => loadPgPersistenceOptions({
      DATABASE_URL: 'postgresql://nyabase:secret@db.internal/nyabase',
      PG_SSL_MODE: 'require',
      PG_SSL_SERVERNAME: 'postgres.service.internal',
    })).toThrow('require PG_SSL_MODE=verify-full');

    expect(() => loadPgPersistenceOptions({
      DATABASE_URL:
        'postgresql://nyabase:secret@db.internal/nyabase?sslmode=disable',
      PG_SSL_MODE: 'verify-full',
    })).toThrow('DATABASE_URL must not contain sslmode');
  });

  it('maps the authoritative config service fields into pool options', () => {
    const values = new Map<string, unknown>([
      ['database.url', 'postgresql://nyabase:secret@postgres/nyabase'],
      ['database.poolMax', 24],
      ['database.idleTimeoutMs', 45_000],
      ['database.statementTimeoutMs', 15_000],
      ['database.migrationsRun', true],
    ]);
    const config = {
      get: (key: string) => values.get(key),
    } as unknown as NyabaseConfigService;

    expect(pgPersistenceOptionsFromConfig(config, {})).toMatchObject({
      connectionString: 'postgresql://nyabase:secret@postgres/nyabase',
      poolMax: 24,
      idleTimeoutMs: 45_000,
      statementTimeoutMs: 15_000,
      runMigrationsOnStart: true,
    });
  });

  it('rejects URL-level TLS overrides through the production config path', () => {
    const values = new Map<string, unknown>([
      [
        'database.url',
        'postgresql://nyabase:secret@postgres/nyabase?sslrootcert=/tmp/other.pem',
      ],
      ['database.poolMax', 24],
      ['database.idleTimeoutMs', 45_000],
      ['database.statementTimeoutMs', 15_000],
      ['database.migrationsRun', true],
    ]);
    const config = {
      get: (key: string) => values.get(key),
    } as unknown as NyabaseConfigService;

    expect(() => pgPersistenceOptionsFromConfig(config, {
      PG_SSL_MODE: 'verify-full',
    })).toThrow('DATABASE_URL must not contain sslrootcert');
  });

  it('redacts credentials in diagnostics', () => {
    const value = redactDatabaseUrl(
      'postgresql://nyabase:secret@db.internal:5432/nyabase',
    );
    expect(value).not.toContain('secret');
    expect(value).toContain('***');
  });
});
