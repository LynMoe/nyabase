import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { UserStatus } from '@nyabase/common';
import { ApiTokenEntity } from '../entities/api-token.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { AuthService } from './auth.service.js';
describe('AuthService refresh token rotation', () => {
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
        service.refreshTokens(issued.refreshToken),
        service.refreshTokens(issued.refreshToken),
      ]);

      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const storedTokens = await dataSource.getRepository(RefreshTokenEntity).find();
      expect(storedTokens).toHaveLength(2);
      expect(storedTokens.filter((token) => token.revoked)).toHaveLength(1);
      expect(storedTokens.filter((token) => !token.revoked)).toHaveLength(1);
      expect(storedTokens.every((token) => token.userId === 'user-a')).toBe(true);
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
