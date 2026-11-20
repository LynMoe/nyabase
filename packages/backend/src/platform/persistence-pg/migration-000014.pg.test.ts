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

const TARGET = '000014_disk-quota.sql';

/** A database migrated up to 000013, seeded by `seed`, then given 000014. */
async function withPre000014(
  seed: (pool: Pool) => Promise<void>,
  check: (pool: Pool, migrate: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'nyabase-000014-'));
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

let numericId = 1;

async function seedUser(pool: Pool, name: string, status = 'active'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO iam.users (id, numeric_id, username, password_hash, display_name, status, role, auth_version)
     VALUES ($1, $2, $3, 'x', $3, $4, 'user', 0)`,
    [id, numericId++, name, status],
  );
  return id;
}

interface World {
  serverId: string;
  bundleId: string;
  pools: [string, string, string];
  imageId: string;
}

async function seedWorld(pool: Pool, bundleRoot: number | null): Promise<World> {
  const serverId = randomUUID();
  const bundleId = randomUUID();
  const imageId = randomUUID();
  const pools: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()];
  await pool.query(
    `INSERT INTO infra.servers (id, name, slug, api_extensions, storage_overcommit_ratio, parent_interface,
       dns_servers, status, revision, node_metrics_status, preflight_status)
     VALUES ($1, 's1', 's1', '{}', 1, 'eth0', '{10.0.0.1}', 'online', 1, 'unknown', 'not_run')`,
    [serverId],
  );
  for (const [index, id] of pools.entries()) {
    await pool.query(
      `INSERT INTO infra.storage_pools (id, server_id, incus_name, driver, resize_family, root_disk_capable,
         shareable, quota_effective, registered, revision)
       VALUES ($1, $2, $3, 'dir', 'quota_online', true, false, true, true, 1)`,
      [id, serverId, `pool-${index}`],
    );
  }
  await pool.query(
    `INSERT INTO infra.images (id, alias, fingerprint, login_user, network_managed_externally, is_active, deleting,
       cleanup_generation, revision)
     VALUES ($1, 'base', $2, 'root', true, true, false, 0, 1)`,
    [imageId, 'a'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO iam.grant_bundles (id, server_id, name, cpu_cores, root_disk_bytes, revision)
     VALUES ($1, $2, 'b', 8, $3, 1)`,
    [bundleId, serverId, bundleRoot],
  );
  return { serverId, bundleId, pools, imageId };
}

async function seedGrant(
  pool: Pool,
  world: World,
  userId: string,
  overrides: { rootDiskBytes?: number | null } = {},
): Promise<string> {
  const id = randomUUID();
  const overridden = 'rootDiskBytes' in overrides ? ['root_disk'] : [];
  await pool.query(
    `INSERT INTO iam.server_grants (id, user_id, server_id, bundle_id, overridden, root_disk_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, world.serverId, world.bundleId, overridden, overrides.rootDiskBytes ?? null],
  );
  return id;
}

/** A data-disk grant (000012) of the pools under the server grant, sharing `limit`. */
async function seedDataDisks(
  pool: Pool,
  world: World,
  userId: string,
  serverGrantId: string,
  poolIds: string[],
  limit: number,
): Promise<void> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO iam.data_disk_grants (id, server_grant_id, user_id, server_id, limit_bytes)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, serverGrantId, userId, world.serverId, limit],
  );
  for (const poolId of poolIds) {
    await pool.query(
      `INSERT INTO iam.storage_pool_grants (id, server_grant_id, data_disk_grant_id, user_id, server_id, pool_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), serverGrantId, id, userId, world.serverId, poolId],
    );
  }
}

async function seedContainer(
  pool: Pool,
  world: World,
  ownerId: string,
  rootBytes: number,
  phase = 'active',
): Promise<void> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO control.containers (id, server_id, owner_id, image_id, created_by, name, revision, image_alias,
       image_fingerprint, root_pool_id, root_size_bytes, mem_bytes, nesting, syscall_intercept, power_intent,
       lifecycle_phase, needs_attention, failure_code)
     VALUES ($1, $2, $3, $4, $3, $5, 1, 'base', $6, $7, $8, 1073741824, true, true, 'stopped', $9, false, $10)`,
    [
      id, world.serverId, ownerId, world.imageId, `c-${id.slice(0, 8)}`, 'a'.repeat(64), world.pools[0], rootBytes,
      phase, phase === 'failed' ? 'X' : null,
    ],
  );
}

async function grantRow(pool: Pool, id: string) {
  const { rows: [row] } = await pool.query(
    `SELECT overridden, disk_bytes::text, root_disk_bytes::text FROM iam.server_grants WHERE id = $1`,
    [id],
  );
  return row;
}

async function ownDisks(pool: Pool, serverGrantId: string) {
  const { rows } = await pool.query(
    `SELECT pool_id, cap_bytes::text FROM iam.storage_pool_grants WHERE server_grant_id = $1 ORDER BY pool_id`,
    [serverGrantId],
  );
  return rows;
}

describePg('migration 000014 (disk quota)', () => {
  it('gives every grant one disk total that never leaves it less room, keeping all coverage', async () => {
    const ids: Record<string, string> = {};
    let world!: World;
    await withPre000014(async (pool) => {
      world = await seedWorld(pool, 100);
      // Follows the bundle, no data disks: nothing to override.
      ids.plain = await seedGrant(pool, world, await seedUser(pool, 'plain'));
      // Its own system-disk quota, no data disks: the total follows it.
      ids.rooted = await seedGrant(pool, world, await seedUser(pool, 'rooted'), { rootDiskBytes: 300 });
      // Same value as the bundle: no override needed.
      ids.same = await seedGrant(pool, world, await seedUser(pool, 'same'), { rootDiskBytes: 100 });
      // One data-disk group of one pool.
      const single = await seedUser(pool, 'single');
      ids.single = await seedGrant(pool, world, single);
      await seedDataDisks(pool, world, single, ids.single, [world.pools[0]], 500);
      // Two groups, and live system disks over a lowered quota (failed / deleting ones do not count).
      const busy = await seedUser(pool, 'busy');
      ids.busy = await seedGrant(pool, world, busy, { rootDiskBytes: 50 });
      await seedDataDisks(pool, world, busy, ids.busy, [world.pools[0], world.pools[1]], 400);
      await seedDataDisks(pool, world, busy, ids.busy, [world.pools[2]], 200);
      await seedContainer(pool, world, busy, 60);
      await seedContainer(pool, world, busy, 20);
      await seedContainer(pool, world, busy, 1_000, 'failed');
      // A disabled user's grants convert too (they are not in the effective views).
      const disabled = await seedUser(pool, 'disabled', 'disabled');
      ids.disabled = await seedGrant(pool, world, disabled);
      await seedDataDisks(pool, world, disabled, ids.disabled, [world.pools[1]], 70);
    }, async (pool, migrate) => {
      const serverBefore = await pool.query(
        `SELECT user_id, cpu_cores, mem_bytes::text, root_disk_bytes::text, gpu_count, expires_at
         FROM iam.effective_server_access ORDER BY user_id`,
      );
      const poolsBefore = await pool.query(
        'SELECT user_id, pool_id, expires_at FROM iam.effective_pool_access ORDER BY user_id, pool_id',
      );
      await migrate();

      expect((await pool.query(
        `SELECT user_id, cpu_cores, mem_bytes::text, root_disk_bytes::text, gpu_count, expires_at
         FROM iam.effective_server_access ORDER BY user_id`,
      )).rows).toEqual(serverBefore.rows);
      expect((await pool.query(
        'SELECT user_id, pool_id, expires_at FROM iam.effective_pool_access ORDER BY user_id, pool_id',
      )).rows).toEqual(poolsBefore.rows);
      const { rows: [bundle] } = await pool.query('SELECT disk_bytes::text, root_disk_bytes::text FROM iam.grant_bundles');
      expect(bundle).toEqual({ disk_bytes: '100', root_disk_bytes: '100' });

      expect(await grantRow(pool, ids.plain!)).toEqual({ overridden: [], disk_bytes: null, root_disk_bytes: null });
      expect(await grantRow(pool, ids.rooted!)).toEqual({ overridden: ['root_disk', 'disk'], disk_bytes: '300', root_disk_bytes: '300' });
      expect(await grantRow(pool, ids.same!)).toEqual({ overridden: ['root_disk'], disk_bytes: null, root_disk_bytes: '100' });
      expect(await grantRow(pool, ids.single!)).toEqual({ overridden: ['disk', 'data_disks'], disk_bytes: '600', root_disk_bytes: null });
      expect(await ownDisks(pool, ids.single!)).toEqual([{ pool_id: world.pools[0], cap_bytes: '500' }]);
      // max(50, 60 + 20 live) + 400 + 200
      expect(await grantRow(pool, ids.busy!)).toEqual({
        overridden: ['root_disk', 'disk', 'data_disks'], disk_bytes: '680', root_disk_bytes: '50',
      });
      expect(await ownDisks(pool, ids.busy!)).toEqual([
        { pool_id: world.pools[0], cap_bytes: '400' },
        { pool_id: world.pools[1], cap_bytes: '400' },
        { pool_id: world.pools[2], cap_bytes: '200' },
      ].sort((left, right) => (left.pool_id < right.pool_id ? -1 : 1)));
      expect(await grantRow(pool, ids.disabled!)).toEqual({ overridden: ['disk', 'data_disks'], disk_bytes: '170', root_disk_bytes: null });

      const disk = await pool.query(
        `SELECT user_id, disk_bytes::text FROM iam.effective_server_access
         WHERE user_id IN (SELECT user_id FROM iam.server_grants WHERE id = ANY ($1))`,
        [[ids.plain, ids.single]],
      );
      expect(disk.rows.map((row) => row.disk_bytes).sort()).toEqual(['100', '600']);
      expect((await pool.query(`SELECT to_regclass('iam.data_disk_grants') AS t`)).rows[0].t).toBeNull();
      // Deleting a server grant still takes its own data disks with it.
      await pool.query('DELETE FROM iam.server_grants WHERE id = $1', [ids.busy]);
      expect(await ownDisks(pool, ids.busy!)).toEqual([]);
    });
  });

  it('stops on an unlimited system-disk quota (bundle or override) and leaves the database as it was', async () => {
    for (const variant of ['bundle', 'override'] as const) {
      await withPre000014(async (pool) => {
        const world = await seedWorld(pool, variant === 'bundle' ? null : 100);
        await seedGrant(pool, world, await seedUser(pool, 'unlimited'), variant === 'override' ? { rootDiskBytes: null } : {});
      }, async (pool, migrate) => {
        await expect(migrate()).rejects.toMatchObject({ cause: { message: expect.stringMatching(/give every unlimited/) } });
        const applied = await pool.query(`SELECT version FROM system.schema_migrations WHERE version = '000014'`);
        expect(applied.rows).toEqual([]);
        expect((await pool.query(`SELECT to_regclass('iam.data_disk_grants') AS t`)).rows[0].t).not.toBeNull();
        expect((await pool.query(`SELECT to_regclass('iam.grant_bundle_disks') AS t`)).rows[0].t).toBeNull();
      });
    }
  });
});
