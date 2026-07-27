import { randomUUID } from 'node:crypto';
import {
  GpuGrantMode,
  RemoteFsType,
  UserStatus,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { StorageRepository } from '../storage/storage.repository.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { AccessResolverService } from './access-resolver.service.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePostgres('AccessResolver canonical RemoteFS assignment authorization', () => {
  it('requires an exact active assignment and rechecks it beyond the IAM cache', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const infrastructure = new InfrastructureRepository(database);
      const storage = new StorageRepository(database);
      const transactions = new PgTransactionManager(database);
      const serverId = randomUUID();
      const userId = randomUUID();
      const mountId = randomUUID();
      await infrastructure.insertServer({
        id: serverId,
        name: 'remote-access',
        slug: 'remote-access',
        agentTokenHash: 'd'.repeat(64),
      });
      await database.insertInto('iam.users').values({
        id: userId,
        numeric_id: 1,
        username: 'remote-user',
        password_hash: 'hash',
        display_name: 'Remote User',
        status: UserStatus.Active,
        auth_version: 1,
        authz_version: 1,
      }).execute();
      await database.insertInto('iam.server_grants').values({
        id: randomUUID(),
        user_id: userId,
        group_id: null,
        server_id: serverId,
        cpu_millis: 0,
        mem_bytes: 0,
        disk_bytes: 0,
        gpu_mode: GpuGrantMode.None,
        gpu_indices: null,
      }).execute();
      await storage.insertRemoteFsMount({
        id: mountId,
        name: 'remote',
        displayName: null,
        description: null,
        type: RemoteFsType.Nfs,
        hostMountPoint: `/mnt/remote-fs/${mountId}`,
        options: '',
        params: {
          type: RemoteFsType.Nfs,
          nfsServer: 'nfs.example',
          exportPath: '/exports/data',
          version: '4.2',
        },
      });
      const assignment = await storage.insertAssignment({
        id: randomUUID(),
        mountId,
        serverId,
        desiredState: 'active',
        generation: 1,
        lastTaskId: null,
      });
      await storage.insertMountSourceGrant(
        randomUUID(),
        'user',
        userId,
        { sourceKind: 'remote', sourceId: mountId },
      );

      const access = new AccessResolverService(
        database,
        transactions,
        { stateCache: { get: () => undefined } } as never,
        new AccessCacheEpochService(database),
      );
      await expect(access.resolveMountSources(userId, serverId))
        .resolves.toEqual(new Set([{ kind: 'remote', id: mountId }]));
      await expect(transactions.run((transaction) =>
        access.hasMountSourceAccessInTransaction(
          transaction,
          userId,
          serverId,
          { kind: 'remote', id: mountId },
        ))).resolves.toBe(true);

      await storage.transitionAssignment(
        assignment.id,
        1,
        ['active'],
        { desiredState: 'removing', generation: 2, lastTaskId: null },
      );
      await expect(access.resolveMountSources(userId, serverId))
        .resolves.toEqual(new Set());
      await expect(transactions.run((transaction) =>
        access.hasMountSourceAccessInTransaction(
          transaction,
          userId,
          serverId,
          { kind: 'remote', id: mountId },
        ))).resolves.toBe(false);
    });
  });
});
