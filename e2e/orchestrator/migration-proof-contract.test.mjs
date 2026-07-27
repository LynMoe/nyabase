import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildMigrationManifest,
  validateMigrationDatabaseEvidence,
  validateMigrationManifest,
} from './migration-proof-contract.mjs';

const orchestratorDir = dirname(fileURLToPath(import.meta.url));
const migrationDir = resolve(
  orchestratorDir,
  '..',
  '..',
  'packages',
  'backend',
  'src',
  'persistence-pg',
  'migrations',
);

function checkedInManifest() {
  const entries = readdirSync(migrationDir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      filename,
      sql: readFileSync(join(migrationDir, filename)),
    }));
  return buildMigrationManifest(entries);
}

function exactDatabase(manifest) {
  return {
    migrations: manifest.migrations.map(({ version, name, checksum }, index) => ({
      version,
      name,
      checksum,
      executionMs: index,
    })),
    schemas: [...manifest.requiredSchemas],
    tables: [...manifest.requiredTables],
    constraints: [...manifest.requiredConstraints],
    indexes: [...manifest.requiredIndexes],
  };
}

test('checked-in initial manifest inventories every current domain object', () => {
  const manifest = checkedInManifest();
  assert.deepEqual(manifest.migrations.map(({ filename }) => filename), [
    '000001_initial.sql',
  ]);
  for (const table of [
    'system.schema_migrations',
    'iam.users',
    'iam.refresh_tokens',
    'iam.server_grants',
    'control.authorization_dependencies',
    'audit.events',
  ]) {
    assert.ok(manifest.requiredTables.includes(table), `missing ${table}`);
  }
  for (const constraint of [
    'system.schema_migrations_pkey',
    'iam.refresh_tokens_predecessor_shape_check',
    'iam.server_grants_scope_check',
    'audit.audit_actor_snapshot_object',
    'infra.remote_fs_mounts_last_task_fk',
    'control.containers_active_task_fk',
  ]) {
    assert.ok(manifest.requiredConstraints.includes(constraint), `missing ${constraint}`);
  }
  assert.match(manifest.digest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() =>
    validateMigrationDatabaseEvidence(manifest, exactDatabase(manifest)));
});

test('exact ledger validation rejects missing, extra, duplicate and checksum-drifted migrations', () => {
  const manifest = checkedInManifest();
  const database = exactDatabase(manifest);

  assert.throws(
    () => validateMigrationDatabaseEvidence(manifest, {
      ...database,
      migrations: database.migrations.slice(0, -1),
    }),
    /does not exactly match/,
  );
  assert.throws(
    () => validateMigrationDatabaseEvidence(manifest, {
      ...database,
      migrations: [
        ...database.migrations,
        { version: '999999', name: 'foreign', checksum: 'f'.repeat(64) },
      ],
    }),
    /does not exactly match/,
  );
  assert.throws(
    () => validateMigrationDatabaseEvidence(manifest, {
      ...database,
      migrations: [...database.migrations, database.migrations[0]],
    }),
    /duplicate versions/,
  );
  assert.throws(
    () => validateMigrationDatabaseEvidence(manifest, {
      ...database,
      migrations: database.migrations.map((entry) =>
        ({ ...entry, checksum: '0'.repeat(64) })),
    }),
    /does not exactly match/,
  );
});

test('domain object validation rejects missing schemas, tables, constraints and indexes', () => {
  const manifest = checkedInManifest();
  const database = exactDatabase(manifest);
  for (const [key, missing, pattern] of [
    ['schemas', 'iam', /database schemas/],
    ['tables', 'iam.users', /database tables/],
    ['constraints', 'iam.server_grants_scope_check', /missing required constraint/],
    ['indexes', 'audit.audit_events_actor_idx', /missing required index/],
  ]) {
    assert.throws(
      () => validateMigrationDatabaseEvidence(manifest, {
        ...database,
        [key]: database[key].filter((identity) => identity !== missing),
      }),
      pattern,
    );
  }
});

test('manifest discovery grows with a new migration and fails closed on unsupported DDL', () => {
  const base = [
    {
      filename: '000001_initial.sql',
      sql: 'CREATE SCHEMA IF NOT EXISTS system;\n',
    },
  ];
  const expanded = buildMigrationManifest([
    ...base,
    {
      filename: '000002_feature.sql',
      sql: [
        'CREATE SCHEMA IF NOT EXISTS feature;',
        'CREATE TABLE feature.items (',
        '  id uuid PRIMARY KEY,',
        '  CONSTRAINT items_shape CHECK (id IS NOT NULL)',
        ');',
        'CREATE INDEX items_id_idx ON feature.items (id);',
        '',
      ].join('\n'),
    },
  ]);
  assert.equal(expanded.migrations.length, 2);
  assert.ok(expanded.requiredTables.includes('feature.items'));
  assert.ok(expanded.requiredConstraints.includes('feature.items_shape'));
  assert.ok(expanded.requiredIndexes.includes('feature.items_id_idx'));
  assert.notEqual(expanded.digest, buildMigrationManifest(base).digest);

  assert.throws(
    () => buildMigrationManifest([{
      filename: '000003_unsupported.sql',
      sql: 'CREATE TABLE "quoted"."items" (id uuid PRIMARY KEY);\n',
    }]),
    /cannot inventory/,
  );
  const tampered = structuredClone(expanded);
  tampered.requiredTables = tampered.requiredTables.slice(1);
  assert.throws(() => validateMigrationManifest(tampered), /digest mismatch|ledger/);
});
