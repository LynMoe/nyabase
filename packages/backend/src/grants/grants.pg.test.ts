import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { FailureCode, Role, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import { testActor } from '../iam/actor.test-helper.js';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import {
  days,
  grantBackend,
  observeGpus,
  seedBackend,
  seedBackendPool,
  seedBundle,
  seedContainer,
  seedImage,
  seedPool,
  seedServer,
  seedUser,
} from '../iam/access.pg-test-helper.js';
import { resolvePoolAccess, resolveServerAccess, resolveSharedBackendAccess } from '../iam/effective-access.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { GrantBundlesService } from './grant-bundles.service.js';
import { pickGrantGpus } from './grant-fields.js';
import { GrantsService } from './grants.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

type Db = Kysely<NyabaseDatabase>;

function services(database: Db) {
  const transactions = new PgTransactionManager(database);
  const changes = new AccessChangeNotifier();
  let signals = 0;
  changes.onChange(() => { signals += 1; });
  const audit = { append: async () => undefined } as never;
  const claims = new GpuClaimsRepository(database);
  return {
    grants: new GrantsService(database, transactions, audit, claims, changes),
    bundles: new GrantBundlesService(database, transactions, audit, claims, changes),
    signals: () => signals,
  };
}

async function manager(database: Db, role: Role = Role.UserAdmin) {
  return testActor(await seedUser(database, undefined, UserStatus.Active, role), role);
}

const assignment = (bundleId: string, extra: Partial<{
  overrides: Record<string, number | null>;
  expiresAt: string | null;
  replace: boolean;
}> = {}) => ({ bundleId, overrides: {}, expiresAt: null, replace: false, ...extra });

async function enableGpu(database: Db, serverId: string) {
  await database.updateTable('infra.servers').set({ gpu_enabled: true }).where('id', '=', serverId).execute();
}

describePg('GrantsService', () => {
  it('assigns a bundle with overrides and reports the effective quotas', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const actor = await manager(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const bundleId = await seedBundle(database, serverId, {
        name: 'GPU A', cpuCores: 16, memBytes: 32, rootDiskBytes: 100, gpuCount: 0,
      });

      const grant = await grants.putServerGrant(actor, userId, serverId, assignment(bundleId, {
        overrides: { rootDiskBytes: 300, memBytes: null },
      }));
      expect(grant).toMatchObject({
        userId, serverId, bundleId, bundleName: 'GPU A',
        overrides: { rootDiskBytes: 300, memBytes: null },
        cpuCores: 16, memBytes: null, rootDiskBytes: 300, gpuCount: 0,
        expiresAt: null, storagePools: [],
      });
      await expect(grants.listServerGrants(userId)).resolves.toEqual([grant]);
      await expect(resolveServerAccess(database, userId, serverId))
        .resolves.toMatchObject({ cpuCores: 16, memBytes: null, rootDiskBytes: 300 });
    });
  });

  it('refuses a second bundle on the same server unless replacing, which keeps the grant and its data disks', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants, signals } = services(database);
      const actor = await manager(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const small = await seedBundle(database, serverId, { cpuCores: 2 });
      const large = await seedBundle(database, serverId, { cpuCores: 32 });

      const first = await grants.putServerGrant(actor, userId, serverId, assignment(small, {
        overrides: { memBytes: 8 },
      }));
      await grants.putStoragePoolGrant(actor, userId, poolId, 500);
      const before = signals();
      await expect(grants.putServerGrant(actor, userId, serverId, assignment(large)))
        .rejects.toMatchObject({
          status: 409,
          response: { code: FailureCode.ServerGrantExists, details: { grantId: first.id, bundleId: small } },
        });
      expect(signals()).toBe(before);
      await expect(grants.putServerGrant(actor, userId, serverId, assignment(small)))
        .rejects.toMatchObject({ response: { code: FailureCode.ServerGrantExists } });

      const replaced = await grants.putServerGrant(actor, userId, serverId, assignment(large, { replace: true }));
      expect(replaced).toMatchObject({ id: first.id, bundleId: large, cpuCores: 32, overrides: {}, memBytes: null });
      expect(replaced.storagePools).toMatchObject([{ poolId, limitBytes: 500 }]);
      expect(signals()).toBe(before + 1);
      await expect(resolvePoolAccess(database, userId, poolId)).resolves.toMatchObject({ limitBytes: 500 });
    });
  });

  it('only takes a bundle of the grant\'s own server', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const actor = await manager(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const otherServer = await seedServer(database);
      const foreign = await seedBundle(database, otherServer);
      await expect(grants.putServerGrant(actor, userId, serverId, assignment(foreign)))
        .rejects.toMatchObject({ status: 404 });
      await expect(grants.putServerGrant(actor, userId, serverId, assignment(randomUUID())))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  it('patches the complete override set and the expiry; dropped keys follow the bundle again', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const actor = await manager(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const bundleId = await seedBundle(database, serverId, { cpuCores: 4, rootDiskBytes: 100 });
      await grants.putServerGrant(actor, userId, serverId, assignment(bundleId, {
        overrides: { cpuCores: 8, rootDiskBytes: 300 },
      }));

      const patched = await grants.patchServerGrant(actor, userId, serverId, { overrides: { rootDiskBytes: 400 } });
      expect(patched).toMatchObject({ overrides: { rootDiskBytes: 400 }, cpuCores: 4, rootDiskBytes: 400 });
      const expiry = days(30).toISOString();
      const expiring = await grants.patchServerGrant(actor, userId, serverId, { expiresAt: expiry });
      expect(expiring).toMatchObject({ overrides: { rootDiskBytes: 400 }, expiresAt: expiry });
      await expect(grants.patchServerGrant(actor, userId, await seedServer(database), { expiresAt: null }))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  it('deletes a server grant with its data disks, so both kinds of coverage lapse', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants, signals } = services(database);
      const actor = await manager(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      await grants.putServerGrant(actor, userId, serverId, assignment(await seedBundle(database, serverId)));
      await grants.putStoragePoolGrant(actor, userId, poolId, null);
      const before = signals();

      await grants.deleteServerGrant(actor, userId, serverId);
      expect(signals()).toBe(before + 1);
      await expect(resolveServerAccess(database, userId, serverId)).resolves.toBeNull();
      await expect(resolvePoolAccess(database, userId, poolId)).resolves.toBeNull();
      await expect(database.selectFrom('iam.storage_pool_grants').select('id').execute()).resolves.toEqual([]);
      // Deleting a grant that does not exist changes nothing.
      await grants.deleteServerGrant(actor, userId, serverId);
      expect(signals()).toBe(before + 1);
    });
  });

  it('grants data disks only on local pools of a server the user holds a bundle on', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const actor = await manager(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const otherServer = await seedServer(database);
      const otherPool = await seedPool(database, otherServer);
      const sharedPool = await seedBackendPool(database, serverId, await seedBackend(database));
      await grants.putServerGrant(actor, userId, serverId, assignment(await seedBundle(database, serverId)));

      await expect(grants.putStoragePoolGrant(actor, userId, otherPool, 10))
        .rejects.toMatchObject({ status: 409, response: { code: FailureCode.ServerGrantRequired } });
      await expect(grants.putStoragePoolGrant(actor, userId, sharedPool, 10)).rejects.toMatchObject({ status: 404 });
      await expect(grants.putStoragePoolGrant(actor, userId, randomUUID(), 10)).rejects.toMatchObject({ status: 404 });

      const created = await grants.putStoragePoolGrant(actor, userId, poolId, 10);
      const updated = await grants.putStoragePoolGrant(actor, userId, poolId, null);
      expect(updated).toMatchObject({ id: created.id, poolId, serverId, limitBytes: null });
      await grants.deleteStoragePoolGrant(actor, userId, poolId);
      await expect(resolvePoolAccess(database, userId, poolId)).resolves.toBeNull();
      await expect(resolveServerAccess(database, userId, serverId)).resolves.not.toBeNull();
    });
  });

  it('allows GPU overrides only where GPU is enabled', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const actor = await manager(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const bundleId = await seedBundle(database, serverId, { gpuCount: 0 });
      await expect(grants.putServerGrant(actor, userId, serverId, assignment(bundleId, { overrides: { gpuCount: 2 } })))
        .rejects.toMatchObject({ response: { code: FailureCode.GpuGrantNotApplicable } });
      await grants.putServerGrant(actor, userId, serverId, assignment(bundleId, { overrides: { gpuCount: 0 } }));
      await enableGpu(database, serverId);
      await expect(grants.patchServerGrant(actor, userId, serverId, { overrides: { gpuCount: 2 } }))
        .resolves.toMatchObject({ gpuCount: 2 });
    });
  });

  it('needs the user admin role (an admin too) and an existing user', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants, signals } = services(database);
      const plain = testActor(await seedUser(database));
      const admin = await manager(database, Role.Admin);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const bundleId = await seedBundle(database, serverId);

      await expect(grants.putServerGrant(plain, userId, serverId, assignment(bundleId)))
        .rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      await expect(grants.deleteServerGrant(plain, userId, serverId))
        .rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      await expect(grants.putServerGrant(admin, randomUUID(), serverId, assignment(bundleId)))
        .rejects.toMatchObject({ status: 404 });
      expect(signals()).toBe(0);
      await expect(grants.putServerGrant(admin, userId, serverId, assignment(bundleId)))
        .resolves.toMatchObject({ serverId });
    });
  });

  it('keeps one shared-backend grant per user, upserted', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const actor = await manager(database);
      const userId = await seedUser(database);
      const backendId = await seedBackend(database);
      const first = await grants.putSharedBackendGrant(actor, userId, backendId, { limitBytes: 10, expiresAt: null });
      const second = await grants.putSharedBackendGrant(actor, userId, backendId, { limitBytes: null, expiresAt: null });
      expect(second).toMatchObject({ id: first.id, userId, sharedBackendId: backendId, limitBytes: null });
      await expect(grants.listSharedBackendGrants(userId)).resolves.toHaveLength(1);
      await grants.deleteSharedBackendGrant(actor, userId, backendId);
      await expect(resolveSharedBackendAccess(database, userId, backendId)).resolves.toBeNull();
    });
  });

  it('rejects zero quotas in the database: NULL is the only unlimited', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      await expect(seedBundle(database, serverId, { memBytes: 0 })).rejects.toThrow(/grant_bundles_mem_bytes_check/);
      await expect(seedBundle(database, serverId, { rootDiskBytes: 0 }))
        .rejects.toThrow(/grant_bundles_root_disk_bytes_check/);
      await expect(seedBundle(database, serverId, { cpuCores: 0 })).rejects.toThrow(/grant_bundles_cpu_cores_check/);
      await seedBundle(database, serverId, { gpuCount: 0, memBytes: 1 });
      const userId = await seedUser(database);
      await expect(grantBackend(database, { user: userId }, await seedBackend(database), 0))
        .rejects.toThrow(/shared_backend_grants_limit_check/);
    });
  });
});

describePg('GrantBundlesService', () => {
  it('creates, lists and names bundles per server', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { bundles, grants } = services(database);
      const actor = await manager(database);
      const serverId = await seedServer(database, 'alpha');
      const otherServer = await seedServer(database, 'beta');
      const quotas = { cpuCores: 16, memBytes: 32, rootDiskBytes: 100, gpuCount: 0 };

      const bundle = await bundles.create(actor, { serverId, name: 'GPU A', ...quotas });
      expect(bundle).toMatchObject({ serverId, name: 'GPU A', ...quotas, revision: 1, grantCount: 0 });
      await expect(bundles.create(actor, { serverId, name: 'gpu a', ...quotas }))
        .rejects.toMatchObject({ status: 409, response: { code: FailureCode.GrantBundleConflict } });
      await bundles.create(actor, { serverId: otherServer, name: 'GPU A', ...quotas });
      await grants.putServerGrant(actor, await seedUser(database), serverId, assignment(bundle.id));

      const listed = await bundles.list();
      expect(listed.map((row) => [row.serverId, row.grantCount])).toEqual([[serverId, 1], [otherServer, 0]]);
      await expect(bundles.list(otherServer)).resolves.toHaveLength(1);
      await expect(bundles.get(bundle.id)).resolves.toMatchObject({ grantCount: 1 });
      await expect(bundles.create(actor, { serverId: randomUUID(), name: 'x', ...quotas }))
        .rejects.toMatchObject({ status: 404 });
      await expect(bundles.create(testActor(await seedUser(database)), { serverId, name: 'y', ...quotas }))
        .rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
    });
  });

  it('grants GPUs only where GPU is enabled', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { bundles } = services(database);
      const actor = await manager(database);
      const serverId = await seedServer(database);
      const base = { serverId, cpuCores: null, memBytes: null, rootDiskBytes: null };
      await expect(bundles.create(actor, { ...base, name: 'two', gpuCount: 2 }))
        .rejects.toMatchObject({ response: { code: FailureCode.GpuGrantNotApplicable } });
      await bundles.create(actor, { ...base, name: 'none', gpuCount: 0 });
      const all = await bundles.create(actor, { ...base, name: 'all', gpuCount: null });
      await expect(bundles.update(actor, all.id, { expectedRevision: 1, gpuCount: 1 }))
        .rejects.toMatchObject({ response: { code: FailureCode.GpuGrantNotApplicable } });
      await enableGpu(database, serverId);
      await expect(bundles.update(actor, all.id, { expectedRevision: 1, gpuCount: 1 }))
        .resolves.toMatchObject({ gpuCount: 1, revision: 2 });
    });
  });

  it('changes every grant that follows the edited field at once, and none that overrides it', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { bundles, grants, signals } = services(database);
      const actor = await manager(database);
      const serverId = await seedServer(database);
      const follower = await seedUser(database);
      const overrider = await seedUser(database);
      const bundle = await bundles.create(actor, {
        serverId, name: 'b', cpuCores: 16, memBytes: 32, rootDiskBytes: 100, gpuCount: 0,
      });
      await grants.putServerGrant(actor, follower, serverId, assignment(bundle.id));
      await grants.putServerGrant(actor, overrider, serverId, assignment(bundle.id, {
        overrides: { rootDiskBytes: 300 },
      }));
      const before = signals();

      await expect(bundles.update(actor, bundle.id, { expectedRevision: 2, rootDiskBytes: 200 }))
        .rejects.toMatchObject({ status: 409, response: { code: FailureCode.RevisionConflict } });
      const updated = await bundles.update(actor, bundle.id, { expectedRevision: 1, rootDiskBytes: 200, cpuCores: 8 });
      expect(updated).toMatchObject({ revision: 2, rootDiskBytes: 200, cpuCores: 8, memBytes: 32, grantCount: 2 });
      expect(signals()).toBe(before + 1);
      await expect(resolveServerAccess(database, follower, serverId))
        .resolves.toMatchObject({ cpuCores: 8, rootDiskBytes: 200 });
      await expect(resolveServerAccess(database, overrider, serverId))
        .resolves.toMatchObject({ cpuCores: 8, rootDiskBytes: 300 });
    });
  });

  it('refuses to delete a bundle that is still assigned, naming the users', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { bundles, grants } = services(database);
      const actor = await manager(database);
      const serverId = await seedServer(database);
      const userId = await seedUser(database, 'holder');
      const bundleId = await seedBundle(database, serverId);
      await grants.putServerGrant(actor, userId, serverId, assignment(bundleId));

      await expect(bundles.delete(actor, bundleId)).rejects.toMatchObject({
        status: 409,
        response: { code: FailureCode.GrantBundleInUse, details: { users: [{ userId, username: 'holder' }] } },
      });
      await grants.deleteServerGrant(actor, userId, serverId);
      await expect(bundles.delete(actor, bundleId)).resolves.toEqual({ deleted: true });
      await expect(bundles.get(bundleId)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('previews who changes, who keeps an override, and what a smaller quota no longer covers', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { bundles, grants } = services(database);
      const actor = await manager(database);
      const serverId = await seedServer(database);
      await enableGpu(database, serverId);
      const cards = ['00000000:01:00.0', '00000000:02:00.0', '00000000:03:00.0', '00000000:04:00.0'];
      await observeGpus(database, serverId, cards);
      const poolId = await seedPool(database, serverId);
      const imageId = await seedImage(database);
      const follower = await seedUser(database, 'a-follower');
      const overrider = await seedUser(database, 'b-overrider');
      const untouched = await seedUser(database, 'c-untouched');
      const bundle = await bundles.create(actor, {
        serverId, name: 'b', cpuCores: 16, memBytes: 4 * 1_073_741_824, rootDiskBytes: 1_000, gpuCount: 4,
      });
      await grants.putServerGrant(actor, follower, serverId, assignment(bundle.id));
      await grants.putServerGrant(actor, overrider, serverId, assignment(bundle.id, { overrides: { memBytes: null } }));
      await grants.putServerGrant(actor, untouched, serverId, assignment(bundle.id, {
        overrides: { memBytes: null, rootDiskBytes: null, gpuCount: 4 },
      }));
      // The follower runs 2 GiB with a 100-byte system disk and holds every card.
      await seedContainer(database, { ownerId: follower, serverId, poolId, imageId, running: true });
      await seedContainer(database, { ownerId: follower, serverId, poolId, imageId, running: true });
      const containers = await database.selectFrom('control.containers').select('id').execute();
      for (const address of cards) {
        await database.insertInto('control.container_gpu_claims')
          .values({ container_id: containers[0]!.id, server_id: serverId, pci_address: address })
          .execute();
      }

      const preview = await bundles.preview(bundle.id, { memBytes: 1_073_741_824, rootDiskBytes: 150, gpuCount: 1 });
      expect(preview.bundle).toMatchObject({ memBytes: 4 * 1_073_741_824, revision: 1 });
      expect(preview.proposed).toMatchObject({ memBytes: 1_073_741_824, rootDiskBytes: 150, gpuCount: 1 });
      expect(preview.serverGpuCount).toBe(4);
      const kept = pickGrantGpus(follower, cards, 1);
      expect(preview.entries).toEqual([
        {
          grantId: expect.any(String),
          userId: follower,
          username: 'a-follower',
          displayName: 'a-follower',
          changes: [
            { field: 'memBytes', before: 4 * 1_073_741_824, after: 1_073_741_824 },
            { field: 'rootDiskBytes', before: 1_000, after: 150 },
            { field: 'gpuCount', before: 4, after: 1 },
          ],
          overridden: [],
          memBytesInUse: 2 * 1_073_741_824,
          rootDiskBytesInUse: 200,
          gpusInUseRemoved: cards.filter((card) => !kept.includes(card)),
        },
        {
          grantId: expect.any(String),
          userId: overrider,
          username: 'b-overrider',
          displayName: 'b-overrider',
          changes: [
            { field: 'rootDiskBytes', before: 1_000, after: 150 },
            { field: 'gpuCount', before: 4, after: 1 },
          ],
          overridden: [{ field: 'memBytes', value: null }],
          memBytesInUse: null,
          rootDiskBytesInUse: null,
          gpusInUseRemoved: [],
        },
        {
          grantId: expect.any(String),
          userId: untouched,
          username: 'c-untouched',
          displayName: 'c-untouched',
          changes: [],
          overridden: [
            { field: 'memBytes', value: null },
            { field: 'rootDiskBytes', value: null },
            { field: 'gpuCount', value: 4 },
          ],
          memBytesInUse: null,
          rootDiskBytesInUse: null,
          gpusInUseRemoved: [],
        },
      ]);
      // Nothing changed: the preview is read-only, and a no-op proposal lists no one.
      await expect(bundles.get(bundle.id)).resolves.toMatchObject({ revision: 1, gpuCount: 4 });
      await expect(bundles.preview(bundle.id, { cpuCores: 16 })).resolves.toMatchObject({ entries: [] });
    });
  });
});
