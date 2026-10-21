import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Capability, UserStatus } from '@nyabase/common';
import { testActor } from '../iam/actor.test-helper.js';
import { UsersController } from './users.controller.js';
import type { UsersService } from './users.service.js';

const toDto = (value: unknown) => value;

function controllerWith(service: Record<string, unknown>) {
  return new UsersController({ toDto, ...service } as unknown as UsersService);
}

describe('user update controller boundaries', () => {
  it('rejects status changes on the self-service route', async () => {
    const updateSelf = vi.fn();
    const controller = controllerWith({ updateSelf });

    await expect(controller.updateUser('user-a', {
      status: UserStatus.Disabled,
    }, testActor('user-a'))).rejects.toThrow('status cannot be changed through the self-service route');
    expect(updateSelf).not.toHaveBeenCalled();
  });

  it('rejects self-service password proof on the administrator route', async () => {
    const updateUser = vi.fn();
    const controller = controllerWith({ updateUser });

    await expect(controller.updateUser('user-a', {
      displayName: 'Alice',
      currentPassword: 'old-password',
    }, testActor('admin-a', Capability.ManageUsers)))
      .rejects.toThrow('currentPassword is only valid for self-service updates');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('attributes self-service SSH key mutations to the authenticated actor', async () => {
    const addSshKey = vi.fn().mockResolvedValue({ id: 'key-a' });
    const deleteSshKey = vi.fn().mockResolvedValue(undefined);
    const controller = controllerWith({ addSshKey, deleteSshKey });
    const user = testActor('user-a');
    const keyText = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3';

    await controller.addSshKey('user-a', { name: 'laptop', keyText }, user);
    await controller.deleteSshKey('user-a', 'key-a', user);

    expect(addSshKey).toHaveBeenCalledWith('user-a', 'laptop', keyText, 'user-a');
    expect(deleteSshKey).toHaveBeenCalledWith('user-a', 'key-a', 'user-a');
  });
});

describe('user routes: self, administrator, everyone else', () => {
  it('lets a user read and update only themselves', async () => {
    const findById = vi.fn().mockResolvedValue({ id: 'user-a' });
    const updateSelf = vi.fn().mockResolvedValue({ id: 'user-a' });
    const controller = controllerWith({ findById, updateSelf });
    const user = testActor('user-a');

    await expect(controller.getUser('user-a', user)).resolves.toEqual({ id: 'user-a' });
    await controller.updateUser('user-a', { displayName: 'A' }, user);
    expect(updateSelf).toHaveBeenCalledWith('user-a', { displayName: 'A' }, undefined);

    await expect(controller.getUser('user-b', user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.updateUser('user-b', { displayName: 'B' }, user))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.listSshKeys('user-b', user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.deleteSshKey('user-b', 'key', user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.addSshKey('user-b', {}, user)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets ManageUsers and ManageGrants read others, but only ManageUsers change them', async () => {
    const findById = vi.fn().mockResolvedValue({ id: 'user-b' });
    const updateUser = vi.fn().mockResolvedValue({ id: 'user-b' });
    const listSshKeys = vi.fn().mockResolvedValue([]);
    const controller = controllerWith({ findById, updateUser, listSshKeys });
    const manager = testActor('admin-a', Capability.ManageUsers);
    const granter = testActor('admin-g', Capability.ManageGrants);

    await expect(controller.getUser('user-b', manager)).resolves.toBeDefined();
    await expect(controller.getUser('user-b', granter)).resolves.toBeDefined();
    await controller.updateUser('user-b', { displayName: 'B' }, manager);
    expect(updateUser).toHaveBeenCalledWith('user-b', { displayName: 'B' }, 'admin-a');
    await expect(controller.updateUser('user-b', { displayName: 'B' }, granter))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.listSshKeys('user-b', manager)).resolves.toEqual([]);
    await expect(controller.listSshKeys('user-b', granter)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('treats an administrator-shaped change to your own record as administration', async () => {
    const updateUser = vi.fn().mockResolvedValue({ id: 'admin-a' });
    const updateSelf = vi.fn().mockResolvedValue({ id: 'admin-a' });
    const controller = controllerWith({ updateUser, updateSelf });
    const manager = testActor('admin-a', Capability.ManageUsers);

    await controller.updateUser('admin-a', { password: 'new-password-1' }, manager);
    expect(updateUser).toHaveBeenCalledTimes(1);
    await controller.updateUser('admin-a', { password: 'new-password-1', currentPassword: 'old' }, manager);
    await controller.updateUser('admin-a', { displayName: 'Me' }, manager);
    expect(updateSelf).toHaveBeenCalledTimes(2);
  });
});
