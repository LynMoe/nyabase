import {
  AgentTaskStatus,
  Capability,
  GpuGrantMode,
  MAX_MANAGED_DATA_DIRS_PER_AGENT,
  RemoteFsType,
  ServerStatus,
  UserStatus,
  remoteFsSourceIdentity,
} from '@nyabase/common';
import { DataSource, EntityManager } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';
import { AccessRevocationGuardService } from '../access/access-revocation-guard.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import type { AgentTasksService } from '../agent-tasks/agent-tasks.service.js';
import type { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import type { AgentGateway } from '../gateway/agent-gateway.js';
import { MountSourcesService } from '../mount-sources/mount-sources.service.js';
import type { ServersService } from '../servers/servers.service.js';
import type { UsersService } from '../users/users.service.js';
import { DataDirsService } from './datadirs.service.js';

describe('DataDirsService create versus mount grant revocation', () => {
  let dataSource: DataSource;
  let dataDirs: DataDirsService;
  let mountSources: MountSourcesService;
  let pauseBeforeCommit: Promise<void> | null;
  let reachedBeforeCommit: (() => void) | null;
  const snapshot = {
    serverId: 'server-a',
    helloAt: Date.now(),
    disks: [{
      diskId: 'disk-a',
      sourceIdentity: 'physical-a',
      mountPoint: '/mnt/disk-a',
      label: null,
    }],
  };

  beforeEach(async () => {
    snapshot.disks[0].sourceIdentity = 'physical-a';
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        ServerEntity,
        UserEntity,
        GroupEntity,
        GroupMemberEntity,
        ServerGrantEntity,
        ImageEntity,
        ImageGrantEntity,
        RemoteFsMountEntity,
        RemoteFsServerAssignmentEntity,
        MountSourceGrantEntity,
        ContainerEntity,
        ContainerMountEntity,
        DataDirectoryEntity,
        QuotaDesiredEntity,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save({
      id: 'server-a', name: 'server-a', slug: 'server-a', agentTokenHash: 'token-a',
      hostFingerprint: null, agentConfigFingerprint: null,
      status: ServerStatus.Online, lastSeenAt: new Date(),
    });
    await dataSource.getRepository(UserEntity).save({
      id: 'user-a', numericId: 1001, username: 'user-a', passwordHash: 'hash',
      displayName: 'User A', status: UserStatus.Active,
    });
    await dataSource.getRepository(UserEntity).save({
      id: 'actor-a', numericId: 1002, username: 'actor-a', passwordHash: 'hash',
      displayName: 'Actor A', status: UserStatus.Active,
    });
    await dataSource.getRepository(GroupEntity).save({
      id: 'grant-admins', name: 'Grant admins', description: null, priority: 1,
      capabilitiesJson: JSON.stringify([Capability.ManageGrants]), isSystem: false, systemKey: null,
    });
    await dataSource.getRepository(GroupMemberEntity).save({
      id: 'actor-grant-membership', groupId: 'grant-admins', userId: 'actor-a',
    });
    await dataSource.getRepository(ServerGrantEntity).save({
      id: 'server-grant-a', scope: 'user', scopeId: 'user-a', serverId: 'server-a',
      cpuMillis: 1000, memBytes: 1024, diskBytes: 4096,
      gpuMode: GpuGrantMode.None, gpuIndices: [],
    });
    await dataSource.getRepository(MountSourceGrantEntity).save({
      id: 'mount-grant-a', scope: 'user', scopeId: 'user-a', sourceKind: 'local',
      sourceId: 'disk-a', serverId: 'server-a', sourceIdentity: 'physical-a',
    });
    await dataSource.getRepository(QuotaDesiredEntity).save({
      id: 'quota-a', serverId: 'server-a', userId: 'user-a', numericUserId: 1001,
      limitBytes: 4096, source: 'grant', generation: 1, lastTaskId: 'quota-task-a',
    });
    const gateway = { stateCache: { get: () => snapshot } } as unknown as AgentGateway;
    const access = new AccessResolverService(
      dataSource.getRepository(GroupEntity),
      dataSource.getRepository(GroupMemberEntity),
      dataSource.getRepository(ServerGrantEntity),
      dataSource.getRepository(ImageGrantEntity),
      dataSource.getRepository(ImageEntity),
      dataSource.getRepository(ServerEntity),
      dataSource.getRepository(MountSourceGrantEntity),
      dataSource.getRepository(RemoteFsServerAssignmentEntity),
      gateway,
      new AccessCacheEpochService(),
    );
    mountSources = new MountSourcesService(
      dataSource.getRepository(RemoteFsMountEntity),
      dataSource.getRepository(RemoteFsServerAssignmentEntity),
      dataSource.getRepository(MountSourceGrantEntity),
      access,
      { log: vi.fn() } as unknown as AuditService,
      gateway,
      dataSource,
      new AccessRevocationGuardService(),
    );
    pauseBeforeCommit = null;
    reachedBeforeCommit = null;
    const tasks = {
      enqueue: vi.fn(async (request: {
        beforeCommit: (manager: never, context: { taskId: string }) => Promise<void>;
      }) => {
        reachedBeforeCommit?.();
        if (pauseBeforeCommit) await pauseBeforeCommit;
        await runSerializedTransaction(dataSource, (manager) => request.beforeCommit(
          manager as never,
          { taskId: 'datadir-task-a' },
        ));
        return { taskId: 'datadir-task-a', status: AgentTaskStatus.Pending };
      }),
    } as unknown as AgentTasksService;
    dataDirs = new DataDirsService(
      dataSource.getRepository(DataDirectoryEntity),
      dataSource.getRepository(ContainerMountEntity),
      dataSource.getRepository(RemoteFsMountEntity),
      dataSource.getRepository(RemoteFsServerAssignmentEntity),
      dataSource.getRepository(QuotaDesiredEntity),
      {} as ServersService,
      { getNumericIdsByUserIds: async () => new Map([['user-a', 1001]]) } as unknown as UsersService,
      { log: vi.fn() } as unknown as AuditService,
      tasks,
      {
        dataDir: () => 'datadir-lock',
        mountSource: () => 'mount-lock',
        quota: () => 'quota-lock',
      } as unknown as ResourceKeyService,
      gateway,
      access,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects create when revocation commits before create beforeCommit', async () => {
    let release!: () => void;
    pauseBeforeCommit = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { reachedBeforeCommit = resolve; });
    const create = dataDirs.createDir(
      'actor-a', 'user-a', 'server-a', 'local', 'disk-a', 'dir-a', 1001,
    );
    await reached;

    await mountSources.deleteGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-a', serverId: 'server-a',
    });
    release();

    await expect(create).rejects.toThrow('authorization changed');
    expect(await dataSource.getRepository(DataDirectoryEntity).count()).toBe(0);
  });

  it('rejects an admin create when ManageContainersAny is revoked before task admission', async () => {
    await dataSource.getRepository(GroupEntity).update('grant-admins', {
      capabilitiesJson: JSON.stringify([
        Capability.ManageGrants,
        Capability.ManageContainersAny,
      ]),
    });
    let release!: () => void;
    pauseBeforeCommit = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { reachedBeforeCommit = resolve; });
    const create = dataDirs.createDir(
      'actor-a',
      'user-a',
      'server-a',
      'local',
      'disk-a',
      'admin-dir',
      1001,
      'admin',
    );
    await reached;

    await dataSource.getRepository(GroupEntity).update('grant-admins', {
      capabilitiesJson: JSON.stringify([Capability.ManageGrants]),
    });
    release();

    await expect(create).rejects.toThrow();
    expect(await dataSource.getRepository(DataDirectoryEntity).count()).toBe(0);
  });

  it('commits create first and then rejects revocation without orphaning the directory', async () => {
    await expect(dataDirs.createDir(
      'actor-a', 'user-a', 'server-a', 'local', 'disk-a', 'dir-a', 1001,
    )).resolves.toMatchObject({ taskId: 'datadir-task-a' });

    await expect(mountSources.deleteGrant('actor-a', 'user', 'user-a', {
      sourceKind: 'local', sourceId: 'disk-a', serverId: 'server-a',
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }) });
    expect(await dataSource.getRepository(DataDirectoryEntity).count()).toBe(1);
    expect(await dataSource.getRepository(MountSourceGrantEntity).count()).toBe(1);
  });

  it('rejects the next directory at the platform-wide report-safe capacity', async () => {
    const originalCount = EntityManager.prototype.count;
    const countSpy = vi.spyOn(EntityManager.prototype, 'count').mockImplementation(function (
      this: EntityManager,
      entity: Parameters<EntityManager['count']>[0],
      options?: Parameters<EntityManager['count']>[1],
    ) {
      if (entity === DataDirectoryEntity) {
        return Promise.resolve(MAX_MANAGED_DATA_DIRS_PER_AGENT);
      }
      return originalCount.call(this, entity, options as never);
    });

    await expect(dataDirs.createDir(
      'actor-a', 'user-a', 'server-a', 'local', 'disk-a', 'overflow', 1001,
    )).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DATA_DIRECTORY_CAPACITY_REACHED' }),
    });
    countSpy.mockRestore();
    expect(await dataSource.getRepository(DataDirectoryEntity).count()).toBe(0);
  });

  it('rejects delete when the local disk identity no longer matches the reservation', async () => {
    await dataSource.getRepository(DataDirectoryEntity).save({
      id: 'dir-a', userId: 'user-a', sourceKind: 'local', sourceId: 'disk-a',
      name: 'data-a', sourceIdentity: 'physical-a', serverId: 'server-a', uid: 1001,
      desiredState: 'active', generation: 1, lastTaskId: 'create-task-a',
    });
    snapshot.disks[0].sourceIdentity = 'physical-replacement';

    await expect(dataDirs.deleteDir(
      'actor-a', 'user-a', 'server-a', 'local', 'disk-a', 'data-a',
    )).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DATA_DIRECTORY_SOURCE_NOT_READY' }),
    });
    expect(await dataSource.getRepository(DataDirectoryEntity).findOneByOrFail({ id: 'dir-a' }))
      .toMatchObject({ desiredState: 'active', generation: 1, lastTaskId: 'create-task-a' });
  });

  it('rejects delete when the remote assignment disappears before task admission', async () => {
    const params = {
      type: RemoteFsType.Nfs,
      nfsServer: 'nfs.example',
      exportPath: '/data',
      version: '4.2',
    } as const;
    await dataSource.getRepository(RemoteFsMountEntity).save({
      id: 'remote-a', name: 'remote-a', displayName: null, description: null,
      type: RemoteFsType.Nfs, hostMountPoint: '/mnt/remote-a', options: '', params,
      desiredState: 'active', generation: 1, lastTaskId: null,
    });
    await dataSource.getRepository(RemoteFsServerAssignmentEntity).save({
      id: 'assignment-a', remoteFsMountId: 'remote-a', serverId: 'server-a',
      desiredState: 'active', generation: 1, lastTaskId: 'ensure-task-a',
    });
    await dataSource.getRepository(DataDirectoryEntity).save({
      id: 'dir-remote-a', userId: 'user-a', sourceKind: 'remote', sourceId: 'remote-a',
      name: 'data-a', sourceIdentity: remoteFsSourceIdentity(params), serverId: null, uid: 1001,
      desiredState: 'active', generation: 1, lastTaskId: 'create-task-a',
    });

    let release!: () => void;
    pauseBeforeCommit = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { reachedBeforeCommit = resolve; });
    const deleting = dataDirs.deleteDir(
      'actor-a', 'user-a', 'server-a', 'remote', 'remote-a', 'data-a',
    );
    await reached;
    await dataSource.getRepository(RemoteFsServerAssignmentEntity).delete({ id: 'assignment-a' });
    release();

    await expect(deleting).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DATA_DIRECTORY_SOURCE_NOT_READY' }),
    });
    expect(await dataSource.getRepository(DataDirectoryEntity).findOneByOrFail({ id: 'dir-remote-a' }))
      .toMatchObject({ desiredState: 'active', generation: 1, lastTaskId: 'create-task-a' });
  });
});
