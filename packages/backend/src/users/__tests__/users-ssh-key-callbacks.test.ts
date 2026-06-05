import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../entities/user.entity.js', () => ({ UserEntity: class UserEntity {} }));
vi.mock('../../entities/ssh-public-key.entity.js', () => ({ SshPublicKeyEntity: class SshPublicKeyEntity {} }));

import { UsersService } from '../users.service.js';

const VALID_ED25519_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3 valid-ed25519@example';

function makeUsersService(overrides: {
  sshKeysRepo?: Record<string, unknown>;
  lifecycleHooks?: Record<string, unknown>;
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
  const lifecycleHooks = {
    enqueueUserSshKeyChange: vi.fn().mockResolvedValue(undefined),
    ...overrides.lifecycleHooks,
  };
  const service = new UsersService(
    {} as never,
    sshKeysRepo as never,
    {} as never,
    {} as never,
    {} as never,
    lifecycleHooks as never,
  );
  return { service, sshKeysRepo, lifecycleHooks, savedKey };
}

describe('UsersService SSH key durable hooks', () => {
  it('enqueues durable SSH reconcile work after adding a public key without rolling back the save', async () => {
    const lifecycleHooks = {
      enqueueUserSshKeyChange: vi.fn().mockRejectedValue(new Error('queue unavailable')),
    };
    const { service, sshKeysRepo } = makeUsersService({ lifecycleHooks });

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
    expect(lifecycleHooks.enqueueUserSshKeyChange).toHaveBeenCalledWith('user-a');
  });

  it('rejects invalid public key text before saving or enqueueing SSH reconciliation', async () => {
    const { service, sshKeysRepo, lifecycleHooks } = makeUsersService();

    await expect(service.addSshKey('user-a', 'bogus', 'not-an-ssh-public-key'))
      .rejects
      .toBeInstanceOf(BadRequestException);

    expect(sshKeysRepo.create).not.toHaveBeenCalled();
    expect(sshKeysRepo.save).not.toHaveBeenCalled();
    expect(lifecycleHooks.enqueueUserSshKeyChange).not.toHaveBeenCalled();
  });

  it('enqueues durable SSH reconcile work after deleting an owned public key', async () => {
    const { service, sshKeysRepo, lifecycleHooks, savedKey } = makeUsersService();

    await expect(service.deleteSshKey('user-a', 'key-a')).resolves.toBeUndefined();

    expect(sshKeysRepo.findOne).toHaveBeenCalledWith({ where: { id: 'key-a', userId: 'user-a' } });
    expect(sshKeysRepo.remove).toHaveBeenCalledWith(savedKey);
    expect(lifecycleHooks.enqueueUserSshKeyChange).toHaveBeenCalledWith('user-a');
  });

  it('does not enqueue reconcile work when key deletion finds no matching user-owned key', async () => {
    const { service, lifecycleHooks } = makeUsersService({
      sshKeysRepo: { findOne: vi.fn(async () => null) },
    });

    await expect(service.deleteSshKey('user-a', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(lifecycleHooks.enqueueUserSshKeyChange).not.toHaveBeenCalled();
  });
});
