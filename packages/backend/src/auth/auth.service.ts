import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, MoreThan, Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { createHash, createHmac, randomBytes } from 'crypto';
import { UserEntity } from '../entities/user.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { ApiTokenEntity } from '../entities/api-token.entity.js';
import { UserStatus } from '@nyabase/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';

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

const MAX_LOGIN_USERNAME_CHARS = 256;
const MAX_LOGIN_PASSWORD_CHARS = 1_024;
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$DCw8KRwf+V7pMnhiRFOb6g$KSjgFxwH2WqyoDT2q5Hz0Z18Zv/+eAHbnRgKiC6dI5A';

interface LoginAttemptEntry {
  count: number;
  windowStartedAt: number;
  lastSeenAt: number;
}

interface LoginAttemptReservation {
  key: string;
  entry: LoginAttemptEntry;
}

@Injectable()
export class AuthService {
  private activePasswordVerifications = 0;
  private readonly loginAttempts = new Map<string, LoginAttemptEntry>();

  constructor(
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    @InjectRepository(RefreshTokenEntity)
    private refreshTokensRepo: Repository<RefreshTokenEntity>,
    @InjectRepository(ApiTokenEntity)
    private apiTokensRepo: Repository<ApiTokenEntity>,
    private jwtService: JwtService,
    private config: NyabaseConfigService,
  ) {}

  /**
   * Verify credentials without issuing a session. Missing and disabled users
   * take the same Argon2 path as a wrong password to avoid a username oracle.
   */
  async validateUser(username: string, password: string): Promise<UserEntity> {
    const user = username.length <= MAX_LOGIN_USERNAME_CHARS
      ? await this.usersRepo.findOne({ where: { username } })
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
    const reservations = this.consumeLoginAttempt(clientIp, username);
    const snapshot = await this.validateUser(username, password);
    const result = await runSerializedTransaction(this.usersRepo.manager.connection, async (manager) => {
      const current = await manager.findOne(UserEntity, { where: { id: snapshot.id } });
      if (
        !current
        || current.status !== UserStatus.Active
        || current.passwordHash !== snapshot.passwordHash
        || current.authVersion !== snapshot.authVersion
      ) {
        throw new UnauthorizedException('Invalid credentials');
      }
      return {
        user: current,
        ...(await this.issueTokensInTransaction(current, manager)),
      };
    });
    // The limiter reserves before the expensive credential path. A complete
    // success is not abuse, so release only this call's exact reservations.
    // Entry identity fences concurrent failures and a replacement time window:
    // neither may be decremented by an older successful call.
    this.releaseSuccessfulLoginReservations(reservations);
    return result;
  }

  /** Internal/test login for an already authenticated durable user. */
  async login(user: UserEntity) {
    return runSerializedTransaction(this.usersRepo.manager.connection, async (manager) => {
      const current = await manager.findOne(UserEntity, { where: { id: user.id } });
      if (!current || current.status !== UserStatus.Active) {
        throw new UnauthorizedException('User not found or disabled');
      }
      return this.issueTokensInTransaction(current, manager);
    });
  }

  async refreshTokens(rawRefreshToken: string, requestId: string) {
    if (!/^[0-9a-f]{64}$/.test(requestId)) {
      throw new BadRequestException('requestId must be 64 lowercase hexadecimal characters');
    }
    const hash = this.tokenHash(rawRefreshToken);
    const requestIdHash = this.tokenHash(requestId);

    return runSerializedTransaction(this.refreshTokensRepo.manager.connection, async (manager) => {
      // Time is intentionally sampled after acquiring the serialized lease.
      const now = new Date();
      await this.purgeExpiredRefreshSessionsInTransaction(manager, now);
      const token = await manager.findOne(RefreshTokenEntity, {
        where: { hash, revoked: false, expiresAt: MoreThan(now) },
      });
      if (!token) {
        const rotated = await manager.findOne(RefreshTokenEntity, {
          where: {
            previousHash: hash,
            previousRequestIdHash: requestIdHash,
            revoked: false,
            expiresAt: MoreThan(now),
          },
        });
        if (!rotated) throw new UnauthorizedException('Invalid refresh token');
        const recoveredRefresh = this.deriveRotatedRefreshToken(
          rotated.id,
          hash,
          requestId,
        );
        if (this.tokenHash(recoveredRefresh) !== rotated.hash) {
          throw new UnauthorizedException('Invalid refresh token');
        }
        const recoveredUser = await manager.findOne(UserEntity, {
          where: { id: rotated.userId },
        });
        if (!recoveredUser || recoveredUser.status !== UserStatus.Active) {
          throw new UnauthorizedException('User not found or disabled');
        }
        return {
          accessToken: this.signAccessToken(recoveredUser),
          refreshToken: recoveredRefresh,
        };
      }

      const user = await manager.findOne(UserEntity, { where: { id: token.userId } });
      if (!user || user.status !== UserStatus.Active) {
        throw new UnauthorizedException('User not found or disabled');
      }
      await this.trimRefreshSessionsInTransaction(manager, user.id, now, token.id);

      const rawRefresh = this.deriveRotatedRefreshToken(token.id, hash, requestId);
      const nextHash = this.tokenHash(rawRefresh);
      const expiresAt = this.refreshExpiryFrom(now);
      const rotated = await manager.update(RefreshTokenEntity, {
        id: token.id,
        hash,
        revoked: false,
        expiresAt: MoreThan(now),
      }, {
        hash: nextHash,
        previousHash: hash,
        previousRequestIdHash: requestIdHash,
        expiresAt,
      });
      if (rotated.affected !== 1) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return {
        accessToken: this.signAccessToken(user),
        refreshToken: rawRefresh,
      };
    });
  }

  /**
   * Possession of a refresh secret is the authority to terminate that session.
   * The one-step predecessor resolves the same row so a logout replayed after
   * automatic rotation still deletes the current token.
   */
  async logout(rawRefreshToken: string): Promise<string | null> {
    const hash = this.tokenHash(rawRefreshToken);
    return runSerializedTransaction(this.refreshTokensRepo.manager.connection, async (manager) => {
      const token = await manager.findOne(RefreshTokenEntity, {
        where: [{ hash }, { previousHash: hash }],
      });
      if (!token) return null;
      await manager.delete(RefreshTokenEntity, { id: token.id });
      return token.userId;
    });
  }

  async validateJwtPayload(payload: JwtPayload): Promise<UserEntity> {
    if (
      typeof payload.sub !== 'string'
      || payload.sub.length === 0
      || !Number.isInteger(payload.ver)
      || payload.ver < 0
    ) {
      throw new UnauthorizedException();
    }
    const user = await this.usersRepo.findOne({ where: { id: payload.sub } });
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
  async validateApiToken(rawToken: string): Promise<UserEntity | null> {
    const hash = this.tokenHash(rawToken);
    const tokenEntity = await this.apiTokensRepo.findOne({ where: { hash } });
    if (!tokenEntity) return null;

    const user = await this.usersRepo.findOne({ where: { id: tokenEntity.userId } });
    if (!user || user.status !== UserStatus.Active) return null;

    const now = new Date();
    const elapsed = tokenEntity.lastUsedAt
      ? now.getTime() - tokenEntity.lastUsedAt.getTime()
      : Infinity;

    if (elapsed >= AuthService.LAST_USED_UPDATE_INTERVAL_MS) {
      // Repository.save on the stale entity can reinsert it after revocation.
      // A conditional update can never resurrect a deleted credential.
      const touched = await this.apiTokensRepo.update(
        { id: tokenEntity.id, hash },
        { lastUsedAt: now },
      );
      if (touched.affected !== 1) return null;
    }

    return user;
  }

  async createApiToken(userId: string, name: string) {
    const normalizedName = name.trim();
    if (normalizedName.length === 0 || normalizedName.length > 128) {
      throw new BadRequestException('API token name must contain 1-128 non-whitespace characters');
    }
    return runSerializedTransaction(this.apiTokensRepo.manager.connection, async (manager) => {
      const user = await manager.findOne(UserEntity, { where: { id: userId } });
      if (!user || user.status !== UserStatus.Active) {
        throw new UnauthorizedException('User not found or disabled');
      }
      const count = await manager.count(ApiTokenEntity, { where: { userId } });
      if (count >= MAX_API_TOKENS_PER_USER) {
        throw new ConflictException({
          code: 'API_TOKEN_CAPACITY_REACHED',
          message: `At most ${MAX_API_TOKENS_PER_USER} API tokens are supported per user`,
        });
      }
      const raw = randomBytes(32).toString('hex');
      const entity = manager.create(ApiTokenEntity, {
        id: uuidv4(),
        userId,
        name: normalizedName,
        hash: this.tokenHash(raw),
        createdAt: new Date(),
        lastUsedAt: null,
      });
      await manager.save(ApiTokenEntity, entity);
      return { entity, secret: raw };
    });
  }

  async listApiTokens(userId: string) {
    return this.apiTokensRepo.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async deleteApiToken(userId: string, tokenId: string) {
    return runSerializedTransaction(this.apiTokensRepo.manager.connection, async (manager) => {
      const token = await manager.findOneBy(ApiTokenEntity, { id: tokenId, userId });
      if (!token) throw new NotFoundException('Token not found');
      await manager.delete(ApiTokenEntity, { id: tokenId, userId });
      return token;
    });
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    return this.verifyPasswordBounded(hash, password);
  }

  async revokeBrowserSessionsInTransaction(manager: EntityManager, userId: string): Promise<void> {
    await manager.delete(RefreshTokenEntity, { userId });
  }

  async deleteUserCredentialsInTransaction(manager: EntityManager, userId: string): Promise<void> {
    await Promise.all([
      manager.delete(RefreshTokenEntity, { userId }),
      manager.delete(ApiTokenEntity, { userId }),
    ]);
  }

  private async issueTokensInTransaction(user: UserEntity, manager: EntityManager) {
    const now = new Date();
    await this.purgeExpiredRefreshSessionsInTransaction(manager, now);

    await this.trimRefreshSessionsInTransaction(manager, user.id, now);

    const rawRefresh = randomBytes(48).toString('hex');
    const repo = manager.getRepository(RefreshTokenEntity);
    await repo.save(repo.create({
      id: uuidv4(),
      userId: user.id,
      hash: this.tokenHash(rawRefresh),
      previousHash: null,
      previousRequestIdHash: null,
      expiresAt: this.refreshExpiryFrom(now),
      revoked: false,
      createdAt: now,
    }));

    return {
      accessToken: this.signAccessToken(user),
      refreshToken: rawRefresh,
    };
  }

  private signAccessToken(user: UserEntity): string {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      ver: user.authVersion,
    };
    return this.jwtService.sign(payload);
  }

  private refreshExpiryFrom(now: Date): Date {
    const expiresInDays = this.config.get<number>('auth.refreshTokenExpiresDays');
    return new Date(now.getTime() + expiresInDays * 86_400_000);
  }

  private async purgeExpiredRefreshSessionsInTransaction(
    manager: EntityManager,
    now: Date,
  ): Promise<void> {
    await manager.createQueryBuilder()
      .delete()
      .from(RefreshTokenEntity)
      .where('revoked = :revoked OR expiresAt <= :now', { revoked: true, now })
      .execute();
  }

  private async trimRefreshSessionsInTransaction(
    manager: EntityManager,
    userId: string,
    now: Date,
    preserveSessionId?: string,
  ): Promise<void> {
    const active = await manager.find(RefreshTokenEntity, {
      where: { userId, revoked: false, expiresAt: MoreThan(now) },
      order: { createdAt: 'ASC' },
    });
    const candidates = preserveSessionId
      ? active.filter((token) => token.id !== preserveSessionId)
      : active;
    const availableOtherSlots = MAX_REFRESH_SESSIONS_PER_USER - (preserveSessionId ? 1 : 0);
    // Login needs one free slot for the row it is about to insert. Refresh
    // preserves the rotating row and may fill all remaining slots.
    const keepCount = preserveSessionId
      ? availableOtherSlots
      : Math.max(0, availableOtherSlots - 1);
    const overflow = candidates.slice(0, Math.max(0, candidates.length - keepCount));
    if (overflow.length > 0) {
      await manager.delete(RefreshTokenEntity, overflow.map((token) => token.id));
    }
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

  private consumeLoginAttempt(
    clientIp: string,
    username: string,
  ): LoginAttemptReservation[] {
    const now = Date.now();
    this.pruneLoginAttempts(now);
    const normalizedIp = clientIp.trim() || 'unknown';
    const normalizedUsername = username.trim().toLowerCase().slice(0, MAX_LOGIN_USERNAME_CHARS);
    const keys = [
      `ip:${normalizedIp}`,
      `principal:${normalizedUsername}`,
    ];
    const limits = [MAX_LOGIN_ATTEMPTS_PER_IP, MAX_LOGIN_ATTEMPTS_PER_PRINCIPAL];
    const reservations: LoginAttemptReservation[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const existing = this.loginAttempts.get(key);
      const entry = !existing || now - existing.windowStartedAt >= LOGIN_ATTEMPT_WINDOW_MS
        ? { count: 0, windowStartedAt: now, lastSeenAt: now }
        : existing;
      if (entry.count >= limits[index]) {
        throw this.tooManyRequests('Too many login attempts');
      }
      // If the principal bucket is already exhausted, the IP increment made
      // just before this check is retained intentionally: blocked credential
      // stuffing is still abuse attributable to this peer.
      entry.count += 1;
      entry.lastSeenAt = now;
      this.loginAttempts.delete(key);
      this.loginAttempts.set(key, entry);
      reservations.push({ key, entry });
    }
    while (this.loginAttempts.size > MAX_LOGIN_LIMITER_KEYS) {
      const oldest = this.loginAttempts.keys().next().value;
      if (oldest === undefined) break;
      this.loginAttempts.delete(oldest);
    }
    return reservations;
  }

  private releaseSuccessfulLoginReservations(
    reservations: readonly LoginAttemptReservation[],
  ): void {
    for (const { key, entry } of reservations) {
      if (this.loginAttempts.get(key) !== entry) continue;
      if (entry.count <= 0) continue;
      entry.count -= 1;
      if (entry.count === 0 && this.loginAttempts.get(key) === entry) {
        this.loginAttempts.delete(key);
      }
    }
  }

  private pruneLoginAttempts(now: number): void {
    for (const [key, entry] of this.loginAttempts) {
      if (now - entry.windowStartedAt >= LOGIN_ATTEMPT_WINDOW_MS) {
        this.loginAttempts.delete(key);
      }
    }
  }

  private tooManyRequests(message: string): HttpException {
    return new HttpException({ code: 'AUTH_RATE_LIMITED', message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
