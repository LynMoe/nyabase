import { afterEach, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { InitialSchema1700000000000 } from './1700000000000-InitialSchema.js';
import { AuthRbacHardening1700000001000 } from './1700000001000-AuthRbacHardening.js';

describe('AuthRbacHardening migration', () => {
  let dataSource: DataSource | undefined;

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('backfills stable identities and bounds legacy active refresh history', async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [] });
    await dataSource.initialize();
    const runner = dataSource.createQueryRunner();
    try {
      await new InitialSchema1700000000000().up(runner);
      await runner.query(
        `INSERT INTO users (id, numericId, username, passwordHash, displayName, status)
         VALUES ('user-a', 1001, 'alice', 'hash', 'Alice', 'active')`,
      );
      for (let index = 0; index < 18; index += 1) {
        await runner.query(
          `INSERT INTO refresh_tokens (id, userId, hash, expiresAt, revoked, createdAt)
           VALUES (?, 'user-a', ?, '2099-01-01T00:00:00.000Z', 0, ?)`,
          [
            `legacy-${String(index).padStart(2, '0')}`,
            `legacy-hash-${index}`,
            `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
          ],
        );
      }
      await runner.query(
        `INSERT INTO groups (id, name, description, priority, isSystem, capabilitiesJson)
         VALUES ('admins', 'Administrators', NULL, 1000, 1, '[]')`,
      );
      await runner.query(
        `INSERT INTO refresh_tokens (id, userId, hash, expiresAt, revoked, createdAt)
         VALUES
           ('active', 'user-a', 'active-hash', '2099-01-01T00:00:00.000Z', 0, '2026-01-01T00:00:00.000Z'),
           ('revoked', 'user-a', 'revoked-hash', '2099-01-01T00:00:00.000Z', 1, '2026-01-01T00:00:00.000Z')`,
      );

      await new AuthRbacHardening1700000001000().up(runner);

      const users = await runner.query(`PRAGMA table_info('users')`) as Array<{ name: string }>;
      const refresh = await runner.query(`PRAGMA table_info('refresh_tokens')`) as Array<{ name: string }>;
      const groups = await runner.query(`PRAGMA table_info('groups')`) as Array<{ name: string }>;
      expect(users.map((column) => column.name)).toContain('authVersion');
      expect(refresh.map((column) => column.name)).toContain('previousHash');
      expect(refresh.map((column) => column.name)).toContain('previousRequestIdHash');
      expect(groups.map((column) => column.name)).toContain('systemKey');
      expect(await runner.query(`SELECT authVersion FROM users WHERE id = 'user-a'`))
        .toEqual([{ authVersion: 0 }]);
      expect(await runner.query(`SELECT systemKey FROM groups WHERE id = 'admins'`))
        .toEqual([{ systemKey: 'administrators' }]);
      const retained = await runner.query(
        `SELECT id FROM refresh_tokens WHERE userId = 'user-a' ORDER BY createdAt DESC, id DESC`,
      ) as Array<{ id: string }>;
      expect(retained).toHaveLength(16);
      expect(retained.map((row) => row.id)).toEqual(
        Array.from({ length: 16 }, (_, offset) => ({ id: `legacy-${String(17 - offset).padStart(2, '0')}` }))
          .map((row) => row.id),
      );
      expect(retained).not.toContainEqual({ id: 'revoked' });
    } finally {
      await runner.release();
    }
  });
});
