import { RemoteFsType, ServerStatus, UserStatus } from '@nyabase/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessRevocationGuardService } from '../access/access-revocation-guard.service.js';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import type { AgentGateway } from '../gateway/agent-gateway.js';
import { MountSourcesService } from './mount-sources.service.js';

describe('MountSourcesService canonical grant writer', () => {
  let dataSource: DataSource;
  let service: MountSourcesService;
  const snapshots = new Map<string, unknown>();

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        ServerEntity,
        UserEntity,
        GroupEntity,
        GroupMemberEntity,
        RemoteFsMountEntity,
        RemoteFsServerAssignmentEntity,
        MountSourceGrantEntity,
        ImageEntity,
        ContainerEntity,
        ContainerMountEntity,
        DataDirectoryEntity,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save(server('server-a'));
    await dataSource.getRepository(ServerEntity).save(server('server-b'));
    await dataSource.getRepository(UserEntity).save(user('user-a'));
    await dataSource.getRepository(GroupEntity).save(group('group-a'));
    snapshots.clear();
    snapshots.set('server-a', snapshot('server-a', 'disk-shared', 'physical-a'));
    snapshots.set('server-b', snapshot('server-b', 'disk-shared', 'physical-b'));
    const access = { invalidateAll: vi.fn() } as unknown as AccessResolverService;
    service = new MountSourcesService(
      dataSource.getRepository(RemoteFsMountEntity),
      dataSource.getRepository(RemoteFsServerAssignmentEntity),
      dataSource.getRepository(MountSourceGrantEntity),
      access,
      { log: vi.fn() } as unknown as AuditService,
      { stateCache: { get: (id: string) => snapshots.get(id) } } as unknown as AgentGateway,
      dataSource,
      new AccessRevocationGuardService(),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('binds a local grant to the exact server and physical identity', async () => {
    const grant = await service.upsertGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    });

    expect(grant).toMatchObject({
      sourceKind: 'local',
      sourceId: 'disk-shared',
      serverId: 'server-a',
      sourceIdentity: 'physical-a',
    });
    expect(await dataSource.getRepository(MountSourceGrantEntity).countBy({
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-b',
    })).toBe(0);
  });

  it('deletes only the requested local server identity', async () => {
    await service.upsertGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    });
    await service.upsertGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-b',
    });

    await service.deleteGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    });

    expect(await dataSource.getRepository(MountSourceGrantEntity).find()).toMatchObject([
      { serverId: 'server-b', sourceIdentity: 'physical-b' },
    ]);
  });

  it('serializes remote upsert against source deletion without leaving an orphan', async () => {
    await dataSource.getRepository(RemoteFsMountEntity).save(remoteMount('remote-a'));
    const upsert = service.upsertGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'remote', sourceId: 'remote-a',
    });
    const remove = runSerializedTransaction(dataSource, async (manager) => {
      await service.deleteSourceInTransaction(manager, {
        sourceKind: 'remote', sourceId: 'remote-a',
      });
      await manager.delete(RemoteFsMountEntity, 'remote-a');
    });

    await Promise.allSettled([upsert, remove]);
    expect(await dataSource.getRepository(RemoteFsMountEntity).countBy({ id: 'remote-a' })).toBe(0);
    expect(await dataSource.getRepository(MountSourceGrantEntity).countBy({ sourceId: 'remote-a' })).toBe(0);
  });

  it('serializes group deletion against grant upsert without leaving an orphan', async () => {
    await dataSource.getRepository(RemoteFsMountEntity).save(remoteMount('remote-a'));
    const remove = runSerializedTransaction(dataSource, async (manager) => {
      await service.deleteScopeInTransaction(manager, 'group', 'group-a');
      await manager.delete(GroupEntity, 'group-a');
    });
    const upsert = service.upsertGrant('actor-a', 'group', 'group-a', {
      sourceKind: 'remote', sourceId: 'remote-a',
    });

    await Promise.allSettled([remove, upsert]);
    expect(await dataSource.getRepository(GroupEntity).countBy({ id: 'group-a' })).toBe(0);
    expect(await dataSource.getRepository(MountSourceGrantEntity).countBy({
      scope: 'group', scopeId: 'group-a',
    })).toBe(0);
  });

  it('rejects an upsert queued after a user becomes disabled', async () => {
    const disable = runSerializedTransaction(dataSource, async (manager) => {
      await manager.update(UserEntity, 'user-a', { status: UserStatus.Disabled });
    });
    const upsert = service.upsertGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    });

    await disable;
    await expect(upsert).rejects.toThrow('active user');
    expect(await dataSource.getRepository(MountSourceGrantEntity).count()).toBe(0);
  });

  it('never grants a mount source to a terminal deleted user', async () => {
    await dataSource.getRepository(UserEntity).update('user-a', { status: UserStatus.Deleted });

    await expect(service.upsertGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'USER_DELETED' }) });
    expect(await dataSource.getRepository(MountSourceGrantEntity).count()).toBe(0);
  });

  it('rolls back local identity replacement while resources still use the old identity', async () => {
    await service.upsertGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    });
    await dataSource.getRepository(DataDirectoryEntity).save(dataDir('physical-a'));
    snapshots.set('server-a', snapshot('server-a', 'disk-shared', 'physical-replacement'));

    await expect(service.upsertGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }) });

    expect(await dataSource.getRepository(MountSourceGrantEntity).findOneByOrFail({
      scope: 'user', scopeId: 'user-a', sourceKind: 'local', sourceId: 'disk-shared',
    })).toMatchObject({ sourceIdentity: 'physical-a' });
  });

  it('blocks the last exact mount grant with a data directory but allows an effective alternate', async () => {
    await service.upsertGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    });
    await dataSource.getRepository(DataDirectoryEntity).save(dataDir('physical-a'));

    await expect(service.deleteGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }) });

    await dataSource.getRepository(GroupMemberEntity).save({
      id: 'member-a', groupId: 'group-a', userId: 'user-a',
    });
    await service.upsertGrant('actor-a', 'group', 'group-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    });
    await expect(service.deleteGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    })).resolves.toBeUndefined();
    expect(await dataSource.getRepository(MountSourceGrantEntity).find()).toMatchObject([
      { scope: 'group', scopeId: 'group-a', sourceIdentity: 'physical-a' },
    ]);
  });

  it('does not let a container on replacement identity B pin a stale grant for identity A', async () => {
    snapshots.set('server-a', snapshot('server-a', 'disk-shared', 'physical-b'));
    await dataSource.getRepository(GroupMemberEntity).save({
      id: 'member-a', groupId: 'group-a', userId: 'user-a',
    });
    await dataSource.getRepository(MountSourceGrantEntity).save([
      {
        id: 'stale-user-a', scope: 'user', scopeId: 'user-a', sourceKind: 'local',
        sourceId: 'disk-shared', serverId: 'server-a', sourceIdentity: 'physical-a',
      },
      {
        id: 'current-group-b', scope: 'group', scopeId: 'group-a', sourceKind: 'local',
        sourceId: 'disk-shared', serverId: 'server-a', sourceIdentity: 'physical-b',
      },
    ]);
    await dataSource.getRepository(ImageEntity).save({
      id: 'image-a', name: 'image-a', dockerImage: 'alpine:3.20',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      description: null, isActive: true, disableSsh: false,
    });
    await dataSource.getRepository(ContainerEntity).save({
      id: 'container-a', serverId: 'server-a', ownerId: 'user-a', name: 'container-a',
      imageId: 'image-a', createdBy: 'user-a',
    });
    await dataSource.getRepository(DataDirectoryEntity).save(dataDir('physical-b'));
    await dataSource.getRepository(ContainerMountEntity).save({
      id: 'container-mount-a', serverId: 'server-a', containerId: 'container-a',
      containerName: 'container-a', sourceKind: 'local', sourceId: 'disk-shared',
      sourceIdentity: 'physical-b',
      userId: 'user-a', dirName: 'data-a', containerPath: '/data',
    });

    await expect(service.deleteGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-shared', serverId: 'server-a',
    })).resolves.toBeUndefined();

    expect(await dataSource.getRepository(MountSourceGrantEntity).find()).toMatchObject([
      { id: 'current-group-b', sourceIdentity: 'physical-b' },
    ]);
  });

  it('enforces shape, partial uniqueness, and the local server FK in SQLite', async () => {
    const grants = dataSource.getRepository(MountSourceGrantEntity);
    await expect(grants.save(grants.create({
      id: 'invalid-local', scope: 'user', scopeId: 'user-a',
      sourceKind: 'local', sourceId: 'disk-a', serverId: null, sourceIdentity: null,
    }))).rejects.toThrow();
    await grants.save(grants.create({
      id: 'local-a', scope: 'user', scopeId: 'user-a', sourceKind: 'local',
      sourceId: 'disk-a', serverId: 'server-a', sourceIdentity: 'physical-a',
    }));
    await expect(grants.save(grants.create({
      id: 'local-duplicate', scope: 'user', scopeId: 'user-a', sourceKind: 'local',
      sourceId: 'disk-a', serverId: 'server-a', sourceIdentity: 'physical-a',
    }))).rejects.toThrow();
    await expect(dataSource.getRepository(ServerEntity).delete('server-a')).rejects.toThrow();
  });
});

function server(id: string) {
  return {
    id,
    name: id,
    slug: id,
    agentTokenHash: `token-${id}`,
    hostFingerprint: null,
    agentConfigFingerprint: null,
    status: ServerStatus.Unknown,
    lastSeenAt: null,
  };
}

function user(id: string) {
  return {
    id,
    numericId: 1001,
    username: id,
    passwordHash: 'hash',
    displayName: id,
    status: UserStatus.Active,
  };
}

function group(id: string) {
  return {
    id,
    name: id,
    description: null,
    priority: 1,
    isSystem: false,
    capabilitiesJson: '[]',
  };
}

function remoteMount(id: string) {
  return {
    id,
    name: id,
    displayName: null,
    description: null,
    type: RemoteFsType.Nfs as RemoteFsType.Nfs,
    hostMountPoint: `/mnt/${id}`,
    options: '',
    params: {
      type: RemoteFsType.Nfs as RemoteFsType.Nfs,
      nfsServer: 'nfs.example',
      exportPath: '/data',
      version: '4.2' as const,
    },
    desiredState: 'active' as const,
    generation: 1,
    lastTaskId: null,
  };
}

function snapshot(serverId: string, diskId: string, sourceIdentity: string) {
  return {
    serverId,
    helloAt: Date.now(),
    disks: [{ diskId, sourceIdentity, mountPoint: `/mnt/${serverId}`, label: null }],
  };
}

function dataDir(sourceIdentity: string) {
  return {
    id: 'dir-a',
    userId: 'user-a',
    sourceKind: 'local' as const,
    sourceId: 'disk-shared',
    name: 'data-a',
    sourceIdentity,
    serverId: 'server-a',
    uid: 1001,
    desiredState: 'active' as const,
    generation: 1,
    lastTaskId: null,
  };
}
