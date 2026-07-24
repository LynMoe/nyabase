import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { UserStatus } from '@nyabase/common';
import { ApiTokenEntity } from '../entities/api-token.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { AuthService } from './auth.service.js';
describe('AuthService refresh token rotation', () => {
  it('rejects malformed request ids even when called outside the HTTP controller', async () => {
    const dataSource = await makeAuthDataSource();
    try {
      const service = makeDbService(dataSource);
      await expect(service.refreshTokens('token', 'A'.repeat(64)))
        .rejects.toBeInstanceOf(BadRequestException);
      await expect(service.refreshTokens('token', 'a'.repeat(63)))
        .rejects.toBeInstanceOf(BadRequestException);
    } finally {
      await dataSource.destroy();
    }
  });
  it('allows only one concurrent rotation of the same refresh token', async () => {
    const dataSource = await makeAuthDataSource();
    try {
      await dataSource.getRepository(UserEntity).save({
        id: 'user-a',
        numericId: 1001,
        username: 'alice',
        displayName: 'Alice',
        passwordHash: 'unused',
        status: UserStatus.Active,
      });
      const service = makeDbService(dataSource);
      const issued = await service.login({
        id: 'user-a',
        username: 'alice',
      } as UserEntity);

      const attempts = await Promise.allSettled([
        service.refreshTokens(issued.refreshToken, '1'.repeat(64)),
        service.refreshTokens(issued.refreshToken, '2'.repeat(64)),
      ]);

      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const storedTokens = await dataSource.getRepository(RefreshTokenEntity).find();
      expect(storedTokens).toHaveLength(1);
      expect(storedTokens[0].revoked).toBe(false);
      expect(storedTokens[0].previousHash).not.toBeNull();
      expect(storedTokens.every((token) => token.userId === 'user-a')).toBe(true);
    } finally {
      await dataSource.destroy();
    }
  });

  it('recovers the exact committed successor when the same refresh response is retried', async () => {
    const dataSource = await makeAuthDataSource();
    try {
      await dataSource.getRepository(UserEntity).save({
        id: 'user-a',
        numericId: 1001,
        username: 'alice',
        displayName: 'Alice',
        passwordHash: 'unused',
        status: UserStatus.Active,
      });
      const service = makeDbService(dataSource);
      const issued = await service.login({ id: 'user-a', username: 'alice' } as UserEntity);
      const requestId = 'a'.repeat(64);

      const first = await service.refreshTokens(issued.refreshToken, requestId);
      const recovered = await service.refreshTokens(issued.refreshToken, requestId);

      expect(recovered.refreshToken).toBe(first.refreshToken);
      expect(await dataSource.getRepository(RefreshTokenEntity).count()).toBe(1);
      await expect(service.refreshTokens(issued.refreshToken, 'b'.repeat(64)))
        .rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      await dataSource.destroy();
    }
  });
});

async function makeAuthDataSource() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: true,
    entities: [UserEntity, RefreshTokenEntity, ApiTokenEntity],
  });
  await dataSource.initialize();
  return dataSource;
}

function makeDbService(dataSource: DataSource) {
  const jwtService = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } });
  const config = {
    get: vi.fn((key: string) => {
      if (key === 'auth.jwtSecret') return 'test-secret';
      if (key === 'auth.refreshTokenExpiresDays') return 30;
      return undefined;
    }),
  };
  return new AuthService(
    dataSource.getRepository(UserEntity),
    dataSource.getRepository(RefreshTokenEntity),
    dataSource.getRepository(ApiTokenEntity),
    jwtService,
    config as never,
  );
}
