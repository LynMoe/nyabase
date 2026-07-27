import { createHash } from 'node:crypto';

const migrationFilenamePattern = /^(\d{6})_([a-z0-9][a-z0-9-]*)\.sql$/;
const shaPattern = /^[0-9a-f]{64}$/;
const sqlIdentifier = '[a-z_][a-z0-9_]*';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function exactStrings(actual, expected, label) {
  invariant(Array.isArray(actual), `${label} must be an array`);
  const normalized = actual.map(String).sort();
  invariant(
    normalized.length === new Set(normalized).size,
    `${label} contains duplicate identities`,
  );
  invariant(
    JSON.stringify(normalized) === JSON.stringify(expected),
    `${label} does not exactly match the image migration manifest`,
  );
}

function manifestPayload(manifest) {
  return {
    schemaVersion: 1,
    migrations: manifest.migrations,
    requiredSchemas: manifest.requiredSchemas,
    requiredTables: manifest.requiredTables,
    requiredConstraints: manifest.requiredConstraints,
    requiredIndexes: manifest.requiredIndexes,
  };
}

function manifestDigest(manifest) {
  return sha256(JSON.stringify(manifestPayload(manifest)));
}

function requiredObjectsFromSql(sql, filename) {
  const schemas = [];
  const tables = [];
  const constraints = [];
  const indexes = [];

  for (const match of sql.matchAll(
    new RegExp(`\\bCREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${sqlIdentifier})`, 'gi'),
  )) {
    schemas.push(match[1].toLowerCase());
  }

  const tablePattern = new RegExp(
    `\\bCREATE\\s+TABLE\\s+(${sqlIdentifier})\\.(${sqlIdentifier})\\s*\\(([\\s\\S]*?)\\n\\);`,
    'gi',
  );
  for (const match of sql.matchAll(tablePattern)) {
    const schema = match[1].toLowerCase();
    const table = match[2].toLowerCase();
    const body = match[3];
    schemas.push(schema);
    tables.push(`${schema}.${table}`);
    if (/\bPRIMARY\s+KEY\b/i.test(body)) {
      constraints.push(`${schema}.${table}_pkey`);
    }
    for (const constraint of body.matchAll(
      new RegExp(`\\bCONSTRAINT\\s+(${sqlIdentifier})\\b`, 'gi'),
    )) {
      constraints.push(`${schema}.${constraint[1].toLowerCase()}`);
    }
  }

  for (const match of sql.matchAll(
    new RegExp(
      `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(${sqlIdentifier})\\s+ON\\s+(${sqlIdentifier})\\.(${sqlIdentifier})`,
      'gi',
    ),
  )) {
    const index = match[1].toLowerCase();
    const schema = match[2].toLowerCase();
    schemas.push(schema);
    indexes.push(`${schema}.${index}`);
  }

  for (const statement of sql.split(';')) {
    const alteredTable = statement.match(new RegExp(
      `\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${sqlIdentifier})\\.(${sqlIdentifier})\\b`,
      'i',
    ));
    if (!alteredTable) continue;
    const schema = alteredTable[1].toLowerCase();
    schemas.push(schema);
    for (const constraint of statement.matchAll(
      new RegExp(`\\bADD\\s+CONSTRAINT\\s+(${sqlIdentifier})\\b`, 'gi'),
    )) {
      constraints.push(`${schema}.${constraint[1].toLowerCase()}`);
    }
  }

  invariant(
    !/\bCREATE\s+TABLE\b/i.test(sql) || tables.length > 0,
    `${filename} contains a CREATE TABLE shape the E2E proof cannot inventory`,
  );
  invariant(
    !/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(sql) || indexes.length > 0,
    `${filename} contains a CREATE INDEX shape the E2E proof cannot inventory`,
  );
  return { schemas, tables, constraints, indexes };
}

export function buildMigrationManifest(entries) {
  invariant(Array.isArray(entries) && entries.length > 0, 'migration inventory is empty');
  const migrations = [];
  const schemas = ['system'];
  const tables = ['system.schema_migrations'];
  const constraints = ['system.schema_migrations_pkey'];
  const indexes = ['system.schema_migrations_pkey'];

  for (const entry of entries) {
    invariant(
      entry && typeof entry.filename === 'string',
      'migration inventory entry has no filename',
    );
    const match = migrationFilenamePattern.exec(entry.filename);
    invariant(
      match,
      `invalid migration filename ${entry.filename}; expected NNNNNN_name.sql`,
    );
    const sql = Buffer.isBuffer(entry.sql)
      ? entry.sql.toString('utf8')
      : String(entry.sql ?? '');
    invariant(sql.trim().length > 0, `migration ${entry.filename} is empty`);
    const objects = requiredObjectsFromSql(sql, entry.filename);
    migrations.push({
      version: match[1],
      name: match[2],
      filename: entry.filename,
      checksum: sha256(sql),
    });
    schemas.push(...objects.schemas);
    tables.push(...objects.tables);
    constraints.push(...objects.constraints);
    indexes.push(...objects.indexes);
  }

  migrations.sort((left, right) => left.version.localeCompare(right.version));
  invariant(
    migrations.length === new Set(migrations.map((migration) => migration.version)).size,
    'migration inventory contains duplicate versions',
  );
  invariant(
    migrations.length === new Set(migrations.map((migration) => migration.filename)).size,
    'migration inventory contains duplicate filenames',
  );

  const manifest = {
    schemaVersion: 1,
    migrations,
    requiredSchemas: sortedUnique(schemas),
    requiredTables: sortedUnique(tables),
    requiredConstraints: sortedUnique(constraints),
    requiredIndexes: sortedUnique(indexes),
  };
  return { ...manifest, digest: manifestDigest(manifest) };
}

export function validateMigrationManifest(manifest) {
  invariant(manifest?.schemaVersion === 1, 'migration manifest schema mismatch');
  invariant(Array.isArray(manifest.migrations) && manifest.migrations.length > 0,
    'migration manifest is empty');
  const versions = [];
  const filenames = [];
  let previousVersion = null;
  for (const migration of manifest.migrations) {
    invariant(
      typeof migration?.version === 'string'
        && typeof migration.name === 'string'
        && typeof migration.filename === 'string'
        && shaPattern.test(migration.checksum ?? ''),
      'migration manifest entry is invalid',
    );
    invariant(
      migration.filename === `${migration.version}_${migration.name}.sql`
        && migrationFilenamePattern.test(migration.filename),
      'migration manifest filename identity mismatch',
    );
    invariant(
      previousVersion === null || previousVersion < migration.version,
      'migration manifest is not strictly version ordered',
    );
    previousVersion = migration.version;
    versions.push(migration.version);
    filenames.push(migration.filename);
  }
  invariant(versions.length === new Set(versions).size, 'migration manifest has duplicate versions');
  invariant(filenames.length === new Set(filenames).size, 'migration manifest has duplicate filenames');
  for (const key of [
    'requiredSchemas',
    'requiredTables',
    'requiredConstraints',
    'requiredIndexes',
  ]) {
    exactStrings(manifest[key], sortedUnique(manifest[key] ?? []), `migration manifest ${key}`);
  }
  invariant(
    manifest.requiredSchemas.includes('system')
      && manifest.requiredTables.includes('system.schema_migrations')
      && manifest.requiredConstraints.includes('system.schema_migrations_pkey')
      && manifest.requiredIndexes.includes('system.schema_migrations_pkey'),
    'migration manifest does not include the SQL migration ledger',
  );
  invariant(shaPattern.test(manifest.digest ?? ''), 'migration manifest digest is invalid');
  invariant(manifest.digest === manifestDigest(manifest), 'migration manifest digest mismatch');
  return manifest;
}

export function validateMigrationDatabaseEvidence(manifestValue, database) {
  const manifest = validateMigrationManifest(manifestValue);
  invariant(Array.isArray(database?.migrations), 'database migration ledger is missing');
  const actualMigrations = database.migrations.map((entry) => ({
    version: String(entry?.version ?? ''),
    name: String(entry?.name ?? ''),
    checksum: String(entry?.checksum ?? '').trim(),
  }));
  const expectedMigrations = manifest.migrations.map(({ version, name, checksum }) => ({
    version,
    name,
    checksum,
  }));
  invariant(
    actualMigrations.length === new Set(actualMigrations.map((entry) => entry.version)).size,
    'database migration ledger contains duplicate versions',
  );
  invariant(
    JSON.stringify(actualMigrations) === JSON.stringify(expectedMigrations),
    'database migration ledger does not exactly match the image migration manifest',
  );
  exactStrings(database.schemas, manifest.requiredSchemas, 'database schemas');
  exactStrings(database.tables, manifest.requiredTables, 'database tables');

  const actualConstraints = sortedUnique((database.constraints ?? []).map(String));
  const actualIndexes = sortedUnique((database.indexes ?? []).map(String));
  for (const constraint of manifest.requiredConstraints) {
    invariant(
      actualConstraints.includes(constraint),
      `database is missing required constraint ${constraint}`,
    );
  }
  for (const index of manifest.requiredIndexes) {
    invariant(actualIndexes.includes(index), `database is missing required index ${index}`);
  }
  return {
    digest: manifest.digest,
    migrationCount: manifest.migrations.length,
    tableCount: manifest.requiredTables.length,
  };
}
