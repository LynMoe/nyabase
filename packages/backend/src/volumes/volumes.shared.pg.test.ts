import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FailureCode } from '@nyabase/common';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { IntentRepository } from '../runtime/intent.repository.js';
import type { IncusClientFactory } from '../runtime/reconcile-worker.service.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { VolumesRepository } from './volumes.repository.js';
import { VolumesService } from './volumes.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string, status: 'online' | 'unknown' = 'unknown') {
  return {
    id,
    name: `shared-vol-${id.slice(0, 8)}`,
    slug: `shared-vol-${id.slice(0, 8)}`,
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

function userValues(id: string, numericId = 1) {
  return {
    id,
    numeric_id: numericId,
    username: `shared-${id.slice(0, 8)}`,
    password_hash: 'test-password-hash',
    display_name: 'Shared Volume User',
    status: 'active' as const,
    auth_version: 0,
    authz_version: 0,
  };
}

function makeService(database: any, clients?: IncusClientFactory) {
  return new VolumesService(
    new VolumesRepository(database),
    new StoragePoolsRepository(database),
    new PgTransactionManager(database),
    new IntentRepository(database),
    { wake: vi.fn() } as never,
    database,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
    undefined,
    clients,
  );
}

async function seedSharedBackend(
  database: any,
  options?: {
    quotaEffective?: boolean;
    grantLimit?: number | null;
    expiresAt?: Date | null;
    serverStatus?: 'online' | 'unknown';
  },
) {
  const userId = randomUUID();
  const serverId = randomUUID();
  const backendId = randomUUID();
  const poolId = randomUUID();
  await database.insertInto('iam.users').values(userValues(userId)).execute();
  await database.insertInto('infra.servers').values(serverValues(serverId, options?.serverStatus)).execute();
  await database.insertInto('infra.shared_backends').values({
    id: backendId,
    name: 'shared-quota',
    display_name: 'Shared Quota',
    identity_key: `cephfs:ceph/${backendId}/data`,
    ceph_fsid: randomUUID(),
    total_bytes: 10_000,
    used_bytes: 0,
    overcommit_ratio: 1,
    revision: 1,
  }).execute();
  await database.insertInto('infra.storage_pools').values({
    id: poolId,
    server_id: serverId,
    incus_name: `cephfs-${poolId.slice(0, 8)}`,
    driver: 'cephfs',
    resize_family: 'quota_online',
    root_disk_capable: false,
    shareable: true,
    block_filesystem: null,
    shared_backend_id: backendId,
    total_bytes: 10_000,
    used_bytes: 0,
    quota_effective: options?.quotaEffective ?? true,
    display_name: null,
    registered: true,
    last_observed_at: new Date(),
    revision: 1,
  }).execute();
  if (options?.grantLimit !== null) {
    await database.insertInto('iam.shared_backend_grants').values({
      id: randomUUID(),
      user_id: userId,
      group_id: null,
      shared_backend_id: backendId,
      limit_bytes: options?.grantLimit ?? 0,
      expires_at: options?.expiresAt ?? null,
    }).execute();
  }
  return { userId, serverId, backendId, poolId };
}

describePg('shared volume quota reservations', () => {
  it('creates a shared volume without pool_id, placement, or volume.ensure', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, backendId } = await seedSharedBackend(database);
      const service = makeService(database);
      const created = await service.createSharedForUser(userId, {
        name: 'quota-only',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      expect(created).toMatchObject({
        name: 'quota-only',
        sharedBackendId: backendId,
        sizeBytes: 100,
        lifecyclePhase: 'active',
        dirEnsured: false,
        usedBytes: null,
      });
      const row = await database.selectFrom('control.volumes')
        .select(['pool_id', 'server_id', 'shared_backend_id', 'lifecycle_phase', 'dir_ensured'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        pool_id: null,
        server_id: null,
        shared_backend_id: backendId,
        lifecycle_phase: 'active',
        dir_ensured: false,
      });
      expect(await database.selectFrom('control.volume_placements')
        .select('volume_id')
        .where('volume_id', '=', created.id)
        .execute()).toHaveLength(0);
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', created.id)
        .execute()).toHaveLength(0);
    });
  });

  it('keeps local list/get from returning shared volumes', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, backendId } = await seedSharedBackend(database);
      const service = makeService(database);
      const created = await service.createSharedForUser(userId, {
        name: 'hidden-from-local',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      expect(await service.listForUser(userId)).toEqual([]);
      await expect(service.getForUser(created.id, userId)).rejects.toMatchObject({
        message: 'Volume not found',
      });
      await expect(service.getForAdmin(created.id)).rejects.toMatchObject({
        message: 'Volume not found',
      });
      const listed = await service.listSharedForUser(userId);
      expect(listed.map((row) => row.id)).toEqual([created.id]);
      await expect(service.getSharedForUser(created.id, userId)).resolves.toMatchObject({
        id: created.id,
        dirEnsured: false,
      });
    });
  });

  it('deletes a never-mounted shared volume in Postgres without an Incus intent', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, backendId } = await seedSharedBackend(database);
      const service = makeService(database);
      const created = await service.createSharedForUser(userId, {
        name: 'never-mounted',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      await service.deleteSharedForUser(userId, created.id);
      expect(await database.selectFrom('control.volumes')
        .select('id')
        .where('id', '=', created.id)
        .execute()).toHaveLength(0);
      const destroy = await database.selectFrom('control.intents')
        .select(['kind', 'status'])
        .where('resource_id', '=', created.id)
        .execute();
      expect(destroy.every((row) => row.status !== 'pending')).toBe(true);
    });
  });

  it('resizes a never-mounted shared volume in Postgres without an intent', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, backendId } = await seedSharedBackend(database);
      const service = makeService(database);
      const created = await service.createSharedForUser(userId, {
        name: 'resize-me',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      const patched = await service.patchSharedForUser(userId, created.id, {
        expectedRevision: created.generation,
        sizeBytes: 200,
      });
      expect('intentId' in patched).toBe(false);
      expect(patched).toMatchObject({ id: created.id, sizeBytes: 200 });
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', created.id)
        .execute()).toHaveLength(0);
    });
  });

  it('requires a live shared-backend grant to create and ignores disk_bytes-only grants', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      const backendId = randomUUID();
      const localPoolId = randomUUID();
      const sharedPoolId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'grant-split',
        display_name: null,
        identity_key: `cephfs:ceph/${backendId}/data`,
        ceph_fsid: randomUUID(),
        total_bytes: 10_000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      await database.insertInto('infra.storage_pools').values([
        {
          id: localPoolId,
          server_id: serverId,
          incus_name: `local-${localPoolId.slice(0, 8)}`,
          driver: 'dir',
          resize_family: 'quota_online',
          root_disk_capable: true,
          shareable: false,
          block_filesystem: null,
          shared_backend_id: null,
          total_bytes: 10_000,
          used_bytes: 0,
          quota_effective: true,
          display_name: null,
          registered: true,
          last_observed_at: new Date(),
          revision: 1,
        },
        {
          id: sharedPoolId,
          server_id: serverId,
          incus_name: `cephfs-${sharedPoolId.slice(0, 8)}`,
          driver: 'cephfs',
          resize_family: 'quota_online',
          root_disk_capable: false,
          shareable: true,
          block_filesystem: null,
          shared_backend_id: backendId,
          total_bytes: 10_000,
          used_bytes: 0,
          quota_effective: true,
          display_name: null,
          registered: true,
          last_observed_at: new Date(),
          revision: 1,
        },
      ]).execute();
      await database.insertInto('iam.server_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        server_id: serverId,
        cpu_millis: null,
        mem_bytes: null,
        disk_bytes: 5_000,
        extension_grants: {},
        expires_at: null,
      }).execute();
      await database.insertInto('iam.storage_pool_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        pool_id: localPoolId,
        expires_at: null,
      }).execute();
      const service = makeService(database);
      await expect(service.createSharedForUser(userId, {
        name: 'no-backend-grant',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      })).rejects.toThrow(/Shared backend access is not granted/);

      await database.insertInto('iam.shared_backend_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        shared_backend_id: backendId,
        limit_bytes: 1_000,
        expires_at: null,
      }).execute();
      await expect(service.createSharedForUser(userId, {
        name: 'with-backend-grant',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      })).resolves.toMatchObject({ name: 'with-backend-grant', dirEnsured: false });
    });
  });

  it('lets the owner get and delete a never-mounted reservation after grant expiry', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, backendId } = await seedSharedBackend(database);
      const service = makeService(database);
      const created = await service.createSharedForUser(userId, {
        name: 'expired-grant',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      await database.updateTable('iam.shared_backend_grants')
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where('shared_backend_id', '=', backendId)
        .execute();
      await expect(service.getSharedForUser(created.id, userId)).resolves.toMatchObject({
        id: created.id,
      });
      await expect(service.patchSharedForUser(userId, created.id, {
        expectedRevision: created.generation,
        sizeBytes: 200,
      })).rejects.toThrow(/Shared backend access is not granted/);
      await service.deleteSharedForUser(userId, created.id);
      expect(await database.selectFrom('control.volumes')
        .select('id')
        .where('id', '=', created.id)
        .execute()).toHaveLength(0);
    });
  });

  it('rejects user create when the shared backend is missing', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      await database.insertInto('iam.users').values(userValues(ownerId)).execute();
      const service = makeService(database);
      await expect(service.createSharedForUser(ownerId, {
        name: 'missing-backend',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: randomUUID() },
      })).rejects.toThrow(/Shared backend access is not granted/);
    });
  });

  it('keeps the no-pool 409 when the backend exists without a registered CephFS pool', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('iam.users').values(userValues(ownerId)).execute();
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'empty-backend',
        display_name: null,
        identity_key: `cephfs:ceph/${backendId}/data`,
        ceph_fsid: randomUUID(),
        total_bytes: 10_000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      await database.insertInto('iam.shared_backend_grants').values({
        id: randomUUID(),
        user_id: ownerId,
        group_id: null,
        shared_backend_id: backendId,
        limit_bytes: 0,
        expires_at: null,
      }).execute();
      const service = makeService(database);
      await expect(service.createSharedForUser(ownerId, {
        name: 'no-pool',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      })).rejects.toMatchObject({
        response: {
          code: 'INVALID_INPUT',
          message: '该共享后端尚未在任何服务器上登记可写配额的 CephFS 池',
          details: { sharedBackendId: backendId },
        },
      });
    });
  });

  it('rejects never-mounted shared shrink as unknown without calling Incus', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const getStorageVolumeState = vi.fn();
      const getStorageVolume = vi.fn();
      const { userId, backendId } = await seedSharedBackend(database);
      const service = makeService(database, {
        get: vi.fn(async () => ({ getStorageVolumeState, getStorageVolume })),
      } as never);
      const created = await service.createSharedForUser(userId, {
        name: 'never-mounted-shrink',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      await expect(service.patchSharedForUser(userId, created.id, {
        expectedRevision: created.generation,
        sizeBytes: 50,
      })).rejects.toMatchObject({
        response: { code: FailureCode.VolumeUsageUnknown },
      });
      const grown = await service.patchSharedForUser(userId, created.id, {
        expectedRevision: created.generation,
        sizeBytes: 200,
      });
      expect('intentId' in grown).toBe(false);
      expect(grown).toMatchObject({ id: created.id, sizeBytes: 200, dirEnsured: false });
      expect(getStorageVolumeState).not.toHaveBeenCalled();
      expect(getStorageVolume).not.toHaveBeenCalled();
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', created.id)
        .execute()).toHaveLength(0);
    });
  });

  it('persists NULL and 409s unknown on a phantom CephFS live-GET', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const getStorageVolumeState = vi.fn().mockResolvedValue({
        metadata: { usage: { used: 100, total: 0 } },
      });
      const getStorageVolume = vi.fn();
      const { userId, serverId, backendId, poolId } = await seedSharedBackend(database, {
        serverStatus: 'online',
      });
      const service = makeService(database, {
        get: vi.fn(async () => ({ getStorageVolumeState, getStorageVolume })),
      } as never);
      const created = await service.createSharedForUser(userId, {
        name: 'phantom-shrink',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      await database.updateTable('control.volumes')
        .set({ dir_ensured: true, used_bytes: 0 })
        .where('id', '=', created.id)
        .execute();
      await database.insertInto('control.volume_placements').values({
        volume_id: created.id,
        server_id: serverId,
        pool_id: poolId,
        catalog_state: 'present',
        observed_generation: 1,
      }).execute();
      await expect(service.patchSharedForUser(userId, created.id, {
        expectedRevision: created.generation,
        sizeBytes: 50,
      })).rejects.toMatchObject({
        response: { code: FailureCode.VolumeUsageUnknown },
      });
      const row = await database.selectFrom('control.volumes')
        .select(['used_bytes', 'size_bytes', 'dir_ensured'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(row.used_bytes).toBeNull();
      expect(Number(row.size_bytes)).toBe(100);
      expect(row.dir_ensured).toBe(true);
      expect(getStorageVolume).not.toHaveBeenCalled();
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', created.id)
        .execute()).toHaveLength(0);
    });
  });

  it('persists live used and 409s below-usage without an intent', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const getStorageVolumeState = vi.fn().mockResolvedValue({
        metadata: { usage: { used: 80, total: 100 } },
      });
      const { userId, serverId, backendId, poolId } = await seedSharedBackend(database, {
        serverStatus: 'online',
      });
      const service = makeService(database, {
        get: vi.fn(async () => ({ getStorageVolumeState })),
      } as never);
      const created = await service.createSharedForUser(userId, {
        name: 'below-usage',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      await database.updateTable('control.volumes')
        .set({ dir_ensured: true, used_bytes: 0 })
        .where('id', '=', created.id)
        .execute();
      await database.insertInto('control.volume_placements').values({
        volume_id: created.id,
        server_id: serverId,
        pool_id: poolId,
        catalog_state: 'ensuring',
        observed_generation: null,
      }).execute();
      await expect(service.patchSharedForUser(userId, created.id, {
        expectedRevision: created.generation,
        sizeBytes: 50,
      })).rejects.toMatchObject({
        response: { code: FailureCode.VolumeShrinkBelowUsage },
      });
      const row = await database.selectFrom('control.volumes')
        .select('used_bytes')
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(Number(row.used_bytes)).toBe(80);
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', created.id)
        .execute()).toHaveLength(0);
    });
  });

  it('creates volume.resize when live used is below the requested size', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const getStorageVolumeState = vi.fn().mockResolvedValue({
        metadata: { usage: { used: 40, total: 0 } },
      });
      const { userId, serverId, backendId, poolId } = await seedSharedBackend(database, {
        serverStatus: 'online',
      });
      const service = makeService(database, {
        get: vi.fn(async () => ({ getStorageVolumeState })),
      } as never);
      const created = await service.createSharedForUser(userId, {
        name: 'trusted-used',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      await database.updateTable('control.volumes')
        .set({ dir_ensured: true, used_bytes: 0 })
        .where('id', '=', created.id)
        .execute();
      await database.insertInto('control.volume_placements').values({
        volume_id: created.id,
        server_id: serverId,
        pool_id: poolId,
        catalog_state: 'present',
        observed_generation: 1,
      }).execute();
      const patched = await service.patchSharedForUser(userId, created.id, {
        expectedRevision: created.generation,
        sizeBytes: 50,
      });
      expect('intentId' in patched).toBe(true);
      const row = await database.selectFrom('control.volumes')
        .select(['used_bytes', 'size_bytes'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(Number(row.used_bytes)).toBe(40);
      expect(Number(row.size_bytes)).toBe(50);
      const intents = await database.selectFrom('control.intents')
        .select(['kind', 'status'])
        .where('resource_id', '=', created.id)
        .execute();
      expect(intents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'volume.resize', status: 'pending' }),
      ]));
    });
  });

  it('does not rewrite seeded used_bytes when live-GET fails', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const getStorageVolumeState = vi.fn().mockRejectedValue(new Error('incus down'));
      const { userId, serverId, backendId, poolId } = await seedSharedBackend(database, {
        serverStatus: 'online',
      });
      const service = makeService(database, {
        get: vi.fn(async () => ({ getStorageVolumeState })),
      } as never);
      const created = await service.createSharedForUser(userId, {
        name: 'get-fail',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      await database.updateTable('control.volumes')
        .set({ dir_ensured: true, used_bytes: 0 })
        .where('id', '=', created.id)
        .execute();
      await database.insertInto('control.volume_placements').values({
        volume_id: created.id,
        server_id: serverId,
        pool_id: poolId,
        catalog_state: 'present',
        observed_generation: 1,
      }).execute();
      await expect(service.patchSharedForUser(userId, created.id, {
        expectedRevision: created.generation,
        sizeBytes: 50,
      })).rejects.toMatchObject({
        response: { code: FailureCode.VolumeUsageUnknown },
      });
      const row = await database.selectFrom('control.volumes')
        .select('used_bytes')
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(Number(row.used_bytes)).toBe(0);
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', created.id)
        .execute()).toHaveLength(0);
    });
  });

  it('does not rewrite seeded used_bytes when the Incus factory is missing', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, serverId, backendId, poolId } = await seedSharedBackend(database, {
        serverStatus: 'online',
      });
      const service = makeService(database);
      const created = await service.createSharedForUser(userId, {
        name: 'no-factory',
        sizeBytes: 100,
        scope: { kind: 'shared', sharedBackendId: backendId },
      });
      await database.updateTable('control.volumes')
        .set({ dir_ensured: true, used_bytes: 0 })
        .where('id', '=', created.id)
        .execute();
      await database.insertInto('control.volume_placements').values({
        volume_id: created.id,
        server_id: serverId,
        pool_id: poolId,
        catalog_state: 'present',
        observed_generation: 1,
      }).execute();
      await expect(service.patchSharedForUser(userId, created.id, {
        expectedRevision: created.generation,
        sizeBytes: 50,
      })).rejects.toMatchObject({
        response: { code: FailureCode.VolumeUsageUnknown },
      });
      const row = await database.selectFrom('control.volumes')
        .select('used_bytes')
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(Number(row.used_bytes)).toBe(0);
    });
  });
});
