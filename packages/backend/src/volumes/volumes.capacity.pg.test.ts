import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ContainerPowerIntent,
  FailureCode,
  IntentKind,
  IntentResourceType,
} from '@nyabase/common';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { IntentRepository } from '../runtime/intent.repository.js';
import { VolumeReconciler } from '../runtime/volume-reconciler.service.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { ContainerActionPolicyService } from '../containers/container-action-policy.service.js';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { ContainerControlService } from '../containers/container-control.service.js';
import { IpPoolsRepository } from '../ip-pools/ip-pools.repository.js';
import { StoragePoolsService } from '../storage-pools/storage-pools.service.js';
import { ContainerSshConvergenceService } from '../ssh/container-ssh-convergence.service.js';
import { VolumesRepository } from './volumes.repository.js';
import { VolumesService } from './volumes.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string) {
  return {
    id,
    name: 'volume-test-server',
    slug: `volume-test-${id.slice(0, 8)}`,
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

function userValues(id: string) {
  return {
    id,
    numeric_id: 1,
    username: `volume-${id.slice(0, 8)}`,
    password_hash: 'test-password-hash',
    display_name: 'Volume Test User',
    status: 'active' as const,
    auth_version: 0,
    authz_version: 0,
  };
}

async function insertLocalPool(database: any, serverId: string, totalBytes = 1000) {
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

function makeService(database: any) {
  return new VolumesService(
    new VolumesRepository(database),
    new StoragePoolsRepository(database),
    new PgTransactionManager(database),
    new IntentRepository(database),
    { wake: vi.fn() } as never,
    database,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
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
        cpu_millis: null,
        mem_bytes: null,
        disk_bytes: 0,
        gpu_mode: 'none',
        gpu_pci_addresses: [],
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
          generation: 1,
          observed_generation: 1,
          lifecycle_phase: 'active',
          needs_attention: false,
          failure_code: null,
        },
        {
          id: sharedVolumeId,
          owner_id: userId,
          pool_id: sharedPoolId,
          server_id: null,
          shared_backend_id: backendId,
          name: 'shared-capacity',
          incus_name: `nyv-${sharedVolumeId.replaceAll('-', '')}`,
          size_bytes: 900,
          used_bytes: 10,
          generation: 1,
          observed_generation: 1,
          lifecycle_phase: 'active',
          needs_attention: false,
          failure_code: null,
        },
      ]).execute();

      const capacity = await makeService(database).capacityForUser(userId, serverId);
      expect(capacity.usedByLocalVolumesBytes).toBe(100);
      expect(capacity.usedByRootDisksBytes).toBe(0);
      expect(capacity.pools).toHaveLength(1);
      expect(capacity.pools[0]!.poolId).toBe(recreatedLocalPoolId);
      expect(capacity.pools[0]!.committedBytes).toBe(100);

      const intents = new IntentRepository(database);
      const reconciler = new VolumeReconciler(database, intents);
      await reconciler.scan(serverId);
      const first = await intents.list({
        resourceType: 'volume',
        resourceId: localVolumeId,
      });
      await intents.settleForObservedGeneration(
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
      expect(second.items).toHaveLength(1);
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
        cpu_millis: null,
        mem_bytes: null,
        disk_bytes: 0,
        gpu_mode: 'none',
        gpu_pci_addresses: [],
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
      const results = await Promise.allSettled([1, 2].map((index) => service.createForUser(
        userId,
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
        cpu_millis: null,
        mem_bytes: null,
        disk_bytes: 0,
        gpu_mode: 'none',
        gpu_pci_addresses: [],
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
      const existing = await service.createForUser(userId, {
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

      await expect(service.createForUser(userId, {
        name: 'overcommit-new',
        sizeBytes: 100,
        scope: { kind: 'local', serverId, poolId },
      })).rejects.toMatchObject({
        response: { code: FailureCode.StoragePoolExhausted },
      });
      await expect(service.patchForUser(userId, existing.resourceId, {
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
        .select(['size_bytes', 'generation'])
        .where('id', '=', existing.resourceId)
        .executeTakeFirstOrThrow()).toMatchObject({
        size_bytes: '1500',
        generation: 1,
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
        cpu_millis: null,
        mem_bytes: null,
        disk_bytes: 0,
        gpu_mode: 'none',
        gpu_pci_addresses: [],
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
        generation: 1,
        observed_generation: 1,
        lifecycle_phase: 'active' as const,
        needs_attention: false,
        failure_code: null,
      }))).execute();

      const service = makeService(database);
      const results = await Promise.allSettled(volumeIds.map((id) => service.patchForUser(
        userId,
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
        .select(['size_bytes', 'generation'])
        .where('pool_id', '=', poolId)
        .orderBy('id')
        .execute();
      expect(rows.map((row) => Number(row.size_bytes)).sort()).toEqual([400, 600]);
      expect(rows.map((row) => row.generation).sort()).toEqual([1, 2]);
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
        name: 'cross-capacity-image',
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
        generation: 1,
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
        cpu_millis: 10_000,
        mem_bytes: 10_000,
        disk_bytes: 10_000,
        gpu_mode: 'none',
        gpu_pci_addresses: [],
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
      const volumeService = new VolumesService(
        new VolumesRepository(database),
        new StoragePoolsRepository(database),
        transactionManager,
        new IntentRepository(database),
        { wake: vi.fn() } as never,
        database,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
      );
      const containerIntents = new IntentRepository(database);
      const containerWake = { wake: vi.fn() } as never;
      const containerService = new ContainerControlService(
        database,
        transactionManager,
        new ContainerControlRepository(database),
        {
          resolveContainerCreateAccessInTransaction: vi.fn().mockResolvedValue({
            grant: {
              accessPhase: 'live',
              cpuMillis: 10_000,
              memBytes: 10_000,
              diskBytes: 10_000,
              gpu: { mode: 'all', pciAddresses: [] },
            },
            imageAvailable: true,
          }),
          assertActorCapabilitiesInTransaction: vi.fn(),
        } as never,
        containerIntents,
        containerWake,
        {} as never,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
        new ContainerActionPolicyService(),
        new IpPoolsRepository(database),
        { get: vi.fn().mockReturnValue(null) } as never,
        new ContainerSshConvergenceService(
          database,
          containerIntents,
          containerWake,
        ),
      );

      const results = await Promise.allSettled([
        containerService.createForUser(userId, {
          serverId,
          imageId,
          name: 'cross-capacity-container',
          rootSizeBytes: 600,
          cpuMillis: 100,
          memBytes: 100,
          gpuPciAddresses: [],
          powerIntent: ContainerPowerIntent.Stopped,
        }),
        volumeService.createForUser(userId, {
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
      const volumeService = new VolumesService(
        new VolumesRepository(database),
        new StoragePoolsRepository(database),
        transactionManager,
        new IntentRepository(database),
        { wake: vi.fn() } as never,
        database,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
      );
      const storageService = new StoragePoolsService(
        new StoragePoolsRepository(database),
        transactionManager,
        database,
        {} as never,
      );

      const results = await Promise.allSettled([
        volumeService.createForUser(userId, {
          name: 'shared-lock-order-volume',
          sizeBytes: 600,
          scope: { kind: 'shared', sharedBackendId: backendId, poolId },
        }),
        storageService.patch(poolId, {
          expectedRevision: 1,
          registered: true,
          displayName: 'patched-concurrently',
          sharedBackendId: backendId,
        }),
      ]);

      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(retryStates).not.toContain('40P01');
      expect(await database.selectFrom('control.volumes')
        .select('id')
        .where('shared_backend_id', '=', backendId)
        .execute()).toHaveLength(1);
      const patchedPool = await database.selectFrom('infra.storage_pools')
        .select(['display_name', 'revision'])
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      expect(patchedPool).toMatchObject({
        display_name: 'patched-concurrently',
        revision: '2',
      });
    });
  });

  it('createForUser requires server grant; createForAdmin does not', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const adminActorId = randomUUID();
      const serverId = randomUUID();
      await database.insertInto('iam.users').values(userValues(ownerId)).execute();
      await database.insertInto('iam.users').values({
        ...userValues(adminActorId),
        numeric_id: 2,
        username: `admin-${adminActorId.slice(0, 8)}`,
      }).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const poolId = await insertLocalPool(database, serverId);
      const service = makeService(database);

      await expect(service.createForUser(ownerId, {
        name: 'user-no-grant',
        sizeBytes: 100,
        scope: { kind: 'local', serverId, poolId },
      })).rejects.toThrow(/Server storage access is not granted/);

      await expect(service.createForAdmin(adminActorId, {
        ownerId,
        name: 'admin-no-grant',
        sizeBytes: 100,
        scope: { kind: 'local', serverId, poolId },
      })).resolves.toMatchObject({ resourceType: 'volume' });

      const rows = await database.selectFrom('control.volumes')
        .select(['name', 'owner_id'])
        .where('pool_id', '=', poolId)
        .execute();
      expect(rows).toEqual([{ name: 'admin-no-grant', owner_id: ownerId }]);
    });
  });

  it('rejects user create with ownerId', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const serverId = randomUUID();
      await database.insertInto('iam.users').values(userValues(ownerId)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const poolId = await insertLocalPool(database, serverId);
      const service = makeService(database);
      await expect(service.createForUser(ownerId, {
        ownerId,
        name: 'user-owner',
        sizeBytes: 100,
        scope: { kind: 'local', serverId, poolId },
      })).rejects.toMatchObject({
        response: { code: FailureCode.InvalidInput },
      });
    });
  });
});
