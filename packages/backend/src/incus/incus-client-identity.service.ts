import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { IncusClientIdentityDto } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  generateIncusClientCertificate,
  validateCertificateKeyPair,
} from './incus-credentials.js';

export interface IncusClientIdentity {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly fingerprint: string;
  readonly notAfter: Date;
  readonly createdAt: Date;
}

/**
 * The control plane's single mTLS client identity. It is generated on first
 * use (10-year certificate), stored in system.incus_client_identity with the
 * private key encrypted by ssh.keyEncryptionSecret, and never rotated.
 * Concurrent first use is safe: every generator inserts with ON CONFLICT DO
 * NOTHING and then reads back the one winning row.
 */
@Injectable()
export class IncusClientIdentityService {
  private cached: IncusClientIdentity | undefined;
  private loading: Promise<IncusClientIdentity> | undefined;

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly config: NyabaseConfigService,
  ) {}

  get(): Promise<IncusClientIdentity> {
    if (this.cached) return Promise.resolve(this.cached);
    this.loading ??= this.loadOrCreate()
      .then((identity) => {
        this.cached = identity;
        return identity;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  async describe(): Promise<IncusClientIdentityDto> {
    const identity = await this.get();
    return {
      fingerprint: identity.fingerprint,
      notAfter: identity.notAfter.toISOString(),
      createdAt: identity.createdAt.toISOString(),
    };
  }

  private async loadOrCreate(): Promise<IncusClientIdentity> {
    const existing = await this.read();
    if (existing) return existing;
    const secret = this.config.keyEncryptionSecret();
    const material = await generateIncusClientCertificate();
    const metadata = validateCertificateKeyPair(
      material.certificatePem,
      material.privateKeyPem,
    );
    await this.database
      .insertInto('system.incus_client_identity')
      .values({
        singleton: true,
        certificate_pem: material.certificatePem,
        encrypted_private_key: encryptPrivateKey(material.privateKeyPem, secret),
        fingerprint: metadata.fingerprint,
        not_after: metadata.notAfter,
      })
      .onConflict((conflict) => conflict.column('singleton').doNothing())
      .execute();
    const stored = await this.read();
    if (!stored) throw new Error('Incus client identity was not persisted');
    return stored;
  }

  private async read(): Promise<IncusClientIdentity | undefined> {
    const row = await this.database
      .selectFrom('system.incus_client_identity')
      .selectAll()
      .where('singleton', '=', true)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      certificatePem: row.certificate_pem,
      privateKeyPem: decryptPrivateKey(
        row.encrypted_private_key,
        this.config.keyEncryptionSecret(),
      ),
      fingerprint: row.fingerprint,
      notAfter: new Date(row.not_after),
      createdAt: new Date(row.created_at),
    };
  }
}
