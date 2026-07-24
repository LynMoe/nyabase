import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@nyabase/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { ApiTokenEntity } from '../entities/api-token.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { AuthService } from './auth.service.js';

describe('AuthService logout session-selection contract', () => {
  const sources: DataSource[] = [];

  afterEach(async () => {
    await Promise.all(sources.splice(0).map((source) => source.destroy()));
  });

  it('returns no owner for unknown and replayed secrets', async () => {
    const { dataSource, service } = await fixture();
    const current = await service.login(await user(dataSource, 'user-a'));

    await expect(service.logout('unknown-refresh-token')).resolves.toBeNull();
    await expect(service.logout(current.refreshToken)).resolves.toBe('user-a');
    await expect(service.logout(current.refreshToken)).resolves.toBeNull();
  });

  it('selects exactly one current or predecessor session across users and sibling sessions', async () => {
    const { dataSource, service } = await fixture();
    const userA = await user(dataSource, 'user-a');
    const userB = await user(dataSource, 'user-b');
    const selected = await service.login(userA);
    const sibling = await service.login(userA);
    const otherUser = await service.login(userB);
    const rotated = await service.refreshTokens(selected.refreshToken, requestId('selected'));

    await expect(service.logout(selected.refreshToken)).resolves.toBe('user-a');
    await expect(service.logout(selected.refreshToken)).resolves.toBeNull();
    await expect(service.logout(rotated.refreshToken)).resolves.toBeNull();

    const remaining = await dataSource.getRepository(RefreshTokenEntity).find({
      order: { userId: 'ASC', id: 'ASC' },
    });
    expect(remaining).toHaveLength(2);
    expect(remaining.map((row) => row.userId)).toEqual(['user-a', 'user-b']);
    await expect(service.refreshTokens(sibling.refreshToken, requestId('sibling')))
      .resolves.toHaveProperty('refreshToken');
    await expect(service.refreshTokens(otherUser.refreshToken, requestId('other-user')))
      .resolves.toHaveProperty('refreshToken');
  });

  it('lets only one concurrent predecessor/current logout delete the selected row', async () => {
    const { dataSource, service } = await fixture();
    const userA = await user(dataSource, 'user-a');
    const userB = await user(dataSource, 'user-b');
    const selected = await service.login(userA);
    const sibling = await service.login(userA);
    const otherUser = await service.login(userB);
    const rotated = await service.refreshTokens(selected.refreshToken, requestId('race'));

    const results = await Promise.all([
      service.logout(selected.refreshToken),
      service.logout(rotated.refreshToken),
    ]);

    expect(results.filter((result) => result === 'user-a')).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(await dataSource.getRepository(RefreshTokenEntity).count()).toBe(2);
    await expect(service.refreshTokens(sibling.refreshToken, requestId('race-sibling')))
      .resolves.toHaveProperty('refreshToken');
    await expect(service.refreshTokens(otherUser.refreshToken, requestId('race-other-user')))
      .resolves.toHaveProperty('refreshToken');
  });

  async function fixture() {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [UserEntity, RefreshTokenEntity, ApiTokenEntity],
    });
    await dataSource.initialize();
    sources.push(dataSource);
    await dataSource.getRepository(UserEntity).save([
      {
        id: 'user-a',
        numericId: 1001,
        username: 'alice',
        displayName: 'Alice',
        passwordHash: 'unused',
        status: UserStatus.Active,
        authVersion: 0,
      },
      {
        id: 'user-b',
        numericId: 1002,
        username: 'bob',
        displayName: 'Bob',
        passwordHash: 'unused',
        status: UserStatus.Active,
        authVersion: 0,
      },
    ]);
    const service = new AuthService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(RefreshTokenEntity),
      dataSource.getRepository(ApiTokenEntity),
      new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } }),
      {
        get: vi.fn((key: string) => key === 'auth.jwtSecret' ? 'test-secret' : 30),
      } as never,
    );
    return { dataSource, service };
  }
});

async function user(dataSource: DataSource, id: string): Promise<UserEntity> {
  return dataSource.getRepository(UserEntity).findOneByOrFail({ id });
}

function requestId(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64);
}
