import { AuditAction, Capability, SystemGroupKey, UserStatus } from '@nyabase/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { UsersService } from './users.service.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation retained the database lease')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('UsersService security mutation boundaries', () => {
  let dataSource: DataSource;
  let access: AccessResolverService;
  let service: UsersService;
  let auth: {
    hashPassword: ReturnType<typeof vi.fn>;
    verifyPassword: ReturnType<typeof vi.fn>;
    revokeBrowserSessionsInTransaction: ReturnType<typeof vi.fn>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let prepareUserKey: ReturnType<typeof vi.fn>;
  let savePreparedUserKeyInTransaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        UserEntity,
        SshPublicKeyEntity,
        UserInternalSshKeyEntity,
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
    auth = {
      hashPassword: vi.fn(async (password: string) => `hash:${password}`),
      verifyPassword: vi.fn().mockResolvedValue(true),
      revokeBrowserSessionsInTransaction: vi.fn().mockResolvedValue(undefined),
    };
    audit = { log: vi.fn().mockResolvedValue(undefined) };
    prepareUserKey = vi.fn(async (user: { id: string }) => ({
      userId: user.id,
      encryptedPrivateKey: 'enc:private-created',
      publicKey: 'public-created',
      fingerprint: 'fingerprint-created',
      generation: 1,
      rotatedAt: new Date(),
    }));
    savePreparedUserKeyInTransaction = vi.fn(async (
      manager: { save: (...args: unknown[]) => Promise<unknown> },
      _user: unknown,
      key: unknown,
    ) => manager.save(UserInternalSshKeyEntity, key));
    const sshIdentities = {
      prepareUserKey,
      savePreparedUserKeyInTransaction,
      getUserKeyDto: vi.fn(async (
        _target: string,
        _actor: string,
        _includePrivate: boolean,
        authorize: (manager: never) => Promise<void>,
      ) => runSerializedTransaction(dataSource, async (manager) => {
        await authorize(manager as never);
        return { userId: 'target', privateKey: 'must-not-leak' };
      })),
      rotateUserKey: vi.fn(async (
        _target: string,
        _actor: string,
        authorize: (manager: never) => Promise<void>,
      ) => runSerializedTransaction(dataSource, async (manager) => {
        await authorize(manager as never);
        return { userId: 'target', generation: 2 };
      })),
    };
    service = new UsersService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(SshPublicKeyEntity),
      auth as never,
      access,
      dataSource,
      { reconcileUser: vi.fn().mockResolvedValue(undefined) } as never,
      sshIdentities as never,
      { notify: vi.fn().mockResolvedValue(undefined) } as never,
      { get: vi.fn((key: string) => key === 'runtime.nodeEnv' ? 'test' : 'admin123') } as never,
      audit as never,
      { applyInTransaction: vi.fn().mockResolvedValue('quota-task') } as never,
    );
    await saveUser('actor', 1001);
    await saveUser('target', 1002);
    await saveGroup('managers', [Capability.ManageUsers]);
    await saveMembership('actor-manager', 'managers', 'actor');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('allows ManageUsers to reset an ordinary user with no capability or resource grant', async () => {
    await expect(service.updateUser('target', { password: 'new-pass-123' }, 'actor'))
      .resolves.toMatchObject({ passwordHash: 'hash:new-pass-123', authVersion: 1 });
    expect(auth.revokeBrowserSessionsInTransaction).toHaveBeenCalledOnce();
    expect(audit.log).toHaveBeenCalledWith(
      'actor',
      expect.anything(),
      'target',
      'user',
      expect.objectContaining({ passwordChanged: true }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('new-pass-123');
  });

  it('requires ManageGrants for reset, status, key deletion, private view, and rotation of a granted user', async () => {
    await dataSource.getRepository(MountSourceGrantEntity).save({
      id: 'target-grant',
      scope: 'user',
      scopeId: 'target',
      sourceKind: 'remote',
      sourceId: 'remote-a',
      serverId: null,
      sourceIdentity: null,
    });
    await dataSource.getRepository(SshPublicKeyEntity).save({
      id: 'target-key', userId: 'target', name: 'laptop', keyText: 'ssh-ed25519 AAAA',
      createdAt: new Date(),
    });

    await expect(service.updateUser('target', { password: 'new-pass-123' }, 'actor'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }) });
    await expect(service.updateUser('target', { status: UserStatus.Disabled }, 'actor'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }) });
    await expect(service.deleteSshKey('target', 'target-key', 'actor'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }) });
    await expect(service.getInternalSshKey('actor', 'target', true))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }) });
    await expect(service.rotateInternalSshKey('actor', 'target'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }) });

    expect(await dataSource.getRepository(SshPublicKeyEntity).count()).toBe(1);
    expect(await currentUser('target')).toMatchObject({
      passwordHash: 'hash',
      status: UserStatus.Active,
      authVersion: 0,
    });

    await setGroupCapabilities('managers', [Capability.ManageUsers, Capability.ManageGrants]);
    await expect(service.updateUser('target', { password: 'new-pass-123' }, 'actor'))
      .resolves.toMatchObject({ authVersion: 1 });
    audit.log.mockClear();
    await expect(service.deleteSshKey('target', 'target-key', 'actor')).resolves.toBeUndefined();
    expect(await dataSource.getRepository(SshPublicKeyEntity).count()).toBe(0);
    expect(audit.log).toHaveBeenCalledWith(
      'actor',
      AuditAction.DeleteUserSshPublicKey,
      'target-key',
      'ssh_public_key',
      expect.objectContaining({ userId: 'target', name: 'laptop' }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('ssh-ed25519 AAAA');
  });

  it('still denies an actor who lacks a target capability even with ManageGrants', async () => {
    await setGroupCapabilities('managers', [Capability.ManageUsers, Capability.ManageGrants]);
    await saveGroup('privileged-targets', [Capability.ManageGroups]);
    await saveMembership('target-privileged', 'privileged-targets', 'target');

    await expect(service.updateUser('target', { password: 'new-pass-123' }, 'actor'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }) });
  });

  it('rechecks the base ManageUsers capability after a controller guard could have passed', async () => {
    await dataSource.getRepository(GroupMemberEntity).delete({ groupId: 'managers', userId: 'actor' });

    await expect(service.updateUser('target', { displayName: 'stolen' }, 'actor'))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }) });
    expect((await currentUser('target')).displayName).toBe('target');
  });

  it('makes concurrent self password changes a one-winner CAS and audits only the winner', async () => {
    let verificationCount = 0;
    let release!: () => void;
    const bothVerified = new Promise<void>((resolve) => { release = resolve; });
    auth.verifyPassword.mockImplementation(async () => {
      verificationCount += 1;
      if (verificationCount === 2) release();
      await bothVerified;
      return true;
    });

    const results = await Promise.allSettled([
      service.updateSelf('target', { displayName: 'first', password: 'first-pass' }, 'old-pass'),
      service.updateSelf('target', { displayName: 'second', password: 'second-pass' }, 'old-pass'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const target = await currentUser('target');
    expect(['hash:first-pass', 'hash:second-pass']).toContain(target.passwordHash);
    expect(target.authVersion).toBe(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('creates user, mandatory membership, and redacted audit as one cohesive operation', async () => {
    await saveGroup('users-system', [], SystemGroupKey.Users, true);
    const created = await service.createUser({
      username: 'new-user',
      password: 'new-user-pass',
      displayName: 'New User',
    }, { systemGroupKey: SystemGroupKey.Users, actorId: 'actor' });

    await expect(dataSource.getRepository(GroupMemberEntity).findOneBy({
      groupId: 'users-system', userId: created.id,
    })).resolves.not.toBeNull();
    await expect(dataSource.getRepository(UserInternalSshKeyEntity).findOneBy({
      userId: created.id,
    })).resolves.toMatchObject({ generation: 1, publicKey: 'public-created' });
    expect(audit.log).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('new-user-pass');

    await expect(service.createUser({
      username: 'orphan',
      password: 'orphan-pass',
      displayName: 'Orphan',
    }, { systemGroupKey: SystemGroupKey.Operators, actorId: 'actor' }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'SYSTEM_GROUP_MISSING' }) });
    expect(await dataSource.getRepository(UserEntity).findOneBy({ username: 'orphan' })).toBeNull();
    expect(await dataSource.getRepository(UserInternalSshKeyEntity).count()).toBe(1);
  });

  it('does not hold the database lease during user keygen and rechecks revoked authority before save', async () => {
    const started = deferred();
    const release = deferred();
    prepareUserKey.mockImplementationOnce(async (user: { id: string }) => {
      started.resolve();
      await release.promise;
      return {
        userId: user.id,
        encryptedPrivateKey: 'enc:private-revoked',
        publicKey: 'public-revoked',
        fingerprint: 'fingerprint-revoked',
        generation: 1,
        rotatedAt: new Date(),
      };
    });

    const creation = service.createUser({
      username: 'revoked-create',
      password: 'new-user-pass',
      displayName: 'Revoked Create',
    }, { actorId: 'actor' });
    await started.promise;
    try {
      await settleWithin(runSerializedTransaction(dataSource, (manager) =>
        manager.delete(GroupMemberEntity, { id: 'actor-manager' })));
    } finally {
      release.resolve();
    }

    await expect(creation).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PRIVILEGE_ESCALATION_DENIED' }),
    });
    expect(await dataSource.getRepository(UserEntity).findOneBy({ username: 'revoked-create' }))
      .toBeNull();
    expect(await dataSource.getRepository(UserInternalSshKeyEntity).count()).toBe(0);
    expect(savePreparedUserKeyInTransaction).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('does not partially create a user when external key generation fails', async () => {
    prepareUserKey.mockRejectedValueOnce(new Error('ssh-keygen unavailable'));

    await expect(service.createUser({
      username: 'keygen-failed',
      password: 'new-user-pass',
      displayName: 'Keygen Failed',
    }, { actorId: 'actor' })).rejects.toThrow('ssh-keygen unavailable');

    expect(await dataSource.getRepository(UserEntity).findOneBy({ username: 'keygen-failed' }))
      .toBeNull();
    expect(await dataSource.getRepository(UserInternalSshKeyEntity).count()).toBe(0);
    expect(savePreparedUserKeyInTransaction).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
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
    capabilities: Capability[],
    systemKey: SystemGroupKey | null = null,
    isSystem = false,
  ): Promise<void> {
    const repository = dataSource.getRepository(GroupEntity);
    const group = repository.create({
      id,
      name: id,
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
});
