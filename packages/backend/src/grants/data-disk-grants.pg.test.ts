import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { AuditAction, FailureCode, Role, UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import { testActor } from '../iam/actor.test-helper.js';
import {
  grantServer,
  seedBackend,
  seedBackendPool,
  seedPool,
  seedServer,
  seedUser,
} from '../iam/access.pg-test-helper.js';
import { listPoolAccess, resolvePoolAccess } from '../iam/effective-access.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { DataDiskGrantsService } from './data-disk-grants.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

type Db = Kysely<NyabaseDatabase>;

async function setup(database: Db) {
  const changes = new AccessChangeNotifier();
  let signals = 0;
  changes.onChange(() => { signals += 1; });
  const audit = { append: vi.fn(async () => undefined) };
  const service = new DataDiskGrantsService(database, new PgTransactionManager(database), audit as never, changes);
  const actor = testActor(await seedUser(database, undefined, UserStatus.Active, Role.UserAdmin), Role.UserAdmin);
  const userId = await seedUser(database);
  const serverId = await seedServer(database);
  const pools = [await seedPool(database, serverId), await seedPool(database, serverId), await seedPool(database, serverId)];
  await grantServer(database, { user: userId }, serverId);
  return { service, audit, actor, userId, serverId, pools, signals: () => signals };
}

const GiB = 1024 ** 3;

describePg('DataDiskGrantsService', () => {
  it('gives several disks of one server one shared quota', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, actor, userId, serverId, pools, signals } = await setup(database);
      const change = await service.create(actor, userId, { serverId, poolIds: pools, limitBytes: 1000 * GiB });
      expect(change).toMatchObject({
        grant: { userId, serverId, poolIds: [...pools].sort(), limitBytes: 1000 * GiB },
        movedPools: [],
        deletedGrantIds: [],
        revokedPoolIds: [],
      });
      expect(signals()).toBe(1);
      const access = await listPoolAccess(database, userId);
      expect(access.map((row) => [row.poolId, row.limitBytes, row.dataDiskGrantId]).sort())
        .toEqual(pools.map((poolId) => [poolId, 1000 * GiB, change.grant!.id]).sort());
      await expect(service.list(userId)).resolves.toEqual([change.grant]);
    });
  });

  it('refuses a disk another grant holds unless asked to move it, then moves it without a gap in coverage', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, audit, actor, userId, serverId, pools } = await setup(database);
      const [a, b, c] = pools as [string, string, string];
      const shared = await service.create(actor, userId, { serverId, poolIds: [a, b, c], limitBytes: 1000 * GiB });

      await expect(service.create(actor, userId, { serverId, poolIds: [a], limitBytes: 2000 * GiB }))
        .rejects.toMatchObject({
          status: 409,
          response: { code: FailureCode.DataDiskPoolGranted, details: { pools: [{ poolId: a, grantId: shared.grant!.id }] } },
        });
      // Nothing changed.
      await expect(resolvePoolAccess(database, userId, a)).resolves.toMatchObject({ dataDiskGrantId: shared.grant!.id });

      const alone = await service.create(actor, userId, { serverId, poolIds: [a], limitBytes: 2000 * GiB, movePools: true });
      expect(alone).toMatchObject({
        grant: { poolIds: [a], limitBytes: 2000 * GiB },
        movedPools: [{ poolId: a, fromGrantId: shared.grant!.id }],
        deletedGrantIds: [],
      });
      await expect(resolvePoolAccess(database, userId, a))
        .resolves.toMatchObject({ limitBytes: 2000 * GiB, dataDiskGrantId: alone.grant!.id });
      await expect(resolvePoolAccess(database, userId, b))
        .resolves.toMatchObject({ limitBytes: 1000 * GiB, dataDiskGrantId: shared.grant!.id });
      expect(audit.append).toHaveBeenLastCalledWith(
        expect.anything(),
        actor.userId,
        AuditAction.CreateDataDiskGrant,
        userId,
        'user',
        expect.objectContaining({ movedPools: [{ poolId: a, fromGrantId: shared.grant!.id }] }),
      );
    });
  });

  it('deletes a grant its last disks moved out of', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, actor, userId, serverId, pools } = await setup(database);
      const [a, b] = pools as [string, string];
      const first = await service.create(actor, userId, { serverId, poolIds: [a, b], limitBytes: 100 * GiB });
      const second = await service.create(actor, userId, {
        serverId, poolIds: [a, b], limitBytes: 300 * GiB, movePools: true,
      });
      expect(second.deletedGrantIds).toEqual([first.grant!.id]);
      await expect(database.selectFrom('iam.data_disk_grants').select('id').execute())
        .resolves.toEqual([{ id: second.grant!.id }]);
    });
  });

  it('patches the quota and the disk set; a disk left out is revoked, one taken from elsewhere moves', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, actor, userId, serverId, pools } = await setup(database);
      const [a, b, c] = pools as [string, string, string];
      const ab = await service.create(actor, userId, { serverId, poolIds: [a, b], limitBytes: 100 * GiB });
      const onlyC = await service.create(actor, userId, { serverId, poolIds: [c], limitBytes: 50 * GiB });

      const quota = await service.patch(actor, userId, ab.grant!.id, { limitBytes: 10 * GiB });
      expect(quota.grant).toMatchObject({ poolIds: [a, b].sort(), limitBytes: 10 * GiB });

      await expect(service.patch(actor, userId, ab.grant!.id, { poolIds: [a, c] }))
        .rejects.toMatchObject({ response: { code: FailureCode.DataDiskPoolGranted } });
      const regrouped = await service.patch(actor, userId, ab.grant!.id, { poolIds: [a, c], movePools: true });
      expect(regrouped).toMatchObject({
        grant: { poolIds: [a, c].sort(), limitBytes: 10 * GiB },
        movedPools: [{ poolId: c, fromGrantId: onlyC.grant!.id }],
        deletedGrantIds: [onlyC.grant!.id],
        revokedPoolIds: [b],
      });
      await expect(resolvePoolAccess(database, userId, b)).resolves.toBeNull();
      await expect(service.patch(actor, userId, randomUUID(), { limitBytes: 1 }))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  it('revokes every disk of a deleted grant', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, actor, userId, serverId, pools } = await setup(database);
      const created = await service.create(actor, userId, { serverId, poolIds: pools.slice(0, 2), limitBytes: GiB });
      const deleted = await service.delete(actor, userId, created.grant!.id);
      expect(deleted).toEqual({
        grant: null, movedPools: [], deletedGrantIds: [], revokedPoolIds: pools.slice(0, 2).sort(),
      });
      await expect(listPoolAccess(database, userId)).resolves.toEqual([]);
      await expect(database.selectFrom('iam.storage_pool_grants').select('id').execute()).resolves.toEqual([]);
    });
  });

  it('only takes local pools of a server the user holds a bundle on', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, actor, userId, serverId, pools } = await setup(database);
      const otherServer = await seedServer(database);
      const otherPool = await seedPool(database, otherServer);
      const sharedPool = await seedBackendPool(database, serverId, await seedBackend(database));
      await expect(service.create(actor, userId, { serverId: otherServer, poolIds: [otherPool], limitBytes: GiB }))
        .rejects.toMatchObject({ status: 409, response: { code: FailureCode.ServerGrantRequired } });
      await expect(service.create(actor, userId, { serverId, poolIds: [pools[0]!, otherPool], limitBytes: GiB }))
        .rejects.toMatchObject({ status: 404, response: { details: { poolIds: [otherPool] } } });
      await expect(service.create(actor, userId, { serverId, poolIds: [sharedPool], limitBytes: GiB }))
        .rejects.toMatchObject({ status: 404 });
      await expect(service.create(testActor(userId), userId, { serverId, poolIds: [pools[0]!], limitBytes: GiB }))
        .rejects.toMatchObject({ response: { code: 'ROLE_REQUIRED' } });
      await expect(database.selectFrom('iam.data_disk_grants').select('id').execute()).resolves.toEqual([]);
    });
  });

  it('keeps one membership per (user, pool) in the database', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { service, actor, userId, serverId, pools } = await setup(database);
      const grant = await service.create(actor, userId, { serverId, poolIds: [pools[0]!], limitBytes: GiB });
      const serverGrant = await database.selectFrom('iam.server_grants').select('id').executeTakeFirstOrThrow();
      await expect(database.insertInto('iam.storage_pool_grants').values({
        id: randomUUID(),
        server_grant_id: serverGrant.id,
        data_disk_grant_id: grant.grant!.id,
        user_id: userId,
        server_id: serverId,
        pool_id: pools[0]!,
      }).execute()).rejects.toMatchObject({ code: '23505' });
    });
  });
});
