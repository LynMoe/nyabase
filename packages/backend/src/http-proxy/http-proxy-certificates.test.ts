import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { certificateFields, decryptPrivateKey } from './http-proxy-certificates.js';

const SECRET = 'certificate-test-secret-that-is-long-enough';
const DOMAIN = '*.apps.example.test';
const dir = mkdtempSync(join(tmpdir(), 'nyabase-cert-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Self-signed pair from openssl; `keyArgs` picks the key algorithm. */
function pair(name: string, keyArgs: string[], options: { san?: boolean } = {}) {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync('openssl', ['genpkey', ...keyArgs, '-out', key], { stdio: 'ignore' });
  const args = ['req', '-new', '-x509', '-key', key, '-out', cert, '-days', '30', '-subj', `/CN=${DOMAIN}`];
  if (options.san !== false) args.push('-addext', `subjectAltName=DNS:${DOMAIN}`);
  execFileSync('openssl', args, { stdio: 'ignore' });
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
}

/** One DER TLV at `offset`: header length and total length. */
function tlv(der: Buffer, offset: number): { header: number; total: number } {
  const first = der[offset + 1]!;
  if (!(first & 0x80)) return { header: 2, total: 2 + first };
  const count = first & 0x7f;
  let length = 0;
  for (let index = 0; index < count; index += 1) length = length * 256 + der[offset + 2 + index]!;
  return { header: 2 + count, total: 2 + count + length };
}

function sequence(content: Buffer): Buffer {
  const length = content.length;
  const header = length < 0x80
    ? Buffer.from([0x30, length])
    : Buffer.from([0x30, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([header, content]);
}

/**
 * OpenSSL 3 only writes v3, so rebuild the DER without the version and
 * extensions fields. The signature no longer verifies, which parsing ignores.
 */
function toV1(pem: string): string {
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  const outer = tlv(der, 0);
  const tbsStart = outer.header;
  const tbs = tlv(der, tbsStart);
  const fields: Buffer[] = [];
  for (let offset = tbsStart + tbs.header; offset < tbsStart + tbs.total;) {
    const field = tlv(der, offset);
    if (der[offset] !== 0xa0 && der[offset] !== 0xa3) fields.push(der.subarray(offset, offset + field.total));
    offset += field.total;
  }
  const rest = der.subarray(tbsStart + tbs.total, outer.total);
  const v1 = sequence(Buffer.concat([sequence(Buffer.concat(fields)), rest]));
  const body = v1.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

describe('certificateFields matches what the rustls proxy can load', () => {
  it.each([
    ['rsa2048', ['-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048']],
    ['p256', ['-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256']],
    ['p384', ['-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-384']],
    ['ed25519', ['-algorithm', 'ED25519']],
  ])('accepts %s and stores the key as PKCS#8', (name, keyArgs) => {
    const { cert, key } = pair(name, keyArgs);
    const fields = certificateFields(cert, key, DOMAIN, SECRET);
    expect(decryptPrivateKey(SECRET, fields.encrypted_private_key_pem!)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it.each([
    ['rsa1024', ['-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:1024'], /2048 to 4096/],
    ['p521', ['-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-521'], /P-256 or P-384/],
    ['ed448', ['-algorithm', 'ED448'], /Unsupported private key type/],
    ['rsapss', ['-algorithm', 'RSA-PSS', '-pkeyopt', 'rsa_keygen_bits:2048'], /Unsupported private key type/],
  ])('rejects %s keys', (name, keyArgs, message) => {
    const { cert, key } = pair(name, keyArgs as string[]);
    expect(() => certificateFields(cert, key, DOMAIN, SECRET)).toThrow(message as RegExp);
  });

  it('requires the wildcard in subjectAltName, not only the subject CN', () => {
    const { cert, key } = pair('cn-only', ['-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'], { san: false });
    expect(() => certificateFields(cert, key, DOMAIN, SECRET)).toThrow(/does not cover wildcard domain/);
  });

  it('rejects X.509 v1 certificates', () => {
    const { cert, key } = pair('v1', ['-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256']);
    expect(() => certificateFields(toV1(cert), key, DOMAIN, SECRET)).toThrow(/X\.509 v3/);
  });
});
