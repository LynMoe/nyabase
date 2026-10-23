import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSqlMigrations } from './migrator.js';

/**
 * sha256 of every released migration, exactly as `system.schema_migrations`
 * records it. A deployed database refuses to boot when an applied migration
 * no longer matches its file, so a released migration is immutable: schema
 * changes go into a new `NNNNNN_name.sql`. Pin a new migration here when it
 * ships in a release (`sha256sum migrations/NNNNNN_name.sql`).
 */
const RELEASED_MIGRATION_CHECKSUMS: Readonly<Record<string, string>> = {
  '000001_initial': '8fe192948aff47524af0a1fbd6097eef32f963679328e72e07974af8822048b0',
};

describe('released SQL migrations', () => {
  it('are unchanged', async () => {
    const migrations = await discoverSqlMigrations(resolve(__dirname, 'migrations'));
    const onDisk = new Map(migrations.map((migration) => [
      `${migration.version}_${migration.name}`,
      migration.checksum,
    ]));
    const problems: string[] = [];
    for (const [migration, released] of Object.entries(RELEASED_MIGRATION_CHECKSUMS)) {
      const current = onDisk.get(migration);
      if (current === undefined) {
        problems.push(
          `${migration}.sql was released but is gone; deployed databases would fail with `
          + `"Applied migration ${migration} is missing from the application".`,
        );
      } else if (current !== released) {
        problems.push(
          `${migration}.sql was released with sha256 ${released} but is now ${current}. `
          + 'Deployed databases refuse to boot on an edited migration ("no longer matches its SQL file"): '
          + 'revert the edit and put the change in a new migration file instead.',
        );
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
