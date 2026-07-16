import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { configureExclusiveSqliteConnection } from './exclusive-sqlite.js';

describe('configureExclusiveSqliteConnection', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('rejects a second Backend while the first connection is alive and recovers after close', () => {
    const root = mkdtempSync(join(tmpdir(), 'nyabase-exclusive-sqlite-'));
    roots.push(root);
    const path = join(root, 'nyabase.db');
    const first = new Database(path, { timeout: 0 });
    const second = new Database(path, { timeout: 0 });

    try {
      configureExclusiveSqliteConnection(first);
      first.exec('CREATE TABLE state (id INTEGER PRIMARY KEY)');
      expect(() => configureExclusiveSqliteConnection(second)).toThrow(/locked/i);
    } finally {
      first.close();
    }

    expect(() => configureExclusiveSqliteConnection(second)).not.toThrow();
    second.close();
  });
});
