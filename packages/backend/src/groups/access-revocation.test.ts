import {
  AgentTaskKind,
  AgentTaskStatus,
  GpuGrantMode,
  RemoteFsType,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import { DataSource, In } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessRevocationGuardService } from '../access/access-revocation-guard.service.js';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import type { AuditService } from '../audit/audit.service.js';
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
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import type { AgentGateway } from '../gateway/agent-gateway.js';
import { MountSourcesService } from '../mount-sources/mount-sources.service.js';
import type { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import type { QuotaDispatchService } from '../quota/quota-dispatch.service.js';
import { GroupsService } from './groups.service.js';
import { AgentTaskFinalizerService } from '../agent-tasks/agent-task-finalizer.service.js';

describe('GroupsService fail-closed access revocation', () => {
  let dataSource: DataSource;
  let service: GroupsService;
  let quotaApply: ReturnType<typeof vi.fn>;
  let access: AccessResolverService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        ServerEntity,
        UserEntity,
        SshPublicKeyEntity,
        UserInternalSshKeyEntity,
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
        AgentTaskEntity,
        ResourceLockEntity,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save(server());
    await dataSource.getRepository(UserEntity).save(user());
    quotaApply = vi.fn().mockResolvedValue('quota-task-a');
    access = {
      invalidateUser: vi.fn(),
      invalidateAll: vi.fn(),
      assertActorCapabilitiesInTransaction: vi.fn().mockResolvedValue(new Set()),
      assertActorMayAdministerUserInTransaction: vi.fn().mockResolvedValue(undefined),
      assertNotFinalActiveAdministratorInTransaction: vi.fn().mockResolvedValue(undefined),
      resolveServerInTransaction: vi.fn(async (manager, userId, serverId) => {
        const direct = await manager.findOneBy(ServerGrantEntity, {
          scope: 'user', scopeId: userId, serverId,
        });
        if (direct) return resolvedGrant(direct.diskBytes);
        const memberships = await manager.find(GroupMemberEntity, { where: { userId } });
        if (memberships.length === 0) return null;
        const inherited = await manager.findOne(ServerGrantEntity, {
          where: {
            scope: 'group',
            scopeId: In(memberships.map((membership: GroupMemberEntity) => membership.groupId)),
            serverId,
          },
        });
        return inherited ? resolvedGrant(inherited.diskBytes) : null;
      }),
    } as unknown as AccessResolverService;
    const guard = new AccessRevocationGuardService();
    const mountSources = new MountSourcesService(
      dataSource.getRepository(RemoteFsMountEntity),
      dataSource.getRepository(RemoteFsServerAssignmentEntity),
      dataSource.getRepository(MountSourceGrantEntity),
      access,
      { log: vi.fn() } as unknown as AuditService,
      { stateCache: { get: vi.fn() } } as unknown as AgentGateway,
      dataSource,
      guard,
    );
    service = new GroupsService(
      dataSource.getRepository(GroupEntity),
      dataSource.getRepository(GroupMemberEntity),
      dataSource.getRepository(ServerGrantEntity),
      dataSource.getRepository(ImageGrantEntity),
      dataSource.getRepository(UserEntity),
      access,
      { log: vi.fn() } as unknown as AuditService,
      { applyInTransaction: quotaApply } as unknown as QuotaDispatchService,
      dataSource,
      mountSources,
      guard,
      { notify: vi.fn().mockResolvedValue(undefined) } as unknown as ProxySnapshotNotifierService,
      { deleteUserCredentialsInTransaction: vi.fn() } as never,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rolls back the last server grant when owned resources remain', async () => {
    await saveUserGrant('user-grant', 4096);
    await saveQuota(4096);
    await saveContainer();

    await expect(service.deleteUserServerGrant('user-a', 'server-a', 'actor-a'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }) });

    expect(await dataSource.getRepository(ServerGrantEntity).count()).toBe(1);
    expect(await dataSource.getRepository(QuotaDesiredEntity).findOneByOrFail({ id: 'quota-a' }))
      .toMatchObject({ limitBytes: 4096, generation: 1 });
    expect(quotaApply).not.toHaveBeenCalled();
  });

  it('allows deleting a direct override when a group grant remains and syncs the alternate quota', async () => {
    await saveGroupAccess(2048);
    await saveUserGrant('user-grant', 4096);

    await expect(service.deleteUserServerGrant('user-a', 'server-a', 'actor-a'))
      .resolves.toEqual({ taskIds: ['quota-task-a'] });

    expect(await dataSource.getRepository(ServerGrantEntity).countBy({ scope: 'user' })).toBe(0);
    expect(quotaApply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-a', serverId: 'server-a', diskBytes: 2048,
    }));
  });

  it('allows a resource-free final revoke without dispatching unlimited quota and preserves the ceiling', async () => {
    await saveUserGrant('user-grant', 4096);
    await saveQuota(4096);

    await expect(service.deleteUserServerGrant('user-a', 'server-a', 'actor-a'))
      .resolves.toEqual({ taskIds: [] });

    expect(quotaApply).not.toHaveBeenCalled();
    expect(await dataSource.getRepository(QuotaDesiredEntity).findOneByOrFail({ id: 'quota-a' }))
      .toMatchObject({ limitBytes: 4096, generation: 1 });
  });

  it('blocks server revocation while an active assignment exposes a remote data directory', async () => {
    await saveUserGrant('user-grant', 4096);
    await dataSource.getRepository(RemoteFsMountEntity).save({
      id: 'remote-a', name: 'remote-a', displayName: null, description: null,
      type: RemoteFsType.Nfs,
      hostMountPoint: '/mnt/remote-a', options: '',
      params: {
        type: RemoteFsType.Nfs,
        nfsServer: 'nfs.example',
        exportPath: '/data',
        version: '4.2',
      },
      desiredState: 'active', generation: 1, lastTaskId: null,
    });
    await dataSource.getRepository(RemoteFsServerAssignmentEntity).save({
      id: 'assignment-a', remoteFsMountId: 'remote-a', serverId: 'server-a',
      desiredState: 'active', generation: 1, lastTaskId: null,
    });
    await dataSource.getRepository(DataDirectoryEntity).save({
      ...dataDir(),
      sourceKind: 'remote',
      sourceId: 'remote-a',
      sourceIdentity: 'remote-physical-a',
      serverId: null,
    });

    await expect(service.deleteUserServerGrant('user-a', 'server-a', 'actor-a'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }) });
    expect(await dataSource.getRepository(ServerGrantEntity).count()).toBe(1);
  });

  it('rolls back member removal and group deletion while inherited resources remain', async () => {
    await saveGroupAccess(2048);
    await saveContainer();

    await expect(service.removeMember('group-a', 'user-a', 'actor-a'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }) });
    expect(await dataSource.getRepository(GroupMemberEntity).count()).toBe(1);

    await expect(service.delete('group-a', 'actor-a'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'ACCESS_REVOKE_HAS_RESOURCES' }) });
    expect(await dataSource.getRepository(GroupEntity).count()).toBe(1);
    expect(await dataSource.getRepository(GroupMemberEntity).count()).toBe(1);
    expect(await dataSource.getRepository(ServerGrantEntity).count()).toBe(1);
  });

  it('blocks deleting a user with resources, then atomically tombstones and cleans an empty user', async () => {
    await saveUserSshKeys();
    await saveUserGrant('user-grant', 4096);
    await saveQuota(4096);
    await saveQuotaTask({ sent: false });
    await dataSource.getRepository(DataDirectoryEntity).save(dataDir());

    await expect(service.deleteUserPermanently('user-a', 'actor-a'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'USER_DELETE_HAS_RESOURCES' }) });
    expect(await dataSource.getRepository(UserEntity).findOneByOrFail({ id: 'user-a' }))
      .toMatchObject({ status: UserStatus.Active });
    expect(await dataSource.getRepository(ServerGrantEntity).count()).toBe(1);
    expect(await dataSource.getRepository(SshPublicKeyEntity).count()).toBe(1);
    expect(await dataSource.getRepository(UserInternalSshKeyEntity).count()).toBe(1);

    await dataSource.getRepository(DataDirectoryEntity).delete('dir-a');
    quotaApply.mockImplementationOnce(async (manager, request) => {
      const desired = await manager.findOneByOrFail(QuotaDesiredEntity, {
        serverId: request.serverId,
        userId: request.userId,
      });
      const taskId = 'quota-drain-task';
      await manager.update(QuotaDesiredEntity, desired.id, {
        limitBytes: 0,
        generation: desired.generation + 1,
        lastTaskId: taskId,
      });
      await manager.save(AgentTaskEntity, {
        id: taskId,
        kind: AgentTaskKind.QuotaEnsure,
        serverId: request.serverId,
        resourceType: 'quota',
        resourceId: request.userId,
        requestedBy: request.requestedBy,
        requestJson: { source: 'user_delete' },
        payloadJson: { generation: desired.generation + 1, numericUserId: 1001, diskBytes: 0 },
        payloadHash: 'quota-drain-hash',
        status: AgentTaskStatus.Pending,
        failureStage: null,
        agentResultJson: null,
        dispatchAttemptCount: 0,
        nextDispatchAt: null,
        finalizerAttemptCount: 0,
        finalizerRetryAt: null,
        resultJson: null,
        errorJson: null,
        startedAt: null,
        lastSentAt: null,
        completedAt: null,
      });
      await manager.save(ResourceLockEntity, {
        resourceKey: 'quota:server-a:user-a',
        taskId,
        serverId: 'server-a',
      });
      return taskId;
    });
    await expect(service.deleteUserPermanently('user-a', 'actor-a')).resolves.toEqual({
      deleted: false,
      taskIds: ['quota-drain-task'],
    });
    expect(await dataSource.getRepository(UserEntity).findOneByOrFail({ id: 'user-a' }))
      .toMatchObject({ status: UserStatus.Deleting });
    expect(await dataSource.getRepository(SshPublicKeyEntity).count()).toBe(0);
    expect(await dataSource.getRepository(UserInternalSshKeyEntity).count()).toBe(0);
    expect(await dataSource.getRepository(ServerGrantEntity).count()).toBe(0);
    expect(await dataSource.getRepository(QuotaDesiredEntity).findOneByOrFail({ id: 'quota-a' }))
      .toMatchObject({ limitBytes: 0, generation: 2, lastTaskId: 'quota-drain-task' });
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(2);
    expect(await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({
      id: 'quota-task-pending',
    })).toMatchObject({
      status: AgentTaskStatus.Failed,
      errorJson: expect.objectContaining({ code: 'TASK_SUPERSEDED' }),
      completedAt: expect.any(Date),
    });
    expect(await dataSource.getRepository(ResourceLockEntity).findOneByOrFail({
      taskId: 'quota-drain-task',
    })).toMatchObject({ resourceKey: 'quota:server-a:user-a' });

    // Simulate a pre-upgrade Deleting row whose SSH material survived the
    // initial request. The finalizer must clean it in the same transaction that
    // exposes the terminal Deleted tombstone.
    await saveUserSshKeys();
    const finalizer = new AgentTaskFinalizerService();
    await dataSource.transaction(async (manager) => {
      const drainTask = await manager.findOneByOrFail(AgentTaskEntity, { id: 'quota-drain-task' });
      await finalizer.applySucceeded(manager, drainTask, {
        numericUserId: 1001,
        diskBytes: 0,
      });
    });
    expect(await dataSource.getRepository(UserEntity).findOneByOrFail({ id: 'user-a' }))
      .toMatchObject({ status: UserStatus.Deleted });
    expect(await dataSource.getRepository(QuotaDesiredEntity).count()).toBe(0);
    expect(await dataSource.getRepository(SshPublicKeyEntity).count()).toBe(0);
    expect(await dataSource.getRepository(UserInternalSshKeyEntity).count()).toBe(0);

    await expect(service.upsertUserServerGrant('user-a', 'server-a', { diskBytes: 8192 }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'USER_DELETED' }) });
    await dataSource.getRepository(GroupEntity).save({
      id: 'post-delete-group', name: 'post-delete-group', description: null,
      priority: 0, isSystem: false, capabilitiesJson: '[]',
    });
    await expect(service.addMember('post-delete-group', 'user-a'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'USER_DELETED' }) });
    expect(await dataSource.getRepository(ServerGrantEntity).count()).toBe(0);
    expect(await dataSource.getRepository(GroupMemberEntity).count()).toBe(0);
  });

  it('rolls back user deletion while a quota task may already have reached the agent', async () => {
    await saveQuota(4096);
    await saveQuotaTask({ sent: true });

    await expect(service.deleteUserPermanently('user-a', 'actor-a'))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USER_DELETE_QUOTA_IN_PROGRESS' }),
      });

    expect(await dataSource.getRepository(UserEntity).findOneByOrFail({ id: 'user-a' }))
      .toMatchObject({ status: UserStatus.Active });
    expect(await dataSource.getRepository(QuotaDesiredEntity).count()).toBe(1);
    expect(await dataSource.getRepository(AgentTaskEntity).count()).toBe(1);
    expect(await dataSource.getRepository(ResourceLockEntity).count()).toBe(1);
  });

  it('blocks deletion when an Agent quarantine retains a failed quota task lock', async () => {
    await saveQuota(4096);
    await saveQuotaTask({ sent: true, status: AgentTaskStatus.Failed });

    await expect(service.deleteUserPermanently('user-a', 'actor-a'))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USER_DELETE_QUOTA_IN_PROGRESS' }),
      });

    expect(await dataSource.getRepository(UserEntity).findOneByOrFail({ id: 'user-a' }))
      .toMatchObject({ status: UserStatus.Active });
    expect(await dataSource.getRepository(ResourceLockEntity).count()).toBe(1);
  });

  async function saveGroupAccess(diskBytes: number) {
    await dataSource.getRepository(GroupEntity).save({
      id: 'group-a', name: 'group-a', description: null, priority: 1,
      isSystem: false, capabilitiesJson: '[]',
    });
    await dataSource.getRepository(GroupMemberEntity).save({
      id: 'member-a', groupId: 'group-a', userId: 'user-a',
    });
    await dataSource.getRepository(ServerGrantEntity).save(serverGrant(
      'group-grant', 'group', 'group-a', diskBytes,
    ));
  }

  async function saveUserGrant(id: string, diskBytes: number) {
    await dataSource.getRepository(ServerGrantEntity).save(serverGrant(
      id, 'user', 'user-a', diskBytes,
    ));
  }

  async function saveQuota(limitBytes: number) {
    await dataSource.getRepository(QuotaDesiredEntity).save({
      id: 'quota-a', serverId: 'server-a', userId: 'user-a', numericUserId: 1001,
      limitBytes, source: 'grant', generation: 1, lastTaskId: 'old-safe-task',
    });
  }

  async function saveUserSshKeys(): Promise<void> {
    await dataSource.getRepository(SshPublicKeyEntity).save({
      id: 'public-key-a',
      userId: 'user-a',
      name: 'laptop',
      keyText: 'ssh-ed25519 AAAA',
      createdAt: new Date(),
    });
    await dataSource.getRepository(UserInternalSshKeyEntity).save({
      userId: 'user-a',
      encryptedPrivateKey: 'encrypted-private-a',
      publicKey: 'internal-public-a',
      fingerprint: 'fingerprint-a',
      generation: 1,
      rotatedAt: new Date(),
    });
  }

  async function saveQuotaTask({
    sent,
    status = AgentTaskStatus.Pending,
  }: {
    sent: boolean;
    status?: AgentTaskStatus;
  }) {
    await dataSource.getRepository(AgentTaskEntity).save({
      id: 'quota-task-pending',
      kind: AgentTaskKind.QuotaEnsure,
      serverId: 'server-a',
      resourceType: 'quota',
      resourceId: 'user-a',
      requestedBy: 'actor-a',
      requestJson: null,
      payloadJson: { generation: 1, numericUserId: 1001, diskBytes: 4096 },
      payloadHash: 'quota-hash',
      status,
      failureStage: null,
      agentResultJson: null,
      dispatchAttemptCount: sent ? 1 : 0,
      nextDispatchAt: null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: null,
      errorJson: null,
      startedAt: sent ? new Date() : null,
      lastSentAt: sent ? new Date() : null,
      completedAt: null,
    });
    await dataSource.getRepository(ResourceLockEntity).save({
      resourceKey: 'quota:server-a:user-a',
      taskId: 'quota-task-pending',
      serverId: 'server-a',
    });
  }

  async function saveContainer() {
    await dataSource.getRepository(ImageEntity).save({
      id: 'image-a', name: 'image-a', dockerImage: 'alpine:3.20',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      description: null, isActive: true, disableSsh: false,
    });
    await dataSource.getRepository(ContainerEntity).save({
      id: 'container-a', serverId: 'server-a', ownerId: 'user-a', name: 'container-a',
      imageId: 'image-a', createdBy: 'user-a',
    });
  }
});

function server() {
  return {
    id: 'server-a', name: 'server-a', slug: 'server-a', agentTokenHash: 'token-a',
    hostFingerprint: null, agentConfigFingerprint: null, status: ServerStatus.Unknown, lastSeenAt: null,
  };
}

function user() {
  return {
    id: 'user-a', numericId: 1001, username: 'user-a', passwordHash: 'hash',
    displayName: 'User A', status: UserStatus.Active,
  };
}

function serverGrant(
  id: string,
  scope: 'user' | 'group',
  scopeId: string,
  diskBytes: number,
) {
  return {
    id, scope, scopeId, serverId: 'server-a', cpuMillis: 1000, memBytes: 1024,
    diskBytes, gpuMode: GpuGrantMode.None, gpuIndices: [],
  };
}

function resolvedGrant(diskBytes: number | null) {
  return {
    cpuMillis: 1000,
    memBytes: 1024,
    diskBytes: diskBytes ?? 0,
    gpuMode: GpuGrantMode.None,
    gpuIndices: [],
  };
}

function dataDir() {
  return {
    id: 'dir-a', userId: 'user-a', sourceKind: 'local' as const,
    sourceId: 'disk-a', name: 'dir-a', sourceIdentity: 'physical-a',
    serverId: 'server-a', uid: 1001, desiredState: 'active' as const,
    generation: 1, lastTaskId: null,
  };
}
