import { resolve } from 'node:path';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import {
  assertFreshInitialMigrationManifest,
  discoverSqlMigrations,
  migrationStatus,
  runSqlMigrations,
} from './migrator.js';
import { pgPersistenceOptionsFromConfig } from './options.js';
import { createPgPool } from './pool.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'migrate' && command !== 'status') {
    throw new Error('Usage: cli.ts <migrate|status>');
  }

  const options = pgPersistenceOptionsFromConfig(new NyabaseConfigService());
  const pool = createPgPool(options);
  const directory = resolve(__dirname, 'migrations');
  try {
    assertFreshInitialMigrationManifest(await discoverSqlMigrations(directory));
    if (command === 'migrate') {
      const completed = await runSqlMigrations(
        pool,
        directory,
        { lockTimeoutMs: options.lockTimeoutMs },
      );
      for (const migration of completed) {
        console.log(`applied ${migration.version}_${migration.name}`);
      }
      if (completed.length === 0) console.log('database is up to date');
      return;
    }

    const status = await migrationStatus(
      pool,
      directory,
      { lockTimeoutMs: options.lockTimeoutMs },
    );
    for (const migration of status.applied) {
      console.log(`applied ${migration.version}_${migration.name}`);
    }
    for (const migration of status.pending) {
      console.log(`pending ${migration.version}_${migration.name}`);
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
