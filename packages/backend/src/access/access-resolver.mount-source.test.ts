import { randomUUID } from 'node:crypto';
import { GpuGrantMode, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { StorageRepository } from '../storage/storage.repository.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { AccessResolverService } from './access-resolver.service.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('AccessResolver exact local mount identity on PostgreSQL', () => {
  it('does not transfer a duplicate disk id across servers or survive identity replacement', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      await expect(context.service.hasMountSourceAccess(
        context.userId,
        context.serverA,
        'local',
        'shared-disk-id',
      )).resolves.toBe(true);
      await expect(context.service.hasMountSourceAccess(
        context.userId,
        context.serverB,
        'local',
        'shared-disk-id',
      )).resolves.toBe(false);

      context.snapshots.set(context.serverA, snapshot('replacement-a'));
      await expect(context.service.hasMountSourceAccess(
        context.userId,
        context.serverA,
        'local',
        'shared-disk-id',
      )).resolves.toBe(false);
    });
  });

  it('rejects container preflight when local identity changes after request preparation', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await setup(fixture);
      context.snapshots.set(context.serverA, snapshot('replacement-a'));
      await expect(context.transactions.run((transaction) =>
        context.service.resolveContainerCreateAccessInTransaction(
          transaction,
          context.userId,
          context.serverA,
          'image-a',
          [{
            kind: 'local',
            id: 'shared-disk-id',
            sourceIdentity: 'physical-a',
          }],
        ))).resolves.toMatchObject({ mountSourcesAllowed: false });
    });
  });
});

async function setup(fixture: PostgresTestDatabase) {
  const infrastructure = new InfrastructureRepository(fixture.database);
  const storage = new StorageRepository(fixture.database);
  const transactions = new PgTransactionManager(fixture.database);
  const userId = randomUUID();
  const serverA = randomUUID();
  const serverB = randomUUID();
  await Promise.all([
    infrastructure.insertServer({
      id: serverA,
      name: 'Mount A',
      slug: `mount-a-${serverA.slice(0, 8)}`,
      agentTokenHash: 'a'.repeat(64),
    }),
    infrastructure.insertServer({
      id: serverB,
      name: 'Mount B',
      slug: `mount-b-${serverB.slice(0, 8)}`,
      agentTokenHash: 'b'.repeat(64),
    }),
  ]);
  await fixture.database.insertInto('iam.users').values({
    id: userId,
    numeric_id: 1001,
    username: `mount-${userId.slice(0, 8)}`,
    password_hash: 'hash',
    display_name: 'Mount User',
    status: UserStatus.Active,
    auth_version: 1,
    authz_version: 1,
  }).execute();
  await fixture.database.insertInto('iam.server_grants').values(
    [serverA, serverB].map((serverId) => ({
      id: randomUUID(),
      user_id: userId,
      group_id: null,
      server_id: serverId,
      cpu_millis: 0,
      mem_bytes: 0,
      disk_bytes: 0,
      gpu_mode: GpuGrantMode.None,
      gpu_indices: null,
    })),
  ).execute();
  await fixture.database.insertInto('iam.image_grants').values({
    id: randomUUID(),
    user_id: userId,
    group_id: null,
    image_id: 'image-a',
    server_id: serverA,
  }).execute();
  await storage.insertMountSourceGrant(
    randomUUID(),
    'user',
    userId,
    {
      sourceKind: 'local',
      sourceId: 'shared-disk-id',
      serverId: serverA,
      sourceIdentity: 'physical-a',
    },
  );
  const snapshots = new Map<string, ReturnType<typeof snapshot>>([
    [serverA, snapshot('physical-a')],
    [serverB, snapshot('physical-b')],
  ]);
  const service = new AccessResolverService(
    fixture.database,
    transactions,
    { stateCache: { get: (serverId: string) => snapshots.get(serverId) } } as never,
    new AccessCacheEpochService(fixture.database),
  );
  return { service, transactions, snapshots, userId, serverA, serverB };
}

function snapshot(sourceIdentity: string) {
  return {
    helloAt: Date.now(),
    disks: [{ diskId: 'shared-disk-id', sourceIdentity }],
  };
}
