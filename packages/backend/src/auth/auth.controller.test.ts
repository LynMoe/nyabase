import { AuditAction, Capability, UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller.js';

describe('AuthController credential audit boundaries', () => {
  it('audits successful credential lifecycle events with the durable principal and token identity', async () => {
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
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const controller = new AuthController(auth as never, access as never, audit as never);

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
    expect(audit.log.mock.calls).toEqual([
      [user.id, AuditAction.UserLogin, user.id, 'user'],
      [user.id, AuditAction.UserLogout, user.id, 'user'],
      [user.id, AuditAction.CreateApiToken, token.id, 'api_token', { name: token.name }],
      [user.id, AuditAction.DeleteApiToken, token.id, 'api_token', { name: token.name }],
    ]);
  });

  it('does not invent a logout audit for an unknown or already-removed refresh session', async () => {
    const auth = { logout: vi.fn().mockResolvedValue(null) };
    const audit = { log: vi.fn() };
    const controller = new AuthController(auth as never, {} as never, audit as never);

    await controller.logout({ refreshToken: 'unknown-refresh-token' });

    expect(audit.log).not.toHaveBeenCalled();
  });
});
