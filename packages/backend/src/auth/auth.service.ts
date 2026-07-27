import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  Inject,
  Optional,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { createHash, createHmac, randomBytes } from 'crypto';
import { AuditAction, UserStatus } from '@nyabase/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import type {
  AuthApiToken,
  AuthPersistence,
  AuthUser,
} from './auth-persistence.js';
import { isPgIamTransaction } from './auth-persistence.js';
import { IAM_AUTH_PERSISTENCE } from './auth.tokens.js';
import {
  RedisDisposableAdapter,
  type RateLimitReservation,
} from '../runtime/redis-disposable.adapter.js';
import { AuditService } from '../audit/audit.service.js';

export interface JwtPayload {
  sub: string;
  username: string;
  /** Monotonic browser-session generation. */
  ver: number;
  /** Added by JwtService; direct WebSocket consumers must enforce it too. */
  exp?: number;
}

export const MAX_REFRESH_SESSIONS_PER_USER = 16;
export const MAX_API_TOKENS_PER_USER = 64;
export const MAX_CONCURRENT_PASSWORD_VERIFICATIONS = 4;
export const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60_000;
export const MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL = 10;
export const MAX_LOGIN_ATTEMPTS_PER_IP = 50;
export const MAX_LOGIN_LIMITER_KEYS = 4_096;
export const AUTH_MONOTONIC_CLOCK = Symbol('AUTH_MONOTONIC_CLOCK');

const MAX_LOGIN_USERNAME_CHARS = 256;
const MAX_LOGIN_PASSWORD_CHARS = 1_024;
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$DCw8KRwf+V7pMnhiRFOb6g$KSjgFxwH2WqyoDT2q5Hz0Z18Zv/+eAHbnRgKiC6dI5A';

interface LoginAttemptEntry {
  count: number;
  windowStartedAt: number;
  lastSeenAt: number;
}

interface LocalLoginAttemptReservation {
  kind: 'local';
  key: string;
  entry: LoginAttemptEntry;
}

interface RedisLoginAttemptReservation {
  kind: 'redis';
  reservation: RateLimitReservation;
}

type LoginAttemptReservation =
  | LocalLoginAttemptReservation
  | RedisLoginAttemptReservation;

@Injectable()
export class AuthService {
  private activePasswordVerifications = 0;
  private readonly loginAttempts = new Map<string, LoginAttemptEntry>();

  constructor(
    @Inject(IAM_AUTH_PERSISTENCE)
    private readonly persistence: AuthPersistence,
    private jwtService: JwtService,
    private config: NyabaseConfigService,
    private readonly audit: AuditService,
    @Optional()
    private readonly redis?: RedisDisposableAdapter,
    @Optional()
    @Inject(AUTH_MONOTONIC_CLOCK)
    private readonly monotonicNow?: () => number,
  ) {}

  /**
   * Verify credentials without issuing a session. Missing and disabled users
   * take the same Argon2 path as a wrong password to avoid a username oracle.
   */
  async validateUser(username: string, password: string): Promise<AuthUser> {
    const user = username.length <= MAX_LOGIN_USERNAME_CHARS
      ? await this.persistence.findUserByUsername(username)
      : null;
    const candidateHash = user?.status === UserStatus.Active
      ? user.passwordHash
      : DUMMY_PASSWORD_HASH;
    const valid = password.length <= MAX_LOGIN_PASSWORD_CHARS
      && await this.verifyPasswordBounded(candidateHash, password);
    if (!valid || !user || user.status !== UserStatus.Active) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }

  /**
   * Authenticate and issue from one credential generation. Argon2 runs outside
   * the DB lease; the exact hash/version/status are rechecked inside it so an
   * old password cannot win a race with reset/disable.
   */
  async authenticateAndLogin(username: string, password: string, clientIp: string) {
    const reservations = await this.consumeLoginAttempt(clientIp, username);
    const snapshot = await this.validateUser(username, password);
    const issued = await this.issueRefreshSession(snapshot.id, {
      id: snapshot.id,
      passwordHash: snapshot.passwordHash,
      authVersion: snapshot.authVersion,
    });
    if (!issued) throw new UnauthorizedException('Invalid credentials');
    const result = {
      user: issued.user,
      accessToken: this.signAccessToken(issued.user),
      refreshToken: issued.refreshToken,
    };
    // The limiter reserves before the expensive credential path. A complete
    // success is not abuse, so release only this call's exact reservations.
    // Entry identity fences concurrent failures and a replacement time window:
    // neither may be decremented by an older successful call.
    await this.releaseSuccessfulLoginReservations(reservations);
    return result;
  }

  /** Internal/test login for an already authenticated durable user. */
  async login(user: Pick<AuthUser, 'id'>) {
    const issued = await this.issueRefreshSession(user.id);
    if (!issued) throw new UnauthorizedException('User not found or disabled');
    return {
      accessToken: this.signAccessToken(issued.user),
      refreshToken: issued.refreshToken,
    };
  }

  async refreshTokens(rawRefreshToken: string, requestId: string) {
    if (!/^[0-9a-f]{64}$/.test(requestId)) {
      throw new BadRequestException('requestId must be 64 lowercase hexadecimal characters');
    }
    const hash = this.tokenHash(rawRefreshToken);
    const requestIdHash = this.tokenHash(requestId);

    // The repository samples and applies `now` inside one PostgreSQL
    // transaction. A row lock makes rotation single-winner across processes.
    let successor = '';
    const result = await this.persistence.rotateRefreshSession({
      hash,
      requestIdHash,
      expiresInMs: this.refreshExpiryDurationMs(),
      maximumSessions: MAX_REFRESH_SESSIONS_PER_USER,
      successorHash: (sessionId) => {
        successor = this.deriveRotatedRefreshToken(sessionId, hash, requestId);
        return this.tokenHash(successor);
      },
    });
    if (result.kind === 'invalid') throw new UnauthorizedException('Invalid refresh token');
    if (result.kind === 'recovered') {
      successor = this.deriveRotatedRefreshToken(result.sessionId, hash, requestId);
    }
    return {
      accessToken: this.signAccessToken(result.user),
      refreshToken: successor,
    };
  }

  /**
   * Possession of a refresh secret is the authority to terminate that session.
   * The one-step predecessor resolves the same row so a logout replayed after
   * automatic rotation still deletes the current token.
   */
  async logout(rawRefreshToken: string): Promise<string | null> {
    const hash = this.tokenHash(rawRefreshToken);
    return this.persistence.deleteRefreshSessionByCurrentOrPreviousHash(
      hash,
      (transaction, userId) => this.audit.append(
        transaction,
        userId,
        AuditAction.UserLogout,
        userId,
        'user',
      ),
    );
  }

  async validateJwtPayload(payload: JwtPayload): Promise<AuthUser> {
    if (
      typeof payload.sub !== 'string'
      || payload.sub.length === 0
      || !Number.isInteger(payload.ver)
      || payload.ver < 0
    ) {
      throw new UnauthorizedException();
    }
    const user = await this.persistence.findUserById(payload.sub);
    if (
      !user
      || user.status !== UserStatus.Active
      || user.authVersion !== payload.ver
    ) {
      throw new UnauthorizedException();
    }
    return user;
  }

  /** Throttle window for lastUsedAt updates: skip writes within this interval. */
  private static readonly LAST_USED_UPDATE_INTERVAL_MS = 60_000;

  /** Validate an API token; returns user if valid. */
  async validateApiToken(rawToken: string): Promise<AuthUser | null> {
    const hash = this.tokenHash(rawToken);
    const now = new Date();
    return this.persistence.validateApiToken(
      hash,
      now,
      AuthService.LAST_USED_UPDATE_INTERVAL_MS,
    );
  }

  async createApiToken(userId: string, name: string) {
    const normalizedName = name.trim();
    if (normalizedName.length === 0 || normalizedName.length > 128) {
      throw new BadRequestException('API token name must contain 1-128 non-whitespace characters');
    }
    const raw = randomBytes(32).toString('hex');
    const entity: AuthApiToken = {
      id: uuidv4(),
      userId,
      name: normalizedName,
      hash: this.tokenHash(raw),
      createdAt: new Date(),
      lastUsedAt: null,
    };
    const created = await this.persistence.createApiToken(
      userId,
      entity,
      MAX_API_TOKENS_PER_USER,
      (transaction, token) => this.audit.append(
        transaction,
        userId,
        AuditAction.CreateApiToken,
        token.id,
        'api_token',
        { name: token.name },
      ),
    );
    if (created === 'inactive-user') {
      throw new UnauthorizedException('User not found or disabled');
    }
    if (created === 'capacity') {
      throw new ConflictException({
        code: 'API_TOKEN_CAPACITY_REACHED',
        message: `At most ${MAX_API_TOKENS_PER_USER} API tokens are supported per user`,
      });
    }
    return { entity, secret: raw };
  }

  async listApiTokens(userId: string) {
    return this.persistence.listApiTokens(userId);
  }

  async deleteApiToken(userId: string, tokenId: string) {
    const token = await this.persistence.deleteApiToken(
      userId,
      tokenId,
      (transaction, deleted) => this.audit.append(
        transaction,
        userId,
        AuditAction.DeleteApiToken,
        deleted.id,
        'api_token',
        { name: deleted.name },
      ),
    );
    if (!token) throw new NotFoundException('Token not found');
    return token;
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    return this.verifyPasswordBounded(hash, password);
  }

  async revokeBrowserSessionsInTransaction(manager: unknown, userId: string): Promise<void> {
    if (!isPgIamTransaction(manager)) {
      throw new Error('IAM credential deletion requires a PostgreSQL/Kysely transaction');
    }
    await this.persistence.revokeBrowserSessions(manager, userId);
  }

  async deleteUserCredentialsInTransaction(manager: unknown, userId: string): Promise<void> {
    if (!isPgIamTransaction(manager)) {
      throw new Error('IAM credential deletion requires a PostgreSQL/Kysely transaction');
    }
    await this.persistence.deleteUserCredentials(manager, userId);
  }

  private async issueRefreshSession(
    userId: string,
    credentialSnapshot?: {
      id: string;
      passwordHash: string;
      authVersion: number;
    },
  ): Promise<{ user: AuthUser; refreshToken: string } | null> {
    const rawRefresh = randomBytes(48).toString('hex');
    const user = await this.persistence.issueRefreshSession(userId, {
      id: uuidv4(),
      hash: this.tokenHash(rawRefresh),
      expiresInMs: this.refreshExpiryDurationMs(),
    }, MAX_REFRESH_SESSIONS_PER_USER, credentialSnapshot, (transaction, issuedUser) =>
      this.audit.append(
        transaction,
        issuedUser.id,
        AuditAction.UserLogin,
        issuedUser.id,
        'user',
      ));
    return user ? { user, refreshToken: rawRefresh } : null;
  }

  private signAccessToken(user: AuthUser): string {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      ver: user.authVersion,
    };
    return this.jwtService.sign(payload);
  }

  private refreshExpiryDurationMs(): number {
    return this.config.get<number>('auth.refreshTokenExpiresDays') * 86_400_000;
  }

  private tokenHash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private deriveRotatedRefreshToken(
    sessionId: string,
    previousHash: string,
    requestId: string,
  ): string {
    return createHmac('sha384', this.config.get<string>('auth.jwtSecret'))
      .update('nyabase-refresh-rotation-v1\0')
      .update(sessionId)
      .update('\0')
      .update(previousHash)
      .update('\0')
      .update(requestId)
      .digest('hex');
  }

  private async verifyPasswordBounded(hash: string, password: string): Promise<boolean> {
    if (this.activePasswordVerifications >= MAX_CONCURRENT_PASSWORD_VERIFICATIONS) {
      throw this.tooManyRequests('Password verification capacity is temporarily exhausted');
    }
    this.activePasswordVerifications += 1;
    try {
      return await argon2.verify(hash, password);
    } finally {
      this.activePasswordVerifications -= 1;
    }
  }

  private async consumeLoginAttempt(
    clientIp: string,
    username: string,
  ): Promise<LoginAttemptReservation[]> {
    const now = this.localLimiterNow();
    this.pruneLoginAttempts(now);
    const normalizedIp = clientIp.trim() || 'unknown';
    const normalizedUsername = username.trim().toLowerCase().slice(0, MAX_LOGIN_USERNAME_CHARS);
    const attempts = [
      {
        localKey: `ip:${normalizedIp}`,
        remoteScope: this.loginLimitScope('ip', normalizedIp),
        limit: MAX_LOGIN_ATTEMPTS_PER_IP,
      },
      {
        localKey: `principal:${normalizedUsername}`,
        remoteScope: this.loginLimitScope('principal', normalizedUsername),
        limit: MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL,
      },
    ];
    const reservations: LoginAttemptReservation[] = [];
    let redisAvailable = Boolean(this.redis);
    for (const attempt of attempts) {
      const existing = this.loginAttempts.get(attempt.localKey);
      const entry = !existing || now - existing.windowStartedAt >= LOGIN_ATTEMPT_WINDOW_MS
        ? { count: 0, windowStartedAt: now, lastSeenAt: now }
        : existing;
      if (!existing && this.loginAttempts.size >= MAX_LOGIN_LIMITER_KEYS) {
        throw this.tooManyRequests(
          'Login limiter capacity is temporarily exhausted',
        );
      }
      if (entry.count >= attempt.limit) {
        throw this.tooManyRequests('Too many login attempts');
      }
      // Every attempt consumes the process-local defense first, including a
      // request rejected by the shared Redis bucket. If Redis is then lost,
      // this process cannot grant a fresh local window.
      entry.count += 1;
      entry.lastSeenAt = now;
      this.loginAttempts.delete(attempt.localKey);
      this.loginAttempts.set(attempt.localKey, entry);
      reservations.push({ kind: 'local', key: attempt.localKey, entry });

      if (redisAvailable && this.redis) {
        const result = await this.redis.consumeRateLimit(
          attempt.remoteScope,
          attempt.limit,
          LOGIN_ATTEMPT_WINDOW_MS,
        );
        if (result.available) {
          if (!result.allowed) {
            throw this.tooManyRequests('Too many login attempts');
          }
          if (result.reservation) {
            reservations.push({
              kind: 'redis',
              reservation: result.reservation,
            });
          }
        }
        if (!result.available) {
          // Once unavailable, keep the remaining shared decisions local for
          // this request. Every attempt is charged locally even while Redis is
          // healthy so an eviction/restart/outage cannot reset this process's
          // live defense-in-depth window.
          redisAvailable = false;
        }
      }
    }
    return reservations;
  }

  private async releaseSuccessfulLoginReservations(
    reservations: readonly LoginAttemptReservation[],
  ): Promise<void> {
    const remoteReleases: Promise<boolean>[] = [];
    for (const reservation of reservations) {
      if (reservation.kind === 'redis') {
        if (this.redis) {
          remoteReleases.push(
            this.redis.releaseRateLimit(reservation.reservation),
          );
        }
        continue;
      }
      const { key, entry } = reservation;
      if (this.loginAttempts.get(key) !== entry) continue;
      if (entry.count <= 0) continue;
      entry.count -= 1;
      if (entry.count === 0 && this.loginAttempts.get(key) === entry) {
        this.loginAttempts.delete(key);
      }
    }
    await Promise.all(remoteReleases);
  }

  private loginLimitScope(kind: 'ip' | 'principal', value: string): string {
    const identity = createHmac(
      'sha256',
      this.config.get<string>('auth.jwtSecret'),
    )
      .update('nyabase-login-limit-v1\0')
      .update(kind)
      .update('\0')
      .update(value)
      .digest('hex');
    return `login:${kind}:${identity}`;
  }

  private pruneLoginAttempts(now: number): void {
    for (const [key, entry] of this.loginAttempts) {
      if (now - entry.windowStartedAt >= LOGIN_ATTEMPT_WINDOW_MS) {
        this.loginAttempts.delete(key);
      }
    }
  }

  private localLimiterNow(): number {
    return this.monotonicNow?.() ?? performance.now();
  }

  private tooManyRequests(message: string): HttpException {
    return new HttpException({ code: 'AUTH_RATE_LIMITED', message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
