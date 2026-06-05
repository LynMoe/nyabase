#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = new URL('../..', import.meta.url).pathname;
const envPath = process.env.NYABASE_TEST_ENV_FILE
  ? join(root, process.env.NYABASE_TEST_ENV_FILE)
  : join(root, 'test/config/local.env');
const env = await loadEnv(envPath);

const backendUrl = stripTrailingSlash(process.env.NYABASE_BACKEND_URL ?? env.NYABASE_BACKEND_URL ?? 'http://localhost:3001');
const apiBase = `${backendUrl}/api`;
const adminUsername = process.env.ADMIN_USERNAME ?? env.ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.ADMIN_INIT_PASSWORD ?? env.ADMIN_INIT_PASSWORD;
if (!adminPassword) throw new Error('ADMIN_INIT_PASSWORD must be set in test/config/local.env or env');

const runId = process.env.NYABASE_MOUNT_RUN_ID ?? `${timestamp()}-${randomBytes(3).toString('hex')}`;
const runPrefix = `mount-${runId}`;
const coordDir = join(root, 'test/runtime/mount', runId);
const localMountPoint = process.env.NYABASE_MOUNT_LOCAL_MOUNTPOINT ?? env.NYABASE_MOUNT_LOCAL_MOUNTPOINT;
const nfsServer = process.env.NYABASE_MOUNT_NFS_SERVER ?? env.NYABASE_MOUNT_NFS_SERVER;
const nfsExport = process.env.NYABASE_MOUNT_NFS_EXPORT ?? env.NYABASE_MOUNT_NFS_EXPORT;

if (!localMountPoint) throw new Error('NYABASE_MOUNT_LOCAL_MOUNTPOINT must be set in test/config/local.env or env');
if (!nfsServer) throw new Error('NYABASE_MOUNT_NFS_SERVER must be set in test/config/local.env or env');
if (!nfsExport) throw new Error('NYABASE_MOUNT_NFS_EXPORT must be set in test/config/local.env or env');

await mkdir(coordDir, { recursive: true, mode: 0o700 });

const admin = await request('POST', '/auth/login', undefined, {
  username: adminUsername,
  password: adminPassword,
});
const token = admin.accessToken;

const servers = await request('GET', '/admin/servers', token);
const cpu = servers.find((server) => server.status === 'online' && !server.isGpuServer);
if (!cpu) throw new Error('No online CPU server found. Run register/deploy agents first.');

const localDisk = await ensureLocalDisk(token, cpu.id, localMountPoint);
const remoteMount = await ensureRemoteMount(token, cpu.id, runPrefix, nfsServer, nfsExport);
const image = await createImage(token, runPrefix);
await pullImageOnServer(token, image.id, cpu.id);
const users = await createFixtureUsers(token, runPrefix, coordDir);

for (const persona of Object.values(users)) {
  await request('POST', `/admin/users/${persona.user.id}/server-grants/${cpu.id}`, token, {
    cpuMillis: 1000,
    memBytes: 512 * 1024 * 1024,
    diskBytes: 0,
    gpuMode: 'none',
    gpuIndices: [],
  });
  await request('POST', `/admin/users/${persona.user.id}/image-grants`, token, {
    imageId: image.id,
    serverId: cpu.id,
  });
}

await grantMountSource(token, users.alphaLocal.user.id, 'local', localDisk.diskId);
await grantMountSource(token, users.betaRemote.user.id, 'remote', remoteMount.id);
await grantMountSource(token, users.deltaBoth.user.id, 'local', localDisk.diskId);
await grantMountSource(token, users.deltaBoth.user.id, 'remote', remoteMount.id);

const localSourceForState = {
  kind: 'local',
  id: localDisk.diskId,
  serverId: cpu.id,
  label: localDisk.label ?? 'test-local',
  hostRoot: localDisk.mountPoint,
};
const remoteSourceForState = {
  kind: 'remote',
  id: remoteMount.id,
  serverId: cpu.id,
  label: remoteMount.displayName ?? remoteMount.name,
  hostRoot: remoteMount.hostMountPoint,
};

const state = {
  schema: 'nyabase.mount-fixture.v1',
  createdAt: new Date().toISOString(),
  backendUrl,
  runPrefix,
  cpuServerId: cpu.id,
  paths: {
    baseDir: coordDir,
    exportDir: nfsExport,
    hostMountPoint: remoteMount.hostMountPoint,
  },
  sources: {
    local: { id: localDisk.diskId, mountPoint: localDisk.mountPoint, label: localDisk.label ?? 'test-local' },
    remote: {
      id: remoteMount.id,
      name: remoteMount.name,
      hostMountPoint: remoteMount.hostMountPoint,
      serverId: cpu.id,
      status: summarizeRemoteStatus(remoteMount, cpu.id),
    },
  },
  image: { id: image.id, dockerImage: image.dockerImage, name: image.name },
  users: {
    alphaLocal: toFixtureUser(users.alphaLocal, [localSourceForState]),
    betaRemote: toFixtureUser(users.betaRemote, [remoteSourceForState]),
    deltaBoth: toFixtureUser(users.deltaBoth, [localSourceForState, remoteSourceForState]),
  },
  credentials: {
    alphaLocal: users.alphaLocal.credentialFile,
    betaRemote: users.betaRemote.credentialFile,
    deltaBoth: users.deltaBoth.credentialFile,
  },
};

const statePath = join(coordDir, 'state.json');
const currentEnvPath = join(root, 'test/runtime/mount/current.env');
await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
await chmod(statePath, 0o600);
await writeFile(currentEnvPath, [
  `NYABASE_MOUNT_COORD_DIR=${coordDir}`,
  `NYABASE_MOUNT_STATE=${statePath}`,
  `NYABASE_MOUNT_RUNTIME_REPORT_MD=${join(coordDir, 'mount-runtime-report.md')}`,
  `NYABASE_MOUNT_RUNTIME_REPORT_JSON=${join(coordDir, 'mount-runtime-report.json')}`,
  '',
].join('\n'), { mode: 0o600 });
await chmod(currentEnvPath, 0o600);

console.log(`Created mount fixture: ${statePath}`);
console.log(`Wrote ${currentEnvPath}`);

async function ensureLocalDisk(token, serverId, mountPoint) {
  const existing = await request('GET', `/admin/servers/${serverId}/disks`, token);
  const found = existing.find((disk) => disk.mountPoint === mountPoint);
  if (found) return found;
  return request('POST', `/admin/servers/${serverId}/disks`, token, {
    mountPoint,
    label: 'nyabase test local source',
  });
}

async function ensureRemoteMount(token, serverId, prefix, nfsServer, exportPath) {
  const existing = await request('GET', `/admin/remote-fs-mounts?serverId=${encodeURIComponent(serverId)}`, token);
  const found = existing.find((mount) => mount.name === `${prefix}-nfs`);
  if (found) return found;

  const created = await request('POST', '/admin/remote-fs-mounts', token, {
    name: `${prefix}-nfs`,
    displayName: `${prefix} NFS`,
    description: 'Generated by test/scripts/create-mount-fixture.mjs',
    serverIds: [serverId],
    options: 'rw',
    hostMountPoint: `/mnt/nyabase-test/${prefix}-nfs`,
    params: {
      type: 'nfs',
      nfsServer,
      exportPath,
      version: '4.2',
    },
  });

  return waitForRemoteMount(token, created.id, serverId);
}

async function waitForRemoteMount(token, mountId, serverId) {
  for (let i = 0; i < 45; i += 1) {
    const mount = await request('GET', `/admin/remote-fs-mounts/${mountId}`, token);
    const status = summarizeRemoteStatus(mount, serverId);
    if (status === 'mounted') return mount;
    if (status === 'error') {
      throw new Error(`Remote FS mount ${mountId} failed on ${serverId}: ${JSON.stringify(mount.serverStatuses?.[serverId] ?? {})}`);
    }
    await sleep(1000);
  }
  const mount = await request('GET', `/admin/remote-fs-mounts/${mountId}`, token);
  throw new Error(`Remote FS mount ${mountId} was not mounted on ${serverId}: ${JSON.stringify(mount.serverStatuses?.[serverId] ?? {})}`);
}

async function createImage(token, prefix) {
  return request('POST', '/admin/images', token, {
    name: `${prefix}-alpine`,
    dockerImage: 'alpine:3.20',
    defaultUid: 0,
    runtimeOverrides: {
      uid: 0,
      entrypoint: null,
      cmd: ['sleep', 'infinity'],
      init: true,
    },
  });
}


async function pullImageOnServer(token, imageId, serverId) {
  const pull = await request('POST', `/admin/images/${imageId}/pull`, token, { serverIds: [serverId] });
  if (!pull.started?.includes(serverId) && !pull.skipped?.includes(serverId)) {
    throw new Error(`Image pull did not target CPU server ${serverId}: ${JSON.stringify(pull)}`);
  }

  for (let i = 0; i < 180; i += 1) {
    const statuses = await request('GET', `/admin/images/${imageId}/status`, token);
    const status = statuses.find((entry) => entry.serverId === serverId);
    if (status?.present) return;
    if (status?.error) throw new Error(`Image pull failed on ${serverId}: ${status.error}`);
    await sleep(1000);
  }

  throw new Error(`Image ${imageId} was not reported present on ${serverId} after pull timeout`);
}

async function createFixtureUsers(token, prefix, coordDir) {
  const specs = {
    alphaLocal: 'Alpha Local',
    betaRemote: 'Beta Remote',
    deltaBoth: 'Delta Both',
  };
  const out = {};
  for (const [key, displayName] of Object.entries(specs)) {
    const username = `${prefix}-${key}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const password = `T${randomBytes(14).toString('base64url')}9`;
    const user = await request('POST', '/admin/users', token, { username, password, displayName });
    const credentialFile = join(coordDir, `${key}.env`);
    await writeFile(credentialFile, [
      `NYABASE_USERNAME=${username}`,
      `NYABASE_PASSWORD=${password}`,
      '',
    ].join('\n'), { mode: 0o600 });
    await chmod(credentialFile, 0o600);
    const login = await request('POST', '/auth/login', undefined, { username, password });
    out[key] = { user: login.user, credentialFile };
  }
  return out;
}

async function grantMountSource(token, userId, sourceKind, sourceId) {
  await request('POST', `/admin/users/${userId}/mount-source-grants`, token, { sourceKind, sourceId });
}

async function request(method, path, token, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function loadEnv(path) {
  if (!existsSync(path)) return {};
  const text = await readFile(path, 'utf8');
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const eq = trimmed.indexOf('=');
    if (eq === -1) return [[trimmed, '']];
    return [[trimmed.slice(0, eq), trimmed.slice(eq + 1)]];
  }));
}

function toFixtureUser(persona, mountSources) {
  return {
    id: persona.user.id,
    username: persona.user.username,
    displayName: persona.user.displayName ?? persona.user.username,
    capabilities: persona.user.capabilities ?? [],
    verifiedLogin: true,
    mountSources,
  };
}

function summarizeRemoteStatus(mount, serverId) {
  const status = mount.serverStatuses?.[serverId]?.status;
  return typeof status === 'string' ? status : 'unknown';
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
