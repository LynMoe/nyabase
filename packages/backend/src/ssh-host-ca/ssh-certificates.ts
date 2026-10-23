import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/**
 * OpenSSH Ed25519 keys and host certificates (PROTOCOL.certkeys), encoded
 * here so a CA private key never has to touch the filesystem or ssh-keygen.
 */

const ED25519 = 'ssh-ed25519';
const ED25519_CERT = 'ssh-ed25519-cert-v01@openssh.com';
const HOST_CERT = 2;
const FOREVER = 0xffff_ffff_ffff_ffffn;

function sshString(value: Buffer | string): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function uint64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
}

function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('Expected an Ed25519 key');
  }
  return Buffer.from(jwk.x, 'base64url');
}

function publicBlob(raw: Buffer): Buffer {
  return Buffer.concat([sshString(ED25519), sshString(raw)]);
}

/** The 32-byte key of an `ssh-ed25519 AAAA… [comment]` line, or null for any other key type. */
export function parseEd25519PublicKey(line: string): Buffer | null {
  const [type, base64] = line.trim().split(/\s+/);
  if (type !== ED25519 || !base64) return null;
  const blob = Buffer.from(base64, 'base64');
  if (blob.length !== 51 || !blob.subarray(0, 15).equals(sshString(ED25519))) return null;
  if (blob.readUInt32BE(15) !== 32) return null;
  return blob.subarray(19);
}

export interface Ed25519Authority {
  /** PKCS#8 PEM; store it encrypted. */
  privateKeyPem: string;
  /** `ssh-ed25519 AAAA… comment`, the line users trust with `@cert-authority`. */
  publicKey: string;
}

export function generateEd25519Authority(comment: string): Ed25519Authority {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const blob = publicBlob(rawPublicKey(publicKey));
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: `${ED25519} ${blob.toString('base64')} ${comment}`,
  };
}

/**
 * A host certificate for `hostPublicKey` (an `ssh-ed25519` line) valid for
 * `principals` forever. Ed25519 signatures are deterministic and the nonce is
 * derived from the inputs, so the same inputs always give the same bytes and
 * a converged guest is recognised by comparing file contents.
 */
export function signEd25519HostCertificate(input: {
  authorityPrivateKeyPem: string;
  hostPublicKey: string;
  principals: readonly string[];
  keyId: string;
}): string {
  const hostKey = parseEd25519PublicKey(input.hostPublicKey);
  if (!hostKey) throw new Error('The host key is not an Ed25519 public key');
  const authority = createPrivateKey(input.authorityPrivateKeyPem);
  const authorityBlob = publicBlob(rawPublicKey(createPublicKey(authority)));
  const principals = Buffer.concat(input.principals.map((principal) => sshString(principal)));
  const nonce = createHash('sha256')
    .update(authorityBlob)
    .update(hostKey)
    .update(principals)
    .update(input.keyId)
    .digest();
  const body = Buffer.concat([
    sshString(ED25519_CERT),
    sshString(nonce),
    sshString(hostKey),
    uint64(0n),
    uint32(HOST_CERT),
    sshString(input.keyId),
    sshString(principals),
    uint64(0n),
    uint64(FOREVER),
    sshString(Buffer.alloc(0)),
    sshString(Buffer.alloc(0)),
    sshString(Buffer.alloc(0)),
    sshString(authorityBlob),
  ]);
  const signature = Buffer.concat([sshString(ED25519), sshString(sign(null, body, authority))]);
  const certificate = Buffer.concat([body, sshString(signature)]);
  return `${ED25519_CERT} ${certificate.toString('base64')} ${input.keyId}`;
}
