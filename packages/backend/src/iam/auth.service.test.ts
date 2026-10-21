import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UserStatus } from '@nyabase/common';
import {
  AuthService,
  LOGIN_ATTEMPT_WINDOW_MS,
  MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL,
} from './auth.service.js';
import { InMemoryAuthPersistenceTestAdapter } from './in-memory-auth-persistence.test-helper.js';
import { SYSTEM_ACTOR_USERNAME } from './system-actor.js';

describe('AuthService login limiter', () => {
  it('returns 429 once a principal exhausts its fixed window', () => {
    const service = createAuth();

    for (let i = 0; i < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL; i += 1) {
      expect(() => consume(service, '10.0.0.3', 'admin')).not.toThrow();
    }
    expect(() => consume(service, '10.0.0.3', 'admin')).toThrow(
      expect.objectContaining({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: expect.objectContaining({ code: 'AUTH_RATE_LIMITED' }),
      }),
    );
  });

  it('opens a fresh window after the fixed window elapses', () => {
    let now = 0;
    const service = createAuth({ monotonicNow: () => now });

    for (let i = 0; i < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL; i += 1) {
      consume(service, '10.0.0.5', 'admin');
    }
    expect(() => consume(service, '10.0.0.5', 'admin')).toThrow();
    now += LOGIN_ATTEMPT_WINDOW_MS;
    expect(() => consume(service, '10.0.0.5', 'admin')).not.toThrow();
  });

  it('releases reservations after a successful login', async () => {
    const persistence = new InMemoryAuthPersistenceTestAdapter();
    const passwordHash = await new AuthService(
      persistence as never,
      jwt(),
      config(),
      audit(),
      { now: () => 0 } as never,
    ).hashPassword('correct-password');
    persistence.seedUser({
      id: randomUUID(),
      username: 'admin',
      passwordHash,
      status: UserStatus.Active,
    });
    const service = createAuth({ persistence });

    for (let i = 0; i < MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL + 2; i += 1) {
      await expect(service.authenticateAndLogin(
        'admin',
        'correct-password',
        '10.0.0.4',
      )).resolves.toMatchObject({
        accessToken: expect.any(String),
      });
    }
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
    consumeLoginAttempt: (clientIp: string, username: string) => unknown;
  }).consumeLoginAttempt(ip, username);
}

function createAuth(options: {
  persistence?: InMemoryAuthPersistenceTestAdapter;
  monotonicNow?: () => number;
} = {}) {
  return new AuthService(
    (options.persistence ?? new InMemoryAuthPersistenceTestAdapter()) as never,
    jwt(),
    config(),
    audit(),
    { now: options.monotonicNow ?? (() => performance.now()) } as never,
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
