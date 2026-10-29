import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AuditAction, UserStatus } from '@nyabase/common';
import {
  AuthService,
  MAX_LOGIN_FAILURES_PER_IP,
  MAX_LOGIN_FAILURES_PER_IP_USERNAME,
  MAX_REAUTH_FAILURES_PER_USER,
  REFRESH_ANCESTOR_WINDOW_LIFETIME_CAP_MS,
  REFRESH_ANCESTOR_WINDOW_SLACK_MS,
  REFRESH_RETAINED_ANCESTORS,
  REFRESH_REUSE_GRACE_MS,
  refreshAncestorMinimumAgeMs,
  RefreshSupersededException,
  RefreshThrottledException,
} from './auth.service.js';
import { accessJwtOptions } from './iam.module.js';
import { InMemoryAuthPersistenceTestAdapter } from './in-memory-auth-persistence.test-helper.js';
import { SessionRevocationService } from './session-revocation.service.js';
import {
  clientAddressBucket,
  LOGIN_ATTEMPT_WINDOW_MS,
  LoginAttemptLimiter,
  PasswordVerificationBusyError,
  PasswordVerificationGate,
} from './login-throttling.js';

const rateLimited = expect.objectContaining({
  status: HttpStatus.TOO_MANY_REQUESTS,
  response: expect.objectContaining({ code: 'AUTH_RATE_LIMITED' }),
});

describe('refresh ancestor protection window', () => {
  it('covers one access-token lifetime (at most an hour) plus the refresh lag', () => {
    expect(REFRESH_ANCESTOR_WINDOW_SLACK_MS).toBe(2 * 60_000);
    expect(refreshAncestorMinimumAgeMs(60_000)).toBe(3 * 60_000);
    expect(refreshAncestorMinimumAgeMs(15 * 60_000)).toBe(17 * 60_000);
    expect(refreshAncestorMinimumAgeMs(60 * 60_000)).toBe(62 * 60_000);
    // Capped at one hour: a 24 h lifetime must not throttle a session for a day.
    expect(REFRESH_ANCESTOR_WINDOW_LIFETIME_CAP_MS).toBe(60 * 60_000);
    expect(refreshAncestorMinimumAgeMs(2 * 3_600_000)).toBe(62 * 60_000);
    expect(refreshAncestorMinimumAgeMs(24 * 3_600_000)).toBe(62 * 60_000);
    // Never below the 1-minute minimum lifetime, even if misconfigured.
    expect(refreshAncestorMinimumAgeMs(1_000)).toBe(3 * 60_000);
  });

  it('rounds Retry-After up to whole seconds, at least one', () => {
    expect(new RefreshThrottledException(41_200).retryAfterSeconds).toBe(42);
    expect(new RefreshThrottledException(1).retryAfterSeconds).toBe(1);
  });

  it('refuses to refresh with an unparseable access-token lifetime', async () => {
    const persistence = new InMemoryAuthPersistenceTestAdapter();
    const service = createAuth({ persistence, jwtExpiresIn: '15 minutes' });
    const user = persistence.seedUser({ id: randomUUID(), username: 'alice' });
    const { refreshToken } = await service.login(user);
    await expect(service.refreshTokens(refreshToken, 'a'.repeat(64)))
      .rejects.toThrow('Invalid auth.jwtExpiresIn');
  });
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

  it('buckets IPv6 clients by /48 and IPv4-mapped clients by IPv4 address', () => {
    expect(clientAddressBucket('2001:db8:1:2::1')).toBe(clientAddressBucket('2001:db8:1:2:ffff::9'));
    expect(clientAddressBucket('2001:db8:1:2::1')).toBe(clientAddressBucket('2001:db8:1:3::1'));
    expect(clientAddressBucket('2001:db8:1:2::1')).not.toBe(clientAddressBucket('2001:db8:2:2::1'));
    expect(clientAddressBucket('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(clientAddressBucket('192.0.2.1')).toBe('192.0.2.1');
    expect(clientAddressBucket('not-an-ip')).toBe('unknown');
    expect(clientAddressBucket('2001:db8:1:2::1')).toBe('2001:db8:1::/48');

    const service = createAuth();
    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_IP_USERNAME; i += 1) {
      consume(service, `2001:db8:1:2::${(i + 1).toString(16)}`, 'admin');
    }
    expect(() => consume(service, '2001:db8:1:2::ffff', 'admin')).toThrow(rateLimited);
    expect(() => consume(service, '2001:db8:1:3::1', 'admin')).toThrow(rateLimited);
    expect(() => consume(service, '2001:db8:2::1', 'admin')).not.toThrow();
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

describe('AuthService re-authentication', () => {
  it('keeps signed-in password checks available while logins saturate their gate', async () => {
    const { service, user } = await seededAuth('alice', 'correct-password');
    const loginGate = (service as unknown as { loginGate: PasswordVerificationGate }).loginGate;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blockers = Array.from({ length: 4 }, (_, index) =>
      loginGate.run(`ip:flood-${index}`, () => held));
    await expect(service.verifyCurrentPassword(user, 'correct-password')).resolves.toBe(true);
    release();
    await Promise.all(blockers);
  });

  it('throttles wrong current-password entries per user', async () => {
    const { service, user } = await seededAuth('alice', 'correct-password');
    for (let i = 0; i < MAX_REAUTH_FAILURES_PER_USER; i += 1) {
      await expect(service.verifyCurrentPassword(user, 'wrong-password')).resolves.toBe(false);
    }
    await expect(service.verifyCurrentPassword(user, 'correct-password')).rejects.toThrow(rateLimited);
  });
});

const DAY = 86_400_000;
const requestId = (digit: string) => digit.repeat(64);

describe('AuthService refresh sessions', () => {
  async function signedIn(jwtExpiresIn?: string) {
    const persistence = new InMemoryAuthPersistenceTestAdapter();
    let now = Date.parse('2026-01-01T00:00:00Z');
    persistence.now = () => new Date(now);
    const auditLog = audit();
    const service = createAuth({ persistence, audit: auditLog, jwtExpiresIn });
    const user = persistence.seedUser({ id: randomUUID(), username: 'alice' });
    const { refreshToken } = await service.login(user);
    return {
      service,
      persistence,
      auditLog,
      user,
      first: refreshToken,
      advance: (ms: number) => { now += ms; },
    };
  }

  it('slides the idle expiry on refresh but never past the absolute lifetime', async () => {
    const { service, persistence, first, advance } = await signedIn();
    expect(service.refreshCookieMaxAgeMs()).toBe(7 * DAY);

    let token = first;
    // Refresh every six days: always inside the 7-day idle window.
    for (let index = 1; index <= 3; index += 1) {
      advance(6 * DAY);
      const rotated = await service.refreshTokens(token, requestId(String(index)));
      expect(rotated.cookieMaxAgeMs).toBe(7 * DAY);
      token = rotated.refreshToken;
    }
    // Day 24 + 7 would overshoot the absolute end at day 30.
    advance(6 * DAY);
    const capped = await service.refreshTokens(token, requestId('4'));
    expect(capped.cookieMaxAgeMs).toBe(6 * DAY);
    expect(persistence.refreshRows()[0]?.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    // Still active (refreshed six days ago), but the session is 30 days old.
    advance(6 * DAY);
    await expect(service.refreshTokens(capped.refreshToken, requestId('5')))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(persistence.refreshRows()).toHaveLength(0);
  });

  it('returns the same successor for the exact retry of a lost response', async () => {
    const { service, first, advance } = await signedIn();
    const rotated = await service.refreshTokens(first, requestId('a'));
    advance(10 * 60_000);
    const retried = await service.refreshTokens(first, requestId('a'));
    expect(retried.refreshToken).toBe(rotated.refreshToken);
  });

  it('refuses the loser of a concurrent rotation without revoking the session', async () => {
    const { service, auditLog, first } = await signedIn();
    const winner = await service.refreshTokens(first, requestId('a'));
    const loser = service.refreshTokens(first, requestId('b'));
    await expect(loser).rejects.toBeInstanceOf(RefreshSupersededException);
    await expect(loser).rejects.toMatchObject({ response: { code: 'REFRESH_SUPERSEDED' } });
    await expect(service.refreshTokens(winner.refreshToken, requestId('c')))
      .resolves.toMatchObject({ refreshToken: expect.any(String) });
    expect(auditLog.append).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), AuditAction.RefreshTokenReuse, expect.anything(),
      expect.anything(), expect.anything(),
    );
  });

  it('revokes the session and audits when a rotated-out token comes back', async () => {
    const { service, persistence, auditLog, user, first, advance } = await signedIn();
    const second = await service.refreshTokens(first, requestId('a'));
    const third = await service.refreshTokens(second.refreshToken, requestId('b'));
    const sessionId = persistence.refreshRows()[0]!.id;

    // Past the grace window, the immediately previous token is reuse too.
    advance(REFRESH_REUSE_GRACE_MS);
    const replay = service.refreshTokens(second.refreshToken, requestId('c'));
    await expect(replay).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(replay).rejects.not.toBeInstanceOf(RefreshSupersededException);
    expect(auditLog.append).toHaveBeenCalledWith(
      undefined,
      null,
      AuditAction.RefreshTokenReuse,
      user.id,
      'user',
      { sessionId },
    );
    expect(persistence.refreshRows()).toHaveLength(0);
    await expect(service.refreshTokens(third.refreshToken, requestId('d')))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('caps rotations per window with 429 so recent ancestors cannot be flushed out', async () => {
    const { service, persistence, first, advance } = await signedIn();
    let token = first;
    for (let index = 0; index < REFRESH_RETAINED_ANCESTORS; index += 1) {
      token = (await service.refreshTokens(token, index.toString(16).padStart(64, '0'))).refreshToken;
    }
    expect(persistence.refreshRows()[0]!.ancestors.size).toBe(REFRESH_RETAINED_ANCESTORS);
    await expect(service.refreshTokens(token, requestId('e'))).rejects.toEqual(rateLimited);
    // The very first token is still remembered: replaying it is reuse.
    advance(REFRESH_REUSE_GRACE_MS);
    await expect(service.refreshTokens(first, requestId('f')))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(persistence.refreshRows()).toHaveLength(0);
  });

  it('ties the throttle window to the access-token lifetime', async () => {
    const { service, first, advance } = await signedIn('1m');
    const windowMs = 60_000 + REFRESH_ANCESTOR_WINDOW_SLACK_MS;
    let token = first;
    for (let index = 0; index < REFRESH_RETAINED_ANCESTORS; index += 1) {
      advance(500);
      token = (await service.refreshTokens(token, index.toString(16).padStart(64, '0'))).refreshToken;
    }
    // The oldest retained ancestor was retired 127.5 s ago.
    const throttled = service.refreshTokens(token, requestId('e'));
    await expect(throttled).rejects.toBeInstanceOf(RefreshThrottledException);
    await expect(throttled).rejects.toMatchObject({
      retryAfterSeconds: Math.ceil((windowMs - (REFRESH_RETAINED_ANCESTORS - 1) * 500) / 1_000),
    });
    // A 1-minute lifetime frees the slot after 3 minutes, not a fixed 15.
    advance(windowMs - (REFRESH_RETAINED_ANCESTORS - 1) * 500);
    await expect(service.refreshTokens(token, requestId('e')))
      .resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  it('caps the throttle window at one hour (+ slack) for a long access-token lifetime', async () => {
    const { service, first, advance } = await signedIn('24h');
    const windowMs = 60 * 60_000 + REFRESH_ANCESTOR_WINDOW_SLACK_MS;
    let token = first;
    for (let index = 0; index < REFRESH_RETAINED_ANCESTORS; index += 1) {
      advance(1_000);
      token = (await service.refreshTokens(token, index.toString(16).padStart(64, '0'))).refreshToken;
    }
    const throttled = service.refreshTokens(token, requestId('e'));
    await expect(throttled).rejects.toMatchObject({
      retryAfterSeconds: Math.ceil((windowMs - (REFRESH_RETAINED_ANCESTORS - 1) * 1_000) / 1_000),
    });
    // The slot frees within the hour, not a day later.
    advance(windowMs - (REFRESH_RETAINED_ANCESTORS - 1) * 1_000);
    await expect(service.refreshTokens(token, requestId('e')))
      .resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  it('forgets ancestors beyond the window: an old token is invalid without revoking', async () => {
    const { service, persistence, auditLog, first, advance } = await signedIn();
    let token = first;
    for (let index = 0; index <= REFRESH_RETAINED_ANCESTORS; index += 1) {
      advance(refreshAncestorMinimumAgeMs(15 * 60_000));
      token = (await service.refreshTokens(token, index.toString(16).padStart(64, '0'))).refreshToken;
    }
    expect(persistence.refreshRows()[0]!.ancestors.size).toBe(REFRESH_RETAINED_ANCESTORS);
    await expect(service.refreshTokens(first, requestId('e')))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(persistence.refreshRows()).toHaveLength(1);
    expect(auditLog.append).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), AuditAction.RefreshTokenReuse, expect.anything(),
      expect.anything(), expect.anything(),
    );
    await expect(service.refreshTokens(token, requestId('f')))
      .resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  it('logs out the session from any retained ancestor token', async () => {
    const { service, persistence, user, first } = await signedIn();
    const second = await service.refreshTokens(first, requestId('a'));
    await service.refreshTokens(second.refreshToken, requestId('b'));
    await expect(service.logout(first)).resolves.toBe(user.id);
    expect(persistence.refreshRows()).toHaveLength(0);
  });
});

describe('AuthService browser-session binding', () => {
  const secret = 'test-jwt-secret-test-jwt-secret-32ch';

  async function boundSession() {
    const persistence = new InMemoryAuthPersistenceTestAdapter();
    const revocations = new SessionRevocationService();
    const ended: Array<[string, string | undefined]> = [];
    revocations.subscribe((userId, sessionId) => ended.push([userId, sessionId]));
    const service = createAuth({
      persistence,
      revocations,
      jwtService: new JwtService({ secret, signOptions: { expiresIn: '15m' } }),
    });
    const user = persistence.seedUser({ id: randomUUID(), username: 'alice' });
    const login = await service.login(user);
    const sessionId = persistence.refreshRows()[0]!.id;
    return { service, persistence, revocations, ended, user, login, sessionId };
  }

  it('names the refresh session in every access token it issues', async () => {
    const { service, login, sessionId, user } = await boundSession();
    const first = await service.validateAccessToken(login.accessToken);
    expect(first).toMatchObject({ user: { id: user.id }, sessionId });
    expect(first.expiresAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    const rotated = await service.refreshTokens(login.refreshToken, requestId('a'));
    await expect(service.validateAccessToken(rotated.accessToken))
      .resolves.toMatchObject({ sessionId });
  });

  it('rejects an access token that names no browser session', async () => {
    const { service, user } = await boundSession();
    await expect(service.validateJwtPayload({ sub: user.id, username: 'alice', ver: 0 } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    const unbound = new JwtService({ secret }).sign({ sub: user.id, username: 'alice', ver: 0 });
    await expect(service.validateAccessToken(unbound)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('bounds a long-lived connection by the token and the session, and ends it on logout', async () => {
    const { service, persistence, ended, user, login, sessionId } = await boundSession();
    const credential = await service.validateAccessToken(login.accessToken);
    await expect(service.browserSessionDeadline(credential))
      .resolves.toEqual({ at: credential.expiresAt, renewable: true });

    // An idle expiry before the token's own expiry wins.
    const idleEnd = new Date(Date.now() + 60_000);
    persistence.updateRefreshByHash(persistence.refreshRows()[0]!.hash, { expiresAt: idleEnd });
    await expect(service.browserSessionDeadline(credential))
      .resolves.toEqual({ at: idleEnd, renewable: true });
    // So does the absolute end (login + 30 days).
    persistence.updateRefreshByHash(persistence.refreshRows()[0]!.hash, {
      expiresAt: new Date(Date.now() + DAY),
      createdAt: new Date(Date.now() - 30 * DAY + 30_000),
    });
    // ... and no fresh token can move it.
    const absolute = await service.browserSessionDeadline(credential);
    expect(absolute!.at.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(absolute!.renewable).toBe(false);

    await expect(service.logout(login.refreshToken)).resolves.toBe(user.id);
    expect(ended).toEqual([[user.id, sessionId]]);
    await expect(service.browserSessionDeadline(credential)).resolves.toBeNull();
  });

  it('stops accepting a session\'s access tokens once the session ends', async () => {
    const { service, login } = await boundSession();
    await expect(service.validateAccessToken(login.accessToken)).resolves.toBeDefined();
    await service.logout(login.refreshToken);
    await expect(service.validateAccessToken(login.accessToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('verifies access tokens as HS256 only', async () => {
    const options = accessJwtOptions({ get: ((key: string) => (key === 'auth.jwtSecret' ? secret : '15m')) as never });
    const { persistence, user, sessionId } = await boundSession();
    const pinned = createAuth({ persistence, jwtService: new JwtService(options) });
    const claims = { sub: user.id, username: 'alice', ver: 0, sid: sessionId };
    await expect(pinned.validateAccessToken(new JwtService(options).sign(claims))).resolves.toBeDefined();
    const hs512 = new JwtService({ secret }).sign(claims, { algorithm: 'HS512', expiresIn: '15m' });
    await expect(pinned.validateAccessToken(hs512)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token of another session of the same user', async () => {
    const { service, user, login } = await boundSession();
    const other = await service.login(user);
    const credential = await service.validateAccessToken(other.accessToken);
    await service.logout(login.refreshToken);
    await expect(service.browserSessionDeadline(credential)).resolves.not.toBeNull();
    await expect(service.browserSessionDeadline({ ...credential, sessionId: randomUUID() }))
      .resolves.toBeNull();
  });

  it('ends the session for long-lived connections when a refresh token is reused', async () => {
    const { service, ended, user, login, sessionId } = await boundSession();
    const rotated = await service.refreshTokens(login.refreshToken, requestId('a'));
    await service.refreshTokens(rotated.refreshToken, requestId('b'));
    await expect(service.refreshTokens(login.refreshToken, requestId('c')))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(ended).toEqual([[user.id, sessionId]]);
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
  audit?: ReturnType<typeof audit>;
  jwtExpiresIn?: string;
  revocations?: SessionRevocationService;
  jwtService?: JwtService;
} = {}) {
  return new AuthService(
    (options.persistence ?? new InMemoryAuthPersistenceTestAdapter()) as never,
    options.jwtService ?? jwt(),
    config(options.jwtExpiresIn),
    (options.audit ?? audit()) as never,
    { now: options.monotonicNow ?? (() => performance.now()) } as never,
    options.revocations ?? new SessionRevocationService(),
  );
}

function jwt() {
  return {
    sign: () => 'access-token',
    verifyAsync: vi.fn(),
  } as never;
}

function config(jwtExpiresIn = '15m') {
  return {
    get: (key: string) => {
      if (key === 'auth.jwtSecret') return 'test-jwt-secret-test-jwt-secret-32ch';
      if (key === 'auth.refreshTokenExpiresDays') return 7;
      if (key === 'auth.sessionMaxLifetimeDays') return 30;
      if (key === 'auth.jwtExpiresIn') return jwtExpiresIn;
      return undefined;
    },
  } as never;
}

function audit() {
  return { append: vi.fn().mockResolvedValue(undefined) };
}
