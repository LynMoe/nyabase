import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'crypto';
import {
  AuditAction,
  MAX_SSH_PUBLIC_KEYS_PER_USER,
  MAX_SSH_PUBLIC_KEY_TEXT_LENGTH,
  normalizeOpenSshPublicKey,
  Role,
  UserStatus,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { assertActorRole } from '../iam/administration.js';
import { requireUserId, type Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { AuthService, currentPasswordIncorrect } from '../iam/auth.service.js';
import { ContainerSshConvergenceService } from '../containers/container-ssh.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';

export interface IamSshPublicKey {
  id: string;
  userId: string;
  name: string;
  keyText: string;
  fingerprint: string;
  createdAt: Date;
}


export const SSH_KEY_IN_USE = 'SSH_KEY_IN_USE';

function isFingerprintTaken(error: unknown): boolean {
  const record = error as { code?: unknown; constraint?: unknown } | null;
  return record?.code === '23505' && record.constraint === 'ssh_public_keys_fingerprint_key';
}

/** A user's SSH public keys: list, add and remove, with the proxy and guest follow-ups. */
@Injectable()
export class UserSshKeysService {
  private readonly logger = new Logger(UserSshKeysService.name);

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly containerSshConvergence: ContainerSshConvergenceService,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
    private readonly auditService: AuditService,
    private readonly authService: AuthService,
  ) {}

  async listSshKeys(userId: string): Promise<IamSshPublicKey[]> {
    const rows = await this.database.selectFrom('iam.ssh_public_keys')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute();
    return rows.map((row) => this.toSshKey(row));
  }

  /**
   * Adds a key for the signed-in user. A key reaches every one of the user's
   * containers as root and outlives sessions, so like an API token it needs a
   * browser session plus the current password, checked again under the row
   * lock against the same credential generation.
   */
  async addSshKey(
    actor: Actor,
    name: string,
    keyText: string,
    currentPassword: string,
  ): Promise<IamSshPublicKey> {
    const userId = requireUserId(actor);
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
    const snapshot = await this.database.selectFrom('iam.users')
      .select(['id', 'status', 'password_hash', 'auth_version'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!snapshot || snapshot.status !== UserStatus.Active) {
      throw new ConflictException('SSH keys require an active user');
    }
    if (!await this.authService.verifyCurrentPassword(
      { id: snapshot.id, passwordHash: snapshot.password_hash },
      currentPassword,
    )) {
      throw currentPasswordIncorrect();
    }
    const saved = await this.transactions.run(async (transaction) => {
      const user = await transaction.selectFrom('iam.users')
        .select(['status', 'password_hash', 'auth_version'])
        .where('id', '=', userId).forUpdate().executeTakeFirst();
      if (!user || user.status !== UserStatus.Active) {
        throw new ConflictException('SSH keys require an active user');
      }
      if (user.password_hash !== snapshot.password_hash || user.auth_version !== snapshot.auth_version) {
        throw new UnauthorizedException('Credentials changed while the request was being processed');
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
        id: randomUUID(),
        user_id: userId,
        name: normalizedName,
        key_text: normalizedKeyText,
        fingerprint,
        created_at: new Date(),
      }).returningAll().executeTakeFirstOrThrow().catch((error: unknown) => {
        // The SSH proxy resolves the user from the key, so a key belongs to
        // exactly one user. The answer does not say whose key it is.
        if (isFingerprintTaken(error)) {
          throw new ConflictException({
            code: SSH_KEY_IN_USE,
            message: 'This SSH public key is already in use',
          });
        }
        throw error;
      });
      const saved = this.toSshKey(row);
      await this.auditService.append(
        transaction,
        userId,
        AuditAction.AddUserSshPublicKey,
        saved.id,
        'ssh_public_key',
        this.sshPublicKeyAuditDetails(saved),
      );
      return saved;
    });
    await this.afterKeysChanged(userId, 'user-ssh-key-added');
    return saved;
  }

  async deleteSshKey(userId: string, keyId: string, actorId: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      if (actorId !== userId) {
        await assertActorRole(transaction, actorId, Role.Admin);
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
    await this.afterKeysChanged(userId, 'user-ssh-key-deleted');
  }

  private async afterKeysChanged(userId: string, reason: string): Promise<void> {
    await this.notifyProxySnapshotsChanged(reason);
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
}
