import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { GRANT_EXPIRY_GRACE_DAYS } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import {
  addMember,
  days,
  grantBackend,
  grantServer,
  seedBackend,
  seedGroup,
  seedImage,
  seedServer,
  seedUser,
  seedVolume,
} from './access.pg-test-helper.js';
import { AccessResolverService } from './access-resolver.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function resolver(database: Kysely<NyabaseDatabase>) {
  return new AccessResolverService(database, new PgTransactionManager(database));
}

async function assign(
  database: Kysely<NyabaseDatabase>,
  imageId: string,
  serverId: string,
  overrides: { phase?: 'active' | 'provisioning' | 'deleting' | 'failed'; needsAttention?: boolean } = {},
) {
  await database.insertInto('infra.image_server_assignments').values({
    id: randomUUID(),
    image_id: imageId,
    server_id: serverId,
    revision: 1,
    observed_fingerprint: 'a'.repeat(64),
    managed_fingerprint: 'a'.repeat(64),
    lifecycle_phase: overrides.phase ?? 'active',
    needs_attention: overrides.needsAttention ?? false,
    failure_code: null,
    failure_reason: null,
    last_observed_at: new Date(),
  }).execute();
}

describePg('AccessResolverService', () => {
  it('makes an image visible only through a server the user currently covers (R8)', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const access = resolver(database);
      const userId = await seedUser(database);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      const covered = await seedServer(database);
      const expired = await seedServer(database);
      const unrelated = await seedServer(database);
      const viaGroup = await seedServer(database);
      const image = await seedImage(database);
      const onlyOnExpired = await seedImage(database);
      const inactiveAssignment = await seedImage(database);
      for (const serverId of [covered, unrelated, viaGroup]) await assign(database, image, serverId);
      await assign(database, onlyOnExpired, expired);
      await assign(database, inactiveAssignment, covered, { phase: 'provisioning' });
      await grantServer(database, { user: userId }, covered);
      await grantServer(database, { user: userId }, expired, { expiresAt: days(-1) });
      await grantServer(database, { group }, viaGroup);

      await expect(access.isImageAccessible(userId, image)).resolves.toBe(true);
      await expect(access.isImageAccessible(userId, onlyOnExpired)).resolves.toBe(false);
      await expect(access.isImageAccessible(userId, inactiveAssignment)).resolves.toBe(false);

      // Dropping both the direct and the group coverage hides the image again.
      await database.deleteFrom('iam.server_grants').where('server_id', 'in', [covered, viaGroup]).execute();
      await expect(access.isImageAccessible(userId, image)).resolves.toBe(false);
      const stranger = await seedUser(database);
      await expect(access.isImageAccessible(stranger, image)).resolves.toBe(false);
    });
  });

  it('allows images per server in the effective access projection', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const access = resolver(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const otherServer = await seedServer(database);
      const image = await seedImage(database);
      await assign(database, image, serverId);
      await grantServer(database, { user: userId }, serverId, { cpuCores: 4, memBytes: 8 });
      await grantServer(database, { user: await seedUser(database) }, otherServer);

      await expect(access.getEffectiveAccess(userId)).resolves.toEqual([{
        serverId,
        cpuCores: 4,
        memBytes: 8,
        diskBytes: null,
        gpuPciAddresses: [],
        expiresAt: null,
        purgeAt: null,
        accessPhase: 'live',
        allowedImageIds: [image],
      }]);
      await expect(access.listAccessibleServers(userId)).resolves.toEqual([serverId]);
    });
  });

  it('reports a lapsed server as grace with the purge date from the ledger, until it is purged', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const access = resolver(database);
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      await grantServer(database, { user: userId }, serverId, {
        cpuCores: 2, expiresAt: days(-1),
      });
      const lapsedAt = days(-1);
      await database.insertInto('control.access_lapses').values({
        user_id: userId, resource_kind: 'server', resource_id: serverId, lapsed_at: lapsedAt,
      }).execute();

      const [entry] = await access.getEffectiveAccess(userId);
      expect(entry).toMatchObject({ serverId, accessPhase: 'grace', cpuCores: 2 });
      expect(entry!.expiresAt).toBe(lapsedAt.toISOString());
      expect(entry!.purgeAt).toBe(
        new Date(lapsedAt.getTime() + GRANT_EXPIRY_GRACE_DAYS * 86_400_000).toISOString(),
      );
      await expect(access.listAccessibleServers(userId)).resolves.toEqual([]);

      // A revoked grant leaves no quotas to show, only the ledger.
      await database.deleteFrom('iam.server_grants').execute();
      expect((await access.getEffectiveAccess(userId))[0]).toMatchObject({
        accessPhase: 'grace', cpuCores: null,
      });

      await database.updateTable('control.access_lapses').set({ purged_at: new Date() }).execute();
      await expect(access.getEffectiveAccess(userId)).resolves.toEqual([]);
    });
  });

  it('projects shared-backend coverage with limits and booked usage; expired ones disappear', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const access = resolver(database);
      const userId = await seedUser(database);
      const limited = await seedBackend(database);
      const unlimited = await seedBackend(database);
      const expired = await seedBackend(database);
      await grantBackend(database, { user: userId }, limited, 1_000);
      await grantBackend(database, { user: userId }, unlimited, 0);
      await grantBackend(database, { user: userId }, expired, 5, days(-1));
      await seedVolume(database, {
        ownerId: userId, poolId: null, serverId: null, sharedBackendId: limited,
      });

      const shared = await access.getEffectiveSharedAccess(userId);
      expect(shared.map((row) => row.sharedBackendId).sort()).toEqual([limited, unlimited].sort());
      expect(shared.find((row) => row.sharedBackendId === limited))
        .toMatchObject({ limitBytes: 1_000, usedBytes: 100 });
      expect(shared.find((row) => row.sharedBackendId === unlimited))
        .toMatchObject({ limitBytes: null, usedBytes: 0 });
    });
  });

  it('lists group summaries by name and only for active users', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const access = resolver(database);
      const userId = await seedUser(database);
      const zed = await seedGroup(database, { name: 'zed' });
      const abc = await seedGroup(database, { name: 'abc' });
      await addMember(database, zed, userId);
      await addMember(database, abc, userId);

      const summaries = await access.getUserGroupSummaries(userId);
      expect(summaries.map((group) => group.name)).toEqual(['abc', 'zed']);
      expect(Object.keys(summaries[0]!).sort()).toEqual(['id', 'isSystem', 'name']);
      await database.updateTable('iam.users').set({ status: 'disabled' }).execute();
      await expect(access.getUserGroupSummaries(userId)).resolves.toEqual([]);
    });
  });
});
