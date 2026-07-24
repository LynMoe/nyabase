import { HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@nyabase/common';
import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ApiTokenEntity } from '../entities/api-token.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import {
  AuthService,
  MAX_API_TOKENS_PER_USER,
  MAX_CONCURRENT_PASSWORD_VERIFICATIONS,
  MAX_LOGIN_ATTEMPTS_PER_IP,
  MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL,
  MAX_LOGIN_LIMITER_KEYS,
  MAX_REFRESH_SESSIONS_PER_USER,
  LOGIN_ATTEMPT_WINDOW_MS,
  type JwtPayload,
} from './auth.service.js';

describe('AuthService durable security boundaries', () => {
  const sources: DataSource[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(sources.splice(0).map((source) => source.destroy()));
  });

  it('rotates one refresh session in place for 100 rotations', async () => {
    const { dataSource, service } = await fixture();
    let refreshToken = (await service.login(await user(dataSource))).refreshToken;

    for (let index = 0; index < 100; index += 1) {
      refreshToken = (await service.refreshTokens(refreshToken, refreshRequestId(index))).refreshToken;
    }

    const rows = await dataSource.getRepository(RefreshTokenEntity).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 'user-a', revoked: false });
    expect(rows[0].hash).toBe(sha256(refreshToken));
  });

  it('lets either the current secret or its one-step predecessor delete the same session', async () => {
    const { dataSource, service } = await fixture();
    const initial = await service.login(await user(dataSource));
    const rotated = await service.refreshTokens(initial.refreshToken, refreshRequestId(101));

    await service.logout(initial.refreshToken);
    expect(await dataSource.getRepository(RefreshTokenEntity).count()).toBe(0);
    await expect(service.refreshTokens(rotated.refreshToken, refreshRequestId(102)))
      .rejects.toBeInstanceOf(UnauthorizedException);

    const current = await service.login(await user(dataSource));
    await service.logout(current.refreshToken);
    expect(await dataSource.getRepository(RefreshTokenEntity).count()).toBe(0);
  });

  it('bounds active refresh sessions and evicts the oldest row', async () => {
    const { dataSource, service } = await fixture();
    const secrets: string[] = [];
    for (let index = 0; index < MAX_REFRESH_SESSIONS_PER_USER + 1; index += 1) {
      secrets.push((await service.login(await user(dataSource))).refreshToken);
    }

    expect(await dataSource.getRepository(RefreshTokenEntity).count()).toBe(MAX_REFRESH_SESSIONS_PER_USER);
    await expect(service.refreshTokens(secrets.at(-1)!, refreshRequestId(103)))
      .resolves.toHaveProperty('refreshToken');
  });

  it('samples refresh expiry only after acquiring the database lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const { dataSource, service } = await fixture();
    const issued = await service.login(await user(dataSource));
    await dataSource.getRepository(RefreshTokenEntity).update(
      { hash: sha256(issued.refreshToken) },
      { expiresAt: new Date(Date.now() + 1_000) },
    );

    let entered!: () => void;
    const enteredLease = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const leaseGate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = runSerializedTransaction(dataSource, async () => {
      entered();
      await leaseGate;
    });
    await enteredLease;
    const refresh = service.refreshTokens(issued.refreshToken, refreshRequestId(104));
    vi.setSystemTime(new Date('2026-07-17T00:00:02.000Z'));
    release();
    await blocker;

    await expect(refresh).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('invalidates old JWT generations and preserves zero credential rows on a login CAS loss', async () => {
    const { dataSource, service, jwt } = await fixture();
    const original = await user(dataSource);
    const issued = await service.login(original);
    const payload = jwt.verify<JwtPayload>(issued.accessToken);
    await dataSource.getRepository(UserEntity).increment({ id: original.id }, 'authVersion', 1);
    await expect(service.validateJwtPayload(payload)).rejects.toBeInstanceOf(UnauthorizedException);

    await dataSource.getRepository(RefreshTokenEntity).clear();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let verified!: () => void;
    const verifiedSnapshot = new Promise<void>((resolve) => { verified = resolve; });
    vi.spyOn(service, 'validateUser').mockImplementationOnce(async () => {
      const snapshot = await user(dataSource);
      verified();
      await gate;
      return snapshot;
    });
    const login = service.authenticateAndLogin('alice', 'old-password', '192.0.2.1');
    await verifiedSnapshot;
    await dataSource.getRepository(UserEntity).update(original.id, {
      passwordHash: 'new-hash',
      authVersion: 2,
    });
    release();

    await expect(login).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await dataSource.getRepository(RefreshTokenEntity).count()).toBe(0);
  });

  it('releases only the successful reservation without clearing prior IP failures', async () => {
    const { dataSource, service } = await fixture();
    vi.spyOn(service, 'validateUser').mockImplementation(async (username) => {
      if (username === 'alice') return user(dataSource);
      throw new UnauthorizedException('Invalid credentials');
    });

    for (let index = 0; index < MAX_LOGIN_ATTEMPTS_PER_IP - 1; index += 1) {
      await expect(service.authenticateAndLogin(
        `missing-${index}`,
        'wrong',
        '198.51.100.7',
      )).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(service.authenticateAndLogin('alice', 'correct', '198.51.100.7'))
      .resolves.toHaveProperty('accessToken');

    await expect(service.authenticateAndLogin(
      'another-name',
      'wrong',
      '198.51.100.7',
    )).rejects.toBeInstanceOf(UnauthorizedException);

    const blocked = await service.authenticateAndLogin(
      'one-too-many',
      'wrong',
      '198.51.100.7',
    ).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
  });

  it('does not let a successful login erase a concurrent failed reservation', async () => {
    const { dataSource, service } = await fixture();
    let entered!: () => void;
    const successEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const successGate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(service, 'validateUser').mockImplementation(async (_username, password) => {
      if (password !== 'correct') throw new UnauthorizedException('Invalid credentials');
      entered();
      await successGate;
      return user(dataSource);
    });

    const success = service.authenticateAndLogin('alice', 'correct', '198.51.100.8');
    await successEntered;
    await expect(service.authenticateAndLogin('alice', 'wrong', '198.51.100.8'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    release();
    await expect(success).resolves.toHaveProperty('accessToken');

    for (let index = 1; index < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL; index += 1) {
      await expect(service.authenticateAndLogin('alice', 'wrong', '198.51.100.8'))
        .rejects.toBeInstanceOf(UnauthorizedException);
    }
    const blocked = await service.authenticateAndLogin(
      'alice',
      'wrong',
      '198.51.100.8',
    ).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
  });

  it('does not let an old-window success decrement a replacement IP window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const { dataSource, service } = await fixture();
    let entered!: () => void;
    const successEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const successGate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(service, 'validateUser').mockImplementation(async (_username, password) => {
      if (password !== 'correct') throw new UnauthorizedException('Invalid credentials');
      entered();
      await successGate;
      return user(dataSource);
    });

    const success = service.authenticateAndLogin('alice', 'correct', '198.51.100.9');
    await successEntered;
    vi.setSystemTime(new Date(Date.now() + LOGIN_ATTEMPT_WINDOW_MS + 1));
    for (let index = 0; index < MAX_LOGIN_ATTEMPTS_PER_IP; index += 1) {
      await expect(service.authenticateAndLogin(
        `replacement-${index}`,
        'wrong',
        '198.51.100.9',
      )).rejects.toBeInstanceOf(UnauthorizedException);
    }
    release();
    await expect(success).resolves.toHaveProperty('accessToken');

    const blocked = await service.authenticateAndLogin(
      'replacement-overflow',
      'wrong',
      '198.51.100.9',
    ).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
  });

  it('retains every credential-generation CAS loss in the principal budget', async () => {
    const { dataSource, service } = await fixture();
    const stale = { ...(await user(dataSource)), passwordHash: 'stale-password-hash' };
    vi.spyOn(service, 'validateUser').mockResolvedValue(stale);

    for (let index = 0; index < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL; index += 1) {
      await expect(service.authenticateAndLogin(
        'alice',
        'correct',
        `203.0.113.${index + 1}`,
      )).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const blocked = await service.authenticateAndLogin(
      'alice',
      'correct',
      '203.0.113.250',
    ).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
    expect(await dataSource.getRepository(RefreshTokenEntity).count()).toBe(0);
  });

  it('removes zero-count successes and keeps limiter entries bounded and positive', async () => {
    const { dataSource, service } = await fixture();
    const validate = vi.spyOn(service, 'validateUser').mockResolvedValue(await user(dataSource));
    await expect(service.authenticateAndLogin('alice', 'correct', '192.0.2.40'))
      .resolves.toHaveProperty('accessToken');
    const attempts = (service as unknown as {
      loginAttempts: Map<string, { count: number }>;
    }).loginAttempts;
    expect(attempts.size).toBe(0);

    validate.mockRejectedValue(new UnauthorizedException('Invalid credentials'));
    for (let index = 0; index < MAX_LOGIN_LIMITER_KEYS / 2 + 16; index += 1) {
      await expect(service.authenticateAndLogin(
        `bounded-${index}`,
        'wrong',
        `198.18.${Math.floor(index / 250)}.${(index % 250) + 1}`,
      )).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(attempts.size).toBe(MAX_LOGIN_LIMITER_KEYS);
    expect([...attempts.values()].every(
      (entry) => Number.isInteger(entry.count) && entry.count > 0,
    )).toBe(true);
  });

  it('shares the principal budget across source IPs', async () => {
    const { service } = await fixture();
    vi.spyOn(service, 'validateUser').mockRejectedValue(new UnauthorizedException('Invalid credentials'));

    for (let index = 0; index < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL; index += 1) {
      await expect(service.authenticateAndLogin(
        'same-principal',
        'wrong',
        `203.0.113.${index + 1}`,
      )).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const blocked = await service.authenticateAndLogin(
      'same-principal',
      'wrong',
      '203.0.113.250',
    ).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
  });

  it('expires bounded attempt windows and globally caps Argon2 concurrency', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const { service } = await fixture();
    vi.spyOn(service, 'validateUser').mockRejectedValue(new UnauthorizedException('Invalid credentials'));
    for (let index = 0; index < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL; index += 1) {
      await expect(service.authenticateAndLogin(
        'windowed', 'wrong', `192.0.2.${index + 1}`,
      )).rejects.toBeInstanceOf(UnauthorizedException);
    }
    vi.setSystemTime(new Date(Date.now() + LOGIN_ATTEMPT_WINDOW_MS + 1));
    await expect(service.authenticateAndLogin('windowed', 'wrong', '192.0.2.250'))
      .rejects.toBeInstanceOf(UnauthorizedException);

    vi.useRealTimers();
    vi.restoreAllMocks();
    const cheapHash = await argon2.hash('correct', { memoryCost: 8, timeCost: 1, parallelism: 1 });
    const checks = await Promise.allSettled(
      Array.from(
        { length: MAX_CONCURRENT_PASSWORD_VERIFICATIONS + 1 },
        () => service.verifyPassword(cheapHash, 'correct'),
      ),
    );
    expect(checks.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(MAX_CONCURRENT_PASSWORD_VERIFICATIONS);
    const rejected = checks.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(HttpException);
    expect((rejected?.reason as HttpException).getStatus()).toBe(429);
  });

  it('never resurrects a PAT deleted between lookup and last-used update', async () => {
    const { dataSource, service } = await fixture();
    const created = await service.createApiToken('user-a', 'automation');
    const repository = dataSource.getRepository(ApiTokenEntity);
    const originalUpdate = repository.update.bind(repository);
    let entered!: () => void;
    const updateEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const updateGate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(repository, 'update').mockImplementationOnce(async (criteria, values) => {
      entered();
      await updateGate;
      return originalUpdate(criteria, values);
    });

    const validation = service.validateApiToken(created.secret);
    await updateEntered;
    await repository.delete({ id: created.entity.id });
    release();

    await expect(validation).resolves.toBeNull();
    expect(await repository.count()).toBe(0);
  });

  it('caps PAT creation per active user', async () => {
    const { service } = await fixture();
    for (let index = 0; index < MAX_API_TOKENS_PER_USER; index += 1) {
      await service.createApiToken('user-a', `token-${index}`);
    }
    await expect(service.createApiToken('user-a', 'overflow')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'API_TOKEN_CAPACITY_REACHED' }),
    });
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
    await dataSource.getRepository(UserEntity).save({
      id: 'user-a',
      numericId: 1001,
      username: 'alice',
      displayName: 'Alice',
      passwordHash: 'old-hash',
      status: UserStatus.Active,
      authVersion: 0,
    });
    const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } });
    const service = new AuthService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(RefreshTokenEntity),
      dataSource.getRepository(ApiTokenEntity),
      jwt,
      {
        get: vi.fn((key: string) => key === 'auth.jwtSecret' ? 'test-secret' : 30),
      } as never,
    );
    return { dataSource, service, jwt };
  }
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function refreshRequestId(index: number): string {
  return index.toString(16).padStart(64, '0');
}

async function user(dataSource: DataSource): Promise<UserEntity> {
  return dataSource.getRepository(UserEntity).findOneByOrFail({ id: 'user-a' });
}
