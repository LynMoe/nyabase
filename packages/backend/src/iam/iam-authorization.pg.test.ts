import { ForbiddenException } from '@nestjs/common';
import { Capability, SystemGroupKey } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import { GrantsService } from '../groups/grants.service.js';
import { testActor } from './actor.test-helper.js';
import { AccessChangeNotifier, AccessResolverService } from './access-resolver.service.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import {
  addMember,
  grantServer,
  seedGroup,
  seedServer,
  seedUser,
} from './access.pg-test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('PostgreSQL canonical authorization', () => {
  function services(database: Parameters<typeof seedUser>[0]) {
    const transactions = new PgTransactionManager(database);
    const access = new AccessResolverService(database, transactions);
    const changes = new AccessChangeNotifier();
    const grants = new GrantsService(
      database,
      transactions,
      access,
      { append: async () => undefined } as never,
      new GpuClaimsRepository(database),
      changes,
    );
    return { access, grants, changes };
  }

  async function grantManager(database: Parameters<typeof seedUser>[0]): Promise<string> {
    const actor = await seedUser(database);
    const group = await seedGroup(database, { capabilities: [Capability.ManageGrants] });
    await addMember(database, group, actor);
    return actor;
  }

  it('merges a direct grant with group grants instead of picking a winner', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const groupId = await seedGroup(database);
      const serverId = await seedServer(database);
      await addMember(database, groupId, userId);
      await grantServer(database, { user: userId }, serverId, { diskBytes: 10 });
      await grantServer(database, { group: groupId }, serverId, { diskBytes: 20 });

      await expect(services(database).access.resolveServer(userId, serverId))
        .resolves.toMatchObject({ diskBytes: 20 });
    });
  });

  it('rejects an actor that lacks the capability being exercised', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedUser(database);
      const groupId = await seedGroup(database, { capabilities: [Capability.ManageUsers] });
      await addMember(database, groupId, actorId);

      await expect(database.transaction().execute((transaction) =>
        services(database).access.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGrants],
        ))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('uses one canonical row for repeated user-grant PUTs', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const actor = testActor(await grantManager(database));
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const input = {
        cpuMillis: null,
        memBytes: null,
        diskBytes: 10,
        gpuPciAddresses: [],
        expiresAt: null,
      };

      const first = await grants.putServerGrant(actor, { kind: 'user', id: userId }, serverId, input);
      const second = await grants.putServerGrant(actor, { kind: 'user', id: userId }, serverId, {
        ...input,
        diskBytes: 20,
      });
      expect(second.id).toBe(first.id);
      expect(await database.selectFrom('iam.server_grants')
        .select(['id', 'disk_bytes'])
        .where('user_id', '=', userId)
        .where('server_id', '=', serverId)
        .execute()).toEqual([{ id: first.id, disk_bytes: '20' }]);
    });
  });

  it('serves users and groups through the same grant functions', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const actor = testActor(await grantManager(database));
      const userId = await seedUser(database);
      const groupId = await seedGroup(database);
      const serverId = await seedServer(database);
      const input = {
        cpuMillis: 1_000, memBytes: null, diskBytes: null, gpuPciAddresses: [], expiresAt: null,
      };

      await grants.putServerGrant(actor, { kind: 'group', id: groupId }, serverId, input);
      await grants.putServerGrant(actor, { kind: 'user', id: userId }, serverId, input);
      await expect(grants.listServerGrants({ kind: 'group', id: groupId }))
        .resolves.toMatchObject([{ scope: 'group', scopeId: groupId, serverId }]);
      await expect(grants.listServerGrants({ kind: 'user', id: userId }))
        .resolves.toMatchObject([{ scope: 'user', scopeId: userId, serverId }]);

      await grants.deleteServerGrant(actor, { kind: 'group', id: groupId }, serverId);
      await expect(grants.listServerGrants({ kind: 'group', id: groupId })).resolves.toEqual([]);
      await expect(grants.listServerGrants({ kind: 'user', id: userId })).resolves.toHaveLength(1);
    });
  });

  it('refuses grant mutations from an actor without ManageGrants and for unknown holders', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const plain = testActor(await seedUser(database));
      const manager = testActor(await grantManager(database));
      const serverId = await seedServer(database);
      const userId = await seedUser(database);
      const input = {
        cpuMillis: null, memBytes: null, diskBytes: null, gpuPciAddresses: [], expiresAt: null,
      };

      await expect(grants.putServerGrant(plain, { kind: 'user', id: userId }, serverId, input))
        .rejects.toMatchObject({ response: { code: 'PRIVILEGE_ESCALATION_DENIED' } });
      await expect(grants.deleteServerGrant(plain, { kind: 'user', id: userId }, serverId))
        .rejects.toMatchObject({ response: { code: 'PRIVILEGE_ESCALATION_DENIED' } });
      await expect(grants.putServerGrant(
        manager,
        { kind: 'group', id: '00000000-0000-4000-8000-0000000000aa' },
        serverId,
        input,
      )).rejects.toMatchObject({ status: 404 });
    });
  });

  it('signals the access-lapse processor after a grant commits, not on failure', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants, changes } = services(database);
      const actor = testActor(await grantManager(database));
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      let signals = 0;
      changes.onChange(() => { signals += 1; });
      const input = {
        cpuMillis: null, memBytes: null, diskBytes: null, gpuPciAddresses: [], expiresAt: null,
      };

      await expect(grants.putServerGrant(
        actor,
        { kind: 'user', id: userId },
        '00000000-0000-4000-8000-0000000000bb',
        input,
      )).rejects.toMatchObject({ status: 404 });
      expect(signals).toBe(0);

      await grants.putServerGrant(actor, { kind: 'user', id: userId }, serverId, input);
      expect(signals).toBe(1);
      await grants.deleteServerGrant(actor, { kind: 'user', id: userId }, serverId);
      expect(signals).toBe(2);
      // Deleting a grant that does not exist changes nothing.
      await grants.deleteServerGrant(actor, { kind: 'user', id: userId }, serverId);
      expect(signals).toBe(2);
    });
  });

  it('does not keep Administrators special in grant authorization', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { grants } = services(database);
      const adminGroup = await seedGroup(database, {
        name: 'Administrators',
        system: SystemGroupKey.Administrators,
        capabilities: Object.values(Capability),
      });
      const admin = await seedUser(database);
      await addMember(database, adminGroup, admin);
      const serverId = await seedServer(database);
      const userId = await seedUser(database);

      await expect(grants.putServerGrant(
        testActor(admin),
        { kind: 'user', id: userId },
        serverId,
        { cpuMillis: null, memBytes: null, diskBytes: null, gpuPciAddresses: [], expiresAt: null },
      )).resolves.toMatchObject({ serverId });
    });
  });
});
