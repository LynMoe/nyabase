import { describe, expect, it, vi } from 'vitest';
import { UserStatus } from '@nyabase/common';
import type { UserEntity } from '../entities/user.entity.js';
import type { GroupsService } from '../groups/groups.service.js';
import { AdminUsersController } from './admin-users.controller.js';
import { UsersController } from './users.controller.js';
import type { UsersService } from './users.service.js';

describe('user update controller boundaries', () => {
  it('rejects status changes on the self-service route instead of silently ignoring them', async () => {
    const updateSelf = vi.fn();
    const controller = new UsersController({ updateSelf } as unknown as UsersService);
    const user = { id: 'user-a' } as UserEntity;

    await expect(controller.updateUser('user-a', {
      status: UserStatus.Disabled,
    }, user)).rejects.toThrow('status cannot be changed through the self-service route');
    expect(updateSelf).not.toHaveBeenCalled();
  });

  it('rejects self-service password proof on the administrator route', async () => {
    const updateUser = vi.fn();
    const controller = new AdminUsersController(
      { updateUser } as unknown as UsersService,
      {} as unknown as GroupsService,
    );
    const actor = { id: 'admin-a' } as UserEntity;

    await expect(controller.updateUser('user-a', {
      displayName: 'Alice',
      currentPassword: 'old-password',
    }, actor)).rejects.toThrow('currentPassword is only valid for self-service updates');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('attributes self-service SSH public-key mutations to the authenticated actor', async () => {
    const addSshKey = vi.fn().mockResolvedValue({ id: 'key-a' });
    const deleteSshKey = vi.fn().mockResolvedValue(undefined);
    const controller = new UsersController({
      addSshKey,
      deleteSshKey,
    } as unknown as UsersService);
    const user = { id: 'user-a' } as UserEntity;
    const keyText = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3';

    await controller.addSshKey('user-a', { name: 'laptop', keyText }, user);
    await controller.deleteSshKey('user-a', 'key-a', user);

    expect(addSshKey).toHaveBeenCalledWith('user-a', 'laptop', keyText, 'user-a');
    expect(deleteSshKey).toHaveBeenCalledWith('user-a', 'key-a', 'user-a');
  });
});
