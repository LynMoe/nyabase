import { afterEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { InitialSchema1700000000000 } from './1700000000000-InitialSchema.js';
import { ProductRevisionCas1700000002000 } from './1700000002000-ProductRevisionCas.js';

describe('ProductRevisionCas migration', () => {
  let dataSource: DataSource | undefined;

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('backfills existing images to revision one and defaults new rows identically', async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [] });
    await dataSource.initialize();
    const runner = dataSource.createQueryRunner();
    try {
      await new InitialSchema1700000000000().up(runner);
      await runner.query(
        `INSERT INTO images (id, name, dockerImage) VALUES ('old', 'Old', 'old:latest')`,
      );
      await new ProductRevisionCas1700000002000().up(runner);
      await runner.query(
        `INSERT INTO images (id, name, dockerImage) VALUES ('new', 'New', 'new:latest')`,
      );
      expect(await runner.query(`SELECT id, revision FROM images ORDER BY id`)).toEqual([
        { id: 'new', revision: 1 },
        { id: 'old', revision: 1 },
      ]);
    } finally {
      await runner.release();
    }
  });
});
