import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { UserStatus, Role } from '@nyabase/common';
import { testActor } from '../iam/actor.test-helper.js';
import { UsersController } from './users.controller.js';
import type { UserSshKeysService } from './user-ssh-keys.service.js';
import type { SshClientConfigService } from './ssh-client-config.service.js';
import type { UsersService } from './users.service.js';

const toDto = (value: unknown) => value;

function controllerWith(service: Record<string, unknown>) {
  return new UsersController(
    { toDto, ...service } as unknown as UsersService,
    service as unknown as UserSshKeysService,
    service as unknown as SshClientConfigService,
  );
}

describe('user update controller boundaries', () => {
  it('rejects status changes on the self-service route', async () => {
    const updateSelf = vi.fn();
    const controller = controllerWith({ updateSelf });

    await expect(controller.updateUser('user-a', {
      status: UserStatus.Disabled,
    }, testActor('user-a'))).rejects.toThrow('status and role cannot be changed through the self-service route');
    expect(updateSelf).not.toHaveBeenCalled();
  });

  it('rejects self-service password proof on the administrator route', async () => {
    const updateUser = vi.fn();
    const controller = controllerWith({ updateUser });

    await expect(controller.updateUser('user-a', {
      displayName: 'Alice',
      currentPassword: 'old-password',
    }, testActor('admin-a', Role.Admin)))
      .rejects.toThrow('currentPassword is only valid for self-service updates');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('attributes self-service SSH key mutations to the authenticated actor', async () => {
    const addSshKey = vi.fn().mockResolvedValue({ id: 'key-a' });
    const deleteSshKey = vi.fn().mockResolvedValue(undefined);
    const controller = controllerWith({ addSshKey, deleteSshKey });
    const user = testActor('user-a');
    const keyText = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3';

    await controller.addSshKey('user-a', { name: 'laptop', keyText, currentPassword: 'pw' }, user);
    await controller.deleteSshKey('user-a', 'key-a', user);

    expect(addSshKey).toHaveBeenCalledWith(user, 'laptop', keyText, 'pw');
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

  it('lets user admins and admins read and change others (the service guards admins)', async () => {
    const findById = vi.fn().mockResolvedValue({ id: 'user-b' });
    const updateUser = vi.fn().mockResolvedValue({ id: 'user-b' });
    const listSshKeys = vi.fn().mockResolvedValue([]);
    const deleteSshKey = vi.fn().mockResolvedValue(undefined);
    const controller = controllerWith({ findById, updateUser, listSshKeys, deleteSshKey });
    const admin = testActor('admin-a', Role.Admin);
    const userAdmin = testActor('ua-a', Role.UserAdmin);

    for (const manager of [admin, userAdmin]) {
      await expect(controller.getUser('user-b', manager)).resolves.toBeDefined();
      await controller.updateUser('user-b', { displayName: 'B' }, manager);
      expect(updateUser).toHaveBeenLastCalledWith('user-b', { displayName: 'B' }, manager.userId);
      await expect(controller.listSshKeys('user-b', manager)).resolves.toEqual([]);
      await controller.deleteSshKey('user-b', 'key', manager);
      expect(deleteSshKey).toHaveBeenLastCalledWith('user-b', 'key', manager.userId);
    }
  });

  it('keeps a user admin on the self-service route for their own record', async () => {
    const updateUser = vi.fn();
    const updateSelf = vi.fn().mockResolvedValue({ id: 'ua-a' });
    const controller = controllerWith({ updateUser, updateSelf });
    const userAdmin = testActor('ua-a', Role.UserAdmin);

    await controller.updateUser('ua-a', { password: 'new-password-1' }, userAdmin);
    expect(updateSelf).toHaveBeenCalledWith('ua-a', { password: 'new-password-1' }, undefined);
    await expect(controller.updateUser('ua-a', { status: UserStatus.Disabled }, userAdmin))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('treats an administrator-shaped change to your own record as administration', async () => {
    const updateUser = vi.fn().mockResolvedValue({ id: 'admin-a' });
    const updateSelf = vi.fn().mockResolvedValue({ id: 'admin-a' });
    const controller = controllerWith({ updateUser, updateSelf });
    const manager = testActor('admin-a', Role.Admin);

    await controller.updateUser('admin-a', { password: 'new-password-1' }, manager);
    expect(updateUser).toHaveBeenCalledTimes(1);
    await controller.updateUser('admin-a', { password: 'new-password-1', currentPassword: 'old' }, manager);
    await controller.updateUser('admin-a', { displayName: 'Me' }, manager);
    expect(updateSelf).toHaveBeenCalledTimes(2);
  });
});

describe('user roles over HTTP', () => {
  it('creates users with the requested role through the admin route', async () => {
    const createUser = vi.fn().mockResolvedValue({ id: 'new' });
    const controller = controllerWith({ createUser });
    const admin = testActor('admin-a', Role.Admin);

    await controller.createUser({
      username: 'newbie', password: 'password-1', displayName: 'New', role: Role.UserAdmin,
    }, admin);
    expect(createUser).toHaveBeenCalledWith(
      { username: 'newbie', password: 'password-1', displayName: 'New', role: Role.UserAdmin },
      { actorId: 'admin-a' },
    );
    await expect(controller.createUser({
      username: 'newbie', password: 'password-1', displayName: 'New', role: 'root',
    }, admin)).rejects.toThrow();
  });

  it('lets user admins create plain users only', async () => {
    const createUser = vi.fn().mockResolvedValue({ id: 'new' });
    const controller = controllerWith({ createUser });
    const userAdmin = testActor('ua-a', Role.UserAdmin);
    const base = { username: 'newbie', password: 'password-1', displayName: 'New' };

    await controller.createUser(base, userAdmin);
    await controller.createUser({ ...base, role: Role.User }, userAdmin);
    expect(createUser).toHaveBeenCalledTimes(2);
    for (const role of [Role.UserAdmin, Role.Admin]) {
      await expect(controller.createUser({ ...base, role }, userAdmin))
        .rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(createUser).toHaveBeenCalledTimes(2);
  });

  it('lets only admins change a role, including their own', async () => {
    const updateUser = vi.fn().mockResolvedValue({ id: 'user-b' });
    const updateSelf = vi.fn();
    const controller = controllerWith({ updateUser, updateSelf });

    await controller.updateUser('user-b', { role: Role.UserAdmin }, testActor('admin-a', Role.Admin));
    expect(updateUser).toHaveBeenCalledWith('user-b', { role: Role.UserAdmin }, 'admin-a');
    await controller.updateUser('admin-a', { role: Role.UserAdmin }, testActor('admin-a', Role.Admin));
    expect(updateUser).toHaveBeenLastCalledWith('admin-a', { role: Role.UserAdmin }, 'admin-a');
    expect(updateSelf).not.toHaveBeenCalled();

    // Nobody promotes themselves, and user admins cannot touch roles.
    await expect(controller.updateUser('user-a', { role: Role.Admin }, testActor('user-a')))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.updateUser('ua-a', { role: Role.Admin }, testActor('ua-a', Role.UserAdmin)))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.updateUser('user-b', { role: Role.User }, testActor('ua-a', Role.UserAdmin)))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(updateUser).toHaveBeenCalledTimes(2);
    expect(updateSelf).not.toHaveBeenCalled();
  });

  it('refuses unknown roles and deleting yourself', async () => {
    const deleteUserPermanently = vi.fn();
    const controller = controllerWith({ updateUser: vi.fn(), deleteUserPermanently });
    const admin = testActor('admin-a', Role.Admin);

    await expect(controller.updateUser('user-b', { role: 'root' }, admin)).rejects.toThrow();
    await expect(controller.deleteUser('admin-a', admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleteUserPermanently).not.toHaveBeenCalled();
  });
});
