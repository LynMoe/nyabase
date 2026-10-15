import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [, , runtimeRoot, runId, expectedFingerprint] = process.argv;

function blocked(message) {
  throw new Error(`BLOCKED: ${message}`);
}

if (!runtimeRoot || runtimeRoot.includes('\0')) {
  blocked('runtime root is required');
}
if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(runId ?? '')) {
  blocked('run id is unsafe');
}
if (!/^[0-9a-f:]{32,95}$/i.test(expectedFingerprint ?? '')) {
  blocked('server fingerprint is malformed');
}

try {
  if (!(await lstat(runtimeRoot)).isDirectory()) {
    blocked('runtime root is not a directory');
  }
} catch {
  blocked('runtime root is unavailable');
}

function normalizeFingerprint(value) {
  return String(value).replace(/[:-\s]/g, '').toLowerCase();
}

function decodeTrustToken(token) {
  if (
    !token
    || /[\r\n]/.test(token)
    || !/^[A-Za-z0-9+/_=-]+$/.test(token)
  ) {
    blocked('trust token is not a single encoded value');
  }
  let decoded;
  try {
    const standardBase64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standardBase64.padEnd(Math.ceil(standardBase64.length / 4) * 4, '=');
    decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    blocked('trust token metadata is not valid JSON');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    blocked('trust token metadata is not an object');
  }
  const clientName = decoded.client_name;
  const fingerprint = normalizeFingerprint(decoded.fingerprint ?? '');
  const addresses = decoded.addresses;
  const expiresAt = decoded.expires_at;
  if (
    typeof clientName !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(clientName)
    || !clientName.includes(runId)
  ) {
    blocked('trust token client name is not run-scoped');
  }
  if (fingerprint !== normalizeFingerprint(expectedFingerprint)) {
    blocked('trust token server fingerprint does not match the pinned server');
  }
  if (
    !Array.isArray(addresses)
    || addresses.length === 0
    || addresses.some((address) => (
      typeof address !== 'string'
      || address.length === 0
      || address.length > 256
      || /[\u0000-\u001f\u007f]/.test(address)
    ))
  ) {
    blocked('trust token has no usable server address');
  }
  if (typeof expiresAt !== 'string' || !expiresAt) {
    blocked('trust token expiry metadata is missing');
  }
  return clientName;
}

function validateKeyPair(certificatePem, privateKeyPem) {
  let certificate;
  let privateKey;
  try {
    certificate = new X509Certificate(certificatePem);
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    blocked('generated Incus client material is invalid');
  }
  const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const privatePublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (
    certificatePublicKey.byteLength !== privatePublicKey.byteLength
    || !timingSafeEqual(certificatePublicKey, privatePublicKey)
  ) {
    blocked('generated Incus client certificate and key do not match');
  }
  return normalizeFingerprint(certificate.fingerprint256);
}

const trustToken = process.env.E2E_INCUS_TRUST_TOKEN?.trim();
const clientName = decodeTrustToken(trustToken);
const temporaryRoot = await mkdtemp(join(runtimeRoot, '.incus-connect-client-'));
const temporaryCertificate = join(temporaryRoot, 'client.crt');
const temporaryKey = join(temporaryRoot, 'client.key');
const certificatePath = join(runtimeRoot, 'incus-connect-client.crt');
const keyPath = join(runtimeRoot, 'incus-connect-client.key');
const ownershipPath = join(runtimeRoot, 'incus-connect-client-ownership');

try {
  try {
    await execFileAsync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-days',
      '3650',
      '-subj',
      `/CN=${clientName}`,
      '-keyout',
      temporaryKey,
      '-out',
      temporaryCertificate,
    ], { timeout: 30_000, maxBuffer: 16 * 1024 });
  } catch {
    blocked('unable to generate the disposable Incus connect certificate');
  }

  const [certificatePem, privateKeyPem] = await Promise.all([
    readFile(temporaryCertificate, 'utf8'),
    readFile(temporaryKey, 'utf8'),
  ]);
  const clientFingerprint = validateKeyPair(certificatePem, privateKeyPem);
  await writeFile(certificatePath, certificatePem, { mode: 0o600 });
  await writeFile(keyPath, privateKeyPem, { mode: 0o600 });
  await chmod(certificatePath, 0o600);
  await chmod(keyPath, 0o600);
  await writeFile(
    ownershipPath,
    [
      `run_id=${runId}`,
      `client_name=${clientName}`,
      `client_fingerprint=${clientFingerprint}`,
      `client_cert=${certificatePath}`,
      `client_key=${keyPath}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await chmod(ownershipPath, 0o600);
  process.stdout.write(`${certificatePath}\n${keyPath}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
