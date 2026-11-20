import { describe, expect, it, vi } from 'vitest';
import { FailureCode, Role, UserStatus } from '@nyabase/common';
import { seedBackend, seedPool, seedServer, seedUser } from '../iam/access.pg-test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { SharedBackendsRepository } from '../shared-backends/shared-backends.repository.js';
import { SharedBackendsService } from '../shared-backends/shared-backends.service.js';
import { DiskChangeNotifier, type DiskChange } from './disk-mounts.js';
import { SharedBackendExecutorsService } from './shared-backend-executors.service.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';
import { StoragePoolsService } from './storage-pools.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

type Db = Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'];

function services(database: Db) {
  const notifier = new DiskChangeNotifier();
  const changes: DiskChange[] = [];
  notifier.onChange((change) => changes.push(change));
  const audit = { append: vi.fn(async () => undefined), log: vi.fn() };
  const transactions = new PgTransactionManager(database);
  const repository = new StoragePoolsRepository(database);
  const pools = new StoragePoolsService(repository, transactions, database, {} as never, audit as never, notifier);
  const executors = new SharedBackendExecutorsService(repository, transactions, {} as never, audit as never);
  const backends = new SharedBackendsService(
    new SharedBackendsRepository(database), transactions, database, executors, audit as never, notifier,
  );
  return { pools, backends, changes };
}

async function revision(database: Db, poolId: string) {
  const row = await database.selectFrom('infra.storage_pools').select('revision').where('id', '=', poolId)
    .executeTakeFirstOrThrow();
  return Number(row.revision);
}

describePg('enabling disks', () => {
  it('enables a local pool at a mount path and tells the provisioner after commit', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { pools, changes } = services(database);
      const actor = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);

      const enabled = await pools.patch(actor, poolId, { expectedRevision: 1, mountPath: '/data1' }, serverId);
      expect(enabled).toMatchObject({ mountPath: '/data1', maintenance: false });
      expect(changes).toEqual([{ disk: { kind: 'pool', id: poolId, serverId }, maintenanceChanged: false }]);

      const parked = await pools.patch(actor, poolId, { expectedRevision: 2, maintenance: true }, serverId);
      expect(parked).toMatchObject({ mountPath: '/data1', maintenance: true });
      expect(changes.at(-1)).toEqual({ disk: { kind: 'pool', id: poolId, serverId }, maintenanceChanged: true });

      // Unregistering takes the pool off the data disks.
      const unregistered = await pools.patch(actor, poolId, { expectedRevision: 3, registered: false }, serverId);
      expect(unregistered).toMatchObject({ registered: false, mountPath: null });
    });
  });

  it('refuses pools that cannot be data disks', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { pools } = services(database);
      const actor = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const serverId = await seedServer(database);
      const blockPool = await seedPool(database, serverId);
      await database.updateTable('infra.storage_pools')
        .set({ driver: 'lvm', resize_family: 'block_backed', block_filesystem: 'ext4' })
        .where('id', '=', blockPool).execute();
      const noQuota = await seedPool(database, serverId);
      await database.updateTable('infra.storage_pools').set({ quota_effective: false }).where('id', '=', noQuota).execute();

      for (const [poolId, reason] of [[blockPool, 'block_backed'], [noQuota, 'quota_ineffective']] as const) {
        await expect(pools.patch(actor, poolId, { expectedRevision: 1, mountPath: '/data' }, serverId))
          .rejects.toMatchObject({
            status: 409,
            response: { code: FailureCode.StorageMountUnsupported, details: { reason } },
          });
        expect(await revision(database, poolId)).toBe(1);
      }
    });
  });

  it('keeps every disk a container can see on its own path, never nested in another\'s', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { pools, backends } = services(database);
      const actor = await seedUser(database, undefined, UserStatus.Active, Role.Admin);
      const serverId = await seedServer(database);
      const otherServer = await seedServer(database);
      const first = await seedPool(database, serverId);
      const second = await seedPool(database, serverId);
      const elsewhere = await seedPool(database, otherServer);
      const backendId = await seedBackend(database);
      await pools.patch(actor, first, { expectedRevision: 1, mountPath: '/data' }, serverId);

      for (const path of ['/data', '/data/x']) {
        await expect(pools.patch(actor, second, { expectedRevision: 1, mountPath: path }, serverId))
          .rejects.toMatchObject({ response: { code: FailureCode.StorageMountPathConflict } });
      }
      await expect(pools.patch(actor, second, { expectedRevision: 1, mountPath: '/data2' }, serverId))
        .resolves.toMatchObject({ mountPath: '/data2' });
      // Another server's pools are never in the same container.
      await expect(pools.patch(actor, elsewhere, { expectedRevision: 1, mountPath: '/data' }, otherServer))
        .resolves.toMatchObject({ mountPath: '/data' });
      // A shared backend can be mounted on any server.
      await expect(backends.patch(actor, backendId, { expectedRevision: 1, mountPath: '/data2/shared' }))
        .rejects.toMatchObject({ response: { code: FailureCode.StorageMountPathConflict } });
      await expect(backends.patch(actor, backendId, { expectedRevision: 1, mountPath: '/meowfs', maintenance: true }))
        .resolves.toMatchObject({ mountPath: '/meowfs', maintenance: true });
    });
  });
});
