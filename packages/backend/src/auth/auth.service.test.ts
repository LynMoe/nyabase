import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { InMemoryAuthPersistenceTestAdapter } from './in-memory-auth-persistence.test-helper.js';

describe('AuthService refresh token rotation', () => {
  it('rejects malformed request ids outside the HTTP controller', async () => {
    const { service } = fixture();
    await expect(service.refreshTokens('token', 'A'.repeat(64)))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.refreshTokens('token', 'a'.repeat(63)))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows only one concurrent rotation of the same refresh token', async () => {
    const { service, persistence, user } = fixture();
    const issued = await service.login(user);
    const attempts = await Promise.allSettled([
      service.refreshTokens(issued.refreshToken, '1'.repeat(64)),
      service.refreshTokens(issued.refreshToken, '2'.repeat(64)),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(persistence.refreshRows()).toEqual([
      expect.objectContaining({ userId: user.id, revoked: false, previousHash: expect.any(String) }),
    ]);
  });

  it('recovers the exact committed successor for an exact request retry', async () => {
    const { service, persistence, user } = fixture();
    const issued = await service.login(user);
    const requestId = 'a'.repeat(64);
    const first = await service.refreshTokens(issued.refreshToken, requestId);
    await expect(service.refreshTokens(issued.refreshToken, requestId)).resolves.toEqual(first);
    expect(persistence.refreshRows()).toHaveLength(1);
    await expect(service.refreshTokens(issued.refreshToken, 'b'.repeat(64)))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});

function fixture() {
  const persistence = new InMemoryAuthPersistenceTestAdapter();
  const user = persistence.seedUser({ id: 'user-a', username: 'alice' });
  const service = new AuthService(
    persistence,
    new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } }),
    {
      get: vi.fn((key: string) => key === 'auth.jwtSecret' ? 'test-secret' : 30),
    } as never,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
  );
  return { persistence, service, user };
}
