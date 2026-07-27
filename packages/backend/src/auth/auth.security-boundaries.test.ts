import { HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@nyabase/common';
import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { InMemoryAuthPersistenceTestAdapter } from './in-memory-auth-persistence.test-helper.js';
import type { RedisDisposableAdapter } from '../runtime/redis-disposable.adapter.js';

describe('AuthService durable security boundaries', () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rotates one refresh session in place for 100 rotations', async () => {
    const { service, persistence, user } = fixture();
    let refreshToken = (await service.login(user)).refreshToken;

    for (let index = 0; index < 100; index += 1) {
      refreshToken = (await service.refreshTokens(refreshToken, refreshRequestId(index))).refreshToken;
    }

    const rows = persistence.refreshRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 'user-a', revoked: false });
    expect(rows[0].hash).toBe(sha256(refreshToken));
  });

  it('lets either the current secret or its one-step predecessor delete the same session', async () => {
    const { service, persistence, user } = fixture();
    const initial = await service.login(user);
    const rotated = await service.refreshTokens(initial.refreshToken, refreshRequestId(101));

    await service.logout(initial.refreshToken);
    expect(persistence.refreshRows()).toHaveLength(0);
    await expect(service.refreshTokens(rotated.refreshToken, refreshRequestId(102)))
      .rejects.toBeInstanceOf(UnauthorizedException);

    const current = await service.login(user);
    await service.logout(current.refreshToken);
    expect(persistence.refreshRows()).toHaveLength(0);
  });

  it('bounds active refresh sessions and evicts the oldest row', async () => {
    const { service, persistence, user } = fixture();
    const secrets: string[] = [];
    for (let index = 0; index < MAX_REFRESH_SESSIONS_PER_USER + 1; index += 1) {
      secrets.push((await service.login(user)).refreshToken);
    }

    expect(persistence.refreshRows()).toHaveLength(MAX_REFRESH_SESSIONS_PER_USER);
    await expect(service.refreshTokens(secrets.at(-1)!, refreshRequestId(103)))
      .resolves.toHaveProperty('refreshToken');
  });

  it('samples refresh expiry only after acquiring the database lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const { service, persistence, user } = fixture();
    const issued = await service.login(user);
    persistence.updateRefreshByHash(
      sha256(issued.refreshToken),
      { expiresAt: new Date(Date.now() + 1_000) },
    );

    let entered!: () => void;
    const enteredLease = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const leaseGate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = persistence.runExclusiveForTest(async () => {
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
    const { service, persistence, jwt, user: original } = fixture();
    const issued = await service.login(original);
    const payload = jwt.verify<JwtPayload>(issued.accessToken);
    persistence.updateUser(original.id, { authVersion: original.authVersion + 1 });
    await expect(service.validateJwtPayload(payload)).rejects.toBeInstanceOf(UnauthorizedException);

    persistence.clearRefresh();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let verified!: () => void;
    const verifiedSnapshot = new Promise<void>((resolve) => { verified = resolve; });
    vi.spyOn(service, 'validateUser').mockImplementationOnce(async () => {
      const snapshot = { ...persistence.getUser(original.id) };
      verified();
      await gate;
      return snapshot;
    });
    const login = service.authenticateAndLogin('alice', 'old-password', '192.0.2.1');
    await verifiedSnapshot;
    persistence.updateUser(original.id, {
      passwordHash: 'new-hash',
      authVersion: 2,
    });
    release();

    await expect(login).rejects.toBeInstanceOf(UnauthorizedException);
    expect(persistence.refreshRows()).toHaveLength(0);
  });

  it('releases only the successful reservation without clearing prior IP failures', async () => {
    const { persistence, service } = fixture();
    vi.spyOn(service, 'validateUser').mockImplementation(async (username) => {
      if (username === 'alice') return persistence.getUser('user-a');
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
    const { persistence, service } = fixture();
    let entered!: () => void;
    const successEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const successGate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(service, 'validateUser').mockImplementation(async (_username, password) => {
      if (password !== 'correct') throw new UnauthorizedException('Invalid credentials');
      entered();
      await successGate;
      return persistence.getUser('user-a');
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
    let monotonicNow = 0;
    const { persistence, service } = fixture(
      undefined,
      () => monotonicNow,
    );
    let entered!: () => void;
    const successEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const successGate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(service, 'validateUser').mockImplementation(async (_username, password) => {
      if (password !== 'correct') throw new UnauthorizedException('Invalid credentials');
      entered();
      await successGate;
      return persistence.getUser('user-a');
    });

    const success = service.authenticateAndLogin('alice', 'correct', '198.51.100.9');
    await successEntered;
    monotonicNow += LOGIN_ATTEMPT_WINDOW_MS + 1;
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
    const { persistence, service } = fixture();
    const stale = { ...persistence.getUser('user-a'), passwordHash: 'stale-password-hash' };
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
    expect(persistence.refreshRows()).toHaveLength(0);
  });

  it('removes zero-count successes and fails closed instead of evicting live limiter entries', async () => {
    const { persistence, service } = fixture();
    const validate = vi.spyOn(service, 'validateUser')
      .mockResolvedValue(persistence.getUser('user-a'));
    await expect(service.authenticateAndLogin('alice', 'correct', '192.0.2.40'))
      .resolves.toHaveProperty('accessToken');
    const attempts = (service as unknown as {
      loginAttempts: Map<string, { count: number }>;
    }).loginAttempts;
    expect(attempts.size).toBe(0);

    validate.mockRejectedValue(new UnauthorizedException('Invalid credentials'));
    for (let index = 0; index < MAX_LOGIN_LIMITER_KEYS / 2; index += 1) {
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
    const overflow = await service.authenticateAndLogin(
      'capacity-overflow',
      'wrong',
      '203.0.113.254',
    ).catch((error: unknown) => error);
    expect(overflow).toBeInstanceOf(HttpException);
    expect((overflow as HttpException).getStatus()).toBe(429);
    expect(attempts.size).toBe(MAX_LOGIN_LIMITER_KEYS);
  });

  it('keeps the limiter bounded when a later principal bucket rejects early', async () => {
    const { service } = await fixture();
    const now = Date.now();
    const attempts = (service as unknown as {
      loginAttempts: Map<string, {
        count: number;
        windowStartedAt: number;
        lastSeenAt: number;
      }>;
    }).loginAttempts;
    for (let index = 0; index < MAX_LOGIN_LIMITER_KEYS - 1; index += 1) {
      attempts.set(`seed:${index}`, {
        count: 1,
        windowStartedAt: now,
        lastSeenAt: now,
      });
    }
    attempts.set('principal:blocked', {
      count: MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL,
      windowStartedAt: now,
      lastSeenAt: now,
    });

    const blocked = await service.authenticateAndLogin(
      'blocked',
      'wrong',
      '198.51.100.250',
    ).catch((error: unknown) => error);

    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
    expect(attempts.size).toBe(MAX_LOGIN_LIMITER_KEYS);
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

  it('uses opaque Redis reservations across API instances and releases only a successful login', async () => {
    let reservationIndex = 0;
    const redis = {
      consumeRateLimit: vi.fn(async (scope: string) => ({
        available: true,
        allowed: true,
        count: 1,
        retryAfterMs: LOGIN_ATTEMPT_WINDOW_MS,
        reservation: {
          scope,
          windowId: `00000000-0000-4000-8000-${String(++reservationIndex).padStart(12, '0')}`,
          reservationId: `10000000-0000-4000-8000-${String(reservationIndex).padStart(12, '0')}`,
        },
      })),
      releaseRateLimit: vi.fn().mockResolvedValue(true),
    } as unknown as RedisDisposableAdapter;
    const { persistence, service } = fixture(redis);
    vi.spyOn(service, 'validateUser').mockResolvedValue(persistence.getUser('user-a'));

    await expect(service.authenticateAndLogin(
      'alice',
      'correct',
      '192.0.2.200',
    )).resolves.toHaveProperty('accessToken');

    expect(redis.consumeRateLimit).toHaveBeenCalledTimes(2);
    for (const [scope] of (redis.consumeRateLimit as ReturnType<typeof vi.fn>).mock.calls) {
      expect(scope).toMatch(/^login:(ip|principal):[0-9a-f]{64}$/);
      expect(scope).not.toContain('alice');
      expect(scope).not.toContain('192.0.2.200');
    }
    expect(redis.releaseRateLimit).toHaveBeenCalledTimes(2);
  });

  it('retains an earlier Redis reservation when the principal budget denies the attempt', async () => {
    const redis = {
      consumeRateLimit: vi.fn()
        .mockResolvedValueOnce({
          available: true,
          allowed: true,
          count: 1,
          retryAfterMs: LOGIN_ATTEMPT_WINDOW_MS,
          reservation: {
            scope: `login:ip:${'a'.repeat(64)}`,
            windowId: '00000000-0000-4000-8000-000000000001',
            reservationId: '10000000-0000-4000-8000-000000000001',
          },
        })
        .mockResolvedValueOnce({
          available: true,
          allowed: false,
          count: MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL,
          retryAfterMs: 1_000,
          reservation: null,
        }),
      releaseRateLimit: vi.fn().mockResolvedValue(true),
    } as unknown as RedisDisposableAdapter;
    const { service } = await fixture(redis);
    const validate = vi.spyOn(service, 'validateUser');

    const blocked = await service.authenticateAndLogin(
      'alice',
      'correct',
      '192.0.2.201',
    ).catch((error: unknown) => error);

    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
    expect(validate).not.toHaveBeenCalled();
    expect(redis.releaseRateLimit).not.toHaveBeenCalled();

    (redis.consumeRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      available: false,
      allowed: false,
      count: 0,
      retryAfterMs: 0,
      reservation: null,
    });
    validate.mockRejectedValue(new UnauthorizedException('Invalid credentials'));
    for (let index = 0; index < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL - 1; index += 1) {
      await expect(service.authenticateAndLogin(
        'alice',
        'wrong',
        `198.51.100.${index + 1}`,
      )).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const locallyBlocked = await service.authenticateAndLogin(
      'alice',
      'wrong',
      '198.51.100.250',
    ).catch((error: unknown) => error);
    expect(locallyBlocked).toBeInstanceOf(HttpException);
    expect((locallyBlocked as HttpException).getStatus()).toBe(429);
  });

  it('expires bounded attempt windows and globally caps Argon2 concurrency', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    let monotonicNow = 0;
    const { service } = await fixture(undefined, () => monotonicNow);
    vi.spyOn(service, 'validateUser').mockRejectedValue(new UnauthorizedException('Invalid credentials'));
    for (let index = 0; index < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL; index += 1) {
      await expect(service.authenticateAndLogin(
        'windowed', 'wrong', `192.0.2.${index + 1}`,
      )).rejects.toBeInstanceOf(UnauthorizedException);
    }
    vi.setSystemTime(new Date(Date.now() + 15 * 60_000));
    const wallClockBlocked = await service.authenticateAndLogin(
      'windowed',
      'wrong',
      '192.0.2.249',
    ).catch((error: unknown) => error);
    expect(wallClockBlocked).toBeInstanceOf(HttpException);
    expect((wallClockBlocked as HttpException).getStatus()).toBe(429);

    monotonicNow += LOGIN_ATTEMPT_WINDOW_MS + 1;
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
    const { persistence, service } = fixture();
    const created = await service.createApiToken('user-a', 'automation');
    let entered!: () => void;
    const updateEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const updateGate = new Promise<void>((resolve) => { release = resolve; });
    persistence.beforeApiTokenTouch = async () => {
      entered();
      await updateGate;
    };

    const validation = service.validateApiToken(created.secret);
    await updateEntered;
    persistence.deleteApiTokenForTest(created.entity.id);
    release();

    await expect(validation).resolves.toBeNull();
    expect(persistence.apiTokenRows()).toHaveLength(0);
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

  function fixture(
    redis?: RedisDisposableAdapter,
    monotonicNow?: () => number,
  ) {
    const persistence = new InMemoryAuthPersistenceTestAdapter();
    const user = persistence.seedUser({
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
      persistence,
      jwt,
      {
        get: vi.fn((key: string) => key === 'auth.jwtSecret' ? 'test-secret' : 30),
      } as never,
      { append: vi.fn().mockResolvedValue(undefined) } as never,
      redis,
      monotonicNow,
    );
    return { service, jwt, persistence, user };
  }
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function refreshRequestId(index: number): string {
  return index.toString(16).padStart(64, '0');
}
