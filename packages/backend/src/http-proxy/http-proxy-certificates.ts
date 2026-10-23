import { BadRequestException } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  randomBytes,
  X509Certificate,
  type KeyObject,
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
  if (!isX509v3(cert.raw)) {
    throw new BadRequestException('Certificate must be an X.509 v3 certificate');
  }
  // The proxy (rustls/webpki) matches names only against subjectAltName.
  if (cert.checkHost(wildcardDomain, { subject: 'never' }) !== wildcardDomain) {
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
  let normalizedKeyPem: string;
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    assertProxySupportedKey(privateKey);
    if (!cert.checkPrivateKey(privateKey)) {
      throw new BadRequestException('Certificate and private key do not match');
    }
    // PKCS#8 is the one encoding every proxy key loader accepts.
    normalizedKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Invalid private key PEM');
  }
  return {
    certificate_pem: certificatePem,
    encrypted_private_key_pem: encryptPrivateKey(secret, normalizedKeyPem),
    certificate_fingerprint: cert.fingerprint256,
    certificate_not_after: new Date(cert.validTo),
  };
}

/**
 * The HTTP proxy signs with ring through rustls, which only loads RSA
 * 2048-4096, ECDSA P-256/P-384 and Ed25519 keys. Anything else would be
 * accepted here and then make every proxy snapshot fail to load.
 */
function assertProxySupportedKey(key: KeyObject): void {
  const details = key.asymmetricKeyDetails ?? {};
  switch (key.asymmetricKeyType) {
    case 'rsa': {
      const bits = details.modulusLength ?? 0;
      if (bits >= 2048 && bits <= 4096) return;
      throw new BadRequestException('RSA private keys must be 2048 to 4096 bits');
    }
    case 'ec':
      if (details.namedCurve === 'prime256v1' || details.namedCurve === 'secp384r1') return;
      throw new BadRequestException('ECDSA private keys must use P-256 or P-384');
    case 'ed25519':
      return;
    default:
      throw new BadRequestException(
        'Unsupported private key type; use RSA 2048-4096, ECDSA P-256/P-384 or Ed25519',
      );
  }
}

/** TBSCertificate starts with the explicit `[0] version` field only in v2/v3, and v3 encodes 2. */
function isX509v3(der: Buffer): boolean {
  let offset = 0;
  const header = (): boolean => {
    if (der[offset] !== 0x30) return false;
    const first = der[offset + 1] ?? 0;
    offset += 2 + (first & 0x80 ? first & 0x7f : 0);
    return true;
  };
  if (!header() || !header()) return false;
  return der[offset] === 0xa0
    && der[offset + 1] === 0x03
    && der[offset + 2] === 0x02
    && der[offset + 3] === 0x01
    && der[offset + 4] === 0x02;
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
