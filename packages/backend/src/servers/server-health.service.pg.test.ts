import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { StoragePoolsService } from '../storage-pools/storage-pools.service.js';
import { ServerHealthService } from './server-health.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(
  id: string,
  status: 'online' | 'unreachable' | 'unknown',
) {
  return {
    id,
    name: `scan-${id.slice(0, 8)}`,
    slug: `scan-${id.slice(0, 8)}`,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: 'eth0',
    dns_servers: [],
    status,
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_status: 'unknown' as const,
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'not_run' as const,
    preflight_checked_at: null,
    preflight_report: null,
  };
}


describePg('ServerHealthService PostgreSQL server admission guard', () => {
  it('lists only online servers for background scans', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const unknownServerId = randomUUID();
      const unreachableServerId = randomUUID();
      const onlineServerId = randomUUID();
      await database
        .insertInto('infra.servers')
        .values([
          serverValues(unknownServerId, 'unknown'),
          serverValues(unreachableServerId, 'unreachable'),
          serverValues(onlineServerId, 'online'),
        ])
        .execute();

      const health = new ServerHealthService(
        database,
        {} as never,
        {} as never,
        { registerServerHealth: vi.fn() } as never,
      );

      await expect(health.listOnlineServerIds()).resolves.toEqual([onlineServerId]);
      await expect(health.isServerOnline(onlineServerId)).resolves.toBe(true);
      await expect(health.isServerOnline(unknownServerId)).resolves.toBe(false);
      await expect(health.isServerOnline(unreachableServerId)).resolves.toBe(false);
    });
  });
});

describePg('ServerHealthService PostgreSQL inventory and status', () => {
  it('refreshes pool used/total from Incus resources', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const poolId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'online')).execute();
      await database.insertInto('infra.storage_pools').values({
        id: poolId,
        server_id: serverId,
        incus_name: 'default',
        driver: 'dir',
        resize_family: 'quota_online',
        root_disk_capable: true,
        shareable: false,
        block_filesystem: null,
        shared_backend_id: null,
        total_bytes: null,
        used_bytes: null,
        quota_effective: true,
        display_name: null,
        registered: true,
        last_observed_at: null,
        revision: 1,
      }).execute();

      const getResources = vi.fn().mockResolvedValue({ metadata: {} });
      const getStoragePoolResources = vi.fn().mockResolvedValue({
        metadata: { space: { used: 250, total: 4000 } },
      });
      const health = new ServerHealthService(
        database,
        { refreshHealth: vi.fn().mockResolvedValue(undefined) } as never,
        new StoragePoolsService(
          new StoragePoolsRepository(database),
          new PgTransactionManager(database),
          database,
          {} as never,
        ),
        { registerServerHealth: vi.fn() } as never,
      );

      await health.refreshInventory(
        serverId,
        { getResources, getStoragePoolResources } as never,
        new AbortController().signal,
      );

      const pool = await database
        .selectFrom('infra.storage_pools')
        .select(['used_bytes', 'total_bytes'])
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      expect(pool.used_bytes).toBe('250');
      expect(pool.total_bytes).toBe('4000');
    });
  });

  it('writes revision-guarded server status', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'unknown')).execute();
      const health = new ServerHealthService(
        database,
        {} as never,
        {} as never,
        { registerServerHealth: vi.fn() } as never,
      );

      await health.markServer(serverId, 'online', undefined, 2);
      await expect(health.isServerOnline(serverId)).resolves.toBe(false);
      await health.markServer(serverId, 'online', undefined, 1);
      await expect(health.isServerOnline(serverId)).resolves.toBe(true);
      await health.markServer(serverId, 'unreachable', 'down');
      const row = await database.selectFrom('infra.servers')
        .select(['status', 'last_error'])
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: 'unreachable', last_error: 'down' });
    });
  });

  it('treats a server intent as stale once the server revision moved on', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'unknown')).execute();
      const health = new ServerHealthService(
        database,
        {} as never,
        {} as never,
        { registerServerHealth: vi.fn() } as never,
      );
      const intent = (targetRevision: number) => ({
        resourceType: 'server',
        kind: 'server.preflight',
        serverId,
        targetRevision,
      }) as never;

      await expect(health.isCurrentServerIntent(intent(1))).resolves.toBe(true);
      await expect(health.isCurrentServerIntent(intent(2))).resolves.toBe(false);
    });
  });
});
