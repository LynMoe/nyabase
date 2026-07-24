import { Capability, ServerStatus, SystemGroupKey, UserStatus } from '@nyabase/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { GroupsService } from './groups.service.js';

describe('GroupsService privilege boundaries', () => {
  let dataSource: DataSource;
  let access: AccessResolverService;
  let service: GroupsService;
  let auditLog: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        UserEntity,
        GroupEntity,
        GroupMemberEntity,
        ServerEntity,
        ServerGrantEntity,
        ImageEntity,
        ImageGrantEntity,
        MountSourceGrantEntity,
        RemoteFsMountEntity,
        RemoteFsServerAssignmentEntity,
      ],
    });
    await dataSource.initialize();
    access = new AccessResolverService(
      dataSource.getRepository(GroupEntity),
      dataSource.getRepository(GroupMemberEntity),
      dataSource.getRepository(ServerGrantEntity),
      dataSource.getRepository(ImageGrantEntity),
      dataSource.getRepository(ImageEntity),
      dataSource.getRepository(ServerEntity),
      dataSource.getRepository(MountSourceGrantEntity),
      dataSource.getRepository(RemoteFsServerAssignmentEntity),
      { stateCache: { get: vi.fn() } } as never,
      new AccessCacheEpochService(),
    );
    auditLog = vi.fn().mockResolvedValue(undefined);
    service = new GroupsService(
      dataSource.getRepository(GroupEntity),
      dataSource.getRepository(GroupMemberEntity),
      dataSource.getRepository(ServerGrantEntity),
      dataSource.getRepository(ImageGrantEntity),
      dataSource.getRepository(UserEntity),
      access,
      { log: auditLog } as never,
      { applyInTransaction: vi.fn().mockResolvedValue('quota-task') } as never,
      dataSource,
      {
        deleteScopeInTransaction: vi.fn().mockResolvedValue(undefined),
        listGrantsForScope: vi.fn().mockResolvedValue([]),
      } as never,
      {
        assertServerAccessRevocationSafe: vi.fn().mockResolvedValue(undefined),
        assertMountSourceRevocationSafe: vi.fn().mockResolvedValue(undefined),
      } as never,
      { notify: vi.fn().mockResolvedValue(undefined) } as never,
      { deleteUserCredentialsInTransaction: vi.fn().mockResolvedValue(undefined) } as never,
    );
    await saveUser('actor', 1001);
    await saveUser('target', 1002);
    await saveGroup('actor-group', 'Actor group', [Capability.ManageGroups]);
    await saveMembership('actor-membership', 'actor-group', 'actor');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('prevents ManageGroups from creating or updating capabilities the actor lacks', async () => {
    await expect(service.create({
      name: 'Escalation',
      capabilities: [Capability.ManageUsers],
    }, 'actor')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
    });
    expect(await dataSource.getRepository(GroupEntity).findOneBy({ name: 'Escalation' })).toBeNull();

    await expect(service.create({ name: 'Ordinary' }, 'actor')).resolves.toMatchObject({
      name: 'Ordinary',
      capabilities: [],
    });
    const ordinary = await dataSource.getRepository(GroupEntity).findOneByOrFail({ name: 'Ordinary' });
    await expect(service.update(ordinary.id, {
      capabilities: [Capability.ManageUsers],
    }, 'actor', ordinary.revision)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
    });
  });

  it('rechecks base ManageGroups and ManageGrants inside the mutation transaction', async () => {
    await saveGroup('work', 'Work', []);
    await dataSource.getRepository(MountSourceGrantEntity).save({
      id: 'mount-grant',
      scope: 'group',
      scopeId: 'work',
      sourceKind: 'remote',
      sourceId: 'remote-a',
      serverId: null,
      sourceIdentity: null,
    });

    await expect(service.addMember('work', 'target', 'actor')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
    });
    expect(await dataSource.getRepository(GroupMemberEntity).findOneBy({
      groupId: 'work', userId: 'target',
    })).toBeNull();

    await setGroupCapabilities('actor-group', [Capability.ManageGroups, Capability.ManageGrants]);
    await expect(service.addMember('work', 'target', 'actor')).resolves.toEqual({ taskIds: [] });

    await dataSource.getRepository(GroupMemberEntity).delete({ groupId: 'actor-group', userId: 'actor' });
    await expect(service.update('work', { description: 'revoked actor must lose' }, 'actor', 1))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
    expect((await dataSource.getRepository(GroupEntity).findOneByOrFail({ id: 'work' })).description)
      .toBeNull();
  });

  it('advances authVersion for every capability or membership change', async () => {
    await saveGroup('work', 'Work', []);

    await service.addMember('work', 'target', 'actor');
    expect((await currentUser('target')).authVersion).toBe(1);

    await service.update('work', { capabilities: [Capability.ManageGroups] }, 'actor', 1);
    expect((await currentUser('target')).authVersion).toBe(2);

    await service.removeMember('work', 'target', 'actor');
    expect((await currentUser('target')).authVersion).toBe(3);
  });

  it('rechecks ManageGrants for direct grant mutations even when the target row is absent', async () => {
    await expect(service.deleteUserServerGrant('target', 'missing-server', 'actor'))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });
    await expect(service.deleteUserImageGrant('target', 'missing-image', 'missing-server', 'actor'))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
      });

    await setGroupCapabilities('actor-group', [Capability.ManageGroups, Capability.ManageGrants]);
    await expect(service.deleteUserServerGrant('target', 'missing-server', 'actor'))
      .rejects.toThrow('Server not found');
    await expect(service.deleteUserImageGrant('target', 'missing-image', 'missing-server', 'actor'))
      .rejects.toThrow('Image not found');
  });

  it('keeps idempotent delete misses out of mutation audit and cache invalidation', async () => {
    await setGroupCapabilities('actor-group', [Capability.ManageGroups, Capability.ManageGrants]);
    await saveGroup('work', 'Work', []);
    await saveServer('server-a');
    await saveImage('image-a');
    const invalidate = vi.spyOn(access, 'invalidateUser');

    await expect(service.removeMember('work', 'target', 'actor'))
      .resolves.toEqual({ taskIds: [] });
    await expect(service.deleteGroupServerGrant('work', 'server-a', 'actor'))
      .resolves.toEqual({ taskIds: [] });
    await expect(service.deleteUserServerGrant('target', 'server-a', 'actor'))
      .resolves.toEqual({ taskIds: [] });
    await expect(service.deleteGroupImageGrant('work', 'image-a', 'server-a', 'actor'))
      .resolves.toBeUndefined();
    await expect(service.deleteUserImageGrant('target', 'image-a', 'server-a', 'actor'))
      .resolves.toBeUndefined();

    expect(auditLog).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('keeps built-in identity immutable and fails closed on reserved-name squatting', async () => {
    await setGroupCapabilities('actor-group', Object.values(Capability));
    await saveGroup(
      'administrators',
      'Administrators',
      Object.values(Capability),
      SystemGroupKey.Administrators,
      true,
    );
    await expect(service.update('administrators', { name: 'Renamed' }, 'actor', 1))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: 'SYSTEM_GROUP_METADATA_IMMUTABLE' }),
      });
    await expect(service.create({ name: 'Users' }, 'actor')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SYSTEM_GROUP_NAME_RESERVED' }),
    });
  });

  it('does not leak ManageGrants projections from the ManageGroups list', async () => {
    await saveGroup('work', 'Work', []);
    await saveMembership('target-work', 'work', 'target');
    await dataSource.getRepository(MountSourceGrantEntity).save({
      id: 'mount-grant', scope: 'group', scopeId: 'work', sourceKind: 'remote',
      sourceId: 'remote-a', serverId: null, sourceIdentity: null,
    });

    const work = (await service.findAll()).find((group) => group.id === 'work')!;
    expect(work.members).toHaveLength(1);
    expect(work).not.toHaveProperty('serverIds');
    expect(work).not.toHaveProperty('serverGrants');
    expect(work).not.toHaveProperty('imageIds');
  });

  it('rejects a stale group metadata client with the authoritative snapshot', async () => {
    await saveGroup('work', 'Work', []);

    const clientA = await service.findById('work');
    const clientB = await service.findById('work');
    const saved = await service.update(
      'work',
      { description: 'Client B committed' },
      'actor',
      clientB.revision,
    );
    expect(saved).toMatchObject({ revision: 2, description: 'Client B committed' });

    await expect(service.update(
      'work',
      { description: 'Stale client A' },
      'actor',
      clientA.revision,
    )).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'GROUP_REVISION_CONFLICT',
        current: expect.objectContaining({ revision: 2, description: 'Client B committed' }),
      }),
    });
    expect(await dataSource.getRepository(GroupEntity).findOneByOrFail({ id: 'work' }))
      .toMatchObject({ revision: 2, description: 'Client B committed' });
  });

  it('protects the final active break-glass administrator', async () => {
    await saveGroup(
      'administrators',
      'Administrators',
      Object.values(Capability),
      SystemGroupKey.Administrators,
      true,
    );
    await saveMembership('target-admin', 'administrators', 'target');
    await expect(dataSource.transaction((manager) =>
      access.assertNotFinalActiveAdministratorInTransaction(manager, 'target')))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'LAST_ACTIVE_ADMINISTRATOR' }) });

    await saveUser('alternative', 1003);
    await saveMembership('alternative-admin', 'administrators', 'alternative');
    await expect(dataSource.transaction((manager) =>
      access.assertNotFinalActiveAdministratorInTransaction(manager, 'target')))
      .resolves.toBeUndefined();
  });

  async function saveUser(id: string, numericId: number): Promise<void> {
    await dataSource.getRepository(UserEntity).save({
      id,
      numericId,
      username: id,
      passwordHash: 'hash',
      displayName: id,
      status: UserStatus.Active,
      authVersion: 0,
    });
  }

  async function currentUser(id: string): Promise<UserEntity> {
    return dataSource.getRepository(UserEntity).findOneByOrFail({ id });
  }

  async function saveGroup(
    id: string,
    name: string,
    capabilities: Capability[],
    systemKey: SystemGroupKey | null = null,
    isSystem = false,
  ): Promise<void> {
    const repository = dataSource.getRepository(GroupEntity);
    const group = repository.create({
      id,
      name,
      description: null,
      priority: 0,
      isSystem,
      systemKey,
    });
    group.capabilities = capabilities;
    await repository.save(group);
  }

  async function setGroupCapabilities(id: string, capabilities: Capability[]): Promise<void> {
    const repository = dataSource.getRepository(GroupEntity);
    const group = await repository.findOneByOrFail({ id });
    group.capabilities = capabilities;
    await repository.save(group);
  }

  async function saveMembership(id: string, groupId: string, userId: string): Promise<void> {
    await dataSource.getRepository(GroupMemberEntity).save({ id, groupId, userId });
  }

  async function saveServer(id: string): Promise<void> {
    await dataSource.getRepository(ServerEntity).save({
      id,
      name: id,
      slug: id,
      agentTokenHash: `hash-${id}`,
      hostFingerprint: null,
      status: ServerStatus.Unknown,
      lastSeenAt: null,
    });
  }

  async function saveImage(id: string): Promise<void> {
    await dataSource.getRepository(ImageEntity).save({
      id,
      name: id,
      dockerImage: `${id}:latest`,
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      description: null,
      isActive: true,
      disableSsh: false,
    });
  }
});
