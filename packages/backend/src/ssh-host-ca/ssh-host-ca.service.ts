import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { SshKeyCryptoService } from '../platform/ssh-key-crypto.service.js';
import { generateEd25519Authority, signEd25519HostCertificate } from './ssh-certificates.js';

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

/**
 * One SSH host certificate authority per user. It signs the host keys of that
 * user's containers only, so the single `@cert-authority *.<suffix>` line in a
 * user's known_hosts vouches for their own containers and never for another
 * user's container of the same name.
 */
@Injectable()
export class SshHostCaService {
  private readonly logger = new Logger(SshHostCaService.name);

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly crypto: SshKeyCryptoService,
  ) {}

  /** The user's CA public key line, created on first use. */
  async publicKey(userId: string): Promise<string> {
    return (await this.ensure(userId)).public_key;
  }

  /**
   * A host certificate for `hostPublicKey` from the owner's CA, or null when
   * the stored CA key cannot be opened (ssh.keyEncryptionSecret changed; an
   * admin resets the authorities to recover).
   */
  async certify(input: {
    ownerId: string;
    hostPublicKey: string;
    principals: readonly string[];
    keyId: string;
  }): Promise<string | null> {
    const row = await this.ensure(input.ownerId);
    let privateKeyPem: string;
    try {
      privateKeyPem = this.crypto.decrypt(row.encrypted_private_key);
    } catch (error) {
      this.logger.warn(`SSH host CA of user ${input.ownerId} cannot be decrypted: ${String(error)}`);
      return null;
    }
    return signEd25519HostCertificate({
      authorityPrivateKeyPem: privateKeyPem,
      hostPublicKey: input.hostPublicKey,
      principals: input.principals,
      keyId: input.keyId,
    });
  }

  /** Drop every user's CA; new ones are created on next use. Returns how many were dropped. */
  async resetAll(executor: Executor = this.database): Promise<number> {
    const result = await executor.deleteFrom('interaction.ssh_host_authorities').executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  private async ensure(userId: string) {
    const existing = await this.select(userId);
    if (existing) return existing;
    const generated = generateEd25519Authority(`nyabase-host-ca-${userId}`);
    await this.database.insertInto('interaction.ssh_host_authorities')
      .values({
        user_id: userId,
        encrypted_private_key: this.crypto.encrypt(generated.privateKeyPem),
        public_key: generated.publicKey,
      })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    const winner = await this.select(userId);
    if (!winner) throw new Error(`SSH host CA of user ${userId} was not stored`);
    return winner;
  }

  private select(userId: string) {
    return this.database.selectFrom('interaction.ssh_host_authorities')
      .select(['encrypted_private_key', 'public_key'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }
}
