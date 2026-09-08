import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { request } from 'node:https';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { promisify } from 'node:util';
import {
  createRoutedNetworkConfig,
  createServerRegistrationConfig,
  ensureIpPoolForServer,
  ensureServerRegistration,
  resolveIncusServerName,
  validateIncusServerName,
} from './server-registration.mjs';
import { parseConnectIntentId } from './connect-intent.mjs';
import {
  discoverStoragePools,
  findAndRegisterCephExecutor,
  registerStoragePools,
  validateRegisteredStoragePoolDto,
  validateStoragePoolDtos,
} from './storage-pool-discovery.mjs';
import { ensureImageRegistration } from './image-registration.mjs';

const execFileAsync = promisify(execFile);
const [, , runtimeRoot, runId, profile = 'smoke'] = process.argv;
if (!runtimeRoot || !runId) {
  throw new Error('usage: seed.mjs <runtime-root> <run-id> <profile>');
}
if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(runId)) {
  throw new Error('unsafe run id');
}
if (!/^(smoke|core|full)$/.test(profile)) {
  throw new Error(`unsupported profile: ${profile}`);
}

const required = [
  'E2E_BASE_URL',
  'E2E_ADMIN_USERNAME',
  'E2E_ADMIN_PASSWORD',
  'E2E_DATABASE_URL',
  'NYABASE_CONFIG_FILE',
  'E2E_EDGE_CA_FILE',
  'E2E_INCUS_API_ENDPOINT',
  'E2E_INCUS_SERVER_CERT_FINGERPRINT',
  'E2E_INCUS_CLIENT_CERT',
  'E2E_INCUS_CLIENT_KEY',
  'E2E_INCUS_CONNECT_CLIENT_CERT',
  'E2E_INCUS_CONNECT_CLIENT_KEY',
  'E2E_INCUS_CA_FILE',
  'E2E_INCUS_TRUST_TOKEN',
  'E2E_INCUS_PARENT_INTERFACE',
  'E2E_INCUS_ROUTED_SUBNET',
  'E2E_INCUS_ROUTED_ADDRESS',
  'E2E_INCUS_ROUTED_GATEWAY',
  'E2E_INCUS_PROBE_ADDRESS',
  'E2E_INCUS_IMAGE_SOURCE_URL',
  'E2E_INCUS_IMAGE_REMOTE',
  'E2E_INCUS_IMAGE_ALIAS',
  'E2E_INCUS_IMAGE_FINGERPRINT',
  'E2E_INCUS_IMAGE_NO_DHCP',
  'E2E_INCUS_PREFLIGHT_IMAGE_ALIAS',
  'E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT',
  'E2E_INCUS_PREFLIGHT_POOL_NAME',
  'E2E_INCUS_PREFLIGHT_EGRESS_URL',
  'E2E_INCUS_PREFLIGHT_SOURCE_SERVER',
  'E2E_NODE_EXPORTER_URL',
  'E2E_NODE_EXPORTER_TOKEN',
  'E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT',
  'E2E_SSH_USER',
  'E2E_INCUS_DIR_POOL',
  'E2E_INCUS_LVM_POOL',
];
for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error(`BLOCKED: missing ${name}`);
  }
}

function blocked(message) {
  throw new Error(`BLOCKED: ${message}`);
}

function loadOptionalCephfsFixture() {
  const envPath = join(runtimeRoot, 'cephfs-nbdev-test.env');
  if (existsSync(envPath)) {
    const mode = (lstatSync(envPath).mode & 0o777).toString(8);
    if (mode !== '600') {
      blocked(`cephfs fixture permissions must be 0600: ${envPath}`);
    }
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = /^(E2E_CEPHFS_[A-Z0-9_]+)=(.*)$/.exec(trimmed);
      if (!match) blocked(`invalid cephfs fixture entry in ${envPath}`);
      const [, name, raw] = match;
      if (!process.env[name]?.trim()) {
        // Strip matching surrounding quotes from shell-style assignments.
        const value = raw.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1');
        process.env[name] = value;
      }
    }
  }
  const backendIdPath = join(runtimeRoot, 'cephfs-backend.id');
  if (!process.env.E2E_SHARED_BACKEND_ID?.trim() && existsSync(backendIdPath)) {
    process.env.E2E_SHARED_BACKEND_ID = readFileSync(backendIdPath, 'utf8').trim();
  }
}

loadOptionalCephfsFixture();

function readRegularFile(name) {
  const path = process.env[name];
  if (!path || path.includes('\0')) {
    blocked(`${name} is not configured`);
  }
  try {
    if (!lstatSync(path).isFile()) {
      blocked(`${name} is not a regular file`);
    }
    return readFileSync(path);
  } catch {
    blocked(`${name} is not a readable regular file`);
  }
}

function readOptionalFile(name) {
  const path = process.env[name];
  if (!path) return undefined;
  return readRegularFile(name);
}

function readPreviousSeedState() {
  try {
    const previous = JSON.parse(readFileSync(join(runtimeRoot, 'seed-state.json'), 'utf8'));
    return previous.runId === runId ? previous : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFingerprint(value) {
  return String(value ?? '')
    .replace(/[:-\s]/g, '')
    .toLowerCase();
}

function requireFingerprint(name) {
  const value = process.env[name] ?? '';
  if (!/^[0-9a-f]{32,64}$/i.test(normalizeFingerprint(value))) {
    blocked(`${name} is not a hexadecimal fingerprint`);
  }
  return value;
}

function requireImageFingerprint(name) {
  const value = process.env[name] ?? '';
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    blocked(`${name} must be a 64-character image fingerprint`);
  }
  return value.toLowerCase();
}

function certificateMetadata(certificatePem, privateKeyPem) {
  let certificate;
  let privateKey;
  try {
    certificate = new X509Certificate(certificatePem);
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    blocked('Incus client certificate/key is not valid PEM');
  }
  const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const privatePublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (
    certificatePublicKey.byteLength !== privatePublicKey.byteLength ||
    !timingSafeEqual(certificatePublicKey, privatePublicKey)
  ) {
    blocked('Incus client certificate and private key do not match');
  }
  const notBefore = new Date(certificate.validFrom);
  const notAfter = new Date(certificate.validTo);
  if (
    !certificate.fingerprint256 ||
    !Number.isFinite(notBefore.getTime()) ||
    !Number.isFinite(notAfter.getTime()) ||
    notAfter <= notBefore
  ) {
    blocked('Incus client certificate validity is not usable');
  }
  return {
    fingerprint: certificate.fingerprint256,
    notBefore,
    notAfter,
  };
}

function encryptionKey(secret) {
  if (!secret || secret.length < 16) {
    blocked(
      'NYABASE_CONFIG_FILE does not contain a usable ssh.keyEncryptionSecret or auth.jwtSecret',
    );
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encryptPrivateKey(privateKeyPem, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(privateKeyPem, 'utf8'), cipher.final()]);
  return [
    'incus-v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function readEncryptionSecret() {
  let configText;
  try {
    configText = readFileSync(process.env.NYABASE_CONFIG_FILE, 'utf8');
  } catch {
    blocked('NYABASE_CONFIG_FILE cannot be read');
  }
  const yamlScalar = (section, key) => {
    let inSection = false;
    for (const line of configText.split(/\r?\n/)) {
      const topLevel = line.match(/^([^\s#][^:]*):\s*$/);
      if (topLevel) {
        inSection = topLevel[1] === section;
        continue;
      }
      if (!inSection) continue;
      const valueMatch = line.match(new RegExp(`^\\s{2}${key}:\\s*(.*?)\\s*$`));
      if (valueMatch) {
        const value = valueMatch[1].replace(/^(['"])(.*)\1$/, '$2');
        return value && !value.startsWith('#') ? value : undefined;
      }
      if (line.trim() && !line.startsWith(' ')) break;
    }
    return undefined;
  };
  const secret =
    process.env.E2E_INCUS_KEY_ENCRYPTION_SECRET ||
    yamlScalar('ssh', 'keyEncryptionSecret') ||
    yamlScalar('auth', 'jwtSecret');
  if (!secret || secret.length < 16) {
    blocked('NYABASE_CONFIG_FILE does not contain a usable certificate encryption secret');
  }
  return secret;
}

function httpsJson(url, options, runHeader) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      url,
      {
        method: options.method ?? 'GET',
        ca: options.ca,
        cert: options.cert,
        key: options.key,
        rejectUnauthorized: true,
        checkServerIdentity: (hostname, certificate) => {
          const tlsError = checkServerIdentity(hostname, certificate);
          if (tlsError) return tlsError;
          if (
            options.expectedServerCertFingerprint &&
            normalizeFingerprint(certificate.fingerprint256) !==
              normalizeFingerprint(options.expectedServerCertFingerprint)
          ) {
            return new Error('TLS server certificate fingerprint mismatch');
          }
          return undefined;
        },
        headers: {
          accept: 'application/json',
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(runHeader ? { 'x-nyabase-e2e-run': runId } : {}),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          let value = null;
          try {
            value = text ? JSON.parse(text) : null;
          } catch {
            reject(new Error(`${options.method ?? 'GET'} ${url.pathname} returned invalid JSON`));
            return;
          }
          if ((response.statusCode ?? 500) >= 400) {
            const error = new Error(
              `${options.method ?? 'GET'} ${url.pathname} returned ${response.statusCode}`,
            );
            error.statusCode = response.statusCode;
            error.responseBody = value;
            reject(error);
            return;
          }
          resolve(value);
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function loadLabServerDefs() {
  const path = process.env.E2E_LAB_SERVERS_FILE?.trim();
  if (!path) return [];
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
    blocked(`E2E_LAB_SERVERS_FILE is missing: ${path}`);
  }
  let listed;
  try {
    listed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    blocked('E2E_LAB_SERVERS_FILE is not valid JSON');
  }
  if (!Array.isArray(listed) || listed.length === 0) {
    blocked('E2E_LAB_SERVERS_FILE must list at least one extra Incus worker');
  }
  return listed.map((entry, index) => {
    const ssh = String(entry?.ssh ?? '').trim();
    const apiEndpoint = String(entry?.apiEndpoint ?? '').trim().replace(/\/$/, '');
    const parentInterface = String(entry?.parentInterface ?? '').trim();
    const slug = String(entry?.slug ?? '').trim();
    if (!ssh || !apiEndpoint.startsWith('https://') || !parentInterface || !slug) {
      blocked(`E2E_LAB_SERVERS_FILE[${index}] requires ssh, https apiEndpoint, parentInterface, slug`);
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug) || slug.length > 64) {
      blocked(`E2E_LAB_SERVERS_FILE[${index}] slug is not a valid server slug`);
    }
    const dirPool = String(entry?.dirPool ?? '').trim();
    const lvmPool = String(entry?.lvmPool ?? '').trim();
    const nodeExporterToken = String(entry?.nodeExporterToken ?? '').trim();
    const role = String(entry?.role ?? '').trim();
    return {
      ssh,
      apiEndpoint,
      parentInterface,
      slug,
      ...(dirPool ? { dirPool } : {}),
      ...(lvmPool ? { lvmPool } : {}),
      ...(nodeExporterToken ? { nodeExporterToken } : {}),
      ...(role ? { role } : {}),
    };
  });
}

async function sshCapture(target, command) {
  try {
    const result = await execFileAsync(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=15',
        target,
        command,
      ],
      { timeout: 60_000, maxBuffer: 256 * 1024 },
    );
    return String(result.stdout ?? '').trim();
  } catch (error) {
    blocked(`ssh ${target} failed: ${error?.stderr?.trim() || error?.message || 'unknown'}`);
  }
}

async function fingerprintForEndpoint(endpoint) {
  const host = new URL(endpoint);
  const connect = `${host.hostname}:${host.port || 8443}`;
  try {
    const result = await execFileAsync(
      'bash',
      [
        '-lc',
        `echo | openssl s_client -connect ${JSON.stringify(connect)} 2>/dev/null | openssl x509 -noout -fingerprint -sha256`,
      ],
      { timeout: 15_000, maxBuffer: 16 * 1024 },
    );
    const value = String(result.stdout ?? '').split('=').pop()?.trim();
    if (!/^[0-9A-Fa-f:]{32,95}$/.test(value ?? '')) {
      blocked(`could not read Incus fingerprint from ${endpoint}`);
    }
    return value;
  } catch (error) {
    blocked(`could not read Incus fingerprint from ${endpoint}: ${error?.message ?? 'unknown'}`);
  }
}

function parseTrustToken(raw) {
  const lines = String(raw ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const token = [...lines].reverse().find((line) => line.length >= 32 && !line.includes(' '));
  if (!token) blocked('Incus trust add did not print a token');
  return token;
}

async function seedLabServer(token, definition, image, selectedShared, routedNetwork, dnsServers) {
  const info = await sshCapture(definition.ssh, 'incus query /1.0');
  let parsed;
  try {
    parsed = JSON.parse(info);
  } catch {
    blocked(`${definition.ssh} did not return Incus /1.0 JSON`);
  }
  const name = validateIncusServerName(
    parsed?.metadata?.environment?.server_name
      ?? parsed?.environment?.server_name,
  );
  const fingerprint = await fingerprintForEndpoint(definition.apiEndpoint);
  const tokenName = `e2e-${runId}`.slice(0, 40);
  const trustRaw = await sshCapture(definition.ssh, `incus config trust add ${tokenName}`);
  const trustToken = parseTrustToken(trustRaw);
  const registration = {
    name,
    slug: definition.slug,
    apiEndpoint: definition.apiEndpoint,
    parentInterface: definition.parentInterface,
    dnsServers,
  };
  const registrationResult = await ensureServerRegistration({
    listServers: () => jsonRequest('/api/admin/servers', { token }),
    createServer: (body) => jsonRequest('/api/admin/servers', {
      method: 'POST',
      token,
      body,
    }),
    registration,
    priorServer: previousSeedState?.labServers?.find((entry) => entry.slug === definition.slug),
  });
  const extra = registrationResult.server;
  await ensureIpPoolForServer({
    listPools: () => jsonRequest('/api/admin/ip-pools', { token }),
    createPool: (body) => jsonRequest('/api/admin/ip-pools', {
      method: 'POST',
      token,
      body,
    }),
    patchPool: (id, body) => jsonRequest(`/api/admin/ip-pools/${id}`, {
      method: 'PATCH',
      token,
      body,
    }),
    serverId: extra.id,
    serverSlug: definition.slug,
    network: routedNetwork,
  });
  const labConnect = await jsonRequest(`/api/admin/servers/${extra.id}/connect`, {
    method: 'POST',
    token,
    body: {
      trustToken,
      expectedServerCertFingerprint: fingerprint,
    },
  });
  await waitForIntent(token, parseConnectIntentId(labConnect), `lab server connect ${definition.slug}`);
  let current = await jsonRequest(`/api/admin/servers/${extra.id}`, { token });
  if (current.status !== 'online') {
    blocked(`lab server ${definition.slug} connected without becoming online: ${current.status}`);
  }
  await discoverStoragePools(jsonRequest, extra.id, token);
  const labPools = validateStoragePoolDtos(
    await jsonRequest(`/api/admin/servers/${extra.id}/storage-pools`, { token }),
    extra.id,
    `lab ${definition.slug} storage pool listing`,
  );
  const dirName = definition.dirPool || process.env.E2E_INCUS_DIR_POOL;
  const lvmName = definition.lvmPool || process.env.E2E_INCUS_LVM_POOL;
  const labDir = labPools.find(
    (pool) =>
      pool.incusName === dirName
      && pool.driver === 'dir'
      && pool.resizeFamily === 'quota_online'
      && pool.quotaEffective === true,
  );
  const labLvm = labPools.find(
    (pool) =>
      pool.incusName === lvmName
      && pool.driver === 'lvm'
      && pool.resizeFamily === 'block_backed',
  );
  if (!labDir || !labLvm) {
    blocked(`lab server ${definition.slug} is missing dir quota_online and lvm block_backed pools`);
  }
  await registerStoragePools(jsonRequest, extra.id, token, [labDir, labLvm]);
  let labCephExecutor;
  if (selectedShared && process.env.E2E_CEPHFS_INCUS_POOL?.trim()) {
    labCephExecutor = await findAndRegisterCephExecutor(
      jsonRequest,
      selectedShared.id,
      extra.id,
      process.env.E2E_CEPHFS_INCUS_POOL,
      token,
      `lab ${definition.slug} CephFS executor`,
    );
  }
  const workerHost = new URL(definition.apiEndpoint).hostname;
  const workerExporter = `https://${workerHost}:19181/metrics`;
  const workerFingerprint = await fingerprintForEndpoint(workerExporter);
  current = await ensureNodeMetrics(token, current, {
    endpoint: workerExporter,
    serverCertFingerprint: workerFingerprint,
    token: definition.nodeExporterToken,
  });
  await runPsql(
    `
UPDATE infra.servers
SET system_pool_id=:'dir_id'::uuid
WHERE id = :'server_id'::uuid;
`,
    {
      dir_id: labDir.id,
      server_id: extra.id,
    },
  );
  current = await jsonRequest(`/api/admin/servers/${extra.id}`, { token });
  await ensureAssignment(token, image, extra.id, previousSeedState?.image);
  await ensurePreflight(token, current, labDir.id);
  return {
    id: extra.id,
    createdByRun: registrationResult.createdByRun,
    name: current.name,
    slug: definition.slug,
    endpoint: current.apiEndpoint,
    certificateFingerprint: fingerprint,
    ssh: definition.ssh,
    parentInterface: definition.parentInterface,
    dirPoolId: labDir.id,
    cephfsPoolId: labCephExecutor?.id,
    role: definition.role || undefined,
  };
}

const edgeTls = {
  ca: readRegularFile('E2E_EDGE_CA_FILE'),
  cert: readOptionalFile('E2E_EDGE_CLIENT_CERT'),
  key: readOptionalFile('E2E_EDGE_CLIENT_KEY'),
};
// Direct Incus probes use the trusted bootstrap identity. The disposable
// connect identity is reserved for the active certificate fixture and the
// connect onboarding path.
const bootstrapIncusTls = {
  ca: readRegularFile('E2E_INCUS_CA_FILE'),
  cert: readRegularFile('E2E_INCUS_CLIENT_CERT'),
  key: readRegularFile('E2E_INCUS_CLIENT_KEY'),
};
const edgeBase = new URL(process.env.E2E_BASE_URL);
const incusBase = new URL(process.env.E2E_INCUS_API_ENDPOINT);

function jsonRequest(path, options = {}) {
  return httpsJson(new URL(path, edgeBase), { ...options, ...edgeTls }, true);
}

function incusRequest(path, options = {}) {
  return httpsJson(
    new URL(path, incusBase),
    {
      ...options,
      ...bootstrapIncusTls,
      expectedServerCertFingerprint: process.env.E2E_INCUS_SERVER_CERT_FINGERPRINT,
    },
    false,
  );
}

async function waitForIntent(token, intentId, label) {
  const deadline = Date.now() + 180_000;
  let last;
  while (Date.now() < deadline) {
    last = await jsonRequest(`/api/intents/${intentId}`, { token });
    if (last?.status === 'succeeded') return last;
    if (last?.status === 'failed') {
      blocked(`${label} intent failed: ${last.failureCode ?? 'UNKNOWN'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  blocked(`${label} intent did not settle within 180 seconds`);
}

async function ensureNodeMetrics(token, server, metrics = {}) {
  const endpoint = new URL(metrics.endpoint ?? process.env.E2E_NODE_EXPORTER_URL);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    blocked('E2E_NODE_EXPORTER_URL must be an HTTPS URL without embedded credentials');
  }
  const secret = metrics.token ?? process.env.E2E_NODE_EXPORTER_TOKEN;
  const tokenFingerprint = createHash('sha256')
    .update(secret, 'utf8')
    .digest('hex');
  const desired = {
    endpoint: endpoint.toString(),
    serverCertFingerprint: metrics.serverCertFingerprint
      ?? process.env.E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT,
    token: secret,
  };
  if (
    server.nodeMetrics?.endpoint === desired.endpoint &&
    normalizeFingerprint(server.nodeMetrics.serverCertFingerprint) ===
      normalizeFingerprint(desired.serverCertFingerprint) &&
    server.nodeMetrics.tokenFingerprint === tokenFingerprint
  ) {
    return server;
  }
  try {
    return await jsonRequest(`/api/admin/servers/${server.id}`, {
      method: 'PATCH',
      token,
      body: {
        expectedRevision: server.revision,
        nodeMetrics: desired,
      },
    });
  } catch (error) {
    if (error?.statusCode !== 409) throw error;
    const current = await jsonRequest(`/api/admin/servers/${server.id}`, { token });
    if (
      current.nodeMetrics?.endpoint === desired.endpoint &&
      normalizeFingerprint(current.nodeMetrics.serverCertFingerprint) ===
        normalizeFingerprint(desired.serverCertFingerprint) &&
      current.nodeMetrics.tokenFingerprint === tokenFingerprint
    ) {
      return current;
    }
    throw error;
  }
}

async function ensureAssignment(token, image, serverId, priorImage) {
  const assignments = await jsonRequest(`/api/admin/images/${image.id}/assignments`, { token });
  const current = assignments.find((entry) => entry.serverId === serverId);
  const assignmentWasCreatedByRun = !current || (
    priorImage?.assignmentCreatedByRun === true
    && priorImage.assignmentId === current?.id
    && priorImage.id === image.id
  );
  const body = current ? { expectedGeneration: current.generation } : {};
  const result = await jsonRequest(`/api/admin/images/${image.id}/assignments/${serverId}`, {
    method: 'PUT',
    token,
    body,
  });
  if (!result?.intent?.intentId) {
    blocked('image assignment response did not include an intent id');
  }
  await waitForIntent(token, result.intent.intentId, 'image assignment');
  const settled = await jsonRequest(`/api/admin/images/${image.id}/assignments`, { token });
  const assignment = settled.find((entry) => entry.serverId === serverId);
  if (
    !assignment ||
    assignment.lifecyclePhase !== 'active' ||
    assignment.managedFingerprint?.toLowerCase() !== image.fingerprint.toLowerCase()
  ) {
    blocked('image assignment did not settle to the pinned active fingerprint');
  }
  return {
    assignment,
    createdByRun: assignmentWasCreatedByRun,
  };
}

async function ensurePreflight(token, server, poolId) {
  const result = await jsonRequest(`/api/admin/servers/${server.id}/preflight`, {
    method: 'POST',
    token,
    body: {
      expectedServerRevision: server.revision,
      poolId,
      probeAddress: process.env.E2E_INCUS_PROBE_ADDRESS,
    },
  });
  if (!result?.intentId) {
    blocked('preflight response did not include an intent id');
  }
  await waitForIntent(token, result.intentId, 'server preflight');
  const report = await jsonRequest(`/api/admin/servers/${server.id}/preflight`, { token });
  if (
    report?.status !== 'passed' ||
    report.report?.status !== 'passed' ||
    report.report?.controlReady !== true ||
    !report.report?.checks ||
    Object.entries(report.report.checks).some(
      ([, value]) => value !== 'pass' && value !== 'not_applicable',
    )
  ) {
    blocked(
      `preflight report is not control-ready: ${JSON.stringify({
        status: report?.status,
        report: report?.report,
      })}`,
    );
  }
  const probeName = `nyabase-preflight-${server.id.replaceAll('-', '')}`;
  try {
    await incusRequest(`/1.0/instances/${encodeURIComponent(probeName)}`);
    blocked(`preflight probe cleanup left ${probeName} behind`);
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
  }
  return report;
}

async function runPsql(sql, variables) {
  const sqlPath = join(runtimeRoot, `seed-${randomUUID()}.sql`);
  writeFileSync(sqlPath, `${sql.trim()}\n`, { mode: 0o600 });
  try {
    const args = [
      process.env.E2E_DATABASE_URL,
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-P',
      'tuples_only=on',
      '-P',
      'format=unaligned',
    ];
    for (const [name, value] of Object.entries(variables)) {
      args.push('-v', `${name}=${value}`);
    }
    args.push('-f', sqlPath);
    return await execFileAsync('psql', args, {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || 'unknown psql error';
    blocked(`PostgreSQL fixture seeding failed: ${detail}`);
  } finally {
    rmSync(sqlPath, { force: true });
  }
}

async function generateStagedCertificate() {
  const directory = join(runtimeRoot, `certificate-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const certPath = join(directory, 'client.crt');
  const keyPath = join(directory, 'client.key');
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
        '/CN=nyabase-e2e-staged-client',
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { timeout: 30_000, maxBuffer: 32 * 1024 },
    );
    const certificatePem = readFileSync(certPath);
    const privateKeyPem = readFileSync(keyPath);
    const metadata = certificateMetadata(certificatePem, privateKeyPem);
    return {
      certificatePem,
      privateKeyPem,
      metadata,
    };
  } catch (error) {
    blocked(`unable to generate a staged client certificate: ${error.message}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const bootstrapCertificatePem = readRegularFile('E2E_INCUS_CLIENT_CERT');
const bootstrapPrivateKeyPem = readRegularFile('E2E_INCUS_CLIENT_KEY');
const bootstrapMetadata = certificateMetadata(bootstrapCertificatePem, bootstrapPrivateKeyPem);
const connectCertificatePem = readRegularFile('E2E_INCUS_CONNECT_CLIENT_CERT');
const connectPrivateKeyPem = readRegularFile('E2E_INCUS_CONNECT_CLIENT_KEY');
const connectMetadata = certificateMetadata(connectCertificatePem, connectPrivateKeyPem);
const expectedServerFingerprint = requireFingerprint('E2E_INCUS_SERVER_CERT_FINGERPRINT');
const expectedImageFingerprint = requireImageFingerprint('E2E_INCUS_IMAGE_FINGERPRINT');
const expectedPreflightFingerprint = requireImageFingerprint(
  'E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT',
);
if (process.env.E2E_INCUS_IMAGE_NO_DHCP !== '1') {
  blocked('E2E_INCUS_IMAGE_NO_DHCP=1 is required for the SSHD image contract');
}
if (
  !process.env.E2E_INCUS_IMAGE_SOURCE_URL.startsWith('https://') ||
  !process.env.E2E_INCUS_PREFLIGHT_SOURCE_SERVER.startsWith('https://') ||
  !process.env.E2E_INCUS_PREFLIGHT_EGRESS_URL.startsWith('https://')
) {
  blocked('image source, preflight source, and preflight egress URLs must use HTTPS');
}

const encryptionSecret = readEncryptionSecret();
const previousSeedState = readPreviousSeedState();
const staged = await generateStagedCertificate();
const session = await jsonRequest('/api/auth/login', {
  method: 'POST',
  body: {
    username: process.env.E2E_ADMIN_USERNAME,
    password: process.env.E2E_ADMIN_PASSWORD,
  },
});
if (!session?.accessToken || !session.user?.id) {
  blocked('admin login did not return a usable session');
}
const token = session.accessToken;

const certificatesSql = `
BEGIN;
UPDATE system.incus_client_certificates
SET state = 'retired', retired_at = COALESCE(retired_at, clock_timestamp())
WHERE state = 'active';
UPDATE system.incus_client_certificates
SET state = 'failed'
WHERE state = 'staged';
WITH next_generation AS (
  SELECT COALESCE(MAX(generation), 0) + 1 AS generation
  FROM system.incus_client_certificates
),
active_insert AS (
  INSERT INTO system.incus_client_certificates (
    id, generation, certificate_pem, encrypted_private_key, fingerprint,
    not_before, not_after, state, created_by, activated_at, retired_at
  )
  SELECT :'active_id'::uuid, generation, :'active_cert', :'active_key', :'active_fp',
    :'active_not_before'::timestamptz, :'active_not_after'::timestamptz,
    'active', :'user_id'::uuid, clock_timestamp(), NULL
  FROM next_generation
  RETURNING id, generation
)
INSERT INTO system.incus_client_certificates (
  id, generation, certificate_pem, encrypted_private_key, fingerprint,
  not_before, not_after, state, created_by, activated_at, retired_at
)
SELECT :'staged_id'::uuid, generation + 1, :'staged_cert', :'staged_key', :'staged_fp',
  :'staged_not_before'::timestamptz, :'staged_not_after'::timestamptz,
  'staged', :'user_id'::uuid, NULL, NULL
FROM active_insert;
INSERT INTO system.incus_client_certificate_trusts (
  certificate_id, server_id, state, last_error, observed_at
)
SELECT :'active_id'::uuid, id, :'active_trust_state', NULL,
  CASE WHEN :'active_trust_state' = 'verified' THEN clock_timestamp() ELSE NULL END
FROM infra.servers
ON CONFLICT (certificate_id, server_id) DO UPDATE
SET state = :'active_trust_state',
    last_error = NULL,
    observed_at = CASE
      WHEN :'active_trust_state' = 'verified' THEN clock_timestamp()
      ELSE NULL
    END;
INSERT INTO system.incus_client_certificate_trusts (
  certificate_id, server_id, state, last_error, observed_at
)
SELECT :'staged_id'::uuid, id, 'pending', NULL, NULL
FROM infra.servers
ON CONFLICT (certificate_id, server_id) DO UPDATE
SET state = 'pending', last_error = NULL, observed_at = NULL;
COMMIT;
`;

async function installCertificateFixture(
  certificatePem,
  privateKeyPem,
  metadata,
  activeTrustState = 'verified',
) {
  if (activeTrustState !== 'pending' && activeTrustState !== 'verified') {
    blocked(`unsupported active certificate trust state: ${activeTrustState}`);
  }
  await runPsql(certificatesSql, {
    active_id: randomUUID(),
    staged_id: randomUUID(),
    active_cert: certificatePem.toString(),
    active_key: encryptPrivateKey(privateKeyPem.toString(), encryptionSecret),
    active_fp: metadata.fingerprint,
    active_not_before: metadata.notBefore.toISOString(),
    active_not_after: metadata.notAfter.toISOString(),
    staged_cert: staged.certificatePem.toString(),
    staged_key: encryptPrivateKey(staged.privateKeyPem.toString(), encryptionSecret),
    staged_fp: staged.metadata.fingerprint,
    staged_not_before: staged.metadata.notBefore.toISOString(),
    staged_not_after: staged.metadata.notAfter.toISOString(),
    user_id: session.user.id,
    active_trust_state: activeTrustState,
  });
}

// Seed the trusted bootstrap identity before any server registration. This
// keeps background scans on a trusted client while connect onboarding is
// still pending.
await installCertificateFixture(
  bootstrapCertificatePem,
  bootstrapPrivateKeyPem,
  bootstrapMetadata,
  'verified',
);

const actualServerName = await resolveIncusServerName(incusRequest);
const registration = createServerRegistrationConfig(process.env, runId, actualServerName);
const routedNetwork = createRoutedNetworkConfig(process.env);
const registrationResult = await ensureServerRegistration({
  listServers: () => jsonRequest('/api/admin/servers', { token }),
  createServer: (body) =>
    jsonRequest('/api/admin/servers', {
      method: 'POST',
      token,
      body,
    }),
  registration,
  requestedServerId: process.env.E2E_INCUS_SERVER_ID,
  priorServer: previousSeedState?.server,
});
const server = registrationResult.server;
const serverCreatedByRun = registrationResult.createdByRun;

if (
  server.serverCertFingerprint &&
  normalizeFingerprint(server.serverCertFingerprint) !==
    normalizeFingerprint(expectedServerFingerprint)
) {
  blocked('registered server certificate fingerprint does not match the pinned input');
}
if (
  server.parentInterface !== process.env.E2E_INCUS_PARENT_INTERFACE ||
  JSON.stringify(server.dnsServers ?? []) !== JSON.stringify(registration.dnsServers)
) {
  blocked('registered server host-network fields do not match the pinned inputs');
}

const ipPool = await ensureIpPoolForServer({
  listPools: () => jsonRequest('/api/admin/ip-pools', { token }),
  createPool: (body) =>
    jsonRequest('/api/admin/ip-pools', {
      method: 'POST',
      token,
      body,
    }),
  patchPool: (id, body) =>
    jsonRequest(`/api/admin/ip-pools/${id}`, {
      method: 'PATCH',
      token,
      body,
    }),
  serverId: server.id,
  serverSlug: registration.slug,
  network: routedNetwork,
});
const peerServerId = process.env.E2E_GPU_PEER_SERVER_ID?.trim();
if (peerServerId && peerServerId !== server.id) {
  const servers = await jsonRequest('/api/admin/servers', { token });
  if (Array.isArray(servers) && servers.some((entry) => entry.id === peerServerId)) {
    await ensureIpPoolForServer({
      listPools: () => jsonRequest('/api/admin/ip-pools', { token }),
      createPool: (body) =>
        jsonRequest('/api/admin/ip-pools', {
          method: 'POST',
          token,
          body,
        }),
      patchPool: (id, body) =>
        jsonRequest(`/api/admin/ip-pools/${id}`, {
          method: 'PATCH',
          token,
          body,
        }),
      serverId: peerServerId,
      serverSlug: registration.slug,
      network: routedNetwork,
    });
  }
}

// Switch the active control-plane identity before submitting the one-time
// onboarding intent. The backend will use this run-scoped certificate for the
// trust-token side effect and every subsequent server operation.
await installCertificateFixture(
  connectCertificatePem,
  connectPrivateKeyPem,
  connectMetadata,
  'pending',
);

let currentServer = await jsonRequest(`/api/admin/servers/${server.id}`, { token });
const connectResult = await jsonRequest(`/api/admin/servers/${server.id}/connect`, {
  method: 'POST',
  token,
  body: {
    trustToken: process.env.E2E_INCUS_TRUST_TOKEN,
    expectedServerCertFingerprint: expectedServerFingerprint,
  },
});
const connectIntentId = parseConnectIntentId(connectResult);
await waitForIntent(token, connectIntentId, 'server connect');
currentServer = await jsonRequest(`/api/admin/servers/${server.id}`, { token });
if (currentServer.status !== 'online') {
  blocked(`server connect intent settled without an online server: ${currentServer.status}`);
}
if (
  normalizeFingerprint(currentServer.serverCertFingerprint) !==
  normalizeFingerprint(expectedServerFingerprint)
) {
  blocked('connected server certificate fingerprint does not match the pinned input');
}
await discoverStoragePools(jsonRequest, server.id, token);
const pools = validateStoragePoolDtos(
  await jsonRequest(`/api/admin/servers/${server.id}/storage-pools`, { token }),
  server.id,
  'persisted storage pool listing',
);
const dir = pools.find(
  (pool) =>
    pool.incusName === process.env.E2E_INCUS_DIR_POOL &&
    pool.driver === 'dir' &&
    pool.resizeFamily === 'quota_online' &&
    pool.quotaEffective === true,
);
const lvm = pools.find(
  (pool) =>
    pool.incusName === process.env.E2E_INCUS_LVM_POOL &&
    pool.driver === 'lvm' &&
    pool.resizeFamily === 'block_backed',
);
if (!dir || !lvm) {
  blocked('both explicitly configured dir quota_online and lvm block_backed pools are required');
}
if (process.env.E2E_INCUS_PREFLIGHT_POOL_NAME !== dir.incusName) {
  blocked('E2E_INCUS_PREFLIGHT_POOL_NAME must name the verified dir pool');
}

await registerStoragePools(jsonRequest, server.id, token, [dir, lvm]);
const registeredPools = validateStoragePoolDtos(
  await jsonRequest(`/api/admin/servers/${server.id}/storage-pools`, { token }),
  server.id,
  'persisted registered storage pool listing',
);
const registeredDir = validateRegisteredStoragePoolDto(
  registeredPools.find((pool) => pool.id === dir.id),
  dir,
  'persisted registered dir storage pool listing',
);
const registeredLvm = validateRegisteredStoragePoolDto(
  registeredPools.find((pool) => pool.id === lvm.id),
  lvm,
  'persisted registered lvm storage pool listing',
);

currentServer = await ensureNodeMetrics(token, currentServer);
await runPsql(
  `
UPDATE infra.servers
SET system_pool_id = :'dir_id'::uuid
WHERE id = :'server_id'::uuid;
`,
  {
    dir_id: registeredDir.id,
    server_id: server.id,
  },
);
currentServer = await jsonRequest(`/api/admin/servers/${server.id}`, { token });
if (currentServer.systemPoolId !== registeredDir.id) {
  blocked('server system_pool_id fixture was not persisted');
}

const imageRegistration = await ensureImageRegistration({
  listImages: (authToken) => jsonRequest('/api/admin/images', { token: authToken }),
  createImage: (body, authToken) => jsonRequest('/api/admin/images', {
    method: 'POST',
    token: authToken,
    body,
  }),
  token,
  runId,
  env: process.env,
  priorImage: previousSeedState?.image,
});
const image = imageRegistration.image;
const imageCreatedByRun = imageRegistration.createdByRun;
let privateImageInfo;
try {
  privateImageInfo = await execFileAsync(
    'incus',
    ['image', 'info', `${process.env.E2E_INCUS_IMAGE_REMOTE}:${process.env.E2E_INCUS_IMAGE_ALIAS}`],
    { timeout: 30_000, maxBuffer: 128 * 1024 },
  );
} catch {
  blocked('Incus private image alias cannot be inspected');
}
if (!privateImageInfo.stdout.toLowerCase().includes(expectedImageFingerprint)) {
  blocked('Incus private image alias does not resolve to the pinned fingerprint');
}
await runPsql(
  `
UPDATE infra.images
SET fingerprint = :'image_fingerprint'
WHERE id = :'image_id'::uuid
  AND is_active = true
  AND deleting = false;
`,
  {
    image_fingerprint: expectedImageFingerprint,
    image_id: image.id,
  },
);
const pinnedImage = await jsonRequest(`/api/admin/images/${image.id}`, { token });
if (pinnedImage.fingerprint?.toLowerCase() !== expectedImageFingerprint) {
  blocked('image fingerprint fixture was not persisted');
}
image.fingerprint = expectedImageFingerprint;
const assignmentResult = await ensureAssignment(
  token,
  image,
  server.id,
  previousSeedState?.image,
);
const assignment = assignmentResult.assignment;
let privatePreflightInfo;
try {
  privatePreflightInfo = await execFileAsync(
    'incus',
    [
      'image',
      'info',
      `${process.env.E2E_INCUS_IMAGE_REMOTE}:${process.env.E2E_INCUS_PREFLIGHT_IMAGE_ALIAS}`,
    ],
    { timeout: 30_000, maxBuffer: 128 * 1024 },
  );
} catch {
  blocked('Incus preflight image alias cannot be inspected');
}
if (!privatePreflightInfo.stdout.toLowerCase().includes(expectedPreflightFingerprint)) {
  blocked('Incus preflight image alias does not resolve to the pinned fingerprint');
}
const preflight = await ensurePreflight(token, currentServer, registeredDir.id);

const verification = await runPsql(
  `
SELECT COALESCE((
  SELECT t.state
  FROM system.incus_client_certificate_trusts t
  JOIN system.incus_client_certificates c ON c.id = t.certificate_id
  WHERE c.state = 'active' AND t.server_id = :'server_id'::uuid
), 'missing') || '|' ||
  COUNT(*) FILTER (WHERE state = 'active') || '|' ||
  COUNT(*) FILTER (WHERE state = 'staged') || '|' ||
  (SELECT COUNT(*) FROM system.incus_client_certificate_trusts t
    JOIN system.incus_client_certificates c ON c.id = t.certificate_id
    WHERE c.state = 'active' AND t.server_id = :'server_id'::uuid
      AND t.state IN ('trusted', 'verified')) || '|' ||
  (SELECT COUNT(*) FROM system.incus_client_certificate_trusts t
    JOIN system.incus_client_certificates c ON c.id = t.certificate_id
    WHERE c.state = 'staged' AND t.server_id = :'server_id'::uuid
      AND t.state = 'pending')
FROM system.incus_client_certificates;
`,
  { server_id: server.id },
);
const [activeTrustState, activeCount, stagedCount, trustedCount, pendingCount] = verification.stdout
  .trim()
  .split('|');
if (
  activeTrustState !== 'verified' ||
  activeCount !== '1' ||
  stagedCount !== '1' ||
  trustedCount !== '1' ||
  pendingCount !== '1'
) {
  blocked('certificate fixture verification did not observe the active trust transition');
}

// Admin inventory is authoritative for fixture binding; the user-facing list is
// grant-filtered and would hide an ungranted seeded backend.
const sharedBackends = await jsonRequest('/api/admin/shared-backends', { token });
const fixtureFsid = process.env.E2E_CEPHFS_FSID?.trim();
const fixtureIdentity = process.env.E2E_CEPHFS_IDENTITY_KEY?.trim();
let selectedShared = process.env.E2E_SHARED_BACKEND_ID
  ? sharedBackends.find((entry) => entry.id === process.env.E2E_SHARED_BACKEND_ID)
  : undefined;
if (!selectedShared && fixtureIdentity) {
  selectedShared = sharedBackends.find((entry) => entry.identityKey === fixtureIdentity);
}
if (!selectedShared && fixtureFsid && fixtureIdentity) {
  selectedShared = await jsonRequest('/api/admin/shared-backends', {
    method: 'POST',
    token,
    body: {
      name: `e2e-cephfs-${runId}`.slice(0, 128),
      identityKey: fixtureIdentity,
      cephFsid: fixtureFsid,
      overcommitRatio: 1,
    },
  });
} else if (process.env.E2E_SHARED_BACKEND_ID?.trim() && !selectedShared) {
  blocked(`E2E_SHARED_BACKEND_ID ${process.env.E2E_SHARED_BACKEND_ID} is not visible to the control plane`);
}
if (selectedShared?.id) {
  process.env.E2E_SHARED_BACKEND_ID = selectedShared.id;
  writeFileSync(join(runtimeRoot, 'cephfs-backend.id'), `${selectedShared.id}\n`, {
    mode: 0o600,
  });
}

const cephfsEnabled = Boolean(
  selectedShared
  && process.env.E2E_CEPHFS_FSID?.trim()
  && process.env.E2E_CEPHFS_IDENTITY_KEY?.trim()
  && process.env.E2E_CEPHFS_INCUS_POOL?.trim(),
);
if (cephfsEnabled) {
  await discoverStoragePools(jsonRequest, server.id, token);
  await findAndRegisterCephExecutor(
    jsonRequest,
    selectedShared.id,
    server.id,
    process.env.E2E_CEPHFS_INCUS_POOL,
    token,
    'primary CephFS executor',
  );
}
const cephfsStatus = cephfsEnabled
  ? [
    'ENABLED: shared CephFS fixture',
    `backend=${selectedShared.id}`,
    `identityKey=${process.env.E2E_CEPHFS_IDENTITY_KEY}`,
    `fsid=${process.env.E2E_CEPHFS_FSID}`,
    `pool=${process.env.E2E_CEPHFS_INCUS_POOL}`,
  ].join(' ')
  : 'BLOCKED: no multi-node CephFS cluster is provisioned for this run';
const gpuStatus = process.env.E2E_GPU_PCI_PROOF === '1' && process.env.E2E_GPU_PCI_ADDRESS?.trim()
  ? `PROVEN: PCI ${process.env.E2E_GPU_PCI_ADDRESS}`
  : 'BLOCKED: GPU PCI hardware is not claimed by this lab';

const labServerDefs = loadLabServerDefs();
const labServers = [];
for (const definition of labServerDefs) {
  labServers.push(
    await seedLabServer(
      token,
      definition,
      image,
      selectedShared,
      routedNetwork,
      registration.dnsServers,
    ),
  );
}

const e2eSshPublicKeyFile = process.env.E2E_SSH_PRIVATE_KEY_FILE
  ? `${process.env.E2E_SSH_PRIVATE_KEY_FILE}.pub`
  : undefined;
if (!e2eSshPublicKeyFile || !existsSync(e2eSshPublicKeyFile)) {
  blocked('E2E SSH public key file is missing beside E2E_SSH_PRIVATE_KEY_FILE');
}
const e2eSshPublicKey = readFileSync(e2eSshPublicKeyFile, 'utf8').trim();
if (!e2eSshPublicKey.startsWith('ssh-')) {
  blocked('E2E SSH public key file is not a usable OpenSSH public key');
}
function normalizeOpenSshPublicKey(value) {
  const parts = String(value ?? '').trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : String(value ?? '').trim();
}
const normalizedE2eSshPublicKey = normalizeOpenSshPublicKey(e2eSshPublicKey);
const existingSshKeys = await jsonRequest(`/api/users/${session.user.id}/ssh-keys`, { token });
const alreadyRegistered = Array.isArray(existingSshKeys)
  && existingSshKeys.some(
    (entry) => normalizeOpenSshPublicKey(entry.keyText) === normalizedE2eSshPublicKey,
  );
if (!alreadyRegistered) {
  await jsonRequest(`/api/users/${session.user.id}/ssh-keys`, {
    method: 'POST',
    token,
    body: {
      name: `e2e-${runId}`,
      keyText: e2eSshPublicKey,
    },
  });
}

const gpuPci = process.env.E2E_GPU_PCI_ADDRESS?.trim() ?? '';
for (const extra of [{ id: server.id, role: undefined }, ...labServers]) {
  if (extra.role === 'gpu' && gpuPci) {
    await jsonRequest(`/api/admin/servers/${extra.id}/extensions/nvidia-gpu`, {
      method: 'PUT',
      token,
      body: { enabled: true },
    });
  }
  await jsonRequest(`/api/admin/users/${session.user.id}/server-grants/${extra.id}`, {
    method: 'PUT',
    token,
    body: {
      cpuMillis: 16_000,
      memBytes: 16 * 1024 * 1024 * 1024,
      diskBytes: 128 * 1024 * 1024 * 1024,
      extensionGrants: extra.role === 'gpu' && gpuPci
        ? { 'nvidia-gpu': { mode: 'pci', pciAddresses: [gpuPci] } }
        : {},
      expiresAt: null,
    },
  });
}
if (selectedShared?.id) {
  await jsonRequest(
    `/api/admin/users/${session.user.id}/shared-backend-grants/${selectedShared.id}`,
    {
      method: 'PUT',
      token,
      body: {
        limitBytes: 128 * 1024 * 1024 * 1024,
        expiresAt: null,
      },
    },
  );
}
const dirPoolIds = new Set();
if (registeredDir?.id) dirPoolIds.add(registeredDir.id);
if (registeredLvm?.id) dirPoolIds.add(registeredLvm.id);
for (const extra of labServers) {
  if (extra.dirPoolId) dirPoolIds.add(extra.dirPoolId);
}
for (const poolId of dirPoolIds) {
  await jsonRequest(
    `/api/admin/users/${session.user.id}/storage-pool-grants/${poolId}`,
    {
      method: 'PUT',
      token,
      body: { expiresAt: null },
    },
  );
}
const gpuPeerRow = labServers.find((entry) => entry.role === 'gpu')
  ?? labServers.find((entry) => String(entry.endpoint ?? '').includes('10.8.1.12'));
if (gpuPci && !gpuPeerRow) {
  blocked('E2E_GPU_PCI_ADDRESS is set but no GPU Incus worker was seeded');
}
const gpuPeer = gpuPeerRow && gpuPci
  ? {
    id: gpuPeerRow.id,
    name: gpuPeerRow.name,
    slug: gpuPeerRow.slug,
    endpoint: gpuPeerRow.endpoint,
    ssh: gpuPeerRow.ssh,
    parentInterface: gpuPeerRow.parentInterface,
    dirPoolId: gpuPeerRow.dirPoolId,
    pciAddress: gpuPci,
  }
  : undefined;

const state = {
  schemaVersion: 3,
  runId,
  profile,
  adminUserId: session.user.id,
  server: {
    id: server.id,
    createdByRun: serverCreatedByRun,
    name: currentServer.name,
    endpoint: currentServer.apiEndpoint,
    certificateFingerprint: currentServer.serverCertFingerprint,
    routedParent: currentServer.parentInterface,
    routedSubnet: routedNetwork.cidr,
    routedGateway: routedNetwork.gateway,
    ipPoolId: ipPool.id,
    systemPoolId: currentServer.systemPoolId,
    nodeMetrics: {
      endpoint: currentServer.nodeMetrics?.endpoint,
      serverCertFingerprint: currentServer.nodeMetrics?.serverCertFingerprint,
      tokenFingerprint: currentServer.nodeMetrics?.tokenFingerprint,
    },
  },
  image: {
    id: image.id,
    alias: image.alias,
    fingerprint: expectedImageFingerprint,
    sourceUrl: process.env.E2E_INCUS_IMAGE_SOURCE_URL,
    sshdWithoutDhcp: true,
    createdByRun: imageCreatedByRun,
    assignmentId: assignment.id,
    assignmentCreatedByRun: assignmentResult.createdByRun,
  },
  preflight: {
    imageAlias: process.env.E2E_INCUS_PREFLIGHT_IMAGE_ALIAS,
    imageFingerprint: expectedPreflightFingerprint,
    poolName: process.env.E2E_INCUS_PREFLIGHT_POOL_NAME,
    sourceServer: process.env.E2E_INCUS_PREFLIGHT_SOURCE_SERVER,
    egressUrl: process.env.E2E_INCUS_PREFLIGHT_EGRESS_URL,
    status: preflight.status,
    report: preflight.report,
  },
  storagePools: {
    dirQuotaOnline: {
      id: dir.id,
      name: dir.incusName,
      driver: 'dir',
      quotaOnline: true,
    },
    lvmBlockBacked: {
      id: lvm.id,
      name: lvm.incusName,
      driver: 'lvm',
      blockBacked: true,
    },
  },
  ...(selectedShared ? { sharedBackendId: selectedShared.id } : {}),
  labServers,
  ...(gpuPeer ? { gpuServer: gpuPeer } : {}),
  blocked: {
    gpu: gpuStatus,
    cephfs: cephfsStatus,
  },
};

mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
const statePath = join(runtimeRoot, 'seed-state.json');
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
chmodSync(statePath, 0o600);

await jsonRequest('/api/auth/logout', {
  method: 'POST',
  body: { refreshToken: session.refreshToken },
});
console.log(`seeded=${statePath}`);
