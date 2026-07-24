import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
  UnauthorizedException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { UserEntity } from '../entities/user.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { ServerGrantEntity } from '../entities/server-grant.entity.js';
import { ImageGrantEntity } from '../entities/image-grant.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
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
  AuditAction,
  SystemGroupKey,
  Capability,
} from '@nyabase/common';
import { SshIdentityService } from '../ssh/ssh-identity.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { AuditService } from '../audit/audit.service.js';
import { QuotaDispatchService } from '../quota/quota-dispatch.service.js';

interface CreateUserOptions {
  systemGroupKey?: SystemGroupKey;
  /** Undefined suppresses audit for low-level internal callers/tests; null is a system actor. */
  actorId?: string | null;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    @InjectRepository(SshPublicKeyEntity)
    private sshKeysRepo: Repository<SshPublicKeyEntity>,
    private authService: AuthService,
    @Inject(forwardRef(() => AccessResolverService))
    private accessResolver: AccessResolverService,
    private dataSource: DataSource,
    private containerSshConvergence: ContainerSshConvergenceService,
    private sshIdentities: SshIdentityService,
    private proxySnapshots: ProxySnapshotNotifierService,
    private config: NyabaseConfigService,
    @Inject(forwardRef(() => AuditService))
    private auditService: AuditService,
    @Inject(forwardRef(() => QuotaDispatchService))
    private quotaDispatchService: QuotaDispatchService,
  ) {}

  async createUser(dto: {
    username: string;
    password: string;
    displayName: string;
  }, options: CreateUserOptions = {}): Promise<UserEntity> {
    if (dto.username.length < 2 || dto.username.length > 64 || !/^[a-z0-9_-]+$/.test(dto.username)) {
      throw new BadRequestException('Username must contain 2-64 lowercase letters, digits, _ or -');
    }
    const displayName = dto.displayName.trim();
    if (displayName.length === 0 || displayName.length > 128) {
      throw new BadRequestException('Display name must contain 1-128 non-whitespace characters');
    }
    if (dto.password.length < 8 || dto.password.length > 256) {
      throw new BadRequestException('Password must contain 8-256 characters');
    }
    const passwordHash = await this.authService.hashPassword(dto.password);
    const userId = uuidv4();
    // ssh-keygen runs before the serialized transaction. The prepared key is
    // persisted atomically with the user only after final authority/admission
    // checks pass.
    const preparedSshKey = await this.sshIdentities.prepareUserKey({
      id: userId,
      username: dto.username,
    });

    const user = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (typeof options.actorId === 'string') {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          manager,
          options.actorId,
          [Capability.ManageUsers],
        );
      }
      if (await manager.findOne(UserEntity, { where: { username: dto.username } })) {
        throw new ConflictException('Username already exists');
      }
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
      if (!Number.isSafeInteger(numericId) || numericId > MAX_AGENT_XFS_PROJECTS) {
        throw new ConflictException({
          code: 'USER_LIFETIME_CAPACITY_REACHED',
          message: 'The durable numeric user namespace is exhausted',
        });
      }

      const entity = manager.create(UserEntity, {
        id: userId,
        numericId,
        username: dto.username,
        passwordHash,
        displayName,
        status: UserStatus.Active,
        authVersion: 0,
      });
      const saved = await manager.save(entity);
      await this.sshIdentities.savePreparedUserKeyInTransaction(
        manager,
        saved,
        preparedSshKey,
      );
      if (options.systemGroupKey) {
        const group = await manager.findOne(GroupEntity, {
          where: { systemKey: options.systemGroupKey, isSystem: true },
        });
        if (!group) {
          throw new ConflictException({
            code: 'SYSTEM_GROUP_MISSING',
            message: `Required built-in group is unavailable: ${options.systemGroupKey}`,
          });
        }
        const [groupGrants, imageGrantCount, mountGrantCount] = await Promise.all([
          manager.find(ServerGrantEntity, {
            where: { scope: 'group', scopeId: group.id },
            select: { serverId: true },
          }),
          manager.count(ImageGrantEntity, { where: { scope: 'group', scopeId: group.id } }),
          manager.count(MountSourceGrantEntity, { where: { scope: 'group', scopeId: group.id } }),
        ]);
        if (typeof options.actorId === 'string') {
          await this.accessResolver.assertActorCapabilitiesInTransaction(
            manager,
            options.actorId,
            [
              ...group.capabilities,
              ...(groupGrants.length + imageGrantCount + mountGrantCount > 0
                ? [Capability.ManageGrants]
                : []),
            ],
          );
        }
        await manager.save(GroupMemberEntity, manager.create(GroupMemberEntity, {
          id: uuidv4(),
          groupId: group.id,
          userId: saved.id,
        }));
        for (const grant of groupGrants) {
          const resolved = await this.accessResolver.resolveServerInTransaction(
            manager,
            saved.id,
            grant.serverId,
          );
          if (!resolved) continue;
          await this.quotaDispatchService.applyInTransaction(manager, {
            serverId: grant.serverId,
            userId: saved.id,
            numericUserId: saved.numericId,
            diskBytes: resolved.diskBytes,
            requestedBy: options.actorId ?? null,
          });
        }
      }
      return saved;
    });
    if (options.actorId !== undefined) {
      await this.auditBestEffort(options.actorId, AuditAction.CreateUser, user.id, {
        username: user.username,
        displayName: user.displayName,
        systemGroupKey: options.systemGroupKey ?? null,
      });
    }
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

  async getInternalSshKey(
    actorId: string,
    targetUserId: string,
    includePrivate: boolean,
  ) {
    return this.sshIdentities.getUserKeyDto(
      targetUserId,
      actorId,
      includePrivate,
      (manager) => this.accessResolver.assertActorMayAdministerUserInTransaction(
        manager,
        actorId,
        targetUserId,
      ),
    );
  }

  async rotateInternalSshKey(actorId: string, targetUserId: string) {
    const rotated = await this.sshIdentities.rotateUserKey(
      targetUserId,
      actorId,
      (manager) => this.accessResolver.assertActorMayAdministerUserInTransaction(
        manager,
        actorId,
        targetUserId,
      ),
    );
    await this.notifyInternalSshKeyRotated(targetUserId);
    return rotated;
  }

  async updateUser(
    id: string,
    dto: {
      displayName?: string;
      password?: string;
      status?: UserStatus;
    },
    actorId?: string,
  ): Promise<UserEntity> {
    const displayName = dto.displayName === undefined
      ? undefined
      : this.normalizeDisplayName(dto.displayName);
    if (dto.password !== undefined && (dto.password.length < 8 || dto.password.length > 256)) {
      throw new BadRequestException('Password must contain 8-256 characters');
    }
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
      if (actorId) {
        await this.accessResolver.assertActorMayAdministerUserInTransaction(manager, actorId, id);
      }
      if (dto.status === UserStatus.Deleted) {
        throw new BadRequestException({
          code: 'USER_DELETED_STATUS_RESERVED',
          message: 'Deleted is reserved for the DELETE endpoint',
        });
      }
      if (
        user.status === UserStatus.Active
        && dto.status !== undefined
        && dto.status !== UserStatus.Active
      ) {
        await this.accessResolver.assertNotFinalActiveAdministratorInTransaction(manager, id);
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
      const allowed: Partial<Pick<UserEntity, 'displayName' | 'passwordHash' | 'status' | 'authVersion'>> = {};
      if (displayName !== undefined) allowed.displayName = displayName;
      if (passwordHash !== undefined) allowed.passwordHash = passwordHash;
      if (dto.status !== undefined) allowed.status = dto.status;
      const securityChanged = passwordHash !== undefined
        || (dto.status !== undefined && dto.status !== user.status);
      if (securityChanged) {
        allowed.authVersion = user.authVersion + 1;
        await this.authService.revokeBrowserSessionsInTransaction(manager, id);
      }
      if (Object.keys(allowed).length > 0) await manager.update(UserEntity, id, allowed);
      return manager.findOneByOrFail(UserEntity, { id });
    });
    if (dto.status !== undefined) this.accessResolver.invalidateUser(id);
    await this.notifyProxySnapshotsChanged('user-updated');
    if (actorId !== undefined) {
      await this.auditBestEffort(actorId, AuditAction.UpdateUser, id, {
        displayNameChanged: dto.displayName !== undefined,
        passwordChanged: dto.password !== undefined,
        status: dto.status,
      });
    }
    return saved;
  }

  /** Self-service update with a password-generation CAS to close verify/update races. */
  async updateSelf(
    id: string,
    dto: { displayName?: string; password?: string },
    currentPassword?: string,
  ): Promise<UserEntity> {
    const displayName = dto.displayName === undefined
      ? undefined
      : this.normalizeDisplayName(dto.displayName);
    let snapshot: UserEntity | null = null;
    let passwordHash: string | undefined;
    if (dto.password !== undefined) {
      if (!currentPassword) throw new BadRequestException('Current password is required');
      if (dto.password.length < 8 || dto.password.length > 256 || currentPassword.length > 1_024) {
        throw new BadRequestException('Password input is outside the supported bounds');
      }
      snapshot = await this.usersRepo.findOne({ where: { id } });
      if (!snapshot || snapshot.status !== UserStatus.Active) {
        throw new UnauthorizedException('Current password is incorrect');
      }
      if (!await this.authService.verifyPassword(snapshot.passwordHash, currentPassword)) {
        throw new UnauthorizedException('Current password is incorrect');
      }
      passwordHash = await this.authService.hashPassword(dto.password);
    }

    const saved = await runSerializedTransaction(this.dataSource, async (manager) => {
      const user = await manager.findOneBy(UserEntity, { id });
      if (!user || user.status !== UserStatus.Active) throw new NotFoundException('User not found');
      if (snapshot && (
        user.passwordHash !== snapshot.passwordHash
        || user.authVersion !== snapshot.authVersion
        || user.status !== snapshot.status
      )) {
        throw new UnauthorizedException('Credentials changed while the request was being processed');
      }
      const allowed: Partial<Pick<UserEntity, 'displayName' | 'passwordHash' | 'authVersion'>> = {};
      if (displayName !== undefined) allowed.displayName = displayName;
      if (passwordHash !== undefined) {
        allowed.passwordHash = passwordHash;
        allowed.authVersion = user.authVersion + 1;
        await this.authService.revokeBrowserSessionsInTransaction(manager, id);
      }
      if (Object.keys(allowed).length > 0) await manager.update(UserEntity, id, allowed);
      return manager.findOneByOrFail(UserEntity, { id });
    });
    await this.notifyProxySnapshotsChanged('user-updated');
    await this.auditBestEffort(id, AuditAction.UpdateUser, id, {
      displayNameChanged: dto.displayName !== undefined,
      passwordChanged: dto.password !== undefined,
      selfService: true,
    });
    return saved;
  }

  async ensureAdminExists(
    addToAdminsGroup: (userId: string) => Promise<void>,
    hasAlternativeAdministrator: (excludedUserId?: string) => Promise<boolean>,
  ): Promise<void> {
    const adminExists = await this.usersRepo.findOne({ where: { username: 'admin' } });
    if (adminExists) {
      if (adminExists.status !== UserStatus.Active) {
        if (!await hasAlternativeAdministrator(adminExists.id)) {
          throw new ConflictException({
            code: 'ADMIN_BOOTSTRAP_UNAVAILABLE',
            message: 'The reserved admin account is inactive and no alternative active administrator exists',
          });
        }
        return;
      }
      // Repair a missing membership on every bootstrap. addMember is idempotent.
      await addToAdminsGroup(adminExists.id);
      return;
    }
    {
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
      }, {
        systemGroupKey: SystemGroupKey.Administrators,
        actorId: null,
      });
      await addToAdminsGroup(user.id);
    }
  }

  // SSH Keys

  async listSshKeys(userId: string): Promise<SshPublicKeyEntity[]> {
    return this.sshKeysRepo.find({ where: { userId } });
  }

  async addSshKey(
    userId: string,
    name: string,
    keyText: string,
    actorId: string,
  ): Promise<SshPublicKeyEntity> {
    const normalizedName = name.trim();
    if (normalizedName.length === 0 || normalizedName.length > 128) {
      throw new BadRequestException('SSH key name must contain 1-128 non-whitespace characters');
    }
    const normalizedKeyText = normalizeOpenSshPublicKey(keyText);
    if (!normalizedKeyText) throw new BadRequestException('Invalid OpenSSH public key');
    if (normalizedKeyText.length > MAX_SSH_PUBLIC_KEY_TEXT_LENGTH) {
      throw new BadRequestException(
        `SSH public key must not exceed ${MAX_SSH_PUBLIC_KEY_TEXT_LENGTH} characters`,
      );
    }

    const saved = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId !== userId) {
        await this.accessResolver.assertActorMayAdministerUserInTransaction(
          manager,
          actorId,
          userId,
        );
      }
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
        name: normalizedName,
        keyText: normalizedKeyText,
        createdAt: new Date(),
      }));
    });
    await this.auditBestEffort(
      actorId,
      AuditAction.AddUserSshPublicKey,
      saved.id,
      this.sshPublicKeyAuditDetails(saved),
      'ssh_public_key',
    );
    await this.notifyProxySnapshotsChanged('user-ssh-key-added');
    return saved;
  }

  async deleteSshKey(userId: string, keyId: string, actorId: string): Promise<void> {
    const deleted = await runSerializedTransaction(this.dataSource, async (manager) => {
      if (actorId !== userId) {
        await this.accessResolver.assertActorMayAdministerUserInTransaction(
          manager,
          actorId,
          userId,
        );
      }
      const target = await manager.findOneBy(UserEntity, { id: userId });
      if (!target || target.status === UserStatus.Deleted) {
        throw new NotFoundException('User not found');
      }
      if (target.status === UserStatus.Deleting) {
        throw new ConflictException({
          code: 'USER_DELETING',
          message: 'SSH keys cannot be changed while the user is being deleted',
          userId,
        });
      }
      if (actorId === userId && target.status !== UserStatus.Active) {
        throw new ConflictException('SSH keys require an active user');
      }
      const key = await manager.findOne(SshPublicKeyEntity, { where: { id: keyId, userId } });
      if (!key) throw new NotFoundException('SSH key not found');
      await manager.delete(SshPublicKeyEntity, { id: key.id, userId });
      return key;
    });
    await this.auditBestEffort(
      actorId,
      AuditAction.DeleteUserSshPublicKey,
      deleted.id,
      this.sshPublicKeyAuditDetails(deleted),
      'ssh_public_key',
    );
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

  private async auditBestEffort(
    actorId: string | null,
    action: AuditAction,
    targetId: string,
    details: unknown,
    targetType = 'user',
  ): Promise<void> {
    try {
      await this.auditService.log(actorId, action, targetId, targetType, details);
    } catch (error) {
      this.logger.warn(
        `Audit write failed after user mutation ${targetId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private sshPublicKeyAuditDetails(key: SshPublicKeyEntity): {
    userId: string;
    name: string;
    algorithm: string;
    fingerprint: string | null;
  } {
    const normalized = normalizeOpenSshPublicKey(key.keyText);
    const [algorithm = 'unknown', encoded = ''] = normalized?.split(' ', 2) ?? [];
    let fingerprint: string | null = null;
    try {
      if (encoded.length > 0) {
        fingerprint = `SHA256:${createHash('sha256')
          .update(Buffer.from(encoded, 'base64'))
          .digest('base64')
          .replace(/=+$/, '')}`;
      }
    } catch {
      // Legacy rows may predate strict key normalization. Audit the operation
      // without ever copying their raw key text into the event.
    }
    return {
      userId: key.userId,
      name: key.name,
      algorithm,
      fingerprint,
    };
  }

  private normalizeDisplayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 128) {
      throw new BadRequestException('Display name must contain 1-128 non-whitespace characters');
    }
    return normalized;
  }
}
