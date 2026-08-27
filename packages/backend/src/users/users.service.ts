import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  AuditAction,
  Capability,
  MAX_PLATFORM_ACTIVE_USERS,
  MAX_SSH_PUBLIC_KEYS_PER_USER,
  MAX_SSH_PUBLIC_KEY_TEXT_LENGTH,
  normalizeOpenSshPublicKey,
  SystemGroupKey,
  type UserDto,
  UserStatus,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AuthService } from '../auth/auth.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { ContainerSshConvergenceService } from '../ssh/container-ssh-convergence.service.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { AuditService } from '../audit/audit.service.js';

export const MAX_LIFETIME_USERS = 4_096;

/** Lowest free id in 1..=4096. max(numeric_id)+1 is wrong once nyabase-system occupies 4096. */
export function pickNextUserNumericId(used: Iterable<number>): number | null {
  const occupied = new Set<number>();
  for (const id of used) occupied.add(Number(id));
  for (let id = 1; id <= MAX_LIFETIME_USERS; id += 1) {
    if (!occupied.has(id)) return id;
  }
  return null;
}

interface CreateUserOptions {
  systemGroupKey?: SystemGroupKey;
  actorId?: string | null;
}

export interface IamUser {
  id: string;
  numericId: number;
  username: string;
  passwordHash: string;
  displayName: string;
  status: UserStatus;
  authVersion: number;
  authzVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IamSshPublicKey {
  id: string;
  userId: string;
  name: string;
  keyText: string;
  fingerprint: string;
  createdAt: Date;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly authService: AuthService,
    @Inject(forwardRef(() => AccessResolverService))
    private readonly accessResolver: AccessResolverService,
    private readonly containerSshConvergence: ContainerSshConvergenceService,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
    private readonly config: NyabaseConfigService,
    @Inject(forwardRef(() => AuditService))
    private readonly auditService: AuditService,
  ) {}

  async createUser(
    dto: { username: string; password: string; displayName: string },
    options: CreateUserOptions = {},
  ): Promise<IamUser> {
    if (dto.username.length < 2 || dto.username.length > 64
      || !/^[a-z0-9_-]+$/.test(dto.username)) {
      throw new BadRequestException(
        'Username must contain 2-64 lowercase letters, digits, _ or -',
      );
    }
    const displayName = this.normalizeDisplayName(dto.displayName);
    if (dto.password.length < 8 || dto.password.length > 256) {
      throw new BadRequestException('Password must contain 8-256 characters');
    }
    const passwordHash = await this.authService.hashPassword(dto.password);
    const userId = uuidv4();

    const user = await this.transactions.run(async (transaction) => {
      // One durable row serializes capacity and numeric identity allocation
      // across API replicas without broad SERIALIZABLE transactions.
      await transaction.selectFrom('iam.policy_state')
        .select(['singleton'])
        .where('singleton', '=', true)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const occupied = await transaction.selectFrom('iam.users')
        .select('numeric_id')
        .execute();
      const nextNumericId = pickNextUserNumericId(
        occupied.map((row) => row.numeric_id),
      );
      if (typeof options.actorId === 'string') {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction,
          options.actorId,
          [Capability.ManageUsers],
        );
      }
      if (await transaction.selectFrom('iam.users')
        .select('id')
        .where('username', '=', dto.username)
        .executeTakeFirst()) {
        throw new ConflictException('Username already exists');
      }
      const counts = await transaction.selectFrom('iam.users')
        .select([
          sql<number>`count(*)::integer`.as('total'),
          sql<number>`count(*) FILTER (WHERE status = ${UserStatus.Active})::integer`
            .as('active'),
        ])
        .executeTakeFirstOrThrow();
      if (counts.total >= MAX_LIFETIME_USERS || nextNumericId === null) {
        throw new ConflictException({
          code: 'USER_LIFETIME_CAPACITY_REACHED',
          message: `At most ${MAX_LIFETIME_USERS} lifetime users are supported`,
        });
      }
      if (counts.active >= MAX_PLATFORM_ACTIVE_USERS) {
        throw new ConflictException({
          code: 'USER_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_ACTIVE_USERS} active users are supported`,
        });
      }
      const now = new Date();
      const inserted = await transaction.insertInto('iam.users').values({
        id: userId,
        numeric_id: nextNumericId,
        username: dto.username,
        password_hash: passwordHash,
        display_name: displayName,
        status: UserStatus.Active,
        auth_version: 0,
        authz_version: 0,
        created_at: now,
        updated_at: now,
      }).returningAll().executeTakeFirstOrThrow();
      await transaction.updateTable('iam.policy_state').set({
        policy_epoch: sql`policy_epoch + 1`,
        updated_at: now,
      }).where('singleton', '=', true).executeTakeFirstOrThrow();
      if (options.systemGroupKey) {
        const group = await transaction.selectFrom('iam.groups')
          .select(['id', 'capabilities'])
          .where('system_key', '=', options.systemGroupKey)
          .where('is_system', '=', true)
          .executeTakeFirst();
        if (!group) {
          throw new ConflictException({
            code: 'SYSTEM_GROUP_MISSING',
            message: `Required built-in group is unavailable: ${options.systemGroupKey}`,
          });
        }
        const grantCounts = await Promise.all([
          transaction.selectFrom('iam.server_grants').select('id')
            .where('group_id', '=', group.id).execute(),
          transaction.selectFrom('iam.storage_pool_grants').select('id')
            .where('group_id', '=', group.id).execute(),
          transaction.selectFrom('iam.shared_backend_grants').select('id')
            .where('group_id', '=', group.id).execute(),
        ]);
        if (typeof options.actorId === 'string') {
          await this.accessResolver.assertActorCapabilitiesInTransaction(
            transaction,
            options.actorId,
            [
              ...(group.capabilities as Capability[]),
              ...(grantCounts.some((rows) => rows.length > 0)
                ? [Capability.ManageGrants]
                : []),
            ],
          );
        }
        await transaction.insertInto('iam.group_members').values({
          id: uuidv4(),
          group_id: group.id,
          user_id: userId,
        }).executeTakeFirstOrThrow();
      }
      const user = this.toUser(inserted);
      if (options.actorId !== undefined) {
        await this.auditService.append(
          transaction,
          options.actorId,
          AuditAction.CreateUser,
          user.id,
          'user',
          {
            username: user.username,
            displayName: user.displayName,
            systemGroupKey: options.systemGroupKey ?? null,
          },
        );
      }
      return user;
    });
    await this.accessResolver.authorizationCommitted([user.id]);
    return user;
  }

  async findById(id: string): Promise<IamUser> {
    const row = await this.database.selectFrom('iam.users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || row.status === UserStatus.Deleted) {
      throw new NotFoundException('User not found');
    }
    return this.toUser(row);
  }

  async findAll(): Promise<IamUser[]> {
    const rows = await this.database.selectFrom('iam.users')
      .selectAll()
      .where('status', '!=', UserStatus.Deleted)
      .orderBy('username')
      .execute();
    return rows.map((row) => this.toUser(row));
  }

  /**
   * Administrative collection projection. Keep this separate from `toDto`:
   * detail reads may profit from the full authorization cache, while a list
   * must never fill that cache once per user.
   */
  async listDtos(): Promise<UserDto[]> {
    const [users, memberships] = await Promise.all([
      this.database.selectFrom('iam.users')
        .select(['id', 'username', 'display_name', 'status', 'created_at'])
        .where('status', '!=', UserStatus.Deleted)
        .orderBy('username')
        .orderBy('id')
        .execute(),
      this.database.selectFrom('iam.group_members as membership')
        .innerJoin('iam.groups as group', 'group.id', 'membership.group_id')
        .select([
          'membership.user_id',
          'group.id',
          'group.name',
          'group.priority',
          'group.is_system',
          'group.capabilities',
        ])
        .innerJoin('iam.users as user', 'user.id', 'membership.user_id')
        .where('user.status', '=', UserStatus.Active)
        .orderBy('membership.user_id')
        .orderBy('group.priority', 'desc')
        .orderBy('group.id', 'desc')
        .execute(),
    ]);
    const groupsByUser = new Map<string, UserDto['groups']>();
    const capabilitiesByUser = new Map<string, Set<Capability>>();
    for (const membership of memberships) {
      const groups = groupsByUser.get(membership.user_id) ?? [];
      groups.push({
        id: membership.id,
        name: membership.name,
        priority: membership.priority,
        isSystem: membership.is_system,
      });
      groupsByUser.set(membership.user_id, groups);
      const capabilities = capabilitiesByUser.get(membership.user_id) ?? new Set<Capability>();
      for (const capability of membership.capabilities as Capability[]) {
        capabilities.add(capability);
      }
      capabilitiesByUser.set(membership.user_id, capabilities);
    }
    return users.map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      status: user.status as UserStatus,
      createdAt: user.created_at.toISOString(),
      capabilities: [...(capabilitiesByUser.get(user.id) ?? [])],
      groups: groupsByUser.get(user.id) ?? [],
    }));
  }

  async findByIds(ids: string[]): Promise<IamUser[]> {
    if (ids.length === 0) return [];
    const rows = await this.database.selectFrom('iam.users')
      .selectAll()
      .where('id', 'in', [...new Set(ids)])
      .execute();
    return rows.map((row) => this.toUser(row));
  }

  async updateUser(
    id: string,
    dto: { displayName?: string; password?: string; status?: UserStatus },
    actorId?: string,
  ): Promise<IamUser> {
    const displayName = dto.displayName === undefined
      ? undefined
      : this.normalizeDisplayName(dto.displayName);
    if (dto.password !== undefined && (dto.password.length < 8 || dto.password.length > 256)) {
      throw new BadRequestException('Password must contain 8-256 characters');
    }
    const passwordHash = dto.password
      ? await this.authService.hashPassword(dto.password)
      : undefined;
    const saved = await this.transactions.run(async (transaction) => {
      const user = await transaction.selectFrom('iam.users')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw new NotFoundException('User not found');
      if (user.status === UserStatus.Deleted || user.status === UserStatus.Deleting) {
        throw new ConflictException({
          code: user.status === UserStatus.Deleted ? 'USER_DELETED' : 'USER_DELETING',
          message: 'A deleted or deleting user cannot be updated',
          userId: id,
        });
      }
      if (actorId) {
        await this.accessResolver.assertActorMayAdministerUserInTransaction(
          transaction,
          actorId,
          id,
        );
      }
      if (dto.status === UserStatus.Deleted || dto.status === UserStatus.Deleting) {
        throw new BadRequestException({
          code: 'USER_DELETED_STATUS_RESERVED',
          message: 'Deleted is reserved for the DELETE endpoint',
        });
      }
      if (user.status === UserStatus.Active
        && dto.status !== undefined
        && dto.status !== UserStatus.Active) {
        await this.accessResolver.assertNotFinalActiveAdministratorInTransaction(
          transaction,
          id,
        );
      }
      if (dto.status === UserStatus.Active && user.status !== UserStatus.Active) {
        await transaction.selectFrom('iam.policy_state')
          .select('policy_epoch')
          .where('singleton', '=', true)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const active = await transaction.selectFrom('iam.users')
          .select(sql<number>`count(*)::integer`.as('count'))
          .where('status', '=', UserStatus.Active)
          .executeTakeFirstOrThrow();
        if (active.count >= MAX_PLATFORM_ACTIVE_USERS) {
          throw new ConflictException({
            code: 'USER_CAPACITY_REACHED',
            message: `At most ${MAX_PLATFORM_ACTIVE_USERS} active users are supported`,
          });
        }
      }
      const securityChanged = passwordHash !== undefined
        || (dto.status !== undefined && dto.status !== user.status);
      if (securityChanged) {
        await this.authService.revokeBrowserSessionsInTransaction(transaction, id);
      }
      const updated = await transaction.updateTable('iam.users').set({
        ...(displayName !== undefined ? { display_name: displayName } : {}),
        ...(passwordHash !== undefined ? { password_hash: passwordHash } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(securityChanged ? { auth_version: user.auth_version + 1 } : {}),
        updated_at: new Date(),
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (securityChanged) {
        await sql`SELECT iam.bump_policy_epoch()`.execute(transaction);
      }
      const saved = this.toUser(updated);
      if (actorId !== undefined) {
        await this.auditService.append(
          transaction,
          actorId,
          AuditAction.UpdateUser,
          id,
          'user',
          {
            displayNameChanged: dto.displayName !== undefined,
            passwordChanged: dto.password !== undefined,
            status: dto.status,
          },
        );
      }
      return saved;
    });
    if (dto.status !== undefined || passwordHash !== undefined) {
      await this.accessResolver.authorizationCommitted([id]);
    }
    await this.notifyProxySnapshotsChanged('user-updated');
    return saved;
  }

  async updateSelf(
    id: string,
    dto: { displayName?: string; password?: string },
    currentPassword?: string,
  ): Promise<IamUser> {
    const displayName = dto.displayName === undefined
      ? undefined
      : this.normalizeDisplayName(dto.displayName);
    let snapshot: IamUser | null = null;
    let passwordHash: string | undefined;
    if (dto.password !== undefined) {
      if (!currentPassword) throw new BadRequestException('Current password is required');
      if (dto.password.length < 8 || dto.password.length > 256
        || currentPassword.length > 1_024) {
        throw new BadRequestException('Password input is outside the supported bounds');
      }
      const row = await this.database.selectFrom('iam.users')
        .selectAll().where('id', '=', id).executeTakeFirst();
      snapshot = row ? this.toUser(row) : null;
      if (!snapshot || snapshot.status !== UserStatus.Active
        || !await this.authService.verifyPassword(snapshot.passwordHash, currentPassword)) {
        throw new UnauthorizedException('Current password is incorrect');
      }
      passwordHash = await this.authService.hashPassword(dto.password);
    }
    const saved = await this.transactions.run(async (transaction) => {
      const user = await transaction.selectFrom('iam.users')
        .selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!user || user.status !== UserStatus.Active) {
        throw new NotFoundException('User not found');
      }
      if (snapshot && (
        user.password_hash !== snapshot.passwordHash
        || user.auth_version !== snapshot.authVersion
        || user.status !== snapshot.status
      )) throw new UnauthorizedException('Credentials changed while the request was being processed');
      if (passwordHash !== undefined) {
        await this.authService.revokeBrowserSessionsInTransaction(transaction, id);
      }
      const updated = await transaction.updateTable('iam.users').set({
        ...(displayName !== undefined ? { display_name: displayName } : {}),
        ...(passwordHash !== undefined ? {
          password_hash: passwordHash,
          auth_version: user.auth_version + 1,
        } : {}),
        updated_at: new Date(),
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (passwordHash !== undefined) {
        await sql`SELECT iam.bump_policy_epoch()`.execute(transaction);
      }
      const saved = this.toUser(updated);
      await this.auditService.append(
        transaction,
        id,
        AuditAction.UpdateUser,
        id,
        'user',
        {
          displayNameChanged: dto.displayName !== undefined,
          passwordChanged: dto.password !== undefined,
          selfService: true,
        },
      );
      return saved;
    });
    if (passwordHash !== undefined) await this.accessResolver.authorizationCommitted([id]);
    await this.notifyProxySnapshotsChanged('user-updated');
    return saved;
  }

  async ensureAdminExists(
    ensureAdministratorMembership: (userId: string) => Promise<void>,
  ): Promise<void> {
    let admin = await this.database.selectFrom('iam.users')
      .selectAll()
      .where('username', '=', 'admin')
      .executeTakeFirst();
    if (admin) {
      if (admin.status !== UserStatus.Active) {
        if (!await this.hasAlternativeAdministrator(admin.id)) {
          throw new ConflictException({
            code: 'ADMIN_BOOTSTRAP_UNAVAILABLE',
            message: 'The reserved admin account is inactive and no alternative active administrator exists',
          });
        }
        return;
      }
      await ensureAdministratorMembership(admin.id);
      return;
    }
    const isProd = this.config.get<string>('runtime.nodeEnv') === 'production';
    let initPassword = this.config.get<string>('auth.adminInitPassword');
    let generatedInitPassword = false;
    if (!initPassword) {
      if (isProd) {
        const { randomBytes } = await import('crypto');
        initPassword = randomBytes(12).toString('hex');
        generatedInitPassword = true;
      } else {
        initPassword = 'admin123';
      }
    }
    try {
      await this.createUser({
        username: 'admin',
        password: initPassword,
        displayName: 'Administrator',
      }, {
        systemGroupKey: SystemGroupKey.Administrators,
        actorId: null,
      });
      if (generatedInitPassword) {
        this.logger.warn(`Generated one-time admin password: ${initPassword}`);
      }
      return;
    } catch (error) {
      if (!this.isUniqueViolation(error) && !this.isUsernameConflict(error)) throw error;
      admin = await this.database.selectFrom('iam.users')
        .selectAll().where('username', '=', 'admin').executeTakeFirst();
      if (!admin || admin.status !== UserStatus.Active) throw error;
      await ensureAdministratorMembership(admin.id);
    }
  }

  async listSshKeys(userId: string): Promise<IamSshPublicKey[]> {
    const rows = await this.database.selectFrom('iam.ssh_public_keys')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute();
    return rows.map((row) => this.toSshKey(row));
  }

  async addSshKey(
    userId: string,
    name: string,
    keyText: string,
    actorId: string,
  ): Promise<IamSshPublicKey> {
    const normalizedName = name.trim();
    if (normalizedName.length === 0 || normalizedName.length > 128) {
      throw new BadRequestException(
        'SSH key name must contain 1-128 non-whitespace characters',
      );
    }
    const normalizedKeyText = normalizeOpenSshPublicKey(keyText);
    if (!normalizedKeyText) throw new BadRequestException('Invalid OpenSSH public key');
    if (normalizedKeyText.length > MAX_SSH_PUBLIC_KEY_TEXT_LENGTH) {
      throw new BadRequestException(
        `SSH public key must not exceed ${MAX_SSH_PUBLIC_KEY_TEXT_LENGTH} characters`,
      );
    }
    const fingerprint = this.publicKeyFingerprint(normalizedKeyText)
      ?? createHash('sha256').update(normalizedKeyText).digest('hex');
    const saved = await this.transactions.run(async (transaction) => {
      if (actorId !== userId) {
        await this.accessResolver.assertActorMayAdministerUserInTransaction(
          transaction,
          actorId,
          userId,
        );
      }
      const user = await transaction.selectFrom('iam.users')
        .select('status').where('id', '=', userId).forUpdate().executeTakeFirst();
      if (!user || user.status !== UserStatus.Active) {
        throw new ConflictException('SSH keys require an active user');
      }
      const count = await transaction.selectFrom('iam.ssh_public_keys')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      if (count.count >= MAX_SSH_PUBLIC_KEYS_PER_USER) {
        throw new ConflictException({
          code: 'SSH_PUBLIC_KEY_CAPACITY_REACHED',
          message: `At most ${MAX_SSH_PUBLIC_KEYS_PER_USER} SSH public keys are supported per user`,
        });
      }
      const row = await transaction.insertInto('iam.ssh_public_keys').values({
        id: uuidv4(),
        user_id: userId,
        name: normalizedName,
        key_text: normalizedKeyText,
        fingerprint,
        created_at: new Date(),
      }).returningAll().executeTakeFirstOrThrow();
      const saved = this.toSshKey(row);
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.AddUserSshPublicKey,
        saved.id,
        'ssh_public_key',
        this.sshPublicKeyAuditDetails(saved),
      );
      return saved;
    });
    await this.notifyProxySnapshotsChanged('user-ssh-key-added');
    try {
      await this.containerSshConvergence.reconcileUser(userId);
    } catch (error) {
      this.logger.warn(
        `SSH key change hook enqueue failed for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return saved;
  }

  async deleteSshKey(userId: string, keyId: string, actorId: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      if (actorId !== userId) {
        await this.accessResolver.assertActorMayAdministerUserInTransaction(
          transaction,
          actorId,
          userId,
        );
      }
      const user = await transaction.selectFrom('iam.users')
        .select('status').where('id', '=', userId).executeTakeFirst();
      if (!user || user.status === UserStatus.Deleted) {
        throw new NotFoundException('User not found');
      }
      if (user.status === UserStatus.Deleting) {
        throw new ConflictException({
          code: 'USER_DELETING',
          message: 'SSH keys cannot be changed while the user is being deleted',
          userId,
        });
      }
      if (actorId === userId && user.status !== UserStatus.Active) {
        throw new ConflictException('SSH keys require an active user');
      }
      const key = await transaction.deleteFrom('iam.ssh_public_keys')
        .where('id', '=', keyId)
        .where('user_id', '=', userId)
        .returningAll()
        .executeTakeFirst();
      if (!key) throw new NotFoundException('SSH key not found');
      const deleted = this.toSshKey(key);
      await this.auditService.append(
        transaction,
        actorId,
        AuditAction.DeleteUserSshPublicKey,
        deleted.id,
        'ssh_public_key',
        this.sshPublicKeyAuditDetails(deleted),
      );
      return deleted;
    });
    await this.notifyProxySnapshotsChanged('user-ssh-key-deleted');
    try {
      await this.containerSshConvergence.reconcileUser(userId);
    } catch (error) {
      this.logger.warn(
        `SSH key change hook enqueue failed for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async getUserSshKeyTexts(userId: string): Promise<string[]> {
    return (await this.listSshKeys(userId)).map((key) => key.keyText);
  }

  async toDto(user: IamUser): Promise<UserDto> {
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
      capabilities: [...capabilities],
      groups,
    };
  }

  private async notifyProxySnapshotsChanged(reason: string): Promise<void> {
    try {
      await this.proxySnapshots.notify(reason);
    } catch (error) {
      this.logger.warn(
        `Proxy snapshot notification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private sshPublicKeyAuditDetails(key: IamSshPublicKey): {
    userId: string;
    name: string;
    algorithm: string;
    fingerprint: string | null;
  } {
    const normalized = normalizeOpenSshPublicKey(key.keyText);
    const [algorithm = 'unknown'] = normalized?.split(' ', 2) ?? [];
    return {
      userId: key.userId,
      name: key.name,
      algorithm,
      fingerprint: this.publicKeyFingerprint(key.keyText),
    };
  }

  private publicKeyFingerprint(keyText: string): string | null {
    const normalized = normalizeOpenSshPublicKey(keyText);
    const [, encoded = ''] = normalized?.split(' ', 2) ?? [];
    try {
      return encoded
        ? `SHA256:${createHash('sha256').update(Buffer.from(encoded, 'base64'))
          .digest('base64').replace(/=+$/, '')}`
        : null;
    } catch {
      return null;
    }
  }

  private normalizeDisplayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 128) {
      throw new BadRequestException(
        'Display name must contain 1-128 non-whitespace characters',
      );
    }
    return normalized;
  }

  private async hasAlternativeAdministrator(excludedUserId?: string): Promise<boolean> {
    const query = this.database.selectFrom('iam.group_members as member')
      .innerJoin('iam.groups as group', 'group.id', 'member.group_id')
      .innerJoin('iam.users as user', 'user.id', 'member.user_id')
      .select('user.id')
      .where('group.system_key', '=', SystemGroupKey.Administrators)
      .where('group.is_system', '=', true)
      .where('user.status', '=', UserStatus.Active);
    const row = excludedUserId
      ? await query.where('user.id', '!=', excludedUserId).executeTakeFirst()
      : await query.executeTakeFirst();
    return row !== undefined;
  }

  private toUser(row: {
    id: string;
    numeric_id: number;
    username: string;
    password_hash: string;
    display_name: string;
    status: string;
    auth_version: number;
    authz_version: string;
    created_at: Date;
    updated_at: Date;
  }): IamUser {
    return {
      id: row.id,
      numericId: row.numeric_id,
      username: row.username,
      passwordHash: row.password_hash,
      displayName: row.display_name,
      status: row.status as UserStatus,
      authVersion: row.auth_version,
      authzVersion: String(row.authz_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toSshKey(row: {
    id: string;
    user_id: string;
    name: string;
    key_text: string;
    fingerprint: string;
    created_at: Date;
  }): IamSshPublicKey {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      keyText: row.key_text,
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(error && typeof error === 'object'
      && (error as { code?: unknown }).code === '23505');
  }

  private isUsernameConflict(error: unknown): boolean {
    return error instanceof ConflictException && error.message === 'Username already exists';
  }
}
