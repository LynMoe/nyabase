import { ForbiddenException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Role, UserStatus } from '@nyabase/common';
import {
  AuthService,
  MAX_LOGIN_FAILURES_PER_IP,
  MAX_LOGIN_FAILURES_PER_IP_USERNAME,
  MAX_REAUTH_FAILURES_PER_USER,
} from './auth.service.js';
import type { Actor } from './actor.js';
import { clientAddressBucket } from './client-address.js';
import { InMemoryAuthPersistenceTestAdapter } from './in-memory-auth-persistence.test-helper.js';
import { LOGIN_ATTEMPT_WINDOW_MS, LoginAttemptLimiter } from './login-attempt-limiter.js';
import {
  PasswordVerificationBusyError,
  PasswordVerificationGate,
} from './password-verification-gate.js';

const rateLimited = expect.objectContaining({
  status: HttpStatus.TOO_MANY_REQUESTS,
  response: expect.objectContaining({ code: 'AUTH_RATE_LIMITED' }),
});

describe('AuthService login limiter', () => {
  it('limits failures per (address, username) without locking the username elsewhere', async () => {
    const { service } = await seededAuth('admin', 'correct-password');

    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_IP_USERNAME; i += 1) {
      await expect(service.authenticateAndLogin('admin', 'wrong-password', '203.0.113.7'))
        .rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(service.authenticateAndLogin('admin', 'correct-password', '203.0.113.7'))
      .rejects.toThrow(rateLimited);
    // The attacker's address is throttled; the real admin elsewhere is not.
    await expect(service.authenticateAndLogin('admin', 'correct-password', '198.51.100.20'))
      .resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it('limits failures per address across usernames', () => {
    const service = createAuth();
    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_IP; i += 1) {
      expect(() => consume(service, '10.0.0.3', `user-${i}`)).not.toThrow();
    }
    expect(() => consume(service, '10.0.0.3', 'fresh-user')).toThrow(rateLimited);
    expect(() => consume(service, '10.0.0.4', 'fresh-user')).not.toThrow();
  });

  it('buckets IPv6 clients by /64 and IPv4-mapped clients by IPv4 address', () => {
    expect(clientAddressBucket('2001:db8:1:2::1')).toBe(clientAddressBucket('2001:db8:1:2:ffff::9'));
    expect(clientAddressBucket('2001:db8:1:2::1')).not.toBe(clientAddressBucket('2001:db8:1:3::1'));
    expect(clientAddressBucket('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(clientAddressBucket('192.0.2.1')).toBe('192.0.2.1');
    expect(clientAddressBucket('not-an-ip')).toBe('unknown');

    const service = createAuth();
    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_IP_USERNAME; i += 1) {
      consume(service, `2001:db8:1:2::${(i + 1).toString(16)}`, 'admin');
    }
    expect(() => consume(service, '2001:db8:1:2::ffff', 'admin')).toThrow(rateLimited);
    expect(() => consume(service, '2001:db8:1:3::1', 'admin')).not.toThrow();
  });

  it('opens a fresh window after the fixed window elapses', () => {
    let now = 0;
    const service = createAuth({ monotonicNow: () => now });

    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_IP_USERNAME; i += 1) {
      consume(service, '10.0.0.5', 'admin');
    }
    expect(() => consume(service, '10.0.0.5', 'admin')).toThrow(rateLimited);
    now += LOGIN_ATTEMPT_WINDOW_MS;
    expect(() => consume(service, '10.0.0.5', 'admin')).not.toThrow();
  });

  it('releases reservations after a successful login', async () => {
    const { service } = await seededAuth('admin', 'correct-password');

    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_IP_USERNAME + 2; i += 1) {
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

describe('LoginAttemptLimiter', () => {
  it('evicts the least recently used entry instead of refusing new keys when full', () => {
    const limiter = new LoginAttemptLimiter(() => 0, 4);
    for (let i = 0; i < 4; i += 1) {
      expect(limiter.reserve([{ key: `filler-${i}`, limit: 1 }])).not.toBeNull();
    }
    expect(limiter.reserve([{ key: 'filler-3', limit: 1 }])).toBeNull();
    // A brand-new client is admitted although the table is full.
    expect(limiter.reserve([{ key: 'newcomer', limit: 1 }])).not.toBeNull();
    expect(limiter.size()).toBe(4);
    // The least recently touched entry (filler-0) made room; filler-3 kept its count.
    expect(limiter.reserve([{ key: 'filler-0', limit: 1 }])).not.toBeNull();
    expect(limiter.reserve([{ key: 'filler-3', limit: 1 }])).toBeNull();
  });

  it('consumes nothing when one rule of an attempt is exhausted', () => {
    const limiter = new LoginAttemptLimiter(() => 0);
    limiter.reserve([{ key: 'b', limit: 1 }]);
    expect(limiter.reserve([{ key: 'a', limit: 1 }, { key: 'b', limit: 1 }])).toBeNull();
    expect(limiter.reserve([{ key: 'a', limit: 1 }])).not.toBeNull();
  });

  it('a full table of other clients does not throttle a new login through AuthService', () => {
    const service = createAuth();
    for (let i = 0; i < 20_000; i += 1) consume(service, `10.1.${i >> 8}.${i & 255}`, 'x');
    expect(() => consume(service, '192.0.2.200', 'admin')).not.toThrow();
  });
});

describe('PasswordVerificationGate', () => {
  it('queues past the active limit and refuses only the holder over its share', async () => {
    const gate = new PasswordVerificationGate({ maxActive: 1, maxQueued: 8, maxPerHolder: 2, waitMs: 1_000 });
    const releases: Array<() => void> = [];
    const work = () => new Promise<string>((resolve) => { releases.push(() => resolve('done')); });

    const first = gate.run('ip:a', work);
    const second = gate.run('ip:a', work);
    await expect(gate.run('ip:a', work)).rejects.toMatchObject({ reason: 'holder' });
    const other = gate.run('ip:b', work);

    releases.shift()!();
    await expect(first).resolves.toBe('done');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await expect(second).resolves.toBe('done');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await expect(other).resolves.toBe('done');
  });

  it('gives up after the wait timeout and when the queue is full', async () => {
    vi.useFakeTimers();
    try {
      const gate = new PasswordVerificationGate({ maxActive: 1, maxQueued: 1, maxPerHolder: 2, waitMs: 100 });
      let release!: () => void;
      const running = gate.run('a', () => new Promise<void>((resolve) => { release = resolve; }));
      const queued = gate.run('b', async () => 'late');
      await expect(gate.run('c', async () => 'x')).rejects.toMatchObject({ reason: 'queue' });
      const timedOut = expect(queued).rejects.toBeInstanceOf(PasswordVerificationBusyError);
      await vi.advanceTimersByTimeAsync(100);
      await timedOut;
      release();
      await running;
      await expect(gate.run('b', async () => 'ok')).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AuthService API token creation', () => {
  it('requires a browser session and the current password', async () => {
    const { service, user, persistence } = await seededAuth('alice', 'correct-password');
    const jwtActor: Actor = { userId: user.id, role: Role.User, authKind: 'jwt', authVersion: 0 };

    await expect(service.createApiToken(
      { ...jwtActor, authKind: 'api-token' },
      'ci',
      'correct-password',
    )).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.createApiToken(jwtActor, 'ci', 'wrong-password'))
      .rejects.toMatchObject({ status: 403, response: { code: 'CURRENT_PASSWORD_INCORRECT' } });
    expect(persistence.apiTokenRows()).toHaveLength(0);

    const created = await service.createApiToken(jwtActor, 'ci', 'correct-password');
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(persistence.apiTokenRows()).toHaveLength(1);
  });

  it('does not insert a token when the password changed after it was verified', async () => {
    const { service, user, persistence } = await seededAuth('alice', 'correct-password');
    const actor: Actor = { userId: user.id, role: Role.User, authKind: 'jwt', authVersion: 0 };
    const findUserById = persistence.findUserById.bind(persistence);
    vi.spyOn(persistence, 'findUserById').mockImplementation(async (id) => {
      const snapshot = { ...(await findUserById(id))! };
      persistence.updateUser(id, { passwordHash: 'rotated', authVersion: 1 });
      return snapshot;
    });
    await expect(service.createApiToken(actor, 'ci', 'correct-password'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(persistence.apiTokenRows()).toHaveLength(0);
  });

  it('throttles wrong current-password entries per user', async () => {
    const { service, user } = await seededAuth('alice', 'correct-password');
    for (let i = 0; i < MAX_REAUTH_FAILURES_PER_USER; i += 1) {
      await expect(service.verifyCurrentPassword(user, 'wrong-password')).resolves.toBe(false);
    }
    await expect(service.verifyCurrentPassword(user, 'correct-password')).rejects.toThrow(rateLimited);
  });
});

function consume(service: AuthService, ip: string, username: string) {
  return (service as unknown as {
    consumeLoginAttempt: (bucket: string, username: string) => unknown;
  }).consumeLoginAttempt(clientAddressBucket(ip), username);
}

async function seededAuth(username: string, password: string) {
  const persistence = new InMemoryAuthPersistenceTestAdapter();
  const passwordHash = await createAuth().hashPassword(password);
  const user = persistence.seedUser({
    id: randomUUID(),
    username,
    passwordHash,
    status: UserStatus.Active,
  });
  return { service: createAuth({ persistence }), persistence, user };
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
