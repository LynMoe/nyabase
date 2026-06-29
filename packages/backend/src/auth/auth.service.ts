import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes } from 'crypto';
import { UserEntity } from '../entities/user.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { ApiTokenEntity } from '../entities/api-token.entity.js';
import { UserStatus } from '@nyabase/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

export interface JwtPayload {
  sub: string;
  username: string;
}

@Injectable()
export class AuthService {
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

  async validateUser(username: string, password: string): Promise<UserEntity> {
    const user = await this.usersRepo.findOne({ where: { username } });
    if (!user || user.status !== UserStatus.Active) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }

  async login(user: UserEntity) {
    const payload: JwtPayload = { sub: user.id, username: user.username };
    const accessToken = this.jwtService.sign(payload);

    const rawRefresh = randomBytes(48).toString('hex');
    const hash = createHash('sha256').update(rawRefresh).digest('hex');
    const expiresInDays = this.config.get<number>('auth.refreshTokenExpiresDays');
    const expiresAt = new Date(Date.now() + expiresInDays * 86400 * 1000);

    await this.refreshTokensRepo.save(
      this.refreshTokensRepo.create({
        id: uuidv4(),
        userId: user.id,
        hash,
        expiresAt,
        createdAt: new Date(),
      }),
    );

    return { accessToken, refreshToken: rawRefresh };
  }

  async refreshTokens(rawRefreshToken: string) {
    const hash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const token = await this.refreshTokensRepo.findOne({ where: { hash } });

    if (!token || token.revoked || token.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.usersRepo.findOne({ where: { id: token.userId } });
    if (!user || user.status !== UserStatus.Active) {
      throw new UnauthorizedException('User not found or disabled');
    }

    // Rotate: revoke old, issue new
    token.revoked = true;
    await this.refreshTokensRepo.save(token);
    return this.login(user);
  }

  async logout(rawRefreshToken: string) {
    const hash = createHash('sha256').update(rawRefreshToken).digest('hex');
    await this.refreshTokensRepo.update({ hash }, { revoked: true });
  }

  async validateJwtPayload(payload: JwtPayload): Promise<UserEntity> {
    const user = await this.usersRepo.findOne({ where: { id: payload.sub } });
    if (!user || user.status !== UserStatus.Active) {
      throw new UnauthorizedException();
    }
    return user;
  }

  /** Throttle window for lastUsedAt updates: skip writes within this interval */
  private static readonly LAST_USED_UPDATE_INTERVAL_MS = 60_000; // 1 minute

  /** Validate an API token; returns user if valid */
  async validateApiToken(rawToken: string): Promise<UserEntity | null> {
    const hash = createHash('sha256').update(rawToken).digest('hex');
    const tokenEntity = await this.apiTokensRepo.findOne({ where: { hash } });
    if (!tokenEntity) return null;

    const user = await this.usersRepo.findOne({ where: { id: tokenEntity.userId } });
    if (!user || user.status !== UserStatus.Active) return null;

    const now = new Date();
    const elapsed = tokenEntity.lastUsedAt
      ? now.getTime() - tokenEntity.lastUsedAt.getTime()
      : Infinity;

    if (elapsed >= AuthService.LAST_USED_UPDATE_INTERVAL_MS) {
      tokenEntity.lastUsedAt = now;
      await this.apiTokensRepo.save(tokenEntity);
    }

    return user;
  }

  async createApiToken(userId: string, name: string) {
    const raw = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(raw).digest('hex');
    const entity = this.apiTokensRepo.create({
      id: uuidv4(),
      userId,
      name,
      hash,
      createdAt: new Date(),
      lastUsedAt: null,
    });
    await this.apiTokensRepo.save(entity);
    return { entity, secret: raw };
  }

  async listApiTokens(userId: string) {
    return this.apiTokensRepo.find({ where: { userId } });
  }

  async deleteApiToken(userId: string, tokenId: string) {
    const token = await this.apiTokensRepo.findOne({
      where: { id: tokenId, userId },
    });
    if (!token) throw new NotFoundException('Token not found');
    await this.apiTokensRepo.remove(token);
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }
}
