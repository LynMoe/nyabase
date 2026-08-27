import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Capability, GpuGrantMode, ServerStatus, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { AccessResolverService } from './access-resolver.service.js';
import { AccessRevocationGuardService } from './access-revocation-guard.service.js';
import { GroupsService } from '../groups/groups.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('PostgreSQL canonical authorization', () => {
  it('selects a direct winner before inherited group access', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      await seedPolicyState(database);
      const userId = await seedUser(database, 'winner-user');
      const groupId = randomUUID();
      const serverId = await seedServer(database, 'winner-server');
      await database.insertInto('iam.groups').values({
        id: groupId,
        name: `Winner group ${groupId.slice(0, 8)}`,
        description: null,
        priority: 100,
        is_system: false,
        system_key: null,
        capabilities: [],
        revision: 1,
      }).execute();
      await database.insertInto('iam.group_members').values({
        id: randomUUID(),
        group_id: groupId,
        user_id: userId,
      }).execute();
      await database.insertInto('iam.server_grants').values([
        grant({ user_id: userId, server_id: serverId, disk_bytes: 10 }),
        grant({ group_id: groupId, server_id: serverId, disk_bytes: 20 }),
      ]).execute();

      const resolver = newResolver(database);
      await expect(resolver.resolveServer(userId, serverId)).resolves.toMatchObject({
        diskBytes: 10,
        accessPhase: 'live',
      });
    });
  });

  it('rejects an actor that lacks the capability being exercised', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      await seedPolicyState(database);
      const actorId = await seedUser(database, 'boundary-actor');
      const groupId = randomUUID();
      await database.insertInto('iam.groups').values({
        id: groupId,
        name: `Boundary group ${groupId.slice(0, 8)}`,
        description: null,
        priority: 1,
        is_system: false,
        system_key: null,
        capabilities: [Capability.ManageUsers],
        revision: 1,
      }).execute();
      await database.insertInto('iam.group_members').values({
        id: randomUUID(),
        group_id: groupId,
        user_id: actorId,
      }).execute();

      const resolver = newResolver(database);
      await expect(database.transaction().execute((transaction) =>
        resolver.assertActorCapabilitiesInTransaction(
          transaction,
          actorId,
          [Capability.ManageGrants],
        ))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('rolls back a server-grant revoke when a local dependency remains', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      await seedPolicyState(database);
      const userId = await seedUser(database, 'rollback-user');
      const serverId = await seedServer(database, 'rollback-server');
      await database.insertInto('iam.server_grants').values(
        grant({ user_id: userId, server_id: serverId, disk_bytes: 10 }),
      ).execute();
      await database.insertInto('control.authorization_dependencies').values({
        id: randomUUID(),
        dependency_kind: 'container',
        dependency_id: randomUUID(),
        user_id: userId,
        server_id: serverId,
        pool_id: null,
        shared_backend_id: null,
      }).execute();

      const guard = new AccessRevocationGuardService();
      await expect(database.transaction().execute(async (transaction) => {
        await transaction.deleteFrom('iam.server_grants')
          .where('user_id', '=', userId)
          .where('server_id', '=', serverId)
          .execute();
        await guard.assertServerAccessRevocationSafe(transaction, [{ userId, serverId }]);
      })).rejects.toBeInstanceOf(ConflictException);

      await expect(database.selectFrom('iam.server_grants')
        .select('id')
        .where('user_id', '=', userId)
        .where('server_id', '=', serverId)
        .executeTakeFirst()).resolves.toBeDefined();
    });
  });

  it('uses one canonical row for repeated user-grant PUTs', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      await seedPolicyState(database);
      const userId = await seedUser(database, 'upsert-user');
      const serverId = await seedServer(database, 'upsert-server');
      const transactions = new PgTransactionManager(database);
      const access = newResolver(database);
      const audit = { append: async () => undefined };
      const groups = new GroupsService(
        database,
        transactions,
        access,
        audit as never,
        new AccessRevocationGuardService(),
      );
      const input = {
        cpuMillis: null,
        memBytes: null,
        diskBytes: 10,
        gpu: { mode: GpuGrantMode.None, pciAddresses: [] },
        expiresAt: null,
      };

      const first = await groups.upsertUserServerGrant(userId, serverId, input);
      const second = await groups.upsertUserServerGrant(userId, serverId, {
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
});

function newResolver(database: Kysely<NyabaseDatabase>): AccessResolverService {
  const transactions = new PgTransactionManager(database);
  return new AccessResolverService(
    database,
    transactions,
    new AccessCacheEpochService(database),
  );
}

let nextNumericId = 1;

async function seedPolicyState(database: Kysely<NyabaseDatabase>): Promise<void> {
  await database.insertInto('iam.policy_state')
    .values({ singleton: true, policy_epoch: 0 })
    .onConflict((conflict) => conflict.column('singleton').doNothing())
    .execute();
}

async function seedUser(database: Kysely<NyabaseDatabase>, username: string): Promise<string> {
  const id = randomUUID();
  await database.insertInto('iam.users').values({
    id,
    numeric_id: nextNumericId++,
    username,
    password_hash: 'unused',
    display_name: username,
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  }).execute();
  return id;
}

async function seedServer(database: Kysely<NyabaseDatabase>, name: string): Promise<string> {
  const id = randomUUID();
  await new InfrastructureRepository(database).insertServer({
    id,
    name,
    slug: `${name}-${id.slice(0, 8)}`,
    api_endpoint: 'https://incus.example.test:8443',
    server_cert_fingerprint: null,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: 'eth0',
    dns_servers: ['10.20.0.1'],
    gpu_runtime_available: false,
    status: ServerStatus.Unknown,
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_endpoint: null,
    node_metrics_server_cert_fingerprint: null,
    node_metrics_token_ciphertext: null,
    node_metrics_token_fingerprint: null,
    node_metrics_status: 'unconfigured',
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'not_run',
    preflight_checked_at: null,
    preflight_report: null,
  });
  return id;
}

function grant(input: {
  user_id?: string;
  group_id?: string;
  server_id: string;
  disk_bytes: number;
}) {
  return {
    id: randomUUID(),
    user_id: input.user_id ?? null,
    group_id: input.group_id ?? null,
    server_id: input.server_id,
    cpu_millis: null,
    mem_bytes: null,
    disk_bytes: input.disk_bytes,
    gpu_mode: GpuGrantMode.None,
    gpu_pci_addresses: [],
    expires_at: null,
  };
}
