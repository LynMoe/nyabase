import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { InMemoryAuthPersistenceTestAdapter } from './in-memory-auth-persistence.test-helper.js';

describe('AuthService logout session-selection contract', () => {
  it('returns no owner for unknown and replayed secrets', async () => {
    const { service, userA } = fixture();
    const current = await service.login(userA);
    await expect(service.logout('unknown-refresh-token')).resolves.toBeNull();
    await expect(service.logout(current.refreshToken)).resolves.toBe(userA.id);
    await expect(service.logout(current.refreshToken)).resolves.toBeNull();
  });

  it('selects exactly one current or predecessor session across siblings and users', async () => {
    const { service, persistence, userA, userB } = fixture();
    const selected = await service.login(userA);
    const sibling = await service.login(userA);
    const otherUser = await service.login(userB);
    const rotated = await service.refreshTokens(selected.refreshToken, requestId('selected'));
    await expect(service.logout(selected.refreshToken)).resolves.toBe(userA.id);
    await expect(service.logout(selected.refreshToken)).resolves.toBeNull();
    await expect(service.logout(rotated.refreshToken)).resolves.toBeNull();
    expect(persistence.refreshRows().map((row) => row.userId).sort())
      .toEqual([userA.id, userB.id].sort());
    await expect(service.refreshTokens(sibling.refreshToken, requestId('sibling')))
      .resolves.toHaveProperty('refreshToken');
    await expect(service.refreshTokens(otherUser.refreshToken, requestId('other-user')))
      .resolves.toHaveProperty('refreshToken');
  });

  it('lets only one concurrent predecessor/current logout delete the selected row', async () => {
    const { service, persistence, userA, userB } = fixture();
    const selected = await service.login(userA);
    const sibling = await service.login(userA);
    const otherUser = await service.login(userB);
    const rotated = await service.refreshTokens(selected.refreshToken, requestId('race'));
    const results = await Promise.all([
      service.logout(selected.refreshToken),
      service.logout(rotated.refreshToken),
    ]);
    expect(results.filter((result) => result === userA.id)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(persistence.refreshRows()).toHaveLength(2);
    await expect(service.refreshTokens(sibling.refreshToken, requestId('race-sibling')))
      .resolves.toHaveProperty('refreshToken');
    await expect(service.refreshTokens(otherUser.refreshToken, requestId('race-other')))
      .resolves.toHaveProperty('refreshToken');
  });
});

function fixture() {
  const persistence = new InMemoryAuthPersistenceTestAdapter();
  const userA = persistence.seedUser({ id: 'user-a', username: 'alice' });
  const userB = persistence.seedUser({ id: 'user-b', username: 'bob', numericId: 1002 });
  const service = new AuthService(
    persistence,
    new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } }),
    { get: vi.fn((key: string) => key === 'auth.jwtSecret' ? 'test-secret' : 30) } as never,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, persistence, userA, userB };
}

function requestId(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64);
}
