import { GpuGrantMode, UserStatus } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { AccessResolverService } from './access-resolver.service.js';

describe('AccessResolverService exact local mount identity', () => {
  it('does not transfer a duplicate disk id across servers or survive identity replacement', async () => {
    const snapshots = new Map<string, {
      serverId: string;
      helloAt: number;
      disks: Array<{ diskId: string; sourceIdentity: string }>;
    }>([
      ['server-a', snapshot('server-a', 'physical-a')],
      ['server-b', snapshot('server-b', 'physical-b')],
    ]);
    const service = new AccessResolverService(
      queryBuilderRepo([]) as never,
      { find: async () => [] } as never,
      {
        find: async () => [serverGrant('server-a'), serverGrant('server-b')],
        ...queryBuilderRepo([]),
      } as never,
      { find: async () => [], ...queryBuilderRepo([]) } as never,
      { find: async () => [] } as never,
      { find: async () => [{ id: 'server-a' }, { id: 'server-b' }] } as never,
      {
        find: async () => [{
          id: 'grant-a',
          scope: 'user',
          scopeId: 'user-a',
          sourceKind: 'local',
          sourceId: 'shared-disk-id',
          serverId: 'server-a',
          sourceIdentity: 'physical-a',
        }],
        ...queryBuilderRepo([]),
      } as never,
      { find: async () => [] } as never,
      { stateCache: { get: (serverId: string) => snapshots.get(serverId) } } as never,
      new AccessCacheEpochService(),
    );

    await expect(service.hasMountSourceAccess(
      'user-a', 'server-a', 'local', 'shared-disk-id',
    )).resolves.toBe(true);
    await expect(service.hasMountSourceAccess(
      'user-a', 'server-b', 'local', 'shared-disk-id',
    )).resolves.toBe(false);

    snapshots.set('server-a', snapshot('server-a', 'replacement-a'));
    await expect(service.hasMountSourceAccess(
      'user-a', 'server-a', 'local', 'shared-disk-id',
    )).resolves.toBe(false);
  });

  it('rejects container preflight when the local identity changes after request preparation', async () => {
    const service = new AccessResolverService(
      queryBuilderRepo([]) as never,
      { find: async () => [] } as never,
      { find: async () => [], ...queryBuilderRepo([]) } as never,
      { find: async () => [], ...queryBuilderRepo([]) } as never,
      { find: async () => [] } as never,
      { find: async () => [{ id: 'server-a' }] } as never,
      { find: async () => [], ...queryBuilderRepo([]) } as never,
      { find: async () => [] } as never,
      { stateCache: { get: () => snapshot('server-a', 'replacement-a') } } as never,
      new AccessCacheEpochService(),
    );
    const manager = {
      findOneBy: async (entity: { name: string }) => entity.name === 'UserEntity'
        ? { id: 'user-a', status: UserStatus.Active }
        : null,
      findOne: async (entity: { name: string }) => entity.name === 'ServerGrantEntity'
        ? serverGrant('server-a')
        : null,
      find: async () => [],
      count: async () => 1,
    };

    await expect(service.resolveContainerCreateAccessInTransaction(
      manager as never,
      'user-a',
      'server-a',
      'image-a',
      [{ kind: 'local', id: 'shared-disk-id', sourceIdentity: 'physical-a' }],
    )).resolves.toMatchObject({ mountSourcesAllowed: false });
  });
});

function queryBuilderRepo(rows: unknown[]) {
  return {
    createQueryBuilder: () => ({
      where: () => ({
        orderBy: () => ({
          addOrderBy: () => ({ getMany: async () => rows }),
        }),
        getMany: async () => rows,
      }),
    }),
  };
}

function snapshot(serverId: string, sourceIdentity: string) {
  return {
    serverId,
    helloAt: Date.now(),
    disks: [{ diskId: 'shared-disk-id', sourceIdentity }],
  };
}

function serverGrant(serverId: string) {
  return {
    id: `grant-${serverId}`,
    scope: 'user',
    scopeId: 'user-a',
    serverId,
    cpuMillis: 0,
    memBytes: 0,
    diskBytes: 0,
    gpuMode: GpuGrantMode.None,
    gpuIndices: [],
  };
}
