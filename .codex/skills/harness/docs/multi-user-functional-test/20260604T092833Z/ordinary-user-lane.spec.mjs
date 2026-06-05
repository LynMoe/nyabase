import { chromium } from '/root/nyabase/packages/frontend/node_modules/@playwright/test/index.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SESSION_DIR = '/root/nyabase/.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z';
const EVIDENCE_PATH = join(SESSION_DIR, 'ordinary-user-lane-evidence.json');
const SCREENSHOT_DIR = SESSION_DIR;
const FRONTEND = process.env.NYABASE_FRONTEND_URL ?? 'http://localhost:5173';
const API = `${FRONTEND.replace(/\/$/, '')}/api`;
const ADMIN_USERNAME = process.env.NYABASE_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.NYABASE_ADMIN_PASSWORD ?? 'admin123';
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const PREFIX = `ou${RUN_ID}`;
const PASSWORD_A = `${PREFIX}A123!`;
const PASSWORD_B = `${PREFIX}B123!`;
const PASSWORD_A2 = `${PREFIX}A234!`;
const HANDOFF_BETA = {
  username: 'admintest-20260604t093408-beta',
  password: 'admintest-20260604t093408-B2pass!',
  source: '.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/admin-lane.md',
};
const MANAGEMENT_CAPS = new Set([
  'manage_users',
  'manage_groups',
  'manage_servers',
  'manage_images',
  'manage_grants',
  'manage_containers_any',
  'view_audit',
  'view_metrics_all',
]);
const MI_B = 1024 * 1024;

const evidence = {
  runId: RUN_ID,
  prefix: PREFIX,
  frontend: FRONTEND,
  api: API,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  counts: { passed: 0, failed: 0, skipped: 0 },
  created: {
    users: [],
    sshKeys: [],
    apiTokens: [],
    containers: [],
  },
  deleted: {
    users: [],
    sshKeys: [],
    apiTokens: [],
    containers: [],
  },
  screenshots: [],
  steps: [],
  findings: [],
  cleanup: [],
};

let adminToken = '';
let userA = null;
let userB = null;
let userAToken = '';
let userBToken = '';
let serverA = null;
let serverB = null;
let imageA = null;
let imageB = null;
const containersToDelete = [];

main().catch(async (error) => {
  record('harness failure', 'fail', { error: describeError(error) });
  await cleanup();
  await writeEvidence();
  process.exitCode = 1;
});

async function main() {
  try {
    const adminLogin = await request('POST', '/auth/login', undefined, {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    });
    expectStatus(adminLogin, [200], 'admin setup login');
    adminToken = adminLogin.body.accessToken;
    record('admin setup login', 'pass', {
      status: adminLogin.status,
      adminUserId: adminLogin.body.user?.id,
      adminCaps: adminLogin.body.user?.capabilities,
    });

    const [serversRes, imagesRes] = await Promise.all([
      request('GET', '/servers', adminToken),
      request('GET', '/images', adminToken),
    ]);
    expectStatus(serversRes, [200], 'admin list servers');
    expectStatus(imagesRes, [200], 'admin list images');
    const onlineServers = serversRes.body.filter((s) => s.status === 'online');
    if (onlineServers.length === 0) {
      throw new InfraBlockedError('No online servers are available for grant/visibility testing');
    }
    const activeImages = imagesRes.body.filter((img) => img.isActive !== false);
    if (activeImages.length === 0) {
      throw new InfraBlockedError('No active images are available for grant/visibility testing');
    }
    serverA = onlineServers[0];
    serverB = onlineServers.find((s) => s.id !== serverA.id) ?? onlineServers[0];
    imageA = activeImages[0];
    imageB = activeImages.find((img) => img.id !== imageA.id) ?? activeImages[0];
    record('setup inventory selected', 'pass', {
      servers: onlineServers.map((s) => ({ id: s.id, name: s.name, status: s.status })),
      images: activeImages.map((img) => ({ id: img.id, name: img.name, isActive: img.isActive })),
      selected: {
        userA: { serverId: serverA.id, imageId: imageA.id },
        userB: { serverId: serverB.id, imageId: imageB.id },
      },
    });

    userA = await createUser(`${PREFIX}a`, PASSWORD_A, `${PREFIX} user A`);
    userB = await createUser(`${PREFIX}b`, PASSWORD_B, `${PREFIX} user B`);
    await grantAccess(userA.id, serverA.id, imageA.id, {
      cpuMillis: 750,
      memBytes: 256 * MI_B,
      diskBytes: 1024 * MI_B,
      gpuMode: 'none',
      gpuIndices: [],
    });
    await grantAccess(userB.id, serverB.id, imageB.id, {
      cpuMillis: 500,
      memBytes: 192 * MI_B,
      diskBytes: 1024 * MI_B,
      gpuMode: 'none',
      gpuIndices: [],
    });

    const loginA = await loginAs(userA.username, PASSWORD_A);
    const loginB = await loginAs(userB.username, PASSWORD_B);
    userAToken = loginA.accessToken;
    userBToken = loginB.accessToken;
    await verifyOrdinaryIdentity('user A', loginA, userA);
    await verifyOrdinaryIdentity('user B', loginB, userB);

    await verifyProfileAndSsh();
    await verifyHandoffBeta();
    await verifyAuthorizationBoundaries();
    await verifyResourceVisibility();
    await verifyContainerVisibility();
    await verifyFrontendOrdinaryUser();
  } finally {
    await cleanup();
    evidence.finishedAt = new Date().toISOString();
    await writeEvidence();
  }

  if (evidence.findings.length > 0 || evidence.steps.some((s) => s.result === 'fail')) {
    process.exitCode = 1;
  }
}

async function createUser(username, password, displayName) {
  const res = await request('POST', '/users', adminToken, { username, password, displayName });
  expectStatus(res, [200, 201], `create user ${username}`);
  evidence.created.users.push({ id: res.body.id, username: res.body.username, password });
  record(`create user ${username}`, 'pass', {
    status: res.status,
    id: res.body.id,
    username: res.body.username,
    groups: res.body.groups?.map((g) => g.name),
  });
  return res.body;
}

async function grantAccess(userId, serverId, imageId, quota) {
  const serverGrant = await request('POST', `/users/${userId}/server-grants/${serverId}`, adminToken, quota);
  expectStatus(serverGrant, [200, 201], `grant server ${serverId} to ${userId}`);
  const imageGrant = await request('POST', `/users/${userId}/image-grants`, adminToken, { imageId, serverId });
  expectStatus(imageGrant, [200, 201], `grant image ${imageId} to ${userId}`);
  record(`grant access ${userId}`, 'pass', {
    serverGrantStatus: serverGrant.status,
    imageGrantStatus: imageGrant.status,
    userId,
    serverId,
    imageId,
    quota,
  });
}

async function loginAs(username, password) {
  const res = await request('POST', '/auth/login', undefined, { username, password });
  expectStatus(res, [200], `login ${username}`);
  return res.body;
}

async function verifyOrdinaryIdentity(label, login, createdUser) {
  expect(login.user.id === createdUser.id, `${label} login user id mismatch`, {
    expected: createdUser.id,
    actual: login.user.id,
  });
  const managementCaps = (login.user.capabilities ?? []).filter((cap) => MANAGEMENT_CAPS.has(cap));
  expect(managementCaps.length === 0, `${label} unexpectedly has management capabilities`, { managementCaps });
  const me = await request('GET', '/auth/me', login.accessToken);
  expectStatus(me, [200], `${label} /auth/me`);
  expect(me.body.id === createdUser.id, `${label} /auth/me id mismatch`, {
    expected: createdUser.id,
    actual: me.body.id,
  });
  const meManagementCaps = (me.body.capabilities ?? []).filter((cap) => MANAGEMENT_CAPS.has(cap));
  expect(meManagementCaps.length === 0, `${label} /auth/me management caps`, { meManagementCaps });
  record(`${label} identity and ordinary capabilities`, 'pass', {
    loginStatus: 200,
    meStatus: me.status,
    userId: me.body.id,
    username: me.body.username,
    capabilities: me.body.capabilities,
    groups: me.body.groups?.map((g) => g.name),
  });
}

async function verifyProfileAndSsh() {
  const noCurrentPassword = await request('PATCH', `/users/${userA.id}`, userAToken, {
    password: `${PREFIX}NoCur1!`,
  });
  expectStatus(noCurrentPassword, [400], 'self password change without current password rejected');
  const wrongCurrentPassword = await request('PATCH', `/users/${userA.id}`, userAToken, {
    password: `${PREFIX}WrongCur1!`,
    currentPassword: 'definitely-wrong',
  });
  expectStatus(wrongCurrentPassword, [401], 'self password change with wrong current password rejected');
  const patchSelf = await request('PATCH', `/users/${userA.id}`, userAToken, {
    displayName: `${PREFIX} user A updated`,
    status: 'disabled',
  });
  expectStatus(patchSelf, [200], 'self display name update');
  expect(patchSelf.body.displayName === `${PREFIX} user A updated`, 'self display name did not update', patchSelf.body);
  expect(patchSelf.body.status !== 'disabled', 'ordinary user status mutation was not ignored', patchSelf.body);

  const passwordUpdate = await request('PATCH', `/users/${userA.id}`, userAToken, {
    password: PASSWORD_A2,
    currentPassword: PASSWORD_A,
  });
  expectStatus(passwordUpdate, [200], 'self password change with current password');
  const oldLogin = await request('POST', '/auth/login', undefined, {
    username: userA.username,
    password: PASSWORD_A,
  });
  expectStatus(oldLogin, [401], 'old password rejected after self password change');
  const newLogin = await request('POST', '/auth/login', undefined, {
    username: userA.username,
    password: PASSWORD_A2,
  });
  expectStatus(newLogin, [200], 'new password login succeeds');
  userAToken = newLogin.body.accessToken;

  const invalidSsh = await request('POST', `/users/${userA.id}/ssh-keys`, userAToken, {
    name: `${PREFIX}-invalid`,
    keyText: 'not-an-ssh-public-key',
  });
  if (invalidSsh.status === 400) {
    record('invalid SSH key rejected', 'pass', {
      status: invalidSsh.status,
      body: invalidSsh.body,
    });
  } else {
    const invalidSshFinding = {
      method: invalidSsh.method,
      path: invalidSsh.path,
      expected: '400 Bad Request for malformed public key text',
      actual: `${invalidSsh.status}`,
      body: invalidSsh.body,
    };
    record('invalid SSH key accepted at profile user API', 'fail', invalidSshFinding);
    recordFinding('invalid SSH key accepted at profile user API', invalidSshFinding, {
      observed: `POST ${invalidSsh.path} returned ${invalidSsh.status} and persisted keyText "not-an-ssh-public-key".`,
      expected: 'Malformed SSH public keys should be rejected before persistence.',
      impact: 'Users can save unusable or arbitrary strings as SSH keys; container SSH sync may receive invalid authorized_keys material.',
      reproduction: [
        `Login as ordinary user ${userA.username}.`,
        `POST /api/users/${userA.id}/ssh-keys with {"name":"${PREFIX}-invalid","keyText":"not-an-ssh-public-key"}.`,
        `Observe ${invalidSsh.status} with a persisted SSH-key record instead of 400.`,
      ],
    });
    if (invalidSsh.body?.id) {
      evidence.created.sshKeys.push({ userId: userA.id, keyId: invalidSsh.body.id, name: invalidSsh.body.name, invalid: true });
      const deleteInvalid = await request('DELETE', `/users/${userA.id}/ssh-keys/${invalidSsh.body.id}`, userAToken);
      if (deleteInvalid.status === 204) {
        evidence.deleted.sshKeys.push({ userId: userA.id, keyId: invalidSsh.body.id, invalid: true });
      }
    }
  }

  const validKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOuLane${RUN_ID.padEnd(24, '0')} ${PREFIX}-user-a`;
  const addKey = await request('POST', `/users/${userA.id}/ssh-keys`, userAToken, {
    name: `${PREFIX}-user-a-key`,
    keyText: validKey,
  });
  expectStatus(addKey, [200, 201], 'self add SSH key');
  evidence.created.sshKeys.push({ userId: userA.id, keyId: addKey.body.id, name: addKey.body.name });
  const listKeys = await request('GET', `/users/${userA.id}/ssh-keys`, userAToken);
  expectStatus(listKeys, [200], 'self list SSH keys');
  expect(
    listKeys.body.some((key) => key.id === addKey.body.id && key.name === `${PREFIX}-user-a-key`),
    'new self SSH key missing from list',
    listKeys.body,
  );

  const otherSshList = await request('GET', `/users/${userB.id}/ssh-keys`, userAToken);
  expectStatus(otherSshList, [403], 'ordinary user cannot list another user SSH keys');
  const otherSshPost = await request('POST', `/users/${userB.id}/ssh-keys`, userAToken, {
    name: `${PREFIX}-cross-key`,
    keyText: validKey,
  });
  expectStatus(otherSshPost, [403], 'ordinary user cannot add another user SSH key');
  const otherSshDelete = await request('DELETE', `/users/${userB.id}/ssh-keys/${addKey.body.id}`, userAToken);
  expectStatus(otherSshDelete, [403], 'ordinary user cannot delete another user SSH key');

  const deleteKey = await request('DELETE', `/users/${userA.id}/ssh-keys/${addKey.body.id}`, userAToken);
  expectStatus(deleteKey, [204], 'self delete SSH key');
  evidence.deleted.sshKeys.push({ userId: userA.id, keyId: addKey.body.id });

  const tokenCreate = await request('POST', '/auth/tokens', userAToken, { name: `${PREFIX}-api-token` });
  expectStatus(tokenCreate, [200, 201], 'self API token create');
  evidence.created.apiTokens.push({ userId: userA.id, tokenId: tokenCreate.body.token.id, name: tokenCreate.body.token.name });
  const tokenMe = await request('GET', '/auth/me', tokenCreate.body.secret);
  expectStatus(tokenMe, [200], 'API token authenticates as owner');
  expect(tokenMe.body.id === userA.id, 'API token authenticated as wrong user', tokenMe.body);
  const tokenDelete = await request('DELETE', `/auth/tokens/${tokenCreate.body.token.id}`, userAToken);
  expectStatus(tokenDelete, [204], 'self API token delete');
  evidence.deleted.apiTokens.push({ userId: userA.id, tokenId: tokenCreate.body.token.id });
  const tokenAfterDelete = await request('GET', '/auth/me', tokenCreate.body.secret);
  expectStatus(tokenAfterDelete, [401], 'deleted API token rejected');

  record('self-service profile, password, API token, and SSH key operations', 'pass', {
    noCurrentPasswordStatus: noCurrentPassword.status,
    wrongCurrentPasswordStatus: wrongCurrentPassword.status,
    statusMutationResult: patchSelf.body.status,
    passwordChangeStatus: passwordUpdate.status,
    invalidSshStatus: invalidSsh.status,
    addSshStatus: addKey.status,
    listSshCount: listKeys.body.length,
    crossUserSshStatuses: {
      list: otherSshList.status,
      post: otherSshPost.status,
      delete: otherSshDelete.status,
    },
    apiTokenStatuses: {
      create: tokenCreate.status,
      use: tokenMe.status,
      delete: tokenDelete.status,
      afterDelete: tokenAfterDelete.status,
    },
  });
}

async function verifyHandoffBeta() {
  const betaLogin = await request('POST', '/auth/login', undefined, {
    username: HANDOFF_BETA.username,
    password: HANDOFF_BETA.password,
  });
  expectStatus(betaLogin, [200], 'admin-lane handoff beta login');
  const betaToken = betaLogin.body.accessToken;
  const me = await request('GET', '/auth/me', betaToken);
  expectStatus(me, [200], 'admin-lane handoff beta /auth/me');
  const managementCaps = (me.body.capabilities ?? []).filter((cap) => MANAGEMENT_CAPS.has(cap));
  expect(managementCaps.length === 0, 'admin-lane handoff beta unexpectedly has management capabilities', {
    username: HANDOFF_BETA.username,
    managementCaps,
  });
  const [access, servers, images, usersDenied, groupsDenied, auditDenied] = await Promise.all([
    request('GET', '/me/access', betaToken),
    request('GET', '/servers', betaToken),
    request('GET', '/images', betaToken),
    request('GET', '/users', betaToken),
    request('GET', '/groups', betaToken),
    request('GET', '/audit?limit=5', betaToken),
  ]);
  expectStatus(access, [200], 'admin-lane handoff beta /me/access');
  expectStatus(servers, [200], 'admin-lane handoff beta /servers');
  expectStatus(images, [200], 'admin-lane handoff beta /images');
  expectStatus(usersDenied, [403], 'admin-lane handoff beta /users denied');
  expectStatus(groupsDenied, [403], 'admin-lane handoff beta /groups denied');
  expectStatus(auditDenied, [403], 'admin-lane handoff beta /audit denied without view_audit');
  record('admin-lane handoff beta ordinary direct-grant session', 'pass', {
    credentialSource: HANDOFF_BETA.source,
    username: HANDOFF_BETA.username,
    userId: me.body.id,
    capabilities: me.body.capabilities,
    access: access.body,
    serverIds: servers.body.map((s) => s.id),
    imageIds: images.body.map((img) => img.id),
    denialStatuses: {
      users: usersDenied.status,
      groups: groupsDenied.status,
      audit: auditDenied.status,
    },
  });
}

async function verifyAuthorizationBoundaries() {
  const endpoints = [
    ['GET', '/users'],
    ['GET', `/users/${userB.id}`],
    ['POST', '/users', { username: `${PREFIX}evil`, password: `${PREFIX}Evil123!`, displayName: 'evil' }],
    ['DELETE', `/users/${userB.id}`],
    ['GET', '/groups'],
    ['POST', '/groups', { name: `${PREFIX}-group`, capabilities: [] }],
    ['GET', `/users/${userA.id}/effective-access`],
    ['GET', `/users/${userA.id}/server-grants`],
    ['POST', `/users/${userA.id}/server-grants/${serverB.id}`, { cpuMillis: 1 }],
    ['GET', `/users/${userA.id}/image-grants`],
    ['POST', `/users/${userA.id}/image-grants`, { imageId: imageB.id, serverId: serverB.id }],
    ['GET', '/servers/all-disks'],
    ['POST', '/servers', {
      name: `${PREFIX}-server`,
      parentIface: 'eth0',
      ipCidr: '10.255.0.0/24',
      gateway: '10.255.0.1',
      reservedIps: [],
    }],
    ['POST', `/servers/${serverA.id}/regenerate-token`],
    ['PATCH', `/servers/${serverA.id}`, { name: `${serverA.name}-ordinary-should-not-write` }],
    ['POST', `/servers/${serverA.id}/disks`, { mountPoint: '/tmp', label: `${PREFIX}-disk` }],
    ['GET', `/images/${imageA.id}/status`],
    ['POST', '/images', {
      name: `${PREFIX}-image`,
      dockerImage: 'alpine:3.20',
      defaultUser: 'root',
      defaultShell: '/bin/sh',
      defaultUid: 0,
    }],
    ['PATCH', `/images/${imageA.id}`, { name: `${imageA.name}-ordinary-should-not-write` }],
    ['DELETE', `/images/${imageA.id}`],
    ['GET', '/audit?limit=10'],
    ['GET', `/metrics/servers/${serverB.id}/users?range=1h`],
    ['GET', `/metrics/servers/${serverB.id}/containers?range=1h`],
  ];
  const results = [];
  for (const [method, path, body] of endpoints) {
    const res = await request(method, path, userAToken, body);
    const expected = path.startsWith(`/metrics/servers/${serverB.id}`)
      ? [403, 404]
      : [403];
    expectStatus(res, expected, `unauthorized boundary ${method} ${path}`);
    results.push({ method, path, status: res.status });
  }

  const directUserB = await request('GET', `/users/${userB.id}`, userAToken);
  expectStatus(directUserB, [403], 'ordinary user cannot read another user detail');
  const patchOther = await request('PATCH', `/users/${userB.id}`, userAToken, { displayName: 'cross write' });
  expectStatus(patchOther, [403], 'ordinary user cannot patch another user');
  const selfDelete = await request('DELETE', `/users/${userA.id}`, userAToken);
  expectStatus(selfDelete, [403], 'ordinary user cannot delete self via admin endpoint');

  record('ordinary user denied admin pages/APIs and cross-user APIs', 'pass', {
    endpointStatuses: results,
    crossUserStatuses: {
      getUserB: directUserB.status,
      patchUserB: patchOther.status,
      deleteSelf: selfDelete.status,
    },
  });
}

async function verifyResourceVisibility() {
  const [accessA, accessB, serversA, serversB, imagesA, imagesB] = await Promise.all([
    request('GET', '/me/access', userAToken),
    request('GET', '/me/access', userBToken),
    request('GET', '/servers', userAToken),
    request('GET', '/servers', userBToken),
    request('GET', '/images', userAToken),
    request('GET', '/images', userBToken),
  ]);
  for (const [name, res] of [
    ['accessA', accessA],
    ['accessB', accessB],
    ['serversA', serversA],
    ['serversB', serversB],
    ['imagesA', imagesA],
    ['imagesB', imagesB],
  ]) {
    expectStatus(res, [200], `visibility ${name}`);
  }

  expect(accessA.body.servers.some((s) => s.serverId === serverA.id), 'user A missing granted server', accessA.body);
  expect(!accessA.body.servers.some((s) => s.serverId === serverB.id && serverB.id !== serverA.id), 'user A sees user B server grant', accessA.body);
  expect(accessB.body.servers.some((s) => s.serverId === serverB.id), 'user B missing granted server', accessB.body);
  expect(!accessB.body.servers.some((s) => s.serverId === serverA.id && serverA.id !== serverB.id), 'user B sees user A server grant', accessB.body);
  expect(serversA.body.some((s) => s.id === serverA.id), 'user A /servers missing granted server', serversA.body);
  expect(!serversA.body.some((s) => s.id === serverB.id && serverB.id !== serverA.id), 'user A /servers includes ungranted server', serversA.body);
  expect(serversB.body.some((s) => s.id === serverB.id), 'user B /servers missing granted server', serversB.body);
  expect(!serversB.body.some((s) => s.id === serverA.id && serverA.id !== serverB.id), 'user B /servers includes ungranted server', serversB.body);
  expect(imagesA.body.some((img) => img.id === imageA.id), 'user A /images missing granted image', imagesA.body);
  expect(!imagesA.body.some((img) => img.id === imageB.id && imageB.id !== imageA.id), 'user A /images includes ungranted image', imagesA.body);
  expect(imagesB.body.some((img) => img.id === imageB.id), 'user B /images missing granted image', imagesB.body);
  expect(!imagesB.body.some((img) => img.id === imageA.id && imageA.id !== imageB.id), 'user B /images includes ungranted image', imagesB.body);

  const serverBDetailFromA = await request('GET', `/servers/${serverB.id}`, userAToken);
  if (serverA.id !== serverB.id) {
    if (serverBDetailFromA.status === 404) {
      record('user A cannot read ungranted server detail', 'pass', {
        status: serverBDetailFromA.status,
        path: serverBDetailFromA.path,
      });
    } else {
      const detail = {
        method: serverBDetailFromA.method,
        path: serverBDetailFromA.path,
        expected: '404 Not Found for ungranted server detail',
        actual: `${serverBDetailFromA.status}`,
        body: serverBDetailFromA.body,
      };
      record('user A can read ungranted server detail', 'fail', detail);
      recordFinding('user A can read ungranted server detail', detail, {
        observed: `GET ${serverBDetailFromA.path} returned ${serverBDetailFromA.status}.`,
        expected: 'Ordinary users should not read server details without a server grant.',
        impact: 'Potential server inventory disclosure outside assigned grants.',
        reproduction: [
          `Login as ordinary user ${userA.username}.`,
          `GET /api/servers/${serverB.id}, where the user only has a grant for ${serverA.id}.`,
          `Observe ${serverBDetailFromA.status} instead of 404.`,
        ],
      });
    }
  }
  const imageBDetailFromA = await request('GET', `/images/${imageB.id}`, userAToken);
  if (imageA.id !== imageB.id) {
    if (imageBDetailFromA.status === 403) {
      record('user A cannot read ungranted image detail', 'pass', {
        status: imageBDetailFromA.status,
        path: imageBDetailFromA.path,
      });
    } else {
      const detail = {
        method: imageBDetailFromA.method,
        path: imageBDetailFromA.path,
        expected: '403 Forbidden for image not present in user /images list or effective access',
        actual: `${imageBDetailFromA.status}`,
        body: imageBDetailFromA.body,
      };
      record('user A can read ungranted image detail', 'fail', detail);
      recordFinding('user A can read ungranted image detail', detail, {
        observed: `GET ${imageBDetailFromA.path} returned ${imageBDetailFromA.status} with full image metadata, while /images for the same user did not include that image.`,
        expected: 'Image detail authorization should be at least as restrictive as /images list and effective access.',
        impact: 'Ordinary users can inspect image metadata outside their visible/usable grant set.',
        reproduction: [
          `Login as ordinary user ${userA.username}.`,
          `Confirm GET /api/images only includes ${imageA.id}.`,
          `GET /api/images/${imageB.id}.`,
          `Observe ${imageBDetailFromA.status} with image metadata instead of 403.`,
        ],
      });
    }
  }
  const createOnServerB = await request('POST', '/containers', userAToken, {
    serverId: serverB.id,
    imageId: imageB.id,
    name: `${PREFIX}denyb`,
    cpuMillis: 10,
    memBytes: 32 * MI_B,
  });
  if (serverA.id !== serverB.id || imageA.id !== imageB.id) {
    if (createOnServerB.status === 403) {
      record('user A cannot create on user B resource slice', 'pass', {
        status: createOnServerB.status,
        body: createOnServerB.body,
      });
    } else {
      const detail = {
        method: createOnServerB.method,
        path: createOnServerB.path,
        expected: '403 Forbidden for create on ungranted server/image slice',
        actual: `${createOnServerB.status}`,
        body: createOnServerB.body,
      };
      record('user A can create on user B resource slice', 'fail', detail);
      recordFinding('user A can create on user B resource slice', detail, {
        observed: `POST /containers with serverId=${serverB.id}, imageId=${imageB.id} returned ${createOnServerB.status}.`,
        expected: 'Ordinary users should only create containers on their granted server/image combinations.',
        impact: 'Potential quota and resource-boundary bypass.',
        reproduction: [
          `Login as ordinary user ${userA.username}.`,
          `POST /api/containers with serverId ${serverB.id} and imageId ${imageB.id}.`,
          `Observe ${createOnServerB.status} instead of 403.`,
        ],
      });
    }
  }

  record('per-user server/image/access visibility', 'pass', {
    userA: {
      access: accessA.body,
      serverIds: serversA.body.map((s) => s.id),
      imageIds: imagesA.body.map((img) => img.id),
      ungrantedServerStatus: serverBDetailFromA.status,
      ungrantedImageStatus: imageBDetailFromA.status,
      createUngrantedStatus: createOnServerB.status,
    },
    userB: {
      access: accessB.body,
      serverIds: serversB.body.map((s) => s.id),
      imageIds: imagesB.body.map((img) => img.id),
    },
  });
}

async function verifyContainerVisibility() {
  const beforeA = await request('GET', '/containers?ownOnly=true', userAToken);
  const beforeB = await request('GET', '/containers?ownOnly=true', userBToken);
  expectStatus(beforeA, [200], 'user A own containers before');
  expectStatus(beforeB, [200], 'user B own containers before');

  const nameA = `${PREFIX}a`;
  const nameB = `${PREFIX}b`;
  const createA = await request('POST', '/containers', userAToken, {
    serverId: serverA.id,
    imageId: imageA.id,
    name: nameA,
    cpuMillis: 50,
    memBytes: 32 * MI_B,
  });
  const createB = await request('POST', '/containers', userBToken, {
    serverId: serverB.id,
    imageId: imageB.id,
    name: nameB,
    cpuMillis: 50,
    memBytes: 32 * MI_B,
  });

  const created = [];
  if ([200, 201, 202].includes(createA.status)) {
    const c = await waitForContainer(userAToken, nameA, userA.id);
    if (c) {
      created.push({ actor: 'userA', container: c });
      containersToDelete.push({ token: userAToken, serverId: c.serverId, containerId: c.containerId ?? c.id, name: c.spec?.name });
      evidence.created.containers.push({ actor: 'userA', serverId: c.serverId, containerId: c.containerId ?? c.id, name: c.spec?.name });
    }
  } else {
    record('user A container create skipped', 'skip', { status: createA.status, body: createA.body });
  }
  if ([200, 201, 202].includes(createB.status)) {
    const c = await waitForContainer(userBToken, nameB, userB.id);
    if (c) {
      created.push({ actor: 'userB', container: c });
      containersToDelete.push({ token: userBToken, serverId: c.serverId, containerId: c.containerId ?? c.id, name: c.spec?.name });
      evidence.created.containers.push({ actor: 'userB', serverId: c.serverId, containerId: c.containerId ?? c.id, name: c.spec?.name });
    }
  } else {
    record('user B container create skipped', 'skip', { status: createB.status, body: createB.body });
  }

  const listA = await request('GET', '/containers?ownOnly=true', userAToken);
  const listB = await request('GET', '/containers?ownOnly=true', userBToken);
  expectStatus(listA, [200], 'user A own containers after');
  expectStatus(listB, [200], 'user B own containers after');
  expect(
    listA.body.every((c) => c.spec?.ownerId === userA.id),
    'user A own container list contains another owner',
    listA.body.map(containerSummary),
  );
  expect(
    listB.body.every((c) => c.spec?.ownerId === userB.id),
    'user B own container list contains another owner',
    listB.body.map(containerSummary),
  );

  const userAContainer = created.find((c) => c.actor === 'userA')?.container;
  const userBContainer = created.find((c) => c.actor === 'userB')?.container;
  const cross = {};
  if (userAContainer) {
    const id = userAContainer.containerId ?? userAContainer.id;
    const getFromB = await request('GET', `/containers/${userAContainer.serverId}/${id}`, userBToken);
    expectStatus(getFromB, [403, 404], 'user B cannot get user A container detail');
    const deleteFromB = await request('DELETE', `/containers/${userAContainer.serverId}/${id}`, userBToken);
    expectStatus(deleteFromB, [403, 404], 'user B cannot delete user A container');
    cross.userAContainerFromB = { get: getFromB.status, delete: deleteFromB.status };
  }
  if (userBContainer) {
    const id = userBContainer.containerId ?? userBContainer.id;
    const getFromA = await request('GET', `/containers/${userBContainer.serverId}/${id}`, userAToken);
    expectStatus(getFromA, [403, 404], 'user A cannot get user B container detail');
    const deleteFromA = await request('DELETE', `/containers/${userBContainer.serverId}/${id}`, userAToken);
    expectStatus(deleteFromA, [403, 404], 'user A cannot delete user B container');
    cross.userBContainerFromA = { get: getFromA.status, delete: deleteFromA.status };
  }

  record('per-user container visibility and cross-user container denial', 'pass', {
    createStatuses: { userA: createA.status, userB: createB.status },
    created: created.map((c) => ({ actor: c.actor, container: containerSummary(c.container) })),
    userAOwnContainerSummaries: listA.body.map(containerSummary),
    userBOwnContainerSummaries: listB.body.map(containerSummary),
    crossAccessStatuses: cross,
  });
}

async function verifyFrontendOrdinaryUser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${FRONTEND}/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', userA.username);
    await page.fill('#password', PASSWORD_A2);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${FRONTEND}/`, { timeout: 15_000 });
    await page.waitForLoadState('networkidle');

    const navLabels = await page.locator('aside nav a').allTextContents();
    const forbiddenNav = ['服务器', '镜像', '容器管理', '远程文件系统', '用户', '用户组', '审计']
      .filter((label) => navLabels.some((text) => text.includes(label)));
    expect(forbiddenNav.length === 0, 'ordinary user sees admin navigation links', { navLabels, forbiddenNav });

    const profilePath = join(SCREENSHOT_DIR, 'ordinary-user-profile.png');
    await page.goto(`${FRONTEND}/profile`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: profilePath, fullPage: true });
    evidence.screenshots.push(profilePath);

    const userMgmtPath = join(SCREENSHOT_DIR, 'ordinary-user-users-page-denied.png');
    await page.goto(`${FRONTEND}/users`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: userMgmtPath, fullPage: true });
    evidence.screenshots.push(userMgmtPath);
    const usersPageText = await page.locator('body').innerText();
    expect(!usersPageText.includes('添加用户'), 'ordinary user can see user creation UI on /users direct URL', {
      usersPageText: usersPageText.slice(0, 1000),
    });
    const usersApiStatus = await page.evaluate(async () => {
      const res = await fetch('/api/users');
      return res.status;
    });
    expect(usersApiStatus === 403, 'ordinary browser session /api/users was not denied', { usersApiStatus });

    const groupsApiStatus = await page.evaluate(async () => {
      const res = await fetch('/api/groups');
      return res.status;
    });
    expect(groupsApiStatus === 403, 'ordinary browser session /api/groups was not denied', { groupsApiStatus });

    const serversApi = await page.evaluate(async () => {
      const res = await fetch('/api/servers');
      return { status: res.status, body: await res.json() };
    });
    expect(serversApi.status === 200, 'ordinary browser session /api/servers did not succeed', serversApi);
    expect(serversApi.body.every((s) => s.id === serverA.id), 'ordinary browser session /api/servers leaks ungranted servers', serversApi);

    record('frontend ordinary-user UI and direct-route authorization', 'pass', {
      navLabels,
      profileScreenshot: profilePath,
      usersPageScreenshot: userMgmtPath,
      apiStatuses: {
        users: usersApiStatus,
        groups: groupsApiStatus,
        servers: serversApi.status,
      },
      serverIds: serversApi.body.map((s) => s.id),
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function waitForContainer(token, name, ownerId) {
  for (let i = 0; i < 15; i += 1) {
    const list = await request('GET', '/containers?ownOnly=true', token);
    if (list.status === 200) {
      const found = list.body.find((c) => c.spec?.name === name && c.spec?.ownerId === ownerId);
      if (found) return found;
    }
    await delay(1000);
  }
  record(`container ${name} not found after create response`, 'skip', {});
  return null;
}

async function cleanup() {
  for (const container of [...containersToDelete].reverse()) {
    try {
      const res = await request('DELETE', `/containers/${container.serverId}/${container.containerId}`, container.token);
      evidence.cleanup.push({
        kind: 'container',
        id: container.containerId,
        name: container.name,
        status: res.status,
        body: res.body,
      });
      if ([200, 202, 204].includes(res.status)) {
        evidence.deleted.containers.push({ serverId: container.serverId, containerId: container.containerId, name: container.name });
      }
    } catch (error) {
      evidence.cleanup.push({ kind: 'container', id: container.containerId, error: describeError(error) });
    }
  }

  if (adminToken) {
    for (const user of [userA, userB].filter(Boolean)) {
      try {
        const res = await request('DELETE', `/users/${user.id}`, adminToken);
        evidence.cleanup.push({ kind: 'user', id: user.id, username: user.username, status: res.status });
        if (res.status === 204) {
          evidence.deleted.users.push({ id: user.id, username: user.username });
        }
      } catch (error) {
        evidence.cleanup.push({ kind: 'user', id: user.id, username: user.username, error: describeError(error) });
      }
    }
  }
}

async function request(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = token.startsWith('nyabase_') ? `Bearer ${token}` : `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { method, path, status: res.status, body: parsed };
}

function expectStatus(res, statuses, description) {
  if (!statuses.includes(res.status)) {
    const detail = {
      method: res.method,
      path: res.path,
      expected: statuses,
      actual: res.status,
      body: res.body,
    };
    record(description, 'fail', detail);
    recordFinding(description, detail, {
      observed: `${res.method} ${res.path} returned ${res.status}`,
      expected: `Expected one of ${statuses.join(', ')}`,
      impact: 'Authorization or functional behavior differed from the ordinary-user contract.',
    });
    throw new Error(`${description}: expected ${statuses.join('/')} got ${res.status}`);
  }
}

function expect(condition, description, detail = {}) {
  if (!condition) {
    record(description, 'fail', detail);
    recordFinding(description, detail, {
      observed: detail,
      expected: 'Condition should hold for ordinary-user isolation and self-service behavior.',
      impact: 'Potential product authorization or self-service regression.',
    });
    throw new Error(description);
  }
}

function recordFinding(title, detail, overrides = {}) {
  evidence.findings.push({
    title,
    observed: overrides.observed ?? detail,
    expected: overrides.expected ?? 'Expected ordinary-user authorization contract to hold.',
    impact: overrides.impact ?? 'Potential product authorization or self-service regression.',
    reproduction: overrides.reproduction,
    evidence: detail,
  });
}

function record(name, result, detail) {
  if (result === 'pass') evidence.counts.passed += 1;
  if (result === 'fail') evidence.counts.failed += 1;
  if (result === 'skip') evidence.counts.skipped += 1;
  evidence.steps.push({
    name,
    result,
    detail,
    at: new Date().toISOString(),
  });
}

async function writeEvidence() {
  await writeFile(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
}

function describeError(error) {
  if (error instanceof InfraBlockedError) return { type: 'infra-blocked', message: error.message };
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return error;
}

function containerSummary(c) {
  return {
    id: c.id,
    containerId: c.containerId,
    serverId: c.serverId,
    ownerId: c.spec?.ownerId,
    name: c.spec?.name,
    imageId: c.spec?.imageId,
    status: c.status,
    lifecycle: c.lifecycle,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class InfraBlockedError extends Error {}
