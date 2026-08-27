import {
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { SshKeyCryptoService } from './ssh-key-crypto.service.js';
import { SshKeygenService } from './ssh-keygen.service.js';

export type SshIdentityTransaction = Transaction<NyabaseDatabase>;

export interface SshProxyHostKey {
  id: 'singleton';
  encryptedPrivateKey: string;
  publicKey: string;
  fingerprint: string;
  generation: number;
  rotatedAt: Date;
}

export type DecryptedSshProxyHostKey = SshProxyHostKey & {
  privateKey: string;
};

/**
 * PostgreSQL-owned proxy host identity.
 *
 * Keeping the proxy singleton here makes its external key generation/CAS
 * boundary explicit without retaining a legacy persistence transaction bridge.
 */
@Injectable()
export class SshIdentityService {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly keygen: SshKeygenService,
    private readonly crypto: SshKeyCryptoService,
  ) {}

  async ensureProxyHostKey(
    authorize?: (transaction: SshIdentityTransaction) => Promise<void>,
  ): Promise<DecryptedSshProxyHostKey> {
    const existing = await this.transactions.run(async (transaction) => {
      await authorize?.(transaction);
      return this.selectHostKey(transaction);
    });
    if (existing) return this.withPrivateKey(existing);

    // ssh-keygen and encryption are deliberately outside the database
    // transaction. Concurrent initializers race only on the singleton insert.
    const generated = await this.keygen.generateEd25519('nyabase-ssh-proxy-host');
    const candidate: SshProxyHostKey = {
      id: 'singleton',
      encryptedPrivateKey: this.crypto.encrypt(generated.privateKey),
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
      generation: 1,
      rotatedAt: new Date(),
    };
    const winner = await this.transactions.run(async (transaction) => {
      await authorize?.(transaction);
      await transaction.insertInto('interaction.ssh_proxy_host_keys').values({
        id: candidate.id,
        encrypted_private_key: candidate.encryptedPrivateKey,
        public_key: candidate.publicKey,
        fingerprint: candidate.fingerprint,
        generation: candidate.generation,
        rotated_at: candidate.rotatedAt,
      }).onConflict((conflict) => conflict.column('id').doNothing()).execute();
      return this.selectHostKey(transaction);
    }, { isolationLevel: 'serializable' });
    if (!winner) {
      throw new ConflictException(
        'SSH proxy host key initialization lost its singleton race',
      );
    }
    // Decrypt the persisted winner. A losing initializer must never return its
    // discarded candidate private key.
    return this.withPrivateKey(winner);
  }

  async getProxyHostKey(
    executor: Kysely<NyabaseDatabase> | SshIdentityTransaction = this.database,
  ): Promise<DecryptedSshProxyHostKey> {
    const key = await this.selectHostKey(executor);
    if (!key) {
      throw new ConflictException('SSH proxy host key invariant is missing');
    }
    return this.withPrivateKey(key);
  }

  async getProxyHostKeySummary(
    authorize?: (transaction: SshIdentityTransaction) => Promise<void>,
  ): Promise<{
    fingerprint: string;
    generation: number;
    rotatedAt: Date;
  }> {
    const key = await this.ensureProxyHostKey(authorize);
    return {
      fingerprint: key.fingerprint,
      generation: key.generation,
      rotatedAt: key.rotatedAt,
    };
  }

  async rotateProxyHostKey(
    authorize: (transaction: SshIdentityTransaction) => Promise<void>,
    onRotated?: (
      transaction: SshIdentityTransaction,
      key: SshProxyHostKey,
    ) => Promise<void>,
  ): Promise<DecryptedSshProxyHostKey> {
    const existing = await this.ensureProxyHostKey(authorize);
    const generated = await this.keygen.generateEd25519(
      `nyabase-ssh-proxy-host:${existing.generation + 1}`,
    );
    const next: SshProxyHostKey = {
      id: 'singleton',
      encryptedPrivateKey: this.crypto.encrypt(generated.privateKey),
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
      generation: existing.generation + 1,
      rotatedAt: new Date(),
    };
    await this.transactions.run(async (transaction) => {
      // Authority and generation are rechecked after external key generation.
      await authorize(transaction);
      const updated = await transaction
        .updateTable('interaction.ssh_proxy_host_keys')
        .set({
          encrypted_private_key: next.encryptedPrivateKey,
          public_key: next.publicKey,
          fingerprint: next.fingerprint,
          generation: next.generation,
          rotated_at: next.rotatedAt,
        })
        .where('id', '=', 'singleton')
        .where('generation', '=', existing.generation)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new ConflictException(
          'SSH proxy host key changed concurrently; retry rotation',
        );
      }
      await onRotated?.(transaction, next);
    }, { isolationLevel: 'serializable' });
    return Object.assign(next, { privateKey: generated.privateKey });
  }

  private async selectHostKey(
    executor: Kysely<NyabaseDatabase> | SshIdentityTransaction,
  ): Promise<SshProxyHostKey | null> {
    const row = await executor.selectFrom('interaction.ssh_proxy_host_keys')
      .selectAll()
      .where('id', '=', 'singleton')
      .executeTakeFirst();
    return row ? {
      id: row.id,
      encryptedPrivateKey: row.encrypted_private_key,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      generation: row.generation,
      rotatedAt: row.rotated_at,
    } : null;
  }

  private withPrivateKey(key: SshProxyHostKey): DecryptedSshProxyHostKey {
    return {
      ...key,
      privateKey: this.crypto.decrypt(key.encryptedPrivateKey),
    };
  }
}
