import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { createHash, createHmac, randomBytes } from 'crypto';
import {
  AuditAction,
  FailureCode,
  jwtLifetimeMs,
  MIN_JWT_LIFETIME_MS,
  UserStatus,
} from '@nyabase/common';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { type AuthUser, isPgIamTransaction } from './auth-persistence.js';
import { IamAuthRepository } from './iam-auth.repository.js';
import { MonotonicClock } from '../platform/monotonic-clock.js';
import { AuditService } from './audit.service.js';
import { SessionRevocationService } from './session-revocation.service.js';
import {
  clientAddressBucket,
  LoginAttemptLimiter,
  PasswordVerificationBusyError,
  PasswordVerificationGate,
  type LoginAttemptReservation,
} from './login-throttling.js';

export interface JwtPayload {
  sub: string;
  username: string;
  /** Monotonic browser-session generation. */
  ver: number;
  /** The refresh session (`iam.refresh_tokens.id`) this token was issued from. */
  sid: string;
  /** Added by JwtService; direct WebSocket consumers must enforce it too. */
  exp?: number;
}

/**
 * A verified access token: the user (re-read now), the browser session it was
 * issued from and when the token itself expires.
 */
export interface AccessCredential {
  user: AuthUser;
  sessionId: string;
  expiresAt: Date;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_REFRESH_SESSIONS_PER_USER = 16;
/**
 * Tabs share the refresh cookie and serialize rotation with a Web Lock, so a
 * retired token normally never comes back except as the exact retry of a lost
 * response (same request id, recovered idempotently). Without Web Locks two
 * tabs can race one rotation with different request ids; the loser presenting
 * the immediately previous token this soon after the rotation is refused
 * without revoking the session. Any other retired token is reuse.
 */
export const REFRESH_REUSE_GRACE_MS = 15_000;
/**
 * Retired refresh hashes remembered per session, and the most rotations a
 * session may make per protection window (below). A tab rotates once per
 * access-token lifetime while it makes requests, plus once per page load or
 * new tab, so a window of one lifetime (at most an hour) plus slack sees roughly
 * tabs + page loads + (tabs x 2 min / lifetime) rotations: 60 tabs opened at
 * once, or 60 tabs polling at the 1-minute minimum lifetime (~180), stay
 * well below 256. Storage stays bounded at 256 rows per session (x16
 * sessions per user, ~1 MB per user at worst) however long a session lives.
 */
export const REFRESH_RETAINED_ANCESTORS = 256;
/**
 * Lag between an active tab's access token expiring and its next refresh:
 * the next authenticated request (polls run every 5-30 s), network latency
 * and clock skew between the browser's request and the JWT expiry check.
 */
export const REFRESH_ANCESTOR_WINDOW_SLACK_MS = 2 * 60_000;

/**
 * Longest access-token lifetime the protection window follows. Every page
 * load or new tab rotates, so with a long lifetime 256 rotations per window
 * is ordinary use and a throttled session would be locked out for hours.
 */
export const REFRESH_ANCESTOR_WINDOW_LIFETIME_CAP_MS = 60 * 60_000;

/**
 * A session may not forget a hash retired less than this long ago; a rotation
 * that would is refused with 429 (at most REFRESH_RETAINED_ANCESTORS per
 * window). The guarantee: a tab that is making requests refreshes within one
 * access-token lifetime (+ slack) of the rotation that issued the cookie it
 * holds, so if a thief rotates that cookie first, the victim's next refresh
 * presents a hash retired less than a window ago, which is still remembered
 * and revokes the session. Longer windows only add throttling, so the window
 * is min(`auth.jwtExpiresIn`, REFRESH_ANCESTOR_WINDOW_LIFETIME_CAP_MS) + slack
 * (at most 62 minutes). Reuse detection is therefore guaranteed for
 * lifetimes up to the 60-minute cap. With a longer lifetime it is best
 * effort: a hash is still only forgotten once REFRESH_RETAINED_ANCESTORS newer
 * ones exist, so a victim tab whose next refresh comes after the thief
 * rotated 256 more times over more than a window is merely signed out
 * (invalid token) instead of revoking the session.
 */
export function refreshAncestorMinimumAgeMs(accessTokenLifetimeMs: number): number {
  const lifetimeMs = Math.min(
    Math.max(accessTokenLifetimeMs, MIN_JWT_LIFETIME_MS),
    REFRESH_ANCESTOR_WINDOW_LIFETIME_CAP_MS,
  );
  return lifetimeMs + REFRESH_ANCESTOR_WINDOW_SLACK_MS;
}
/** Failed logins per (client address bucket, username) per window. */
export const MAX_LOGIN_FAILURES_PER_IP_USERNAME = 10;
/** Failed logins per client address bucket (any usernames) per window. */
export const MAX_LOGIN_FAILURES_PER_IP = 30;
/** Wrong current-password entries per signed-in user per window. */
export const MAX_REAUTH_FAILURES_PER_USER = 10;

/**
 * A signed-in user typed the wrong current password. Not a 401: the session is
 * fine, and a 401 would make the browser client refresh and resend the request.
 */
export function currentPasswordIncorrect(): ForbiddenException {
  return new ForbiddenException({
    code: FailureCode.CurrentPasswordIncorrect,
    message: 'Current password is incorrect',
  });
}

/**
 * The just-retired token lost a concurrent rotation. The shared cookie may
 * already hold the winner's successor, so the response must not clear it.
 */
export class RefreshSupersededException extends UnauthorizedException {
  constructor() {
    super({ code: 'REFRESH_SUPERSEDED', message: 'Refresh token was already rotated' });
  }
}

/**
 * The session rotated REFRESH_RETAINED_ANCESTORS times within one protection
 * window. Not a 401: the session is intact and the cookie must be kept. The
 * controller turns `retryAfterSeconds` into a Retry-After header.
 */
export class RefreshThrottledException extends HttpException {
  readonly retryAfterSeconds: number;

  constructor(retryAfterMs: number) {
    super(
      { code: 'AUTH_RATE_LIMITED', message: 'Too many session refreshes' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  }
}

const MAX_LOGIN_USERNAME_CHARS = 256;
const MAX_LOGIN_PASSWORD_CHARS = 1_024;
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$DCw8KRwf+V7pMnhiRFOb6g$KSjgFxwH2WqyoDT2q5Hz0Z18Zv/+eAHbnRgKiC6dI5A';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // Anonymous logins and signed-in password re-checks get separate Argon2
  // capacity, so a login flood cannot block password changes or API tokens.
  private readonly loginGate = new PasswordVerificationGate();
  private readonly reauthGate = new PasswordVerificationGate();
  private readonly loginAttempts: LoginAttemptLimiter;

  constructor(
    private readonly persistence: IamAuthRepository,
    private jwtService: JwtService,
    private config: NyabaseConfigService,
    private readonly audit: AuditService,
    private readonly clock: MonotonicClock,
    private readonly sessionRevocations: SessionRevocationService,
  ) {
    this.loginAttempts = new LoginAttemptLimiter(() => this.clock.now());
  }

  /**
   * Verify credentials without issuing a session. Missing and disabled users
   * take the same Argon2 path as a wrong password to avoid a username oracle.
   * `holder` is the client address bucket that the Argon2 gate accounts to.
   */
  async validateUser(username: string, password: string, holder = 'internal'): Promise<AuthUser> {
    const user = username.length <= MAX_LOGIN_USERNAME_CHARS
      ? await this.persistence.findUserByUsername(username)
      : null;
    const candidateHash = user?.status === UserStatus.Active
      ? user.passwordHash
      : DUMMY_PASSWORD_HASH;
    const valid = password.length <= MAX_LOGIN_PASSWORD_CHARS
      && await this.verifyPasswordBounded(this.loginGate, holder, candidateHash, password);
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
    const bucket = clientAddressBucket(clientIp);
    const reservations = this.consumeLoginAttempt(bucket, username);
    let snapshot: AuthUser;
    try {
      snapshot = await this.validateUser(username, password, `ip:${clientAddressBucket(clientIp, 48)}`);
    } catch (error) {
      // A busy Argon2 gate is not a failed guess.
      if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        this.loginAttempts.release(reservations);
      }
      throw error;
    }
    const issued = await this.issueRefreshSession(snapshot.id, {
      id: snapshot.id,
      passwordHash: snapshot.passwordHash,
      authVersion: snapshot.authVersion,
    });
    if (!issued) throw new UnauthorizedException('Invalid credentials');
    const result = {
      user: issued.user,
      accessToken: this.signAccessToken(issued.user, issued.sessionId),
      refreshToken: issued.refreshToken,
    };
    // The limiter reserves before the expensive credential path. A complete
    // success is not abuse, so release only this call's exact reservations.
    // Entry identity fences concurrent failures and a replacement time window:
    // neither may be decremented by an older successful call.
    this.loginAttempts.release(reservations);
    return result;
  }

  /** Internal/test login for an already authenticated durable user. */
  async login(user: Pick<AuthUser, 'id'>) {
    const issued = await this.issueRefreshSession(user.id);
    if (!issued) throw new UnauthorizedException('User not found or disabled');
    return {
      accessToken: this.signAccessToken(issued.user, issued.sessionId),
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
      ...this.sessionLifetimeMs(),
      reuseGraceMs: REFRESH_REUSE_GRACE_MS,
      retainedAncestors: REFRESH_RETAINED_ANCESTORS,
      ancestorMinimumAgeMs: this.refreshAncestorWindowMs(),
      maximumSessions: MAX_REFRESH_SESSIONS_PER_USER,
      successorHash: (sessionId) => {
        successor = this.deriveRotatedRefreshToken(sessionId, hash, requestId);
        return this.tokenHash(successor);
      },
      // The presenter may be the thief or the victim; attribute it to the system.
      onReuse: (transaction, reuse) => this.audit.append(
        transaction,
        null,
        AuditAction.RefreshTokenReuse,
        reuse.userId,
        'user',
        { sessionId: reuse.sessionId },
      ),
    });
    if (result.kind === 'superseded') throw new RefreshSupersededException();
    // Not a 401: the session is intact and the cookie must be kept.
    if (result.kind === 'throttled') throw new RefreshThrottledException(result.retryAfterMs);
    if (result.kind === 'reused') {
      this.sessionRevocations.endSession(result.userId, result.sessionId);
      this.logger.warn(
        `Refresh token reuse: revoked session ${result.sessionId} of user ${result.userId}`,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (result.kind === 'invalid') throw new UnauthorizedException('Invalid refresh token');
    if (result.kind === 'recovered') {
      successor = this.deriveRotatedRefreshToken(result.sessionId, hash, requestId);
    }
    return {
      accessToken: this.signAccessToken(result.user, result.sessionId),
      refreshToken: successor,
      user: result.user,
      // What is left of this session; never past its absolute lifetime.
      cookieMaxAgeMs: result.expiresInMs,
    };
  }

  /** Cookie lifetime of a fresh login: the first expiry of a new session. */
  refreshCookieMaxAgeMs(): number {
    const { idleMs, absoluteMs } = this.sessionLifetimeMs();
    return Math.min(idleMs, absoluteMs);
  }

  /**
   * Possession of a refresh secret is the authority to terminate that session.
   * A retained ancestor resolves the same row, so a logout from a tab whose
   * cookie read predates later rotations still deletes the current token.
   * Connections authorized by the session (consoles) close once it committed.
   */
  async logout(rawRefreshToken: string): Promise<string | null> {
    const hash = this.tokenHash(rawRefreshToken);
    const ended = await this.persistence.deleteRefreshSessionByCurrentOrRetiredHash(
      hash,
      (transaction, userId) => this.audit.append(
        transaction,
        userId,
        AuditAction.UserLogout,
        userId,
        'user',
      ),
    );
    if (!ended) return null;
    this.sessionRevocations.endSession(ended.userId, ended.sessionId);
    return ended.userId;
  }

  async validateJwtPayload(payload: JwtPayload): Promise<AuthUser> {
    if (
      typeof payload.sub !== 'string'
      || payload.sub.length === 0
      || !Number.isInteger(payload.ver)
      || payload.ver < 0
      || typeof payload.sid !== 'string'
      || !SESSION_ID_PATTERN.test(payload.sid)
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

  /** For connections that authenticate outside the HTTP guard (the console). */
  async validateAccessToken(token: string): Promise<AccessCredential> {
    if (!/^[A-Za-z0-9._-]{20,4096}$/.test(token)) {
      throw new UnauthorizedException('Invalid access token');
    }
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    if (!Number.isSafeInteger(payload.exp)) throw new UnauthorizedException('Invalid access token');
    const user = await this.validateJwtPayload(payload);
    return { user, sessionId: payload.sid, expiresAt: new Date(payload.exp! * 1_000) };
  }

  /**
   * Until when `credential` may keep authorizing a long-lived connection: the
   * first of the token's own expiry, the browser session's idle expiry and its
   * absolute end. Null when the session is gone (logged out, reused, evicted,
   * expired) or belongs to someone else. A connection must present a fresh
   * access token, re-checked here, before this moment to keep going.
   */
  async browserSessionDeadline(credential: AccessCredential): Promise<Date | null> {
    const session = await this.persistence.findLiveRefreshSession(
      credential.user.id,
      credential.sessionId,
    );
    if (!session) return null;
    const deadline = Math.min(
      credential.expiresAt.getTime(),
      session.expiresAt.getTime(),
      session.createdAt.getTime() + this.sessionLifetimeMs().absoluteMs,
    );
    return deadline > Date.now() ? new Date(deadline) : null;
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  /**
   * Re-authentication of a signed-in user (password change, SSH key).
   * Wrong entries are counted per user so a stolen access token cannot be
   * used to brute-force the password; a correct one gives its unit back.
   */
  async verifyCurrentPassword(
    user: Pick<AuthUser, 'id' | 'passwordHash'>,
    password: string,
  ): Promise<boolean> {
    if (password.length === 0 || password.length > MAX_LOGIN_PASSWORD_CHARS) return false;
    const reservations = this.loginAttempts.reserve([
      { key: `reauth:${user.id}`, limit: MAX_REAUTH_FAILURES_PER_USER },
    ]);
    if (!reservations) throw this.tooManyRequests('Too many incorrect password attempts');
    let valid: boolean;
    try {
      valid = await this.verifyPasswordBounded(this.reauthGate, `user:${user.id}`, user.passwordHash, password);
    } catch (error) {
      this.loginAttempts.release(reservations);
      throw error;
    }
    if (valid) this.loginAttempts.release(reservations);
    return valid;
  }

  async revokeBrowserSessionsInTransaction(manager: unknown, userId: string): Promise<void> {
    if (!isPgIamTransaction(manager)) {
      throw new Error('IAM credential deletion requires a PostgreSQL/Kysely transaction');
    }
    await this.persistence.revokeBrowserSessions(manager, userId);
  }

  private async issueRefreshSession(
    userId: string,
    credentialSnapshot?: {
      id: string;
      passwordHash: string;
      authVersion: number;
    },
  ): Promise<{ user: AuthUser; refreshToken: string; sessionId: string } | null> {
    const rawRefresh = randomBytes(48).toString('hex');
    const sessionId = uuidv4();
    const user = await this.persistence.issueRefreshSession(userId, {
      id: sessionId,
      hash: this.tokenHash(rawRefresh),
      expiresInMs: this.refreshCookieMaxAgeMs(),
    }, MAX_REFRESH_SESSIONS_PER_USER, credentialSnapshot, (transaction, issuedUser) =>
      this.audit.append(
        transaction,
        issuedUser.id,
        AuditAction.UserLogin,
        issuedUser.id,
        'user',
      ));
    return user ? { user, refreshToken: rawRefresh, sessionId } : null;
  }

  private signAccessToken(user: AuthUser, sessionId: string): string {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      ver: user.authVersion,
      sid: sessionId,
    };
    return this.jwtService.sign(payload);
  }

  /** `auth.jwtExpiresIn` is restart-only, so this is stable per process. */
  private refreshAncestorWindowMs(): number {
    const configured = this.config.get<string>('auth.jwtExpiresIn');
    const lifetimeMs = jwtLifetimeMs(configured);
    if (lifetimeMs === null) throw new Error(`Invalid auth.jwtExpiresIn: ${String(configured)}`);
    return refreshAncestorMinimumAgeMs(lifetimeMs);
  }

  /**
   * Refreshing slides the expiry by the idle window, but never past login +
   * the absolute lifetime: a stolen-and-refreshed session cannot live forever.
   */
  private sessionLifetimeMs(): { idleMs: number; absoluteMs: number } {
    return {
      idleMs: this.config.get<number>('auth.refreshTokenExpiresDays') * 86_400_000,
      absoluteMs: this.config.get<number>('auth.sessionMaxLifetimeDays') * 86_400_000,
    };
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

  private async verifyPasswordBounded(
    gate: PasswordVerificationGate,
    holder: string,
    hash: string,
    password: string,
  ): Promise<boolean> {
    try {
      return await gate.run(holder, () => argon2.verify(hash, password));
    } catch (error) {
      if (error instanceof PasswordVerificationBusyError) {
        throw this.tooManyRequests('Password verification capacity is temporarily exhausted');
      }
      throw error;
    }
  }

  /**
   * Failures are counted per (client address, username) and per client
   * address, never per username alone: nobody can lock another user (or
   * `admin`) out from a different address.
   */
  private consumeLoginAttempt(bucket: string, username: string): LoginAttemptReservation[] {
    const normalizedUsername = username.trim().toLowerCase().slice(0, MAX_LOGIN_USERNAME_CHARS);
    const reservations = this.loginAttempts.reserve([
      { key: `ip:${bucket}`, limit: MAX_LOGIN_FAILURES_PER_IP },
      { key: `login:${bucket}\0${normalizedUsername}`, limit: MAX_LOGIN_FAILURES_PER_IP_USERNAME },
    ]);
    if (!reservations) throw this.tooManyRequests('Too many login attempts');
    return reservations;
  }

  private tooManyRequests(message: string): HttpException {
    return new HttpException({ code: 'AUTH_RATE_LIMITED', message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
