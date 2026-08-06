import { randomUUID } from 'node:crypto';
import {
  Capability,
  GRANT_EXPIRY_GRACE_DAYS,
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

describePostgres('AccessResolver grant expiry phases', () => {
  it('resolves a live direct grant as phase full', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await grantServer(fixture, context.userId, context.serverAccessible);
      const grant = await context.service.resolveServer(context.userId, context.serverAccessible);
      expect(grant).toMatchObject({ accessPhase: 'full', expiresAt: null, purgeAt: null });
    });
  });

  it('falls back to a live group grant, phase full, when the direct grant is dead', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const groupId = await createGroupWithMember(fixture, context.userId, 1);
      await grantServer(fixture, context.userId, context.serverAccessible, {
        expiresAt: daysFromNow(-(GRANT_EXPIRY_GRACE_DAYS + 1)),
        diskBytes: 1,
      });
      await grantGroupServer(fixture, groupId, context.serverAccessible, {
        expiresAt: null,
        diskBytes: 2,
      });
      const grant = await context.service.resolveServer(context.userId, context.serverAccessible);
      expect(grant).toMatchObject({ accessPhase: 'full', diskBytes: 2 });
    });
  });

  it('resolves a grace-phase direct grant (past expiry, inside the grace window)', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const expiresAt = daysFromNow(-1);
      await grantServer(fixture, context.userId, context.serverAccessible, { expiresAt });
      const grant = await context.service.resolveServer(context.userId, context.serverAccessible);
      expect(grant?.accessPhase).toBe('grace');
      expect(grant?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
      expect(grant?.purgeAt?.getTime()).toBe(
        expiresAt.getTime() + GRANT_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000,
      );
    });
  });

  it('is Lost (resolveServer returns null) once the direct grant is past the grace window', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await grantServer(fixture, context.userId, context.serverAccessible, {
        expiresAt: daysFromNow(-(GRANT_EXPIRY_GRACE_DAYS + 1)),
      });
      await expect(context.service.resolveServer(context.userId, context.serverAccessible))
        .resolves.toBeNull();
    });
  });

  it('is Lost when there is no grant at all', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await expect(context.service.resolveServer(context.userId, context.serverAccessible))
        .resolves.toBeNull();
    });
  });

  it('prefers the group with the latest expiresAt when only grace-tier groups cover access', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const soonerGroup = await createGroupWithMember(fixture, context.userId, 100);
      const laterGroup = await createGroupWithMember(fixture, context.userId, 1);
      await grantGroupServer(fixture, soonerGroup, context.serverAccessible, {
        expiresAt: daysFromNow(-1),
        diskBytes: 10,
      });
      await grantGroupServer(fixture, laterGroup, context.serverAccessible, {
        expiresAt: daysFromNow(-0.5),
        diskBytes: 20,
      });
      const grant = await context.service.resolveServer(context.userId, context.serverAccessible);
      expect(grant).toMatchObject({ accessPhase: 'grace', diskBytes: 20 });
    });
  });

  it('resolveServerInTransaction and resolveServerPairsInTransaction agree on phase resolution', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const groupId = await createGroupWithMember(fixture, context.userId, 1);
      await grantServer(fixture, context.userId, context.serverAccessible, {
        expiresAt: daysFromNow(-1),
        diskBytes: 5,
      });
      await grantGroupServer(fixture, groupId, context.serverAccessible, {
        expiresAt: null,
        diskBytes: 9,
      });
      const transactions = new PgTransactionManager(fixture.database);
      const [single, batch] = await transactions.run(async (transaction) => Promise.all([
        context.service.resolveServerInTransaction(
          transaction,
          context.userId,
          context.serverAccessible,
        ),
        context.service.resolveServerPairsInTransaction(
          transaction,
          [{ userId: context.userId, serverId: context.serverAccessible }],
        ),
      ]));
      const batched = batch.get(`${context.userId}\0${context.serverAccessible}`);
      expect(single).toMatchObject({ accessPhase: 'full', diskBytes: 9 });
      expect(batched).toMatchObject({ accessPhase: 'full', diskBytes: 9 });
    });
  });

  it('exposes accessPhase/expiresAt/purgeAt on getEffectiveAccess for a grace-phase grant', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      const expiresAt = daysFromNow(-1);
      await grantServer(fixture, context.userId, context.serverAccessible, { expiresAt });
      const [access] = await context.service.getEffectiveAccess(context.userId);
      expect(access).toMatchObject({
        serverId: context.serverAccessible,
        accessPhase: 'grace',
        expiresAt: expiresAt.toISOString(),
      });
      expect(access?.purgeAt).not.toBeNull();
    });
  });

  it('rejects container-create access (requires full) while access is only in grace', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await grantServer(fixture, context.userId, context.serverAccessible, {
        expiresAt: daysFromNow(-1),
      });
      await grantImage(fixture, context.userId, 'image-a', context.serverAccessible);
      const transactions = new PgTransactionManager(fixture.database);
      const result = await transactions.run((transaction) =>
        context.service.resolveContainerCreateAccessInTransaction(
          transaction,
          context.userId,
          context.serverAccessible,
          'image-a',
          [],
        ));
      expect(result).toBeNull();
    });
  });

  it('allows container-create access while the direct grant is still full', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await grantServer(fixture, context.userId, context.serverAccessible);
      await grantImage(fixture, context.userId, 'image-a', context.serverAccessible);
      const transactions = new PgTransactionManager(fixture.database);
      const result = await transactions.run((transaction) =>
        context.service.resolveContainerCreateAccessInTransaction(
          transaction,
          context.userId,
          context.serverAccessible,
          'image-a',
          [],
        ));
      expect(result).toMatchObject({ mountSourcesAllowed: true, grant: { accessPhase: 'full' } });
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
  options: { expiresAt?: Date | null; diskBytes?: number | null } = {},
) {
  await fixture.database.insertInto('iam.server_grants').values({
    id: randomUUID(),
    user_id: userId,
    group_id: null,
    server_id: serverId,
    cpu_millis: null,
    mem_bytes: null,
    disk_bytes: options.diskBytes ?? null,
    gpu_mode: GpuGrantMode.None,
    gpu_indices: null,
    expires_at: options.expiresAt ?? null,
  }).execute();
}

async function grantGroupServer(
  fixture: PostgresTestDatabase,
  groupId: string,
  serverId: string,
  options: { expiresAt?: Date | null; diskBytes?: number | null } = {},
) {
  await fixture.database.insertInto('iam.server_grants').values({
    id: randomUUID(),
    user_id: null,
    group_id: groupId,
    server_id: serverId,
    cpu_millis: null,
    mem_bytes: null,
    disk_bytes: options.diskBytes ?? null,
    gpu_mode: GpuGrantMode.None,
    gpu_indices: null,
    expires_at: options.expiresAt ?? null,
  }).execute();
}

async function createGroupWithMember(
  fixture: PostgresTestDatabase,
  userId: string,
  priority: number,
): Promise<string> {
  const groupId = randomUUID();
  await fixture.database.insertInto('iam.groups').values({
    id: groupId,
    name: `Group ${groupId.slice(0, 8)}`,
    description: null,
    priority,
    is_system: false,
    system_key: null,
    capabilities: [],
    revision: 1,
  }).execute();
  await fixture.database.insertInto('iam.group_members').values({
    id: randomUUID(),
    group_id: groupId,
    user_id: userId,
  }).execute();
  return groupId;
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
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
