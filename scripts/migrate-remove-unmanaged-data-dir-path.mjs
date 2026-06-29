#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const requireBackend = createRequire(path.join(root, 'packages/backend/package.json'));
const runId = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z');
const reportDir = path.join(root, 'test/runtime/migrations/remove-unmanaged-data-dir-path', runId);

const JSON_COLUMNS = [
  { table: 'container_desired_specs', column: 'mounts_json', idColumn: 'id' },
  { table: 'operations', column: 'request_json', idColumn: 'id' },
  { table: 'operations', column: 'payload_json', idColumn: 'id' },
  { table: 'operations', column: 'result_json', idColumn: 'id' },
  { table: 'operations', column: 'hook_plan_json', idColumn: 'id' },
  { table: 'operations', column: 'hook_results_json', idColumn: 'id' },
  { table: 'audit_logs', column: 'payload', idColumn: 'id' },
];

const DOCKER_ROOT_RESERVED_DIRS = new Set([
  'buildkit',
  'containerd',
  'containers',
  'image',
  'network',
  'overlay2',
  'plugins',
  'runtimes',
  'swarm',
  'tmp',
  'trust',
  'volumes',
]);

const args = parseArgs(process.argv.slice(2));
loadEnv(path.join(root, '.env.local'));
loadEnv(path.join(root, '.env'));

const apply = args.has('--apply');
const deleteOrphans = args.has('--delete-orphans');
const driver = argValue('--driver') ?? process.env.DB_DRIVER ?? 'sqlite';

const report = {
  runId,
  mode: { apply, deleteOrphans, driver },
  backup: null,
  schema: [],
  json: [],
  orphanDirs: [],
  deletedOrphanDirs: [],
  warnings: [],
};

await fsp.mkdir(reportDir, { recursive: true });

try {
  if (driver === 'postgres') {
    await runPostgres();
  } else {
    await runSqlite();
  }
} finally {
  const reportPath = path.join(reportDir, 'report.json');
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.relative(root, reportPath)}`);
}

async function runSqlite() {
  const Database = requireBackend('better-sqlite3');
  const dbPathArg = argValue('--db-path');
  const dbPath = path.resolve(root, dbPathArg ?? process.env.DB_PATH ?? './nyabase.db');
  report.database = dbPath;
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite DB not found: ${dbPath}`);

  if (apply) {
    const backupDir = path.join(reportDir, 'backup');
    await fsp.mkdir(backupDir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const src = `${dbPath}${suffix}`;
      if (fs.existsSync(src)) {
        await fsp.copyFile(src, path.join(backupDir, path.basename(src)));
      }
    }
    report.backup = backupDir;
  }

  const db = new Database(dbPath);
  try {
    const tableColumns = (table) =>
      db.prepare(`PRAGMA table_info(${q(table)})`).all().map((row) => row.name);

    const cleanJson = () => {
      for (const spec of JSON_COLUMNS) {
        if (!tableExistsSqlite(db, spec.table)) continue;
        const columns = tableColumns(spec.table);
        if (!columns.includes(spec.column) || !columns.includes(spec.idColumn)) continue;
        const rows = db.prepare(`SELECT ${q(spec.idColumn)} AS id, ${q(spec.column)} AS value FROM ${q(spec.table)} WHERE ${q(spec.column)} IS NOT NULL`).all();
        let changed = 0;
        const changedIds = [];
        const update = db.prepare(`UPDATE ${q(spec.table)} SET ${q(spec.column)} = ? WHERE ${q(spec.idColumn)} = ?`);
        for (const row of rows) {
          const original = parseJson(row.value);
          const cleansed = cleanseLegacyMountCreate(original);
          if (stableJson(original) === stableJson(cleansed)) continue;
          changed += 1;
          changedIds.push(row.id);
          if (apply) update.run(JSON.stringify(cleansed), row.id);
        }
        report.json.push({ ...spec, changedRows: changed, ids: changedIds });
      }
    };

    const dropLegacyColumns = () => {
      if (!tableExistsSqlite(db, 'container_mounts')) return;
      const columns = tableColumns('container_mounts');
      for (const column of ['createIfMissing', 'create_if_missing']) {
        if (!columns.includes(column)) continue;
        report.schema.push({ table: 'container_mounts', column, action: 'drop_column' });
        if (apply) db.prepare(`ALTER TABLE ${q('container_mounts')} DROP COLUMN ${q(column)}`).run();
      }
    };

    if (apply) {
      db.transaction(() => {
        cleanJson();
        dropLegacyColumns();
      })();
    } else {
      cleanJson();
      dropLegacyColumns();
    }

    await collectAndMaybeDeleteOrphans({
      listLocalSources: () => {
        if (!tableExistsSqlite(db, 'data_disks')) return [];
        const columns = tableColumns('data_disks');
        const mountPoint = pickColumn(columns, ['mountPoint', 'mount_point']);
        const desiredState = pickColumn(columns, ['desiredState', 'desired_state']);
        if (!mountPoint || !desiredState) return [];
        return db.prepare(`SELECT ${q('id')} AS id, ${q(mountPoint)} AS root FROM ${q('data_disks')} WHERE ${q(desiredState)} IN ('active', 'removing')`).all();
      },
      listRemoteSources: () => {
        if (!tableExistsSqlite(db, 'remote_fs_mounts')) return [];
        const columns = tableColumns('remote_fs_mounts');
        const hostMountPoint = pickColumn(columns, ['hostMountPoint', 'host_mount_point']);
        const desiredState = pickColumn(columns, ['desiredState', 'desired_state']);
        if (!hostMountPoint || !desiredState) return [];
        return db.prepare(`SELECT ${q('id')} AS id, ${q(hostMountPoint)} AS root FROM ${q('remote_fs_mounts')} WHERE ${q(desiredState)} IN ('active', 'removing')`).all();
      },
      listRegisteredDirs: () => {
        if (!tableExistsSqlite(db, 'data_directories')) return [];
        const columns = tableColumns('data_directories');
        const sourceKind = pickColumn(columns, ['sourceKind', 'source_kind']);
        const sourceId = pickColumn(columns, ['sourceId', 'source_id']);
        const desiredState = pickColumn(columns, ['desiredState', 'desired_state']);
        if (!sourceKind || !sourceId || !desiredState) return [];
        return db.prepare(`SELECT ${q(sourceKind)} AS sourceKind, ${q(sourceId)} AS sourceId, ${q('name')} AS name FROM ${q('data_directories')} WHERE ${q(desiredState)} IN ('active', 'removing')`).all();
      },
    });
  } finally {
    db.close();
  }
}

async function runPostgres() {
  const { Client } = requireBackend('pg');
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? '5432'),
    database: process.env.DB_NAME ?? 'nyabase',
    user: process.env.DB_USER ?? 'nyabase',
    password: process.env.DB_PASSWORD ?? '',
  });
  await client.connect();
  report.database = `${process.env.DB_HOST ?? 'localhost'}/${process.env.DB_NAME ?? 'nyabase'}`;
  report.backup = 'Run pg_dump before --apply; changed row ids are listed in this report.';

  try {
    const tableExists = async (table) => Number((await client.query(
      'SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
      [table],
    )).rows[0].count) > 0;
    const columnExists = async (table, column) => Number((await client.query(
      'SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
      [table, column],
    )).rows[0].count) > 0;

    const cleanJson = async () => {
      for (const spec of JSON_COLUMNS) {
        if (!await tableExists(spec.table) || !await columnExists(spec.table, spec.column)) continue;
        const rows = (await client.query(`SELECT ${q(spec.idColumn)} AS id, ${q(spec.column)} AS value FROM ${q(spec.table)} WHERE ${q(spec.column)} IS NOT NULL`)).rows;
        let changed = 0;
        const changedIds = [];
        for (const row of rows) {
          const original = parseJson(row.value);
          const cleansed = cleanseLegacyMountCreate(original);
          if (stableJson(original) === stableJson(cleansed)) continue;
          changed += 1;
          changedIds.push(row.id);
          if (apply) {
            await client.query(`UPDATE ${q(spec.table)} SET ${q(spec.column)} = $1 WHERE ${q(spec.idColumn)} = $2`, [JSON.stringify(cleansed), row.id]);
          }
        }
        report.json.push({ ...spec, changedRows: changed, ids: changedIds });
      }
    };

    const dropLegacyColumns = async () => {
      if (!await tableExists('container_mounts')) return;
      for (const column of ['createIfMissing', 'create_if_missing']) {
        if (!await columnExists('container_mounts', column)) continue;
        report.schema.push({ table: 'container_mounts', column, action: 'drop_column' });
        if (apply) await client.query(`ALTER TABLE ${q('container_mounts')} DROP COLUMN ${q(column)}`);
      }
    };

    if (apply) await client.query('BEGIN');
    try {
      await cleanJson();
      await dropLegacyColumns();
      if (apply) await client.query('COMMIT');
    } catch (error) {
      if (apply) await client.query('ROLLBACK');
      throw error;
    }

    await collectAndMaybeDeleteOrphans({
      listLocalSources: async () => await rowsIfTablePostgres(client, 'data_disks', `SELECT id, "mountPoint" AS root FROM ${q('data_disks')} WHERE "desiredState" IN ('active', 'removing')`),
      listRemoteSources: async () => await rowsIfTablePostgres(client, 'remote_fs_mounts', `SELECT id, "hostMountPoint" AS root FROM ${q('remote_fs_mounts')} WHERE "desiredState" IN ('active', 'removing')`),
      listRegisteredDirs: async () => await rowsIfTablePostgres(client, 'data_directories', `SELECT "sourceKind" AS "sourceKind", "sourceId" AS "sourceId", name FROM ${q('data_directories')} WHERE "desiredState" IN ('active', 'removing')`),
    });
  } finally {
    await client.end();
  }
}

async function collectAndMaybeDeleteOrphans({ listLocalSources, listRemoteSources, listRegisteredDirs }) {
  const [locals, remotes, registered] = await Promise.all([
    listLocalSources(),
    listRemoteSources(),
    listRegisteredDirs(),
  ]);
  const registeredKeys = new Set(registered.map((row) => `${row.sourceKind}:${row.sourceId}:${row.name}`));
  const sources = [
    ...locals.map((row) => ({ kind: 'local', id: row.id, root: row.root ?? row.mountPoint })),
    ...remotes.map((row) => ({ kind: 'remote', id: row.id, root: row.root ?? row.hostMountPoint })),
  ];

  for (const source of sources) {
    const sourceRoot = path.resolve(String(source.root ?? ''));
    if (!isSafeSourceRoot(sourceRoot)) {
      report.warnings.push(`Skipped unsafe source root ${source.kind}:${source.id} ${sourceRoot}`);
      continue;
    }
    let entries;
    try {
      entries = await fsp.readdir(sourceRoot, { withFileTypes: true });
    } catch (error) {
      report.warnings.push(`Skipped unreadable source root ${source.kind}:${source.id} ${sourceRoot}: ${error.message}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (source.kind === 'local' && DOCKER_ROOT_RESERVED_DIRS.has(entry.name)) continue;
      if (registeredKeys.has(`${source.kind}:${source.id}:${entry.name}`)) continue;
      const fullPath = path.join(sourceRoot, entry.name);
      report.orphanDirs.push({ sourceKind: source.kind, sourceId: source.id, name: entry.name, path: fullPath });
      if (apply && deleteOrphans) {
        await fsp.rm(fullPath, { recursive: true, force: true });
        report.deletedOrphanDirs.push(fullPath);
      }
    }
  }
}

function cleanseLegacyMountCreate(value) {
  if (Array.isArray(value)) return value.map(cleanseLegacyMountCreate);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'createIfMissing' || key === 'createDirs') continue;
    result[key] = cleanseLegacyMountCreate(child);
  }
  return result;
}

function parseJson(value) {
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stableJson(value) {
  return JSON.stringify(value);
}

function q(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function tableExistsSqlite(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

function pickColumn(columns, candidates) {
  return candidates.find((candidate) => columns.includes(candidate)) ?? null;
}

async function rowsIfTablePostgres(client, table, sql) {
  const exists = Number((await client.query(
    'SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
    [table],
  )).rows[0].count) > 0;
  if (!exists) return [];
  return (await client.query(sql)).rows;
}

function isSafeSourceRoot(sourceRoot) {
  if (!sourceRoot || sourceRoot === path.parse(sourceRoot).root) return false;
  const parts = sourceRoot.split(path.sep).filter(Boolean);
  return parts.length >= 2;
}

function parseArgs(argv) {
  return new Set(argv);
}

function argValue(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
