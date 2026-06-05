import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

type ApiResult<T = unknown> = {
  method: string;
  path: string;
  status: number;
  body: T;
};

type UserDto = {
  id: string;
  username: string;
  capabilities: string[];
};

type LoginResponse = {
  accessToken: string;
  user: UserDto;
};

type EffectiveAccess = {
  servers: Array<{
    serverId: string;
    cpuMillis: number;
    memBytes: number;
    diskBytes: number;
    gpuMode: string;
    gpuIndices: number[];
    allowedImageIds: string[];
  }>;
};

type SshKeyDto = {
  id: string;
  name: string;
  keyText: string;
  createdAt: string;
};

type ContainerDto = {
  id: string;
  containerId: string;
  serverId: string;
  status: string;
  spec: {
    name: string;
    ownerId: string;
    dockerId: string;
    sshServerEnabled: boolean;
  };
  sshServer?: {
    enabled: boolean;
    status: string;
    user: string;
    port: number;
    keyHash?: string;
    lastReconciledAt?: number;
  };
  lifecycle?: {
    dockerId: string | null;
    phase: string | null;
    stale: boolean;
  };
};

type UserQuota = {
  usedBytes: number;
  limitBytes: number;
};

type EvidenceEntry = {
  name: string;
  actor: string;
  method: string;
  path: string;
  status: number;
  expected: string;
  classification: 'pass' | 'fail-product' | 'blocked-infra';
  bodySummary?: unknown;
};

const sessionDir = '.codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z';
const evidencePath = `${sessionDir}/quota-ssh-lane-evidence.json`;
const apiBase = stripTrailingSlash(process.env.NYABASE_API_BASE ?? 'http://localhost:5173/api');
const runSuffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const runPrefix = `quota-ssh-${runSuffix}`;

const credentials = {
  admin: { username: 'admin', password: 'admin123' },
  alpha: {
    username: 'admintest-20260604t093408-alpha',
    password: 'admintest-20260604t093408-A1pass!',
  },
  beta: {
    username: 'admintest-20260604t093408-beta',
    password: 'admintest-20260604t093408-B2pass!',
  },
};

const handoff = {
  serverId: '5336594b-4f9a-4cef-b389-3ef9aa1eca78',
  imageId: '59f6b47d-5b38-41b6-aff9-12193a4eeae5',
};

const entries: EvidenceEntry[] = [];
const cleanup = {
  betaSshKeyDeleted: false,
  betaSshKeyId: null as string | null,
  betaBogusSshKeyDeleted: false,
  betaBogusSshKeyId: null as string | null,
};
const resources = {
  alphaUserId: '',
  betaUserId: '',
  serverId: '',
  imageId: '',
  betaInitialContainerIds: [] as string[],
  observedAdminSshContainers: [] as Array<{
    serverId: string;
    containerId: string;
    name: string;
    status: string;
    sshStatus: string;
  }>,
};

let adminToken = '';
let alphaToken = '';
let betaToken = '';
let alphaAccess: EffectiveAccess | null = null;
let betaAccess: EffectiveAccess | null = null;
let alphaGrant: EffectiveAccess['servers'][number] | null = null;
let betaGrant: EffectiveAccess['servers'][number] | null = null;

describe.sequential('quota and SSH black-box lane', () => {
  it('authenticates handoff users and verifies grant visibility', async () => {
    const admin = await login('admin', credentials.admin.username, credentials.admin.password);
    adminToken = admin.body.accessToken;
    expect(admin.status).toBe(200);
    expect(admin.body.user.capabilities).toEqual(expect.arrayContaining([
      'manage_users',
      'manage_groups',
      'manage_servers',
      'manage_images',
      'manage_grants',
      'manage_containers_any',
    ]));

    const alpha = await login('alpha', credentials.alpha.username, credentials.alpha.password);
    alphaToken = alpha.body.accessToken;
    resources.alphaUserId = alpha.body.user.id;
    expect(alpha.status).toBe(200);
    expect(alpha.body.user.capabilities).toEqual(expect.arrayContaining(['view_audit', 'view_metrics_all']));
    expect(alpha.body.user.capabilities).not.toContain('manage_users');

    const beta = await login('beta', credentials.beta.username, credentials.beta.password);
    betaToken = beta.body.accessToken;
    resources.betaUserId = beta.body.user.id;
    expect(beta.status).toBe(200);
    expect(beta.body.user.capabilities.filter((cap) => cap.startsWith('manage_'))).toEqual([]);

    const alphaMe = await request<UserDto>('GET', '/auth/me', alphaToken);
    record('alpha /auth/me includes handoff capabilities', 'alpha', alphaMe, '200 with view caps');
    expect(alphaMe.status).toBe(200);

    const betaMe = await request<UserDto>('GET', '/auth/me', betaToken);
    record('beta /auth/me has no management capabilities', 'beta', betaMe, '200 without management caps');
    expect(betaMe.status).toBe(200);

    alphaAccess = (await request<EffectiveAccess>('GET', '/me/access', alphaToken)).body;
    betaAccess = (await request<EffectiveAccess>('GET', '/me/access', betaToken)).body;
    record('alpha quota/image grant visibility', 'alpha', { method: 'GET', path: '/me/access', status: 200, body: alphaAccess }, '200 group grant visible', summarizeAccess(alphaAccess));
    record('beta quota/image grant visibility', 'beta', { method: 'GET', path: '/me/access', status: 200, body: betaAccess }, '200 direct grant visible', summarizeAccess(betaAccess));

    alphaGrant = findGrant(alphaAccess, handoff.serverId, handoff.imageId);
    betaGrant = findGrant(betaAccess, handoff.serverId, handoff.imageId);
    expect(alphaGrant, 'alpha handoff group grant must be visible in /me/access').toBeTruthy();
    expect(betaGrant, 'beta handoff direct grant must be visible in /me/access').toBeTruthy();
    expect(alphaGrant!.cpuMillis).toBe(250);
    expect(alphaGrant!.memBytes).toBe(134_217_728);
    expect(alphaGrant!.diskBytes).toBe(67_108_864);
    expect(betaGrant!.cpuMillis).toBe(500);
    expect(betaGrant!.memBytes).toBe(268_435_456);
    expect(betaGrant!.diskBytes).toBe(134_217_728);

    resources.serverId = betaGrant!.serverId;
    resources.imageId = handoff.imageId;

    const betaContainers = await request<ContainerDto[]>('GET', '/containers', betaToken);
    record('beta initial container list', 'beta', betaContainers, '200, used as no-create baseline', {
      count: Array.isArray(betaContainers.body) ? betaContainers.body.length : null,
    });
    expect(betaContainers.status).toBe(200);
    resources.betaInitialContainerIds = betaContainers.body.map((container) => container.containerId);
  });

  it('exercises beta SSH key CRUD and unauthorized alpha SSH-key paths', async () => {
    const keyName = `${runPrefix}-beta-key`;
    const keyText = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIQuotaSshLanePublicKeyOnly000000000000 ${keyName}@nyabase-test`;

    const beforeList = await request<SshKeyDto[]>('GET', `/users/${resources.betaUserId}/ssh-keys`, betaToken);
    record('beta SSH key list before add', 'beta', beforeList, '200');
    expect(beforeList.status).toBe(200);

    const add = await request<SshKeyDto>('POST', `/users/${resources.betaUserId}/ssh-keys`, betaToken, {
      name: keyName,
      keyText,
    });
    record('beta SSH key add self', 'beta', add, '201', {
      id: add.body?.id,
      name: add.body?.name,
    });
    expect(add.status).toBe(201);
    expect(add.body.id).toBeTruthy();
    cleanup.betaSshKeyId = add.body.id;

    const afterAddList = await request<SshKeyDto[]>('GET', `/users/${resources.betaUserId}/ssh-keys`, betaToken);
    record('beta SSH key list after add', 'beta', afterAddList, '200 includes created key', {
      count: afterAddList.body.length,
      containsCreatedKey: afterAddList.body.some((key) => key.id === cleanup.betaSshKeyId),
    });
    expect(afterAddList.status).toBe(200);
    expect(afterAddList.body.some((key) => key.id === cleanup.betaSshKeyId)).toBe(true);

    const deniedList = await request('GET', `/users/${resources.alphaUserId}/ssh-keys`, betaToken);
    record('beta cannot list alpha SSH keys', 'beta', deniedList, '403');
    expect(deniedList.status).toBe(403);

    const deniedAdd = await request('POST', `/users/${resources.alphaUserId}/ssh-keys`, betaToken, {
      name: `${runPrefix}-cross-add`,
      keyText,
    });
    record('beta cannot add alpha SSH key', 'beta', deniedAdd, '403');
    expect(deniedAdd.status).toBe(403);

    const deniedDelete = await request('DELETE', `/users/${resources.alphaUserId}/ssh-keys/00000000-0000-0000-0000-000000000001`, betaToken);
    record('beta cannot delete alpha SSH key', 'beta', deniedDelete, '403');
    expect(deniedDelete.status).toBe(403);

    const remove = await request('DELETE', `/users/${resources.betaUserId}/ssh-keys/${cleanup.betaSshKeyId}`, betaToken);
    record('beta SSH key delete self', 'beta', remove, '204');
    expect(remove.status).toBe(204);
    cleanup.betaSshKeyDeleted = true;
    cleanup.betaSshKeyId = null;

    const afterDeleteList = await request<SshKeyDto[]>('GET', `/users/${resources.betaUserId}/ssh-keys`, betaToken);
    record('beta SSH key list after delete', 'beta', afterDeleteList, '200 created key absent', {
      count: afterDeleteList.body.length,
    });
    expect(afterDeleteList.status).toBe(200);
    expect(afterDeleteList.body.some((key) => key.name === keyName)).toBe(false);
  });

  it('rejects invalid SSH key text for beta', async () => {
    const bogusKeyName = `${runPrefix}-bogus-key`;
    const bogusAdd = await request<SshKeyDto>('POST', `/users/${resources.betaUserId}/ssh-keys`, betaToken, {
      name: bogusKeyName,
      keyText: 'not-an-ssh-public-key',
    });
    record('beta invalid SSH key rejected', 'beta', bogusAdd, '400 invalid public key should be rejected', {
      acceptedKeyId: bogusAdd.status === 201 ? bogusAdd.body?.id : undefined,
      acceptedKeyText: bogusAdd.status === 201 ? bogusAdd.body?.keyText : undefined,
      message: summarizeError(bogusAdd.body),
    });
    if (bogusAdd.status === 201 && bogusAdd.body?.id) {
      cleanup.betaBogusSshKeyId = bogusAdd.body.id;

      const listWithBogus = await request<SshKeyDto[]>('GET', `/users/${resources.betaUserId}/ssh-keys`, betaToken);
      record('beta invalid SSH key persisted in list', 'beta', listWithBogus, 'should not be present after rejected add', {
        containsBogus: listWithBogus.status === 200
          ? listWithBogus.body.some((key) => key.id === cleanup.betaBogusSshKeyId && key.keyText === 'not-an-ssh-public-key')
          : null,
      });
    }
    expect(bogusAdd.status).toBe(400);
  });

  it('checks quota endpoint behavior and runtime observation shape', async () => {
    expect(betaAccess).toBeTruthy();
    expect(alphaAccess).toBeTruthy();
    expect(betaGrant).toBeTruthy();
    expect(alphaGrant).toBeTruthy();

    const betaQuota = await request<UserQuota>('GET', `/servers/${resources.serverId}/quota`, betaToken);
    record('beta user quota endpoint', 'beta', betaQuota, '200 with runtime usedBytes and grant limitBytes', betaQuota.body);
    expect(betaQuota.status).toBe(200);
    expect(typeof betaQuota.body.usedBytes).toBe('number');
    expect(betaQuota.body.limitBytes).toBe(betaGrant!.diskBytes);

    const alphaQuota = await request<UserQuota>('GET', `/servers/${resources.serverId}/quota`, alphaToken);
    record('alpha user quota endpoint', 'alpha', alphaQuota, '200 group grant disk limit visible', alphaQuota.body);
    expect(alphaQuota.status).toBe(200);
    expect(typeof alphaQuota.body.usedBytes).toBe('number');
    expect(alphaQuota.body.limitBytes).toBe(alphaGrant!.diskBytes);

    const disks = await request<Array<{ diskId: string; pquotaEnabled: boolean; usedBytes: number; totalBytes: number }>>('GET', `/servers/${resources.serverId}/disks`, betaToken);
    record('beta server disk runtime observation endpoint', 'beta', disks, '200; may be empty when agent/server has no disk observation', {
      count: Array.isArray(disks.body) ? disks.body.length : null,
      pquotaValues: Array.isArray(disks.body) ? disks.body.map((disk) => disk.pquotaEnabled) : null,
    });
    expect(disks.status).toBe(200);
    expect(Array.isArray(disks.body)).toBe(true);

    const fakeServerQuota = await request('GET', '/servers/00000000-0000-0000-0000-000000000099/quota', betaToken);
    record('beta cannot read quota for ungranted/fake server', 'beta', fakeServerQuota, '404');
    expect(fakeServerQuota.status).toBe(404);
  });

  it('rejects quota-overrun container creates before persistence', async () => {
    expect(betaGrant).toBeTruthy();
    const grant = betaGrant!;
    const cpuOverName = `${runPrefix}-cpu-over`;
    const memOverName = `${runPrefix}-mem-over`;

    const cpuOver = await request('POST', '/containers', betaToken, {
      serverId: resources.serverId,
      imageId: resources.imageId,
      name: cpuOverName,
      cpuMillis: grant.cpuMillis + 1,
      memBytes: 1,
      sshServerEnabled: true,
    });
    record('beta CPU quota overrun rejected', 'beta', cpuOver, '400 CPU quota exceeded', summarizeError(cpuOver.body));
    expect(cpuOver.status).toBe(400);
    expect(JSON.stringify(cpuOver.body).toLowerCase()).toContain('cpu');

    const memOver = await request('POST', '/containers', betaToken, {
      serverId: resources.serverId,
      imageId: resources.imageId,
      name: memOverName,
      cpuMillis: 1,
      memBytes: grant.memBytes + 1,
    });
    record('beta memory quota overrun rejected', 'beta', memOver, '400 Memory quota exceeded', summarizeError(memOver.body));
    expect(memOver.status).toBe(400);
    expect(JSON.stringify(memOver.body).toLowerCase()).toContain('memory');

    const afterDeniedCreates = await request<ContainerDto[]>('GET', '/containers', betaToken);
    record('beta container list unchanged after overrun denials', 'beta', afterDeniedCreates, '200 no lane-created containers', {
      count: afterDeniedCreates.body.length,
      laneNames: afterDeniedCreates.body
        .map((container) => container.spec.name)
        .filter((name) => name.startsWith(runPrefix)),
    });
    expect(afterDeniedCreates.status).toBe(200);
    expect(afterDeniedCreates.body.map((container) => container.containerId).sort()).toEqual(resources.betaInitialContainerIds.slice().sort());
    expect(afterDeniedCreates.body.some((container) => container.spec.name.startsWith(runPrefix))).toBe(false);
  });

  it('observes container SSH availability and denies beta access to another user container SSH controls', async () => {
    const adminContainers = await request<ContainerDto[]>('GET', '/containers', adminToken);
    record('admin container list for SSH availability observation', 'admin', adminContainers, '200', {
      count: Array.isArray(adminContainers.body) ? adminContainers.body.length : null,
    });
    expect(adminContainers.status).toBe(200);

    const sshContainers = adminContainers.body.filter((container) => container.spec.sshServerEnabled || container.sshServer?.enabled);
    resources.observedAdminSshContainers = sshContainers.map((container) => ({
      serverId: container.serverId,
      containerId: container.containerId,
      name: container.spec.name,
      status: container.status,
      sshStatus: container.sshServer?.status ?? 'missing',
    }));

    record('observed existing container SSH state', 'admin', adminContainers, 'read-only observation', {
      sshContainerCount: sshContainers.length,
      observed: resources.observedAdminSshContainers,
    });
    expect(sshContainers.length).toBeGreaterThan(0);
    expect(sshContainers.some((container) => container.sshServer?.status === 'running')).toBe(true);

    const target = sshContainers[0];
    const deniedEnable = await request('POST', `/containers/${target.serverId}/${target.containerId}/ssh/enable`, betaToken);
    record('beta cannot enable SSH on admin container', 'beta', deniedEnable, '403 or 404');
    expect([403, 404]).toContain(deniedEnable.status);

    const deniedReconcile = await request('POST', `/containers/${target.serverId}/${target.containerId}/ssh/reconcile`, betaToken);
    record('beta cannot reconcile SSH on admin container', 'beta', deniedReconcile, '403 or 404');
    expect([403, 404]).toContain(deniedReconcile.status);

    const betaOwnContainers = await request<ContainerDto[]>('GET', '/containers', betaToken);
    record('beta own container SSH enable availability', 'beta', betaOwnContainers, '200; no beta-owned container available in this environment', {
      count: betaOwnContainers.body.length,
      note: 'Granted server was offline during lane run, so safe under-quota container creation was not attempted.',
    });
    expect(betaOwnContainers.status).toBe(200);
    expect(betaOwnContainers.body.every((container) => !container.spec.name.startsWith(runPrefix))).toBe(true);
  });
});

afterAll(async () => {
  if (cleanup.betaSshKeyId && betaToken && resources.betaUserId) {
    const cleanupResult = await request('DELETE', `/users/${resources.betaUserId}/ssh-keys/${cleanup.betaSshKeyId}`, betaToken);
    cleanup.betaSshKeyDeleted = cleanupResult.status === 204 || cleanupResult.status === 404;
    record('afterAll beta SSH key cleanup', 'beta', cleanupResult, '204 or 404');
    cleanup.betaSshKeyId = null;
  }

  if (cleanup.betaBogusSshKeyId && betaToken && resources.betaUserId) {
    const cleanupResult = await request('DELETE', `/users/${resources.betaUserId}/ssh-keys/${cleanup.betaBogusSshKeyId}`, betaToken);
    cleanup.betaBogusSshKeyDeleted = cleanupResult.status === 204 || cleanupResult.status === 404;
    record('afterAll beta bogus SSH key cleanup', 'beta', cleanupResult, '204 or 404');
    cleanup.betaBogusSshKeyId = null;
  }

  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      runPrefix,
      apiBase,
      handoffUsers: {
        alpha: { username: credentials.alpha.username, userId: resources.alphaUserId },
        beta: { username: credentials.beta.username, userId: resources.betaUserId },
      },
      resources,
      cleanup,
      entries,
      notes: [
        'No product source was modified.',
        'No under-quota container was created because the handoff server was offline and successful create would persist desired state until an agent binds dockerId.',
        'The observed container SSH disable action is not exposed by the current API; enable and reconcile routes were covered for authorization.',
      ],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
});

async function login(actor: 'admin' | 'alpha' | 'beta', username: string, password: string): Promise<ApiResult<LoginResponse>> {
  const result = await request<LoginResponse>('POST', '/auth/login', undefined, { username, password });
  record(`${actor} login`, actor, result, '200', {
    userId: result.body?.user?.id,
    username: result.body?.user?.username,
    capabilities: result.body?.user?.capabilities,
  });
  return result;
}

async function request<T = unknown>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { method, path, status: response.status, body: parsed as T };
}

function record(
  name: string,
  actor: string,
  result: Pick<ApiResult, 'method' | 'path' | 'status' | 'body'>,
  expected: string,
  bodySummary?: unknown,
) {
  const isExpected = expectedStatusMatches(result.status, expected);
  entries.push({
    name,
    actor,
    method: result.method,
    path: result.path,
    status: result.status,
    expected,
    classification: isExpected ? 'pass' : 'fail-product',
    bodySummary,
  });
}

function expectedStatusMatches(status: number, expected: string): boolean {
  const explicit = expected.match(/\b(20\d|201|204|40\d|50\d)\b/g);
  if (!explicit) return true;
  return explicit.map(Number).includes(status);
}

function summarizeAccess(access: EffectiveAccess) {
  return {
    servers: access.servers.map((server) => ({
      serverId: server.serverId,
      cpuMillis: server.cpuMillis,
      memBytes: server.memBytes,
      diskBytes: server.diskBytes,
      gpuMode: server.gpuMode,
      gpuIndices: server.gpuIndices,
      allowedImageIds: server.allowedImageIds,
    })),
  };
}

function summarizeError(body: unknown) {
  if (body && typeof body === 'object') {
    const maybe = body as { message?: unknown; error?: unknown; statusCode?: unknown };
    return {
      statusCode: maybe.statusCode,
      message: maybe.message,
      error: maybe.error,
    };
  }
  return body;
}

function findGrant(access: EffectiveAccess, serverId: string, imageId: string) {
  return access.servers.find((server) => server.serverId === serverId && server.allowedImageIds.includes(imageId)) ?? null;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
