import { BadRequestException } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  X509Certificate,
} from 'crypto';
import {
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
} from '@nyabase/common';

import type { DomainPoolRow } from './http-proxy-state.js';

const KEY_VERSION = 'v1';

export interface CertificateFields {
  certificate_pem: string | null;
  encrypted_private_key_pem: string | null;
  certificate_fingerprint: string | null;
  certificate_not_after: Date | null;
}

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptPrivateKey(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    KEY_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptPrivateKey(secret: string, value: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split('.');
  if (version !== KEY_VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error('Unsupported encrypted HTTP proxy key format');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function validateCertificate(
  certificatePem: string,
  wildcardDomain: string,
): X509Certificate {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificatePem);
  } catch {
    throw new BadRequestException('Invalid certificate PEM');
  }
  const validFrom = Date.parse(cert.validFrom);
  const validTo = Date.parse(cert.validTo);
  const now = Date.now();
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now) {
    throw new BadRequestException('Certificate is not currently valid');
  }
  const minimumValidTo = now
    + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS
    + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS;
  if (validTo <= minimumValidTo) {
    throw new BadRequestException(
      'Certificate expires before the proxy snapshot lease can safely drain',
    );
  }
  if (cert.checkHost(wildcardDomain) !== wildcardDomain) {
    throw new BadRequestException(
      `Certificate does not cover wildcard domain ${wildcardDomain}`,
    );
  }
  return cert;
}


/**
 * Validate a certificate/key pair for a wildcard domain and produce the columns
 * to store (private key encrypted). Neither given means "no certificate".
 */
export function certificateFields(
  certificatePem: string | null | undefined,
  privateKeyPem: string | null | undefined,
  wildcardDomain: string,
  secret: string,
): CertificateFields {
  if (!certificatePem && !privateKeyPem) {
    return {
      certificate_pem: null,
      encrypted_private_key_pem: null,
      certificate_fingerprint: null,
      certificate_not_after: null,
    };
  }
  if (!certificatePem || !privateKeyPem) {
    throw new BadRequestException(
      'Both certificatePem and privateKeyPem are required when configuring HTTPS',
    );
  }
  const cert = validateCertificate(certificatePem, wildcardDomain);
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (!cert.checkPrivateKey(privateKey)) {
      throw new BadRequestException('Certificate and private key do not match');
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Invalid private key PEM');
  }
  return {
    certificate_pem: certificatePem,
    encrypted_private_key_pem: encryptPrivateKey(secret, privateKeyPem),
    certificate_fingerprint: cert.fingerprint256,
    certificate_not_after: new Date(cert.validTo),
  };
}

/** TLS material that stays valid for longer than a snapshot lease can be in flight. */
export function poolHasSafeTlsLease(pool: DomainPoolRow, now: number): boolean {
  return Boolean(
    pool.certificate_pem
    && pool.encrypted_private_key_pem
    && pool.certificate_not_after
    && pool.certificate_not_after.getTime() > now
      + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS
      + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  );
}
