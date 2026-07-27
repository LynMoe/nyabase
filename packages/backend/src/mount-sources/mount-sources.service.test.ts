import { randomUUID } from 'node:crypto';
import {
  Capability,
  MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE,
  RemoteFsType,
  UserStatus,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AccessRevocationGuardService } from '../access/access-revocation-guard.service.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import {
  withPostgresTestDatabase,
  type PostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { StorageRepository } from '../storage/storage.repository.js';
import { MountSourcesService } from './mount-sources.service.js';

const describePostgres = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describe('MountSourcesService batch DTO projection', () => {
  it('preserves 128 reference order with one deduplicated RemoteFS lookup', async () => {
    const refs = new Set(Array.from({ length: 128 }, (_, index) => ({
      kind: 'remote' as const,
      id: `mount-${index}`,
    })));
    const listRemoteFsMountsByIds = vi.fn(async (ids: readonly string[]) =>
      [...ids].reverse().map((id) => ({
        id,
        name: `Name ${id}`,
        displayName: `Display ${id}`,
        description: null,
      })));
    const service = new MountSourcesService(
      { listRemoteFsMountsByIds } as never,
      {} as never,
      { resolveMountSources: vi.fn().mockResolvedValue(refs) } as never,
      {} as never,
      { stateCache: { get: vi.fn() } } as never,
      {} as never,
    );

    const projected = await service.listForUser('user-a', 'server-a');
    expect(projected).toHaveLength(128);
    expect(projected.map((item) => item.id)).toEqual([...refs].map((ref) => ref.id));
    expect(listRemoteFsMountsByIds).toHaveBeenCalledOnce();
    expect(listRemoteFsMountsByIds).toHaveBeenCalledWith([...refs].map((ref) => ref.id));
  });
});

describePostgres('MountSourcesService PostgreSQL canonical grant writer', () => {
  it('rolls back the grant when required audit append fails', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await createContext(fixture);
      context.audit.append.mockRejectedValueOnce(new Error('audit unavailable'));
      await expect(context.service.upsertGrant(
        context.actorId,
        'user',
        context.userId,
        {
          sourceKind: 'local',
          sourceId: 'disk-shared',
          serverId: context.serverA,
        },
      )).rejects.toThrow('audit unavailable');
      expect(await context.storage.listMountSourceGrantsForScope('user', context.userId))
        .toEqual([]);
    });
  });

  it('binds a local grant to the exact server and physical identity', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await createContext(fixture);
      const grant = await context.service.upsertGrant(
        context.actorId,
        'user',
        context.userId,
        {
          sourceKind: 'local',
          sourceId: 'disk-shared',
          serverId: context.serverA,
        },
      );
      expect(grant).toMatchObject({
        sourceKind: 'local',
        sourceId: 'disk-shared',
        serverId: context.serverA,
        sourceIdentity: 'physical-a',
      });
      expect(await context.storage.listMountSourceGrantsForScope('user', context.userId))
        .toHaveLength(1);
    });
  });

  it('rechecks ManageGrants inside the same Kysely transaction', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await createContext(fixture, false);
      await expect(context.service.upsertGrant(
        context.actorId,
        'user',
        context.userId,
        {
          sourceKind: 'local',
          sourceId: 'disk-shared',
          serverId: context.serverA,
        },
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
      expect(await context.storage.listMountSourceGrantsForScope('user', context.userId))
        .toHaveLength(0);
    });
  });

  it('deletes only the requested local server identity', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await createContext(fixture);
      await context.service.upsertGrant(context.actorId, 'user', context.userId, {
        sourceKind: 'local',
        sourceId: 'disk-shared',
        serverId: context.serverA,
      });
      await context.service.upsertGrant(context.actorId, 'user', context.userId, {
        sourceKind: 'local',
        sourceId: 'disk-shared',
        serverId: context.serverB,
      });
      await context.service.deleteGrant(context.actorId, 'user', context.userId, {
        sourceKind: 'local',
        sourceId: 'disk-shared',
        serverId: context.serverA,
      });
      expect(await context.storage.listMountSourceGrantsForScope('user', context.userId))
        .toMatchObject([{
          serverId: context.serverB,
          sourceIdentity: 'physical-b',
        }]);
    });
  });

  it('rolls back a local identity replacement while a dependency uses the old identity', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await createContext(fixture);
      await context.service.upsertGrant(context.actorId, 'user', context.userId, {
        sourceKind: 'local',
        sourceId: 'disk-shared',
        serverId: context.serverA,
      });
      await fixture.database.insertInto('control.authorization_dependencies').values({
        id: randomUUID(),
        dependency_kind: 'data_directory',
        dependency_id: randomUUID(),
        user_id: context.userId,
        server_id: context.serverA,
        source_kind: 'local',
        source_id: 'disk-shared',
        source_identity: 'physical-a',
      }).execute();
      context.snapshots.set(
        context.serverA,
        snapshot(context.serverA, 'physical-replacement'),
      );

      await expect(context.service.upsertGrant(
        context.actorId,
        'user',
        context.userId,
        {
          sourceKind: 'local',
          sourceId: 'disk-shared',
          serverId: context.serverA,
        },
      )).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }),
      });
      expect(await context.storage.listMountSourceGrantsForScope('user', context.userId))
        .toMatchObject([{ sourceIdentity: 'physical-a' }]);
    });
  });

  it('serializes remote grant upsert against source deletion without an orphan', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await createContext(fixture);
      const mountId = randomUUID();
      await context.storage.insertRemoteFsMount({
        id: mountId,
        name: 'remote-a',
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

      const upsert = context.service.upsertGrant(
        context.actorId,
        'user',
        context.userId,
        { sourceKind: 'remote', sourceId: mountId },
      );
      const remove = context.transactions.run(async (transaction) => {
        await context.service.deleteSourceInTransaction(
          transaction,
          { sourceKind: 'remote', sourceId: mountId },
        );
        await context.storage.deleteRemoteFsMount(mountId, transaction);
      });
      await Promise.allSettled([upsert, remove]);

      const persistedMount = await context.storage.findRemoteFsMount(mountId);
      const persistedGrants = await context.storage.listMountSourceGrantsForTarget({
        sourceKind: 'remote',
        sourceId: mountId,
      });
      expect(persistedGrants).toHaveLength(persistedMount ? 1 : 0);
    });
  });

  it('serializes concurrent admission at the per-scope mount grant cap', async () => {
    await withPostgresTestDatabase(async (fixture) => {
      const context = await createContext(fixture);
      await fixture.database.insertInto('iam.mount_source_grants').values(
        Array.from(
          { length: MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE - 1 },
          (_, index) => ({
            id: randomUUID(),
            user_id: context.userId,
            group_id: null,
            source_kind: 'local' as const,
            source_id: index === 0 ? 'disk-shared' : `capacity-disk-${index}`,
            server_id: context.serverA,
            source_identity: index === 0 ? 'physical-a' : `capacity-identity-${index}`,
          }),
        ),
      ).execute();
      const remoteIds = [randomUUID(), randomUUID()];
      for (const [index, id] of remoteIds.entries()) {
        await context.storage.insertRemoteFsMount({
          id,
          name: `capacity-remote-${index}`,
          displayName: null,
          description: null,
          type: RemoteFsType.Nfs,
          hostMountPoint: `/mnt/remote-fs/${id}`,
          options: '',
          params: {
            type: RemoteFsType.Nfs,
            nfsServer: 'nfs.example',
            exportPath: `/exports/capacity-${index}`,
            version: '4.2',
          },
        });
      }

      const attempts = await Promise.allSettled(remoteIds.map((sourceId) =>
        context.service.upsertGrant(
          context.actorId,
          'user',
          context.userId,
          { sourceKind: 'remote', sourceId },
        )));
      expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(attempts.find(({ status }) => status === 'rejected')).toMatchObject({
        reason: {
          response: expect.objectContaining({
            code: 'MOUNT_SOURCE_GRANT_CAPACITY_REACHED',
            maxGrants: MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE,
          }),
        },
      });
      expect(await context.storage.listMountSourceGrantsForScope(
        'user',
        context.userId,
      )).toHaveLength(MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE);

      const winnerIndex = attempts.findIndex(({ status }) => status === 'fulfilled');
      await expect(context.service.upsertGrant(
        context.actorId,
        'user',
        context.userId,
        { sourceKind: 'remote', sourceId: remoteIds[winnerIndex]! },
      )).resolves.toMatchObject({ sourceId: remoteIds[winnerIndex] });
      context.snapshots.set(
        context.serverA,
        snapshot(context.serverA, 'physical-at-cap-replacement'),
      );
      await expect(context.service.upsertGrant(
        context.actorId,
        'user',
        context.userId,
        {
          sourceKind: 'local',
          sourceId: 'disk-shared',
          serverId: context.serverA,
        },
      )).resolves.toMatchObject({
        sourceIdentity: 'physical-at-cap-replacement',
      });
      const finalGrants = await context.storage.listMountSourceGrantsForScope(
        'user',
        context.userId,
      );
      expect(finalGrants).toHaveLength(MAX_MOUNT_SOURCE_GRANTS_PER_SCOPE);
      expect(finalGrants.filter((grant) =>
        grant.sourceKind === 'local'
        && grant.sourceId === 'disk-shared'
        && grant.serverId === context.serverA)).toMatchObject([
        { sourceIdentity: 'physical-at-cap-replacement' },
      ]);
    });
  });
});

async function createContext(
  fixture: PostgresTestDatabase,
  actorAuthorized = true,
) {
  const infrastructure = new InfrastructureRepository(fixture.database);
  const storage = new StorageRepository(fixture.database);
  const transactions = new PgTransactionManager(fixture.database);
  const actorId = randomUUID();
  const userId = randomUUID();
  const groupId = randomUUID();
  const serverA = randomUUID();
  const serverB = randomUUID();
  await infrastructure.insertServer({
    id: serverA,
    name: 'server-a',
    slug: 'server-a',
    agentTokenHash: 'a'.repeat(64),
  });
  await infrastructure.insertServer({
    id: serverB,
    name: 'server-b',
    slug: 'server-b',
    agentTokenHash: 'b'.repeat(64),
  });
  await fixture.database.insertInto('iam.users').values([
    {
      id: actorId,
      numeric_id: 1,
      username: 'actor',
      password_hash: 'hash',
      display_name: 'Actor',
      status: UserStatus.Active,
      auth_version: 1,
      authz_version: 1,
    },
    {
      id: userId,
      numeric_id: 2,
      username: 'user',
      password_hash: 'hash',
      display_name: 'User',
      status: UserStatus.Active,
      auth_version: 1,
      authz_version: 1,
    },
  ]).execute();
  await fixture.database.insertInto('iam.groups').values({
    id: groupId,
    name: 'grant-writers',
    description: null,
    priority: 10,
    is_system: false,
    system_key: null,
    capabilities: actorAuthorized ? [Capability.ManageGrants] : [],
    revision: 1,
  }).execute();
  await fixture.database.insertInto('iam.group_members').values({
    id: randomUUID(),
    group_id: groupId,
    user_id: actorId,
  }).execute();

  const snapshots = new Map<string, unknown>([
    [serverA, snapshot(serverA, 'physical-a')],
    [serverB, snapshot(serverB, 'physical-b')],
  ]);
  const gateway = {
    stateCache: {
      get: (serverId: string) => snapshots.get(serverId),
    },
  };
  const access = new AccessResolverService(
    fixture.database,
    transactions,
    gateway as never,
    new AccessCacheEpochService(fixture.database),
  );
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const service = new MountSourcesService(
    storage,
    transactions,
    access,
    audit as never,
    gateway as never,
    new AccessRevocationGuardService(),
  );
  return {
    actorId,
    userId,
    serverA,
    serverB,
    storage,
    transactions,
    snapshots,
    audit,
    service,
  };
}

function snapshot(serverId: string, sourceIdentity: string) {
  return {
    serverId,
    helloAt: new Date(),
    disks: [{
      diskId: 'disk-shared',
      sourceIdentity,
      mountPoint: '/data',
      label: 'Data',
      totalBytes: 10_000,
      usedBytes: 100,
      pquotaEnabled: true,
    }],
  };
}
