import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MANAGED_DATA_DIRS_PER_AGENT, RemoteFsType, ServerStatus } from '@nyabase/common';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { assertAgentDataDirCapacity } from './data-dir-capacity.js';

describe('Agent DataDir projection capacity', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        DataDirectoryEntity,
        RemoteFsServerAssignmentEntity,
        RemoteFsMountEntity,
        ServerEntity,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save([
      server('server-a'),
      server('server-b'),
    ]);
    await dataSource.getRepository(RemoteFsMountEntity).save([
      remoteMount('remote-a'),
      remoteMount('remote-b'),
    ]);
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('counts local and every assigned global RemoteFS row for one Server', async () => {
    await dataSource.getRepository(DataDirectoryEntity).save([
      dataDir('local-a', 'local', 'disk-a', 'server-a'),
      dataDir('local-other', 'local', 'disk-a', 'server-b'),
      dataDir('remote-a', 'remote', 'remote-a', null),
      dataDir('remote-b', 'remote', 'remote-b', null),
    ]);
    await dataSource.getRepository(RemoteFsServerAssignmentEntity).save({
      id: 'assignment-a',
      remoteFsMountId: 'remote-a',
      serverId: 'server-a',
      desiredState: 'removing',
      generation: 1,
      lastTaskId: null,
    });

    await expect(dataSource.transaction((manager) => assertAgentDataDirCapacity(
      manager,
      'server-a',
      { includeRemoteMountId: 'remote-b', additionalRows: MAX_MANAGED_DATA_DIRS_PER_AGENT - 3 },
    ))).resolves.toBeUndefined();
    await expect(dataSource.transaction((manager) => assertAgentDataDirCapacity(
      manager,
      'server-a',
      { includeRemoteMountId: 'remote-b', additionalRows: MAX_MANAGED_DATA_DIRS_PER_AGENT - 2 },
    ))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DATA_DIRECTORY_CAPACITY_REACHED' }),
    });
  });
});

function dataDir(
  id: string,
  sourceKind: 'local' | 'remote',
  sourceId: string,
  serverId: string | null,
) {
  return {
    id,
    userId: 'user-a',
    sourceKind,
    sourceId,
    name: id,
    sourceIdentity: `${sourceKind}:${sourceId}`,
    serverId,
    uid: 1000,
    desiredState: 'active' as const,
    generation: 1,
    lastTaskId: null,
  };
}

function server(id: string) {
  return {
    id,
    name: id,
    slug: id,
    agentTokenHash: `hash-${id}`,
    hostFingerprint: null,
    status: ServerStatus.Unknown,
    lastSeenAt: null,
  };
}

function remoteMount(id: string) {
  return {
    id,
    name: id,
    displayName: null,
    description: null,
    type: RemoteFsType.Nfs,
    hostMountPoint: `/mnt/remote-fs/${id}`,
    options: '',
    params: {
      type: RemoteFsType.Nfs as RemoteFsType.Nfs,
      nfsServer: 'nfs.internal',
      exportPath: `/${id}`,
      version: '4.2' as const,
    },
    desiredState: 'active' as const,
    generation: 1,
    lastTaskId: null,
  };
}
