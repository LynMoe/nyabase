import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FailureCode } from '@nyabase/common';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';
import { StoragePoolsService } from './storage-pools.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string) {
  return {
    id,
    name: 'storage-test-server',
    slug: `storage-test-${id.slice(0, 8)}`,
    api_endpoint: 'https://127.0.0.1:8443',
    server_cert_fingerprint: null,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: null,
    dns_servers: [],
    gpu_runtime_available: false,
    status: 'unknown' as const,
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_endpoint: null,
    node_metrics_server_cert_fingerprint: null,
    node_metrics_token_ciphertext: null,
    node_metrics_token_fingerprint: null,
    node_metrics_status: 'unconfigured' as const,
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'not_run' as const,
    preflight_checked_at: null,
    preflight_report: null,
  };
}

describePg('storage pool registration and shared mapping', () => {
  it('discovers an unregistered CephFS pool, maps it, and rejects a second mapping', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'shared-ceph',
        display_name: null,
        identity_key: 'cephfs:ceph/fs-a/data',
        ceph_fsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        total_bytes: null,
        used_bytes: null,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();

      const poolMetadata = {
        name: 'cephfs-a',
        driver: 'cephfs',
        config: {
          'cephfs.cluster_name': 'ceph',
          source: 'fs-a',
          'cephfs.path': '/data',
        },
      };
      const client = {
        listStoragePools: vi.fn().mockResolvedValue({ metadata: [poolMetadata] }),
        getStoragePoolResources: vi.fn().mockResolvedValue({
          metadata: { space: { total: 1000, used: 100 } },
        }),
      };
      const clients = { get: vi.fn().mockResolvedValue(client) };
      const service = new StoragePoolsService(
        new StoragePoolsRepository(database),
        new PgTransactionManager(database),
        database,
        clients as never,
      );

      const discovered = await service.discover(serverId);
      expect(discovered[0]).toMatchObject({
        driver: 'cephfs',
        shareable: true,
        sharedBackendId: backendId,
        registered: false,
      });

      const registered = await service.patch(discovered[0]!.id, {
        expectedRevision: discovered[0]!.revision,
        registered: true,
        sharedBackendId: backendId,
      });
      expect(registered.sharedBackendId).toBe(backendId);
      expect(registered.registered).toBe(true);

      clients.get.mockResolvedValueOnce({
        ...client,
        listStoragePools: vi.fn().mockResolvedValue({
          metadata: [{ ...poolMetadata, name: 'cephfs-b' }],
        }),
      });
      await expect(service.discover(serverId)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: FailureCode.StoragePoolInUse,
        }),
      });
    });
  });

  it('rejects a discovered identity when its reported FSID conflicts', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'shared-ceph',
        display_name: null,
        identity_key: 'cephfs:ceph/fs-a/data',
        ceph_fsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        total_bytes: null,
        used_bytes: null,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      const service = new StoragePoolsService(
        new StoragePoolsRepository(database),
        new PgTransactionManager(database),
        database,
        {
          get: vi.fn().mockResolvedValue({
            listStoragePools: vi.fn().mockResolvedValue({
              metadata: [{
                name: 'cephfs-a',
                driver: 'cephfs',
                config: {
                  'cephfs.cluster_name': 'ceph',
                  source: 'fs-a',
                  'cephfs.path': '/data',
                  'cephfs.fsid': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                },
              }],
            }),
            getStoragePoolResources: vi.fn().mockResolvedValue({ metadata: {} }),
          }),
        } as never,
      );

      await expect(service.discover(serverId)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: FailureCode.SharedBackendIdentityConflict,
        }),
      });
    });
  });
});
