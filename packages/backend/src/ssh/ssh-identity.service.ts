import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuditAction, type UserInternalSshKeyDto } from '@nyabase/common';
import { AuditService } from '../audit/audit.service.js';
import { UserEntity } from '../entities/user.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { SshProxyHostKeyEntity } from '../entities/ssh-proxy-host-key.entity.js';
import { SshKeyCryptoService } from './ssh-key-crypto.service.js';
import { SshKeygenService } from './ssh-keygen.service.js';

@Injectable()
export class SshIdentityService {
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
  ) {}

  async createUserKeyInTransaction(
    manager: EntityManager,
    user: Pick<UserEntity, 'id' | 'username'>,
  ): Promise<UserInternalSshKeyEntity> {
    const key = await this.generatedUserKey(user, 1);
    return manager.save(UserInternalSshKeyEntity, key);
  }

  async ensureUserKey(userId: string): Promise<UserInternalSshKeyEntity> {
    const existing = await this.userKeysRepo.findOneBy({ userId });
    if (existing) return existing;
    const user = await this.usersRepo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    return this.userKeysRepo.save(await this.generatedUserKey(user, 1));
  }

  async getUserKeyDto(
    userId: string,
    actorId: string,
    includePrivate: boolean,
  ): Promise<UserInternalSshKeyDto> {
    const key = await this.ensureUserKey(userId);
    if (includePrivate) {
      await this.audit.log(actorId, AuditAction.ViewUserInternalSshKey, userId, 'user', {
        generation: key.generation,
      });
    }
    return this.toDto(key, includePrivate);
  }

  async rotateUserKey(userId: string, actorId: string): Promise<UserInternalSshKeyDto> {
    const user = await this.usersRepo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    const existing = await this.ensureUserKey(userId);
    const next = await this.generatedUserKey(user, existing.generation + 1);
    await this.userKeysRepo.save(next);
    await this.audit.log(actorId, AuditAction.RotateUserInternalSshKey, userId, 'user', {
      previousGeneration: existing.generation,
      generation: next.generation,
      fingerprint: next.fingerprint,
    });
    return this.toDto(next, true);
  }

  async getUserInternalPublicKey(userId: string): Promise<{
    publicKey: string;
    generation: number;
    fingerprint: string;
  }> {
    const key = await this.ensureUserKey(userId);
    return {
      publicKey: key.publicKey,
      generation: key.generation,
      fingerprint: key.fingerprint,
    };
  }

  async ensureProxyHostKey(): Promise<SshProxyHostKeyEntity & { privateKey: string }> {
    const existing = await this.hostKeysRepo.findOneBy({ id: 'singleton' });
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
    const saved = await this.hostKeysRepo.save(entity);
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
    const existing = await this.ensureProxyHostKey();
    const generated = await this.keygen.generateEd25519(`nyabase-ssh-proxy-host:${existing.generation + 1}`);
    const entity = this.hostKeysRepo.create({
      id: 'singleton',
      encryptedPrivateKey: this.crypto.encrypt(generated.privateKey),
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
      generation: existing.generation + 1,
      rotatedAt: new Date(),
    });
    const saved = await this.hostKeysRepo.save(entity);
    return Object.assign(saved, { privateKey: generated.privateKey });
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
