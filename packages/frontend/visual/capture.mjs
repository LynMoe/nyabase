#!/usr/bin/env node
/**
 * Local visual QA: Vite + mocked /api + Playwright screenshots.
 * Not product e2e. Not CI.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const shotsRoot = path.join(here, 'shots');
const BASE = process.env.VISUAL_BASE_URL ?? 'http://127.0.0.1:5173';
const ISO = '2026-01-15T08:00:00.000Z';
const CERT_EXPIRY = '2026-09-20T00:00:00.000Z';

const CAPS = [
  'manage_users', 'manage_groups', 'manage_servers', 'manage_images',
  'manage_storage_pools', 'manage_ip_pools', 'manage_shared_backends',
  'manage_volumes', 'manage_grants', 'manage_containers_any',
  'manage_preflight', 'manage_certificates', 'view_audit',
  'view_metrics_all', 'manage_system_settings',
];

const capability = {
  growOnline: true, shrinkOnline: false, shrinkRequiresStop: true,
  shrinkNever: false, enforceUsageFloor: true,
};
const actionOn = { enabled: true };
const actionOff = { enabled: false, reason: 'phase_not_active', message: '当前不可用' };

const user = {
  id: 'user-admin',
  username: 'admin',
  displayName: '平台管理员',
  status: 'active',
  createdAt: ISO,
  capabilities: CAPS,
  groups: [{ id: 'grp-admins', name: 'administrators', priority: 0, isSystem: true }],
};

const otherUser = {
  id: 'user-alice',
  username: 'alice',
  displayName: 'Alice Chen',
  status: 'active',
  createdAt: ISO,
  capabilities: [],
  groups: [{ id: 'grp-users', name: 'users', priority: 10, isSystem: true }],
};

const server = {
  id: 'srv-1',
  name: 'lab-node-a',
  slug: 'lab-node-a',
  apiEndpoint: 'https://10.0.0.11:8443',
  serverCertFingerprint: 'aa:bb:cc:dd:ee:ff',
  incusVersion: '6.12',
  apiExtensions: ['container_unix_socket'],
  systemPoolId: 'pool-1',
  systemPoolName: 'local',
  storageOvercommitRatio: 1,
  parentInterface: 'vmbr0',
  dnsServers: ['1.1.1.1'],
  enabledExtensions: ['nvidia-gpu'],
  extensionHealth: { 'nvidia-gpu': { runtimeReady: true } },
  status: 'online',
  lastSeenAt: ISO,
  lastError: null,
  revision: 3,
  preflightStatus: 'passed',
  preflightCheckedAt: ISO,
  preflightReport: { controlReady: true, checks: { storage: 'pass' }, failureCode: null },
  nodeMetrics: {
    endpoint: 'https://10.0.0.11:9100',
    serverCertFingerprint: '11:22:33',
    tokenFingerprint: 'tok-fp',
    health: { status: 'online', lastSuccessAt: ISO, outageSince: null, lastError: null },
  },
  createdAt: ISO,
  updatedAt: ISO,
};

const userServer = {
  id: server.id,
  name: server.name,
  slug: server.slug,
  status: server.status,
  lastSeenAt: server.lastSeenAt,
  preflightStatus: server.preflightStatus,
  enabledExtensions: server.enabledExtensions,
};

const pool = {
  id: 'pool-1',
  serverId: 'srv-1',
  incusName: 'local',
  displayName: '本地盘',
  driver: 'dir',
  resizeFamily: 'quota_online',
  rootDiskCapable: true,
  shareable: false,
  blockFilesystem: null,
  sharedBackendId: null,
  totalBytes: 500 * 1024 ** 3,
  usedBytes: 120 * 1024 ** 3,
  quotaEffective: true,
  registered: true,
  capability,
  lastObservedAt: ISO,
  revision: 2,
};

const container = {
  id: 'ctr-1',
  serverId: 'srv-1',
  serverName: 'lab-node-a',
  ownerId: 'user-admin',
  ownerName: '平台管理员',
  name: 'dev-workspace',
  instanceName: 'c-dev-workspace',
  imageId: 'img-1',
  imageName: 'ubuntu/24.04',
  imageFingerprint: 'sha256:abcd1234',
  rootPoolId: 'pool-1',
  rootPoolName: '本地盘',
  rootSizeBytes: 20 * 1024 ** 3,
  rootSizePendingBytes: null,
  rootUsedBytes: 8 * 1024 ** 3,
  rootCapability: capability,
  cpuMillis: 2000,
  memBytes: 4 * 1024 ** 3,
  extensions: {},
  powerIntent: 'running',
  lifecyclePhase: 'active',
  routedIp: '10.20.0.15',
  actual: { instanceName: 'c-dev-workspace', status: 'running', routedIp: '10.20.0.15', observedAt: ISO },
  ssh: {
    enabled: true, status: 'running', ready: true, loginUser: 'ubuntu',
    proxyHost: 'ssh.example.test', proxyPort: 2222,
    observedAt: ISO, lastError: null,
  },
  volumes: [{
    id: 'att-1', containerId: 'ctr-1', volumeId: 'vol-1', volumeName: 'data',
    deviceName: 'vol-data', containerPath: '/data', readOnly: false,
    kind: 'local', bindState: 'attached', onlineCancelAllowed: false,
    detachDrainedAt: null, createdAt: ISO, updatedAt: ISO,
  }],
  needsAttention: false,
  failureCode: null,
  failureReason: null,
  generation: 4,
  observedGeneration: 4,
  actions: {
    start: actionOff, stop: actionOn, restart: actionOn, delete: actionOn,
    stats: actionOn, console: actionOn,
  },
  createdAt: ISO,
  updatedAt: ISO,
};

const volume = {
  id: 'vol-1',
  ownerId: 'user-admin',
  poolId: 'pool-1',
  poolName: '本地盘',
  serverId: 'srv-1',
  sharedBackendId: null,
  name: 'data',
  incusName: 'vol-data',
  sizeBytes: 50 * 1024 ** 3,
  usedBytes: 12 * 1024 ** 3,
  scope: { kind: 'local', serverId: 'srv-1', poolId: 'pool-1' },
  capability,
  lifecyclePhase: 'active',
  generation: 2,
  observedGeneration: 2,
  needsAttention: false,
  failureCode: null,
  createdAt: ISO,
  updatedAt: ISO,
  attachments: [{
    attachmentId: 'att-1', containerId: 'ctr-1',
    containerName: 'dev-workspace', containerPath: '/data',
  }],
};

const image = {
  id: 'img-1',
  name: 'ubuntu-24.04',
  alias: 'ubuntu/24.04',
  fingerprint: 'sha256:abcd1234ffff',
  description: '开发用 Ubuntu',
  loginUser: 'ubuntu',
  minRootSizeBytes: 8 * 1024 ** 3,
  networkManagedExternally: false,
  isActive: true,
  deleting: false,
  cleanupGeneration: 0,
  revision: 1,
  createdAt: ISO,
  updatedAt: ISO,
  assignments: [{
    id: 'asg-1', imageId: 'img-1', serverId: 'srv-1', generation: 1,
    observedFingerprint: 'sha256:abcd1234ffff', managedFingerprint: 'sha256:abcd1234ffff',
    lifecyclePhase: 'active', needsAttention: false, failureCode: null,
    failureReason: null, lastObservedAt: ISO, createdAt: ISO, updatedAt: ISO,
  }],
};

const group = {
  id: 'grp-users',
  name: 'users',
  description: '普通用户组',
  priority: 10,
  isSystem: true,
  capabilities: [],
  revision: 1,
  createdAt: ISO,
  updatedAt: ISO,
  members: [{ userId: 'user-alice', username: 'alice', displayName: 'Alice Chen' }],
  memberCount: 1,
};

const backend = {
  id: 'be-1', name: 'ceph-lab', displayName: '实验室 Ceph',
  identityKey: 'ceph:lab', cephFsid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  totalBytes: 2 * 1024 ** 4, usedBytes: 400 * 1024 ** 3, overcommitRatio: 1,
  serverIds: ['srv-1'], hasOnlineExecutor: true, revision: 1, createdAt: ISO, updatedAt: ISO,
};

const ipPool = {
  id: 'ipp-1', name: 'lab-lan', cidr: '10.20.0.0/24', allocationCidr: '10.20.0.16/28',
  gateway: '10.20.0.1', reservedIps: ['10.20.0.1'], serverIds: ['srv-1'],
  allocatedCount: 3, usableCount: 10, revision: 1, createdAt: ISO, updatedAt: ISO,
};

const binding = {
  id: 'bind-1', mine: true, ownerId: 'user-admin', ownerUsername: 'admin',
  hostname: 'app.lab.test', domainPoolId: 'dp-1', domainPool: '*.lab.test',
  targetUrl: 'http://10.20.0.15:8080', containerId: 'ctr-1',
  containerName: 'dev-workspace', containerStatus: 'running', targetPort: 8080,
  entryHttpsEnabled: false, status: 'ready', warningReasons: [], warningMessage: '',
  createdAt: ISO, updatedAt: ISO,
};

const domainPool = {
  id: 'dp-1', wildcardDomain: '*.lab.test', enabled: true, httpsEnabled: false,
  certificatePem: null, privateKeyPem: null, certificateFingerprint: null,
  certificateNotAfter: null, revision: 1, createdAt: ISO, updatedAt: ISO,
};

const auditLog = {
  id: 'aud-1', ts: ISO, actorId: 'user-admin', actorName: '平台管理员', actorUsername: 'admin',
  action: 'container.create', targetType: 'container', targetId: 'ctr-1',
  targetName: 'dev-workspace', actorSnapshot: null, targetSnapshot: null, related: [], payload: null,
};

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function mockApi(urlString, method) {
  const url = new URL(urlString);
  const p = url.pathname.replace(/^\/api/, '') || '/';
  const m = method.toUpperCase();

  if (p === '/public/settings') {
    return json({ branding: { title: 'nyabase', description: '开发容器管理平台' }, sshProxy: { host: 'ssh.example.test', port: 2222 } });
  }
  if (p === '/auth/login' && m === 'POST') {
    return json({ accessToken: 'access-token', refreshToken: 'refresh-token', user });
  }
  if (p === '/auth/me') return json(user);
  if (p === '/auth/logout') return { status: 204, body: '' };
  if (p === '/auth/refresh' && m === 'POST') {
    return json({ accessToken: 'access-token', refreshToken: 'refresh-token', user });
  }

  if (p === '/servers') return json([userServer]);
  if (p === '/servers/srv-1') return json(userServer);
  if (p === '/admin/servers') return json([server]);
  if (p === '/admin/servers/srv-1') return json(server);
  if (p === '/admin/servers/srv-1/storage-pools' || p === '/servers/srv-1/storage-pools') return json([pool]);
  if (p === '/admin/servers/srv-1/preflight') {
    return json({
      serverId: 'srv-1', status: 'passed', checkedAt: ISO,
      report: { controlReady: true, checks: { incus: 'pass', bridge: 'pass' }, failureCode: null },
    });
  }
  if (p === '/admin/servers/srv-1/extensions') {
    return json([{
      extensionId: 'nvidia-gpu',
      displayName: 'NVIDIA GPU',
      enabled: true,
      health: { runtimeReady: true },
      occupiedDeviceCount: 0,
    }]);
  }
  if (
    p === '/admin/servers/srv-1/extensions/nvidia-gpu/devices'
    || p === '/servers/srv-1/extensions/nvidia-gpu/devices'
  ) {
    return json({ items: [{ pciAddress: '0000:01:00.0', model: 'RTX 4090' }], enabled: true });
  }

  if (p === '/containers' || p === '/admin/containers') return json([container]);
  if (p === '/containers/ctr-1' || p === '/admin/containers/ctr-1') return json(container);
  if (p.endsWith('/containers/ctr-1/volumes')) return json(container.volumes);
  if (p.endsWith('/containers/ctr-1/intents')) return json({ items: [{
    id: 'int-1', kind: 'container.create', resourceType: 'container', resourceId: 'ctr-1',
    serverId: 'srv-1', requestedBy: 'admin', requestSummary: { name: 'dev-workspace' },
    targetGeneration: 1, baseline: null, status: 'succeeded', failureCode: null, failure: null,
    attemptCount: 1, nextAttemptAt: null, createdAt: ISO, settledAt: ISO, blockedByIntentId: null,
  }], nextCursor: null });

  if (p === '/volumes' || p === '/admin/volumes') return json([volume]);
  if (p === '/images' || p === '/admin/images') return json([image]);
  if (p === '/admin/images/catalog') return json([{
    alias: 'ubuntu/24.04',
    aliases: ['ubuntu/24.04', 'ubuntu/noble'],
    fingerprint: 'b'.repeat(64),
    os: 'Ubuntu',
    release: '24.04',
    variant: 'default',
    version: '1',
    sizeBytes: 140283904,
    description: 'Ubuntu 24.04 default v1',
    added: false,
  }]);
  if (p === '/admin/users') return json([user, otherUser]);
  if (p === '/admin/users/user-admin') return json(user);
  if (p === '/admin/users/user-alice') return json(otherUser);
  if (p === '/admin/catalog/users') return json([user, otherUser]);
  if (p === '/admin/groups') return json([group]);
  if (p === '/admin/groups/grp-users') return json(group);
  if (p === '/admin/shared-backends' || p === '/shared-backends') return json([backend]);
  if (p === '/admin/ip-pools') return json([ipPool]);
  if (p === '/http-proxy/bindings' || p === '/admin/http-proxy/bindings') return json([binding]);
  if (p === '/http-proxy/domain-pools' || p === '/admin/http-proxy/domain-pools') return json([domainPool]);

  if (p === '/admin/incus-client-certificate') {
    return json({
      generation: 2,
      fingerprint: 'sha256:certfp',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: CERT_EXPIRY,
      state: 'active',
      servers: [{ serverId: 'srv-1', trustState: 'trusted', observedAt: ISO, lastError: null }],
    });
  }

  if (p === '/admin/ssh-proxy/status') {
    return json({
      connectedProxies: 1, activeConnections: 2, totalConnections: 40,
      totalRejectedConnections: 0, totalClosedConnections: 38,
      totalBytesFromClient: 1_024_000, totalBytesToClient: 4_096_000,
      bandwidthInBps: 1200, bandwidthOutBps: 8800, updatedAt: ISO,
      proxies: [{
        proxyId: 'px-1', hostname: 'edge-1', listen: '0.0.0.0:2222',
        activeConnections: 2, totalConnections: 40, bandwidthInBps: 1200, bandwidthOutBps: 8800,
        totalBytesFromClient: 1_024_000, totalBytesToClient: 4_096_000, lastSnapshotGeneration: 9,
        connections: [{ id: 'c1', user: 'alice', peer: '1.2.3.4:22' }],
      }],
    });
  }
  if (p === '/admin/ssh-proxy/host-key') {
    return json({ fingerprint: 'SHA256:hostkey', algorithm: 'ed25519', updatedAt: ISO });
  }
  if (p === '/admin/http-proxy/status') {
    return json({
      connectedProxies: 1, activeConnections: 3, totalRequests: 900,
      totalRejectedRequests: 2, updatedAt: ISO,
      proxies: [{
        proxyId: 'hpx-1', hostname: 'edge-http', httpListen: ':80', httpsListen: ':443',
        activeConnections: 3, totalRequests: 900, totalRejectedRequests: 2,
      }],
    });
  }

  if (p.startsWith('/audit/') && p !== '/audit/') {
    return json({
      ...auditLog, actorSnapshot: null, targetSnapshot: null, related: [],
      request: { name: 'dev-workspace' }, snapshots: [],
    });
  }
  if (p.startsWith('/audit')) {
    return json({
      items: [
        auditLog,
        {
          ...auditLog, id: 'aud-2', action: 'user.update',
          targetType: 'user', targetId: 'user-alice', targetName: 'Alice Chen',
        },
      ],
      total: 2, limit: 50, offset: 0,
    });
  }

  if (p === '/admin/system-settings') {
    const field = (key, label, valueKind, effectiveValue, extra = {}) => ({
      key, yamlPath: key, env: key.toUpperCase().replaceAll('.', '_'),
      valueKind, effectiveValue, source: 'database', yamlValue: effectiveValue,
      envValuePresent: false, defaultValue: effectiveValue, secret: false,
      editable: true, restartRequired: false, public: false, label,
      description: extra.description ?? '', ...extra,
    });
    const fields = [
      field('branding.title', '品牌标题', 'string', 'nyabase', { public: true }),
      field('branding.description', '品牌描述', 'string', '开发容器管理平台', { public: true }),
      field('auth.sessionHours', '会话时长', 'number', 12),
      field('ssh.enabled', '启用 SSH 代理', 'boolean', true),
    ];
    return json({
      revision: 4, snapshotToken: 'snap-1', configFile: '/etc/nyabase.yaml',
      fields, editable: fields, readOnly: [],
      publicSettings: { branding: { title: 'nyabase', description: '开发容器管理平台' }, sshProxy: null },
    });
  }

  if (p === '/users/user-admin/ssh-keys') {
    return json([{ id: 'key-1', name: 'laptop', keyText: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample laptop', createdAt: ISO }]);
  }

  if (p.includes('/server-grants')) {
    return json([{
      id: 'sg-1', scope: 'user', scopeId: 'user-alice', serverId: 'srv-1',
      cpuMillis: 4000, memBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3,
      gpu: { mode: 'none', pciAddresses: [] }, expiresAt: null, createdAt: ISO, updatedAt: ISO,
    }]);
  }
  if (p.includes('/storage-pool-grants')) return json([]);
  if (p.includes('/shared-backend-grants')) return json([]);
  if (p.includes('/effective-access')) {
    return json({
      servers: [{
        serverId: 'srv-1', cpuMillis: 4000, memBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3,
        gpu: { mode: 'none', pciAddresses: [] }, expiresAt: null, purgeAt: null,
        accessPhase: 'live', allowedImageIds: ['img-1'],
      }],
      sharedBackends: [],
    });
  }

  if (p.includes('/intents')) return json({ items: [], nextCursor: null });
  if (p.includes('/storage-capacity')) {
    return json({
      grantLimitBytes: 200 * 1024 ** 3, usedByRootDisksBytes: 20 * 1024 ** 3,
      usedByLocalVolumesBytes: 50 * 1024 ** 3, availableBytes: 130 * 1024 ** 3,
      pools: [{
        poolId: 'pool-1', displayName: '本地盘', driver: 'dir', shareable: false,
        totalBytes: pool.totalBytes, committedBytes: 70 * 1024 ** 3,
        availableBytes: 130 * 1024 ** 3, quotaEffective: true, overcommitRatio: 1, capability,
      }],
    });
  }
  if (p === '/me/access') {
    return json({
      servers: [{
        serverId: 'srv-1',
        cpuMillis: 4000,
        memBytes: 8 * 1024 ** 3,
        diskBytes: 200 * 1024 ** 3,
        extensionGrants: { 'nvidia-gpu': { pciAddresses: ['0000:01:00.0'] } },
        expiresAt: null,
        purgeAt: null,
        accessPhase: 'live',
        allowedImageIds: ['img-1'],
      }],
      sharedBackends: [{
        sharedBackendId: 'be-1',
        limitBytes: 500 * 1024 ** 3,
        usedBytes: 80 * 1024 ** 3,
        expiresAt: null,
      }],
    });
  }

  if (m !== 'GET') return json({ ok: true });
  return json([]);
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createServer();
    socket.once('error', () => resolve(true));
    socket.once('listening', () => { socket.close(() => resolve(false)); });
    socket.listen(port, '127.0.0.1');
  });
}

async function ensureVite() {
  if (await portOpen(5173)) return null;
  const child = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5173'], {
    cwd: frontendRoot,
    stdio: 'pipe',
    env: { ...process.env, BROWSER: 'none' },
  });
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (await portOpen(5173)) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Vite did not start on :5173');
}

async function waitSettled(page) {
  await page.waitForTimeout(250);
  await page.locator('.animate-spin').first().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(350);
}

async function shot(page, dir, name) {
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return path.relative(shotsRoot, file);
}

async function clickByText(page, text) {
  const loc = page.getByRole('button', { name: text }).first();
  if (await loc.count() === 0) return false;
  await loc.click();
  await waitSettled(page);
  return true;
}

async function selectFirstOption(page, triggerId) {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole('option').first().waitFor({ timeout: 5_000 });
  await page.getByRole('option').first().click();
  await waitSettled(page);
}

async function closeOverlay(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill('secret12');
  await page.locator('button[type="submit"]').click();
  await page.getByRole('heading', { name: '资源概览' }).waitFor({ timeout: 20_000 });
  await waitSettled(page);
}

const PAGES = [
  { name: 'dashboard', path: '/' },
  { name: 'quota', path: '/quota' },
  { name: 'containers', path: '/containers' },
  { name: 'container-overview', path: '/containers/ctr-1?tab=overview' },
  { name: 'container-storage', path: '/containers/ctr-1?tab=storage' },
  { name: 'container-intents', path: '/containers/ctr-1?tab=intents' },
  { name: 'volumes', path: '/volumes' },
  { name: 'shared-volumes', path: '/shared-volumes' },
  { name: 'http-proxy', path: '/http-proxy' },
  { name: 'profile', path: '/profile' },
  { name: 'servers', path: '/servers' },
  { name: 'server-detail', path: '/servers/srv-1' },
  { name: 'server-detail-connect', path: '/servers/srv-1?tab=connect' },
  { name: 'server-detail-storage', path: '/servers/srv-1?tab=storage' },
  { name: 'server-detail-preflight', path: '/servers/srv-1?tab=preflight' },
  { name: 'server-detail-metrics', path: '/servers/srv-1?tab=metrics' },
  { name: 'ip-pools', path: '/ip-pools' },
  { name: 'shared-backends', path: '/shared-backends' },
  { name: 'images', path: '/images' },
  { name: 'manage-containers', path: '/manage/containers' },
  { name: 'ssh-proxy', path: '/ssh-proxy' },
  { name: 'http-proxy-ops', path: '/http-proxy-ops' },
  { name: 'users', path: '/users' },
  { name: 'user-detail', path: '/users/user-alice' },
  { name: 'user-detail-grants', path: '/users/user-alice?tab=grants' },
  { name: 'groups', path: '/groups' },
  { name: 'group-detail', path: '/groups/grp-users' },
  { name: 'group-detail-members', path: '/groups/grp-users?tab=members' },
  { name: 'group-detail-grants', path: '/groups/grp-users?tab=grants' },
  { name: 'audit', path: '/audit' },
  { name: 'system-settings', path: '/system-settings' },
];

const DIALOGS = [
  { name: 'dialog-create-user', path: '/users', open: (p) => clickByText(p, '新建用户') },
  { name: 'dialog-disable-user', path: '/users/user-alice', open: (p) => clickByText(p, '停用') },
  { name: 'dialog-create-group', path: '/groups', open: (p) => clickByText(p, '新建用户组') },
  { name: 'dialog-create-container', path: '/containers', open: (p) => clickByText(p, '新建容器') },
  { name: 'dialog-create-volume', path: '/volumes', open: async (p) => {
    if (!await clickByText(p, '新建数据卷')) return false;
    await selectFirstOption(p, 'volume-server');
    await p.getByText(/剩余|额度不限/).first().waitFor({ timeout: 5_000 });
    return true;
  } },
  { name: 'dialog-create-shared-volume', path: '/shared-volumes', open: async (p) => {
    if (!await clickByText(p, '新建共享卷')) return false;
    await selectFirstOption(p, 'volume-shared-backend');
    await p.getByText(/剩余 .* \/ 额度/).first().waitFor({ timeout: 5_000 });
    return true;
  } },
  { name: 'dialog-delete-volume', path: '/volumes', open: (p) => clickByText(p, '删除') },
  { name: 'dialog-server-onboarding', path: '/servers', open: (p) => clickByText(p, '添加服务器') },
  { name: 'dialog-add-catalog-image', path: '/images', open: (p) => clickByText(p, '添加镜像') },
  { name: 'dialog-ip-pool', path: '/ip-pools', open: (p) => clickByText(p, '创建 IP 池') },
  { name: 'dialog-http-binding', path: '/http-proxy', open: (p) => clickByText(p, '新建发布') },
  { name: 'dialog-domain-pool', path: '/http-proxy-ops', open: (p) => clickByText(p, '新建域名池') },
  { name: 'dialog-ssh-disconnect', path: '/ssh-proxy', open: (p) => clickByText(p, '断开全部') },
  { name: 'dialog-audit-detail', path: '/audit', open: (p) => clickByText(p, '查看') },
  { name: 'dialog-stop-container', path: '/containers/ctr-1?tab=overview', open: (p) => clickByText(p, '停止') },
  { name: 'dialog-edit-container-spec', path: '/containers/ctr-1?tab=overview', open: (p) => clickByText(p, '编辑规格') },
  { name: 'dialog-resize-root', path: '/containers/ctr-1?tab=storage', open: (p) => clickByText(p, '调整容量') },
  { name: 'dialog-attach-volume', path: '/containers/ctr-1?tab=storage', open: (p) => clickByText(p, '挂载') },
  { name: 'dialog-change-password', path: '/profile', open: (p) => clickByText(p, '修改密码') },
  { name: 'dialog-edit-user', path: '/users/user-alice', open: (p) => clickByText(p, '编辑') },
  { name: 'dialog-edit-group', path: '/groups/grp-users', open: (p) => clickByText(p, '编辑') },
  { name: 'dialog-server-storage-settings', path: '/servers/srv-1?tab=storage', open: (p) => clickByText(p, '编辑存储设置') },
  { name: 'dialog-server-connect', path: '/servers/srv-1?tab=connect', open: (p) => clickByText(p, '连接服务器') },
  { name: 'dialog-delete-ssh-key', path: '/profile', open: async (p) => {
    const btn = p.getByRole('button', { name: /删除 SSH 公钥/ });
    if (await btn.count() === 0) return false;
    await btn.first().click();
    await p.waitForTimeout(350);
    return true;
  } },
  { name: 'dialog-add-ssh-key', path: '/profile', open: (p) => clickByText(p, '添加公钥') },
  { name: 'dialog-grant-server', path: '/users/user-alice?tab=grants', open: async (p) => {
    const btn = p.getByTestId('grant-add-server');
    if (await btn.count() === 0) return false;
    await btn.click();
    await waitSettled(p);
    return true;
  } },
  { name: 'dialog-grant-pool', path: '/users/user-alice?tab=grants', open: async (p) => {
    const btn = p.getByTestId('grant-add-pool');
    if (await btn.count() === 0) return false;
    await btn.click();
    await waitSettled(p);
    return true;
  } },
  { name: 'dialog-grant-backend', path: '/users/user-alice?tab=grants', open: async (p) => {
    const btn = p.getByTestId('grant-add-backend');
    if (await btn.count() === 0) return false;
    await btn.click();
    await waitSettled(p);
    return true;
  } },
  { name: 'dialog-add-group-member', path: '/groups/grp-users?tab=members', open: (p) => clickByText(p, '添加成员') },
];

async function captureViewport(browser, viewport, label) {
  const dir = path.join(shotsRoot, label);
  await mkdir(dir, { recursive: true });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: label === 'mobile' ? 2 : 1,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const res = mockApi(req.url(), req.method());
    await route.fulfill(res);
  });

  const files = [];
  await page.goto(`${BASE}/login?reason=session-expired`, { waitUntil: 'domcontentloaded' });
  await waitSettled(page);
  files.push({ name: 'login', file: await shot(page, dir, 'login'), kind: 'page' });

  await login(page);

  const only = process.env.VISUAL_ONLY
    ? new Set(process.env.VISUAL_ONLY.split(',').map((name) => name.trim()).filter(Boolean))
    : null;
  const pages = only ? PAGES.filter((item) => only.has(item.name)) : PAGES;
  const dialogs = only ? DIALOGS.filter((item) => only.has(item.name)) : DIALOGS;

  for (const item of pages) {
    await page.goto(`${BASE}${item.path}`, { waitUntil: 'domcontentloaded' });
    await waitSettled(page);
    files.push({ name: item.name, file: await shot(page, dir, item.name), kind: 'page' });
  }

  if (label === 'mobile' && (!only || only.has('mobile-nav-sheet'))) {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await waitSettled(page);
    const menu = page.getByRole('button', { name: '打开导航' });
    if (await menu.count()) {
      await menu.click();
      await page.waitForTimeout(400);
      files.push({ name: 'mobile-nav-sheet', file: await shot(page, dir, 'mobile-nav-sheet'), kind: 'overlay' });
      await closeOverlay(page);
    }
  }

  for (const dialog of dialogs) {
    await page.goto(`${BASE}${dialog.path}`, { waitUntil: 'domcontentloaded' });
    await waitSettled(page);
    const opened = await dialog.open(page).catch(() => false);
    if (!opened) {
      files.push({ name: dialog.name, file: null, kind: 'dialog', skipped: true });
      continue;
    }
    files.push({ name: dialog.name, file: await shot(page, dir, dialog.name), kind: 'dialog' });
    await closeOverlay(page);
  }

  await context.close();
  return files;
}

async function main() {
  await mkdir(shotsRoot, { recursive: true });
  const vite = await ensureVite();
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await captureViewport(browser, { width: 1280, height: 800 }, 'desktop');
    const mobile = await captureViewport(browser, { width: 390, height: 844 }, 'mobile');
    const manifest = {
      generatedAt: new Date().toISOString(),
      base: BASE,
      viewports: { desktop: '1280x800', mobile: '390x844' },
      desktop,
      mobile,
    };
    await writeFile(path.join(shotsRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const taken = [...desktop, ...mobile].filter((x) => x.file).length;
    const skipped = [...desktop, ...mobile].filter((x) => x.skipped).length;
    console.log(`Wrote ${taken} screenshots (${skipped} dialogs skipped) to ${shotsRoot}`);
  } finally {
    await browser.close();
    if (vite) vite.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
