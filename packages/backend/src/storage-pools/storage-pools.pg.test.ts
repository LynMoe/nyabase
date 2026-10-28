import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FailureCode, ServerStatus } from '@nyabase/common';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';
import { SharedBackendExecutorsService } from './shared-backend-executors.service.js';
import { StoragePoolDiscoveryService } from './storage-pool-discovery.service.js';
import { StoragePoolsService } from './storage-pools.service.js';
import { grantPool, grantServer } from '../iam/access.pg-test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string, status: 'online' | 'unknown' = 'unknown') {
  return {
    id,
    name: `storage-test-server-${id.slice(0, 8)}`,
    slug: `storage-test-${id.slice(0, 8)}`,
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
    node_metrics_status: 'unknown' as const,
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

const ACTOR_ID = '00000000-0000-4000-8000-0000000000aa';
const FAKE_AUDIT = { append: async () => undefined, log: async () => undefined } as never;

function makeService(
  database: ConstructorParameters<typeof StoragePoolsRepository>[0],
  clients: unknown,
) {
  const repository = new StoragePoolsRepository(database);
  const transactions = new PgTransactionManager(database);
  const discovery = new StoragePoolDiscoveryService(repository, transactions, clients as never);
  const pools = new StoragePoolsService(repository, transactions, database, discovery, FAKE_AUDIT);
  const executors = new SharedBackendExecutorsService(repository, transactions, discovery, FAKE_AUDIT);
  // One handle for pool and executor operations, as the flows below mix both.
  return Object.assign(pools, {
    listExecutors: executors.listExecutors.bind(executors),
    discoverExecutors: executors.discoverExecutors.bind(executors),
    patchExecutor: executors.patchExecutor.bind(executors),
  });
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

      const discovered = await service.discover(ACTOR_ID, serverId);
      expect(discovered.pools).toEqual([]);
      expect(discovered.identityConflicts).toEqual([]);

      const executors = await service.discoverExecutors(ACTOR_ID, backendId, serverId);
      expect(executors.executors).toHaveLength(1);
      expect(executors.executors[0]).toMatchObject({
        backendId,
        serverId,
        incusName: 'cephfs-a',
        registered: false,
        serverStatus: ServerStatus.Online,
      });

      const registered = await service.patchExecutor(ACTOR_ID, backendId, executors.executors[0]!.id, {
        expectedRevision: executors.executors[0]!.revision,
        registered: true,
      });
      expect(registered.registered).toBe(true);

      // The last executor of a backend that still holds volumes stays registered:
      // without it nothing could destroy their data.
      const ownerId = randomUUID();
      await database.insertInto('iam.users').values({
        id: ownerId, numeric_id: 200, username: 'shared-owner', password_hash: 'unused',
        display_name: 'Shared owner', status: 'active', auth_version: 1,
      }).execute();
      await database.insertInto('control.volumes').values({
        id: randomUUID(), owner_id: ownerId, shared_backend_id: backendId, name: 'data',
        incus_name: `nyv-${randomUUID().replaceAll('-', '')}`, size_bytes: '1024', lifecycle_phase: 'active',
        revision: 1, needs_attention: false,
      }).execute();
      await expect(service.patchExecutor(ACTOR_ID, backendId, registered.id, {
        expectedRevision: registered.revision,
        registered: false,
      })).rejects.toMatchObject({ response: expect.objectContaining({ code: FailureCode.StoragePoolInUse }) });

      clients.get.mockResolvedValueOnce(incusClient([{ ...cephPoolMetadata, name: 'cephfs-b' }]));
      const second = await service.discover(ACTOR_ID, serverId);
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

      const discovered = await service.discover(ACTOR_ID, serverId);
      expect(discovered.pools).toEqual([]);
      expect(discovered.identityConflicts[0]).toMatchObject({
        code: FailureCode.SharedBackendIdentityConflict,
        identityKey: 'cephfs:ceph/fs-a/data',
        expectedFsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        discoveredFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        serverId,
        incusName: 'cephfs-a',
      });
      await expect(service.patch(ACTOR_ID, randomUUID(), {
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

      const discovered = await service.discover(ACTOR_ID, serverId);
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
      await service.discover(ACTOR_ID, serverId);
      const [executor] = await service.listExecutors(backendId);
      expect(executor?.id).toBeTruthy();
      await expect(service.patch(ACTOR_ID, executor!.id, {
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
      const result = await service.discoverExecutors(ACTOR_ID, backendId);
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

  it('persists source on discover and allows remark PATCH without registration', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const userId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'online')).execute();
      await database.insertInto('iam.users').values({
        id: userId,
        numeric_id: 1,
        username: `pool-${userId.slice(0, 8)}`,
        password_hash: 'test-password-hash',
        display_name: 'Pool User',
        status: 'active',
        auth_version: 0,
      }).execute();
      const client = incusClient([
        { name: 'dir-a', driver: 'dir', config: { source: '/data1/nyabase/incus' } },
        { name: 'dir-bad', driver: 'dir', config: { source: '/bad\npath' } },
      ]);
      const service = makeService(database, { get: vi.fn().mockResolvedValue(client) });
      const discovered = await service.discover(ACTOR_ID, serverId);
      const dir = discovered.pools.find((pool) => pool.incusName === 'dir-a');
      const bad = discovered.pools.find((pool) => pool.incusName === 'dir-bad');
      expect(dir?.source).toBe('/data1/nyabase/incus');
      expect(dir?.displayName).toBeNull();
      expect(bad?.source).toBeNull();

      const remarked = await service.patch(ACTOR_ID, dir!.id, {
        expectedRevision: dir!.revision,
        displayName: '系统盘',
      });
      expect(remarked.displayName).toBe('系统盘');
      expect(remarked.registered).toBe(false);
      expect(remarked.source).toBe('/data1/nyabase/incus');

      const registered = await service.patch(ACTOR_ID, dir!.id, {
        expectedRevision: remarked.revision,
        registered: true,
      });
      expect(registered.registered).toBe(true);
      expect(registered.displayName).toBe('系统盘');

      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, dir!.id);
      const listed = await service.listVisible(userId, serverId);
      expect(listed.find((pool) => pool.id === dir!.id)?.source).toBeNull();
      const got = await service.getVisible(dir!.id, userId, serverId);
      expect(got.source).toBeNull();

      client.listStoragePools.mockResolvedValue({
        metadata: [
          { name: 'dir-a', driver: 'dir', config: { source: '/data1/moved' } },
          { name: 'dir-bad', driver: 'dir', config: { source: '/bad\npath' } },
        ],
      });
      const discoveredAgain = await service.discover(ACTOR_ID, serverId);
      const moved = discoveredAgain.pools.find((pool) => pool.incusName === 'dir-a');
      expect(moved?.source).toBe('/data1/moved');
      expect(moved?.displayName).toBe('系统盘');
      expect(moved?.registered).toBe(true);
    });
  });
});
