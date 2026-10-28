import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { pickGrantGpus } from '../grants/grant-fields.js';
import {
  days,
  grantBackend,
  grantPool,
  grantServer,
  observeGpus,
  seedBackend,
  seedBundle,
  seedPool,
  seedServer,
  seedUser,
} from './access.pg-test-helper.js';
import {
  listPoolAccess,
  listServerAccess,
  loadServerAccessKeys,
  resolvePoolAccess,
  resolveServerAccess,
  resolveSharedBackendAccess,
} from './effective-access.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

const CARDS = Array.from({ length: 8 }, (_, index) => `00000000:${(0x10 + index).toString(16)}:00.0`);

describePg('iam.effective_server_access', () => {
  it('reads every non-overridden quota from the bundle, live', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const bundleId = await seedBundle(database, serverId, {
        cpuCores: 16, memBytes: 32, rootDiskBytes: 100, gpuCount: 0,
      });
      await grantServer(database, { user: userId }, serverId, { bundleId });

      await expect(resolveServerAccess(database, userId, serverId)).resolves.toMatchObject({
        cpuCores: 16, memBytes: 32, rootDiskBytes: 100, gpuCount: 0, gpuPciAddresses: [], expiresAt: null,
      });
      await database.updateTable('iam.grant_bundles')
        .set({ root_disk_bytes: 300, cpu_cores: null })
        .where('id', '=', bundleId)
        .execute();
      await expect(resolveServerAccess(database, userId, serverId)).resolves.toMatchObject({
        cpuCores: null, memBytes: 32, rootDiskBytes: 300,
      });
    });
  });

  it('takes an override where the grant has one, including an unlimited (NULL) one', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const bundleId = await seedBundle(database, serverId, {
        cpuCores: 16, memBytes: 32, rootDiskBytes: 100, gpuCount: 2,
      });
      const grantId = await grantServer(database, { user: userId }, serverId, { bundleId });
      await database.updateTable('iam.server_grants')
        .set({ overridden: ['root_disk', 'mem'], root_disk_bytes: 300, mem_bytes: null })
        .where('id', '=', grantId)
        .execute();

      await expect(resolveServerAccess(database, userId, serverId)).resolves.toMatchObject({
        cpuCores: 16, memBytes: null, rootDiskBytes: 300, gpuCount: 2,
      });
      // The bundle no longer reaches overridden fields.
      await database.updateTable('iam.grant_bundles')
        .set({ root_disk_bytes: 50, mem_bytes: 64, cpu_cores: 8 })
        .where('id', '=', bundleId)
        .execute();
      await expect(resolveServerAccess(database, userId, serverId)).resolves.toMatchObject({
        cpuCores: 8, memBytes: null, rootDiskBytes: 300,
      });
    });
  });

  it('refuses override values for fields that are not overridden, and unknown field tokens', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const grantId = await grantServer(database, { user: userId }, serverId);
      await expect(database.updateTable('iam.server_grants')
        .set({ cpu_cores: 4 })
        .where('id', '=', grantId)
        .execute()).rejects.toMatchObject({ code: '23514' });
      await expect(database.updateTable('iam.server_grants')
        .set({ overridden: ['disk'] })
        .where('id', '=', grantId)
        .execute()).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('keeps a grant on its bundle\'s server (composite foreign key)', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const otherServerId = await seedServer(database);
      const otherBundle = await seedBundle(database, otherServerId);
      await expect(grantServer(database, { user: userId }, serverId, { bundleId: otherBundle }))
        .rejects.toMatchObject({ code: '23503' });
    });
  });

  it('picks the GPUs by md5(user, card) from the observed cards, as pickGrantGpus does', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      await observeGpus(database, serverId, CARDS);
      const users = await Promise.all(Array.from({ length: 6 }, () => seedUser(database)));
      const bundleId = await seedBundle(database, serverId, { gpuCount: 3 });
      for (const userId of users) await grantServer(database, { user: userId }, serverId, { bundleId });

      const picks = new Set<string>();
      for (const userId of users) {
        const access = await resolveServerAccess(database, userId, serverId);
        expect(access?.gpuPciAddresses).toEqual(pickGrantGpus(userId, CARDS, 3));
        expect(access?.gpuPciAddresses).toHaveLength(3);
        picks.add(access!.gpuPciAddresses.join(','));
      }
      // The choice depends on the user: six users do not all land on the same three cards.
      expect(picks.size).toBeGreaterThan(1);
    });
  });

  it('keeps the cards already picked when the count grows, and drops the lowest-ranked when it shrinks', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      await observeGpus(database, serverId, CARDS);
      const bundleId = await seedBundle(database, serverId, { gpuCount: 2 });
      await grantServer(database, { user: userId }, serverId, { bundleId });
      const two = (await resolveServerAccess(database, userId, serverId))!.gpuPciAddresses;

      await database.updateTable('iam.grant_bundles').set({ gpu_count: 5 }).where('id', '=', bundleId).execute();
      const five = (await resolveServerAccess(database, userId, serverId))!.gpuPciAddresses;
      expect(five).toHaveLength(5);
      expect(five).toEqual(expect.arrayContaining(two));

      await database.updateTable('iam.grant_bundles').set({ gpu_count: 3 }).where('id', '=', bundleId).execute();
      const three = (await resolveServerAccess(database, userId, serverId))!.gpuPciAddresses;
      expect(three).toEqual(expect.arrayContaining(two));
      expect(five).toEqual(expect.arrayContaining(three));
      expect(three).toEqual(pickGrantGpus(userId, CARDS, 3));

      await database.updateTable('iam.grant_bundles').set({ gpu_count: null }).where('id', '=', bundleId).execute();
      expect((await resolveServerAccess(database, userId, serverId))!.gpuPciAddresses).toEqual(CARDS);

      await database.updateTable('iam.grant_bundles').set({ gpu_count: 20 }).where('id', '=', bundleId).execute();
      expect((await resolveServerAccess(database, userId, serverId))!.gpuPciAddresses).toEqual(CARDS);

      await database.updateTable('iam.grant_bundles').set({ gpu_count: 0 }).where('id', '=', bundleId).execute();
      expect((await resolveServerAccess(database, userId, serverId))!.gpuPciAddresses).toEqual([]);
    });
  });

  it('moves only the users a vanished card ranked for', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      await observeGpus(database, serverId, CARDS);
      const bundleId = await seedBundle(database, serverId, { gpuCount: 2 });
      const users = await Promise.all(Array.from({ length: 10 }, () => seedUser(database)));
      for (const userId of users) await grantServer(database, { user: userId }, serverId, { bundleId });
      const before = new Map<string, string[]>();
      for (const userId of users) {
        before.set(userId, (await resolveServerAccess(database, userId, serverId))!.gpuPciAddresses);
      }
      const gone = CARDS[3]!;
      await observeGpus(database, serverId, CARDS.filter((card) => card !== gone));
      for (const userId of users) {
        const after = (await resolveServerAccess(database, userId, serverId))!.gpuPciAddresses;
        const had = before.get(userId)!;
        if (had.includes(gone)) {
          expect(after.filter((card) => had.includes(card))).toEqual(had.filter((card) => card !== gone));
          expect(after).toHaveLength(2);
        } else {
          expect(after).toEqual(had);
        }
      }
    });
  });

  it('exposes no coverage once the grant expired', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const otherServerId = await seedServer(database);
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(-3) });
      const later = days(9);
      await grantServer(database, { user: userId }, otherServerId, { expiresAt: later });

      await expect(resolveServerAccess(database, userId, serverId)).resolves.toBeNull();
      expect((await listServerAccess(database, userId)).map((access) => access.serverId)).toEqual([otherServerId]);
      expect((await resolveServerAccess(database, userId, otherServerId))?.expiresAt?.getTime())
        .toBe(later.getTime());
    });
  });

  it('excludes disabled, deleting and deleted users', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      const bundleId = await seedBundle(database, serverId);
      const active = await seedUser(database);
      const disabled = await seedUser(database, undefined, UserStatus.Disabled);
      const deleting = await seedUser(database, undefined, UserStatus.Deleting);
      const deleted = await seedUser(database, undefined, UserStatus.Deleted);
      for (const userId of [active, disabled, deleting, deleted]) {
        await grantServer(database, { user: userId }, serverId, { bundleId });
      }

      const keys = await loadServerAccessKeys(database);
      expect(keys).toEqual(new Set([`${active}\0${serverId}`]));
      await database.updateTable('iam.users')
        .set({ status: UserStatus.Active })
        .where('id', '=', disabled)
        .execute();
      await expect(resolveServerAccess(database, disabled, serverId)).resolves.not.toBeNull();
    });
  });

  it('never mixes users or servers', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const a = await seedUser(database);
      const b = await seedUser(database);
      const one = await seedServer(database);
      const two = await seedServer(database);
      await grantServer(database, { user: a }, one, { cpuCores: 1 });
      await grantServer(database, { user: b }, two, { cpuCores: 2 });

      await expect(resolveServerAccess(database, a, two)).resolves.toBeNull();
      await expect(resolveServerAccess(database, b, one)).resolves.toBeNull();
      expect((await resolveServerAccess(database, a, one))?.cpuCores).toBe(1);
    });
  });
});

describePg('iam.effective_pool_access and iam.effective_shared_backend_access', () => {
  it('makes a data-disk grant current exactly while its server grant is, with its own quota', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const otherPoolId = await seedPool(database, serverId);
      const grantId = await grantServer(database, { user: userId }, serverId, { expiresAt: days(7) });
      await grantPool(database, { user: userId }, poolId, 500);
      await grantPool(database, { user: userId }, otherPoolId, null);

      await expect(resolvePoolAccess(database, userId, poolId)).resolves.toMatchObject({ limitBytes: 500 });
      expect((await listPoolAccess(database, userId)).map((access) => access.limitBytes).sort())
        .toEqual([500, null]);

      await database.updateTable('iam.server_grants')
        .set({ expires_at: days(-1) })
        .where('id', '=', grantId)
        .execute();
      await expect(resolvePoolAccess(database, userId, poolId)).resolves.toBeNull();
      await expect(listPoolAccess(database, userId)).resolves.toEqual([]);

      await database.updateTable('iam.server_grants').set({ expires_at: null }).where('id', '=', grantId).execute();
      await database.deleteFrom('iam.server_grants').where('id', '=', grantId).execute();
      await expect(database.selectFrom('iam.storage_pool_grants').select('id').execute()).resolves.toEqual([]);
    });
  });

  it('keeps a data-disk grant on a pool of its server grant\'s server', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const otherServerId = await seedServer(database);
      const foreignPool = await seedPool(database, otherServerId);
      const grantId = await grantServer(database, { user: userId }, serverId);
      await expect(database.insertInto('iam.storage_pool_grants').values({
        id: randomUUID(),
        server_grant_id: grantId,
        user_id: userId,
        server_id: serverId,
        pool_id: foreignPool,
        limit_bytes: null,
      }).execute()).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('excludes disabled users from pool coverage', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database, undefined, UserStatus.Disabled);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      await grantServer(database, { user: userId }, serverId);
      await grantPool(database, { user: userId }, poolId);
      await expect(resolvePoolAccess(database, userId, poolId)).resolves.toBeNull();
    });
  });

  it('reads one shared-backend grant per user, NULL meaning unlimited', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const backendId = await seedBackend(database);
      const unlimitedBackendId = await seedBackend(database);
      await grantBackend(database, { user: userId }, backendId, 300);
      await grantBackend(database, { user: userId }, unlimitedBackendId, null);

      await expect(resolveSharedBackendAccess(database, userId, backendId))
        .resolves.toMatchObject({ limitBytes: 300, expiresAt: null });
      await expect(resolveSharedBackendAccess(database, userId, unlimitedBackendId))
        .resolves.toMatchObject({ limitBytes: null });
      await expect(grantBackend(database, { user: userId }, backendId, 5)).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('keeps expired backend grants out and excludes disabled users', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const disabled = await seedUser(database, undefined, UserStatus.Disabled);
      const backendId = await seedBackend(database);
      await grantBackend(database, { user: userId }, backendId, 900, days(-1));
      await grantBackend(database, { user: disabled }, backendId, 5);

      await expect(resolveSharedBackendAccess(database, userId, backendId)).resolves.toBeNull();
      await expect(resolveSharedBackendAccess(database, disabled, backendId)).resolves.toBeNull();
      const views = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM iam.effective_shared_backend_access
      `.execute(database);
      expect(views.rows[0]?.count).toBe('0');
    });
  });
});
