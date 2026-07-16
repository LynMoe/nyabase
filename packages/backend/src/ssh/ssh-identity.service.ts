import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditAction, type UserInternalSshKeyDto } from '@nyabase/common';
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

  async createUserKeyInTransaction(
    manager: EntityManager,
    user: Pick<UserEntity, 'id' | 'username'>,
  ): Promise<UserInternalSshKeyEntity> {
    const key = await this.generatedUserKey(user, 1);
    return manager.save(UserInternalSshKeyEntity, key);
  }

  async getUserKeyDto(
    userId: string,
    actorId: string,
    includePrivate: boolean,
  ): Promise<UserInternalSshKeyDto> {
    const key = await this.requireUserKey(userId);
    if (includePrivate) {
      await this.audit.log(actorId, AuditAction.ViewUserInternalSshKey, userId, 'user', {
        generation: key.generation,
      });
    }
    return this.toDto(key, includePrivate);
  }

  async rotateUserKey(userId: string, actorId: string): Promise<UserInternalSshKeyDto> {
    const rotated = await runSerializedTransaction(this.dataSource, async (manager) => {
      const [user, existing] = await Promise.all([
        manager.findOneBy(UserEntity, { id: userId }),
        manager.findOneBy(UserInternalSshKeyEntity, { userId }),
      ]);
      if (!user) throw new NotFoundException('User not found');
      if (!existing) {
        throw new ConflictException('User internal SSH key invariant is missing');
      }

      const next = await this.generatedUserKey(user, existing.generation + 1);
      const updated = await manager.update(UserInternalSshKeyEntity, {
        userId,
        generation: existing.generation,
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
      return { previousGeneration: existing.generation, key: next };
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
    const key = await manager.findOneBy(UserInternalSshKeyEntity, { userId });
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

  async ensureProxyHostKey(): Promise<SshProxyHostKeyEntity & { privateKey: string }> {
    return runSerializedTransaction(this.dataSource, (manager) =>
      this.ensureProxyHostKeyInTransaction(manager));
  }

  async ensureProxyHostKeyInTransaction(
    manager: EntityManager,
  ): Promise<SshProxyHostKeyEntity & { privateKey: string }> {
    const existing = await manager.findOneBy(SshProxyHostKeyEntity, { id: 'singleton' });
    if (existing) {
      return Object.assign(existing, {
        privateKey: this.crypto.decrypt(existing.encryptedPrivateKey),
      });
    }
    const generated = await this.keygen.generateEd25519('nyabase-ssh-proxy-host');
    const entity = this.hostKeysRepo.create({
      id: 'singleton',
      encryptedPrivateKey: this.crypto.encrypt(generated.privateKey),
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
      generation: 1,
      rotatedAt: new Date(),
    });
    const saved = await manager.save(SshProxyHostKeyEntity, entity);
    return Object.assign(saved, { privateKey: generated.privateKey });
  }

  async getProxyHostKeySummary(): Promise<{
    fingerprint: string;
    generation: number;
    rotatedAt: Date;
  }> {
    const key = await this.ensureProxyHostKey();
    return {
      fingerprint: key.fingerprint,
      generation: key.generation,
      rotatedAt: key.rotatedAt,
    };
  }

  async rotateProxyHostKey(): Promise<SshProxyHostKeyEntity & { privateKey: string }> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const existing = await this.ensureProxyHostKeyInTransaction(manager);
      const generated = await this.keygen.generateEd25519(`nyabase-ssh-proxy-host:${existing.generation + 1}`);
      const next = this.hostKeysRepo.create({
        id: 'singleton',
        encryptedPrivateKey: this.crypto.encrypt(generated.privateKey),
        publicKey: generated.publicKey,
        fingerprint: generated.fingerprint,
        generation: existing.generation + 1,
        rotatedAt: new Date(),
      });
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
    if (!user) throw new NotFoundException('User not found');
    if (!key) throw new ConflictException('User internal SSH key invariant is missing');
    return key;
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
