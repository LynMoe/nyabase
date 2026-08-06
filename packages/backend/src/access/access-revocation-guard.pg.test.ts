import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import {
  AccessRevocationGuardService,
  type ExactMountSource,
} from './access-revocation-guard.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL
  ? describe
  : describe.skip;

describePg('AccessRevocationGuardService PostgreSQL bulk bounds', () => {
  it('checks 128 users x 16 servers in one query while preserving effective grants and payload', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const users = await seedUsers(fixture.database, 128);
      const servers = await seedServers(fixture.database, 16);
      const groupId = await seedGroup(fixture.database);
      await fixture.database.insertInto('iam.group_members').values({
        id: randomUUID(),
        group_id: groupId,
        user_id: users[0],
      }).execute();
      await fixture.database.insertInto('iam.server_grants').values([
        serverGrant({ groupId, serverId: servers[0] }),
        serverGrant({ userId: users[0], serverId: servers[1] }),
      ]).execute();
      await fixture.database.insertInto('control.authorization_dependencies').values([
        dependency(users[0], servers[0], 'inherited-server'),
        dependency(users[0], servers[1], 'direct-server'),
        dependency(users[0], servers[2], 'blocked-server'),
      ]).execute();

      const affected = users.flatMap((userId) =>
        servers.map((serverId) => ({ userId, serverId })));
      const { database, queryCount, destroy } = countedDatabase(fixture.connectionString);
      const guard = new AccessRevocationGuardService();
      try {
        await database.transaction().execute(async (transaction) => {
          queryCount.reset();
          let error: unknown;
          try {
            await guard.assertServerAccessRevocationSafe(transaction, affected);
          } catch (caught) {
            error = caught;
          }
          expect(queryCount.value()).toBe(1);
          expect(error).toBeInstanceOf(ConflictException);
          expect((error as ConflictException).getResponse()).toMatchObject({
            code: 'ACCESS_REVOKE_HAS_RESOURCES',
            userId: users[0],
            serverId: servers[2],
            dependencyKind: 'container',
            dependencyId: 'blocked-server',
          });
        });
      } finally {
        await destroy();
      }
    });
  });

  it('allows server grant revoke when only remote data-directory dependencies remain', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const [userId] = await seedUsers(fixture.database, 1);
      const [serverId] = await seedServers(fixture.database, 1);
      await fixture.database.insertInto('control.authorization_dependencies').values({
        id: randomUUID(),
        dependency_kind: 'data_directory',
        dependency_id: 'remote-only',
        user_id: userId,
        server_id: serverId,
        source_kind: 'remote',
        source_id: 'remote-fs-1',
        source_identity: null,
      }).execute();

      const guard = new AccessRevocationGuardService();
      await fixture.database.transaction().execute(async (transaction) => {
        await expect(
          guard.assertServerAccessRevocationSafe(transaction, [{ userId, serverId }]),
        ).resolves.toBeUndefined();
      });
    });
  });

  it('blocks server grant revoke for local data-directory dependencies', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const [userId] = await seedUsers(fixture.database, 1);
      const [serverId] = await seedServers(fixture.database, 1);
      await fixture.database.insertInto('control.authorization_dependencies').values({
        id: randomUUID(),
        dependency_kind: 'data_directory',
        dependency_id: 'local-dir',
        user_id: userId,
        server_id: serverId,
        source_kind: 'local',
        source_id: 'disk-1',
        source_identity: 'identity-1',
      }).execute();

      const guard = new AccessRevocationGuardService();
      await fixture.database.transaction().execute(async (transaction) => {
        let error: unknown;
        try {
          await guard.assertServerAccessRevocationSafe(transaction, [{ userId, serverId }]);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'ACCESS_REVOKE_HAS_RESOURCES',
          dependencyKind: 'data_directory',
          dependencyId: 'local-dir',
        });
      });
    });
  });

  it('checks the 64 x 64 supported mount revocation cross-product in one bounded query', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const users = await seedUsers(fixture.database, 64);
      const [serverId] = await seedServers(fixture.database, 1);
      const groupId = await seedGroup(fixture.database);
      const sources: ExactMountSource[] = Array.from({ length: 64 }, (_, index) => ({
        sourceKind: 'local',
        sourceId: `disk-${index}`,
        serverId,
        sourceIdentity: `identity-${index}`,
      }));
      await fixture.database.insertInto('iam.group_members').values({
        id: randomUUID(),
        group_id: groupId,
        user_id: users[0],
      }).execute();
      await fixture.database.insertInto('iam.mount_source_grants').values([
        mountGrant({ groupId, source: sources[0] }),
        mountGrant({ userId: users[1], source: sources[0] }),
      ]).execute();
      await fixture.database.insertInto('control.authorization_dependencies').values([
        mountDependency(users[0], sources[0], 'inherited-mount'),
        mountDependency(users[1], sources[0], 'direct-mount'),
        mountDependency(users[2], sources[0], 'blocked-mount'),
      ]).execute();

      const { database, queryCount, destroy } = countedDatabase(fixture.connectionString);
      const guard = new AccessRevocationGuardService();
      try {
        await database.transaction().execute(async (transaction) => {
          queryCount.reset();
          const startedAt = performance.now();
          let error: unknown;
          try {
            await guard.assertMountSourcesRevocationSafe(
              transaction,
              users,
              sources,
            );
          } catch (caught) {
            error = caught;
          }
          expect(queryCount.value()).toBe(1);
          expect(performance.now() - startedAt).toBeLessThan(5_000);
          expect(error).toBeInstanceOf(ConflictException);
          expect((error as ConflictException).getResponse()).toMatchObject({
            code: 'ACCESS_REVOKE_HAS_RESOURCES',
            userId: users[2],
            sourceKind: 'local',
            sourceId: sources[0].sourceId,
            serverId,
            sourceIdentity: sources[0].sourceIdentity,
            dependencyKind: 'container_mount',
            dependencyId: 'blocked-mount',
          });
        });
      } finally {
        await destroy();
      }
    });
  });
});

function countedDatabase(connectionString: string): {
  database: Kysely<NyabaseDatabase>;
  queryCount: { reset(): void; value(): number };
  destroy(): Promise<void>;
} {
  let count = 0;
  const pool = new Pool({ connectionString, max: 1 });
  pool.on('error', () => undefined);
  const database = new Kysely<NyabaseDatabase>({
    dialect: new PostgresDialect({ pool }),
    log: (event) => {
      if (event.level === 'query') count += 1;
    },
  });
  return {
    database,
    queryCount: {
      reset: () => { count = 0; },
      value: () => count,
    },
    destroy: () => database.destroy(),
  };
}

async function seedUsers(
  database: Kysely<NyabaseDatabase>,
  count: number,
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await database.insertInto('iam.users').values(ids.map((id, index) => ({
    id,
    numeric_id: index + 1,
    username: `revocation-${index}`,
    password_hash: 'unused',
    display_name: `Revocation ${index}`,
    status: 'active',
    auth_version: 1,
    authz_version: 1,
  }))).execute();
  return ids;
}

async function seedServers(
  database: Kysely<NyabaseDatabase>,
  count: number,
): Promise<string[]> {
  const repository = new InfrastructureRepository(database);
  return Promise.all(Array.from({ length: count }, async (_, index) => {
    const id = randomUUID();
    await repository.insertServer({
      id,
      name: `Revocation server ${index}`,
      slug: `revocation-server-${index}`,
      agentTokenHash: String(index).padStart(64, '0'),
    });
    return id;
  }));
}

async function seedGroup(database: Kysely<NyabaseDatabase>): Promise<string> {
  const id = randomUUID();
  await database.insertInto('iam.groups').values({
    id,
    name: `Revocation group ${id.slice(0, 8)}`,
    description: null,
    priority: 1,
    is_system: false,
    system_key: null,
    capabilities: [],
    revision: 1,
  }).execute();
  return id;
}

function serverGrant(input: {
  userId?: string;
  groupId?: string;
  serverId: string;
}) {
  return {
    id: randomUUID(),
    user_id: input.userId ?? null,
    group_id: input.groupId ?? null,
    server_id: input.serverId,
    cpu_millis: null,
    mem_bytes: null,
    disk_bytes: null,
    gpu_mode: null,
    gpu_indices: null,
  };
}

function mountGrant(input: {
  userId?: string;
  groupId?: string;
  source: ExactMountSource;
}) {
  return {
    id: randomUUID(),
    user_id: input.userId ?? null,
    group_id: input.groupId ?? null,
    source_kind: input.source.sourceKind,
    source_id: input.source.sourceId,
    server_id: input.source.serverId,
    source_identity: input.source.sourceIdentity,
  };
}

function dependency(userId: string, serverId: string, dependencyId: string) {
  return {
    id: randomUUID(),
    dependency_kind: 'container',
    dependency_id: dependencyId,
    user_id: userId,
    server_id: serverId,
    source_kind: null,
    source_id: null,
    source_identity: null,
  };
}

function mountDependency(
  userId: string,
  source: ExactMountSource,
  dependencyId: string,
) {
  return {
    id: randomUUID(),
    dependency_kind: 'container_mount',
    dependency_id: dependencyId,
    user_id: userId,
    server_id: source.serverId!,
    source_kind: source.sourceKind,
    source_id: source.sourceId,
    source_identity: source.sourceIdentity,
  };
}
