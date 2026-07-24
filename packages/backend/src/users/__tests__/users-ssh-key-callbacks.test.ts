import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AuditAction, MAX_SSH_PUBLIC_KEYS_PER_USER, UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../entities/user.entity.js', () => ({ UserEntity: class UserEntity {} }));
vi.mock('../../entities/ssh-public-key.entity.js', () => ({ SshPublicKeyEntity: class SshPublicKeyEntity {} }));

import { UsersService } from '../users.service.js';

const VALID_ED25519_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3';

function makeUsersService(overrides: {
  sshKeysRepo?: Record<string, unknown>;
  containerSshSync?: Record<string, unknown>;
  keyCount?: number;
  userStatus?: UserStatus;
  audit?: Record<string, unknown>;
} = {}) {
  const savedKey = {
    id: 'key-a',
    userId: 'user-a',
    name: 'laptop',
    keyText: VALID_ED25519_KEY,
    createdAt: new Date(),
  };
  const sshKeysRepo = {
    create: vi.fn((input) => input),
    save: vi.fn(async (input) => ({ ...savedKey, ...input })),
    findOne: vi.fn(async (_options?: unknown) => savedKey),
    remove: vi.fn(async (_key?: unknown) => savedKey),
    find: vi.fn(async () => [savedKey]),
    ...overrides.sshKeysRepo,
  };
  const containerSshSync = {
    reconcileUser: vi.fn().mockResolvedValue(undefined),
    ...overrides.containerSshSync,
  };
  const proxySnapshots = {
    notify: vi.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === 'runtime.nodeEnv') return 'development';
      if (key === 'auth.adminInitPassword') return 'admin123';
      return undefined;
    }),
  };
  const audit = {
    log: vi.fn().mockResolvedValue(undefined),
    ...overrides.audit,
  };
  const manager = {
    findOneBy: vi.fn().mockResolvedValue({ id: 'user-a', status: overrides.userStatus ?? UserStatus.Active }),
    findOne: vi.fn((_entity: unknown, options: unknown) => sshKeysRepo.findOne(options)),
    count: vi.fn().mockResolvedValue(overrides.keyCount ?? 0),
    create: vi.fn((_entity: unknown, input: unknown) => sshKeysRepo.create(input)),
    save: vi.fn((_entity: unknown, input: unknown) => sshKeysRepo.save(input)),
    delete: vi.fn(async (_entity: unknown, criteria: unknown) => {
      const key = await sshKeysRepo.findOne({ where: criteria });
      if (!key) return { affected: 0 };
      await sshKeysRepo.remove(key);
      return { affected: 1 };
    }),
  };
  const dataSource = {
    options: { type: 'postgres' },
    transaction: vi.fn(async (...args: unknown[]) => {
      const work = args.at(-1) as (value: typeof manager) => Promise<unknown>;
      return work(manager);
    }),
  };
  const service = new UsersService(
    {} as never,
    sshKeysRepo as never,
    {} as never,
    { assertActorMayAdministerUserInTransaction: vi.fn().mockResolvedValue(undefined) } as never,
    dataSource as never,
    containerSshSync as never,
    {} as never,
    proxySnapshots as never,
    config as never,
    audit as never,
    { applyInTransaction: vi.fn() } as never,
  );
  return { service, sshKeysRepo, containerSshSync, proxySnapshots, savedKey, manager, dataSource, audit };
}

describe('UsersService SSH key durable hooks', () => {
  it('broadcasts proxy snapshots after adding a public key without rolling back the save', async () => {
    const containerSshSync = {
      reconcileUser: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    };
    const { service, sshKeysRepo, proxySnapshots, audit } = makeUsersService({ containerSshSync });

    const saved = await service.addSshKey(
      'user-a',
      'laptop',
      ` \t ${VALID_ED25519_KEY.replaceAll(' ', '\t  ')} \t `,
      'user-a',
    );
    expect(saved).toMatchObject({
      id: expect.any(String),
      userId: 'user-a',
      keyText: VALID_ED25519_KEY,
    });

    expect(sshKeysRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-a',
      name: 'laptop',
      keyText: VALID_ED25519_KEY,
    }));
    expect(containerSshSync.reconcileUser).not.toHaveBeenCalled();
    expect(proxySnapshots.notify).toHaveBeenCalledWith('user-ssh-key-added');
    expect(audit.log).toHaveBeenCalledOnce();
    expect(audit.log).toHaveBeenCalledWith(
      'user-a',
      AuditAction.AddUserSshPublicKey,
      saved.id,
      'ssh_public_key',
      {
        userId: 'user-a',
        name: 'laptop',
        algorithm: 'ssh-ed25519',
        fingerprint: expect.stringMatching(/^SHA256:/),
      },
    );
    const serializedAudit = JSON.stringify(audit.log.mock.calls);
    expect(serializedAudit).not.toContain(VALID_ED25519_KEY);
    expect(serializedAudit).not.toContain('AAAAC3NzaC1lZDI1NTE5');
    expect(serializedAudit).not.toContain('keyText');
  });

  it('rejects invalid public key text before saving or enqueueing SSH reconciliation', async () => {
    const { service, sshKeysRepo, containerSshSync, audit } = makeUsersService();

    await expect(service.addSshKey('user-a', 'bogus', 'not-an-ssh-public-key', 'user-a'))
      .rejects
      .toBeInstanceOf(BadRequestException);

    expect(sshKeysRepo.create).not.toHaveBeenCalled();
    expect(sshKeysRepo.save).not.toHaveBeenCalled();
    expect(containerSshSync.reconcileUser).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('rejects a fifth public key inside the serialized admission transaction', async () => {
    const { service, sshKeysRepo, manager, audit } = makeUsersService({
      keyCount: MAX_SSH_PUBLIC_KEYS_PER_USER,
    });

    await expect(service.addSshKey('user-a', 'overflow', VALID_ED25519_KEY, 'user-a'))
      .rejects.toBeInstanceOf(ConflictException);

    expect(manager.count).toHaveBeenCalledOnce();
    expect(sshKeysRepo.save).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('rejects SSH keys for a non-active user in the same transaction', async () => {
    const { service, sshKeysRepo, audit } = makeUsersService({ userStatus: UserStatus.Deleting });

    await expect(service.addSshKey('user-a', 'late-key', VALID_ED25519_KEY, 'user-a'))
      .rejects.toBeInstanceOf(ConflictException);

    expect(sshKeysRepo.save).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('broadcasts proxy snapshots after deleting an owned public key', async () => {
    const { service, sshKeysRepo, containerSshSync, proxySnapshots, savedKey, audit } = makeUsersService();

    await expect(service.deleteSshKey('user-a', 'key-a', 'user-a')).resolves.toBeUndefined();

    expect(sshKeysRepo.findOne).toHaveBeenCalledWith({ where: { id: 'key-a', userId: 'user-a' } });
    expect(sshKeysRepo.remove).toHaveBeenCalledWith(savedKey);
    expect(containerSshSync.reconcileUser).not.toHaveBeenCalled();
    expect(proxySnapshots.notify).toHaveBeenCalledWith('user-ssh-key-deleted');
    expect(audit.log).toHaveBeenCalledOnce();
    expect(audit.log).toHaveBeenCalledWith(
      'user-a',
      AuditAction.DeleteUserSshPublicKey,
      'key-a',
      'ssh_public_key',
      expect.objectContaining({
        userId: 'user-a',
        name: 'laptop',
        algorithm: 'ssh-ed25519',
        fingerprint: expect.stringMatching(/^SHA256:/),
      }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('AAAAC3NzaC1lZDI1NTE5');
  });

  it('does not enqueue reconcile work when key deletion finds no matching user-owned key', async () => {
    const { service, containerSshSync, audit } = makeUsersService({
      sshKeysRepo: { findOne: vi.fn(async () => null) },
    });

    await expect(service.deleteSshKey('user-a', 'missing', 'user-a'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(containerSshSync.reconcileUser).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([UserStatus.Deleting, UserStatus.Deleted])(
    'fails closed when an administrator deletes a public key for a %s target',
    async (userStatus) => {
      const { service, sshKeysRepo, audit, proxySnapshots } = makeUsersService({ userStatus });

      await expect(service.deleteSshKey('user-a', 'key-a', 'admin-a')).rejects.toBeDefined();
      expect(sshKeysRepo.remove).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(proxySnapshots.notify).not.toHaveBeenCalled();
    },
  );

  it('keeps committed key mutations successful when the post-commit audit sink fails', async () => {
    const { service, sshKeysRepo, audit } = makeUsersService({
      audit: { log: vi.fn().mockRejectedValue(new Error('audit unavailable')) },
    });

    await expect(service.addSshKey('user-a', 'laptop', VALID_ED25519_KEY, 'user-a'))
      .resolves.toMatchObject({ userId: 'user-a' });
    expect(sshKeysRepo.save).toHaveBeenCalledOnce();
    expect(audit.log).toHaveBeenCalledOnce();
  });

  it('does not audit a public key when persistence fails and rolls the transaction back', async () => {
    const { service, audit, proxySnapshots } = makeUsersService({
      sshKeysRepo: { save: vi.fn().mockRejectedValue(new Error('database unavailable')) },
    });

    await expect(service.addSshKey('user-a', 'laptop', VALID_ED25519_KEY, 'user-a'))
      .rejects.toThrow('database unavailable');
    expect(audit.log).not.toHaveBeenCalled();
    expect(proxySnapshots.notify).not.toHaveBeenCalled();
  });

  it('queues container SSH sync when the internal key rotates', async () => {
    const { service, containerSshSync, proxySnapshots } = makeUsersService();

    await service.notifyInternalSshKeyRotated('user-a');

    expect(containerSshSync.reconcileUser).toHaveBeenCalledWith('user-a');
    expect(proxySnapshots.notify).toHaveBeenCalledWith('user-internal-ssh-key-rotated');
  });
});
