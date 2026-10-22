import { sql } from 'kysely';
import { UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import {
  addMember,
  days,
  grantBackend,
  grantPool,
  grantServer,
  seedBackend,
  seedGroup,
  seedPool,
  seedServer,
  seedUser,
} from './access.pg-test-helper.js';
import {
  listServerAccess,
  loadServerAccessKeys,
  resolvePoolAccess,
  resolveServerAccess,
  resolveSharedBackendAccess,
} from './effective-access.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('iam.effective_server_access', () => {
  it('merges a direct grant and several group grants per dimension by maximum', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const groupA = await seedGroup(database);
      const groupB = await seedGroup(database);
      await addMember(database, groupA, userId);
      await addMember(database, groupB, userId);
      await grantServer(database, { user: userId }, serverId, {
        cpuCores: 2, memBytes: 8, diskBytes: 100,
      });
      await grantServer(database, { group: groupA }, serverId, {
        cpuCores: 4, memBytes: 4, diskBytes: 300,
      });
      await grantServer(database, { group: groupB }, serverId, {
        cpuCores: 1, memBytes: 16, diskBytes: 200,
      });

      await expect(resolveServerAccess(database, userId, serverId)).resolves.toMatchObject({
        cpuCores: 4,
        memBytes: 16,
        diskBytes: 300,
        gpuPciAddresses: [],
        expiresAt: null,
      });
    });
  });

  it('lets a NULL (unlimited) quota win per dimension', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      await grantServer(database, { user: userId }, serverId, {
        cpuCores: null, memBytes: 8, diskBytes: 100,
      });
      await grantServer(database, { group }, serverId, {
        cpuCores: 4, memBytes: null, diskBytes: null,
      });

      await expect(resolveServerAccess(database, userId, serverId)).resolves.toMatchObject({
        cpuCores: null,
        memBytes: null,
        diskBytes: null,
      });
    });
  });

  it('unions GPU whitelists as a distinct, sorted list', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      await grantServer(database, { user: userId }, serverId, {
        gpu: ['0000:81:00.0', '0000:01:00.0'],
      });
      await grantServer(database, { group }, serverId, {
        gpu: ['0000:41:00.0', '0000:01:00.0'],
      });

      const access = await resolveServerAccess(database, userId, serverId);
      expect(access?.gpuPciAddresses).toEqual(['0000:01:00.0', '0000:41:00.0', '0000:81:00.0']);
    });
  });

  it('takes the latest expiry, and never-expiring wins over any date', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const otherServerId = await seedServer(database);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      const soon = days(2);
      const later = days(9);
      await grantServer(database, { user: userId }, serverId, { expiresAt: soon });
      await grantServer(database, { group }, serverId, { expiresAt: later });
      await grantServer(database, { user: userId }, otherServerId, { expiresAt: soon });
      await grantServer(database, { group }, otherServerId, { expiresAt: null });

      expect((await resolveServerAccess(database, userId, serverId))?.expiresAt?.getTime())
        .toBe(later.getTime());
      expect((await resolveServerAccess(database, userId, otherServerId))?.expiresAt).toBeNull();
    });
  });

  it('ignores an expired grant while another grant is current, quotas included', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      await grantServer(database, { user: userId }, serverId, {
        cpuCores: 64, diskBytes: 9_999, gpu: ['0000:01:00.0'], expiresAt: days(-1),
      });
      await grantServer(database, { group }, serverId, {
        cpuCores: 2, diskBytes: 100, gpu: ['0000:02:00.0'], expiresAt: days(5),
      });

      const access = await resolveServerAccess(database, userId, serverId);
      expect(access).toMatchObject({ cpuCores: 2, diskBytes: 100 });
      expect(access?.gpuPciAddresses).toEqual(['0000:02:00.0']);
    });
  });

  it('exposes no coverage at all in the views when every grant is expired', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      await grantServer(database, { user: userId }, serverId, { expiresAt: days(-10) });
      await grantServer(database, { group }, serverId, { expiresAt: days(-3) });

      await expect(resolveServerAccess(database, userId, serverId)).resolves.toBeNull();
      await expect(listServerAccess(database, userId)).resolves.toEqual([]);
      await expect(database.selectFrom('iam.effective_server_access').select('user_id').execute())
        .resolves.toEqual([]);
    });
  });

  it('excludes disabled, deleting and deleted users and drops revoked group membership', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      const group = await seedGroup(database);
      const active = await seedUser(database);
      const disabled = await seedUser(database, undefined, UserStatus.Disabled);
      const deleting = await seedUser(database, undefined, UserStatus.Deleting);
      const deleted = await seedUser(database, undefined, UserStatus.Deleted);
      for (const userId of [active, disabled, deleting, deleted]) {
        await addMember(database, group, userId);
      }
      await grantServer(database, { group }, serverId);
      await grantServer(database, { user: disabled }, serverId);

      const keys = await loadServerAccessKeys(database);
      expect(keys).toEqual(new Set([`${active}\0${serverId}`]));

      await database.deleteFrom('iam.group_members')
        .where('user_id', '=', active)
        .execute();
      await expect(resolveServerAccess(database, active, serverId)).resolves.toBeNull();

      await expect(resolveServerAccess(database, disabled, serverId)).resolves.toBeNull();
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
  it('merges pool admission across user and group grants with the latest expiry', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const otherPoolId = await seedPool(database, serverId);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      const later = days(7);
      await grantPool(database, { user: userId }, poolId, days(1));
      await grantPool(database, { group }, poolId, later);
      await grantPool(database, { user: userId }, otherPoolId, days(-2));

      expect((await resolvePoolAccess(database, userId, poolId))?.expiresAt?.getTime())
        .toBe(later.getTime());
      await expect(resolvePoolAccess(database, userId, otherPoolId)).resolves.toBeNull();
    });
  });

  it('merges shared-backend limits by maximum with NULL meaning unlimited', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const backendId = await seedBackend(database);
      const unlimitedBackendId = await seedBackend(database);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      await grantBackend(database, { user: userId }, backendId, 100);
      await grantBackend(database, { group }, backendId, 300);
      await grantBackend(database, { user: userId }, unlimitedBackendId, 100);
      await grantBackend(database, { group }, unlimitedBackendId, null);

      await expect(resolveSharedBackendAccess(database, userId, backendId))
        .resolves.toMatchObject({ limitBytes: 300, expiresAt: null });
      await expect(resolveSharedBackendAccess(database, userId, unlimitedBackendId))
        .resolves.toMatchObject({ limitBytes: null });
    });
  });

  it('keeps expired backend grants out of the current merge and excludes disabled users', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const disabled = await seedUser(database, undefined, UserStatus.Disabled);
      const backendId = await seedBackend(database);
      const group = await seedGroup(database);
      await addMember(database, group, userId);
      await grantBackend(database, { user: userId }, backendId, 900, days(-1));
      await grantBackend(database, { group }, backendId, null, days(-2));
      await grantBackend(database, { user: disabled }, backendId, 5);

      await expect(resolveSharedBackendAccess(database, userId, backendId)).resolves.toBeNull();
      await expect(resolveSharedBackendAccess(database, disabled, backendId)).resolves.toBeNull();
      const views = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM iam.effective_shared_backend_access
      `.execute(database);
      // The only current grant belongs to a disabled user, so the active-only view is empty.
      expect(views.rows[0]?.count).toBe('0');
    });
  });
});
