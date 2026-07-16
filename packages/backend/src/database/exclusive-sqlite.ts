import type Database from 'better-sqlite3';

/**
 * Keep the control plane single-writer by holding SQLite's EXCLUSIVE lock for
 * the lifetime of the TypeORM connection. SQLite owns crash recovery for this
 * lock, so there is no stale pid/lock file to repair after a killed Backend.
 */
export function configureExclusiveSqliteConnection(db: Database.Database): void {
  const rows = db.pragma('locking_mode = EXCLUSIVE') as Array<{ locking_mode?: string }>;
  if (rows.length !== 1 || rows[0]?.locking_mode?.toLowerCase() !== 'exclusive') {
    throw new Error('SQLite refused locking_mode=EXCLUSIVE');
  }

  // Merely selecting the locking mode does not acquire the lock. Force one
  // write transaction before TypeORM can expose any service or websocket.
  db.exec('BEGIN EXCLUSIVE; COMMIT;');
}
