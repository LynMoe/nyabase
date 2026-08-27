import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UserStatus } from '@nyabase/common';
import {
  AuthService,
  MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL,
} from './auth.service.js';
import { InMemoryAuthPersistenceTestAdapter } from './in-memory-auth-persistence.test-helper.js';
import { SYSTEM_ACTOR_USERNAME } from '../groups/groups.service.js';

describe('AuthService login limiter', () => {
  it('rejects the request when Redis is configured but unavailable, even if local count is 1', async () => {
    const redis = {
      consumeRateLimit: vi.fn().mockResolvedValue({
        available: false,
        allowed: false,
        count: 0,
        retryAfterMs: 0,
        reservation: null,
      }),
      releaseRateLimit: vi.fn(),
    };
    const service = createAuth({ redis });

    await expect(consume(service, '10.0.0.1', 'admin')).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: { code: 'AUTH_LIMITER_UNAVAILABLE' },
    });
    expect(redis.consumeRateLimit).toHaveBeenCalled();
  });

  it('returns 429 when Redis denies the shared bucket', async () => {
    const redis = {
      consumeRateLimit: vi.fn().mockResolvedValue({
        available: true,
        allowed: false,
        count: 10,
        retryAfterMs: 1_000,
        reservation: null,
      }),
      releaseRateLimit: vi.fn(),
    };
    const service = createAuth({ redis });

    await expect(consume(service, '10.0.0.2', 'admin')).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'AUTH_RATE_LIMITED' },
    });
  });

  it('keeps the process-local limiter when Redis is not wired', async () => {
    const service = createAuth({ redis: undefined });

    for (let i = 0; i < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL; i += 1) {
      await expect(consume(service, '10.0.0.3', 'admin')).resolves.toBeDefined();
    }
    await expect(consume(service, '10.0.0.3', 'admin')).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'AUTH_RATE_LIMITED' },
    });
  });

  it('releases Redis reservations after a successful login', async () => {
    const reservation = {
      scope: 'login:ip:abc',
      windowId: randomUUID(),
      reservationId: randomUUID(),
    };
    const redis = {
      consumeRateLimit: vi.fn().mockResolvedValue({
        available: true,
        allowed: true,
        count: 1,
        retryAfterMs: 1_000,
        reservation,
      }),
      releaseRateLimit: vi.fn().mockResolvedValue(true),
    };
    const persistence = new InMemoryAuthPersistenceTestAdapter();
    const passwordHash = await new AuthService(
      persistence,
      jwt(),
      config(),
      audit(),
    ).hashPassword('correct-password');
    persistence.seedUser({
      id: randomUUID(),
      username: 'admin',
      passwordHash,
      status: UserStatus.Active,
    });
    const service = createAuth({ persistence, redis });

    await expect(service.authenticateAndLogin(
      'admin',
      'correct-password',
      '10.0.0.4',
    )).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
    expect(redis.releaseRateLimit).toHaveBeenCalled();
  });
});

describe('AuthService nyabase-system login', () => {
  it('rejects login for the durable system actor', async () => {
    const persistence = new InMemoryAuthPersistenceTestAdapter();
    persistence.seedUser({
      id: randomUUID(),
      username: SYSTEM_ACTOR_USERNAME,
      displayName: 'Nyabase System',
      status: UserStatus.Disabled,
      passwordHash: 'unused',
    });
    const service = createAuth({ persistence });

    await expect(service.authenticateAndLogin(
      SYSTEM_ACTOR_USERNAME,
      'any-password',
      '127.0.0.1',
    )).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

function consume(service: AuthService, ip: string, username: string) {
  return (service as unknown as {
    consumeLoginAttempt: (clientIp: string, username: string) => Promise<unknown>;
  }).consumeLoginAttempt(ip, username);
}

function createAuth(options: {
  redis?: {
    consumeRateLimit: ReturnType<typeof vi.fn>;
    releaseRateLimit: ReturnType<typeof vi.fn>;
  };
  persistence?: InMemoryAuthPersistenceTestAdapter;
} = {}) {
  return new AuthService(
    options.persistence ?? new InMemoryAuthPersistenceTestAdapter(),
    jwt(),
    config(),
    audit(),
    options.redis as never,
  );
}

function jwt() {
  return {
    sign: () => 'access-token',
    verifyAsync: vi.fn(),
  } as never;
}

function config() {
  return {
    get: (key: string) => {
      if (key === 'auth.jwtSecret') return 'test-jwt-secret-test-jwt-secret-32ch';
      if (key === 'auth.refreshTokenExpiresDays') return 7;
      return undefined;
    },
  } as never;
}

function audit() {
  return { append: vi.fn().mockResolvedValue(undefined) } as never;
}
