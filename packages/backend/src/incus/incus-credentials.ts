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

const execFileAsync = promisify(execFile);
const ENCRYPTED_PRIVATE_KEY_VERSION = 'incus-v1';
const CERTIFICATE_GENERATION_TIMEOUT_MS = 15_000;

export interface IncusCertificateMaterial {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

export interface IncusCertificateMetadata {
  readonly fingerprint: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export function encryptionKey(secret: string): Buffer {
  if (!secret || secret.length < 16) {
    throw new Error('The Incus certificate encryption secret is not configured');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptPrivateKey(privateKeyPem: string, secret: string): string {
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

export function decryptPrivateKey(ciphertext: string, secret: string): string {
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

export function certificateMetadata(certificatePem: string): IncusCertificateMetadata {
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

export function validateCertificateKeyPair(
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

export async function generateIncusClientCertificate(): Promise<IncusCertificateMaterial> {
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
