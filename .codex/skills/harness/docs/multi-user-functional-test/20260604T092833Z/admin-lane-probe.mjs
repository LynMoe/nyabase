import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const frontendBase = process.env.NYABASE_FRONTEND_URL ?? 'http://localhost:5173';
const backendBase = process.env.NYABASE_BACKEND_URL ?? `${frontendBase}/api`;
const adminUsername = process.env.ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.ADMIN_PASSWORD ?? process.env.ADMIN_INIT_PASSWORD ?? 'admin123';
const runId = process.env.NYABASE_ADMIN_LANE_RUN_ID ?? new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15).toLowerCase();
const prefix = `admintest-${runId}`;
const passwordA = `${prefix}-A1pass!`;
const passwordB = `${prefix}-B1pass!`;
const passwordUpdated = `${prefix}-B2pass!`;
const evidencePath = join(process.cwd(), '.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/admin-lane-evidence.json');

const evidence = {
  runId,
  prefix,
  startedAt: new Date().toISOString(),
  frontendBase,
  backendBase,
  checks: [],
  created: {
    users: [],
    groups: [],
    images: [],
    serverGrants: [],
    imageGrants: [],
    apiTokens: [],
  },
  handoffCredentials: [],
  findings: [],
};

class HttpError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} -> ${status}: ${JSON.stringify(body)}`);
    this.method = method;
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

function safeJson(value) {
  if (typeof value === 'string' && value.length > 160) return `${value.slice(0, 160)}...`;
  if (Array.isArray(value)) return value.slice(0, 20).map(safeJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password/i.test(key)) {
        out[key] = item ? '<redacted>' : item;
      } else {
        out[key] = safeJson(item);
      }
    }
    return out;
  }
  return value;
}

function record(name, status, details = {}) {
  const normalizedStatus = status === true ? 'pass' : status === false ? 'fail' : status;
  evidence.checks.push({
    name,
    status: normalizedStatus,
    details: safeJson(details),
    ts: new Date().toISOString(),
  });
}

async function rawFetch(method, pathOrUrl, token, body) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${backendBase}${pathOrUrl}`;
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed, headers: Object.fromEntries(res.headers.entries()) };
}

async function api(method, path, token, body, expected = [200, 201, 204]) {
  const res = await rawFetch(method, path, token, body);
  if (!expected.includes(res.status)) {
    throw new HttpError(method, `${backendBase}${path}`, res.status, res.body);
  }
  return res.body;
}

async function expectStatus(name, method, path, token, body, expectedStatuses) {
  const res = await rawFetch(method, path, token, body);
  const pass = expectedStatuses.includes(res.status);
  record(name, pass ? 'pass' : 'fail', {
    method,
    path,
    expectedStatuses,
    observedStatus: res.status,
    body: res.body,
  });
  if (!pass) {
    evidence.findings.push({
      title: `${name} returned ${res.status}, expected ${expectedStatuses.join('/')}`,
      observed: { status: res.status, body: safeJson(res.body) },
      expected: `HTTP status in ${expectedStatuses.join(', ')}`,
      impact: 'Permission boundary or validation behavior may not match expected product contract.',
      reproduction: [`${method} ${path}`],
    });
  }
  return res;
}

async function main() {
  const frontendRes = await fetch(frontendBase, { headers: { Accept: 'text/html' } });
  record('frontend shell reachable at http://localhost:5173', frontendRes.status >= 200 && frontendRes.status < 400 ? 'pass' : 'fail', {
    observedStatus: frontendRes.status,
    contentType: frontendRes.headers.get('content-type'),
  });

  const unauthorizedMe = await expectStatus('unauthenticated /auth/me is rejected', 'GET', '/auth/me', null, undefined, [401]);
  void unauthorizedMe;

  const badLogin = await expectStatus('bad admin password is rejected', 'POST', '/auth/login', null, {
    username: adminUsername,
    password: `${adminPassword}-wrong`,
  }, [401]);
  void badLogin;

  const adminLogin = await api('POST', '/auth/login', null, {
    username: adminUsername,
    password: adminPassword,
  });
  const adminToken = adminLogin.accessToken;
  const adminCaps = adminLogin.user?.capabilities ?? [];
  const requiredAdminCaps = [
    'manage_users',
    'manage_groups',
    'manage_servers',
    'manage_images',
    'manage_grants',
    'manage_containers_any',
    'view_audit',
    'view_metrics_all',
  ];
  const missingCaps = requiredAdminCaps.filter((cap) => !adminCaps.includes(cap));
  record('admin login returns all management capabilities', missingCaps.length === 0 ? 'pass' : 'fail', {
    username: adminLogin.user?.username,
    userId: adminLogin.user?.id,
    capabilities: adminCaps,
    missingCaps,
  });

  const me = await api('GET', '/auth/me', adminToken);
  record('admin can inspect current user via /auth/me', me.username === adminUsername ? 'pass' : 'fail', {
    username: me.username,
    id: me.id,
    capabilities: me.capabilities,
    groups: me.groups,
  });

  const usersBefore = await api('GET', '/users', adminToken);
  record('admin can list users', Array.isArray(usersBefore) ? 'pass' : 'fail', {
    count: Array.isArray(usersBefore) ? usersBefore.length : null,
  });

  const userA = await api('POST', '/users', adminToken, {
    username: `${prefix}-alpha`,
    password: passwordA,
    displayName: `Admin Lane Alpha ${runId}`,
  });
  evidence.created.users.push({ id: userA.id, username: userA.username, password: passwordA });
  evidence.handoffCredentials.push({
    username: userA.username,
    password: passwordA,
    purpose: 'ordinary user with group-level server/image grants after this probe',
  });
  record('admin created ordinary user alpha', userA.groups?.some((g) => g.name === 'Users') ? 'pass' : 'fail', {
    id: userA.id,
    username: userA.username,
    status: userA.status,
    groups: userA.groups,
  });

  const userB = await api('POST', '/users', adminToken, {
    username: `${prefix}-beta`,
    password: passwordB,
    displayName: `Admin Lane Beta ${runId}`,
  });
  evidence.created.users.push({ id: userB.id, username: userB.username, password: passwordUpdated });
  evidence.handoffCredentials.push({
    username: userB.username,
    password: passwordUpdated,
    purpose: 'ordinary user with direct server/image grants after this probe',
  });
  record('admin created ordinary user beta', userB.groups?.some((g) => g.name === 'Users') ? 'pass' : 'fail', {
    id: userB.id,
    username: userB.username,
    status: userB.status,
    groups: userB.groups,
  });

  await expectStatus('duplicate username is rejected', 'POST', '/users', adminToken, {
    username: userA.username,
    password: passwordA,
    displayName: 'Duplicate Alpha',
  }, [409]);

  await expectStatus('short password is rejected on create user', 'POST', '/users', adminToken, {
    username: `${prefix}-short`,
    password: 'short',
    displayName: 'Short Password',
  }, [400]);

  const patchedB = await api('PATCH', `/users/${userB.id}`, adminToken, {
    displayName: `Admin Lane Beta Updated ${runId}`,
    password: passwordUpdated,
  });
  record('admin can update another user display name and password', patchedB.displayName?.includes('Updated') ? 'pass' : 'fail', {
    id: patchedB.id,
    username: patchedB.username,
    displayName: patchedB.displayName,
  });

  const betaOldLogin = await expectStatus('old beta password is invalid after admin password update', 'POST', '/auth/login', null, {
    username: userB.username,
    password: passwordB,
  }, [401]);
  void betaOldLogin;
  const betaLogin = await api('POST', '/auth/login', null, {
    username: userB.username,
    password: passwordUpdated,
  });
  const betaToken = betaLogin.accessToken;
  record('updated beta password can authenticate', betaLogin.user?.username === userB.username ? 'pass' : 'fail', {
    username: betaLogin.user?.username,
    capabilities: betaLogin.user?.capabilities,
    groups: betaLogin.user?.groups,
  });

  await expectStatus('ordinary user cannot list users', 'GET', '/users', betaToken, undefined, [403]);
  await expectStatus('ordinary user cannot create users', 'POST', '/users', betaToken, {
    username: `${prefix}-blocked`,
    password: `${prefix}-blocked-pass`,
    displayName: 'Blocked User',
  }, [403]);
  await expectStatus('ordinary user cannot read another user detail', 'GET', `/users/${userA.id}`, betaToken, undefined, [403]);

  const betaSelfStatusPatch = await api('PATCH', `/users/${userB.id}`, betaToken, {
    displayName: `Beta self patch ${runId}`,
    status: 'disabled',
  });
  record('ordinary user self status patch is ignored', betaSelfStatusPatch.status === 'active' ? 'pass' : 'fail', {
    id: betaSelfStatusPatch.id,
    username: betaSelfStatusPatch.username,
    status: betaSelfStatusPatch.status,
    displayName: betaSelfStatusPatch.displayName,
  });

  const groupsBefore = await api('GET', '/groups', adminToken);
  record('admin can list groups', Array.isArray(groupsBefore) ? 'pass' : 'fail', {
    count: Array.isArray(groupsBefore) ? groupsBefore.length : null,
    systemGroups: Array.isArray(groupsBefore) ? groupsBefore.filter((g) => g.isSystem).map((g) => g.name) : [],
  });
  await expectStatus('ordinary user cannot list groups', 'GET', '/groups', betaToken, undefined, [403]);

  const group = await api('POST', '/groups', adminToken, {
    name: `${prefix}-operators`,
    description: 'Admin persona lane test group',
    priority: 17,
    capabilities: ['view_audit'],
  });
  evidence.created.groups.push({ id: group.id, name: group.name });
  record('admin can create group with capability', group.capabilities?.includes('view_audit') ? 'pass' : 'fail', {
    id: group.id,
    name: group.name,
    priority: group.priority,
    capabilities: group.capabilities,
  });

  const updatedGroup = await api('PATCH', `/groups/${group.id}`, adminToken, {
    description: 'Admin persona lane test group updated',
    priority: 18,
    capabilities: ['view_audit', 'view_metrics_all'],
  });
  record('admin can update group capabilities and priority', updatedGroup.capabilities?.includes('view_metrics_all') && updatedGroup.priority === 18 ? 'pass' : 'fail', {
    id: updatedGroup.id,
    priority: updatedGroup.priority,
    capabilities: updatedGroup.capabilities,
  });

  await api('POST', `/groups/${group.id}/members`, adminToken, { userId: userA.id });
  const members = await api('GET', `/groups/${group.id}/members`, adminToken);
  record('admin can add group member', Array.isArray(members) && members.some((m) => m.id === userA.id || m.userId === userA.id), {
    groupId: group.id,
    memberCount: Array.isArray(members) ? members.length : null,
    members,
  });

  const alphaLogin = await api('POST', '/auth/login', null, {
    username: userA.username,
    password: passwordA,
  });
  const alphaToken = alphaLogin.accessToken;
  const alphaMe = await api('GET', '/auth/me', alphaToken);
  record('new group capabilities appear in ordinary user /auth/me', ['view_audit', 'view_metrics_all'].every((cap) => alphaMe.capabilities?.includes(cap)) ? 'pass' : 'fail', {
    username: alphaMe.username,
    capabilities: alphaMe.capabilities,
    groups: alphaMe.groups,
  });
  await expectStatus('user with view_audit but no manage_users cannot list users', 'GET', '/users', alphaToken, undefined, [403]);

  const servers = await api('GET', '/servers', adminToken);
  const firstServer = Array.isArray(servers) ? servers[0] : null;
  record('admin can list servers for visibility setup', Array.isArray(servers) ? 'pass' : 'fail', {
    count: Array.isArray(servers) ? servers.length : null,
    firstServer: firstServer ? {
      id: firstServer.id,
      name: firstServer.name,
      status: firstServer.status,
      isGpuServer: firstServer.isGpuServer,
    } : null,
  });

  let image = null;
  if (firstServer) {
    const grantPayload = {
      cpuMillis: 250,
      memBytes: 128 * 1024 * 1024,
      diskBytes: 64 * 1024 * 1024,
      gpuMode: 'none',
      gpuIndices: [],
    };
    const groupServerGrant = await api('POST', `/groups/${group.id}/server-grants/${firstServer.id}`, adminToken, grantPayload);
    evidence.created.serverGrants.push({ scope: 'group', scopeId: group.id, serverId: firstServer.id });
    record('admin can add group server grant', groupServerGrant.serverId === firstServer.id, groupServerGrant);

    const userServerGrant = await api('POST', `/users/${userB.id}/server-grants/${firstServer.id}`, adminToken, {
      cpuMillis: 500,
      memBytes: 256 * 1024 * 1024,
      diskBytes: 128 * 1024 * 1024,
      gpuMode: 'none',
      gpuIndices: [],
    });
    evidence.created.serverGrants.push({ scope: 'user', scopeId: userB.id, serverId: firstServer.id });
    record('admin can add direct user server grant', userServerGrant.serverId === firstServer.id, userServerGrant);

    const alphaServers = await api('GET', '/servers', alphaToken);
    record('granted ordinary user can see granted server', Array.isArray(alphaServers) && alphaServers.some((s) => s.id === firstServer.id), {
      expectedServerId: firstServer.id,
      visibleServerIds: Array.isArray(alphaServers) ? alphaServers.map((s) => s.id) : null,
    });
  }

  const imagesBefore = await api('GET', '/images', adminToken);
  record('admin can list images', Array.isArray(imagesBefore) ? 'pass' : 'fail', {
    count: Array.isArray(imagesBefore) ? imagesBefore.length : null,
  });

  image = await api('POST', '/images', adminToken, {
    name: `${prefix}-image`,
    dockerImage: 'alpine:3.20',
    defaultUser: 'root',
    defaultShell: '/bin/sh',
    defaultUid: 0,
    description: 'Admin persona lane disposable image',
    cmd: '/bin/sh',
  });
  evidence.created.images.push({ id: image.id, name: image.name });
  record('admin can create image for visibility setup', image.name === `${prefix}-image`, {
    id: image.id,
    name: image.name,
    dockerImage: image.dockerImage,
    isActive: image.isActive,
  });

  const adminImageDetail = await rawFetch('GET', `/images/${image.id}`, adminToken);
  record('admin can read newly created image detail', adminImageDetail.status === 200 ? 'pass' : 'fail', {
    expectedStatus: 200,
    observedStatus: adminImageDetail.status,
    body: adminImageDetail.body,
  });
  if (adminImageDetail.status !== 200) {
    evidence.findings.push({
      title: 'Admin cannot read image detail for an image they created unless it is granted',
      reproduction: [
        'POST /api/images as admin with a valid image body',
        `GET /api/images/${image.id} as the same admin`,
      ],
      observed: `GET returned HTTP ${adminImageDetail.status} with body ${JSON.stringify(safeJson(adminImageDetail.body))}`,
      expected: 'Admin users with manage_images should be able to inspect image details consistently with GET /api/images list access.',
      impact: 'Admin image visibility/setup flows can be blocked by the detail endpoint, especially UI flows that navigate to or inspect a newly created image before grants exist.',
      evidence: { imageId: image.id },
    });
  }

  if (firstServer && image) {
    const groupImageGrant = await api('POST', `/groups/${group.id}/image-grants`, adminToken, {
      imageId: image.id,
      serverId: firstServer.id,
    });
    evidence.created.imageGrants.push({ scope: 'group', scopeId: group.id, imageId: image.id, serverId: firstServer.id });
    record('admin can add group image grant', groupImageGrant.imageId === image.id && groupImageGrant.serverId === firstServer.id, groupImageGrant);

    const userImageGrant = await api('POST', `/users/${userB.id}/image-grants`, adminToken, {
      imageId: image.id,
      serverId: firstServer.id,
    });
    evidence.created.imageGrants.push({ scope: 'user', scopeId: userB.id, imageId: image.id, serverId: firstServer.id });
    record('admin can add direct user image grant', userImageGrant.imageId === image.id && userImageGrant.serverId === firstServer.id, userImageGrant);

    const alphaImages = await api('GET', '/images?activeOnly=true', alphaToken);
    record('granted ordinary user can see granted image', Array.isArray(alphaImages) && alphaImages.some((img) => img.id === image.id), {
      expectedImageId: image.id,
      visibleImageIds: Array.isArray(alphaImages) ? alphaImages.map((img) => img.id) : null,
    });

    const alphaEffective = await api('GET', `/users/${userA.id}/effective-access`, adminToken);
    record('admin can inspect effective access for group-granted user', Array.isArray(alphaEffective.servers) && alphaEffective.servers.some((s) => s.serverId === firstServer.id && s.allowedImageIds.includes(image.id)), {
      userId: userA.id,
      expectedServerId: firstServer.id,
      expectedImageId: image.id,
      effectiveAccess: alphaEffective,
    });

    const betaEffective = await api('GET', `/users/${userB.id}/effective-access`, adminToken);
    record('admin can inspect effective access for direct-granted user', Array.isArray(betaEffective.servers) && betaEffective.servers.some((s) => s.serverId === firstServer.id && s.allowedImageIds.includes(image.id)), {
      userId: userB.id,
      expectedServerId: firstServer.id,
      expectedImageId: image.id,
      effectiveAccess: betaEffective,
    });

    await expectStatus('ordinary user cannot inspect another user effective access', 'GET', `/users/${userA.id}/effective-access`, betaToken, undefined, [403]);
  } else {
    record('server/image grant setup skipped because no server was available', 'skip', { firstServer, image });
  }

  const auditAdmin = await api('GET', '/audit?limit=20', adminToken);
  record('admin can view audit log', Array.isArray(auditAdmin) ? 'pass' : 'fail', {
    count: Array.isArray(auditAdmin) ? auditAdmin.length : null,
    actions: Array.isArray(auditAdmin) ? auditAdmin.map((a) => a.action).slice(0, 10) : null,
  });

  const auditAlpha = await api('GET', '/audit?limit=5', alphaToken);
  record('ordinary user with view_audit group capability can view audit log', Array.isArray(auditAlpha) ? 'pass' : 'fail', {
    count: Array.isArray(auditAlpha) ? auditAlpha.length : null,
  });

  await expectStatus('ordinary user without view_audit cannot view audit log', 'GET', '/audit?limit=5', betaToken, undefined, [403]);

  const apiTokenCreated = await api('POST', '/auth/tokens', betaToken, { name: `${prefix}-beta-token` });
  evidence.created.apiTokens.push({ ownerId: userB.id, tokenId: apiTokenCreated.token?.id });
  record('ordinary user can create API token', Boolean(apiTokenCreated.secret && apiTokenCreated.token?.id), {
    token: apiTokenCreated.token,
    secretSeenOnce: Boolean(apiTokenCreated.secret),
  });

  const apiTokenMe = await api('GET', '/auth/me', apiTokenCreated.secret);
  record('API token can authenticate as ordinary user', apiTokenMe.username === userB.username, {
    username: apiTokenMe.username,
    id: apiTokenMe.id,
  });
  await api('DELETE', `/auth/tokens/${apiTokenCreated.token.id}`, betaToken, undefined, [204]);
  record('ordinary user can delete own API token', 'pass', { tokenId: apiTokenCreated.token.id });
  await expectStatus('deleted API token is rejected', 'GET', '/auth/me', apiTokenCreated.secret, undefined, [401]);

  const selfDelete = await expectStatus('admin cannot delete self', 'DELETE', `/users/${me.id}`, adminToken, undefined, [403]);
  void selfDelete;

  const failedChecks = evidence.checks.filter((c) => c.status === 'fail');
  evidence.finishedAt = new Date().toISOString();
  evidence.summary = {
    passed: evidence.checks.filter((c) => c.status === 'pass').length,
    failed: failedChecks.length,
    skipped: evidence.checks.filter((c) => c.status === 'skip').length,
    findingCount: evidence.findings.length,
  };

  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    verdict: failedChecks.length === 0 && evidence.findings.length === 0 ? 'PASS' : 'FAIL',
    summary: evidence.summary,
    evidencePath,
    handoffCredentials: evidence.handoffCredentials,
    findings: evidence.findings.map((f) => f.title),
  }, null, 2));
}

main().catch(async (err) => {
  evidence.finishedAt = new Date().toISOString();
  evidence.summary = {
    passed: evidence.checks.filter((c) => c.status === 'pass').length,
    failed: evidence.checks.filter((c) => c.status === 'fail').length + 1,
    skipped: evidence.checks.filter((c) => c.status === 'skip').length,
    findingCount: evidence.findings.length,
    fatal: safeJson({ message: err.message, status: err.status, body: err.body }),
  };
  record('probe fatal error', 'fail', { message: err.message, status: err.status, body: err.body });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  console.error(err);
  process.exitCode = 1;
});
