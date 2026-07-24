import { afterEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { InitialSchema1700000000000 } from './1700000000000-InitialSchema.js';
import { GroupRevisionCas1700000003000 } from './1700000003000-GroupRevisionCas.js';

describe('GroupRevisionCas migration', () => {
  let dataSource: DataSource | undefined;

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('backfills existing groups to revision one and defaults new rows identically', async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [] });
    await dataSource.initialize();
    const runner = dataSource.createQueryRunner();
    try {
      await new InitialSchema1700000000000().up(runner);
      await runner.query(
        `INSERT INTO groups (id, name, capabilitiesJson) VALUES ('old', 'Old', '[]')`,
      );
      await new GroupRevisionCas1700000003000().up(runner);
      await runner.query(
        `INSERT INTO groups (id, name, capabilitiesJson) VALUES ('new', 'New', '[]')`,
      );
      expect(await runner.query(`SELECT id, revision FROM groups ORDER BY id`)).toEqual([
        { id: 'new', revision: 1 },
        { id: 'old', revision: 1 },
      ]);
    } finally {
      await runner.release();
    }
  });
});
