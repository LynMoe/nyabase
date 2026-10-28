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
  // 000001-000007 squashed on 2026-10-26; production's schema_migrations was rewritten to match.
  '000001_initial': '8848618cee05d8e08dd708fa2aef656351732a24bd02af2393652139a99160ca',
  // Deployed to production on 2026-10-27 with 8356204.
  '000002_ssh-proxy-lines': '4ab7dfdba4cb8227286dcd5ac755550daff2feeee1e0196b07a9bb305a9a6d9f',
  // Deployed to production on 2026-10-28 with 0f4866c.
  '000003_grant-bundles': 'a44266926e6f31ee4f728df16dd72217c124019f4525694848d9b6190915dc56',
  // Deployed to production on 2026-10-28 with 4d819b8.
  '000004_notes-and-shared-volume-limit': '4921afb78f6ebcc08dba84592af229e59152d310a62cce1315cb3e487f6acd82',
  // Deployed to production on 2026-10-28 with bd78409.
  '000005_audit-impersonator': '0650632c377fb1947ba17d8211202b369078b626da6f0844882ddf25af1d49ab',
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
