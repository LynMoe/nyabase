import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ServerStatus } from '@nyabase/common';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ServersService } from './servers.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('clean Incus server contract', () => {
  it('does not persist an expected fingerprint before transport TOFU observes it', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database
        .insertInto('infra.servers')
        .values({
          id: serverId,
          name: 'TOFU node',
          slug: `tofu-${serverId.slice(0, 8)}`,
          api_endpoint: 'https://incus.example.test:8443',
          server_cert_fingerprint: null,
          incus_version: null,
          api_extensions: [],
          system_pool_id: null,
          storage_overcommit_ratio: 1,
          parent_interface: 'eth0',
          dns_servers: ['10.20.0.1'],
          gpu_runtime_available: false,
          status: ServerStatus.Unknown,
          last_seen_at: null,
          last_error: null,
          revision: 1,
          node_metrics_endpoint: null,
          node_metrics_server_cert_fingerprint: null,
          node_metrics_token_ciphertext: null,
          node_metrics_token_fingerprint: null,
          node_metrics_status: 'unconfigured',
          node_metrics_last_success_at: null,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
          preflight_status: 'not_run',
          preflight_checked_at: null,
          preflight_report: null,
        })
        .execute();
      const service = new ServersService(
        database,
        new PgTransactionManager(database),
        {} as never,
        {} as never,
      );

      await expect(service.prepareConnection(serverId, 'aa'.repeat(32))).resolves.toBe(1);
      await expect(
        database
          .selectFrom('infra.servers')
          .select(['server_cert_fingerprint', 'revision'])
          .where('id', '=', serverId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({
        server_cert_fingerprint: null,
        revision: '1',
      });

      await database
        .updateTable('infra.servers')
        .set({ server_cert_fingerprint: 'aa'.repeat(32) })
        .where('id', '=', serverId)
        .execute();
      await expect(service.prepareConnection(serverId, 'bb'.repeat(32))).rejects.toMatchObject({
        response: { code: 'PREFLIGHT_IDENTITY_MISMATCH' },
      });
    });
  });

  it('rejects stale or referenced server deletion', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database
        .insertInto('infra.servers')
        .values({
          id: serverId,
          name: 'Guarded node',
          slug: `guarded-${serverId.slice(0, 8)}`,
          api_endpoint: 'https://incus.example.test:8443',
          server_cert_fingerprint: null,
          incus_version: null,
          api_extensions: [],
          system_pool_id: null,
          storage_overcommit_ratio: 1,
          parent_interface: 'eth0',
          dns_servers: ['10.20.1.1'],
          gpu_runtime_available: false,
          status: ServerStatus.Unknown,
          last_seen_at: null,
          last_error: null,
          revision: 3,
          node_metrics_endpoint: null,
          node_metrics_server_cert_fingerprint: null,
          node_metrics_token_ciphertext: null,
          node_metrics_token_fingerprint: null,
          node_metrics_status: 'unconfigured',
          node_metrics_last_success_at: null,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
          preflight_status: 'not_run',
          preflight_checked_at: null,
          preflight_report: null,
        })
        .execute();
      const poolId = randomUUID();
      await database
        .insertInto('infra.storage_pools')
        .values({
          id: poolId,
          server_id: serverId,
          incus_name: 'default',
          driver: 'dir',
          resize_family: 'quota_online',
          root_disk_capable: true,
          shareable: false,
          block_filesystem: null,
          shared_backend_id: null,
          total_bytes: 100,
          used_bytes: 10,
          quota_effective: true,
          display_name: null,
          registered: false,
          last_observed_at: null,
          revision: 1,
        })
        .execute();

      const service = new ServersService(
        database,
        new PgTransactionManager(database),
        { assertActorCapabilitiesInTransaction: vi.fn() } as never,
        { append: vi.fn() } as never,
        undefined,
        undefined,
        { forgetServer: vi.fn() } as never,
      );

      await expect(service.delete('actor-1', serverId, 2)).rejects.toMatchObject({
        response: { code: 'REVISION_CONFLICT' },
      });
      await expect(service.delete('actor-1', serverId, 3)).rejects.toMatchObject({
        response: {
          code: 'SERVER_NOT_EMPTY',
          details: { references: ['storage_pools'] },
        },
      });
      await expect(
        database
          .selectFrom('infra.servers')
          .select('id')
          .where('id', '=', serverId)
          .executeTakeFirst(),
      ).resolves.toEqual({ id: serverId });
    });
  });
});
