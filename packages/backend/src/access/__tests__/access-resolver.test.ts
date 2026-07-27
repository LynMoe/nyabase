import { randomUUID } from 'node:crypto';
import {
  Capability,
  GpuGrantMode,
  UserStatus,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { InfrastructureRepository } from '../../infrastructure/infrastructure.repository.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../../persistence-pg/transaction.js';
import { AccessCacheEpochService } from '../access-cache-epoch.service.js';
import { AccessResolverService } from '../access-resolver.service.js';
import { resolveGrant } from '../grant-utils.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function makeGrant(overrides = {}) {
  return {
    cpuMillis: null as number | null,
    memBytes: null as number | null,
    diskBytes: null as number | null,
    gpuMode: null as GpuGrantMode | null,
    gpuIndices: null as number[] | null,
    ...overrides,
  };
}

describe('resolveGrant', () => {
  it('treats null resource fields as unlimited and null GPU mode as all', () => {
    expect(resolveGrant(makeGrant())).toEqual({
      cpuMillis: 0,
      memBytes: 0,
      diskBytes: 0,
      gpuMode: GpuGrantMode.All,
      gpuIndices: [],
    });
  });

  it('uses non-null resource values', () => {
    expect(resolveGrant(makeGrant({
      cpuMillis: 8000,
      memBytes: 8 * 1024 ** 3,
    }))).toMatchObject({
      cpuMillis: 8000,
      memBytes: 8 * 1024 ** 3,
      diskBytes: 0,
    });
  });

  it('uses explicit GPU indices', () => {
    expect(resolveGrant(makeGrant({
      gpuMode: GpuGrantMode.Indices,
      gpuIndices: [0, 2],
    }))).toMatchObject({
      gpuMode: GpuGrantMode.Indices,
      gpuIndices: [0, 2],
    });
  });

  it('uses empty indices when an indices grant has null indices', () => {
    expect(resolveGrant(makeGrant({ gpuMode: GpuGrantMode.Indices })))
      .toMatchObject({ gpuIndices: [] });
  });

  it('uses all GPU mode when mode is null', () => {
    expect(resolveGrant(makeGrant({ gpuMode: null }))).toMatchObject({
      gpuMode: GpuGrantMode.All,
      gpuIndices: [],
    });
  });

  it('preserves explicit zero as unlimited', () => {
    expect(resolveGrant(makeGrant({ cpuMillis: 0 })).cpuMillis).toBe(0);
  });
});

describePostgres('AccessResolver PostgreSQL image authorization', () => {
  it('requires an image grant to match an effectively granted server', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await grantServer(fixture, context.userId, context.serverAccessible);
      await grantImage(fixture, context.userId, 'image-a', context.serverUngranted);
      await expect(context.service.isImageAccessibleForUser(
        context.userId,
        'image-a',
      )).resolves.toBe(false);
    });
  });

  it('allows an image grant on an effectively granted server', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await grantServer(fixture, context.userId, context.serverAccessible);
      await grantImage(fixture, context.userId, 'image-a', context.serverAccessible);
      await expect(context.service.isImageAccessibleForUser(
        context.userId,
        'image-a',
      )).resolves.toBe(true);
    });
  });

  it('does not let admin capabilities bypass image authorization', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture, Capability.ManageImages);
      await expect(context.service.isImageAccessibleForUser(
        context.userId,
        'image-a',
      )).resolves.toBe(false);
    });
  });

  it('does not let admin capabilities synthesize effective resource access', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture, Capability.ManageContainersAny);
      await expect(context.service.getEffectiveAccess(context.userId))
        .resolves.toEqual([]);
    });
  });
});

async function setup(
  fixture: PostgresTestDatabase,
  capability?: Capability,
) {
  const infrastructure = new InfrastructureRepository(fixture.database);
  const transactions = new PgTransactionManager(fixture.database);
  const userId = randomUUID();
  const serverAccessible = randomUUID();
  const serverUngranted = randomUUID();
  await Promise.all([
    infrastructure.insertServer({
      id: serverAccessible,
      name: 'Accessible',
      slug: `accessible-${serverAccessible.slice(0, 8)}`,
      agentTokenHash: 'e'.repeat(64),
    }),
    infrastructure.insertServer({
      id: serverUngranted,
      name: 'Ungranted',
      slug: `ungranted-${serverUngranted.slice(0, 8)}`,
      agentTokenHash: 'f'.repeat(64),
    }),
  ]);
  await fixture.database.insertInto('iam.users').values({
    id: userId,
    numeric_id: 1001,
    username: `image-${userId.slice(0, 8)}`,
    password_hash: 'hash',
    display_name: 'Image User',
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  }).execute();
  if (capability) {
    const groupId = randomUUID();
    await fixture.database.insertInto('iam.groups').values({
      id: groupId,
      name: `Admin ${groupId.slice(0, 8)}`,
      description: null,
      priority: 100,
      is_system: false,
      system_key: null,
      capabilities: [capability],
      revision: 1,
    }).execute();
    await fixture.database.insertInto('iam.group_members').values({
      id: randomUUID(),
      group_id: groupId,
      user_id: userId,
    }).execute();
  }
  const service = new AccessResolverService(
    fixture.database,
    transactions,
    { stateCache: { get: () => undefined } } as never,
    new AccessCacheEpochService(fixture.database),
  );
  return { service, userId, serverAccessible, serverUngranted };
}

async function grantServer(
  fixture: PostgresTestDatabase,
  userId: string,
  serverId: string,
) {
  await fixture.database.insertInto('iam.server_grants').values({
    id: randomUUID(),
    user_id: userId,
    group_id: null,
    server_id: serverId,
    cpu_millis: null,
    mem_bytes: null,
    disk_bytes: null,
    gpu_mode: GpuGrantMode.None,
    gpu_indices: null,
  }).execute();
}

async function grantImage(
  fixture: PostgresTestDatabase,
  userId: string,
  imageId: string,
  serverId: string,
) {
  await fixture.database.insertInto('iam.image_grants').values({
    id: randomUUID(),
    user_id: userId,
    group_id: null,
    image_id: imageId,
    server_id: serverId,
  }).execute();
}
