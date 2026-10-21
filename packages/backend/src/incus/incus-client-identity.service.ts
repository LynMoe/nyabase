import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { IncusClientIdentityDto } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';

const execFileAsync = promisify(execFile);
const ENCRYPTED_PRIVATE_KEY_VERSION = 'incus-v1';
const CERTIFICATE_GENERATION_TIMEOUT_MS = 15_000;

interface IncusCertificateMaterial {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

interface IncusCertificateMetadata {
  readonly fingerprint: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

function encryptionKey(secret: string): Buffer {
  if (!secret || secret.length < 16) {
    throw new Error('The Incus certificate encryption secret is not configured');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encryptPrivateKey(privateKeyPem: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(privateKeyPem, 'utf8'),
    cipher.final(),
  ]);
  return [
    ENCRYPTED_PRIVATE_KEY_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function decryptPrivateKey(ciphertext: string, secret: string): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 4 || parts[0] !== ENCRYPTED_PRIVATE_KEY_VERSION) {
    throw new Error('Invalid encrypted Incus private key');
  }
  let iv: Buffer;
  let authTag: Buffer;
  let encrypted: Buffer;
  try {
    iv = Buffer.from(parts[1], 'base64url');
    authTag = Buffer.from(parts[2], 'base64url');
    encrypted = Buffer.from(parts[3], 'base64url');
  } catch {
    throw new Error('Invalid encrypted Incus private key');
  }
  if (iv.length !== 12 || authTag.length !== 16 || encrypted.length === 0) {
    throw new Error('Invalid encrypted Incus private key');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Unable to decrypt the Incus private key');
  }
}

function certificateMetadata(certificatePem: string): IncusCertificateMetadata {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new Error('Invalid Incus client certificate PEM');
  }
  const notBefore = new Date(certificate.validFrom);
  const notAfter = new Date(certificate.validTo);
  if (
    !certificate.fingerprint256
    || !Number.isFinite(notBefore.getTime())
    || !Number.isFinite(notAfter.getTime())
    || notAfter <= notBefore
  ) {
    throw new Error('Invalid Incus client certificate validity');
  }
  return {
    fingerprint: certificate.fingerprint256,
    notBefore,
    notAfter,
  };
}

function validateCertificateKeyPair(
  certificatePem: string,
  privateKeyPem: string,
): IncusCertificateMetadata {
  const metadata = certificateMetadata(certificatePem);
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error('Invalid Incus client private key PEM');
  }
  const certificate = new X509Certificate(certificatePem);
  const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const privatePublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (
    certificatePublicKey.byteLength !== privatePublicKey.byteLength
    || !timingSafeEqual(certificatePublicKey, privatePublicKey)
  ) {
    throw new Error('Incus client certificate and private key do not match');
  }
  return metadata;
}

async function generateIncusClientCertificate(): Promise<IncusCertificateMaterial> {
  const directory = await mkdtemp(join(tmpdir(), 'nyabase-incus-client-'));
  const certificatePath = join(directory, 'client.crt');
  const privateKeyPath = join(directory, 'client.key');
  try {
    await execFileAsync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-days',
        '3650',
        '-subj',
        '/CN=nyabase-incus-client',
        '-keyout',
        privateKeyPath,
        '-out',
        certificatePath,
      ],
      {
        timeout: CERTIFICATE_GENERATION_TIMEOUT_MS,
        maxBuffer: 16 * 1024,
      },
    );
    const [certificatePem, privateKeyPem] = await Promise.all([
      readFile(certificatePath, 'utf8'),
      readFile(privateKeyPath, 'utf8'),
    ]);
    validateCertificateKeyPair(certificatePem, privateKeyPem);
    return { certificatePem, privateKeyPem };
  } catch (error) {
    throw new Error(
      `Unable to generate an Incus client certificate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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
