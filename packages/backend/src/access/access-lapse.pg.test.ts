import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { AuditAction, GRANT_EXPIRY_GRACE_DAYS, UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import {
  addMember,
  days,
  grantBackend,
  grantPool,
  grantServer,
  seedAttachment,
  seedBackend,
  seedBackendPool,
  seedContainer,
  seedGroup,
  seedImage,
  seedPool,
  seedServer,
  seedUser,
  seedVolume,
} from '../iam/access.pg-test-helper.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { ReconcileClaimRepository } from '../reconcile/reconcile-claim.repository.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';
import { VolumesRepository } from '../volumes/volumes.repository.js';
import { AccessLapseProcessor } from './access-lapse.processor.js';
import { AccessLapseRepository } from './access-lapse.repository.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;

async function fixture(database: Kysely<NyabaseDatabase>) {
  const transactions = new PgTransactionManager(database);
  const claims = new ReconcileClaimRepository(database);
  const changes = new AccessChangeNotifier();
  // Real repositories, real purge service; only the container power/delete
  // endpoint is replaced by a recorder (it would talk to Incus intents).
  const actions: Array<{ id: string; action: string; actorIsSystem: boolean }> = [];
  const containers = {
    action: vi.fn(async (actor: { authKind: string }, id: string, action: string) => {
      actions.push({ id, action, actorIsSystem: actor.authKind === 'system' });
      // The real endpoint records the desired power state.
      if (action === 'stop') {
        await database.updateTable('control.containers').set({ power_intent: 'stopped' })
          .where('id', '=', id).execute();
      }
      return { intentId: randomUUID() };
    }),
  };
  const audit = { append: vi.fn(async () => undefined) };
  const proxySnapshots = { notify: vi.fn(async () => undefined) };
  const purge = new UserServerResourcePurgeService(
    transactions,
    new ContainerControlRepository(database),
    containers as never,
    new VolumesRepository(database),
    new IntentRepository(database, noopWake()),
    claims,
    audit as never,
  );
  const processor = new AccessLapseProcessor(
    new AccessLapseRepository(database, transactions),
    claims,
    purge,
    audit as never,
    changes,
    proxySnapshots as never,
  );
  return { processor, claims, changes, actions, audit, transactions, proxySnapshots };
}

async function ledger(database: Kysely<NyabaseDatabase>, userId?: string) {
  let query = database.selectFrom('control.access_lapses').selectAll().orderBy('resource_kind');
  if (userId) query = query.where('user_id', '=', userId);
  return query.execute();
}

async function world(database: Kysely<NyabaseDatabase>) {
  const userId = await seedUser(database);
  const serverId = await seedServer(database);
  const poolId = await seedPool(database, serverId);
  const imageId = await seedImage(database);
  return { userId, serverId, poolId, imageId };
}

describePg('access lapse processor', () => {
  it('opens the grace at detection time, stops containers once, and never moves lapsed_at', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions, audit, proxySnapshots } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(-2) });
      const running = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      const stopped = await seedContainer(database, { ownerId: userId, serverId, poolId, imageId });

      const before = Date.now();
      await expect(processor.process()).resolves.toBe(1);

      const rows = await ledger(database, userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ resource_kind: 'server', resource_id: serverId, purged_at: null });
      // The old expiry is not the lapse time: the grace starts at detection.
      expect(rows[0]!.lapsed_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(rows[0]!.lapsed_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
      expect(rows[0]!.stopped_at).not.toBeNull();
      expect(actions).toEqual([{ id: running, action: 'stop', actorIsSystem: true }]);
      expect(proxySnapshots.notify).toHaveBeenCalledTimes(1);
      expect(actions.some((entry) => entry.id === stopped)).toBe(false);
      expect(audit.append).toHaveBeenCalledWith(
        expect.anything(), null, AuditAction.GrantExpired, userId, 'user',
        expect.objectContaining({ resourceKind: 'server', resourceId: serverId }),
      );

      // Later scans neither stop again nor move lapsed_at.
      const first = rows[0]!.lapsed_at.getTime();
      await expect(processor.process()).resolves.toBe(0);
      expect(actions).toHaveLength(1);
      expect((await ledger(database, userId))[0]!.lapsed_at.getTime()).toBe(first);
    });
  });

  it('purges containers and local volumes of the server once the 14 days are over', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      const otherServer = await seedServer(database);
      const otherPool = await seedPool(database, otherServer);
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(-20) });
      // The grace opened more than 14 days ago.
      await database.insertInto('control.access_lapses').values({
        user_id: userId,
        resource_kind: 'server',
        resource_id: serverId,
        lapsed_at: new Date(Date.now() - (GRANT_EXPIRY_GRACE_DAYS + 1) * DAY_MS),
      }).execute();
      await grantServer(database, { user: userId }, otherServer);
      await grantPool(database, { user: userId }, poolId);
      await grantPool(database, { user: userId }, otherPool);
      const container = await seedContainer(database, { ownerId: userId, serverId, poolId, imageId });
      const keepContainer = await seedContainer(database, {
        ownerId: userId, serverId: otherServer, poolId: otherPool, imageId,
      });
      const volume = await seedVolume(database, { ownerId: userId, poolId, serverId });
      const keepVolume = await seedVolume(database, {
        ownerId: userId, poolId: otherPool, serverId: otherServer,
      });

      await expect(processor.process()).resolves.toBe(1);

      expect(actions).toEqual([{ id: container, action: 'delete', actorIsSystem: true }]);
      const row = (await ledger(database, userId))[0]!;
      expect(row.purged_at).not.toBeNull();
      expect(row.stopped_at).toBeNull();
      // The volume has no placement and no attachment: its row is removed outright.
      const volumes = await database.selectFrom('control.volumes').select('id').execute();
      expect(volumes.map((item) => item.id)).toEqual([keepVolume]);
      expect(volume).not.toBe(keepVolume);
      expect(keepContainer).toBeDefined();

      // Containers are deleted asynchronously; once nothing is left the row goes away.
      await database.deleteFrom('control.containers').where('id', '=', container).execute();
      await processor.process();
      expect(await ledger(database, userId)).toEqual([]);
    });
  });

  it('treats a revocation as an immediate lapse that starts at detection time', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      await grantServer(database, { user: userId }, serverId);
      const running = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      await expect(processor.process()).resolves.toBe(0);
      expect(await ledger(database)).toEqual([]);

      await database.deleteFrom('iam.server_grants').where('user_id', '=', userId).execute();
      const before = Date.now();
      await expect(processor.process()).resolves.toBe(1);

      const row = (await ledger(database, userId))[0]!;
      expect(row.lapsed_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(row.lapsed_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
      expect(actions).toEqual([{ id: running, action: 'stop', actorIsSystem: true }]);
      const firstLapse = row.lapsed_at.getTime();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await processor.process();
      expect((await ledger(database, userId))[0]!.lapsed_at.getTime()).toBe(firstLapse);
    });
  });

  it('cancels the grace when coverage returns and does not restart stopped containers', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(-1) });
      const container = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      await processor.process();
      expect(await ledger(database, userId)).toHaveLength(1);
      actions.length = 0;

      await grantServer(database, { group: await groupOf(database, userId) }, serverId);
      await expect(processor.process()).resolves.toBe(1);

      expect(await ledger(database, userId)).toEqual([]);
      expect(actions).toEqual([]);
      expect(container).toBeDefined();
      await expect(processor.process()).resolves.toBe(0);
    });
  });

  it('lapses when the user is removed from the covering group or the group is deleted, but not while another group covers', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      const groupA = await seedGroup(database);
      const groupB = await seedGroup(database);
      await addMember(database, groupA, userId);
      await addMember(database, groupB, userId);
      await grantServer(database, { group: groupA }, serverId);
      await grantServer(database, { group: groupB }, serverId);
      await seedContainer(database, { ownerId: userId, serverId, poolId, imageId, running: true });

      await database.deleteFrom('iam.group_members').where('group_id', '=', groupA).execute();
      await processor.process();
      expect(await ledger(database, userId)).toEqual([]);

      // Deleting the group takes its members and grants with it (foreign keys cascade).
      await database.deleteFrom('iam.groups').where('id', '=', groupB).execute();
      await expect(processor.process()).resolves.toBe(1);
      expect(await ledger(database, userId)).toHaveLength(1);
    });
  });

  it('opens a lapse for a disabled user on every resource kind and stops running containers there', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      const backendId = await seedBackend(database);
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, poolId);
      await grantBackend(database, { user: userId }, backendId, null);
      await seedBackendPool(database, serverId, backendId);
      const running = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      await seedVolume(database, { ownerId: userId, poolId, serverId });
      await seedVolume(database, { ownerId: userId, poolId: null, serverId: null, sharedBackendId: backendId });

      await database.updateTable('iam.users').set({ status: UserStatus.Disabled })
        .where('id', '=', userId).execute();
      const before = Date.now();
      await processor.process();

      const rows = await ledger(database, userId);
      expect(rows.map((row) => row.resource_kind).sort())
        .toEqual(['server', 'shared_backend', 'storage_pool']);
      for (const row of rows) {
        // Detection time, as for a revocation; stopped at once, not purged.
        expect(row.lapsed_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(row.stopped_at).not.toBeNull();
        expect(row.purged_at).toBeNull();
      }
      expect(actions.filter((entry) => entry.id === running && entry.action === 'stop').length)
        .toBeGreaterThanOrEqual(1);
      expect(actions.every((entry) => entry.action === 'stop' && entry.actorIsSystem)).toBe(true);
      expect(await database.selectFrom('control.volumes').select('id').execute()).toHaveLength(2);
    });
  });

  it('opens nothing when a disabled user owns no resources', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId } = await world(database);
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, poolId);
      await database.updateTable('iam.users').set({ status: UserStatus.Disabled })
        .where('id', '=', userId).execute();

      await expect(processor.process()).resolves.toBe(0);
      expect(await ledger(database)).toEqual([]);
      expect(actions).toEqual([]);
    });
  });

  it('scans a disabled user as uncovered on every resource kind', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, serverId, poolId } = await world(database);
      const backendId = await seedBackend(database);
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(30) });
      await grantPool(database, { user: userId }, poolId);
      await grantBackend(database, { user: userId }, backendId, null);
      await seedBackendPool(database, serverId, backendId);
      await seedVolume(database, { ownerId: userId, poolId, serverId });
      await seedVolume(database, { ownerId: userId, poolId: null, serverId: null, sharedBackendId: backendId });
      await database.updateTable('iam.users').set({ status: UserStatus.Disabled })
        .where('id', '=', userId).execute();
      const repository = new AccessLapseRepository(database, new PgTransactionManager(database));

      for (const [kind, resourceId] of [
        ['server', serverId], ['storage_pool', poolId], ['shared_backend', backendId],
      ] as const) {
        await expect(repository.inspect({ userId, kind, resourceId }))
          .resolves.toMatchObject({ covered: false, lapse: null });
      }
    });
  });

  it('opens every kind at detection time and ignores old expired grants, direct or via a group', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor } = await fixture(database);
      const { userId, serverId, poolId } = await world(database);
      const backendId = await seedBackend(database);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(-9) });
      await grantServer(database, { group }, serverId, { expiresAt: days(-4) });
      await grantPool(database, { group }, poolId, days(-9));
      await grantPool(database, { user: userId }, poolId, days(-4));
      await grantBackend(database, { user: userId }, backendId, null, days(-4));
      await grantBackend(database, { group }, backendId, 5, days(-9));
      await seedBackendPool(database, serverId, backendId);
      await seedVolume(database, { ownerId: userId, poolId, serverId });
      await seedVolume(database, { ownerId: userId, poolId: null, serverId: null, sharedBackendId: backendId });

      const before = Date.now();
      await processor.process();

      const rows = await ledger(database, userId);
      expect(rows.map((row) => row.resource_kind).sort())
        .toEqual(['server', 'shared_backend', 'storage_pool']);
      for (const row of rows) {
        expect(row.lapsed_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
        expect(row.lapsed_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
      }
    });
  });

  it('does not backdate a group removal to an old unrelated expired direct grant', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      const group = await groupOf(database, userId);
      // A direct grant that expired long ago, plus a current grant via the group.
      await grantServer(database, { user: userId }, serverId, {
        expiresAt: new Date(Date.now() - (GRANT_EXPIRY_GRACE_DAYS + 5) * DAY_MS),
      });
      await grantServer(database, { group }, serverId);
      await seedContainer(database, { ownerId: userId, serverId, poolId, imageId });
      await expect(processor.process()).resolves.toBe(0);

      await database.deleteFrom('iam.group_members').where('group_id', '=', group).execute();
      const before = Date.now();
      await processor.process();

      const row = (await ledger(database, userId))[0]!;
      expect(row.lapsed_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(row.purged_at).toBeNull();
      expect(actions.filter((entry) => entry.action === 'delete')).toEqual([]);
    });
  });

  it('stops a container again when it runs during the grace, keeping the first stopped_at', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(-1) });
      const container = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      await processor.process();
      const firstStop = (await ledger(database, userId))[0]!.stopped_at!.getTime();
      expect(actions).toEqual([{ id: container, action: 'stop', actorIsSystem: true }]);

      // Nothing runs: later passes do nothing.
      await expect(processor.process()).resolves.toBe(0);

      // An administrator starts it again during the grace.
      await database.updateTable('control.containers').set({ power_intent: 'running' })
        .where('id', '=', container).execute();
      await processor.process();

      expect(actions).toEqual([
        { id: container, action: 'stop', actorIsSystem: true },
        { id: container, action: 'stop', actorIsSystem: true },
      ]);
      expect((await ledger(database, userId))[0]!.stopped_at!.getTime()).toBe(firstStop);
    });
  });

  it('purges a disabled user\'s containers and volumes once the 14 days are over', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      await grantServer(database, { user: userId }, serverId);
      const container = await seedContainer(database, { ownerId: userId, serverId, poolId, imageId });
      await seedVolume(database, { ownerId: userId, poolId, serverId });
      await database.updateTable('iam.users').set({ status: UserStatus.Disabled })
        .where('id', '=', userId).execute();

      await processor.process();
      expect(actions).toEqual([]);
      expect((await ledger(database, userId)).every((row) => row.purged_at === null)).toBe(true);

      await database.updateTable('control.access_lapses')
        .set({ lapsed_at: new Date(Date.now() - (GRANT_EXPIRY_GRACE_DAYS + 1) * DAY_MS) })
        .execute();
      await processor.process();

      expect(actions).toEqual([{ id: container, action: 'delete', actorIsSystem: true }]);
      const server = (await ledger(database, userId)).find((row) => row.resource_kind === 'server');
      expect(server?.purged_at).not.toBeNull();
      // The volume has no placement and no attachment: its row is removed outright.
      expect(await database.selectFrom('control.volumes').select('id').execute()).toEqual([]);
    });
  });

  it('keeps processing a real expiry lapse while the user is disabled, purge included', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(-1) });
      const container = await seedContainer(database, { ownerId: userId, serverId, poolId, imageId });
      await processor.process();
      await database.updateTable('control.access_lapses')
        .set({ lapsed_at: new Date(Date.now() - (GRANT_EXPIRY_GRACE_DAYS + 1) * DAY_MS) })
        .where('user_id', '=', userId).execute();
      await database.updateTable('iam.users').set({ status: UserStatus.Disabled })
        .where('id', '=', userId).execute();

      await processor.process();

      expect(actions).toEqual([{ id: container, action: 'delete', actorIsSystem: true }]);
      expect((await ledger(database, userId))[0]!.purged_at).not.toBeNull();
    });
  });

  it('deletes the row and restarts nothing when a disabled user is enabled again within the grace', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      await grantServer(database, { user: userId }, serverId);
      const container = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      await database.updateTable('iam.users').set({ status: UserStatus.Disabled })
        .where('id', '=', userId).execute();
      await processor.process();
      expect(await ledger(database, userId)).toHaveLength(1);
      // The stop intent lands: the container is stopped.
      await database.updateTable('control.containers').set({ power_intent: 'stopped' })
        .where('id', '=', container).execute();
      actions.length = 0;

      await database.updateTable('iam.users').set({ status: UserStatus.Active })
        .where('id', '=', userId).execute();
      await processor.process();
      await processor.process();

      expect(actions).toEqual([]);
      expect((await database.selectFrom('control.containers').select('power_intent')
        .executeTakeFirstOrThrow()).power_intent).toBe('stopped');
      expect(await ledger(database)).toEqual([]);
    });
  });

  it('scopes a storage-pool lapse to containers using that pool and to that pool\'s volumes', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      const lapsedPool = await seedPool(database, serverId);
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, poolId);
      await grantPool(database, { user: userId }, lapsedPool, days(-1));
      const usesLapsedPool = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      const unrelated = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      const lapsedVolume = await seedVolume(database, { ownerId: userId, poolId: lapsedPool, serverId });
      const keptVolume = await seedVolume(database, { ownerId: userId, poolId, serverId });
      await seedAttachment(database, usesLapsedPool, lapsedVolume);

      await processor.process();

      const rows = await ledger(database, userId);
      expect(rows).toMatchObject([{ resource_kind: 'storage_pool', resource_id: lapsedPool }]);
      expect(actions).toEqual([{ id: usesLapsedPool, action: 'stop', actorIsSystem: true }]);
      expect(actions.some((entry) => entry.id === unrelated)).toBe(false);
      expect(keptVolume).toBeDefined();

      // After the grace: the pool's volume (and the containers using it) go, the rest stays.
      await database.updateTable('control.access_lapses')
        .set({ lapsed_at: new Date(Date.now() - (GRANT_EXPIRY_GRACE_DAYS + 1) * DAY_MS) })
        .execute();
      actions.length = 0;
      await processor.process();
      expect(actions).toEqual([{ id: usesLapsedPool, action: 'delete', actorIsSystem: true }]);
      const remaining = await database.selectFrom('control.volumes')
        .select(['id', 'lifecycle_phase']).execute();
      expect(remaining.find((row) => row.id === keptVolume)?.lifecycle_phase).toBe('active');
      expect(remaining.find((row) => row.id === lapsedVolume)?.lifecycle_phase)
        .not.toBe('active');
    });
  });

  it('scopes a shared-backend lapse to that backend\'s volumes and their containers', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      const backendId = await seedBackend(database);
      const otherBackendId = await seedBackend(database);
      await seedBackendPool(database, serverId, backendId);
      await seedBackendPool(database, serverId, otherBackendId);
      await grantServer(database, { user: userId }, serverId);
      await grantBackend(database, { user: userId }, backendId, null, days(-1));
      await grantBackend(database, { user: userId }, otherBackendId, null);
      const mounted = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      const other = await seedContainer(database, {
        ownerId: userId, serverId, poolId, imageId, running: true,
      });
      const lapsedVolume = await seedVolume(database, {
        ownerId: userId, poolId: null, serverId: null, sharedBackendId: backendId,
      });
      const keptVolume = await seedVolume(database, {
        ownerId: userId, poolId: null, serverId: null, sharedBackendId: otherBackendId,
      });
      await seedAttachment(database, mounted, lapsedVolume);
      await seedAttachment(database, other, keptVolume);

      await processor.process();
      expect(await ledger(database, userId)).toMatchObject([
        { resource_kind: 'shared_backend', resource_id: backendId },
      ]);
      expect(actions).toEqual([{ id: mounted, action: 'stop', actorIsSystem: true }]);

      await database.updateTable('control.access_lapses')
        .set({ lapsed_at: new Date(Date.now() - (GRACE_DAYS + 1) * DAY_MS) })
        .execute();
      actions.length = 0;
      await processor.process();
      expect(actions).toEqual([{ id: mounted, action: 'delete', actorIsSystem: true }]);
      const volumes = await database.selectFrom('control.volumes')
        .select(['id', 'lifecycle_phase']).execute();
      expect(volumes.find((row) => row.id === keptVolume)?.lifecycle_phase).toBe('active');
    });
  });

  it('keeps users independent and ignores users that own nothing on the resource', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      const bystander = await seedUser(database);
      const covered = await seedUser(database);
      await grantServer(database, { user: covered }, serverId);
      await seedContainer(database, { ownerId: userId, serverId, poolId, imageId, running: true });
      const safe = await seedContainer(database, {
        ownerId: covered, serverId, poolId, imageId, running: true,
      });

      await processor.process();

      expect((await ledger(database)).map((row) => row.user_id)).toEqual([userId]);
      expect(actions.some((entry) => entry.id === safe)).toBe(false);
      expect(bystander).toBeDefined();
    });
  });

  it('skips a pair that another worker holds the lease for, and releases its own lease', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, claims, actions } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      await seedContainer(database, { ownerId: userId, serverId, poolId, imageId, running: true });
      const held = await claims.claim({
        resourceType: 'access_lapse',
        resourceId: userId,
        placementServerId: serverId,
        workerId: 'access-lapse:other-replica',
      });
      expect(held).not.toBeNull();

      await expect(processor.process()).resolves.toBe(0);
      expect(await ledger(database)).toEqual([]);
      expect(actions).toEqual([]);

      await claims.release({
        resourceType: 'access_lapse',
        resourceId: userId,
        placementServerId: serverId,
        workerId: 'access-lapse:other-replica',
      });
      await expect(processor.process()).resolves.toBe(1);
      const left = await database.selectFrom('control.reconcile_claims')
        .select('resource_type').where('resource_type', '=', 'access_lapse').execute();
      expect(left).toEqual([]);
    });
  });

  it('runs a pass after an IAM change is signalled', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor, changes } = await fixture(database);
      const { userId, serverId, poolId, imageId } = await world(database);
      await grantServer(database, { user: userId }, serverId);
      await seedContainer(database, { ownerId: userId, serverId, poolId, imageId, running: true });
      processor.onModuleInit();
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await database.deleteFrom('iam.server_grants').where('user_id', '=', userId).execute();
        changes.notify();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((await ledger(database, userId)).length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(await ledger(database, userId)).toHaveLength(1);
      } finally {
        await processor.onModuleDestroy();
      }
    });
  });

  it('removes ledger rows for pairs that own nothing any more', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { processor } = await fixture(database);
      const { userId, serverId } = await world(database);
      await database.insertInto('control.access_lapses').values({
        user_id: userId,
        resource_kind: 'server',
        resource_id: serverId,
        lapsed_at: days(-3),
      }).execute();
      await processor.process();
      expect(await ledger(database)).toEqual([]);
    });
  });

  it('decides purely from the database: repository work items follow the 14-day rule', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, serverId, poolId, imageId } = await world(database);
      const repository = new AccessLapseRepository(database, new PgTransactionManager(database));
      await seedContainer(database, { ownerId: userId, serverId, poolId, imageId });
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(-20) });

      const [candidate] = await repository.scan();
      expect(candidate).toMatchObject({ covered: false, userId, kind: 'server', lapse: null });
    });
  });
});

const GRACE_DAYS = GRANT_EXPIRY_GRACE_DAYS;

async function groupOf(database: Kysely<NyabaseDatabase>, userId: string): Promise<string> {
  const group = await seedGroup(database);
  await addMember(database, group, userId);
  return group;
}
