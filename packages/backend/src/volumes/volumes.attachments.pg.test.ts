import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { testActor } from '../iam/actor.test-helper.js';
import { FailureCode, Role } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { VolumesRepository } from './volumes.repository.js';
import { makeVolumeServices } from './volume-services.test-helper.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';
import { ensureServerGrant, grantPool } from '../iam/access.pg-test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(id: string, suffix: string) {
  return {
    id,
    name: `attachment-test-${suffix}`,
    slug: `attachment-test-${suffix}`,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: null,
    dns_servers: [],
    status: 'online' as const,
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

function userValues(id: string, numericId: number) {
  return {
    id,
    numeric_id: numericId,
    username: `attach-${id.slice(0, 8)}`,
    password_hash: 'test-password-hash',
    display_name: 'Attachment Test User',
    status: 'active' as const,
    auth_version: 0,
  };
}

async function insertPool(database: Kysely<NyabaseDatabase>, serverId: string, name: string) {
  const id = randomUUID();
  await database.insertInto('infra.storage_pools').values({
    id,
    server_id: serverId,
    incus_name: name,
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
  return id;
}

async function insertContainer(
  database: Kysely<NyabaseDatabase>,
  ownerId: string,
  serverId: string,
  poolId: string,
  imageId: string,
  name: string,
) {
  const id = randomUUID();
  // Attaching needs current coverage of the container's server (and the volume's pool).
  await ensureServerGrant(database, ownerId, serverId);
  await database.insertInto('control.containers').values({
    id,
    server_id: serverId,
    owner_id: ownerId,
    image_id: imageId,
    created_by: ownerId,
    name,
    revision: 1,
    observed_revision: null,
    image_alias: 'base',
    image_fingerprint: 'a'.repeat(64),
    root_pool_id: poolId,
    root_size_bytes: 100,
    root_size_pending_bytes: null,
    mem_bytes: 1_073_741_824,
    nesting: true,
    syscall_intercept: true,
    power_intent: 'stopped',
    lifecycle_phase: 'active',
    instance_name: null,
    needs_attention: false,
    failure_code: null,
    failure_reason: null,
  }).execute();
  return id;
}

async function insertVolume(
  database: Kysely<NyabaseDatabase>,
  ownerId: string,
  poolId: string | null,
  serverId: string | null,
  sharedBackendId: string | null,
  name: string,
) {
  const id = randomUUID();
  if (poolId && !sharedBackendId) {
    const pool = await database.selectFrom('infra.storage_pools').select('server_id')
      .where('id', '=', poolId).executeTakeFirstOrThrow();
    await ensureServerGrant(database, ownerId, pool.server_id);
    const granted = await database.selectFrom('iam.storage_pool_grants').select('id')
      .where('user_id', '=', ownerId).where('pool_id', '=', poolId).executeTakeFirst();
    if (!granted) await grantPool(database, { user: ownerId }, poolId);
  }
  await database.insertInto('control.volumes').values({
    id,
    owner_id: ownerId,
    pool_id: sharedBackendId ? null : poolId,
    server_id: serverId,
    shared_backend_id: sharedBackendId,
    name,
    incus_name: `nyv-${id.replaceAll('-', '')}`,
    size_bytes: 100,
    used_bytes: 0,
    revision: 1,
    observed_revision: 1,
    lifecycle_phase: 'active',
    needs_attention: false,
    failure_code: null,
  }).execute();
  return id;
}

async function insertStoppedRoute(database: Kysely<NyabaseDatabase>, containerId: string, serverId: string) {
  await database.insertInto('control.container_ssh_routes').values({
    container_id: containerId,
    server_id: serverId,
    instance_name: `nyc-${containerId.replaceAll('-', '')}`,
    routed_ip: '10.0.0.8',
    instance_status: 'Stopped',
    instance_started_at: null,
    ssh_status: 'container_stopped',
    last_error: null,
    observed_at: new Date(),
  }).execute();
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

describePg('volume attachment ownership, visibility, and drain guards', () => {
  it('blocks delete while attached and enforces the 360-second detach drain', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      const imageId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId, 1)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'one')).execute();
      const poolId = await insertPool(database, serverId, `pool-${serverId.slice(0, 8)}`);
      await database.insertInto('infra.images').values({
        id: imageId,
        alias: 'base',
        fingerprint: null,
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      const containerOne = await insertContainer(
        database,
        userId,
        serverId,
        poolId,
        imageId,
        'container-one',
      );
      const containerTwo = await insertContainer(
        database,
        userId,
        serverId,
        poolId,
        imageId,
        'container-two',
      );
      const volumeId = await insertVolume(database, userId, poolId, serverId, null, 'attached');
      const service = makeService(database);

      await service.attach(testActor(userId), containerOne, {
        volumeId,
        containerPath: '/data',
        readOnly: false,
      }, 'local');
      await expect(service.delete(testActor(userId), volumeId)).rejects.toMatchObject({
        response: expect.objectContaining({ code: FailureCode.VolumeRequiresUnbind }),
      });
      const attachment = await database.selectFrom('control.volume_attachments')
        .selectAll()
        .where('volume_id', '=', volumeId)
        .executeTakeFirstOrThrow();

      await service.detach(testActor(userId), attachment.id, containerOne, 'local');
      const detaching = await database.selectFrom('control.volume_attachments')
        .select(['bind_state', 'container_id'])
        .where('volume_id', '=', volumeId)
        .executeTakeFirstOrThrow();
      expect(detaching.bind_state).toBe('detaching');
      expect(detaching.container_id).toBe(containerOne);

      await expect(service.delete(testActor(userId), volumeId)).rejects.toMatchObject({
        response: expect.objectContaining({ code: FailureCode.VolumeRequiresUnbind }),
      });
      await expect(service.attach(testActor(userId), containerTwo, {
        volumeId,
        containerPath: '/data',
        readOnly: false,
      }, 'local')).resolves.toMatchObject({ intentId: expect.any(String) });
      await expect(service.attach(testActor(userId), containerOne, {
        volumeId,
        containerPath: '/data',
        readOnly: false,
      }, 'local')).rejects.toMatchObject({
        response: expect.objectContaining({ code: FailureCode.InvalidInput }),
      });
    });
  });

  it('lets the container owner or an admin attach, and nobody else', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const otherId = randomUUID();
      const serverId = randomUUID();
      const imageId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId, 1)).execute();
      const adminId = randomUUID();
      await database.insertInto('iam.users').values(userValues(otherId, 2)).execute();
      await database.insertInto('iam.users').values(userValues(adminId, 3)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'one')).execute();
      const poolId = await insertPool(database, serverId, `pool-${serverId.slice(0, 8)}`);
      await database.insertInto('infra.images').values({
        id: imageId,
        alias: 'base',
        fingerprint: null,
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      const container = await insertContainer(database, userId, serverId, poolId, imageId, 'c-authz');
      const volumeId = await insertVolume(database, userId, poolId, serverId, null, 'v-authz');
      const service = makeService(database);
      const input = { volumeId, containerPath: '/data', readOnly: false };

      await expect(service.attach(testActor(otherId), container, input, 'local'))
        .rejects.toMatchObject({ status: 404 });
      // The admin role alone does not reach another user's container; scope=all does.
      await expect(service.attach(testActor(adminId, Role.Admin), container, input, 'local'))
        .rejects.toMatchObject({ status: 404 });
      await expect(service.attach(testActor(otherId), container, input, 'local', 'all'))
        .rejects.toMatchObject({ status: 403 });
      await expect(service.attach(
        testActor(adminId, Role.Admin),
        container,
        input,
        'local',
        'all',
      )).resolves.toMatchObject({ intentId: expect.any(String) });
      const attachment = await database.selectFrom('control.volume_attachments')
        .selectAll()
        .where('volume_id', '=', volumeId)
        .executeTakeFirstOrThrow();
      await expect(service.detach(testActor(otherId), attachment.id, container, 'local'))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  it('rejects a shared volume on a server without a visible CephFS mapping', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverOne = randomUUID();
      const serverTwo = randomUUID();
      const imageId = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId, 1)).execute();
      await database.insertInto('infra.servers').values([
        serverValues(serverOne, 'one'),
        serverValues(serverTwo, 'two'),
      ]).execute();
      await insertPool(database, serverOne, `pool-${serverOne.slice(0, 8)}`);
      const poolTwo = await insertPool(database, serverTwo, `pool-${serverTwo.slice(0, 8)}`);
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'shared-attachment',
        display_name: null,
        identity_key: `cephfs:ceph/${backendId}/data`,
        ceph_fsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        total_bytes: 1000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      const sharedPoolId = randomUUID();
      await database.insertInto('infra.storage_pools').values({
        id: sharedPoolId,
        server_id: serverOne,
        incus_name: `cephfs-${serverOne.slice(0, 8)}`,
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
      }).execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        alias: 'base',
        fingerprint: null,
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      const container = await insertContainer(
        database,
        userId,
        serverTwo,
        poolTwo,
        imageId,
        'container-two',
      );
      const volumeId = await insertVolume(
        database,
        userId,
        sharedPoolId,
        null,
        backendId,
        'shared-volume',
      );
      await database.insertInto('iam.shared_backend_grants').values({
        id: randomUUID(),
        user_id: userId,
        shared_backend_id: backendId,
        limit_bytes: null,
        expires_at: null,
      }).execute();
      const service = makeService(database);

      await expect(service.attach(testActor(userId), container, {
        volumeId,
        containerPath: '/shared',
        readOnly: false,
      }, 'shared')).rejects.toMatchObject({
        response: expect.objectContaining({ code: FailureCode.VolumeCrossServerDenied }),
      });
      expect(await database.selectFrom('control.volume_attachments')
        .select('id')
        .where('volume_id', '=', volumeId)
        .execute()).toHaveLength(0);
      expect((await database.selectFrom('control.containers')
        .select('revision')
        .where('id', '=', container)
        .executeTakeFirstOrThrow()).revision).toBe(1);
    });
  });

  it('populates VolumeDto.attachments in one list query with container names', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      const imageId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId, 2)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'dto')).execute();
      const poolId = await insertPool(database, serverId, `pool-dto-${serverId.slice(0, 8)}`);
      await database.insertInto('infra.images').values({
        id: imageId,
        alias: 'base',
        fingerprint: null,
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      const containerId = await insertContainer(
        database,
        userId,
        serverId,
        poolId,
        imageId,
        'web-app',
      );
      const volumeId = await insertVolume(database, userId, poolId, serverId, null, 'dto-vol');
      const service = makeService(database);
      await service.attach(testActor(userId), containerId, {
        volumeId,
        containerPath: '/data',
        readOnly: false,
      }, 'local');
      const listed = await service.list(testActor(userId));
      const volume = listed.find((item) => item.id === volumeId);
      expect(volume?.usedBytes).toBe(0);
      expect(volume?.poolName).toMatch(/^pool-dto-/);
      expect(volume?.poolName).not.toBe(volumeId);
      expect(volume?.attachments).toEqual([
        expect.objectContaining({
          containerId,
          containerName: 'web-app',
          containerPath: '/data',
        }),
      ]);
      const fetched = await service.get(testActor(userId), volumeId);
      expect(fetched.attachments[0]?.containerName).toBe('web-app');
    });
  });

  it('attaches a shared volume without a volume.ensure and keeps the placement row after detach', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      const imageId = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId, 3)).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'home')).execute();
      const localPool = await insertPool(database, serverId, `local-${serverId.slice(0, 8)}`);
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'shared-blocked',
        display_name: null,
        identity_key: `cephfs:ceph/${backendId}/data`,
        ceph_fsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        total_bytes: 1000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      const sharedPoolId = randomUUID();
      await database.insertInto('infra.storage_pools').values({
        id: sharedPoolId,
        server_id: serverId,
        incus_name: `cephfs-${serverId.slice(0, 8)}`,
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
      }).execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        alias: 'base',
        fingerprint: null,
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      const containerId = await insertContainer(database, userId, serverId, localPool, imageId, 'c1');
      const volumeId = await insertVolume(database, userId, sharedPoolId, null, backendId, 'shared');
      await database.insertInto('control.volume_placements').values({
        volume_id: volumeId,
        server_id: serverId,
        pool_id: sharedPoolId,
        catalog_state: 'present',
      }).execute();
      await database.insertInto('iam.shared_backend_grants').values({
        id: randomUUID(),
        user_id: userId,
        shared_backend_id: backendId,
        limit_bytes: null,
        expires_at: null,
      }).execute();
      const service = makeService(database);
      const accepted = await service.attach(testActor(userId), containerId, {
        volumeId,
        containerPath: '/shared',
        readOnly: false,
      }, 'shared');
      const update = await database.selectFrom('control.intents')
        .selectAll()
        .where('id', '=', accepted.intentId)
        .executeTakeFirstOrThrow();
      expect(update.kind).toBe('container.update');
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('kind', '=', 'volume.ensure')
        .where('resource_id', '=', volumeId)
        .execute()).toHaveLength(0);

      const attachment = await database.selectFrom('control.volume_attachments')
        .select('id')
        .where('volume_id', '=', volumeId)
        .executeTakeFirstOrThrow();
      await insertStoppedRoute(database, containerId, serverId);
      await service.detach(testActor(userId), attachment.id, containerId, 'shared');
      const placement = await database.selectFrom('control.volume_placements')
        .select(['catalog_state', 'server_id'])
        .where('volume_id', '=', volumeId)
        .where('server_id', '=', serverId)
        .executeTakeFirstOrThrow();
      expect(placement.catalog_state).toBe('present');
    });
  });

  it('keeps sticky catalogs after detach and does not drop the attachment row until settle', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const homeServer = randomUUID();
      const peerServer = randomUUID();
      const imageId = randomUUID();
      const backendId = randomUUID();
      await database.insertInto('iam.users').values(userValues(userId, 4)).execute();
      await database.insertInto('infra.servers').values([
        serverValues(homeServer, 'home2'),
        serverValues(peerServer, 'peer'),
      ]).execute();
      await insertPool(database, homeServer, `local-${homeServer.slice(0, 8)}`);
      const localPeer = await insertPool(database, peerServer, `local-${peerServer.slice(0, 8)}`);
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'shared-retract',
        display_name: null,
        identity_key: `cephfs:ceph/${backendId}/data`,
        ceph_fsid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
          incus_name: `cephfs-${homeServer.slice(0, 8)}`,
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
          incus_name: `cephfs-${peerServer.slice(0, 8)}`,
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
      await database.insertInto('infra.images').values({
        id: imageId,
        alias: 'base',
        fingerprint: null,
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      const containerId = await insertContainer(database, userId, peerServer, localPeer, imageId, 'on-peer');
      const volumeId = await insertVolume(database, userId, homePool, null, backendId, 'shared-retract');
      await database.insertInto('control.volume_placements').values({
        volume_id: volumeId,
        server_id: homeServer,
        pool_id: homePool,
        catalog_state: 'present',
      }).execute();
      await database.insertInto('iam.shared_backend_grants').values({
        id: randomUUID(),
        user_id: userId,
        shared_backend_id: backendId,
        limit_bytes: null,
        expires_at: null,
      }).execute();
      const service = makeService(database);
      await service.attach(testActor(userId), containerId, {
        volumeId,
        containerPath: '/shared',
        readOnly: false,
      }, 'shared');
      const attachment = await database.selectFrom('control.volume_attachments')
        .select('id')
        .where('volume_id', '=', volumeId)
        .executeTakeFirstOrThrow();
      await service.detach(testActor(userId), attachment.id, containerId, 'shared');
      const peerPlacement = await database.selectFrom('control.volume_placements')
        .select(['catalog_state', 'server_id'])
        .where('volume_id', '=', volumeId)
        .where('server_id', '=', peerServer)
        .executeTakeFirstOrThrow();
      expect(peerPlacement.catalog_state).toBe('ensuring');
      expect(await database.selectFrom('control.volume_attachments')
        .select('bind_state')
        .where('volume_id', '=', volumeId)
        .executeTakeFirst()).toEqual({ bind_state: 'detaching' });
    });
  });
});
