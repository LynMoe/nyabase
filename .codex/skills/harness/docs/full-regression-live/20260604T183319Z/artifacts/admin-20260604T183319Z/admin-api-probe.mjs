import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const OUT = '.codex/skills/harness/docs/full-regression-live/20260604T183319Z/artifacts/admin-20260604T183319Z';
const LOG = '.codex/skills/harness/docs/full-regression-live/20260604T183319Z/logs/admin-20260604T183319Z';
const API = 'http://localhost:3001/api';
const REQUESTED_PREFIX = 'frlive-admin-20260604T183319Z-';
const RESOURCE_PREFIX = REQUESTED_PREFIX.toLowerCase();
const suffix = (process.env.NYABASE_PROBE_SUFFIX || crypto.randomBytes(3).toString('hex')).toLowerCase();
const ADMIN_PASSWORD = process.env.NYABASE_ADMIN_PASSWORD || process.env.ADMIN_INIT_PASSWORD || '';
const startedAt = new Date().toISOString();

const state = {
  startedAt,
  apiBase: API,
  requestedPrefix: REQUESTED_PREFIX,
  resourcePrefix: RESOURCE_PREFIX,
  prefixNote: REQUESTED_PREFIX === RESOURCE_PREFIX ? null : 'Usernames/container names are lowercase-normalized because backend validators only allow lowercase resource names.',
  suffix,
  created: { userId: null, groupId: null, imageId: null, containerId: null, operationIds: [] },
  selected: { server: null, imageDockerRef: 'ubuntu:24.04' },
  probes: [],
  checks: [],
  failures: [],
  cleanup: [],
  residuals: [],
};

function sh(cmd, args, opts = {}) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', ...opts }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|secret|password/i.test(k)) out[k] = '<redacted>';
      else out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}
function summarize(path, body) {
  if (Array.isArray(body)) return { type: 'array', count: body.length, sample: sanitize(body.slice(0, 5)) };
  if (!body || typeof body !== 'object') return sanitize(body);
  if (path.includes('/auth/login')) return { accessToken: body.accessToken ? '<redacted>' : undefined, refreshToken: body.refreshToken ? '<redacted>' : undefined, user: sanitize(body.user) };
  if (path.includes('/operations/') && body.commands) {
    return sanitize({ ...body, commands: body.commands.map(c => ({ ...c, payload: c.payload ? '<payload-present>' : c.payload })) });
  }
  return sanitize(body);
}
async function req(label, method, path, token, body, expected = []) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const started = Date.now();
  let status = 0, parsed = null, text = '';
  try {
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    status = res.status;
    text = await res.text();
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  } catch (e) {
    parsed = { error: e instanceof Error ? e.message : String(e) };
  }
  const ok = expected.length ? expected.includes(status) : status >= 200 && status < 300;
  const rec = { label, method, path, status, ok, durationMs: Date.now() - started, request: sanitize(body), response: summarize(path, parsed) };
  state.probes.push(rec);
  if (!ok) state.failures.push({ label, path, status, expected, response: rec.response });
  return { status, body: parsed, ok, rec };
}
function addCheck(name, ok, evidence = undefined, classification = undefined) {
  const check = { name, ok, evidence: sanitize(evidence) };
  if (classification) check.classification = classification;
  state.checks.push(check);
  if (!ok) state.failures.push({ label: name, classification, evidence: sanitize(evidence) });
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function pollOperation(token, operationId, label, timeoutMs = 120000) {
  const terminal = new Set(['succeeded', 'failed', 'cancelled']);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await req(`${label}:get-operation`, 'GET', `/operations/${operationId}`, token, undefined, [200, 403, 404]);
    last = r.body;
    if (r.status === 200 && terminal.has(r.body?.status)) return r.body;
    await sleep(2000);
  }
  state.failures.push({ label, classification: 'convergence-timeout', evidence: sanitize(last) });
  return last;
}
async function waitContainer(token, containerId, predicate, label, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await req(`${label}:get-container`, 'GET', `/v2/containers/${containerId}`, token, undefined, [200, 404]);
    last = r.body;
    if (r.status === 404) return { status: 404, body: r.body };
    if (r.status === 200 && predicate(r.body)) return { status: 200, body: r.body };
    await sleep(3000);
  }
  state.failures.push({ label, classification: 'convergence-timeout', evidence: sanitize(last) });
  return { status: last ? 200 : 0, body: last };
}
function sql(query) {
  return sh('sqlite3', ['-json', 'test/runtime/db/nyabase-test.db', query]);
}
function sqlJson(query) {
  const out = sql(query).trim();
  if (!out) return [];
  try { return JSON.parse(out); } catch { return [{ parseError: out }]; }
}
async function cleanupStep(name, fn) {
  try {
    const result = await fn();
    state.cleanup.push({ name, ok: true, result: sanitize(result) });
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    state.cleanup.push({ name, ok: false, error });
    state.residuals.push({ name, reason: error });
    return null;
  }
}

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('Admin password was not provided via environment/local.env');
  const adminLogin = await req('admin login', 'POST', '/auth/login', null, { username: 'admin', password: ADMIN_PASSWORD }, [200]);
  const adminToken = adminLogin.body?.accessToken;
  addCheck('admin login returns full admin capabilities', Boolean(adminToken && adminLogin.body?.user?.capabilities?.includes('manage_users') && adminLogin.body?.user?.capabilities?.includes('manage_containers_any')), adminLogin.body?.user);
  if (!adminToken) throw new Error('Admin login failed; cannot continue');

  const [me, users0, groups0, servers0, images0, containers0] = await Promise.all([
    req('admin /auth/me', 'GET', '/auth/me', adminToken, undefined, [200]),
    req('admin list users', 'GET', '/users', adminToken, undefined, [200]),
    req('admin list groups', 'GET', '/groups', adminToken, undefined, [200]),
    req('admin list servers', 'GET', '/servers', adminToken, undefined, [200]),
    req('admin list images', 'GET', '/images', adminToken, undefined, [200]),
    req('admin global containers', 'GET', '/v2/containers', adminToken, undefined, [200]),
  ]);
  addCheck('admin-only users/groups/global container lists are reachable', users0.status === 200 && groups0.status === 200 && containers0.status === 200, { users: users0.body?.length, groups: groups0.body?.length, containers: containers0.body?.length });
  const onlineServers = (servers0.body || []).filter(s => s.status === 'online');
  const server = onlineServers.find(s => !s.isGpuServer) || onlineServers[0];
  state.selected.server = server ? { id: server.id, name: server.name, status: server.status, isGpuServer: server.isGpuServer } : null;
  addCheck('runtime has online server for admin container probe', Boolean(server), state.selected.server, server ? undefined : 'infra-precondition');
  if (!server) throw new Error('No online server available');

  await Promise.all([
    req('admin audit accessible', 'GET', '/audit?limit=3', adminToken, undefined, [200]),
    req('admin all-disks accessible', 'GET', '/servers/all-disks', adminToken, undefined, [200]),
    req('admin remote-fs accessible', 'GET', '/system/remote-fs-mounts', adminToken, undefined, [200]),
    req('admin data-dir issues accessible', 'GET', '/admin/data-dirs/issues', adminToken, undefined, [200]),
  ]);

  const username = `${RESOURCE_PREFIX}user-${suffix}`;
  const groupName = `${REQUESTED_PREFIX}group-${suffix}`;
  const imageName = `${REQUESTED_PREFIX}image-${suffix}`;
  const containerName = `${RESOURCE_PREFIX}ctr-${suffix}`;
  const userPassword = crypto.randomBytes(12).toString('base64url') + 'Aa1';

  const createUser = await req('admin create user', 'POST', '/users', adminToken, { username, password: userPassword, displayName: `${REQUESTED_PREFIX}User ${suffix}` }, [201, 200]);
  const userId = createUser.body?.id;
  state.created.userId = userId;
  addCheck('admin user create and Users auto-membership', Boolean(userId && createUser.body?.groups?.some(g => g.name === 'Users')), createUser.body);

  const createGroup = await req('admin create group', 'POST', '/groups', adminToken, { name: groupName, description: `${REQUESTED_PREFIX} API probe group`, priority: 77, capabilities: [] }, [201, 200]);
  const groupId = createGroup.body?.id;
  state.created.groupId = groupId;
  addCheck('admin group create', Boolean(groupId), createGroup.body);

  if (groupId && userId) {
    await req('admin add group member', 'POST', `/groups/${groupId}/members`, adminToken, { userId }, [201, 200]);
    const members = await req('admin list group members', 'GET', `/groups/${groupId}/members`, adminToken, undefined, [200]);
    addCheck('admin group member add/list', members.body?.some(m => m.userId === userId), members.body);
  }

  const createImage = await req('admin create image', 'POST', '/images', adminToken, {
    name: imageName,
    dockerImage: state.selected.imageDockerRef,
    defaultUser: 'root',
    defaultShell: '/bin/bash',
    defaultUid: 0,
    description: `${REQUESTED_PREFIX} API probe image using existing docker ref`,
    cmd: 'sleep 3600',
  }, [201, 200]);
  const imageId = createImage.body?.id;
  state.created.imageId = imageId;
  addCheck('admin image create', Boolean(imageId), createImage.body);

  if (groupId && userId && imageId) {
    const grantBody = { cpuMillis: 500, memBytes: 268435456, diskBytes: 104857600, gpuMode: 'none', gpuIndices: null };
    await req('admin group server grant upsert', 'POST', `/groups/${groupId}/server-grants/${server.id}`, adminToken, grantBody, [201, 200]);
    const serverGrants = await req('admin group server grants list', 'GET', `/groups/${groupId}/server-grants`, adminToken, undefined, [200]);
    addCheck('group server grant persisted with quota values', serverGrants.body?.some(g => g.serverId === server.id && g.cpuMillis === 500 && g.diskBytes === 104857600), serverGrants.body);

    await req('admin group image grant add', 'POST', `/groups/${groupId}/image-grants`, adminToken, { imageId, serverId: server.id }, [201, 200]);
    const imageGrants = await req('admin group image grants list', 'GET', `/groups/${groupId}/image-grants`, adminToken, undefined, [200]);
    addCheck('group image grant persisted', imageGrants.body?.some(g => g.imageId === imageId && g.serverId === server.id), imageGrants.body);

    const effective = await req('admin user effective access after group grants', 'GET', `/users/${userId}/effective-access`, adminToken, undefined, [200]);
    const effServer = effective.body?.servers?.find(s => s.serverId === server.id);
    addCheck('user isolation configured through group grants', Boolean(effServer && effServer.cpuMillis === 500 && effServer.allowedImageIds?.includes(imageId)), effective.body);

    const userServerGrantsBefore = await req('admin list direct user server grants initially empty', 'GET', `/users/${userId}/server-grants`, adminToken, undefined, [200]);
    addCheck('direct user grant list reachable', Array.isArray(userServerGrantsBefore.body), userServerGrantsBefore.body);
    await req('admin direct user server grant override', 'POST', `/users/${userId}/server-grants/${server.id}`, adminToken, { cpuMillis: 750, memBytes: 314572800, diskBytes: 125829120, gpuMode: 'none', gpuIndices: null }, [201, 200]);
    const effectiveOverride = await req('admin user effective access after direct override', 'GET', `/users/${userId}/effective-access`, adminToken, undefined, [200]);
    const effOverride = effectiveOverride.body?.servers?.find(s => s.serverId === server.id);
    addCheck('direct user server grant overrides group grant', Boolean(effOverride && effOverride.cpuMillis === 750 && effOverride.diskBytes === 125829120), effectiveOverride.body);
    await req('admin delete direct user server grant override', 'DELETE', `/users/${userId}/server-grants/${server.id}`, adminToken, undefined, [204]);
    const effectiveFallback = await req('admin user effective access after direct grant deletion', 'GET', `/users/${userId}/effective-access`, adminToken, undefined, [200]);
    const effFallback = effectiveFallback.body?.servers?.find(s => s.serverId === server.id);
    addCheck('direct user grant delete falls back to group grant', Boolean(effFallback && effFallback.cpuMillis === 500 && effFallback.diskBytes === 104857600), effectiveFallback.body);

    const quotaRows = sqlJson(`select serverId,userId,numericUserId,limitBytes,generation from quota_desired where userId='${userId.replaceAll("'", "''")}' and serverId='${server.id.replaceAll("'", "''")}'`);
    addCheck('quota desired row updated by grant API', quotaRows.some(r => Number(r.limitBytes) === 104857600), quotaRows);

    const userLogin = await req('created normal user login', 'POST', '/auth/login', null, { username, password: userPassword }, [200]);
    const userToken = userLogin.body?.accessToken;
    addCheck('created user can login', Boolean(userToken), userLogin.body?.user);
    if (userToken) {
      const [userMe, myAccess, userServers, userImages, userQuota] = await Promise.all([
        req('created user /auth/me', 'GET', '/auth/me', userToken, undefined, [200]),
        req('created user /me/access', 'GET', '/me/access', userToken, undefined, [200]),
        req('created user list accessible servers', 'GET', '/servers', userToken, undefined, [200]),
        req('created user list accessible images', 'GET', '/images?activeOnly=true', userToken, undefined, [200]),
        req('created user server quota', 'GET', `/servers/${server.id}/quota`, userToken, undefined, [200]),
      ]);
      addCheck('normal user sees only configured access', userServers.body?.length === 1 && userServers.body?.[0]?.id === server.id && userImages.body?.some(i => i.id === imageId) && myAccess.body?.servers?.some(s => s.serverId === server.id), { servers: userServers.body, images: userImages.body, access: myAccess.body });
      addCheck('quota API exposes effective disk limit to granted user', Number(userQuota.body?.limitBytes) === 104857600, userQuota.body);
      await Promise.all([
        req('created user denied /users', 'GET', '/users', userToken, undefined, [403]),
        req('created user denied /groups', 'GET', '/groups', userToken, undefined, [403]),
        req('created user denied /audit', 'GET', '/audit?limit=1', userToken, undefined, [403]),
        req('created user denied admin data issues', 'GET', '/admin/data-dirs/issues', userToken, undefined, [403]),
      ]);
      const overQuota = await req('created user over-quota container create rejected', 'POST', '/v2/containers', userToken, { serverId: server.id, imageId, name: `${RESOURCE_PREFIX}over-${suffix}`, cpuMillis: 1000, memBytes: 67108864 }, [403, 400]);
      addCheck('quota enforcement rejects over-CPU create before resource allocation', overQuota.status === 403 || overQuota.status === 400, overQuota.body);
    }
  }

  if (imageId) {
    const createContainer = await req('admin create small container', 'POST', '/v2/containers', adminToken, { serverId: server.id, imageId, name: containerName, cpuMillis: 100, memBytes: 67108864, sshServerEnabled: false }, [201, 200]);
    const createOperationId = createContainer.body?.operationId;
    if (createOperationId) state.created.operationIds.push(createOperationId);
    addCheck('admin container create enqueued', Boolean(createOperationId), createContainer.body);
    if (createOperationId) {
      const createOp = await pollOperation(adminToken, createOperationId, 'admin container create operation', 140000);
      const containerId = createOp?.resourceId;
      state.created.containerId = containerId || null;
      addCheck('admin container create operation succeeded', createOp?.status === 'succeeded', createOp, createOp?.status === 'succeeded' ? undefined : 'infra');
      if (containerId && createOp?.status === 'succeeded') {
        const runningView = await waitContainer(adminToken, containerId, c => c.phase === 'active' && c.runtime?.status === 'running' && c.actions?.stop?.enabled, 'wait created container running/controllable', 90000);
        addCheck('admin can see created container with enabled controls', runningView.status === 200 && runningView.body?.actions?.stop?.enabled && runningView.body?.actions?.delete?.enabled, runningView.body);
        if (runningView.status === 200 && runningView.body?.actions?.stop?.enabled) {
          const stop = await req('admin stop container', 'POST', `/v2/containers/${containerId}/actions/stop`, adminToken, undefined, [201, 200]);
          const stopOperationId = stop.body?.operationId;
          if (stopOperationId) state.created.operationIds.push(stopOperationId);
          addCheck('admin stop container enqueued', Boolean(stopOperationId), stop.body);
          const stopOp = stopOperationId ? await pollOperation(adminToken, stopOperationId, 'admin stop container operation', 120000) : null;
          addCheck('admin stop container operation succeeded', stopOp?.status === 'succeeded', stopOp, stopOp?.status === 'succeeded' ? undefined : 'infra');
          const stoppedView = await waitContainer(adminToken, containerId, c => c.actions?.start?.enabled || c.runtime?.status === 'exited' || c.runtime?.status === 'dead', 'wait stopped container start-control', 90000);
          addCheck('admin sees start control after stop', stoppedView.status === 200 && stoppedView.body?.actions?.start?.enabled, stoppedView.body, stoppedView.body?.actions?.start?.enabled ? undefined : 'convergence-timeout');
          if (stoppedView.status === 200 && stoppedView.body?.actions?.start?.enabled) {
            const start = await req('admin start container', 'POST', `/v2/containers/${containerId}/actions/start`, adminToken, undefined, [201, 200]);
            const startOperationId = start.body?.operationId;
            if (startOperationId) state.created.operationIds.push(startOperationId);
            addCheck('admin start container enqueued', Boolean(startOperationId), start.body);
            const startOp = startOperationId ? await pollOperation(adminToken, startOperationId, 'admin start container operation', 120000) : null;
            addCheck('admin start container operation succeeded', startOp?.status === 'succeeded', startOp, startOp?.status === 'succeeded' ? undefined : 'infra');
            await waitContainer(adminToken, containerId, c => c.actions?.stop?.enabled || c.runtime?.status === 'running', 'wait restarted container running', 90000);
          }
        }
        const latest = await req('admin get container before delete', 'GET', `/v2/containers/${containerId}`, adminToken, undefined, [200, 404]);
        if (latest.status === 200 && latest.body?.actions?.delete?.enabled) {
          const del = await req('admin delete container', 'POST', `/v2/containers/${containerId}/actions/delete`, adminToken, undefined, [201, 200]);
          const deleteOperationId = del.body?.operationId;
          if (deleteOperationId) state.created.operationIds.push(deleteOperationId);
          addCheck('admin delete container enqueued', Boolean(deleteOperationId), del.body);
          const delOp = deleteOperationId ? await pollOperation(adminToken, deleteOperationId, 'admin delete container operation', 120000) : null;
          addCheck('admin delete container operation succeeded', delOp?.status === 'succeeded', delOp, delOp?.status === 'succeeded' ? undefined : 'infra');
          const gone = await waitContainer(adminToken, containerId, () => false, 'wait deleted container hidden', 30000);
          addCheck('deleted container no longer readable/listed', gone.status === 404, gone.body);
        } else {
          addCheck('admin delete container control available', false, latest.body, 'convergence-timeout');
        }
      }
    }
  }

  // Cleanup: retry active resource cleanup even if earlier planned cleanup failed.
  await cleanupStep('container cleanup ensure deleted', async () => {
    const cid = state.created.containerId;
    if (!cid) return { skipped: 'no container id' };
    const get = await req('cleanup get container', 'GET', `/v2/containers/${cid}`, adminToken, undefined, [200, 404]);
    if (get.status === 404) return { alreadyDeleted: true };
    if (get.body?.actions?.delete?.enabled) {
      const del = await req('cleanup delete container', 'POST', `/v2/containers/${cid}/actions/delete`, adminToken, undefined, [201, 200, 403]);
      if (del.body?.operationId) {
        state.created.operationIds.push(del.body.operationId);
        const op = await pollOperation(adminToken, del.body.operationId, 'cleanup delete container operation', 120000);
        return { deleteOperation: op?.status, operationId: del.body.operationId };
      }
      return { deleteAttemptStatus: del.status, body: del.body };
    }
    return { blocked: 'delete action not enabled', view: get.body };
  });

  await cleanupStep('set user quota to zero before removing grants', async () => {
    if (!state.created.userId || !server?.id) return { skipped: true };
    const r = await req('cleanup zero quota direct grant', 'POST', `/users/${state.created.userId}/server-grants/${server.id}`, adminToken, { cpuMillis: 0, memBytes: 0, diskBytes: 0, gpuMode: 'none', gpuIndices: null }, [201, 200, 404]);
    await sleep(500);
    return { status: r.status, quotaRows: sqlJson(`select serverId,userId,limitBytes,generation from quota_desired where userId='${state.created.userId.replaceAll("'", "''")}'`) };
  });
  await cleanupStep('delete group image grant', async () => {
    if (!groupId || !imageId || !server?.id) return { skipped: true };
    return (await req('cleanup delete group image grant', 'DELETE', `/groups/${groupId}/image-grants/${imageId}/${server.id}`, adminToken, undefined, [204, 404])).status;
  });
  await cleanupStep('delete group server grant', async () => {
    if (!groupId || !server?.id) return { skipped: true };
    return (await req('cleanup delete group server grant', 'DELETE', `/groups/${groupId}/server-grants/${server.id}`, adminToken, undefined, [204, 404])).status;
  });
  await cleanupStep('delete direct user server grant', async () => {
    if (!state.created.userId || !server?.id) return { skipped: true };
    return (await req('cleanup delete direct user server grant', 'DELETE', `/users/${state.created.userId}/server-grants/${server.id}`, adminToken, undefined, [204, 404])).status;
  });
  await cleanupStep('remove group member', async () => {
    if (!groupId || !state.created.userId) return { skipped: true };
    return (await req('cleanup remove group member', 'DELETE', `/groups/${groupId}/members/${state.created.userId}`, adminToken, undefined, [204, 404])).status;
  });
  await cleanupStep('delete group', async () => {
    if (!groupId) return { skipped: true };
    return (await req('cleanup delete group', 'DELETE', `/groups/${groupId}`, adminToken, undefined, [204, 404])).status;
  });
  await cleanupStep('delete image', async () => {
    if (!imageId) return { skipped: true };
    return (await req('cleanup delete image', 'DELETE', `/images/${imageId}`, adminToken, undefined, [204, 404])).status;
  });
  await cleanupStep('delete user', async () => {
    if (!state.created.userId) return { skipped: true };
    return (await req('cleanup delete user', 'DELETE', `/users/${state.created.userId}`, adminToken, undefined, [204, 404])).status;
  });

  const escReq = REQUESTED_PREFIX.replaceAll("'", "''");
  const escLow = RESOURCE_PREFIX.replaceAll("'", "''");
  const cid = state.created.containerId?.replaceAll("'", "''");
  const uid = state.created.userId?.replaceAll("'", "''");
  const gid = state.created.groupId?.replaceAll("'", "''");
  const iid = state.created.imageId?.replaceAll("'", "''");
  const proof = {
    activePrefixRows: {
      users: sqlJson(`select id,username,displayName,status from users where username like '${escLow}%' or displayName like '${escReq}%' or displayName like '${escLow}%'`),
      groups: sqlJson(`select id,name,isSystem from groups where name like '${escReq}%' or name like '${escLow}%'`),
      images: sqlJson(`select id,name,dockerImage,isActive from images where name like '${escReq}%' or name like '${escLow}%'`),
      activeContainers: sqlJson(`select id,name,server_id as serverId,owner_id as ownerId,deleted_at as deletedAt from containers where (name like '${escLow}%' or name like '${escReq}%') and deleted_at is null`),
    },
    createdIdRows: {
      users: uid ? sqlJson(`select id,username from users where id='${uid}'`) : [],
      groups: gid ? sqlJson(`select id,name from groups where id='${gid}'`) : [],
      images: iid ? sqlJson(`select id,name from images where id='${iid}'`) : [],
      containers: cid ? sqlJson(`select c.id,c.name,c.deleted_at as deletedAt,l.phase from containers c left join container_lifecycle l on l.containerId=c.id where c.id='${cid}'`) : [],
      serverGrants: (uid || gid) ? sqlJson(`select id,scope,scopeId,serverId,cpuMillis,memBytes,diskBytes from server_grants where ${[uid&&`(scope='user' and scopeId='${uid}')`,gid&&`(scope='group' and scopeId='${gid}')`].filter(Boolean).join(' or ') || '0'}`) : [],
      imageGrants: (uid || gid || iid) ? sqlJson(`select id,scope,scopeId,imageId,serverId from image_grants where ${[uid&&`(scope='user' and scopeId='${uid}')`,gid&&`(scope='group' and scopeId='${gid}')`,iid&&`imageId='${iid}'`].filter(Boolean).join(' or ') || '0'}`) : [],
      groupMembers: (uid || gid) ? sqlJson(`select id,groupId,userId from group_members where ${[uid&&`userId='${uid}'`,gid&&`groupId='${gid}'`].filter(Boolean).join(' or ') || '0'}`) : [],
      quotaDesired: uid ? sqlJson(`select id,serverId,userId,numericUserId,limitBytes,generation from quota_desired where userId='${uid}'`) : [],
      operations: cid ? sqlJson(`select id,kind,status,resourceId,serverId,lastError from operations where resourceId='${cid}' order by createdAt`) : [],
    },
  };
  const activeZero = Object.values(proof.activePrefixRows).every(rows => Array.isArray(rows) && rows.length === 0)
    && ['users','groups','images','serverGrants','imageGrants','groupMembers'].every(k => Array.isArray(proof.createdIdRows[k]) && proof.createdIdRows[k].length === 0)
    && (!proof.createdIdRows.containers.length || proof.createdIdRows.containers.every(r => r.deletedAt));
  addCheck('cleanup active resources zero proof', activeZero, proof);
  if (proof.createdIdRows.quotaDesired.length) {
    state.residuals.push({ type: 'quota_desired', classification: 'cleanup-blocked', note: 'No public API deletes quota_desired rows after user/grant cleanup; limit was set to zero before user deletion.', rows: proof.createdIdRows.quotaDesired });
  }
  const operationResiduals = proof.createdIdRows.operations.filter(r => r.status !== 'succeeded');
  if (operationResiduals.length) state.residuals.push({ type: 'operations', classification: 'infra', rows: operationResiduals });

  const summary = {
    startedAt: state.startedAt,
    completedAt: new Date().toISOString(),
    created: state.created,
    selected: state.selected,
    checks: state.checks.map(c => ({ name: c.name, ok: c.ok, classification: c.classification })),
    failures: state.failures,
    residuals: state.residuals,
    cleanup: state.cleanup,
    probeCount: state.probes.length,
  };
  await fs.writeFile(`${OUT}/admin-api-probe.json`, JSON.stringify(state, null, 2) + '\n');
  await fs.writeFile(`${OUT}/cleanup-proof.json`, JSON.stringify(proof, null, 2) + '\n');
  await fs.writeFile(`${OUT}/admin-api-summary.json`, JSON.stringify(summary, null, 2) + '\n');
  const lines = [
    `started=${state.startedAt}`,
    `completed=${summary.completedAt}`,
    `selected_server=${state.selected.server?.name ?? 'none'} ${state.selected.server?.id ?? ''}`,
    `checks=${state.checks.filter(c=>c.ok).length}/${state.checks.length}`,
    `failures=${state.failures.length}`,
    `residuals=${state.residuals.length}`,
    `created_user=${state.created.userId ?? 'none'}`,
    `created_group=${state.created.groupId ?? 'none'}`,
    `created_image=${state.created.imageId ?? 'none'}`,
    `created_container=${state.created.containerId ?? 'none'}`,
  ];
  await fs.writeFile(`${OUT}/admin-api-summary.txt`, lines.join('\n') + '\n');
  await fs.writeFile(`${LOG}/admin-api-probe.log`, state.probes.map(p => `${p.ok ? 'ok' : 'FAIL'} ${p.method} ${p.path} ${p.status} ${p.label}`).join('\n') + '\n');
  console.log(lines.join('\n'));
  if (state.failures.length) process.exitCode = 2;
}

main().catch(async (e) => {
  state.failures.push({ label: 'script exception', classification: 'infra', error: e instanceof Error ? e.message : String(e) });
  await fs.writeFile(`${OUT}/admin-api-probe.json`, JSON.stringify(state, null, 2) + '\n').catch(()=>{});
  console.error(e);
  process.exit(1);
});
