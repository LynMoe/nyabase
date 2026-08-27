import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { VolumesRepository } from '../volumes/volumes.repository.js';
import { VolumesService } from '../volumes/volumes.service.js';
import { IntentRepository } from './intent.repository.js';
import { VolumeReconciler } from './volume-reconciler.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string, suffix: string) {
  return {
    id,
    name: `vol-rec-${suffix}`,
    slug: `vol-rec-${suffix}`,
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

describePg('volume reconciler placements', () => {
  it('does not RemoveAll home while a peer catalog still reports used_by', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const homeServer = randomUUID();
      const peerServer = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('iam.users').values({
        id: ownerId,
        numeric_id: 1,
        username: `vol-${ownerId.slice(0, 8)}`,
        password_hash: 'x',
        display_name: 'v',
        status: 'active',
        auth_version: 0,
        authz_version: 0,
      }).execute();
      await database.insertInto('infra.servers').values([
        serverValues(homeServer, 'home'),
        serverValues(peerServer, 'peer'),
      ]).execute();
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'ceph',
        display_name: null,
        identity_key: `cephfs:ceph/${backendId}/data`,
        ceph_fsid: randomUUID(),
        total_bytes: 1000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      const homePool = randomUUID();
      const peerPool = randomUUID();
      await database.insertInto('infra.storage_pools').values([
        {
          id: homePool,
          server_id: homeServer,
          incus_name: 'cephfs-home',
          driver: 'cephfs',
          resize_family: 'quota_online',
          root_disk_capable: false,
          shareable: true,
          block_filesystem: null,
          shared_backend_id: backendId,
          total_bytes: 1000,
          used_bytes: 0,
          quota_effective: true,
          display_name: null,
          registered: true,
          last_observed_at: new Date(),
          revision: 1,
        },
        {
          id: peerPool,
          server_id: peerServer,
          incus_name: 'cephfs-peer',
          driver: 'cephfs',
          resize_family: 'quota_online',
          root_disk_capable: false,
          shareable: true,
          block_filesystem: null,
          shared_backend_id: backendId,
          total_bytes: 1000,
          used_bytes: 0,
          quota_effective: true,
          display_name: null,
          registered: true,
          last_observed_at: new Date(),
          revision: 1,
        },
      ]).execute();
      const volumeId = randomUUID();
      await database.insertInto('control.volumes').values({
        id: volumeId,
        owner_id: ownerId,
        pool_id: homePool,
        server_id: null,
        shared_backend_id: backendId,
        name: 'shared',
        incus_name: `nyv-${volumeId.replaceAll('-', '')}`,
        size_bytes: 100,
        used_bytes: 0,
        generation: 2,
        observed_generation: 1,
        lifecycle_phase: 'deleting',
        needs_attention: false,
        failure_code: null,
      }).execute();
      await database.insertInto('control.volume_placements').values([
        {
          volume_id: volumeId,
          server_id: homeServer,
          pool_id: homePool,
          desired_present: false,
          observed_present: true,
          unused_confirmed_at: new Date(),
        },
        {
          volume_id: volumeId,
          server_id: peerServer,
          pool_id: peerPool,
          desired_present: false,
          observed_present: true,
          unused_confirmed_at: new Date(),
        },
      ]).execute();
      const homeDelete = vi.fn();
      const clients = {
        get: vi.fn(async (serverId: string) => ({
          getStorageVolume: vi.fn(async () => ({
            metadata: {
              used_by: serverId === peerServer ? ['/1.0/instances/x'] : [],
            },
          })),
        })),
      };
      const reconciler = new VolumeReconciler(
        database,
        new IntentRepository(database),
        undefined,
        clients as never,
      );
      const outcome = await reconciler.reconcile({
        intent: {
          id: randomUUID(),
          kind: 'volume.ensure',
          resourceType: 'volume',
          resourceId: volumeId,
          serverId: homeServer,
          request: { operation: 'delete' },
          attemptCount: 0,
        } as never,
        client: {
          getStorageVolume: vi.fn().mockResolvedValue({ metadata: { used_by: [] } }),
          deleteStorageVolume: homeDelete,
        } as never,
        claim: {} as never,
        lease: {} as never,
        signal: new AbortController().signal,
      });
      expect(outcome).toMatchObject({
        outcome: 'retry',
        failure: { code: 'VOLUME_REQUIRES_DETACH' },
      });
      expect(homeDelete).not.toHaveBeenCalled();
      expect(await database.selectFrom('control.volumes').select('id').where('id', '=', volumeId).execute()).toHaveLength(1);
      expect(await database.selectFrom('control.volume_placements').select('server_id').where('volume_id', '=', volumeId).execute()).toHaveLength(2);
    });
  });

  it('deletes the volume row immediately when deleteVolume sees zero placements', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const serverId = randomUUID();
      await database.insertInto('iam.users').values({
        id: ownerId,
        numeric_id: 2,
        username: `vol2-${ownerId.slice(0, 8)}`,
        password_hash: 'x',
        display_name: 'v',
        status: 'active',
        auth_version: 0,
        authz_version: 0,
      }).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'solo')).execute();
      const poolId = randomUUID();
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
        total_bytes: 1000,
        used_bytes: 0,
        quota_effective: true,
        display_name: null,
        registered: true,
        last_observed_at: new Date(),
        revision: 1,
      }).execute();
      const volumeId = randomUUID();
      await database.insertInto('control.volumes').values({
        id: volumeId,
        owner_id: ownerId,
        pool_id: poolId,
        server_id: serverId,
        shared_backend_id: null,
        name: 'empty',
        incus_name: `nyv-${volumeId.replaceAll('-', '')}`,
        size_bytes: 100,
        used_bytes: 0,
        generation: 1,
        observed_generation: 1,
        lifecycle_phase: 'active',
        needs_attention: false,
        failure_code: null,
      }).execute();
      const service = new VolumesService(
        new VolumesRepository(database),
        new StoragePoolsRepository(database),
        new PgTransactionManager(database),
        new IntentRepository(database),
        { wake: vi.fn() } as never,
        database,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
      );
      const accepted = await service.deleteForUser(ownerId, volumeId);
      expect(await database.selectFrom('control.volumes').select('id').where('id', '=', volumeId).execute()).toHaveLength(0);
      const intent = await database.selectFrom('control.intents')
        .select(['id', 'status', 'kind', 'resource_id'])
        .where('id', '=', accepted.intentId)
        .executeTakeFirstOrThrow();
      expect(intent).toMatchObject({
        status: 'succeeded',
        kind: 'volume.ensure',
        resource_id: volumeId,
      });
    });
  });
});
