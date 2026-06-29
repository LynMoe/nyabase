import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { UserEntity } from '../entities/user.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { AuthService } from '../auth/auth.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { ContainerSshSyncService } from '../containers/container-ssh-sync.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { UserStatus, UserDto, normalizeOpenSshPublicKey } from '@nyabase/common';
import { SshIdentityService } from '../ssh/ssh-identity.service.js';
import { SshProxyGateway } from '../ssh/ssh-proxy-gateway.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  /** Bidirectional cache: UUID ↔ numericId (never changes after creation). */
  private readonly numericIdCache = new Map<string, number>();
  private readonly uuidCache = new Map<number, string>();

  constructor(
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    @InjectRepository(SshPublicKeyEntity)
    private sshKeysRepo: Repository<SshPublicKeyEntity>,
    private authService: AuthService,
    private accessResolver: AccessResolverService,
    private dataSource: DataSource,
    private containerSshSync: ContainerSshSyncService,
    private sshIdentities: SshIdentityService,
    private sshProxyGateway: SshProxyGateway,
    private config: NyabaseConfigService,
  ) {}

  async createUser(dto: {
    username: string;
    password: string;
    displayName: string;
  }): Promise<UserEntity> {
    const existing = await this.usersRepo.findOne({ where: { username: dto.username } });
    if (existing) throw new ConflictException('Username already exists');

    const passwordHash = await this.authService.hashPassword(dto.password);

    const user = await runSerializedTransaction(this.dataSource, async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .select('COALESCE(MAX(u.numericId), 0)', 'max')
        .from(UserEntity, 'u')
        .getRawOne<{ max: string }>();
      const numericId = Number(result?.max ?? 0) + 1;

      const entity = manager.create(UserEntity, {
        id: uuidv4(),
        numericId,
        username: dto.username,
        passwordHash,
        displayName: dto.displayName,
        status: UserStatus.Active,
      });
      const saved = await manager.save(entity);
      await this.sshIdentities.createUserKeyInTransaction(manager, saved);
      return saved;
    });

    this.numericIdCache.set(user.id, user.numericId);
    this.uuidCache.set(user.numericId, user.id);
    return user;
  }

  /**
   * Resolve UUIDs → numericIds. Missing entries are batch-fetched from DB and
   * cached. UUIDs not found in DB are omitted from the result.
   */
  async getNumericIdsByUserIds(uuids: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const missing: string[] = [];

    for (const uuid of uuids) {
      const cached = this.numericIdCache.get(uuid);
      if (cached !== undefined) {
        result.set(uuid, cached);
      } else {
        missing.push(uuid);
      }
    }

    if (missing.length > 0) {
      const rows = await this.usersRepo.findBy({ id: In(missing) });
      for (const row of rows) {
        // Skip users created before the numericId migration (numericId is nullable).
        if (row.numericId == null) continue;
        this.numericIdCache.set(row.id, row.numericId);
        this.uuidCache.set(row.numericId, row.id);
        result.set(row.id, row.numericId);
      }
    }

    return result;
  }

  /**
   * Resolve numericIds → UUIDs. Missing entries are batch-fetched from DB and
   * cached. numericIds not found in DB are omitted from the result.
   */
  async getUserIdsByNumericIds(numericIds: number[]): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    const missing: number[] = [];

    for (const num of numericIds) {
      const cached = this.uuidCache.get(num);
      if (cached !== undefined) {
        result.set(num, cached);
      } else {
        missing.push(num);
      }
    }

    if (missing.length > 0) {
      const rows = await this.usersRepo.findBy({ numericId: In(missing) });
      for (const row of rows) {
        this.numericIdCache.set(row.id, row.numericId);
        this.uuidCache.set(row.numericId, row.id);
        result.set(row.numericId, row.id);
      }
    }

    return result;
  }

  async findById(id: string): Promise<UserEntity> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findAll(): Promise<UserEntity[]> {
    return this.usersRepo.find();
  }

  async findByIds(ids: string[]): Promise<UserEntity[]> {
    if (ids.length === 0) return [];
    return this.usersRepo.findBy({ id: In(ids) });
  }

  async updateUser(
    id: string,
    dto: {
      displayName?: string;
      password?: string;
      status?: UserStatus;
    },
  ): Promise<UserEntity> {
    const user = await this.findById(id);
    if (dto.displayName !== undefined) user.displayName = dto.displayName;
    if (dto.status !== undefined) user.status = dto.status;
    if (dto.password) {
      user.passwordHash = await this.authService.hashPassword(dto.password);
    }
    if (dto.status === UserStatus.Disabled) {
      this.accessResolver.invalidateUser(id);
    }
    const saved = await this.usersRepo.save(user);
    await this.notifySshProxyChanged();
    return saved;
  }

  async deleteUser(id: string): Promise<void> {
    const user = await this.findById(id);
    this.accessResolver.invalidateUser(id);
    await this.usersRepo.remove(user);
    // Evict from bidirectional cache so stale entries don't linger.
    if (user.numericId != null) {
      this.numericIdCache.delete(id);
      this.uuidCache.delete(user.numericId);
    }
    await this.notifySshProxyChanged();
  }

  async ensureAdminExists(addToAdminsGroup: (userId: string) => Promise<void>): Promise<void> {
    const adminExists = await this.usersRepo.findOne({ where: { username: 'admin' } });
    if (!adminExists) {
      const isProd = this.config.get<string>('runtime.nodeEnv') === 'production';
      let initPassword = this.config.get<string>('auth.adminInitPassword');

      if (!initPassword) {
        if (isProd) {
          // Generate a strong random password in production to avoid a known default
          const { randomBytes } = await import('crypto');
          initPassword = randomBytes(12).toString('hex');
          // Print once to stdout so operators can capture it from service logs
          console.log('');
          console.log('╔════════════════════════════════════════════════════╗');
          console.log('║  ADMIN INITIAL PASSWORD (shown once)               ║');
          console.log(`║  Username : admin                                  ║`);
          console.log(`║  Password : ${initPassword.padEnd(38)}  ║`);
          console.log('║  Change it immediately via the UI or API.          ║');
          console.log('╚════════════════════════════════════════════════════╝');
          console.log('');
        } else {
          // Development/test: fall back to well-known default for convenience
          initPassword = 'admin123';
        }
      }

      const user = await this.createUser({
        username: 'admin',
        password: initPassword,
        displayName: 'Administrator',
      });
      await addToAdminsGroup(user.id);
    }
  }

  // SSH Keys

  async listSshKeys(userId: string): Promise<SshPublicKeyEntity[]> {
    return this.sshKeysRepo.find({ where: { userId } });
  }

  async addSshKey(userId: string, name: string, keyText: string): Promise<SshPublicKeyEntity> {
    const normalizedKeyText = normalizeOpenSshPublicKey(keyText);
    if (!normalizedKeyText) throw new BadRequestException('Invalid OpenSSH public key');

    const key = this.sshKeysRepo.create({
      id: uuidv4(),
      userId,
      name,
      keyText: normalizedKeyText,
      createdAt: new Date(),
    });
    const saved = await this.sshKeysRepo.save(key);
    await this.notifySshProxyChanged();
    return saved;
  }

  async deleteSshKey(userId: string, keyId: string): Promise<void> {
    const key = await this.sshKeysRepo.findOne({ where: { id: keyId, userId } });
    if (!key) throw new NotFoundException('SSH key not found');
    await this.sshKeysRepo.remove(key);
    await this.notifySshProxyChanged();
  }

  async getUserSshKeyTexts(userId: string): Promise<string[]> {
    const keys = await this.listSshKeys(userId);
    return keys.map((k) => k.keyText);
  }

  async notifyInternalSshKeyRotated(userId: string): Promise<void> {
    try {
      await this.containerSshSync.enqueueForUser(userId);
    } catch (e) {
      this.logger.warn(`SSH key change hook enqueue failed for ${userId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.notifySshProxyChanged();
  }

  private async notifySshProxyChanged(): Promise<void> {
    try {
      await this.sshProxyGateway.broadcastSnapshot();
    } catch (e) {
      this.logger.warn(`SSH proxy snapshot broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async toDto(user: UserEntity): Promise<UserDto> {
    const [capabilities, groups] = await Promise.all([
      this.accessResolver.userCapabilities(user.id),
      this.accessResolver.getUserGroupSummaries(user.id),
    ]);
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      capabilities: Array.from(capabilities),
      groups,
    };
  }
}
