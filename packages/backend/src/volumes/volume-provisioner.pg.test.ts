import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { AuditAction, FailureCode, Role } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { testActor } from '../iam/actor.test-helper.js';
import {
  LARGE_GRANT_BYTES,
  grantBackend,
  grantPool,
  grantServer,
  seedBackend,
  seedBackendPool,
  seedContainer,
  seedImage,
  seedPool,
  seedServer,
  seedUser,
} from '../iam/access.pg-test-helper.js';
import { ContainerReconcileStore } from '../containers/container-reconcile.store.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { makeVolumeServices } from './volume-services.test-helper.js';
import { VolumesRepository } from './volumes.repository.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const GiB = 1024 ** 3;

type Db = Kysely<NyabaseDatabase>;

function services(database: Db) {
  const audit = { append: vi.fn(async () => undefined) };
  const intents = new IntentRepository(database, noopWake());
  return {
    audit,
    intents,
    ...makeVolumeServices(
      new VolumesRepository(database),
      new StoragePoolsRepository(database),
      new PgTransactionManager(database),
      intents,
      database,
      audit as never,
    ),
  };
}

/** A data disk: a dir pool with an effective quota and no known capacity, enabled at `mountPath`. */
async function seedDisk(database: Db, serverId: string, mountPath: string | null, driver: 'dir' | 'zfs' = 'dir') {
  const poolId = await seedPool(database, serverId);
  await database.updateTable('infra.storage_pools')
    .set({ mount_path: mountPath, total_bytes: null, driver })
    .where('id', '=', poolId)
    .execute();
  return poolId;
}

async function volumesOf(database: Db, ownerId: string) {
  return database.selectFrom('control.volumes')
    .select(['id', 'pool_id', 'shared_backend_id', 'size_bytes', 'shrink_reserved_bytes', 'lifecycle_phase', 'name'])
    .where('owner_id', '=', ownerId)
    .orderBy('name')
    .execute();
}

async function activate(database: Db, volumeIds: readonly string[]) {
  await database.updateTable('control.volumes').set({ lifecycle_phase: 'active' })
    .where('id', 'in', volumeIds).execute();
}

async function mountsOf(database: Db, containerId: string) {
  return database.selectFrom('control.volume_attachments')
    .select(['volume_id', 'container_path', 'bind_state'])
    .where('container_id', '=', containerId)
    .orderBy('container_path')
    .execute();
}

describePg('VolumeProvisioner', () => {
  it('creates one volume per covered, enabled disk and mounts it into every active container of the owner', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner } = services(database);
      const userId = await seedUser(database);
      const otherId = await seedUser(database);
      const serverId = await seedServer(database);
      const otherServer = await seedServer(database);
      const image = await seedImage(database);
      const data1 = await seedDisk(database, serverId, '/data1');
      const data2 = await seedDisk(database, serverId, '/data2');
      const disabled = await seedDisk(database, serverId, null);
      const rootPool = await seedPool(database, otherServer);
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, [data1, data2, disabled], 300 * GiB);
      const mine = await seedContainer(database, { ownerId: userId, serverId, poolId: data1, imageId: image });
      const elsewhere = await seedContainer(database, { ownerId: userId, serverId: otherServer, poolId: rootPool, imageId: image });
      const theirs = await seedContainer(database, { ownerId: otherId, serverId, poolId: data1, imageId: image });

      const first = await provisioner.run(new Map());
      expect(first).toMatchObject({ created: 2, mounted: 0, resized: 0 });
      const created = await volumesOf(database, userId);
      // The owner's 100-byte system disk on the server comes out of the total; the rest is split.
      const half = String(Math.floor((300 * GiB - 100) / 2));
      expect(created).toEqual([
        expect.objectContaining({ pool_id: data1, name: '/data1', size_bytes: half, lifecycle_phase: 'provisioning' }),
        expect.objectContaining({ pool_id: data2, name: '/data2', size_bytes: half, lifecycle_phase: 'provisioning' }),
      ]);
      for (const volume of created) {
        const ensure = await database.selectFrom('control.intents').select(['kind', 'requested_by'])
          .where('resource_id', '=', volume.id).execute();
        expect(ensure).toEqual([{ kind: 'volume.ensure', requested_by: null }]);
      }

      // Not mountable until Incus holds them.
      await activate(database, created.map((volume) => volume.id));
      const second = await provisioner.run(new Map());
      expect(second).toMatchObject({ created: 0, mounted: 2 });
      expect(await mountsOf(database, mine)).toEqual([
        { volume_id: created[0]!.id, container_path: '/data1', bind_state: 'attaching' },
        { volume_id: created[1]!.id, container_path: '/data2', bind_state: 'attaching' },
      ]);
      expect(await mountsOf(database, elsewhere)).toEqual([]);
      expect(await mountsOf(database, theirs)).toEqual([]);
      const containerIntents = await database.selectFrom('control.intents')
        .select(['kind', 'target_revision', 'request_json'])
        .where('resource_id', '=', mine)
        .execute();
      expect(containerIntents).toHaveLength(1);
      expect(containerIntents[0]).toMatchObject({ kind: 'container.update', target_revision: 2 });
      expect(containerIntents[0]!.request_json).toMatchObject({ operation: 'mount_volumes' });

      await expect(provisioner.run(new Map())).resolves.toMatchObject({ created: 0, mounted: 0, resized: 0 });
    });
  });

  it('creates a shared volume ready to mount, on the servers that reach its backend through one executor pool', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner } = services(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const unreached = await seedServer(database);
      const image = await seedImage(database);
      const backendId = await seedBackend(database);
      await database.updateTable('infra.shared_backends').set({ mount_path: '/meowfs' }).where('id', '=', backendId).execute();
      const executorPool = await seedBackendPool(database, serverId, backendId);
      await grantBackend(database, { user: userId }, backendId, 10 * GiB);
      const root = await seedPool(database, serverId);
      const rootElsewhere = await seedPool(database, unreached);
      const reached = await seedContainer(database, { ownerId: userId, serverId, poolId: root, imageId: image });
      const notReached = await seedContainer(database, { ownerId: userId, serverId: unreached, poolId: rootElsewhere, imageId: image });

      await expect(provisioner.run(new Map())).resolves.toMatchObject({ created: 1, mounted: 1 });
      const [volume] = await volumesOf(database, userId);
      expect(volume).toMatchObject({ shared_backend_id: backendId, size_bytes: String(10 * GiB), lifecycle_phase: 'active' });
      expect(await mountsOf(database, reached)).toEqual([
        { volume_id: volume!.id, container_path: '/meowfs', bind_state: 'attaching' },
      ]);
      expect(await mountsOf(database, notReached)).toEqual([]);
      const placement = await database.selectFrom('control.volume_placements').selectAll().execute();
      expect(placement).toEqual([expect.objectContaining({ server_id: serverId, pool_id: executorPool, catalog_state: 'ensuring' })]);
    });
  });

  it('follows a lowered ceiling: below the data where the filesystem takes it, by ratchet where it does not', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner, audit } = services(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const dirDisk = await seedDisk(database, serverId, '/data1');
      const zfsDisk = await seedDisk(database, serverId, '/data2', 'zfs');
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, [dirDisk, zfsDisk], LARGE_GRANT_BYTES, 20 * GiB);
      await provisioner.run(new Map());
      const [dirVolume, zfsVolume] = await volumesOf(database, userId);
      await activate(database, [dirVolume!.id, zfsVolume!.id]);
      await database.updateTable('control.volumes').set({ size_bytes: 100 * GiB, revision: 5 })
        .where('id', 'in', [dirVolume!.id, zfsVolume!.id]).execute();

      // Usage unknown: the ceiling still holds where the filesystem takes it; the ratchet needs the data.
      await expect(provisioner.run(new Map())).resolves.toMatchObject({ resized: 1 });
      await provisioner.run(new Map([[zfsVolume!.id, 60 * GiB]]));
      const after = await volumesOf(database, userId);
      expect(after).toEqual([
        expect.objectContaining({ size_bytes: String(20 * GiB), shrink_reserved_bytes: String(100 * GiB) }),
        expect.objectContaining({ size_bytes: String(60 * GiB), shrink_reserved_bytes: String(100 * GiB) }),
      ]);
      const resize = await database.selectFrom('control.intents').select(['kind', 'request_json'])
        .where('resource_id', '=', dirVolume!.id).where('kind', '=', 'volume.resize').executeTakeFirstOrThrow();
      expect(resize.request_json).toMatchObject({ source: 'quota_balancer', sizeBytes: 20 * GiB });
      expect(audit.append).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), AuditAction.ResizeVolume, expect.anything(), expect.anything(), expect.anything(),
      );
    });
  });

  it('shares a grant\'s quota between its disks, giving each the free space of the group', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner } = services(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const disks = [await seedDisk(database, serverId, '/data1'), await seedDisk(database, serverId, '/data2')];
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, disks, 100 * GiB);
      await provisioner.run(new Map());
      const [a, b] = await volumesOf(database, userId);
      await activate(database, [a!.id, b!.id]);
      // 40 GiB written to /data1: it keeps its data plus half of what is left; /data2 gives up the rest.
      await provisioner.run(new Map([[a!.id, 40 * GiB], [b!.id, 0]]));
      await database.updateTable('control.volumes').set({ shrink_reserved_bytes: null }).execute();
      await provisioner.run(new Map([[a!.id, 40 * GiB], [b!.id, 0]]));
      const sizes = (await volumesOf(database, userId)).map((volume) => Number(volume.size_bytes) / GiB);
      expect(sizes).toEqual([70, 30]);
    });
  });

  it('takes the owner\'s system disks out of the total, and passes a capped disk\'s share to the others', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner } = services(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const image = await seedImage(database);
      const disks = [await seedDisk(database, serverId, '/data1'), await seedDisk(database, serverId, '/data2')];
      const grantId = await grantServer(database, { user: userId }, serverId, {
        diskBytes: 100 * GiB,
        dataDisks: [{ poolId: disks[0]!, capBytes: 10 * GiB }, { poolId: disks[1]!, capBytes: null }],
      });
      const containerId = await seedContainer(database, { ownerId: userId, serverId, poolId: disks[0]!, imageId: image });
      await database.updateTable('control.containers').set({ root_size_bytes: 40 * GiB }).where('id', '=', containerId).execute();
      await provisioner.run(new Map());
      const [a, b] = await volumesOf(database, userId);
      await activate(database, [a!.id, b!.id]);
      // 60 GiB left beside the system disk: /data1 stops at its 10 GiB ceiling, /data2 takes the other 50.
      await provisioner.run(new Map([[a!.id, 0], [b!.id, 0]]));
      await database.updateTable('control.volumes').set({ shrink_reserved_bytes: null }).execute();
      await provisioner.run(new Map([[a!.id, 0], [b!.id, 0]]));
      expect((await volumesOf(database, userId)).map((volume) => Number(volume.size_bytes) / GiB)).toEqual([10, 50]);

      // A grow planned before the system disk grew waits a pass: the next plan shrinks instead.
      const before = await database.selectFrom('control.volumes').select(['revision', 'size_bytes']).where('id', '=', b!.id)
        .executeTakeFirstOrThrow();
      const grow = (provisioner as unknown as {
        applyResize(resize: object): Promise<boolean>;
      }).applyResize.bind(provisioner);
      await expect(grow({
        volumeId: b!.id, revision: before.revision, sizeBytes: 55 * GiB,
        quota: { ownerId: userId, serverId, rootBytes: 35 * GiB },
      })).resolves.toBe(false);
      await expect(grow({
        volumeId: b!.id, revision: before.revision, sizeBytes: 55 * GiB,
        quota: { ownerId: userId, serverId, rootBytes: 40 * GiB },
      })).resolves.toBe(true);
      expect(grantId).toEqual(expect.any(String));
    });
  });

  it('skips a path another volume already mounts, and disks under maintenance', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner } = services(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const image = await seedImage(database);
      const data1 = await seedDisk(database, serverId, '/data1');
      const busy = await seedDisk(database, serverId, '/data2');
      await database.updateTable('infra.storage_pools').set({ maintenance: true }).where('id', '=', busy).execute();
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, data1, 10 * GiB);
      await grantPool(database, { user: userId }, busy, 10 * GiB);
      const containerId = await seedContainer(database, { ownerId: userId, serverId, poolId: data1, imageId: image });
      await provisioner.run(new Map());
      const created = await volumesOf(database, userId);
      expect(created.map((volume) => volume.pool_id)).toEqual([data1]);
      await activate(database, [created[0]!.id]);
      // An older mount (made by hand before) holds /data1 in this container.
      const old = await seedDisk(database, serverId, null);
      const oldVolume = randomUUID();
      await database.insertInto('control.volumes').values({
        id: oldVolume, owner_id: userId, pool_id: old, server_id: serverId, shared_backend_id: null, name: 'old',
        incus_name: `nyv-${oldVolume.replaceAll('-', '')}`, size_bytes: GiB, lifecycle_phase: 'active',
        used_bytes: null, revision: 1, observed_revision: null, needs_attention: false, failure_code: null,
      }).execute();
      await database.insertInto('control.volume_attachments').values({
        id: randomUUID(), container_id: containerId, volume_id: oldVolume, device_name: `nyd-${randomUUID().replaceAll('-', '')}`,
        container_path: '/data1', read_only: false, bind_state: 'attached',
      }).execute();

      const outcome = await provisioner.run(new Map());
      expect(outcome).toMatchObject({
        mounted: 0,
        pathConflicts: [{ containerId, volumeId: created[0]!.id, containerPath: '/data1' }],
      });
    });
  });

  it('previews enabling a disk: who gets a volume, which containers mount it, which paths are taken', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner } = services(database);
      const userId = await seedUser(database, 'preview-user');
      const serverId = await seedServer(database);
      const image = await seedImage(database);
      const disk = await seedDisk(database, serverId, null);
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, disk, 10 * GiB);
      const containerId = await seedContainer(database, { ownerId: userId, serverId, poolId: disk, imageId: image });

      const preview = await provisioner.preview({ kind: 'pool', id: disk, serverId }, '/data9');
      expect(preview).toEqual({
        volumes: [{ userId, username: 'preview-user' }],
        mounts: [expect.objectContaining({ containerId, ownerId: userId, serverId })],
        pathConflicts: [],
      });
      // A preview changes nothing.
      expect(await volumesOf(database, userId)).toEqual([]);
    });
  });

  it('mounts the owner\'s volumes into a container in its create transaction', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner } = services(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const image = await seedImage(database);
      const disk = await seedDisk(database, serverId, '/data1');
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, disk, 10 * GiB);
      await provisioner.run(new Map());
      const [volume] = await volumesOf(database, userId);
      await activate(database, [volume!.id]);

      const containerId = await seedContainer(database, { ownerId: userId, serverId, poolId: disk, imageId: image });
      await database.updateTable('control.containers').set({ lifecycle_phase: 'provisioning' })
        .where('id', '=', containerId).execute();
      await new PgTransactionManager(database).run((transaction) => provisioner.bindNewContainer(transaction, {
        id: containerId, owner_id: userId, server_id: serverId,
      }));
      expect(await mountsOf(database, containerId)).toEqual([
        { volume_id: volume!.id, container_path: '/data1', bind_state: 'attaching' },
      ]);
    });
  });

  it('leaves blocked mounts and disks under maintenance out of the instance, and rewrites containers on a flip', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner } = services(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const image = await seedImage(database);
      const disk = await seedDisk(database, serverId, '/data1');
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, disk, 10 * GiB);
      const containerId = await seedContainer(database, { ownerId: userId, serverId, poolId: disk, imageId: image });
      await provisioner.run(new Map());
      const [volume] = await volumesOf(database, userId);
      await activate(database, [volume!.id]);
      await provisioner.run(new Map());
      const store = new ContainerReconcileStore(database, new IntentRepository(database, noopWake()));

      await expect(store.readAttachments(containerId, serverId)).resolves.toEqual([
        expect.objectContaining({ volume_id: volume!.id, container_path: '/data1' }),
      ]);
      await database.updateTable('infra.storage_pools').set({ maintenance: true }).where('id', '=', disk).execute();
      await expect(store.readAttachments(containerId, serverId)).resolves.toEqual([]);
      await expect(provisioner.rewriteContainersOnDisk({ kind: 'pool', id: disk, serverId })).resolves.toBe(1);
      const queued = await database.selectFrom('control.intents').select(['kind', 'request_json'])
        .where('resource_id', '=', containerId).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
      expect(queued.request_json).toMatchObject({ operation: 'storage_maintenance' });

      await database.updateTable('infra.storage_pools').set({ maintenance: false }).where('id', '=', disk).execute();
      await database.updateTable('control.volume_attachments').set({ bind_state: 'blocked' }).execute();
      await expect(store.readAttachments(containerId, serverId)).resolves.toEqual([]);
    });
  });

  it('reports the owner\'s disk total, data disks and system-disk room in the capacity view', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner, capacity } = services(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const image = await seedImage(database);
      const disks = [await seedDisk(database, serverId, '/data1'), await seedDisk(database, serverId, '/data2')];
      await grantServer(database, { user: userId }, serverId, { rootDiskBytes: 90 * GiB });
      await grantPool(database, { user: userId }, disks, 100 * GiB);
      await database.updateTable('iam.storage_pool_grants').set({ cap_bytes: 40 * GiB }).where('pool_id', '=', disks[1]!).execute();
      const containerId = await seedContainer(database, { ownerId: userId, serverId, poolId: disks[0]!, imageId: image });
      await database.updateTable('control.containers').set({ root_size_bytes: 20 * GiB }).where('id', '=', containerId).execute();
      await provisioner.run(new Map());
      await database.updateTable('control.volumes').set({ used_bytes: 30 * GiB }).where('pool_id', '=', disks[0]!).execute();

      const view = await capacity(testActor(userId), serverId);
      expect(view).toMatchObject({
        diskLimitBytes: 100 * GiB,
        rootDiskLimitBytes: 90 * GiB,
        usedByRootDisksBytes: 20 * GiB,
        dataDiskUsedBytes: 30 * GiB,
        // min(90 − 20 under the ceiling, 100 − 20 − 30 under the total)
        rootDiskAvailableBytes: 50 * GiB,
      });
      expect(disks.map((poolId) => view.pools.find((pool) => pool.poolId === poolId)?.dataDisk)).toEqual([
        { poolId: disks[0], capBytes: null, usedBytes: 30 * GiB },
        { poolId: disks[1], capBytes: 40 * GiB, usedBytes: 0 },
      ]);
      expect(view.pools.find((pool) => pool.poolId === disks[0])).toMatchObject({ mountPath: '/data1', maintenance: false });
    });
  });

  it('lets a user admin delete a volume once no grant covers it and nothing mounts it', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { provisioner, delete: remove } = services(database);
      const admin = testActor(await seedUser(database, undefined, undefined, Role.UserAdmin), Role.UserAdmin);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const image = await seedImage(database);
      const disk = await seedDisk(database, serverId, '/data1');
      await grantServer(database, { user: userId }, serverId);
      const grantId = await grantPool(database, { user: userId }, disk, 10 * GiB);
      const containerId = await seedContainer(database, { ownerId: userId, serverId, poolId: disk, imageId: image });
      await provisioner.run(new Map());
      const [volume] = await volumesOf(database, userId);
      await activate(database, [volume!.id]);
      await provisioner.run(new Map());

      await expect(remove(admin, volume!.id, 'local'))
        .rejects.toMatchObject({ status: 409, response: { code: FailureCode.VolumeStillGranted } });
      await database.deleteFrom('iam.storage_pool_grants').where('server_grant_id', '=', grantId).execute();
      await expect(remove(admin, volume!.id, 'local'))
        .rejects.toMatchObject({ status: 409, response: { code: FailureCode.VolumeRequiresUnbind } });
      await database.deleteFrom('control.volume_attachments').where('container_id', '=', containerId).execute();
      // Wrong kind is a 404, like every other volume route.
      await expect(remove(admin, volume!.id, 'shared')).rejects.toMatchObject({ status: 404 });

      const accepted = await remove(admin, volume!.id, 'local');
      expect(accepted).toMatchObject({ resourceId: volume!.id });
      const [after] = await volumesOf(database, userId);
      expect(after).toMatchObject({ lifecycle_phase: 'deleting' });
      const destroy = await database.selectFrom('control.intents').select(['kind', 'status'])
        .where('resource_id', '=', volume!.id).where('kind', '=', 'volume.destroy').execute();
      expect(destroy).toEqual([{ kind: 'volume.destroy', status: 'pending' }]);
      // Deleting: the provisioner does not create a new one while the grant is gone.
      await expect(provisioner.run(new Map())).resolves.toMatchObject({ created: 0 });
    });
  });
});
