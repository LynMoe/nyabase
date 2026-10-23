import type { Kysely } from 'kysely';
import { ContainerPhase, Role } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { ContainerSshConvergenceService } from '../containers/container-ssh.js';
import { makeContainerControlService } from '../containers/container-services.test-helper.js';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import {
  grantPool,
  grantServer,
  seedBackend,
  seedBackendPool,
  seedContainer,
  seedImage,
  seedPool,
  seedServer,
  seedUser,
  seedVolume,
} from '../iam/access.pg-test-helper.js';
import { SYSTEM_ACTOR } from '../iam/actor.js';
import { testActor } from '../iam/actor.test-helper.js';
import { IpPoolsRepository } from '../ip-pools/ip-pools.repository.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';
import { VolumesRepository } from '../volumes/volumes.repository.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

/** The purge over the real container control service, not a recorder. */
function purgeService(database: Kysely<NyabaseDatabase>): UserServerResourcePurgeService {
  const transactions = new PgTransactionManager(database);
  const intents = new IntentRepository(database, noopWake());
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const repository = new ContainerControlRepository(database);
  const containers = makeContainerControlService(
    database,
    transactions,
    repository,
    new AccessResolverService(database, transactions),
    intents,
    {} as never,
    audit as never,
    new IpPoolsRepository(database),
    { get: vi.fn().mockReturnValue(null) } as never,
    new ContainerSshConvergenceService(database, intents),
    {} as never,
    new GpuClaimsRepository(database),
  );
  return new UserServerResourcePurgeService(
    transactions,
    repository,
    containers,
    new VolumesRepository(database),
    intents,
    { forceDetach: vi.fn() } as never,
    audit as never,
  );
}

async function world(database: Kysely<NyabaseDatabase>) {
  const userId = await seedUser(database);
  const serverId = await seedServer(database);
  const poolId = await seedPool(database, serverId);
  const imageId = await seedImage(database);
  await grantServer(database, { user: userId }, serverId);
  await grantPool(database, { user: userId }, poolId);
  const containerIds = [
    await seedContainer(database, { ownerId: userId, serverId, poolId, imageId, running: true }),
    await seedContainer(database, { ownerId: userId, serverId, poolId, imageId }),
  ];
  const volumeId = await seedVolume(database, { ownerId: userId, poolId, serverId });
  return { userId, serverId, containerIds, volumeId };
}

async function phases(database: Kysely<NyabaseDatabase>, ids: string[]) {
  const rows = await database.selectFrom('control.containers')
    .select(['id', 'lifecycle_phase'])
    .where('id', 'in', ids)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.id, row.lifecycle_phase]));
}

describePg('user server resource purge over the real container service', () => {
  it('lets an administrator purge another user\'s containers and local volumes', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, serverId, containerIds, volumeId } = await world(database);
      const adminId = await seedUser(database, undefined, undefined, Role.Admin);

      const result = await purgeService(database).purge(testActor(adminId, Role.Admin), userId, serverId);

      expect(result.containerIds.sort()).toEqual([...containerIds].sort());
      expect(result.intentIds).toHaveLength(2);
      expect(await phases(database, containerIds)).toEqual(Object.fromEntries(
        containerIds.map((id) => [id, ContainerPhase.Deleting]),
      ));
      const deletes = await database.selectFrom('control.intents')
        .select(['resource_id', 'requested_by'])
        .where('kind', '=', 'container.delete')
        .execute();
      expect(deletes.map((row) => row.resource_id).sort()).toEqual([...containerIds].sort());
      expect(deletes.every((row) => row.requested_by === adminId)).toBe(true);
      expect(result.volumeIds).toEqual([volumeId]);
    });
  });

  it('purges the same way as the system on grant expiry', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { userId, serverId, containerIds } = await world(database);

      const result = await purgeService(database).purge(SYSTEM_ACTOR, userId, serverId);

      expect(result.containerIds.sort()).toEqual([...containerIds].sort());
      expect(Object.values(await phases(database, containerIds)))
        .toEqual([ContainerPhase.Deleting, ContainerPhase.Deleting]);
    });
  });

  it('keeps a written shared volume for a retried destroy while its executor is unreachable', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = await seedUser(database);
      const serverId = await seedServer(database);
      const backendId = await seedBackend(database);
      await seedBackendPool(database, serverId, backendId);
      const volumeId = await seedVolume(database, {
        ownerId: userId, poolId: null, serverId: null, sharedBackendId: backendId,
      });
      await database.updateTable('control.volumes').set({ dir_ensured: true })
        .where('id', '=', volumeId).execute();
      await database.updateTable('infra.servers').set({ status: 'unreachable' })
        .where('id', '=', serverId).execute();

      const result = await purgeService(database).purgeSharedBackendVolumes(SYSTEM_ACTOR, userId, backendId);

      expect(result.volumeIds).toEqual([volumeId]);
      expect(result.intentIds).toHaveLength(1);
      const volume = await database.selectFrom('control.volumes').select('lifecycle_phase')
        .where('id', '=', volumeId).executeTakeFirst();
      expect(volume?.lifecycle_phase).toBe('deleting');
    });
  });
});
