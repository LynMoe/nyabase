import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { testActor } from '../iam/actor.test-helper.js';
import {
  days,
  grantPool,
  grantServer,
  seedServer,
  seedUser,
  seedVolume,
} from '../iam/access.pg-test-helper.js';
import {
  ContainerPowerIntent,
  FailureCode,
  IntentKind,
  IntentResourceType,
  Role,
  UserStatus,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { VolumeReconciler } from './volume-reconciler.service.js';
import { VolumeReconcileStore } from './volume-reconcile.store.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { makeContainerControlService } from '../containers/container-services.test-helper.js';
import { IpPoolsRepository } from '../ip-pools/ip-pools.repository.js';
import { SharedBackendExecutorsService } from '../storage-pools/shared-backend-executors.service.js';
import { StoragePoolDiscoveryService } from '../storage-pools/storage-pool-discovery.service.js';
import { ContainerSshConvergenceService } from '../containers/container-ssh.js';
import { VolumesRepository } from './volumes.repository.js';
import { makeVolumeServices } from './volume-services.test-helper.js';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string) {
  return {
    id,
    name: 'volume-test-server',
    slug: `volume-test-${id.slice(0, 8)}`,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: null,
    dns_servers: [],
    status: 'unknown' as const,
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

function userValues(id: string) {
  return {
    id,
    numeric_id: 1,
    username: `volume-${id.slice(0, 8)}`,
    password_hash: 'test-password-hash',
    display_name: 'Volume Test User',
    status: 'active' as const,
    auth_version: 0,
  };
}

async function insertLocalPool(database: Kysely<NyabaseDatabase>, serverId: string, totalBytes = 1000) {
  const poolId = randomUUID();
  await database.insertInto('infra.storage_pools').values({
    id: poolId,
    server_id: serverId,
    incus_name: `local-${poolId.slice(0, 8)}`,
    driver: 'dir',
    resize_family: 'quota_online',
    root_disk_capable: true,
    shareable: false,
    block_filesystem: null,
    shared_backend_id: null,
    total_bytes: totalBytes,
    used_bytes: 0,
    quota_effective: true,
    display_name: null,
    registered: true,
    last_observed_at: new Date(),
    revision: 1,
  }).execute();
  return poolId;
}

function makeService(database: Kysely<NyabaseDatabase>) {
  return makeVolumeServices(
    new VolumesRepository(database),
    new StoragePoolsRepository(database),
    new PgTransactionManager(database),
    new IntentRepository(database, noopWake()),
    database,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
    { get: vi.fn().mockRejectedValue(new Error('Incus is unavailable in this test')), listServerIds: vi.fn() } as never,
  );
}

describePg('volume capacity locking and scope exclusions', () => {
  it('excludes shared volume bytes from server and local-pool capacity', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      const backendId = randomUUID();
      const sharedPoolId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const recreatedLocalPoolId = await insertLocalPool(database, serverId);
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'shared-capacity',
        display_name: null,
        identity_key: `cephfs:ceph/fs-${backendId.slice(0, 8)}/data`,
        ceph_fsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        total_bytes: 2000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      await database.insertInto('infra.storage_pools').values({
        id: sharedPoolId,
        server_id: serverId,
        incus_name: `shared-${sharedPoolId.slice(0, 8)}`,
        driver: 'cephfs',
        resize_family: 'quota_online',
        root_disk_capable: false,
        shareable: true,
        block_filesystem: null,
        shared_backend_id: backendId,
        total_bytes: 2000,
        used_bytes: 0,
        quota_effective: true,
        display_name: null,
        registered: true,
        last_observed_at: new Date(),
        revision: 1,
      }).execute();
      await database.insertInto('iam.server_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        server_id: serverId,
        cpu_cores: null,
        mem_bytes: null,
        disk_bytes: null,
        expires_at: null,
      }).execute();
      await database.insertInto('iam.storage_pool_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        pool_id: recreatedLocalPoolId,
        expires_at: null,
      }).execute();
      await database.insertInto('iam.shared_backend_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        shared_backend_id: backendId,
        limit_bytes: 1000,
        expires_at: null,
      }).execute();
      const localVolumeId = randomUUID();
      const sharedVolumeId = randomUUID();
      await database.insertInto('control.volumes').values([
        {
          id: localVolumeId,
          owner_id: userId,
          pool_id: recreatedLocalPoolId,
          server_id: serverId,
          shared_backend_id: null,
          name: 'local-capacity',
          incus_name: `nyv-${localVolumeId.replaceAll('-', '')}`,
          size_bytes: 100,
          used_bytes: 10,
          revision: 1,
          observed_revision: 1,
          lifecycle_phase: 'active',
          needs_attention: false,
          failure_code: null,
        },
        {
          id: sharedVolumeId,
          owner_id: userId,
          pool_id: null,
          server_id: null,
          shared_backend_id: backendId,
          name: 'shared-capacity',
          incus_name: `nyv-${sharedVolumeId.replaceAll('-', '')}`,
          size_bytes: 900,
          used_bytes: 10,
          revision: 1,
          observed_revision: 1,
          lifecycle_phase: 'active',
          needs_attention: false,
          failure_code: null,
        },
      ]).execute();
      await database.insertInto('control.volume_placements').values([
        {
          volume_id: localVolumeId,
          server_id: serverId,
          pool_id: recreatedLocalPoolId,
          catalog_state: 'present' as const,
          observed_revision: 1,
        },
        {
          volume_id: sharedVolumeId,
          server_id: serverId,
          pool_id: sharedPoolId,
          catalog_state: 'present' as const,
          observed_revision: 1,
        },
      ]).execute();

      const capacity = await makeService(database).capacity(testActor(userId), serverId);
      expect(capacity.usedByLocalVolumesBytes).toBe(100);
      expect(capacity.usedByRootDisksBytes).toBe(0);
      expect(capacity.pools).toHaveLength(1);
      expect(capacity.pools[0]!.poolId).toBe(recreatedLocalPoolId);
      expect(capacity.pools[0]!.committedBytes).toBe(100);

      const intents = new IntentRepository(database, noopWake());
      const reconciler = new VolumeReconciler(new VolumeReconcileStore(database, intents),
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        { get: vi.fn().mockResolvedValue(undefined), listServerIds: vi.fn() } as never,
        { register: vi.fn() } as never,
      );
      await reconciler.scan(serverId);
      const first = await intents.list({
        resourceType: 'volume',
        resourceId: localVolumeId,
      });
      await intents.settleForObservedRevision(
        'volume',
        localVolumeId,
        1,
        { outcome: 'succeeded', placementServerId: serverId },
      );
      await reconciler.scan(serverId);
      const second = await intents.list({
        resourceType: 'volume',
        resourceId: localVolumeId,
      });
      expect(first.items).toHaveLength(1);
      expect(second.items).toHaveLength(2);

      await database.updateTable('control.volumes')
        .set({ pool_id: null })
        .where('id', '=', sharedVolumeId)
        .execute();
      const afterNullPool = await makeService(database).capacity(testActor(userId), serverId);
      expect(afterNullPool.usedByLocalVolumesBytes).toBe(100);
      expect(afterNullPool.pools[0]!.committedBytes).toBe(100);
    });
  });

  it('allows only one concurrent local reservation when the pool has 1000 bytes', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const poolId = await insertLocalPool(database, serverId);
      await database.insertInto('iam.server_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        server_id: serverId,
        cpu_cores: null,
        mem_bytes: null,
        disk_bytes: null,
        expires_at: null,
      }).execute();
      await database.insertInto('iam.storage_pool_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        pool_id: poolId,
        expires_at: null,
      }).execute();
      const service = makeService(database);
      const results = await Promise.allSettled([1, 2].map((index) => service.create(testActor(userId),
        {
          name: `race-${index}`,
          sizeBytes: 600,
          scope: { kind: 'local', serverId, poolId },
        },
      )));

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status === 'rejected') {
        expect(rejected.reason.response.code).toBe(FailureCode.StoragePoolExhausted);
      }
      const rows = await database.selectFrom('control.volumes')
        .select('id')
        .where('pool_id', '=', poolId)
        .execute();
      expect(rows).toHaveLength(1);
      const intents = await database.selectFrom('control.intents')
        .select(['kind', 'resource_type'])
        .where('kind', '=', IntentKind.VolumeEnsure)
        .where('resource_type', '=', IntentResourceType.Volume)
        .execute();
      expect(intents).toHaveLength(1);
    });
  });

  it('keeps existing resources when overcommit is lowered below committed and rejects new growth', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId)).execute();
      await database.insertInto('infra.servers').values({
        ...serverValues(serverId),
        storage_overcommit_ratio: 2,
      }).execute();
      const poolId = await insertLocalPool(database, serverId, 1_000);
      await database.insertInto('iam.server_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        server_id: serverId,
        cpu_cores: null,
        mem_bytes: null,
        disk_bytes: null,
        expires_at: null,
      }).execute();
      await database.insertInto('iam.storage_pool_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        pool_id: poolId,
        expires_at: null,
      }).execute();

      const service = makeService(database);
      const existing = await service.create(testActor(userId), {
        name: 'overcommit-existing',
        sizeBytes: 1_500,
        scope: { kind: 'local', serverId, poolId },
      });

      await database.updateTable('infra.servers')
        .set({ storage_overcommit_ratio: 1 })
        .where('id', '=', serverId)
        .execute();

      const retained = await database.selectFrom('control.volumes')
        .select(['id', 'size_bytes', 'lifecycle_phase'])
        .where('id', '=', existing.resourceId)
        .executeTakeFirstOrThrow();
      expect(retained).toMatchObject({
        id: existing.resourceId,
        size_bytes: '1500',
        lifecycle_phase: 'provisioning',
      });

      await expect(service.create(testActor(userId), {
        name: 'overcommit-new',
        sizeBytes: 100,
        scope: { kind: 'local', serverId, poolId },
      })).rejects.toMatchObject({
        response: { code: FailureCode.StoragePoolExhausted },
      });
      await expect(service.patch(testActor(userId), existing.resourceId, {
        expectedRevision: 1,
        sizeBytes: 1_600,
      })).rejects.toMatchObject({
        response: { code: FailureCode.StoragePoolExhausted },
      });

      expect(await database.selectFrom('control.volumes')
        .select('id')
        .where('pool_id', '=', poolId)
        .execute()).toHaveLength(1);
      expect(await database.selectFrom('control.volumes')
        .select(['size_bytes', 'revision'])
        .where('id', '=', existing.resourceId)
        .executeTakeFirstOrThrow()).toMatchObject({
        size_bytes: '1500',
        revision: 1,
      });
    });
  });

  it('serializes concurrent local volume expansions against pool capacity', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const poolId = await insertLocalPool(database, serverId);
      await database.insertInto('iam.server_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        server_id: serverId,
        cpu_cores: null,
        mem_bytes: null,
        disk_bytes: null,
        expires_at: null,
      }).execute();
      await database.insertInto('iam.storage_pool_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        pool_id: poolId,
        expires_at: null,
      }).execute();
      const volumeIds = [randomUUID(), randomUUID()];
      await database.insertInto('control.volumes').values(volumeIds.map((id, index) => ({
        id,
        owner_id: userId,
        pool_id: poolId,
        server_id: serverId,
        shared_backend_id: null,
        name: `expand-${index}`,
        incus_name: `nyv-${id.replaceAll('-', '')}`,
        size_bytes: 400,
        used_bytes: 0,
        revision: 1,
        observed_revision: 1,
        lifecycle_phase: 'active' as const,
        needs_attention: false,
        failure_code: null,
      }))).execute();
      await database.insertInto('control.volume_placements').values(volumeIds.map((id) => ({
        volume_id: id,
        server_id: serverId,
        pool_id: poolId,
        catalog_state: 'present' as const,
        observed_revision: 1,
      }))).execute();

      const service = makeService(database);
      const results = await Promise.allSettled(volumeIds.map((id) => service.patch(testActor(userId),
        id,
        { expectedRevision: 1, sizeBytes: 600 },
      )));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status === 'rejected') {
        expect(rejected.reason.response.code).toBe(FailureCode.StoragePoolExhausted);
      }
      const rows = await database.selectFrom('control.volumes')
        .select(['size_bytes', 'revision'])
        .where('pool_id', '=', poolId)
        .orderBy('id')
        .execute();
      expect(rows.map((row) => Number(row.size_bytes)).sort()).toEqual([400, 600]);
      expect(rows.map((row) => row.revision).sort()).toEqual([1, 2]);
    });
  });

  it('uses server-then-pool locks across concurrent container and volume reservations', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      const imageId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const poolId = await insertLocalPool(database, serverId, 1_000);
      await database.updateTable('infra.servers')
        .set({
          system_pool_id: poolId,
          status: 'online',
          preflight_status: 'passed',
          parent_interface: 'eth0',
        })
        .where('id', '=', serverId)
        .execute();
      const ipPoolId = randomUUID();
      await database.insertInto('infra.ip_pools').values({
        id: ipPoolId,
        name: `capacity-pool-${ipPoolId.slice(0, 8)}`,
        cidr: '10.50.0.0/24',
        allocation_cidr: '10.50.0.0/24',
        gateway: '10.50.0.1',
        reserved_ips: JSON.stringify(['10.50.0.1']),
        revision: 1,
      }).execute();
      await database.insertInto('infra.ip_pool_servers').values({
        pool_id: ipPoolId,
        server_id: serverId,
      }).execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        alias: 'cross-capacity',
        fingerprint: 'a'.repeat(64),
        description: null,
        login_user: 'root',
        min_root_size_bytes: 1,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      await database.insertInto('infra.image_server_assignments').values({
        id: randomUUID(),
        image_id: imageId,
        server_id: serverId,
        revision: 1,
        observed_fingerprint: 'a'.repeat(64),
        managed_fingerprint: 'a'.repeat(64),
        lifecycle_phase: 'active',
        needs_attention: false,
        failure_code: null,
        failure_reason: null,
        last_observed_at: new Date(),
      }).execute();
      await database.insertInto('iam.server_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        server_id: serverId,
        cpu_cores: 10,
        mem_bytes: 10_000,
        disk_bytes: 10_000,
        expires_at: null,
      }).execute();
      await database.insertInto('iam.storage_pool_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        pool_id: poolId,
        expires_at: null,
      }).execute();

      const transactionManager = new PgTransactionManager(database);
      const retryStates: string[] = [];
      const originalRun = transactionManager.run.bind(transactionManager);
      vi.spyOn(transactionManager, 'run').mockImplementation((work, options = {}) =>
        originalRun(work, {
          ...options,
          onRetry: (event) => {
            retryStates.push(event.sqlstate);
            options.onRetry?.(event);
          },
        }));
      const volumeService = makeVolumeServices(
        new VolumesRepository(database),
        new StoragePoolsRepository(database),
        transactionManager,
        new IntentRepository(database, noopWake()),
        database,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
        { get: vi.fn().mockRejectedValue(new Error('Incus is unavailable in this test')), listServerIds: vi.fn() } as never,
      );
      const containerIntents = new IntentRepository(database, noopWake());
      const containerService = makeContainerControlService(
        database,
        transactionManager,
        new ContainerControlRepository(database),
        {
          resolveContainerCreateAccessInTransaction: vi.fn().mockResolvedValue({
            grant: {
              cpuMillis: 10_000,
              memBytes: 10_000,
              diskBytes: 10_000,
              gpuPciAddresses: [],
            },
            imageAvailable: true,
          }),
        } as never,
        containerIntents,
        {} as never,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
        new IpPoolsRepository(database),
        { get: vi.fn().mockReturnValue(null) } as never,
        new ContainerSshConvergenceService(
          database,
          containerIntents,
        ),
        volumeService.attachments,
        new GpuClaimsRepository(database),
      );

      const results = await Promise.allSettled([
        containerService.create(testActor(userId), {
          serverId,
          imageId,
          name: 'cross-capacity-container',
          rootSizeBytes: 600,
          memBytes: 100,
          powerIntent: ContainerPowerIntent.Stopped,
        }),
        volumeService.create(testActor(userId), {
          name: 'cross-capacity-volume',
          sizeBytes: 600,
          scope: { kind: 'local', serverId, poolId },
        }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(retryStates).not.toContain('40P01');
    });
  });

  it('serializes a shared-volume reservation with a storage-pool patch', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      const backendId = randomUUID();
      const poolId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'shared-lock-order',
        display_name: null,
        identity_key: `cephfs:lock-order/${backendId}`,
        ceph_fsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        total_bytes: 1_000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      await database.insertInto('infra.storage_pools').values({
        id: poolId,
        server_id: serverId,
        incus_name: `shared-${poolId.slice(0, 8)}`,
        driver: 'cephfs',
        resize_family: 'quota_online',
        root_disk_capable: false,
        shareable: true,
        block_filesystem: null,
        shared_backend_id: backendId,
        total_bytes: 1_000,
        used_bytes: 0,
        quota_effective: true,
        display_name: null,
        registered: true,
        last_observed_at: new Date(),
        revision: 1,
      }).execute();
      await database.insertInto('iam.shared_backend_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        shared_backend_id: backendId,
        limit_bytes: 1_000,
        expires_at: null,
      }).execute();

      const transactionManager = new PgTransactionManager(database);
      const retryStates: string[] = [];
      const originalRun = transactionManager.run.bind(transactionManager);
      vi.spyOn(transactionManager, 'run').mockImplementation((work, options = {}) =>
        originalRun(work, {
          ...options,
          onRetry: (event) => {
            retryStates.push(event.sqlstate);
            options.onRetry?.(event);
          },
        }));
      const volumeService = makeVolumeServices(
        new VolumesRepository(database),
        new StoragePoolsRepository(database),
        transactionManager,
        new IntentRepository(database, noopWake()),
        database,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
        { get: vi.fn().mockRejectedValue(new Error('Incus is unavailable in this test')), listServerIds: vi.fn() } as never,
      );
      const poolsRepository = new StoragePoolsRepository(database);
      const storageService = new SharedBackendExecutorsService(
        poolsRepository,
        transactionManager,
        new StoragePoolDiscoveryService(poolsRepository, transactionManager, {} as never),
        { append: vi.fn().mockResolvedValue(undefined), log: vi.fn() } as never,
      );

      const results = await Promise.allSettled([
        volumeService.createShared(testActor(userId), {
          name: 'shared-lock-order-volume',
          sizeBytes: 600,
          scope: { kind: 'shared', sharedBackendId: backendId },
        }),
        storageService.patchExecutor(userId, backendId, poolId, {
          expectedRevision: 1,
          registered: true,
        }),
      ]);

      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(retryStates).not.toContain('40P01');
      expect(await database.selectFrom('control.volumes')
        .select('id')
        .where('shared_backend_id', '=', backendId)
        .execute()).toHaveLength(1);
      const patchedPool = await database.selectFrom('infra.storage_pools')
        .select(['registered', 'revision'])
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      expect(patchedPool).toMatchObject({
        registered: true,
        revision: '2',
      });
    });
  });

  it('create requires server grant', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const serverId = randomUUID();
      await database.insertInto('iam.users').values(userValues(ownerId)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const poolId = await insertLocalPool(database, serverId);
      const service = makeService(database);

      await expect(service.create(testActor(ownerId), {
        name: 'user-no-grant',
        sizeBytes: 100,
        scope: { kind: 'local', serverId, poolId },
      })).rejects.toThrow(/Server storage access is not granted/);

      const rows = await database.selectFrom('control.volumes')
        .select(['name', 'owner_id'])
        .where('pool_id', '=', poolId)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  it('growing a local volume needs the pool grant now; an administrator override does not', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = await seedUser(database);
      const adminId = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const serverId = await seedServer(database);
      const poolId = await insertLocalPool(database, serverId);
      await grantServer(database, { user: ownerId }, serverId);
      // The pool grant lapsed: the owner keeps the server but no longer the pool.
      await grantPool(database, { user: ownerId }, poolId, days(-1));
      const volumeId = await seedVolume(database, { ownerId, poolId, serverId });
      await database.insertInto('control.volume_placements').values({
        volume_id: volumeId,
        server_id: serverId,
        pool_id: poolId,
        catalog_state: 'present',
        observed_revision: 1,
      }).execute();
      const service = makeService(database);

      await expect(service.patch(testActor(ownerId), volumeId, { expectedRevision: 1, sizeBytes: 200 }))
        .rejects.toThrow(/Storage pool access is not granted/);
      expect(await database.selectFrom('control.volumes').select('size_bytes')
        .where('id', '=', volumeId).executeTakeFirstOrThrow()).toMatchObject({ size_bytes: '100' });

      await service.patch(testActor(adminId, Role.Admin), volumeId, { expectedRevision: 1, sizeBytes: 200 }, 'all');
      expect(await database.selectFrom('control.volumes').select('size_bytes')
        .where('id', '=', volumeId).executeTakeFirstOrThrow()).toMatchObject({ size_bytes: '200' });
    });
  });
});

describePg('volume shrink reservations', () => {
  async function reservationOf(database: Kysely<NyabaseDatabase>, volumeId: string) {
    return database.selectFrom('control.volumes')
      .select(['size_bytes', 'shrink_reserved_bytes', 'revision', 'needs_attention'])
      .where('id', '=', volumeId)
      .executeTakeFirstOrThrow();
  }

  it('counts an unverified shrink at the old size, and a revert never exceeds the grant', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await insertLocalPool(database, serverId, 10_000);
      await grantServer(database, { user: ownerId }, serverId, { diskBytes: 1_000 });
      await grantPool(database, { user: ownerId }, poolId);
      const volumeId = await seedVolume(database, { ownerId, poolId, serverId });
      // 1000 bytes, last scanned at 100 used: the floor the API sees is stale.
      await database.updateTable('control.volumes').set({ size_bytes: 1_000, used_bytes: 100 })
        .where('id', '=', volumeId).execute();
      await database.insertInto('control.volume_placements').values({
        volume_id: volumeId,
        server_id: serverId,
        pool_id: poolId,
        catalog_state: 'present',
        observed_revision: 1,
      }).execute();
      const service = makeService(database);
      const store = new VolumeReconcileStore(database, new IntentRepository(database, noopWake()));
      const createRest = (name: string) => service.create(testActor(ownerId), {
        name,
        sizeBytes: 800,
        scope: { kind: 'local', serverId, poolId },
      });

      await service.patch(testActor(ownerId), volumeId, { expectedRevision: 1, sizeBytes: 200 });
      expect(await reservationOf(database, volumeId))
        .toMatchObject({ size_bytes: '200', shrink_reserved_bytes: '1000', revision: 2 });
      // Incus still holds 1000 bytes: the freed 800 is not spendable yet.
      await expect(createRest('rest-1')).rejects.toMatchObject({
        response: { code: FailureCode.StorageGrantExceeded },
      });

      // Growing back within the reservation costs nothing, although the grant is full.
      await service.patch(testActor(ownerId), volumeId, { expectedRevision: 2, sizeBytes: 600 });
      expect(await reservationOf(database, volumeId))
        .toMatchObject({ size_bytes: '600', shrink_reserved_bytes: '1000', revision: 3 });

      // The worker found revision 2's shrink below usage, but revision 3 replaced it.
      expect(await store.revertImpossibleShrink(
        { id: volumeId, revision: 2 },
        1_000n,
        900n,
        'VOLUME_SHRINK_BELOW_USAGE',
      )).toBe(false);
      expect(await reservationOf(database, volumeId))
        .toMatchObject({ size_bytes: '600', shrink_reserved_bytes: '1000', needs_attention: false });

      // Reverting the current revision restores what Incus holds, within the reservation.
      expect(await store.revertImpossibleShrink(
        { id: volumeId, revision: 3 },
        1_000n,
        900n,
        'VOLUME_SHRINK_BELOW_USAGE',
      )).toBe(true);
      expect(await reservationOf(database, volumeId))
        .toMatchObject({ size_bytes: '1000', shrink_reserved_bytes: null, needs_attention: true });
      await expect(createRest('rest-2')).rejects.toMatchObject({
        response: { code: FailureCode.StorageGrantExceeded },
      });

      // Once a shrink is verified the space is free.
      await database.updateTable('control.volumes').set({ used_bytes: 100, needs_attention: false })
        .where('id', '=', volumeId).execute();
      await service.patch(testActor(ownerId), volumeId, { expectedRevision: 3, sizeBytes: 200 });
      await store.recordVerified((await store.readVolume(volumeId, serverId))!, 100n);
      expect(await reservationOf(database, volumeId))
        .toMatchObject({ size_bytes: '200', shrink_reserved_bytes: null });
      await expect(createRest('rest-3')).resolves.toMatchObject({ resourceId: expect.any(String) });

      // Incus holding more than the row ever committed never grows the row:
      // the volume is only parked.
      await database.updateTable('control.volumes').set({ revision: 5 }).where('id', '=', volumeId).execute();
      expect(await store.revertImpossibleShrink(
        { id: volumeId, revision: 5 },
        900n,
        800n,
        'VOLUME_SHRINK_BELOW_USAGE',
      )).toBe(true);
      expect(await reservationOf(database, volumeId))
        .toMatchObject({ size_bytes: '200', shrink_reserved_bytes: null });
    });
  });
});
