import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FailureCode, ServerStatus } from '@nyabase/common';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';
import { StoragePoolsService } from './storage-pools.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string, status: 'online' | 'unknown' = 'unknown') {
  return {
    id,
    name: `storage-test-server-${id.slice(0, 8)}`,
    slug: `storage-test-${id.slice(0, 8)}`,
    api_endpoint: 'https://127.0.0.1:8443',
    server_cert_fingerprint: null,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: null,
    dns_servers: [],
    status,
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

const cephPoolMetadata = {
  name: 'cephfs-a',
  driver: 'cephfs',
  config: {
    'cephfs.cluster_name': 'ceph',
    source: 'fs-a',
    'cephfs.path': '/data',
  },
};

function makeService(
  database: ConstructorParameters<typeof StoragePoolsRepository>[0],
  clients: unknown,
) {
  return new StoragePoolsService(
    new StoragePoolsRepository(database),
    new PgTransactionManager(database),
    database,
    clients as never,
  );
}

function incusClient(pools: unknown[]) {
  return {
    listStoragePools: vi.fn().mockResolvedValue({ metadata: pools }),
    getStoragePoolResources: vi.fn().mockResolvedValue({
      metadata: { space: { total: 1000, used: 100 } },
    }),
    listStorageVolumes: vi.fn().mockResolvedValue({ metadata: [] }),
    getStorageVolumeState: vi.fn().mockResolvedValue({ metadata: { usage: {} } }),
  };
}

describePg('storage pool registration and shared mapping', () => {
  it('discovers an unregistered CephFS pool, maps it, and sidecars a second mapping', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'online')).execute();
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

      const client = incusClient([cephPoolMetadata]);
      const clients = { get: vi.fn().mockResolvedValue(client) };
      const service = makeService(database, clients);

      const discovered = await service.discover(serverId);
      expect(discovered.pools).toEqual([]);
      expect(discovered.identityConflicts).toEqual([]);

      const executors = await service.discoverExecutors(backendId, serverId);
      expect(executors.executors).toHaveLength(1);
      expect(executors.executors[0]).toMatchObject({
        backendId,
        serverId,
        incusName: 'cephfs-a',
        registered: false,
        serverStatus: ServerStatus.Online,
      });

      const registered = await service.patchExecutor(backendId, executors.executors[0]!.id, {
        expectedRevision: executors.executors[0]!.revision,
        registered: true,
      });
      expect(registered.registered).toBe(true);

      clients.get.mockResolvedValueOnce(incusClient([{ ...cephPoolMetadata, name: 'cephfs-b' }]));
      const second = await service.discover(serverId);
      expect(second.pools).toEqual([]);
      expect(second.identityConflicts[0]).toMatchObject({
        code: FailureCode.StoragePoolInUse,
        serverId,
        incusName: 'cephfs-b',
      });
    });
  });

  it('returns identity conflicts as a sidecar instead of 409 on local discover', async () => {
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
      const service = makeService(database, {
        get: vi.fn().mockResolvedValue(incusClient([{
          ...cephPoolMetadata,
          config: {
            ...cephPoolMetadata.config,
            'cephfs.fsid': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        }])),
      });

      const discovered = await service.discover(serverId);
      expect(discovered.pools).toEqual([]);
      expect(discovered.identityConflicts[0]).toMatchObject({
        code: FailureCode.SharedBackendIdentityConflict,
        identityKey: 'cephfs:ceph/fs-a/data',
        expectedFsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        discoveredFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        serverId,
        incusName: 'cephfs-a',
      });
      await expect(service.patch(randomUUID(), {
        expectedRevision: 1,
        registered: true,
      })).rejects.toMatchObject({ message: 'Storage pool not found' });
    });
  });

  it('commits a local dir pool when a sibling CephFS FSID conflicts', async () => {
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
      const service = makeService(database, {
        get: vi.fn().mockResolvedValue(incusClient([
          {
            name: 'local-dir',
            driver: 'dir',
            config: {},
          },
          {
            ...cephPoolMetadata,
            config: {
              ...cephPoolMetadata.config,
              'cephfs.fsid': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            },
          },
        ])),
      });

      const discovered = await service.discover(serverId);
      expect(discovered.pools).toHaveLength(1);
      expect(discovered.pools[0]).toMatchObject({
        driver: 'dir',
        incusName: 'local-dir',
        shareable: false,
        sharedBackendId: null,
      });
      expect(discovered.identityConflicts[0]?.code).toBe(
        FailureCode.SharedBackendIdentityConflict,
      );
      const listed = await service.list(serverId, true);
      expect(listed.every((pool) => pool.driver !== 'cephfs')).toBe(true);
      expect(listed.some((pool) => pool.incusName === 'local-dir')).toBe(true);
    });
  });

  it('404s local PATCH on a shareable CephFS pool id', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'online')).execute();
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
      const service = makeService(database, {
        get: vi.fn().mockResolvedValue(incusClient([cephPoolMetadata])),
      });
      await service.discover(serverId);
      const [executor] = await service.listExecutors(backendId);
      expect(executor?.id).toBeTruthy();
      await expect(service.patch(executor!.id, {
        expectedRevision: executor!.revision,
        registered: true,
      })).rejects.toMatchObject({ message: 'Storage pool not found' });
      await expect(service.get(executor!.id, true)).rejects.toMatchObject({
        message: 'Storage pool not found',
      });
    });
  });

  it('keeps discover-executors at HTTP 200 when a sibling Incus is unreachable', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const onlineId = randomUUID();
      const downId = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(onlineId, 'online')).execute();
      await database.insertInto('infra.servers').values({
        ...serverValues(downId, 'online'),
        name: 'down-node',
        slug: `down-${downId.slice(0, 8)}`,
      }).execute();
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
      const clients = {
        get: vi.fn().mockImplementation(async (id: string) => {
          if (id === downId) throw new Error('ECONNREFUSED');
          return incusClient([cephPoolMetadata]);
        }),
      };
      const service = makeService(database, clients);
      const result = await service.discoverExecutors(backendId);
      expect(result.executors).toHaveLength(1);
      expect(result.executors[0]?.serverId).toBe(onlineId);
      expect(result.identityConflicts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: FailureCode.ServerUnreachable,
          serverId: downId,
        }),
      ]));
    });
  });
});
