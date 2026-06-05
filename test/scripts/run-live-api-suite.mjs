#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = new URL('../..', import.meta.url).pathname;
const env = await loadEnv(process.env.NYABASE_TEST_ENV_FILE ? join(root, process.env.NYABASE_TEST_ENV_FILE) : join(root, 'test/config/local.env'));

const backendUrl = stripTrailingSlash(process.env.NYABASE_BACKEND_URL ?? env.NYABASE_BACKEND_URL ?? 'http://localhost:3001');
const frontendUrl = stripTrailingSlash(process.env.NYABASE_FRONTEND_URL ?? env.NYABASE_FRONTEND_URL ?? 'http://localhost:5173');
const apiBase = `${backendUrl}/api`;
const adminUsername = process.env.ADMIN_USERNAME ?? env.ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.ADMIN_INIT_PASSWORD ?? env.ADMIN_INIT_PASSWORD ?? 'admin123';
const runId = process.env.NYABASE_LIVE_API_RUN_ID ?? `${timestamp()}-${randomBytes(3).toString('hex')}`;
const fixturePrefix = process.env.NYABASE_LIVE_API_PREFIX ?? 'live-api';
const runtimeDir = join(root, 'test/runtime/live-api');
const runDir = join(runtimeDir, 'runs', runId);
const fixturePath = join(runtimeDir, 'fixture.json');
const reportPath = join(runDir, 'report.json');
const reportMdPath = join(runDir, 'report.md');
const currentEnvPath = join(runtimeDir, 'current.env');

const localMountPoint = process.env.NYABASE_MOUNT_LOCAL_MOUNTPOINT ?? env.NYABASE_MOUNT_LOCAL_MOUNTPOINT;
const nfsServer = process.env.NYABASE_MOUNT_NFS_SERVER ?? env.NYABASE_MOUNT_NFS_SERVER;
const nfsExport = process.env.NYABASE_MOUNT_NFS_EXPORT ?? env.NYABASE_MOUNT_NFS_EXPORT;

const keepContainers = process.env.NYABASE_LIVE_API_KEEP_CONTAINERS === '1';
const pullImages = process.env.NYABASE_LIVE_API_PULL_IMAGES !== '0';
const enableRemoteFs = process.env.NYABASE_LIVE_API_ENABLE_REMOTE_FS !== '0';
const smokeOnly = process.argv.includes('--smoke');

const results = [];
const cleanupContainers = [];
let cachedAdmin;

await mkdir(runDir, { recursive: true, mode: 0o700 });

try {
  await step('backend auth endpoint is reachable', async () => {
    const res = await raw('GET', '/auth/me');
    assert([401, 200].includes(res.status), `expected 401 or 200, got ${res.status}`);
  });

  await step('frontend is reachable', async () => {
    const res = await fetch(`${frontendUrl}/`);
    assert(res.ok, `frontend ${frontendUrl} returned ${res.status}`);
  });

  const admin = await step('admin login and token refresh/logout APIs work', async () => {
    const login = await api('POST', '/auth/login', undefined, { username: adminUsername, password: adminPassword });
    assert(login.body.accessToken, 'missing admin accessToken');
    assert(login.body.refreshToken, 'missing admin refreshToken');
    const refreshed = await api('POST', '/auth/refresh', undefined, { refreshToken: login.body.refreshToken });
    assert(refreshed.body.accessToken, 'missing refreshed accessToken');
    const token = await api('POST', '/auth/tokens', login.body.accessToken, { name: `live-api-${runId}` }, [200, 201]);
    assert(token.body.secret, 'missing API token secret');
    await api('GET', '/auth/tokens', login.body.accessToken);
    await api('DELETE', `/auth/tokens/${token.body.token.id}`, login.body.accessToken, undefined, [204]);
    await api('POST', '/auth/logout', login.body.accessToken, { refreshToken: refreshed.body.refreshToken }, [204]);
    return login.body;
  });

  if (smokeOnly) {
    await writeReports('pass');
    printSummary();
    process.exit(0);
  }

  const fixture = await step('admin prepares persistent servers, disks, images, users, groups, grants, and quotas', async () => ensureFixture(admin.accessToken));

  await step('admin management APIs expose prepared fixture', async () => {
    await api('GET', '/admin/users', admin.accessToken);
    await api('GET', `/admin/users/${fixture.users.alpha.id}`, admin.accessToken);
    await api('GET', '/admin/groups', admin.accessToken);
    await api('GET', `/admin/groups/${fixture.groups.operators.id}`, admin.accessToken);
    await api('GET', `/admin/groups/${fixture.groups.operators.id}/members`, admin.accessToken);
    await api('GET', `/admin/groups/${fixture.groups.operators.id}/server-grants`, admin.accessToken);
    await api('GET', `/admin/groups/${fixture.groups.operators.id}/image-grants`, admin.accessToken);
    await api('GET', `/admin/groups/${fixture.groups.operators.id}/mount-source-grants`, admin.accessToken);
    await api('GET', `/admin/users/${fixture.users.alpha.id}/server-grants`, admin.accessToken);
    await api('GET', `/admin/users/${fixture.users.alpha.id}/image-grants`, admin.accessToken);
    await api('GET', `/admin/users/${fixture.users.alpha.id}/mount-source-grants`, admin.accessToken);
    await api('GET', `/admin/users/${fixture.users.alpha.id}/effective-access`, admin.accessToken);
    await api('GET', '/admin/images?activeOnly=true', admin.accessToken);
    await api('GET', `/admin/images/${fixture.images.alpine.id}`, admin.accessToken);
    await api('GET', `/admin/images/${fixture.images.alpine.id}/status`, admin.accessToken);
    await api('GET', `/admin/servers/${fixture.servers.cpu.id}`, admin.accessToken);
    await api('GET', `/admin/servers/${fixture.servers.cpu.id}/disks`, admin.accessToken);
    await api('GET', '/admin/servers/all-disks', admin.accessToken);
    await api('GET', `/admin/servers/${fixture.servers.cpu.id}/self-check`, admin.accessToken);
    await api('GET', `/admin/data-dirs?serverId=${fixture.servers.cpu.id}`, admin.accessToken);
    await api('GET', '/admin/data-dirs/issues', admin.accessToken);
    await api('GET', '/admin/v2/containers', admin.accessToken);
    await api('GET', '/audit?limit=20', admin.accessToken);
  });

  await step('admin cleans stale live-api runtime containers before persona run', async () => {
    await cleanupStaleLiveApiContainers(admin.accessToken);
  });

  await runPersona('alpha', fixture, async (actor) => {
    const source = fixture.sources.local;
    await userProfileChecks(actor);
    await userAccessChecks(actor, fixture, source);
    await dataDirChecks(actor, fixture, source);
    const c = await containerChecks(actor, fixture, {
      imageId: fixture.images.alpine.id,
      source,
      name: `${fixturePrefix}-alpha-${runId}`.slice(0, 63),
      ssh: true,
    });
    await adminContainerRead(admin.accessToken, c.id);
  });

  await runPersona('beta', fixture, async (actor) => {
    const source = fixture.sources.remote ?? fixture.sources.local;
    await userAccessChecks(actor, fixture, source);
    await dataDirChecks(actor, fixture, source);
    await containerChecks(actor, fixture, {
      imageId: fixture.images.ubuntu.id,
      source,
      name: `${fixturePrefix}-beta-${runId}`.slice(0, 63),
      ssh: false,
    });
  });

  await runPersona('gamma', fixture, async (actor) => {
    if (!fixture.servers.gpu || !fixture.images.gpu) {
      record('gamma GPU flow blocked by missing online GPU server', 'blocked', { reason: 'No online GPU server or GPU image fixture' });
      return;
    }
    const c = await containerChecks(actor, fixture, {
      serverId: fixture.servers.gpu.id,
      imageId: fixture.images.gpu.id,
      source: null,
      name: `${fixturePrefix}-gamma-${runId}`.slice(0, 63),
      ssh: false,
    });
    await api('GET', `/metrics/servers/${fixture.servers.gpu.id}/containers?range=5m`, actor.token, undefined, [200, 403]);
    await removeContainer(actor.token, c.id);
  });

  await runPersona('delta', fixture, async (actor) => {
    const deniedAdmin = await raw('GET', '/admin/users', actor.token);
    assert(deniedAdmin.status === 403, `ordinary user admin/users expected 403, got ${deniedAdmin.status}`);
    const deniedAudit = await raw('GET', '/audit', actor.token);
    assert(deniedAudit.status === 403, `ordinary user audit expected 403, got ${deniedAudit.status}`);
    const deniedServer = await raw('GET', `/servers/${fixture.servers.cpu.id}`, actor.token);
    assert([403, 404].includes(deniedServer.status), `ungranted server expected 403/404, got ${deniedServer.status}`);
    const deniedCreate = await raw('POST', '/v2/containers', actor.token, {
      serverId: fixture.servers.cpu.id,
      imageId: fixture.images.alpine.id,
      name: `${fixturePrefix}-denied-${runId}`.slice(0, 63),
    });
    assert([403, 404].includes(deniedCreate.status), `ungranted container create expected 403/404, got ${deniedCreate.status}`);
  });

  await step('admin metrics, audit, operations, and cleanup paths work after persona operations', async () => {
    await api('GET', `/admin/metrics/servers/${fixture.servers.cpu.id}/host?range=5m`, admin.accessToken);
    await api('GET', `/admin/metrics/servers/${fixture.servers.cpu.id}/users?range=5m`, admin.accessToken);
    await api('GET', `/admin/metrics/servers/${fixture.servers.cpu.id}/containers?range=5m`, admin.accessToken);
    if (fixture.servers.gpu) await api('GET', `/admin/metrics/servers/${fixture.servers.gpu.id}/gpus?range=5m`, admin.accessToken);
    await api('GET', '/audit?limit=50', admin.accessToken);
    for (const c of [...cleanupContainers]) await removeContainer(admin.accessToken, c.id, true);
  });

  await writeReports('pass');
  printSummary();
  process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
} catch (error) {
  await cleanupBestEffort();
  record('suite failed', 'fail', { error: String(error?.stack ?? error) });
  await writeReports('fail');
  printSummary();
  process.exit(1);
}

async function ensureFixture(adminToken) {
  const existing = await readJsonIfExists(fixturePath);
  const servers = await discoverServers(adminToken);
  const local = await ensureLocalDisk(adminToken, servers.cpu.id);
  const remote = await ensureRemoteMount(adminToken, servers.cpu.id);
  const images = await ensureImages(adminToken, servers);
  const users = await ensureUsers(adminToken);
  const groups = await ensureGroups(adminToken, users);

  await ensureServerGrant(adminToken, 'user', users.alpha.id, servers.cpu.id, { cpuMillis: 1000, memBytes: 512 * 1024 * 1024, diskBytes: 256 * 1024 * 1024, gpuMode: 'none', gpuIndices: [] });
  await ensureServerGrant(adminToken, 'group', groups.operators.id, servers.cpu.id, { cpuMillis: 1500, memBytes: 1024 * 1024 * 1024, diskBytes: 512 * 1024 * 1024, gpuMode: 'none', gpuIndices: [] });
  if (servers.gpu && images.gpu) {
    await ensureServerGrant(adminToken, 'user', users.gamma.id, servers.gpu.id, { cpuMillis: 1000, memBytes: 1024 * 1024 * 1024, diskBytes: 256 * 1024 * 1024, gpuMode: 'indices', gpuIndices: [0] });
  }

  await ensureImageGrant(adminToken, 'user', users.alpha.id, images.alpine.id, servers.cpu.id);
  await ensureImageGrant(adminToken, 'group', groups.operators.id, images.ubuntu.id, servers.cpu.id);
  if (servers.gpu && images.gpu) await ensureImageGrant(adminToken, 'user', users.gamma.id, images.gpu.id, servers.gpu.id);

  await ensureMountGrant(adminToken, 'user', users.alpha.id, 'local', local.diskId);
  await ensureMountGrant(adminToken, 'group', groups.operators.id, 'local', local.diskId);
  if (remote) {
    await ensureMountGrant(adminToken, 'group', groups.operators.id, 'remote', remote.id);
    await ensureMountGrant(adminToken, 'user', users.alpha.id, 'remote', remote.id);
  }

  const fixture = {
    schema: 'nyabase.live-api-fixture.v1',
    updatedAt: new Date().toISOString(),
    backendUrl,
    frontendUrl,
    prefix: fixturePrefix,
    servers,
    sources: {
      local: { kind: 'local', id: local.diskId, serverId: servers.cpu.id, label: local.label ?? fixturePrefix, mountPoint: local.mountPoint },
      remote: remote ? { kind: 'remote', id: remote.id, serverId: servers.cpu.id, name: remote.name, hostMountPoint: remote.hostMountPoint } : null,
    },
    images,
    users,
    groups,
    reusedFrom: existing?.updatedAt ?? null,
  };
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
  await chmod(fixturePath, 0o600);
  await writeFile(currentEnvPath, [
    `NYABASE_LIVE_API_FIXTURE=${fixturePath}`,
    `NYABASE_LIVE_API_REPORT=${reportPath}`,
    `NYABASE_LIVE_API_REPORT_MD=${reportMdPath}`,
    '',
  ].join('\n'), { mode: 0o600 });
  await chmod(currentEnvPath, 0o600);
  return fixture;
}

async function discoverServers(token) {
  const servers = (await api('GET', '/admin/servers', token)).body;
  const cpu = servers.find((s) => s.status === 'online' && !s.isGpuServer) ?? servers.find((s) => !s.isGpuServer);
  assert(cpu, 'no CPU server is registered; run register/deploy agents first');
  const gpu = servers.find((s) => s.status === 'online' && s.isGpuServer) ?? null;
  await api('PATCH', `/admin/servers/${cpu.id}/defaults`, token, {
    defaultCpuMillis: 1000,
    defaultMemBytes: 1024 * 1024 * 1024,
    defaultDiskBytes: 1024 * 1024 * 1024,
    defaultGpuMode: 'none',
    defaultGpuIndices: [],
  });
  if (gpu) {
    await api('PATCH', `/admin/servers/${gpu.id}/defaults`, token, {
      defaultCpuMillis: 1000,
      defaultMemBytes: 1024 * 1024 * 1024,
      defaultDiskBytes: 1024 * 1024 * 1024,
      defaultGpuMode: 'indices',
      defaultGpuIndices: [0],
    });
  }
  return { cpu: pickServer(cpu), gpu: gpu ? pickServer(gpu) : null };
}

async function ensureLocalDisk(token, serverId) {
  assert(localMountPoint, 'NYABASE_MOUNT_LOCAL_MOUNTPOINT is required');
  const disks = (await api('GET', `/admin/servers/${serverId}/disks`, token)).body;
  const found = disks.find((d) => d.mountPoint === localMountPoint);
  if (found) {
    await api('PATCH', `/admin/servers/${serverId}/disks/${found.diskId}`, token, { label: `${fixturePrefix}-local` });
    return { ...found, label: `${fixturePrefix}-local` };
  }
  return (await api('POST', `/admin/servers/${serverId}/disks`, token, { mountPoint: localMountPoint, label: `${fixturePrefix}-local` }, [200, 201])).body;
}

async function ensureRemoteMount(token, serverId) {
  if (!enableRemoteFs || !nfsServer || !nfsExport) return null;
  const name = `${fixturePrefix}-nfs`;
  const existing = (await api('GET', `/admin/remote-fs-mounts?serverId=${encodeURIComponent(serverId)}`, token)).body.find((m) => m.name === name);
  const mount = existing ?? (await api('POST', '/admin/remote-fs-mounts', token, {
    name,
    displayName: 'Live API NFS',
    description: 'Persistent live API test mount',
    serverIds: [serverId],
    options: 'rw',
    hostMountPoint: `/mnt/nyabase-test/${name}`,
    params: { type: 'nfs', nfsServer, exportPath: nfsExport, version: '4.2' },
  }, [200, 201])).body;
  await api('PATCH', `/admin/remote-fs-mounts/${mount.id}`, token, { displayName: 'Live API NFS' });
  await api('GET', `/admin/remote-fs-mounts/${mount.id}/servers`, token);
  await api('POST', `/admin/remote-fs-mounts/${mount.id}/servers`, token, { serverId }, [200, 201, 409]);
  await api('POST', `/admin/remote-fs-mounts/${mount.id}/remount`, token, undefined, [200, 201, 202]);
  return (await api('GET', `/admin/remote-fs-mounts/${mount.id}`, token)).body;
}

async function ensureImages(token, servers) {
  const alpine = await ensureImage(token, 'alpine', {
    dockerImage: 'alpine:3.20',
    runtimeOverrides: { uid: 0, entrypoint: null, cmd: ['sleep', 'infinity'], init: true },
  });
  const ubuntu = await ensureImage(token, 'ubuntu', {
    dockerImage: 'ubuntu:24.04',
    runtimeOverrides: { uid: 0, entrypoint: null, cmd: ['sleep', 'infinity'], init: true },
  });
  const inactive = await ensureImage(token, 'inactive', {
    dockerImage: 'alpine:3.19',
    runtimeOverrides: { uid: 0, entrypoint: null, cmd: ['sleep', 'infinity'], init: true },
    isActive: false,
  });
  const gpu = servers.gpu ? await ensureImage(token, 'gpu', {
    dockerImage: 'nvidia/cuda:12.4.1-base-ubuntu22.04',
    runtimeOverrides: { uid: 0, entrypoint: null, cmd: ['sleep', 'infinity'], init: true },
  }) : null;
  if (pullImages) {
    await pullImage(token, alpine.id, servers.cpu.id);
    await pullImage(token, ubuntu.id, servers.cpu.id);
    if (gpu && servers.gpu) await pullImage(token, gpu.id, servers.gpu.id);
  }
  return { alpine: pickImage(alpine), ubuntu: pickImage(ubuntu), inactive: pickImage(inactive), gpu: gpu ? pickImage(gpu) : null };
}

async function ensureImage(token, key, spec) {
  const name = `${fixturePrefix}-${key}`;
  const existing = (await api('GET', '/admin/images', token)).body.find((i) => i.name === name);
  if (existing) {
    return (await api('PATCH', `/admin/images/${existing.id}`, token, { name, dockerImage: spec.dockerImage, runtimeOverrides: spec.runtimeOverrides, isActive: spec.isActive ?? true })).body;
  }
  const created = (await api('POST', '/admin/images', token, { name, dockerImage: spec.dockerImage, runtimeOverrides: spec.runtimeOverrides, description: 'Persistent live API test image' }, [200, 201])).body;
  if (spec.isActive === false) return (await api('PATCH', `/admin/images/${created.id}`, token, { isActive: false })).body;
  return created;
}

async function pullImage(token, imageId, serverId) {
  const started = await api('POST', `/admin/images/${imageId}/pull`, token, { serverIds: [serverId] }, [200, 201, 202]);
  assert(started.body.started?.includes(serverId) || started.body.skipped?.includes(serverId), `image pull did not target ${serverId}`);
  for (let i = 0; i < 180; i += 1) {
    const statuses = (await api('GET', `/admin/images/${imageId}/status`, token)).body;
    const status = statuses.find((s) => s.serverId === serverId);
    if (status?.present) return;
    if (status?.error) throw new Error(`image pull failed on ${serverId}: ${status.error}`);
    await sleep(1000);
  }
  throw new Error(`image ${imageId} not present on ${serverId} after pull timeout`);
}

async function ensureUsers(token) {
  const specs = {
    alpha: 'Alpha Live API',
    beta: 'Beta Live API',
    gamma: 'Gamma Live API',
    delta: 'Delta Live API',
  };
  const users = {};
  for (const [key, displayName] of Object.entries(specs)) {
    const username = `${fixturePrefix}-${key}`;
    const password = await persistentPassword(key);
    const existing = (await api('GET', '/admin/users', token)).body.find((u) => u.username === username);
    const user = existing
      ? (await api('PATCH', `/admin/users/${existing.id}`, token, { displayName, password, status: 'active' })).body
      : (await api('POST', '/admin/users', token, { username, password, displayName }, [200, 201])).body;
    const credentialFile = join(runtimeDir, `${key}.env`);
    await writeFile(credentialFile, `USERNAME=${username}\nPASSWORD=${password}\nUSER_ID=${user.id}\n`, { mode: 0o600 });
    await chmod(credentialFile, 0o600);
    users[key] = { id: user.id, username, displayName, password, credentialFile };
  }
  return users;
}

async function ensureGroups(token, users) {
  const groups = await api('GET', '/admin/groups', token);
  const existing = groups.body.find((g) => g.name === `${fixturePrefix}-operators`);
  const body = {
    name: `${fixturePrefix}-operators`,
    description: 'Persistent live API test operators',
    priority: 50,
    capabilities: [],
  };
  const operators = existing ? (await api('PATCH', `/admin/groups/${existing.id}`, token, body)).body : (await api('POST', '/admin/groups', token, body, [200, 201])).body;
  await api('POST', `/admin/groups/${operators.id}/members`, token, { userId: users.beta.id }, [200, 201, 409]);
  return { operators: { id: operators.id, name: operators.name } };
}

async function ensureServerGrant(token, scope, scopeId, serverId, quota) {
  if (scope === 'user') return api('POST', `/admin/users/${scopeId}/server-grants/${serverId}`, token, quota, [200, 201]);
  return api('POST', `/admin/groups/${scopeId}/server-grants/${serverId}`, token, quota, [200, 201]);
}

async function ensureImageGrant(token, scope, scopeId, imageId, serverId) {
  if (scope === 'user') return api('POST', `/admin/users/${scopeId}/image-grants`, token, { imageId, serverId }, [200, 201, 409]);
  await api('POST', `/admin/groups/${scopeId}/image-grants`, token, { imageId, serverId }, [200, 201, 409]);
  return api('POST', `/admin/groups/${scopeId}/image-grants/${imageId}/sync-servers`, token, { serverIds: [serverId] }, [200, 201]);
}

async function ensureMountGrant(token, scope, scopeId, sourceKind, sourceId) {
  if (scope === 'user') {
    await api('POST', `/admin/users/${scopeId}/mount-source-grants`, token, { sourceKind, sourceId }, [200, 201]);
  } else {
    await api('POST', `/admin/groups/${scopeId}/mount-source-grants`, token, { sourceKind, sourceId }, [200, 201]);
  }
  await api('POST', `/admin/mount-sources/grants/${sourceKind}/${sourceId}`, token, { scope, scopeId }, [200, 201]);
}

async function runPersona(name, fixture, fn) {
  const user = fixture.users[name];
  await step(`subagent persona ${name} operates through real user API`, async () => {
    const actor = await spawnPersona(name, user);
    await fn(actor);
  });
}

async function spawnPersona(name, user) {
  const payload = {
    apiBase,
    username: user.username,
    password: user.password,
    persona: name,
  };
  const script = `
const payload = JSON.parse(process.env.NYABASE_PERSONA_PAYLOAD);
async function request(method, path, token, body) {
  const res = await fetch(payload.apiBase + path, {
    method,
    headers: { accept: 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(method + ' ' + path + ' ' + res.status + ': ' + text);
  return parsed;
}
(async () => {
  const login = await request('POST', '/auth/login', undefined, { username: payload.username, password: payload.password });
  const me = await request('GET', '/auth/me', login.accessToken);
  process.stdout.write(JSON.stringify({ persona: payload.persona, token: login.accessToken, refreshToken: login.refreshToken, user: me }));
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
`;
  const out = await runNodeScript(script, { NYABASE_PERSONA_PAYLOAD: JSON.stringify(payload) });
  return JSON.parse(out);
}

async function userProfileChecks(actor) {
  await api('GET', `/users/${actor.user.id}`, actor.token);
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAKxELmEG7rqBkGaSOXo9W5iTiZb20hOhtjYZO8lQW2 live-api@nyabase-test';
  const existingKeys = await api('GET', `/users/${actor.user.id}/ssh-keys`, actor.token);
  for (const existing of existingKeys.body.filter((item) => item.name?.startsWith('live-api-'))) {
    await api('DELETE', `/users/${actor.user.id}/ssh-keys/${existing.id}`, actor.token, undefined, [204]);
  }
  const created = await api('POST', `/users/${actor.user.id}/ssh-keys`, actor.token, { name: `live-api-${runId}`, keyText: key }, [200, 201]);
  await api('GET', `/users/${actor.user.id}/ssh-keys`, actor.token);
  await api('DELETE', `/users/${actor.user.id}/ssh-keys/${created.body.id}`, actor.token, undefined, [204]);
  const token = await api('POST', '/auth/tokens', actor.token, { name: `persona-${actor.persona}-${runId}` }, [200, 201]);
  await api('DELETE', `/auth/tokens/${token.body.token.id}`, actor.token, undefined, [204]);
}

async function userAccessChecks(actor, fixture, source) {
  await api('GET', '/servers', actor.token);
  await api('GET', `/servers/${source?.serverId ?? fixture.servers.cpu.id}`, actor.token);
  await api('GET', `/servers/${source?.serverId ?? fixture.servers.cpu.id}/quota`, actor.token);
  await api('GET', `/servers/${source?.serverId ?? fixture.servers.cpu.id}/disks`, actor.token);
  await api('GET', `/servers/${source?.serverId ?? fixture.servers.cpu.id}/gpus`, actor.token, undefined, [200, 404]);
  await api('GET', '/images?activeOnly=true', actor.token);
  await api('GET', `/images/${actor.persona === 'beta' ? fixture.images.ubuntu.id : fixture.images.alpine.id}`, actor.token);
  await api('GET', '/me/access', actor.token);
  await api('GET', `/mount-sources?serverId=${source?.serverId ?? fixture.servers.cpu.id}`, actor.token);
  await api('GET', `/metrics/servers/${source?.serverId ?? fixture.servers.cpu.id}/host?range=5m`, actor.token);
  await api('GET', `/metrics/servers/${source?.serverId ?? fixture.servers.cpu.id}/users?range=5m`, actor.token);
}

async function dataDirChecks(actor, fixture, source) {
  if (!source) return;
  const name = `${actor.persona}-${runId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63);
  await api('POST', '/data-dirs', actor.token, { serverId: source.serverId, sourceKind: source.kind, sourceId: source.id, name }, [200, 201]);
  await api('GET', `/data-dirs?serverId=${source.serverId}`, actor.token);
  await api('GET', `/admin/data-dirs?serverId=${source.serverId}&userId=${actor.user.id}`, (await adminToken()).accessToken, undefined, [200]);
  await api('DELETE', `/data-dirs/${source.serverId}/${source.id}/${name}?sourceKind=${source.kind}`, actor.token, undefined, [200, 204]);
}

async function containerChecks(actor, fixture, options) {
  const serverId = options.serverId ?? fixture.servers.cpu.id;
  const dataDirs = options.source ? [{
    sourceKind: options.source.kind,
    sourceId: options.source.id,
    dirName: `${actor.persona}-ctr-${runId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63),
    containerPath: '/workspace',
    createIfMissing: true,
  }] : [];
  const create = await api('POST', '/v2/containers', actor.token, {
    serverId,
    imageId: options.imageId,
    name: options.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
    dataDirs,
    sshServerEnabled: options.ssh,
  }, [200, 201, 202]);
  const op = await waitOperation(actor.token, create.body.operationId);
  const c = await waitContainer(actor.token, op.resourceId, 'active');
  cleanupContainers.push({ id: c.id, owner: actor.persona });
  await api('GET', '/v2/containers', actor.token);
  await api('GET', `/v2/containers/${c.id}`, actor.token);
  await waitActionEnabled(actor.token, c.id, 'stats');
  await api('GET', `/v2/containers/${c.id}/stats`, actor.token);
  await api('GET', `/metrics/servers/${serverId}/containers?range=5m`, actor.token);
  await api('POST', `/v2/containers/${c.id}/exec-sessions`, actor.token, { shell: '/bin/sh', tty: false }, [200, 201, 202]);
  if (options.ssh) {
    await action(actor.token, c.id, 'enable-ssh');
    await action(actor.token, c.id, 'reconcile-ssh');
  }
  if (dataDirs.length > 0) await action(actor.token, c.id, 'update-mounts', dataDirs);
  await action(actor.token, c.id, 'stop');
  await action(actor.token, c.id, 'start');
  await action(actor.token, c.id, 'restart');
  return c;
}

async function adminContainerRead(token, containerId) {
  await api('GET', `/admin/v2/containers/${containerId}`, token);
  await api('GET', `/admin/v2/containers/${containerId}/stats`, token);
}

async function waitOperation(token, operationId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await api('GET', `/operations/${operationId}`, token);
    last = res.body;
    if (['succeeded', 'failed', 'cancelled'].includes(last.status)) {
      assert(last.status === 'succeeded', `operation ${operationId} ended ${last.status}: ${last.lastError ?? ''}`);
      return last;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for operation ${operationId}; last=${last?.status}`);
}

async function waitContainer(token, containerId, phase, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await raw('GET', `/v2/containers/${containerId}`, token);
    if (res.status === 404 && phase === 'deleted') return { id: containerId, phase: 'deleted' };
    if (res.ok) {
      last = res.body;
      if (last.phase === phase) return last;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for container ${containerId} phase ${phase}; last=${last?.phase}`);
}

async function waitActionEnabled(token, containerId, actionName, timeoutMs = 120000, admin = false) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  const path = `${admin ? '/admin' : ''}/v2/containers/${containerId}`;
  while (Date.now() < deadline) {
    const res = await api('GET', path, token);
    last = res.body;
    if (last.actions?.[actionName]?.enabled) return last;
    await sleep(1000);
  }
  const action = last?.actions?.[actionName];
  throw new Error(`timed out waiting action ${actionName} enabled for ${containerId}; phase=${last?.phase} reason=${action?.reason ?? ''}`);
}

async function action(token, containerId, actionName, body) {
  await waitActionEnabled(token, containerId, actionKey(actionName));
  const ref = await api('POST', `/v2/containers/${containerId}/actions/${actionName}`, token, body, [200, 201, 202]);
  await waitOperation(token, ref.body.operationId);
}

async function removeContainer(token, containerId, admin = false) {
  const path = `${admin ? '/admin' : ''}/v2/containers/${containerId}`;
  const view = await raw('GET', path, token);
  if (view.status === 404) return;
  await waitActionEnabled(token, containerId, 'delete', 120000, admin);
  const ref = await api('POST', `${path}/actions/delete`, token, undefined, [200, 201, 202]);
  const opPath = admin ? `/admin/operations/${ref.body.operationId}` : `/operations/${ref.body.operationId}`;
  for (let i = 0; i < 180; i += 1) {
    const op = await api('GET', opPath, token);
    if (['succeeded', 'failed', 'cancelled'].includes(op.body.status)) {
      assert(op.body.status === 'succeeded', `delete operation failed: ${op.body.lastError ?? ''}`);
      break;
    }
    await sleep(1000);
  }
  cleanupContainers.splice(cleanupContainers.findIndex((c) => c.id === containerId), 1);
}

async function adminToken() {
  if (!cachedAdmin) cachedAdmin = (await api('POST', '/auth/login', undefined, { username: adminUsername, password: adminPassword })).body;
  return cachedAdmin;
}

async function cleanupBestEffort() {
  if (keepContainers || cleanupContainers.length === 0) return;
  try {
    const admin = await adminToken();
    for (const c of [...cleanupContainers]) {
      await removeContainer(admin.accessToken, c.id, true).catch(() => {});
    }
  } catch {
    // Report the primary failure; cleanup failures are visible in runtime state.
  }
}

async function cleanupStaleLiveApiContainers(adminAccessToken) {
  const containers = (await api('GET', '/admin/v2/containers', adminAccessToken)).body;
  for (const c of containers.filter((item) => String(item.name ?? '').startsWith(`${fixturePrefix}-`))) {
    await removeContainer(adminAccessToken, c.id, true).catch(() => {});
  }
}

function actionKey(endpointAction) {
  return {
    'update-mounts': 'updateMounts',
    'enable-ssh': 'enableSsh',
    'reconcile-ssh': 'reconcileSsh',
  }[endpointAction] ?? endpointAction;
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    record(name, 'pass', { ms: Date.now() - started });
    return value;
  } catch (error) {
    record(name, 'fail', { ms: Date.now() - started, error: String(error?.stack ?? error) });
    throw error;
  }
}

function record(name, status, extra = {}) {
  results.push({ name, status, ...extra });
  const label = status === 'pass' ? 'PASS' : status === 'blocked' ? 'BLOCKED' : 'FAIL';
  console.log(`${label} ${name}`);
}

async function api(method, path, token, body, expected = [200]) {
  const res = await raw(method, path, token, body);
  if (!expected.includes(res.status)) throw new Error(`${method} ${path} expected ${expected.join('/')} got ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

async function raw(method, path, token, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const text = res.status === 204 ? '' : await res.text();
  let parsed = null;
  if (text) {
    parsed = contentType.includes('application/json') ? JSON.parse(text) : text;
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

async function persistentPassword(key) {
  const path = join(runtimeDir, `${key}.env`);
  if (existsSync(path)) {
    const text = await readFile(path, 'utf8');
    const match = /^PASSWORD=(.*)$/m.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return `T${randomBytes(18).toString('base64url')}9`;
}

async function runNodeScript(script, envExtra) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, ...envExtra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err || `persona process exited ${code}`));
    });
  });
}

async function writeReports(status) {
  const report = {
    schema: 'nyabase.live-api-report.v1',
    status,
    runId,
    createdAt: new Date().toISOString(),
    apiBase,
    fixturePath,
    keepContainers,
    smokeOnly,
    results,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await chmod(reportPath, 0o600);
  await writeFile(reportMdPath, [
    `# Live API Suite ${runId}`,
    '',
    `Status: ${status}`,
    `API: ${apiBase}`,
    `Fixture: ${fixturePath}`,
    '',
    '## Results',
    ...results.map((r) => `- ${r.status}: ${r.name}${r.error ? ` - ${r.error.split('\n')[0]}` : ''}`),
    '',
  ].join('\n'), { mode: 0o600 });
  await chmod(reportMdPath, 0o600);
}

function printSummary() {
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Summary: pass=${counts.pass ?? 0} fail=${counts.fail ?? 0} blocked=${counts.blocked ?? 0}`);
  console.log(`Report: ${reportPath}`);
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const text = await readFile(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function pickServer(server) {
  return { id: server.id, name: server.name, status: server.status, isGpuServer: server.isGpuServer };
}

function pickImage(image) {
  return { id: image.id, name: image.name, dockerImage: image.dockerImage, isActive: image.isActive };
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15).toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
