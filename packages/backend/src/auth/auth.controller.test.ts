import { Capability, UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller.js';

describe('AuthController credential delegation', () => {
  it('delegates credential lifecycle events to the transaction-owning service', async () => {
    const user = {
      id: 'user-a',
      username: 'alice',
      displayName: 'Alice',
      status: UserStatus.Active,
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
    };
    const token = {
      id: 'token-a',
      name: 'automation',
      lastUsedAt: null,
      createdAt: new Date('2026-07-17T00:01:00.000Z'),
    };
    const auth = {
      authenticateAndLogin: vi.fn().mockResolvedValue({
        user,
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
      logout: vi.fn().mockResolvedValue(user.id),
      createApiToken: vi.fn().mockResolvedValue({ entity: token, secret: 'secret' }),
      deleteApiToken: vi.fn().mockResolvedValue(token),
    };
    const access = {
      userCapabilities: vi.fn().mockResolvedValue(new Set([Capability.ManageUsers])),
      getUserGroupSummaries: vi.fn().mockResolvedValue([]),
    };
    const controller = new AuthController(auth as never, access as never);

    await controller.login(
      { username: 'alice', password: 'correct horse battery staple' },
      { socket: { remoteAddress: '192.0.2.8' } },
    );
    await controller.logout({ refreshToken: 'refresh-token' });
    await controller.createToken(user as never, { name: 'automation' });
    await controller.deleteToken(user as never, token.id);

    expect(auth.authenticateAndLogin).toHaveBeenCalledWith(
      'alice',
      'correct horse battery staple',
      '192.0.2.8',
    );
    expect(auth.logout).toHaveBeenCalledWith('refresh-token');
    expect(auth.createApiToken).toHaveBeenCalledWith(user.id, token.name);
    expect(auth.deleteApiToken).toHaveBeenCalledWith(user.id, token.id);
  });

  it('preserves idempotent logout delegation for an unknown refresh session', async () => {
    const auth = { logout: vi.fn().mockResolvedValue(null) };
    const controller = new AuthController(auth as never, {} as never);

    await controller.logout({ refreshToken: 'unknown-refresh-token' });

    expect(auth.logout).toHaveBeenCalledWith('unknown-refresh-token');
  });
});
