import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  AuditAction,
  UserStatus,
  type UserInternalSshKeyDto,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import type { IamTransaction } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SshKeyCryptoService } from '../ssh/ssh-key-crypto.service.js';
import { SshKeygenService } from '../ssh/ssh-keygen.service.js';

export interface PreparedUserSshKey {
  userId: string;
  encryptedPrivateKey: string;
  publicKey: string;
  fingerprint: string;
  generation: number;
  rotatedAt: Date;
}

@Injectable()
export class UserSshIdentityService {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly keygen: SshKeygenService,
    private readonly crypto: SshKeyCryptoService,
    private readonly audit: AuditService,
  ) {}

  prepareUserKey(user: { id: string; username: string }): Promise<PreparedUserSshKey> {
    return this.generate(user, 1);
  }

  async savePreparedUserKeyInTransaction(
    transaction: IamTransaction,
    user: { id: string },
    key: PreparedUserSshKey,
  ): Promise<PreparedUserSshKey> {
    if (key.userId !== user.id || key.generation !== 1) {
      throw new ConflictException('Prepared user SSH key does not match the new user');
    }
    await transaction.insertInto('iam.user_internal_ssh_keys').values({
      user_id: key.userId,
      encrypted_private_key: key.encryptedPrivateKey,
      public_key: key.publicKey,
      fingerprint: key.fingerprint,
      generation: key.generation,
      rotated_at: key.rotatedAt,
    }).executeTakeFirstOrThrow();
    return key;
  }

  async getUserKeyDto(
    userId: string,
    actorId: string,
    includePrivate: boolean,
    authorize: (transaction: IamTransaction) => Promise<void>,
  ): Promise<UserInternalSshKeyDto> {
    const key = await this.transactions.run(async (transaction) => {
      await authorize(transaction);
      await this.assertUserKeyAvailable(transaction, userId);
      const current = await transaction.selectFrom('iam.user_internal_ssh_keys')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!current) throw new ConflictException('User internal SSH key invariant is missing');
      if (includePrivate) {
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.ViewUserInternalSshKey,
          userId,
          'user',
          { generation: current.generation },
        );
      }
      return current;
    });
    return this.toDto(key, includePrivate);
  }

  async rotateUserKey(
    userId: string,
    actorId: string,
    authorize: (transaction: IamTransaction) => Promise<void>,
  ): Promise<UserInternalSshKeyDto> {
    const snapshot = await this.transactions.run(async (transaction) => {
      await authorize(transaction);
      const user = await this.assertUserKeyAvailable(transaction, userId);
      const existing = await transaction.selectFrom('iam.user_internal_ssh_keys')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!existing) throw new ConflictException('User internal SSH key invariant is missing');
      return { user, existing };
    });
    const next = await this.generate(
      { id: snapshot.user.id, username: snapshot.user.username },
      snapshot.existing.generation + 1,
    );
    await this.transactions.run(async (transaction) => {
      await authorize(transaction);
      await this.assertUserKeyAvailable(transaction, userId);
      const updated = await transaction.updateTable('iam.user_internal_ssh_keys').set({
        encrypted_private_key: next.encryptedPrivateKey,
        public_key: next.publicKey,
        fingerprint: next.fingerprint,
        generation: next.generation,
        rotated_at: next.rotatedAt,
      }).where('user_id', '=', userId)
        .where('generation', '=', snapshot.existing.generation)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new ConflictException('User internal SSH key changed concurrently; retry rotation');
      }
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.RotateUserInternalSshKey,
        userId,
        'user',
        {
          previousGeneration: snapshot.existing.generation,
          generation: next.generation,
          fingerprint: next.fingerprint,
        },
      );
    });
    return this.toDto({
      user_id: next.userId,
      encrypted_private_key: next.encryptedPrivateKey,
      public_key: next.publicKey,
      fingerprint: next.fingerprint,
      generation: next.generation,
      rotated_at: next.rotatedAt,
    }, true);
  }

  async getUserInternalPublicKey(userId: string): Promise<{
    publicKey: string;
    generation: number;
    fingerprint: string;
  }> {
    await this.assertUserKeyAvailable(this.database, userId);
    const key = await this.database.selectFrom('iam.user_internal_ssh_keys')
      .select(['public_key', 'generation', 'fingerprint'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!key) throw new ConflictException('User internal SSH key invariant is missing');
    return {
      publicKey: key.public_key,
      generation: key.generation,
      fingerprint: key.fingerprint,
    };
  }

  private async generate(
    user: { id: string; username: string },
    generation: number,
  ): Promise<PreparedUserSshKey> {
    const generated = await this.keygen.generateEd25519(
      `nyabase-internal:${user.username}:${generation}`,
    );
    return {
      userId: user.id,
      encryptedPrivateKey: this.crypto.encrypt(generated.privateKey),
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
      generation,
      rotatedAt: new Date(),
    };
  }

  private async assertUserKeyAvailable(
    executor: Pick<Kysely<NyabaseDatabase>, 'selectFrom'>,
    userId: string,
  ): Promise<{ id: string; username: string; status: string }> {
    const user = await executor.selectFrom('iam.users')
      .select(['id', 'username', 'status'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || user.status === UserStatus.Deleted) {
      throw new NotFoundException('User not found');
    }
    if (user.status === UserStatus.Deleting) {
      throw new ConflictException({
        code: 'USER_DELETING',
        message: 'SSH key access is disabled while the user is being deleted',
        userId,
      });
    }
    return user;
  }

  private toDto(
    key: {
      user_id: string;
      encrypted_private_key: string;
      public_key: string;
      fingerprint: string;
      generation: number;
      rotated_at: Date;
    },
    includePrivate: boolean,
  ): UserInternalSshKeyDto {
    return {
      userId: key.user_id,
      publicKey: key.public_key,
      ...(includePrivate
        ? { privateKey: this.crypto.decrypt(key.encrypted_private_key) }
        : {}),
      fingerprint: key.fingerprint,
      generation: key.generation,
      rotatedAt: key.rotated_at.toISOString(),
    };
  }
}
