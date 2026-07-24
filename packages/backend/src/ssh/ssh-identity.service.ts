import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditAction, UserStatus, type UserInternalSshKeyDto } from '@nyabase/common';
import { AuditService } from '../audit/audit.service.js';
import { UserEntity } from '../entities/user.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { SshProxyHostKeyEntity } from '../entities/ssh-proxy-host-key.entity.js';
import { SshKeyCryptoService } from './ssh-key-crypto.service.js';
import { SshKeygenService } from './ssh-keygen.service.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';

@Injectable()
export class SshIdentityService {
  private readonly logger = new Logger(SshIdentityService.name);

  constructor(
    @InjectRepository(UserEntity)
    private usersRepo: Repository<UserEntity>,
    @InjectRepository(UserInternalSshKeyEntity)
    private userKeysRepo: Repository<UserInternalSshKeyEntity>,
    @InjectRepository(SshProxyHostKeyEntity)
    private hostKeysRepo: Repository<SshProxyHostKeyEntity>,
    private keygen: SshKeygenService,
    private crypto: SshKeyCryptoService,
    private audit: AuditService,
    private dataSource: DataSource,
  ) {}

  async prepareUserKey(
    user: Pick<UserEntity, 'id' | 'username'>,
  ): Promise<UserInternalSshKeyEntity> {
    return this.generatedUserKey(user, 1);
  }

  async savePreparedUserKeyInTransaction(
    manager: EntityManager,
    user: Pick<UserEntity, 'id'>,
    key: UserInternalSshKeyEntity,
  ): Promise<UserInternalSshKeyEntity> {
    if (key.userId !== user.id || key.generation !== 1) {
      throw new ConflictException('Prepared user SSH key does not match the new user');
    }
    return manager.save(UserInternalSshKeyEntity, key);
  }

  async getUserKeyDto(
    userId: string,
    actorId: string,
    includePrivate: boolean,
    authorizeInTransaction: (manager: EntityManager) => Promise<void>,
  ): Promise<UserInternalSshKeyDto> {
    const key = await runSerializedTransaction(this.dataSource, async (manager) => {
      await authorizeInTransaction(manager);
      const [user, current] = await Promise.all([
        manager.findOneBy(UserEntity, { id: userId }),
        manager.findOneBy(UserInternalSshKeyEntity, { userId }),
      ]);
      this.assertUserKeyAvailable(user, userId);
      if (!current) throw new ConflictException('User internal SSH key invariant is missing');
      return current;
    });
    if (includePrivate) {
      await this.audit.log(actorId, AuditAction.ViewUserInternalSshKey, userId, 'user', {
        generation: key.generation,
      });
    }
    return this.toDto(key, includePrivate);
  }

  async rotateUserKey(
    userId: string,
    actorId: string,
    authorizeInTransaction: (manager: EntityManager) => Promise<void>,
  ): Promise<UserInternalSshKeyDto> {
    const snapshot = await runSerializedTransaction(this.dataSource, async (manager) => {
      await authorizeInTransaction(manager);
      const [user, existing] = await Promise.all([
        manager.findOneBy(UserEntity, { id: userId }),
        manager.findOneBy(UserInternalSshKeyEntity, { userId }),
      ]);
      this.assertUserKeyAvailable(user, userId);
      if (!existing) {
        throw new ConflictException('User internal SSH key invariant is missing');
      }
      return { user, existing };
    });

    // ssh-keygen and encryption are external/CPU work. They must never retain
    // the process-wide SQLite coordinator lease.
    const next = await this.generatedUserKey(
      snapshot.user,
      snapshot.existing.generation + 1,
    );

    const rotated = await runSerializedTransaction(this.dataSource, async (manager) => {
      await authorizeInTransaction(manager);
      this.assertUserKeyAvailable(
        await manager.findOneBy(UserEntity, { id: userId }),
        userId,
      );
      const updated = await manager.update(UserInternalSshKeyEntity, {
        userId,
        generation: snapshot.existing.generation,
      }, {
        encryptedPrivateKey: next.encryptedPrivateKey,
        publicKey: next.publicKey,
        fingerprint: next.fingerprint,
        generation: next.generation,
        rotatedAt: next.rotatedAt,
      });
      if (updated.affected !== 1) {
        throw new ConflictException('User internal SSH key changed concurrently; retry rotation');
      }
      return { previousGeneration: snapshot.existing.generation, key: next };
    });

    try {
      await this.audit.log(actorId, AuditAction.RotateUserInternalSshKey, userId, 'user', {
        previousGeneration: rotated.previousGeneration,
        generation: rotated.key.generation,
        fingerprint: rotated.key.fingerprint,
      });
    } catch (error) {
      // Rotation is already committed. Audit failure must not turn a successful
      // durable mutation into a misleading HTTP failure.
      this.logger.warn(
        `SSH key rotation audit failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.toDto(rotated.key, true);
  }

  async getUserInternalPublicKey(userId: string): Promise<{
    publicKey: string;
    generation: number;
    fingerprint: string;
  }> {
    const key = await this.requireUserKey(userId);
    return this.publicKeyView(key);
  }

  async getUserInternalPublicKeyInTransaction(
    manager: EntityManager,
    userId: string,
  ): Promise<{
    publicKey: string;
    generation: number;
    fingerprint: string;
  }> {
    const [user, key] = await Promise.all([
      manager.findOneBy(UserEntity, { id: userId }),
      manager.findOneBy(UserInternalSshKeyEntity, { userId }),
    ]);
    this.assertUserKeyAvailable(user, userId);
    if (!key) throw new ConflictException('User internal SSH key invariant is missing');
    return this.publicKeyView(key);
  }

  private publicKeyView(key: UserInternalSshKeyEntity): {
    publicKey: string;
    generation: number;
    fingerprint: string;
  } {
    return {
      publicKey: key.publicKey,
      generation: key.generation,
      fingerprint: key.fingerprint,
    };
  }

  async ensureProxyHostKey(
    authorizeInTransaction?: (manager: EntityManager) => Promise<void>,
  ): Promise<SshProxyHostKeyEntity & { privateKey: string }> {
    const existing = await runSerializedTransaction(this.dataSource, async (manager) => {
      await authorizeInTransaction?.(manager);
      return manager.findOneBy(SshProxyHostKeyEntity, { id: 'singleton' });
    });
    if (existing) {
      return this.withProxyPrivateKey(existing);
    }

    // Generate outside both the SQLite coordinator lease and the final insert
    // transaction. Concurrent initializers race only on the singleton insert.
    const generated = await this.keygen.generateEd25519('nyabase-ssh-proxy-host');
    const candidate = this.hostKeysRepo.create({
      id: 'singleton',
      encryptedPrivateKey: this.crypto.encrypt(generated.privateKey),
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
      generation: 1,
      rotatedAt: new Date(),
    });

    let winner: SshProxyHostKeyEntity | null = null;
    try {
      winner = await runSerializedTransaction(this.dataSource, async (manager) => {
        // Authority may have been revoked while ssh-keygen was running.
        await authorizeInTransaction?.(manager);
        const current = await manager.findOneBy(SshProxyHostKeyEntity, { id: 'singleton' });
        if (!current) {
          await manager.createQueryBuilder()
            .insert()
            .into(SshProxyHostKeyEntity)
            .values(candidate)
            .orIgnore()
            .execute();
        }
        return current
          ?? manager.findOneBy(SshProxyHostKeyEntity, { id: 'singleton' });
      });
    } catch (error) {
      // PostgreSQL SERIALIZABLE can report 40001 when two ON CONFLICT inserts
      // race even though the other transaction committed the singleton. Read
      // the winner in a fresh transaction; never mask unrelated DB failures.
      if (!this.isSerializationConflict(error)) throw error;
    }
    if (!winner) {
      winner = await runSerializedTransaction(this.dataSource, async (manager) => {
        await authorizeInTransaction?.(manager);
        return manager.findOneBy(SshProxyHostKeyEntity, { id: 'singleton' });
      });
    }
    if (!winner) {
      throw new ConflictException('SSH proxy host key initialization lost its singleton race');
    }
    // Always decrypt the persisted winner. A losing concurrent initializer
    // must never return its discarded private key.
    return this.withProxyPrivateKey(winner);
  }

  async getProxyHostKeyInTransaction(
    manager: EntityManager,
  ): Promise<SshProxyHostKeyEntity & { privateKey: string }> {
    const key = await manager.findOneBy(SshProxyHostKeyEntity, { id: 'singleton' });
    if (!key) throw new ConflictException('SSH proxy host key invariant is missing');
    return this.withProxyPrivateKey(key);
  }

  async getProxyHostKeySummary(
    authorizeInTransaction?: (manager: EntityManager) => Promise<void>,
  ): Promise<{
    fingerprint: string;
    generation: number;
    rotatedAt: Date;
  }> {
    const key = await this.ensureProxyHostKey(authorizeInTransaction);
    return {
      fingerprint: key.fingerprint,
      generation: key.generation,
      rotatedAt: key.rotatedAt,
    };
  }

  async rotateProxyHostKey(
    authorizeInTransaction: (manager: EntityManager) => Promise<void>,
  ): Promise<SshProxyHostKeyEntity & { privateKey: string }> {
    const existing = await this.ensureProxyHostKey(authorizeInTransaction);
    // The expensive subprocess chain is deliberately between the snapshot and
    // the final authorization/CAS transaction.
    const generated = await this.keygen.generateEd25519(
      `nyabase-ssh-proxy-host:${existing.generation + 1}`,
    );
    const next = this.hostKeysRepo.create({
      id: 'singleton',
      encryptedPrivateKey: this.crypto.encrypt(generated.privateKey),
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
      generation: existing.generation + 1,
      rotatedAt: new Date(),
    });

    return runSerializedTransaction(this.dataSource, async (manager) => {
      // Recheck current authority after key generation and commit only if the
      // observed generation is still current.
      await authorizeInTransaction(manager);
      const updated = await manager.update(SshProxyHostKeyEntity, {
        id: 'singleton',
        generation: existing.generation,
      }, {
        encryptedPrivateKey: next.encryptedPrivateKey,
        publicKey: next.publicKey,
        fingerprint: next.fingerprint,
        generation: next.generation,
        rotatedAt: next.rotatedAt,
      });
      if (updated.affected !== 1) {
        throw new ConflictException('SSH proxy host key changed concurrently; retry rotation');
      }
      return Object.assign(next, { privateKey: generated.privateKey });
    });
  }

  decryptUserPrivateKey(key: Pick<UserInternalSshKeyEntity, 'encryptedPrivateKey'>): string {
    return this.crypto.decrypt(key.encryptedPrivateKey);
  }

  private async generatedUserKey(
    user: Pick<UserEntity, 'id' | 'username'>,
    generation: number,
  ): Promise<UserInternalSshKeyEntity> {
    const generated = await this.keygen.generateEd25519(`nyabase-internal:${user.username}:${generation}`);
    return this.userKeysRepo.create({
      userId: user.id,
      encryptedPrivateKey: this.crypto.encrypt(generated.privateKey),
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
      generation,
      rotatedAt: new Date(),
    });
  }

  private async requireUserKey(userId: string): Promise<UserInternalSshKeyEntity> {
    const [user, key] = await Promise.all([
      this.usersRepo.findOneBy({ id: userId }),
      this.userKeysRepo.findOneBy({ userId }),
    ]);
    this.assertUserKeyAvailable(user, userId);
    if (!key) throw new ConflictException('User internal SSH key invariant is missing');
    return key;
  }

  private assertUserKeyAvailable(user: UserEntity | null, userId: string): asserts user is UserEntity {
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
  }

  private withProxyPrivateKey(
    key: SshProxyHostKeyEntity,
  ): SshProxyHostKeyEntity & { privateKey: string } {
    return Object.assign(key, {
      privateKey: this.crypto.decrypt(key.encryptedPrivateKey),
    });
  }

  private isSerializationConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as {
      code?: unknown;
      driverError?: { code?: unknown };
    };
    const code = record.code ?? record.driverError?.code;
    return code === '40001';
  }

  private toDto(key: UserInternalSshKeyEntity, includePrivate: boolean): UserInternalSshKeyDto {
    return {
      userId: key.userId,
      publicKey: key.publicKey,
      ...(includePrivate ? { privateKey: this.crypto.decrypt(key.encryptedPrivateKey) } : {}),
      fingerprint: key.fingerprint,
      generation: key.generation,
      rotatedAt: key.rotatedAt.toISOString(),
    };
  }
}
