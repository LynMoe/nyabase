import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { runSqlMigrations } from './migrator.js';
import { pgMigrationsDirectory } from './persistence-pg.module.js';
import { withPostgresTestDatabase } from './postgres-test-harness.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

const TARGET = '000012_singleton-volumes.sql';

/** A database migrated up to 000011, seeded by `seed`, then given 000012. */
async function withPre000012(
  seed: (pool: Pool) => Promise<void>,
  check: (pool: Pool, migrate: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'nyabase-000012-'));
  try {
    const shipped = (await readdir(pgMigrationsDirectory())).filter((name) => name.endsWith('.sql')).sort();
    expect(shipped).toContain(TARGET);
    for (const name of shipped.filter((name) => name < TARGET)) {
      await copyFile(join(pgMigrationsDirectory(), name), join(directory, name));
    }
    await withPostgresTestDatabase(async ({ pool }) => {
      await seed(pool);
      await check(pool, async () => {
        await copyFile(join(pgMigrationsDirectory(), TARGET), join(directory, TARGET));
        await runSqlMigrations(pool, directory);
      });
    }, undefined, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface Seeded {
  userId: string;
  serverId: string;
  poolIds: [string, string];
  serverGrantId: string;
  poolGrantIds: [string, string];
  backendId: string;
}

async function seedBase(pool: Pool, limits: { pool: number | null; backend: number | null }): Promise<Seeded> {
  const userId = randomUUID();
  const serverId = randomUUID();
  const poolIds: [string, string] = [randomUUID(), randomUUID()];
  const bundleId = randomUUID();
  const serverGrantId = randomUUID();
  const poolGrantIds: [string, string] = [randomUUID(), randomUUID()];
  const backendId = randomUUID();
  await pool.query(
    `INSERT INTO iam.users (id, numeric_id, username, password_hash, display_name, status, role, auth_version)
     VALUES ($1, 1, 'alice', 'x', 'alice', 'active', 'user', 0)`,
    [userId],
  );
  await pool.query(
    `INSERT INTO infra.servers (id, name, slug, api_extensions, storage_overcommit_ratio, parent_interface,
       dns_servers, status, revision, node_metrics_status, preflight_status)
     VALUES ($1, 's1', 's1', '{}', 1, 'eth0', '{10.0.0.1}', 'online', 1, 'unknown', 'not_run')`,
    [serverId],
  );
  for (const [index, id] of poolIds.entries()) {
    await pool.query(
      `INSERT INTO infra.storage_pools (id, server_id, incus_name, driver, resize_family, root_disk_capable,
         shareable, quota_effective, registered, revision)
       VALUES ($1, $2, $3, 'dir', 'quota_online', true, false, true, true, 1)`,
      [id, serverId, `pool-${index}`],
    );
  }
  await pool.query(
    `INSERT INTO iam.grant_bundles (id, server_id, name, revision) VALUES ($1, $2, 'b', 1)`,
    [bundleId, serverId],
  );
  await pool.query(
    `INSERT INTO iam.server_grants (id, user_id, server_id, bundle_id) VALUES ($1, $2, $3, $4)`,
    [serverGrantId, userId, serverId, bundleId],
  );
  for (const [index, id] of poolGrantIds.entries()) {
    await pool.query(
      `INSERT INTO iam.storage_pool_grants (id, server_grant_id, user_id, server_id, pool_id, limit_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, serverGrantId, userId, serverId, poolIds[index], index === 0 ? limits.pool : 2_000],
    );
  }
  await pool.query(
    `INSERT INTO infra.shared_backends (id, name, identity_key, ceph_fsid, overcommit_ratio, revision,
       default_mount_path, max_volumes_per_user)
     VALUES ($1, 'meowfs', 'k', $2, 1, 1, '/meowfs', 1)`,
    [backendId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO iam.shared_backend_grants (id, user_id, shared_backend_id, limit_bytes) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), userId, backendId, limits.backend],
  );
  return { userId, serverId, poolIds, serverGrantId, poolGrantIds, backendId };
}

async function seedVolume(pool: Pool, owner: string, scope: { poolId: string; serverId: string } | { backendId: string }) {
  const id = randomUUID();
  const local = 'poolId' in scope;
  await pool.query(
    `INSERT INTO control.volumes (id, owner_id, pool_id, server_id, shared_backend_id, name, incus_name, size_bytes,
       lifecycle_phase)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 100, 'active')`,
    [
      id,
      owner,
      local ? scope.poolId : null,
      local ? scope.serverId : null,
      local ? null : scope.backendId,
      `v-${id.slice(0, 8)}`,
      `nyv-${id.replaceAll('-', '')}`,
    ],
  );
  return id;
}

describePg('migration 000012 (singleton volumes)', () => {
  it('turns each data-disk quota into a one-pool grant without changing coverage', async () => {
    let seeded!: Seeded;
    await withPre000012(async (pool) => {
      seeded = await seedBase(pool, { pool: 1_000, backend: 5_000 });
      await seedVolume(pool, seeded.userId, { poolId: seeded.poolIds[0], serverId: seeded.serverId });
      await seedVolume(pool, seeded.userId, { backendId: seeded.backendId });
    }, async (pool, migrate) => {
      const before = await pool.query(
        'SELECT user_id, pool_id, limit_bytes::text, expires_at FROM iam.effective_pool_access ORDER BY pool_id',
      );
      await migrate();
      const after = await pool.query(
        `SELECT user_id, pool_id, limit_bytes::text, expires_at, data_disk_grant_id
         FROM iam.effective_pool_access ORDER BY pool_id`,
      );
      expect(after.rows.map(({ data_disk_grant_id: _, ...row }) => row)).toEqual(before.rows);
      const grants = await pool.query(
        `SELECT id, server_grant_id, user_id, server_id, limit_bytes::text FROM iam.data_disk_grants ORDER BY id`,
      );
      expect(grants.rows).toEqual([...seeded.poolGrantIds].sort().map((id) => ({
        id,
        server_grant_id: seeded.serverGrantId,
        user_id: seeded.userId,
        server_id: seeded.serverId,
        limit_bytes: id === seeded.poolGrantIds[0] ? '1000' : '2000',
      })));
      const members = await pool.query('SELECT id, data_disk_grant_id FROM iam.storage_pool_grants');
      for (const row of members.rows) expect(row.data_disk_grant_id).toBe(row.id);
      // Shared backends start disabled; the per-user cap is gone.
      const backend = await pool.query('SELECT * FROM infra.shared_backends');
      expect(backend.rows[0]).toMatchObject({ mount_path: null, maintenance: false });
      expect(backend.rows[0]).not.toHaveProperty('max_volumes_per_user');
      const pools = await pool.query('SELECT mount_path, maintenance FROM infra.storage_pools');
      for (const row of pools.rows) expect(row).toEqual({ mount_path: null, maintenance: false });
      // Deleting the server grant still takes the data disks with it.
      await pool.query('DELETE FROM iam.server_grants WHERE id = $1', [seeded.serverGrantId]);
      expect((await pool.query('SELECT count(*)::int AS n FROM iam.data_disk_grants')).rows[0].n).toBe(0);
      expect((await pool.query('SELECT count(*)::int AS n FROM iam.storage_pool_grants')).rows[0].n).toBe(0);
    });
  });

  it('enforces one live volume per user and disk afterwards', async () => {
    await withPre000012(async (pool) => {
      const seeded = await seedBase(pool, { pool: 1_000, backend: 5_000 });
      await seedVolume(pool, seeded.userId, { poolId: seeded.poolIds[0], serverId: seeded.serverId });
      await pool.query(`UPDATE iam.users SET username = username`);
    }, async (pool, migrate) => {
      await migrate();
      const { rows: [volume] } = await pool.query('SELECT owner_id, pool_id, server_id FROM control.volumes');
      await expect(seedVolume(pool, volume.owner_id, { poolId: volume.pool_id, serverId: volume.server_id }))
        .rejects.toMatchObject({ code: '23505' });
      await pool.query(`UPDATE control.volumes SET lifecycle_phase = 'deleting'`);
      await expect(seedVolume(pool, volume.owner_id, { poolId: volume.pool_id, serverId: volume.server_id }))
        .resolves.toEqual(expect.any(String));
    });
  });

  it('stops on an unlimited storage grant and leaves the database as it was', async () => {
    for (const limits of [{ pool: null, backend: 5_000 }, { pool: 1_000, backend: null }]) {
      await withPre000012(async (pool) => {
        await seedBase(pool, limits);
      }, async (pool, migrate) => {
        await expect(migrate()).rejects.toMatchObject({ cause: { message: expect.stringMatching(/give every unlimited/) } });
        const applied = await pool.query(`SELECT version FROM system.schema_migrations WHERE version = '000012'`);
        expect(applied.rows).toEqual([]);
        expect((await pool.query(`SELECT to_regclass('iam.data_disk_grants') AS t`)).rows[0].t).toBeNull();
      });
    }
  });

  it('stops when a user holds several volumes on one disk', async () => {
    await withPre000012(async (pool) => {
      const seeded = await seedBase(pool, { pool: 1_000, backend: 5_000 });
      await seedVolume(pool, seeded.userId, { backendId: seeded.backendId });
      await seedVolume(pool, seeded.userId, { backendId: seeded.backendId });
    }, async (_pool, migrate) => {
      await expect(migrate()).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/several volumes on one pool or shared backend/) },
      });
    });
  });
});
