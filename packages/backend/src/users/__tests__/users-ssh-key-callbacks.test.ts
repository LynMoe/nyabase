import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MAX_SSH_PUBLIC_KEYS_PER_USER, UserStatus } from '@nyabase/common';
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
    findOne: vi.fn(async () => savedKey),
    remove: vi.fn(async () => savedKey),
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
  const manager = {
    findOneBy: vi.fn().mockResolvedValue({ id: 'user-a', status: overrides.userStatus ?? UserStatus.Active }),
    count: vi.fn().mockResolvedValue(overrides.keyCount ?? 0),
    create: vi.fn((_entity: unknown, input: unknown) => sshKeysRepo.create(input)),
    save: vi.fn((_entity: unknown, input: unknown) => sshKeysRepo.save(input)),
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
    {} as never,
    dataSource as never,
    containerSshSync as never,
    {} as never,
    proxySnapshots as never,
    config as never,
  );
  return { service, sshKeysRepo, containerSshSync, proxySnapshots, savedKey, manager, dataSource };
}

describe('UsersService SSH key durable hooks', () => {
  it('broadcasts proxy snapshots after adding a public key without rolling back the save', async () => {
    const containerSshSync = {
      reconcileUser: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    };
    const { service, sshKeysRepo, proxySnapshots } = makeUsersService({ containerSshSync });

    await expect(service.addSshKey('user-a', 'laptop', ` \t ${VALID_ED25519_KEY.replaceAll(' ', '\t  ')} \t `))
      .resolves
      .toMatchObject({
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
  });

  it('rejects invalid public key text before saving or enqueueing SSH reconciliation', async () => {
    const { service, sshKeysRepo, containerSshSync } = makeUsersService();

    await expect(service.addSshKey('user-a', 'bogus', 'not-an-ssh-public-key'))
      .rejects
      .toBeInstanceOf(BadRequestException);

    expect(sshKeysRepo.create).not.toHaveBeenCalled();
    expect(sshKeysRepo.save).not.toHaveBeenCalled();
    expect(containerSshSync.reconcileUser).not.toHaveBeenCalled();
  });

  it('rejects a fifth public key inside the serialized admission transaction', async () => {
    const { service, sshKeysRepo, manager } = makeUsersService({
      keyCount: MAX_SSH_PUBLIC_KEYS_PER_USER,
    });

    await expect(service.addSshKey('user-a', 'overflow', VALID_ED25519_KEY))
      .rejects.toBeInstanceOf(ConflictException);

    expect(manager.count).toHaveBeenCalledOnce();
    expect(sshKeysRepo.save).not.toHaveBeenCalled();
  });

  it('rejects SSH keys for a non-active user in the same transaction', async () => {
    const { service, sshKeysRepo } = makeUsersService({ userStatus: UserStatus.Deleting });

    await expect(service.addSshKey('user-a', 'late-key', VALID_ED25519_KEY))
      .rejects.toBeInstanceOf(ConflictException);

    expect(sshKeysRepo.save).not.toHaveBeenCalled();
  });

  it('broadcasts proxy snapshots after deleting an owned public key', async () => {
    const { service, sshKeysRepo, containerSshSync, proxySnapshots, savedKey } = makeUsersService();

    await expect(service.deleteSshKey('user-a', 'key-a')).resolves.toBeUndefined();

    expect(sshKeysRepo.findOne).toHaveBeenCalledWith({ where: { id: 'key-a', userId: 'user-a' } });
    expect(sshKeysRepo.remove).toHaveBeenCalledWith(savedKey);
    expect(containerSshSync.reconcileUser).not.toHaveBeenCalled();
    expect(proxySnapshots.notify).toHaveBeenCalledWith('user-ssh-key-deleted');
  });

  it('does not enqueue reconcile work when key deletion finds no matching user-owned key', async () => {
    const { service, containerSshSync } = makeUsersService({
      sshKeysRepo: { findOne: vi.fn(async () => null) },
    });

    await expect(service.deleteSshKey('user-a', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(containerSshSync.reconcileUser).not.toHaveBeenCalled();
  });

  it('queues container SSH sync when the internal key rotates', async () => {
    const { service, containerSshSync, proxySnapshots } = makeUsersService();

    await service.notifyInternalSshKeyRotated('user-a');

    expect(containerSshSync.reconcileUser).toHaveBeenCalledWith('user-a');
    expect(proxySnapshots.notify).toHaveBeenCalledWith('user-internal-ssh-key-rotated');
  });
});
