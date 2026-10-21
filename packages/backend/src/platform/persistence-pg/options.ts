import { readFileSync } from 'node:fs';
import {
  checkServerIdentity as verifyTlsServerIdentity,
  type ConnectionOptions,
} from 'node:tls';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';

export interface PgPersistenceOptions {
  connectionString: string;
  applicationName: string;
  poolMax: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
  readinessTimeoutMs: number;
  ssl: false | ConnectionOptions;
  runMigrationsOnStart: boolean;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function booleanValue(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${key} must be true, false, 1, or 0`);
}

function validatedConnectionString(rawValue: string | undefined): string {
  if (rawValue && /[\u0000-\u001f\u007f]/.test(rawValue)) {
    throw new Error('DATABASE_URL must not contain control characters');
  }
  const value = rawValue?.trim();
  if (!value) {
    throw new Error(
      'DATABASE_URL is required; SQLite paths are not supported',
    );
  }
  if (value.length > 4_096) {
    throw new Error('DATABASE_URL must not exceed 4096 characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Database URL must be a valid postgresql:// connection string');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('Database URL must use the postgresql:// or postgres:// protocol');
  }
  if (!parsed.hostname) {
    throw new Error('DATABASE_URL must include a PostgreSQL hostname');
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('DATABASE_URL database name must be valid percent-encoding');
  }
  if (
    !databaseName
    || databaseName.includes('/')
    || /[\u0000-\u001f\u007f]/.test(databaseName)
  ) {
    throw new Error('DATABASE_URL must include exactly one database name');
  }
  if (parsed.hash) {
    throw new Error('DATABASE_URL must not contain a fragment');
  }
  const forbiddenSslParameter = [...parsed.searchParams.keys()].find((key) => [
    'ssl',
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'uselibpqcompat',
  ].includes(key.toLowerCase()));
  if (forbiddenSslParameter) {
    throw new Error(
      `DATABASE_URL must not contain ${forbiddenSslParameter}; `
      + 'configure PostgreSQL TLS only with PG_SSL_* settings',
    );
  }
  const unsupportedParameter = parsed.searchParams.keys().next().value;
  if (unsupportedParameter) {
    throw new Error(
      `DATABASE_URL query parameter ${unsupportedParameter} is not supported; `
      + 'use the dedicated PostgreSQL settings',
    );
  }
  return value;
}

function connectionString(env: NodeJS.ProcessEnv): string {
  return validatedConnectionString(env.DATABASE_URL);
}

function optionalTlsCa(env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PG_SSL_CA_FILE?.trim();
  if (!path) return undefined;
  let ca: string;
  try {
    ca = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`PG_SSL_CA_FILE could not be read: ${path}`, { cause: error });
  }
  if (!ca.trim()) throw new Error('PG_SSL_CA_FILE must not be empty');
  return ca;
}

function sslOptions(env: NodeJS.ProcessEnv): PgPersistenceOptions['ssl'] {
  const mode = env.PG_SSL_MODE?.trim().toLowerCase() || 'disable';
  const ca = optionalTlsCa(env);
  const verificationName = env.PG_SSL_SERVERNAME?.trim();
  if (mode !== 'verify-full' && (ca || verificationName)) {
    throw new Error(
      'PG_SSL_CA_FILE and PG_SSL_SERVERNAME require PG_SSL_MODE=verify-full',
    );
  }
  switch (mode) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-full': {
      const ssl: ConnectionOptions = { rejectUnauthorized: true };
      if (ca) ssl.ca = ca;
      if (verificationName) {
        // node-postgres derives SNI from DATABASE_URL and overwrites the
        // `servername` TLS option. Override identity verification explicitly
        // so private-CA deployments can use a stable certificate name.
        ssl.checkServerIdentity = (_host, certificate) =>
          verifyTlsServerIdentity(verificationName, certificate);
      }
      return ssl;
    }
    default:
      throw new Error('PG_SSL_MODE must be disable, require, or verify-full');
  }
}

export function loadPgPersistenceOptions(
  env: NodeJS.ProcessEnv = process.env,
): PgPersistenceOptions {
  return {
    connectionString: connectionString(env),
    applicationName: env.PG_APPLICATION_NAME?.trim() || 'nyabase-backend',
    poolMax: positiveInteger(env, 'DB_POOL_MAX', 20),
    connectionTimeoutMs: positiveInteger(env, 'PG_CONNECTION_TIMEOUT_MS', 5_000),
    idleTimeoutMs: positiveInteger(env, 'DB_IDLE_TIMEOUT_MS', 30_000),
    statementTimeoutMs: positiveInteger(env, 'DB_STATEMENT_TIMEOUT_MS', 30_000),
    lockTimeoutMs: positiveInteger(env, 'PG_LOCK_TIMEOUT_MS', 5_000),
    idleInTransactionTimeoutMs: positiveInteger(
      env,
      'PG_IDLE_IN_TRANSACTION_TIMEOUT_MS',
      30_000,
    ),
    readinessTimeoutMs: positiveInteger(
      env,
      'PG_READINESS_TIMEOUT_MS',
      5_000,
    ),
    ssl: sslOptions(env),
    runMigrationsOnStart: booleanValue(env, 'DB_MIGRATIONS_RUN', false),
  };
}

export function pgPersistenceOptionsFromConfig(
  config: NyabaseConfigService,
  env: NodeJS.ProcessEnv = process.env,
): PgPersistenceOptions {
  return {
    connectionString: validatedConnectionString(
      config.get<string>('database.url'),
    ),
    applicationName: env.PG_APPLICATION_NAME?.trim() || 'nyabase-backend',
    poolMax: config.get<number>('database.poolMax'),
    connectionTimeoutMs: positiveInteger(env, 'PG_CONNECTION_TIMEOUT_MS', 5_000),
    idleTimeoutMs: config.get<number>('database.idleTimeoutMs'),
    statementTimeoutMs: config.get<number>('database.statementTimeoutMs'),
    lockTimeoutMs: positiveInteger(env, 'PG_LOCK_TIMEOUT_MS', 5_000),
    idleInTransactionTimeoutMs: positiveInteger(
      env,
      'PG_IDLE_IN_TRANSACTION_TIMEOUT_MS',
      30_000,
    ),
    readinessTimeoutMs: positiveInteger(
      env,
      'PG_READINESS_TIMEOUT_MS',
      5_000,
    ),
    ssl: sslOptions(env),
    runMigrationsOnStart: config.get<boolean>('database.migrationsRun'),
  };
}

export function redactDatabaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username) url.username = '***';
  if (url.password) url.password = '***';
  return url.toString();
}
