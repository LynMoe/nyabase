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

const TARGET = '000013_storage-pool-roles.sql';

/** A database migrated up to 000012, seeded by `seed`, then given 000013. */
async function withPre000013(
  seed: (pool: Pool) => Promise<void>,
  check: (pool: Pool, migrate: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'nyabase-000013-'));
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

async function seedServer(pool: Pool, name: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO infra.servers (id, name, slug, api_extensions, storage_overcommit_ratio, parent_interface,
       dns_servers, status, revision, node_metrics_status, preflight_status)
     VALUES ($1, $2, $2, '{}', 1, 'eth0', '{10.0.0.1}', 'online', 1, 'unknown', 'not_run')`,
    [id, name],
  );
  return id;
}

async function seedPool(pool: Pool, serverId: string, name: string, registered = true): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO infra.storage_pools (id, server_id, incus_name, driver, resize_family, root_disk_capable,
       shareable, quota_effective, registered, revision)
     VALUES ($1, $2, $3, 'dir', 'quota_online', true, false, true, $4, 1)`,
    [id, serverId, name, registered],
  );
  return id;
}

async function rejects(pool: Pool, statement: string, params: unknown[], constraint: string): Promise<void> {
  await expect(pool.query(statement, params)).rejects.toMatchObject({ code: '23514', constraint });
}

describePg('migration 000013 (storage pool roles)', () => {
  it('moves each server system pool onto the pool and starts every server single', async () => {
    const ids: Record<string, string> = {};
    await withPre000013(async (pool) => {
      ids.withSystem = await seedServer(pool, 'with-system');
      ids.without = await seedServer(pool, 'without');
      ids.system = await seedPool(pool, ids.withSystem, 'system');
      ids.data = await seedPool(pool, ids.withSystem, 'data');
      ids.other = await seedPool(pool, ids.without, 'other');
      await pool.query(`UPDATE infra.storage_pools SET mount_path = '/data1' WHERE id = $1`, [ids.data]);
      await pool.query(`UPDATE infra.servers SET system_pool_id = $1 WHERE id = $2`, [ids.system, ids.withSystem]);
    }, async (pool, migrate) => {
      await migrate();
      const pools = await pool.query<{ id: string; system_disk: boolean; system_weight: number; mount_path: string | null }>(
        `SELECT id, system_disk, system_weight, mount_path FROM infra.storage_pools ORDER BY incus_name`,
      );
      expect(pools.rows).toEqual([
        { id: ids.data, system_disk: false, system_weight: 1, mount_path: '/data1' },
        { id: ids.other, system_disk: false, system_weight: 1, mount_path: null },
        { id: ids.system, system_disk: true, system_weight: 1, mount_path: null },
      ]);
      const servers = await pool.query(
        `SELECT root_placement, root_placement_sticky FROM infra.servers ORDER BY name`,
      );
      expect(servers.rows).toEqual([
        { root_placement: 'single', root_placement_sticky: false },
        { root_placement: 'single', root_placement_sticky: false },
      ]);
      const column = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'infra' AND table_name = 'servers' AND column_name = 'system_pool_id'`,
      );
      expect(column.rowCount).toBe(0);
    });
  });

  it('keeps single servers at one system pool and system pools registered and root-capable', async () => {
    const ids: Record<string, string> = {};
    await withPre000013(async (pool) => {
      ids.server = await seedServer(pool, 's');
      ids.first = await seedPool(pool, ids.server, 'first');
      ids.second = await seedPool(pool, ids.server, 'second');
      ids.loose = await seedPool(pool, ids.server, 'loose', false);
      await pool.query(`UPDATE infra.servers SET system_pool_id = $1 WHERE id = $2`, [ids.first, ids.server]);
    }, async (pool, migrate) => {
      await migrate();
      await rejects(
        pool,
        `UPDATE infra.storage_pools SET system_disk = true WHERE id = $1`,
        [ids.second],
        'servers_root_placement_single',
      );
      await pool.query(`UPDATE infra.servers SET root_placement = 'random', root_placement_sticky = true WHERE id = $1`, [ids.server]);
      await pool.query(`UPDATE infra.storage_pools SET system_disk = true, system_weight = 3 WHERE id = $1`, [ids.second]);
      await rejects(
        pool,
        `UPDATE infra.servers SET root_placement = 'single', root_placement_sticky = false WHERE id = $1`,
        [ids.server],
        'servers_root_placement_single',
      );
      await rejects(
        pool,
        `UPDATE infra.servers SET root_placement = 'single' WHERE id = $1`,
        [ids.server],
        'servers_root_placement_check',
      );
      await rejects(
        pool,
        `UPDATE infra.storage_pools SET system_disk = true WHERE id = $1`,
        [ids.loose],
        'storage_pools_system_disk_check',
      );
      await rejects(
        pool,
        `UPDATE infra.storage_pools SET system_disk = false WHERE id = $1`,
        [ids.second],
        'storage_pools_system_params_check',
      );
      await rejects(
        pool,
        `UPDATE infra.storage_pools SET registered = false WHERE id = $1`,
        [ids.first],
        'storage_pools_system_disk_check',
      );
      // Turning the role off with its parameters reset is fine; then single placement fits again.
      await pool.query(
        `UPDATE infra.storage_pools SET system_disk = false, system_weight = 1, system_max_used_percent = NULL
         WHERE id = $1`,
        [ids.second],
      );
      await pool.query(`UPDATE infra.servers SET root_placement = 'single', root_placement_sticky = false WHERE id = $1`, [ids.server]);
    });
  });
});
