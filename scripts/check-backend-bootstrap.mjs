#!/usr/bin/env node
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const backendRoot = join(repoRoot, 'packages', 'backend');
const requireFromBackend = createRequire(join(backendRoot, 'package.json'));
requireFromBackend('reflect-metadata');
const { Pool } = requireFromBackend('pg');

if (process.env.NYABASE_BACKEND_BOOTSTRAP_CHILD === '1') {
  await bootstrapCompiledBackend();
  process.exit(0);
}

const baseDatabaseUrl = process.env.NYABASE_TEST_DATABASE_URL;
if (!baseDatabaseUrl) {
  throw new Error(
    'NYABASE_TEST_DATABASE_URL is required for the PostgreSQL backend bootstrap gate',
  );
}
const databaseName = `nyabase_bootstrap_${process.pid}_${randomUUID().replaceAll('-', '')}`;
const safeDatabaseName = `"${databaseName}"`;
const adminUrl = new URL(baseDatabaseUrl);
if (adminUrl.protocol !== 'postgresql:' && adminUrl.protocol !== 'postgres:') {
  throw new Error('NYABASE_TEST_DATABASE_URL must use postgresql:// or postgres://');
}
adminUrl.pathname = '/postgres';
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const expectedMigrations = readdirSync(
  join(backendRoot, 'src', 'persistence-pg', 'migrations'),
)
  .filter((name) => /^\d{6}_[a-z0-9][a-z0-9-]*\.sql$/.test(name))
  .map((name) => name.slice(0, -4))
  .sort();
if (expectedMigrations.length === 0) {
  throw new Error('No PostgreSQL migrations found for the backend bootstrap gate');
}
const root = mkdtempSync(join(tmpdir(), 'nyabase-backend-bootstrap-'));
const configPath = join(root, 'config.yaml');
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });

let databaseCreated = false;
let verification;
let runError;
try {
  writeFileSync(configPath, [
    'runtime:',
    '  nodeEnv: test',
    '  role: all',
    'server:',
    '  port: 1',
    '  corsOrigin: ""',
    'auth:',
    '  jwtSecret: "bootstrap-jwt-secret-bootstrap-jwt-secret"',
    '  jwtExpiresIn: 15m',
    '  refreshTokenExpiresDays: 1',
    '  adminInitPassword: "bootstrap-password"',
    'database:',
    `  url: ${JSON.stringify(databaseUrl.toString())}`,
    '  poolMax: 4',
    '  idleTimeoutMs: 1000',
    '  statementTimeoutMs: 15000',
    '  migrationsRun: true',
    'redis:',
    '  url: "redis://127.0.0.1:1/0"',
    '  keyPrefix: "nyabase:bootstrap:"',
    '  tlsCaFile: ""',
    '  tlsServername: ""',
    'metrics:',
    '  victoriaMetricsUrl: http://127.0.0.1:1',
    '  vmagentUrl: http://127.0.0.1:1',
    'http:',
    '  proxyToken: "bootstrap-http-token-bootstrap-http-token"',
    'ssh:',
    '  keyEncryptionSecret: "bootstrap-key-secret-bootstrap-key-secret"',
    '  proxyToken: "bootstrap-ssh-token-bootstrap-ssh-token"',
    '  proxyPublicHost: ""',
    '  proxyPublicPort: 2222',
    '  proxySnapshotStaleMs: 300000',
    '',
  ].join('\n'), { mode: 0o600 });
  await admin.query(`CREATE DATABASE ${safeDatabaseName}`);
  databaseCreated = true;
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NYABASE_BACKEND_BOOTSTRAP_CHILD: '1',
      NYABASE_CONFIG_FILE: configPath,
    },
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `Compiled backend bootstrap child exited with `
      + (child.signal ? `signal ${child.signal}` : `status ${child.status}`),
    );
  }

  verification = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
  const migrationResult = await verification.query(`
    SELECT version, name
    FROM system.schema_migrations
    ORDER BY version
  `);
  const appliedMigrations = migrationResult.rows.map(
    ({ version, name }) => `${version}_${name}`,
  );
  if (
    appliedMigrations.length !== expectedMigrations.length
    || appliedMigrations.some((migration, index) => migration !== expectedMigrations[index])
  ) {
    throw new Error(
      `Backend bootstrap migration mismatch: expected ${expectedMigrations.join(', ')}, `
      + `applied ${appliedMigrations.join(', ')}`,
    );
  }
  console.log(
    `Backend PostgreSQL bootstrap PASS: ${appliedMigrations.length}/`
    + `${expectedMigrations.length} fresh migrations`,
  );
} catch (error) {
  runError = error;
} finally {
  const cleanupErrors = [];
  await verification?.end().catch((error) => cleanupErrors.push(error));
  if (databaseCreated) {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    ).catch((error) => cleanupErrors.push(error));
    await admin.query(`DROP DATABASE IF EXISTS ${safeDatabaseName}`)
      .catch((error) => cleanupErrors.push(error));
    const remaining = await admin.query(
      'SELECT count(*)::integer AS count FROM pg_database WHERE datname = $1',
      [databaseName],
    ).catch((error) => {
      cleanupErrors.push(error);
      return undefined;
    });
    if (remaining && remaining.rows[0]?.count !== 0) {
      cleanupErrors.push(new Error(`Temporary PostgreSQL database still exists: ${databaseName}`));
    }
  }
  await admin.end().catch((error) => cleanupErrors.push(error));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 0) {
    console.log('Backend bootstrap cleanup PASS: isolated PostgreSQL database removed');
  }
  if (runError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [runError, ...cleanupErrors].filter(Boolean),
      'Backend PostgreSQL bootstrap gate failed',
    );
  }
}

async function bootstrapCompiledBackend() {
  const { NestFactory } = requireFromBackend('@nestjs/core');
  const [{ AppModule }, { RuntimeRoleService }] = await Promise.all([
    import(pathToFileURL(join(backendRoot, 'dist', 'app.module.js'))),
    import(pathToFileURL(join(
      backendRoot,
      'dist',
      'runtime',
      'runtime-role.service.js',
    ))),
  ]);
  let app;
  try {
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    const runtimeRole = app.get(RuntimeRoleService);
    if (runtimeRole.role !== 'all') {
      throw new Error(
        `Backend bootstrap resolved unexpected runtime role: ${runtimeRole.role}`,
      );
    }
    console.log(
      'Backend compiled bootstrap PASS: role=all, module graph, providers, and lifecycle init',
    );
  } finally {
    await app?.close();
  }
}
