import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { UserEntity } from '../entities/user.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { AuthService } from '../auth/auth.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { ContainerSshConvergenceService } from '../ssh/container-ssh-convergence.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import {
  UserStatus,
  UserDto,
  normalizeOpenSshPublicKey,
  MAX_AGENT_XFS_PROJECTS,
  MAX_PLATFORM_ACTIVE_USERS,
  MAX_SSH_PUBLIC_KEYS_PER_USER,
  MAX_SSH_PUBLIC_KEY_TEXT_LENGTH,
} from '@nyabase/common';
import { SshIdentityService } from '../ssh/ssh-identity.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    @InjectRepository(SshPublicKeyEntity)
    private sshKeysRepo: Repository<SshPublicKeyEntity>,
    private authService: AuthService,
    private accessResolver: AccessResolverService,
    private dataSource: DataSource,
    private containerSshConvergence: ContainerSshConvergenceService,
    private sshIdentities: SshIdentityService,
    private proxySnapshots: ProxySnapshotNotifierService,
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
      const [totalUsers, activeUsers] = await Promise.all([
        manager.count(UserEntity),
        manager.count(UserEntity, { where: { status: UserStatus.Active } }),
      ]);
      // Deleted users remain durable tombstones and their numeric IDs may
      // already exist as XFS project records on every previously granted
      // server. Bound the lifetime namespace by the authoritative report
      // shape so ordinary user churn can never make Agent inventory invalid.
      if (totalUsers >= MAX_AGENT_XFS_PROJECTS) {
        throw new ConflictException({
          code: 'USER_LIFETIME_CAPACITY_REACHED',
          message: `At most ${MAX_AGENT_XFS_PROJECTS} lifetime users are supported`,
        });
      }
      if (activeUsers >= MAX_PLATFORM_ACTIVE_USERS) {
        throw new ConflictException({
          code: 'USER_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_ACTIVE_USERS} active users are supported`,
        });
      }
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

    return user;
  }

  /**
   * Resolve UUIDs -> numericIds with one bounded batch query. These mappings
   * are durable data, not process state; retaining every historical user in a
   * process cache would grow without bound under normal user churn.
   */
  async getNumericIdsByUserIds(uuids: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(uuids)];
    const result = new Map<string, number>();
    if (ids.length === 0) return result;
    const rows = await this.usersRepo.findBy({ id: In(ids) });
    for (const row of rows) {
      // Skip users created before the numericId migration (numericId is nullable).
      if (row.numericId == null) continue;
      result.set(row.id, row.numericId);
    }
    return result;
  }

  /**
   * Resolve numericIds -> UUIDs with one bounded batch query. IDs not present
   * in durable state are omitted.
   */
  async getUserIdsByNumericIds(numericIds: number[]): Promise<Map<number, string>> {
    const ids = [...new Set(numericIds)];
    const result = new Map<number, string>();
    if (ids.length === 0) return result;
    const rows = await this.usersRepo.findBy({ numericId: In(ids) });
    for (const row of rows) {
      result.set(row.numericId, row.id);
    }
    return result;
  }

  async findById(id: string): Promise<UserEntity> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user || user.status === UserStatus.Deleted) throw new NotFoundException('User not found');
    return user;
  }

  async findAll(): Promise<UserEntity[]> {
    return this.usersRepo.find({ where: { status: Not(UserStatus.Deleted) } });
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
    const passwordHash = dto.password
      ? await this.authService.hashPassword(dto.password)
      : undefined;
    const saved = await runSerializedTransaction(this.dataSource, async (manager) => {
      const user = await manager.findOneBy(UserEntity, { id });
      if (!user) throw new NotFoundException('User not found');
      if (user.status === UserStatus.Deleted || user.status === UserStatus.Deleting) {
        throw new ConflictException({
          code: user.status === UserStatus.Deleted ? 'USER_DELETED' : 'USER_DELETING',
          message: 'A deleted or deleting user cannot be updated',
          userId: id,
        });
      }
      if (dto.status === UserStatus.Deleted) {
        throw new BadRequestException({
          code: 'USER_DELETED_STATUS_RESERVED',
          message: 'Deleted is reserved for the DELETE endpoint',
        });
      }
      if (
        dto.status === UserStatus.Active
        && user.status !== UserStatus.Active
        && await manager.count(UserEntity, { where: { status: UserStatus.Active } })
          >= MAX_PLATFORM_ACTIVE_USERS
      ) {
        throw new ConflictException({
          code: 'USER_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_ACTIVE_USERS} active users are supported`,
        });
      }
      const allowed: Partial<Pick<UserEntity, 'displayName' | 'passwordHash' | 'status'>> = {};
      if (dto.displayName !== undefined) allowed.displayName = dto.displayName;
      if (passwordHash !== undefined) allowed.passwordHash = passwordHash;
      if (dto.status !== undefined) allowed.status = dto.status;
      if (Object.keys(allowed).length > 0) await manager.update(UserEntity, id, allowed);
      return manager.findOneByOrFail(UserEntity, { id });
    });
    if (dto.status !== undefined) this.accessResolver.invalidateUser(id);
    await this.notifyProxySnapshotsChanged('user-updated');
    return saved;
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
    if (normalizedKeyText.length > MAX_SSH_PUBLIC_KEY_TEXT_LENGTH) {
      throw new BadRequestException(
        `SSH public key must not exceed ${MAX_SSH_PUBLIC_KEY_TEXT_LENGTH} characters`,
      );
    }

    const saved = await runSerializedTransaction(this.dataSource, async (manager) => {
      const user = await manager.findOneBy(UserEntity, { id: userId });
      if (!user || user.status !== UserStatus.Active) {
        throw new ConflictException('SSH keys require an active user');
      }
      const keyCount = await manager.count(SshPublicKeyEntity, { where: { userId } });
      if (keyCount >= MAX_SSH_PUBLIC_KEYS_PER_USER) {
        throw new ConflictException({
          code: 'SSH_PUBLIC_KEY_CAPACITY_REACHED',
          message: `At most ${MAX_SSH_PUBLIC_KEYS_PER_USER} SSH public keys are supported per user`,
        });
      }
      return manager.save(SshPublicKeyEntity, manager.create(SshPublicKeyEntity, {
        id: uuidv4(),
        userId,
        name,
        keyText: normalizedKeyText,
        createdAt: new Date(),
      }));
    });
    await this.notifyProxySnapshotsChanged('user-ssh-key-added');
    return saved;
  }

  async deleteSshKey(userId: string, keyId: string): Promise<void> {
    const key = await this.sshKeysRepo.findOne({ where: { id: keyId, userId } });
    if (!key) throw new NotFoundException('SSH key not found');
    await this.sshKeysRepo.remove(key);
    await this.notifyProxySnapshotsChanged('user-ssh-key-deleted');
  }

  async getUserSshKeyTexts(userId: string): Promise<string[]> {
    const keys = await this.listSshKeys(userId);
    return keys.map((k) => k.keyText);
  }

  async notifyInternalSshKeyRotated(userId: string): Promise<void> {
    try {
      await this.containerSshConvergence.reconcileUser(userId);
    } catch (e) {
      this.logger.warn(`SSH key change hook enqueue failed for ${userId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.notifyProxySnapshotsChanged('user-internal-ssh-key-rotated');
  }

  private async notifyProxySnapshotsChanged(reason: string): Promise<void> {
    try {
      await this.proxySnapshots.notify(reason);
    } catch (e) {
      this.logger.warn(`Proxy snapshot notification failed: ${e instanceof Error ? e.message : String(e)}`);
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
