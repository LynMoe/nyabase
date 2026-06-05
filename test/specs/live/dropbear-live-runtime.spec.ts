import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

type ApiErrorBody = { message?: unknown; error?: unknown; statusCode?: unknown };

class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${path} failed with ${status}: ${JSON.stringify(body)}`);
  }
}

type LoginResponse = {
  accessToken: string;
  user: UserDto;
};

type UserDto = {
  id: string;
  username: string;
  capabilities: string[];
};

type ServerDto = {
  id: string;
  name: string;
  isGpuServer: boolean;
  status: string;
};

type ImageDto = {
  id: string;
  name: string;
  dockerImage: string;
  isActive: boolean;
};

type ImageServerStatus = {
  serverId: string;
  present: boolean;
  online: boolean;
  pulling?: { progress: number; message: string };
  error?: string;
};

type SshKeyDto = {
  id: string;
  name: string;
  createdAt: string;
};

type ContainerDto = {
  id: string;
  containerId?: string;
  serverId: string;
  serverName?: string;
  name: string;
  imageId: string;
  phase: string;
  powerIntent?: string;
  runtime: {
    runtimeId: string | null;
    status: string | null;
    ip?: string | null;
    stale?: boolean;
    observedAt?: string | null;
  };
  ssh: {
    enabled: boolean;
    status: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
    user?: 'root';
    port?: 22;
    pid?: number;
    keyHash?: string;
    lastReconciledAt?: number;
    lastError?: string;
  };
  // Optional legacy fields used only for normalization during cleanup of older
  // rows; live assertions below target the V2 ContainerView fields above.
  spec?: {
    containerId: string;
    ownerId: string;
    imageId: string;
    name: string;
    ip: string;
    sshServerEnabled: boolean;
  };
  status?: string;
  stats?: unknown | null;
  sshServer?: {
    enabled: boolean;
    status: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
    user: 'root';
    port: 22;
    pid?: number;
    keyHash?: string;
    lastReconciledAt?: number;
    lastError?: string;
  };
};

type EffectiveAccess = {
  servers: Array<{
    serverId: string;
    cpuMillis: number;
    memBytes: number;
    diskBytes: number;
    gpuMode: 'none' | 'indices' | 'all';
    gpuIndices: number[];
    allowedImageIds: string[];
  }>;
};

type ServerGrantDto = {
  serverId: string;
};

type ImageGrantDto = {
  imageId: string;
  serverId: string;
};

type Actor = {
  label: 'user-a' | 'user-b';
  token: string;
  user: UserDto;
};

type TestContainer = {
  name: string;
  serverId: string;
  containerId: string;
  purpose: string;
};

type OperationRef = { ok: true; operationId: string; status: string };

type SshKeyPair = {
  label: string;
  privatePath: string;
  publicPath: string;
  publicKey: string;
  fingerprint: string;
};

type Evidence = {
  step: string;
  actor?: string;
  method?: string;
  path?: string;
  status?: number;
  expected?: string;
  ids?: Record<string, string | number | boolean | null | undefined>;
  summary?: unknown;
};

type SshAttempt = {
  label: string;
  host: string;
  keyFingerprint?: string;
  exitCode: number;
  stdout: string;
  stderrSummary: string;
};

type DropbearKillResult = {
  output: string;
  targetCount: number;
  aliveAfterKillCount: number;
};

type DropbearKillObservation = {
  state: ContainerDto | null;
  reason: 'state-not-running' | 'login-failed' | 'state-unavailable' | 'inconclusive';
  loginAttempt?: SshAttempt;
};

type PriorRunCleanup = {
  prefix: string;
  scanned: {
    containers: number;
    users: number;
    images: number;
    grants: number;
    sshKeys: number;
  };
  removed: string[];
  residuals: {
    containers: string[];
    users: string[];
    images: string[];
    grants: string[];
    sshKeys: string[];
  };
};

type Report = {
  runPrefix: string;
  backendUrl: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  status: 'pass' | 'fail-product' | 'fail-test' | 'fail-infra';
  counts: { passed: number; failed: number; skipped: number };
  noRawSecretsRecorded: true;
  users: Record<string, { id: string; username: string; managementCapabilities: string[] }>;
  server?: { id: string; name: string; status: string };
  image?: { id: string; name: string; dockerImage: string };
  createdContainers: TestContainer[];
  deletedContainers: TestContainer[];
  sshKeys: Array<{ userId: string; keyId: string; name: string; fingerprint: string; action: 'added' | 'deleted' }>;
  denials: Evidence[];
  evidence: Evidence[];
  sshAttempts: SshAttempt[];
  cleanup: string[];
  priorPrefixCleanup: PriorRunCleanup[];
  residuals: { productContainers: string[]; note: string };
  failures: Array<{ test: string; cause: string; rootCause: 'product' | 'test' | 'infra'; evidence: string }>;
};

const STARTED_AT = new Date().toISOString();
const RUN_ID = process.env.NYABASE_DROPBEAR_LIVE_RUN_ID ?? timestampRunId();
const RUN_PREFIX = `dropbear-live-${RUN_ID}`;
const TEMP_DIR = process.env.NYABASE_DROPBEAR_LIVE_TMP ?? join('test/runtime/dropbear', RUN_ID);
const REPORT_JSON = join(TEMP_DIR, 'dropbear-live-report.redacted.json');
const REPORT_MD = join(TEMP_DIR, 'dropbear-live-report.redacted.md');
const KNOWN_HOSTS = join(TEMP_DIR, 'known_hosts');
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
const backendUrl = stripTrailingSlash(process.env.NYABASE_BACKEND_URL ?? process.env.BACKEND_URL ?? `http://localhost:${loadEnvValue('PORT') ?? '3001'}`);
const apiBase = `${backendUrl}/api`;
const adminUsername = process.env.ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.ADMIN_INIT_PASSWORD ?? loadEnvValue('ADMIN_INIT_PASSWORD');
const COMMAND = `pnpm exec vitest run test/specs/live/dropbear-live-runtime.spec.ts --reporter=verbose`;
const PRIOR_RUNS = [
  {
    prefix: 'dropbear-live-20260602t160927z-c22669',
    userIds: ['0dfebf03-66aa-4182-977b-668080eb48c1', '44af1e78-e914-4983-8d1e-ea7146b87365'],
    imageId: '9950bf71-5aa0-4337-bbca-618679cf3af4',
    containerContainerIds: ['9f7f9f6dbb48', '2b56245b7868'],
  },
  {
    prefix: 'dropbear-live-20260602t161114z-bd9158',
    userIds: ['53f97d7a-d5d6-4b35-ab2e-8f1e01e57549', '0f22909f-5c63-4dac-94f9-7d8a6eb28f6a'],
    imageId: 'f05ef3b3-ee00-45d1-bb0d-fb7887a78df2',
    containerContainerIds: ['62945d5bb73d', '70997b850735'],
  },
  {
    prefix: 'dropbear-live-20260602t162132z-ea21b7',
    userIds: ['5547d2a6-0e1e-4371-9684-ef163eb2bebf', 'e9801834-cacc-4c90-9a63-eaebf05d734e'],
    imageId: '727574b3-a0cf-4896-8e64-86559db3813c',
    containerContainerIds: ['63367205fac1', '7aebf3e44d8d'],
  },
  {
    prefix: 'dropbear-live-20260602t162314z-f69a37',
    userIds: ['36ae90c2-c569-42e8-b176-0bc9b53a4400', '495da993-e6e3-4ce5-aeaa-d6677b9a5695'],
    imageId: 'b31f420d-54e4-4006-aa19-f3211eb7bb30',
    containerContainerIds: ['33f96be9de42', '6ff43b1c4e72'],
  },
  {
    prefix: 'dropbear-live-20260602t162622z-f44369',
    userIds: ['36daf437-3b77-44fc-8025-816280b93c45', '0a78cb85-ab88-4b62-9f87-52048d6a4af8'],
    imageId: 'd5ab7594-cf01-4045-a1fc-aad8393c7161',
    containerContainerIds: ['f3ae7fafdfa6', 'a0f3e4a4040d'],
  },
  {
    prefix: 'dropbear-live-20260602t162921z-885616',
    userIds: ['c3f761e7-c509-4b28-bf9e-fbb6c51dc0fe', 'dfafbbfa-d5c3-49a4-b02d-48f6d28d49a1'],
    imageId: '93fee9dc-4079-4367-82fa-4f50c4f2e653',
    containerContainerIds: ['e6761e0a717c', '1a88c3e87f87'],
  },
];

if (!adminPassword) {
  throw new Error('ADMIN_INIT_PASSWORD must be set in test/config/local.env or process env');
}

const report: Report = {
  runPrefix: RUN_PREFIX,
  backendUrl,
  command: COMMAND,
  startedAt: STARTED_AT,
  finishedAt: '',
  status: 'pass',
  counts: { passed: 0, failed: 0, skipped: 0 },
  noRawSecretsRecorded: true,
  users: {},
  createdContainers: [],
  deletedContainers: [],
  sshKeys: [],
  denials: [],
  evidence: [],
  sshAttempts: [],
  cleanup: [],
  priorPrefixCleanup: [],
  residuals: {
    productContainers: [],
    note: 'CPU managed Docker exact-prefix residual scan was not run in tester lane; devops host-level verification remains a cleanup verification gap if required.',
  },
  failures: [],
};

describe('live Dropbear user-state runtime on CPU agent', () => {
  it('proves non-admin SSH enablement, isolation, repair, key sync, lifecycle, and cleanup', async () => {
    const createdContainers: TestContainer[] = [];
    const createdKeyIds: Array<{ actor: Actor; keyId: string; fingerprint: string; name: string }> = [];
    let adminToken: string | undefined;
    let userA: UserDto | undefined;
    let userB: UserDto | undefined;
    let image: ImageDto | undefined;
    let server: ServerDto | undefined;
    let userAPassword: string | undefined;
    let userBPassword: string | undefined;
    let bodyFailed = false;

    try {
      await mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
      await writeFile(KNOWN_HOSTS, '', { mode: 0o600 });

      const admin = await login(adminUsername, adminPassword);
      adminToken = admin.accessToken;
      expect(admin.user.capabilities).toEqual(expect.arrayContaining(Array.from(MANAGEMENT_CAPS)));
      await verifyAndCleanupPriorPrefixes(adminToken);

      server = await findOnlineCpuServer(adminToken);
      report.server = { id: server.id, name: server.name, status: server.status };

      image = await createImage(adminToken, RUN_PREFIX);
      await ensureImagePresent(adminToken, image.id, server.id);
      report.image = { id: image.id, name: image.name, dockerImage: image.dockerImage };

      userAPassword = strongPassword('a');
      userBPassword = strongPassword('b');
      userA = await createUser(adminToken, `${RUN_PREFIX}-a`, userAPassword, 'Dropbear Live A');
      userB = await createUser(adminToken, `${RUN_PREFIX}-b`, userBPassword, 'Dropbear Live B');
      await grantCpuImage(adminToken, userA.id, server.id, image.id);
      await grantCpuImage(adminToken, userB.id, server.id, image.id);

      const actorA = await loginActor('user-a', userA.username, userAPassword);
      const actorB = await loginActor('user-b', userB.username, userBPassword);
      expect(actorA.user.capabilities.filter((cap) => MANAGEMENT_CAPS.has(cap))).toEqual([]);
      expect(actorB.user.capabilities.filter((cap) => MANAGEMENT_CAPS.has(cap))).toEqual([]);
      await assertNoManagementCapabilities(adminToken, userA.id, userB.id, server.id, image.id);

      const key1 = await generateKeyPair('a-primary');
      const firstKey = await addUserKey(actorA, key1, 'primary');
      createdKeyIds.push({ actor: actorA, keyId: firstKey.id, fingerprint: key1.fingerprint, name: firstKey.name });

      const enabled = await createContainer(actorA, server.id, image.id, `${RUN_PREFIX}-enabled`, true, 'create-time SSH enabled');
      createdContainers.push(enabled);
      const enabledRunning = await waitForSshRunning(actorA, enabled, 'create-time enabled container');
      expect(enabledRunning.ssh).toMatchObject({ enabled: true, status: 'running', port: 22, user: 'root' });
      await assertSshMarker(key1, enabledRunning.runtime.ip, `enabled-${RUN_ID}`);
      await assertPasswordRejected(enabledRunning.runtime.ip, 'create-time enabled container');

      await verifyUserBDenials(actorB, actorA, enabled);
      await assertContainerRunning(actorA, enabled, 'after User B denial attempts');

      const disabled = await createContainer(actorA, server.id, image.id, `${RUN_PREFIX}-manual`, false, 'manual enable path');
      createdContainers.push(disabled);
      const conflict = await expectApiError(
        'POST',
        containerPath(disabled, '/actions/reconcile-ssh'),
        actorA.token,
        undefined,
        [409],
      );
      report.evidence.push({
        step: 'disabled container manual reconcile conflict',
        actor: actorA.label,
        method: 'POST',
        path: redactContainerPath(disabled, '/actions/reconcile-ssh'),
        status: conflict.status,
        expected: '409 Conflict without enabling SSH',
      });

      const enableResult = await api<OperationRef>(
        'POST',
        containerPath(disabled, '/actions/enable-ssh'),
        actorA.token,
      );
      await waitForOperationTerminal(actorA.token, enableResult.operationId);
      record('manual SSH enable', actorA, 'POST', redactContainerPath(disabled, '/actions/enable-ssh'), 201, {
        containerId: shortId(disabled.containerId),
        operationId: shortId(enableResult.operationId),
      });
      const manualRunning = await waitForSshRunning(actorA, disabled, 'manual enable container');
      await assertSshMarker(key1, manualRunning.runtime.ip, `manual-${RUN_ID}`);

      const killResult = await killDropbearWithConsole(actorA, disabled);
      const killedState = await waitForSshNotRunningOrLoginFail(actorA, disabled, key1);
      report.evidence.push({
        step: 'dropbear killed before manual repair',
        actor: actorA.label,
        path: redactContainerPath(disabled),
        ids: {
          containerId: shortId(disabled.containerId),
          killTargets: killResult.targetCount,
          killAliveAfter: killResult.aliveAfterKillCount,
          killObservation: killedState.reason,
          sshStatus: killedState.state?.ssh?.status,
          loginExit: killedState.loginAttempt?.exitCode,
        },
      });
      expect(killedState.reason, 'Dropbear kill must produce non-running API state, missing state, or failed SSH login').not.toBe('inconclusive');

      const reconcile = await api<OperationRef>(
        'POST',
        containerPath(disabled, '/actions/reconcile-ssh'),
        actorA.token,
      );
      await waitForOperationTerminal(actorA.token, reconcile.operationId);
      record('manual Dropbear repair reconcile', actorA, 'POST', redactContainerPath(disabled, '/actions/reconcile-ssh'), 201, {
        containerId: shortId(disabled.containerId),
        operationId: shortId(reconcile.operationId),
      });
      const repaired = await waitForSshRunning(actorA, disabled, 'manual repair container');
      await assertSshMarker(key1, repaired.runtime.ip, `repair-${RUN_ID}`);
      if (killedState.state === null) {
        report.evidence.push({
          step: 'null kill observation accepted after manual reconcile and SSH login',
          actor: actorA.label,
          path: redactContainerPath(disabled),
          ids: {
            containerId: shortId(disabled.containerId),
            operationId: shortId(reconcile.operationId),
            repairLoginVerified: true,
          },
        });
      }

      const key2 = await generateKeyPair('a-secondary');
      const secondKey = await addUserKey(actorA, key2, 'secondary');
      createdKeyIds.push({ actor: actorA, keyId: secondKey.id, fingerprint: key2.fingerprint, name: secondKey.name });
      await waitForSshLoginSuccess(key2, repaired.runtime.ip, `second-key-${RUN_ID}`);

      await deleteUserKey(actorA, firstKey.id, key1.fingerprint, firstKey.name);
      removeCreatedKey(createdKeyIds, firstKey.id);
      await waitForSshLoginRejected(key1, repaired.runtime.ip, 'first key after delete');
      await waitForSshLoginSuccess(key2, repaired.runtime.ip, `second-key-after-delete-${RUN_ID}`);

      const restart = await api<OperationRef>('POST', containerPath(disabled, '/actions/restart'), actorA.token);
      await waitForOperationTerminal(actorA.token, restart.operationId);
      record('restart SSH-enabled container', actorA, 'POST', redactContainerPath(disabled, '/actions/restart'), 201, {
        containerId: shortId(disabled.containerId),
        operationId: shortId(restart.operationId),
      });
      const restarted = await waitForSshRunning(actorA, disabled, 'restart lifecycle');
      await waitForSshLoginSuccess(key2, restarted.runtime.ip, `restart-${RUN_ID}`);

      for (const container of [...createdContainers].reverse()) {
        await removeContainerViaOperationViaOperation(actorA, container);
        removeCreatedContainer(createdContainers, container.containerId);
      }

      await deleteUserKey(actorA, secondKey.id, key2.fingerprint, secondKey.name);
      removeCreatedKey(createdKeyIds, secondKey.id);

      await assertProductResiduals(actorA);
      report.counts.passed = 1;
    } catch (error) {
      bodyFailed = true;
      report.counts.failed = 1;
      report.status = classifyFailure(error);
      report.failures.push({
        test: 'live Dropbear user-state runtime on CPU agent',
        cause: describeError(error),
        rootCause: report.status === 'fail-infra' ? 'infra' : report.status === 'fail-test' ? 'test' : 'product',
        evidence: REPORT_MD,
      });
      throw error;
    } finally {
      await cleanupBestEffort({
        adminToken,
        userA,
        userB,
        image,
        userAPassword,
        createdContainers,
        createdKeyIds,
      });
      await removeTempSecrets();
      const cleanupFailedAfterPassingBody = !bodyFailed && report.status !== 'pass';
      if (cleanupFailedAfterPassingBody) {
        report.counts.passed = 0;
        report.counts.failed = 1;
      }
      await writeReports();
      if (cleanupFailedAfterPassingBody) {
        throw new Error(`cleanup failed; see ${REPORT_MD}`);
      }
    }
  }, 720_000);
});

async function loginActor(label: Actor['label'], username: string, password: string): Promise<Actor> {
  const loginResult = await login(username, password);
  const actor = { label, token: loginResult.accessToken, user: loginResult.user };
  report.users[label] = {
    id: loginResult.user.id,
    username: loginResult.user.username,
    managementCapabilities: loginResult.user.capabilities.filter((cap) => MANAGEMENT_CAPS.has(cap)),
  };
  return actor;
}

async function login(username: string, password: string): Promise<LoginResponse> {
  return api<LoginResponse>('POST', '/auth/login', undefined, { username, password });
}

async function findOnlineCpuServer(token: string): Promise<ServerDto> {
  const servers = await api<ServerDto[]>('GET', '/admin/servers', token);
  const preferred = process.env.NYABASE_DROPBEAR_CPU_SERVER_ID;
  const server = preferred
    ? servers.find((item) => item.id === preferred && item.status === 'online' && !item.isGpuServer)
    : servers.find((item) => item.status === 'online' && !item.isGpuServer);
  expect(server, 'expected an online CPU server from GET /api/admin/servers').toBeTruthy();
  record('selected CPU server', undefined, 'GET', '/admin/servers', 200, {
    serverId: server!.id,
    name: server!.name,
  });
  return server!;
}

async function createImage(token: string, runPrefix: string): Promise<ImageDto> {
  const image = await api<ImageDto>('POST', '/admin/images', token, {
    name: `${runPrefix}-ubuntu-2404`,
    dockerImage: 'ubuntu:24.04',
    defaultUid: 0,
    runtimeOverrides: {
      uid: 0,
      entrypoint: null,
      cmd: ['sleep', 'infinity'],
      init: true,
    },
    description: `${runPrefix} disposable Dropbear live runtime image`,
  });
  record('create active ubuntu image row', undefined, 'POST', '/admin/images', 201, {
    imageId: image.id,
    name: image.name,
    dockerImage: image.dockerImage,
  });
  return image;
}

async function ensureImagePresent(token: string, imageId: string, serverId: string) {
  const before = await api<ImageServerStatus[]>('GET', `/admin/images/${imageId}/status`, token);
  const beforeStatus = before.find((item) => item.serverId === serverId);
  if (!beforeStatus?.present) {
    const pull = await api<{ started: string[]; skipped: string[] }>('POST', `/admin/images/${imageId}/pull`, token, {
      serverIds: [serverId],
    });
    record('admin image pull if absent', undefined, 'POST', `/admin/images/${imageId}/pull`, 201, {
      imageId,
      serverId,
      started: pull.started.includes(serverId),
      skipped: pull.skipped.includes(serverId),
    });
  } else {
    record('image already present on CPU server', undefined, 'GET', `/admin/images/${imageId}/status`, 200, {
      imageId,
      serverId,
    });
  }

  const present = await poll(async () => {
    const statuses = await api<ImageServerStatus[]>('GET', `/admin/images/${imageId}/status`, token);
    const status = statuses.find((item) => item.serverId === serverId);
    if (status?.error) throw new Error(`image pull failed on ${serverId}: ${status.error}`);
    return status?.present ? status : null;
  }, 240_000, 2_000);
  expect(present?.present).toBe(true);
}

async function createUser(token: string, username: string, password: string, displayName: string): Promise<UserDto> {
  const user = await api<UserDto>('POST', '/admin/users', token, { username, password, displayName });
  record('create disposable non-admin user', undefined, 'POST', '/admin/users', 201, {
    userId: user.id,
    username: user.username,
    managementCapabilities: user.capabilities.filter((cap) => MANAGEMENT_CAPS.has(cap)),
  });
  return user;
}

async function grantCpuImage(token: string, userId: string, serverId: string, imageId: string) {
  await api('POST', `/admin/users/${userId}/server-grants/${serverId}`, token, {
    cpuMillis: 1000,
    memBytes: 512 * MI_B,
    diskBytes: 128 * MI_B,
    gpuMode: 'none',
    gpuIndices: [],
  });
  await api('POST', `/admin/users/${userId}/image-grants`, token, { imageId, serverId });
  record('grant CPU server and active image', undefined, 'POST', `/admin/users/${userId}/server-grants/${serverId} + image-grants`, 201, {
    userId,
    serverId,
    imageId,
  });
}

async function assertNoManagementCapabilities(
  adminToken: string,
  userAId: string,
  userBId: string,
  serverId: string,
  imageId: string,
) {
  for (const userId of [userAId, userBId]) {
    const access = await api<EffectiveAccess>('GET', `/admin/users/${userId}/effective-access`, adminToken);
    expect(access.servers).toHaveLength(1);
    expect(access.servers[0]).toMatchObject({
      serverId,
      cpuMillis: 1000,
      memBytes: 512 * MI_B,
      diskBytes: 128 * MI_B,
      gpuMode: 'none',
      gpuIndices: [],
    });
    expect(access.servers[0].allowedImageIds).toEqual([imageId]);
  }
  report.evidence.push({
    step: 'fixture setup effective access verified',
    ids: { userAId, userBId, serverId, imageId },
    expected: 'exactly one CPU server grant and one active ubuntu image grant per user; no management capabilities',
  });
}

async function generateKeyPair(label: string): Promise<SshKeyPair> {
  const privatePath = join(TEMP_DIR, `${label}.ed25519`);
  const publicPath = `${privatePath}.pub`;
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${RUN_PREFIX}-${label}`, '-f', privatePath], {
    timeout: 20_000,
  });
  const publicKey = (await readFile(publicPath, 'utf8')).trim();
  const fingerprint = await sshFingerprint(publicPath);
  return { label, privatePath, publicPath, publicKey, fingerprint };
}

async function sshFingerprint(publicPath: string): Promise<string> {
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', publicPath, '-E', 'sha256'], { timeout: 20_000 });
  const parts = stdout.trim().split(/\s+/);
  return parts[1] ?? sha256(stdout).slice(0, 16);
}

async function addUserKey(actor: Actor, key: SshKeyPair, suffix: string): Promise<SshKeyDto> {
  const created = await api<SshKeyDto>('POST', `/users/${actor.user.id}/ssh-keys`, actor.token, {
    name: `${RUN_PREFIX}-${suffix}`,
    keyText: key.publicKey,
  });
  report.sshKeys.push({
    userId: actor.user.id,
    keyId: created.id,
    name: created.name,
    fingerprint: key.fingerprint,
    action: 'added',
  });
  record('user adds own SSH public key', actor, 'POST', `/users/${actor.user.id}/ssh-keys`, 201, {
    keyId: created.id,
    keyName: created.name,
    fingerprint: key.fingerprint,
  });
  return created;
}

async function deleteUserKey(actor: Actor, keyId: string, fingerprint: string, name: string) {
  await api('DELETE', `/users/${actor.user.id}/ssh-keys/${keyId}`, actor.token);
  report.sshKeys.push({ userId: actor.user.id, keyId, name, fingerprint, action: 'deleted' });
  record('user deletes own SSH public key', actor, 'DELETE', `/users/${actor.user.id}/ssh-keys/${keyId}`, 204, {
    keyId,
    fingerprint,
  });
}

async function createContainer(
  actor: Actor,
  serverId: string,
  imageId: string,
  name: string,
  sshServerEnabled: boolean,
  purpose: string,
): Promise<TestContainer> {
  const createResult = await api<OperationRef>('POST', '/v2/containers', actor.token, {
    serverId,
    imageId,
    name,
    cpuMillis: 250,
    memBytes: 128 * MI_B,
    sshServerEnabled,
  });
  await waitForOperationTerminal(actor.token, createResult.operationId);
  record(`create ${purpose} container`, actor, 'POST', '/v2/containers', 201, {
    name,
    serverId,
    imageId,
    sshServerEnabled,
    operationId: shortId(createResult.operationId),
  });

  const found = await poll(async () => {
    const containers = await listOwnContainers(actor);
    return containers.find((item) => item.name === name) ?? null;
  }, 90_000, 1_000);
  expect(found, `expected container ${name} to appear in owner list`).toBeTruthy();

  const container = { name, serverId, containerId: canonicalContainerId(found!), purpose };
  report.createdContainers.push(container);
  return container;
}

async function listOwnContainers(actor: Actor): Promise<ContainerDto[]> {
  return api<ContainerDto[]>('GET', '/v2/containers', actor.token);
}

async function waitForSshRunning(actor: Actor, container: TestContainer, label: string): Promise<ContainerDto> {
  let last: ContainerDto | null = null;
  const detail = await poll(async () => {
    const current = await api<ContainerDto>('GET', containerPath(container), actor.token);
    last = current;
    if (
      current.runtime.status === 'running'
      && current.ssh.enabled === true
      && current.ssh.status === 'running'
      && current.ssh.port === 22
      && current.runtime.ip
    ) {
      return current;
    }
    return null;
  }, 120_000, 1_500);
  if (!detail) {
    report.evidence.push({
      step: `timeout waiting for Dropbear running: ${label}`,
      actor: actor.label,
      method: 'GET',
      path: redactContainerPath(container),
      status: 200,
      ids: {
        containerId: shortId(container.containerId),
        runtimeStatus: last?.runtime.status ?? null,
        runtimeIpPresent: Boolean(last?.runtime.ip),
        runtimeStale: last?.runtime.stale ?? null,
        sshEnabled: last?.ssh.enabled ?? null,
        sshStatus: last?.ssh.status ?? null,
        sshPort: last?.ssh.port ?? null,
      },
    });
  }
  expect(detail, `expected SSH running state for ${label}; last=${JSON.stringify({
    runtimeStatus: last?.runtime.status ?? null,
    runtimeIpPresent: Boolean(last?.runtime.ip),
    runtimeStale: last?.runtime.stale ?? null,
    sshEnabled: last?.ssh.enabled ?? null,
    sshStatus: last?.ssh.status ?? null,
    sshPort: last?.ssh.port ?? null,
  })}`).toBeTruthy();
  record(`wait for Dropbear running: ${label}`, actor, 'GET', redactContainerPath(container), 200, {
    containerId: shortId(container.containerId),
    ip: detail!.runtime.ip,
    sshStatus: detail!.ssh.status,
    port: detail!.ssh.port,
    pidPresent: Boolean(detail!.ssh.pid),
  });
  return detail!;
}

async function assertContainerRunning(actor: Actor, container: TestContainer, label: string) {
  const detail = await api<ContainerDto>('GET', containerPath(container), actor.token);
  expect(detail.runtime.status).toBe('running');
  expect(detail.ssh.status).toBe('running');
  record(`container remains running ${label}`, actor, 'GET', redactContainerPath(container), 200, {
    containerId: shortId(container.containerId),
    status: detail.runtime.status,
    sshStatus: detail.ssh.status,
  });
}

async function assertSshMarker(key: SshKeyPair, host: string, marker: string) {
  await waitForSshLoginSuccess(key, host, marker);
}

async function waitForSshLoginSuccess(key: SshKeyPair, host: string, marker: string) {
  const attempt = await poll(async () => {
    const result = await sshAttempt(key.privatePath, host, `printf '%s\\n' ${shellQuote(marker)}`, key.fingerprint);
    return result.exitCode === 0 && result.stdout.includes(marker) ? result : null;
  }, 60_000, 2_000);
  expect(attempt, `expected SSH key login success for ${key.label} to ${host}`).toBeTruthy();
  report.sshAttempts.push(attempt!);
}

async function waitForSshLoginRejected(key: SshKeyPair, host: string, label: string) {
  const attempt = await poll(async () => {
    const result = await sshAttempt(key.privatePath, host, 'true', key.fingerprint);
    return result.exitCode !== 0 ? result : null;
  }, 60_000, 2_000);
  expect(attempt, `expected SSH key login rejection for ${label}`).toBeTruthy();
  report.sshAttempts.push({ ...attempt!, label: `rejected ${label}` });
}

async function assertPasswordRejected(host: string, label: string) {
  const result = await passwordOnlySshAttempt(host);
  report.sshAttempts.push({ ...result, label: `password rejected ${label}` });
  expect(result.exitCode, `expected no-key BatchMode SSH to fail for ${label}`).not.toBe(0);
}

async function passwordOnlySshAttempt(host: string): Promise<SshAttempt> {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'PubkeyAuthentication=no',
    '-o',
    'PasswordAuthentication=yes',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'PreferredAuthentications=password',
    `root@${host}`,
    'true',
  ];
  try {
    const { stdout, stderr } = await execFileAsync('ssh', args, { timeout: 15_000 });
    return {
      label: 'password-only-batch-reject',
      host,
      exitCode: 0,
      stdout: stdout.trim(),
      stderrSummary: summarizeStderr(stderr),
    };
  } catch (error) {
    const err = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      label: 'password-only-batch-reject',
      host,
      exitCode: typeof err.code === 'number' ? err.code : 255,
      stdout: (err.stdout ?? '').trim(),
      stderrSummary: summarizeStderr(err.stderr ?? err.message),
    };
  }
}

async function sshAttempt(
  privateKeyPath: string | undefined,
  host: string,
  command: string,
  keyFingerprint?: string,
  label = 'ssh',
): Promise<SshAttempt> {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    `IdentityFile=${privateKeyPath ?? '/dev/null'}`,
    `root@${host}`,
    command,
  ];
  try {
    const { stdout, stderr } = await execFileAsync('ssh', args, { timeout: 15_000 });
    return {
      label,
      host,
      keyFingerprint,
      exitCode: 0,
      stdout: stdout.trim(),
      stderrSummary: summarizeStderr(stderr),
    };
  } catch (error) {
    const err = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      label,
      host,
      keyFingerprint,
      exitCode: typeof err.code === 'number' ? err.code : 255,
      stdout: (err.stdout ?? '').trim(),
      stderrSummary: summarizeStderr(err.stderr ?? err.message),
    };
  }
}

async function verifyUserBDenials(actorB: Actor, actorA: Actor, container: TestContainer) {
  const denialOps: Array<{ method: string; suffix: string; body?: unknown; allowed: number[] }> = [
    { method: 'GET', suffix: '', allowed: [403, 404] },
    { method: 'GET', suffix: '/stats', allowed: [403, 404] },
    { method: 'POST', suffix: '/actions/start', allowed: [403, 404] },
    { method: 'POST', suffix: '/actions/stop', allowed: [403, 404] },
    { method: 'POST', suffix: '/actions/restart', allowed: [403, 404] },
    { method: 'DELETE', suffix: '', allowed: [403, 404] },
    { method: 'POST', suffix: '/actions/enable-ssh', allowed: [403, 404] },
    { method: 'POST', suffix: '/actions/reconcile-ssh', allowed: [403, 404] },
  ];

  for (const op of denialOps) {
    const error = await expectApiError(op.method, containerPath(container, op.suffix), actorB.token, op.body, op.allowed);
    const evidence = {
      step: `User B denied ${op.method} ${op.suffix || 'detail/delete'}`,
      actor: actorB.label,
      method: op.method,
      path: redactContainerPath(container, op.suffix),
      status: error.status,
      expected: '403/404 class denial for User A container',
      ids: { userAId: actorA.user.id, userBId: actorB.user.id, containerId: shortId(container.containerId) },
    };
    report.denials.push(evidence);
  }
}

async function killDropbearWithConsole(actor: Actor, container: TestContainer): Promise<DropbearKillResult> {
  const output = await execViaConsole(actor, container, [
    'stty -echo 2>/dev/null || true',
    'is_dropbear_comm() { case "$1" in dropbear|nyabase-dropbea|nyabase-dropbear|*dropbear*) return 0 ;; *) return 1 ;; esac; }',
    'add_target() { case "$1" in ""|*[!0-9]*) return ;; esac; case " $targets " in *" $1 "*) ;; *) targets="$targets $1" ;; esac; }',
    'targets=""',
    'pid="$(cat /run/nyabase-dropbear.pid 2>/dev/null || true)"',
    'case "$pid" in',
    '  ""|*[!0-9]*) ;;',
    '  *)',
    '    comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"',
    '    if is_dropbear_comm "$comm"; then add_target "$pid"; fi',
    '  ;;',
    'esac',
    'for f in /proc/[0-9]*/comm; do',
    '  comm="$(cat "$f" 2>/dev/null || true)"',
    '  if is_dropbear_comm "$comm"; then',
    '    p="${f#/proc/}"; p="${p%/comm}"',
    '    add_target "$p"',
    '  fi',
    'done',
    'count=0; for p in $targets; do count=$((count + 1)); kill "$p" 2>/dev/null || true; done',
    'sleep 1',
    'for p in $targets; do kill -9 "$p" 2>/dev/null || true; done',
    'sleep 1',
    'alive=0; for p in $targets; do if kill -0 "$p" 2>/dev/null; then alive=$((alive + 1)); fi; done',
    'printf "NYABASE_DROPBEAR_KILL_RESULT targets=%s alive=%s\\n" "$count" "$alive"',
    'if [ "$count" -gt 0 ]; then printf "NYABASE_DROPBEAR_KILL_STATE attempted\\n"; else printf "NYABASE_DROPBEAR_KILL_STATE no-target\\n"; fi',
  ].join('\n'));
  const killSummary = parseDropbearKillSummary(output);
  const targetCount = killSummary?.targetCount ?? 0;
  const aliveAfterKillCount = killSummary?.aliveAfterKillCount ?? 0;
  expect(targetCount, `Dropbear kill command did not target a process; output=${sanitizeConsole(output)}`).toBeGreaterThan(0);
  expect(output).toContain('NYABASE_DROPBEAR_KILL_STATE attempted');
  record('kill Dropbear through product console exec', actor, 'POST+/ws/console', redactContainerPath(container, '/exec-sessions'), 200, {
    containerId: shortId(container.containerId),
    targetCount,
    aliveAfterKillCount,
    output: sanitizeConsole(output),
  });
  return { output, targetCount, aliveAfterKillCount };
}

async function execViaConsole(actor: Actor, container: TestContainer, script: string): Promise<string> {
  if (typeof WebSocket !== 'function') {
    throw new Error('Node WebSocket implementation unavailable');
  }
  const exec = await api<{ sessionId: string }>('POST', containerPath(container, '/exec-sessions'), actor.token, {
    shell: 'sh',
    tty: true,
    cols: 100,
    rows: 24,
  });
  const wsUrl = `${backendUrl.replace(/^http/, 'ws')}/ws/console?sessionId=${encodeURIComponent(exec.sessionId)}`;
  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore close errors during timeout
      }
      reject(new Error(`console websocket timed out; output=${sanitizeConsole(chunks.join(''))}`));
    }, 30_000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: actor.token }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'input', data: `${script}\nexit\n` }));
      }, 250);
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string; exitCode?: number };
      if (message.type === 'data' && message.data) chunks.push(decodeConsoleData(message.data));
      if (message.type === 'eof') {
        clearTimeout(timeout);
        resolve(chunks.join(''));
      }
    });
    ws.addEventListener('close', () => {
      const output = chunks.join('');
      if (output.includes('NYABASE_DROPBEAR_KILL_RESULT')) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('console websocket error'));
    });
  });
}

async function waitForSshNotRunningOrLoginFail(
  actor: Actor,
  container: TestContainer,
  key: SshKeyPair,
): Promise<DropbearKillObservation> {
  return poll(async () => {
    const state = await getContainerStateOrNull(actor, container);
    if (!state) return { state, reason: 'state-unavailable' };
    if (state.ssh.status !== 'running') return { state, reason: 'state-not-running' };
    const loginAttempt = await sshAttempt(key.privatePath, state.runtime.ip, 'true', key.fingerprint, 'after-dropbear-kill');
    if (loginAttempt.exitCode !== 0) return { state, reason: 'login-failed', loginAttempt };
    return null;
  }, 45_000, 2_000).then((observed) => observed ?? {
    state: null,
    reason: 'inconclusive',
  });
}

async function getContainerStateOrNull(actor: Actor, container: TestContainer): Promise<ContainerDto | null> {
  try {
    return await api<ContainerDto>('GET', containerPath(container), actor.token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function removeContainerViaOperationViaOperation(actor: Actor, container: TestContainer) {
  const operation = await requestContainerDeleteOperation(actor.token, container.containerId);
  await waitForOperationTerminal(actor.token, operation.operationId);
  report.deletedContainers.push(container);
  record(`delete ${container.purpose} container via V2 operation`, actor, 'POST', `/v2/containers/${shortId(container.containerId)}/actions/delete`, 201, {
    containerId: shortId(container.containerId),
    name: container.name,
    operationId: shortId(operation.operationId),
  });
  await poll(async () => {
    const containers = await listOwnContainers(actor);
    return containers.some((item) => canonicalContainerId(item) === container.containerId) ? null : true;
  }, 60_000, 1_000);
}

async function requestContainerDeleteOperation(token: string, containerId: string) {
  return api<{ ok: true; operationId: string; status: string }>('POST', `/v2/containers/${containerId}/actions/delete`, token);
}

async function waitForOperationTerminal(token: string, operationId: string) {
  const terminal = new Set(['succeeded', 'failed', 'cancelled']);
  const operation = await poll(async () => {
    const current = await api<{ id: string; status: string; lastError: string | null }>('GET', `/operations/${operationId}`, token);
    return terminal.has(current.status) ? current : null;
  }, 120_000, 1_000);
  expect(operation, `operation ${operationId} reached terminal state`).toBeTruthy();
  expect(operation!.status, `operation ${operationId} failed: ${operation!.lastError ?? ''}`).toBe('succeeded');
  return operation!;
}

async function assertProductResiduals(actor: Actor) {
  const containers = await listOwnContainers(actor);
  const residuals = containers.filter((item) => item.name.startsWith(RUN_PREFIX));
  report.residuals.productContainers = residuals.map((item) => `${item.name}:${shortId(canonicalContainerId(item))}`);
  record('exact-prefix product residual scan', actor, 'GET', '/v2/containers', 200, {
    runPrefix: RUN_PREFIX,
    residualContainers: report.residuals.productContainers,
  });
  expect(residuals).toEqual([]);
}

async function verifyAndCleanupPriorPrefixes(adminToken: string) {
  for (const prior of PRIOR_RUNS) {
    const summary: PriorRunCleanup = {
      prefix: prior.prefix,
      scanned: { containers: 0, users: 0, images: 0, grants: 0, sshKeys: 0 },
      removed: [],
      residuals: { containers: [], users: [], images: [], grants: [], sshKeys: [] },
    };

    const [containers, users, images] = await Promise.all([
      api<ContainerDto[]>('GET', '/admin/v2/containers', adminToken),
      api<UserDto[]>('GET', '/admin/users', adminToken),
      api<ImageDto[]>('GET', '/admin/images', adminToken),
    ]);

    const priorContainers = containers.filter((item) =>
      item.name.startsWith(prior.prefix)
      || prior.containerContainerIds.includes(shortId(canonicalContainerId(item)))
      || prior.containerContainerIds.includes(canonicalContainerId(item)));
    const priorUsers = users.filter((item) =>
      item.username.startsWith(prior.prefix)
      || prior.userIds.includes(item.id));
    const priorImages = images.filter((item) =>
      item.name.startsWith(prior.prefix)
      || item.id === prior.imageId);

    summary.scanned.containers = priorContainers.length;
    summary.scanned.users = priorUsers.length;
    summary.scanned.images = priorImages.length;

    for (const user of priorUsers) {
      const [sshKeys, serverGrants, imageGrants] = await Promise.all([
        api<SshKeyDto[]>('GET', `/admin/users/${user.id}/ssh-keys`, adminToken),
        api<ServerGrantDto[]>('GET', `/admin/users/${user.id}/server-grants`, adminToken),
        api<ImageGrantDto[]>('GET', `/admin/users/${user.id}/image-grants`, adminToken),
      ]);
      const matchingKeys = sshKeys.filter((key) => key.name.startsWith(prior.prefix));
      const matchingServerGrants = serverGrants;
      const matchingImageGrants = imageGrants.filter((grant) =>
        grant.imageId === prior.imageId
        || priorImages.some((image) => image.id === grant.imageId));

      summary.scanned.sshKeys += matchingKeys.length;
      summary.scanned.grants += matchingServerGrants.length + matchingImageGrants.length;

      for (const key of matchingKeys) {
        await cleanupPrior(summary, `ssh-key ${user.id}/${key.id}`, () =>
          api('DELETE', `/admin/users/${user.id}/ssh-keys/${key.id}`, adminToken));
      }
      for (const grant of matchingImageGrants) {
        await cleanupPrior(summary, `image-grant ${user.id}/${grant.imageId}/${grant.serverId}`, () =>
          api('DELETE', `/admin/users/${user.id}/image-grants/${grant.imageId}/${grant.serverId}`, adminToken));
      }
      for (const grant of matchingServerGrants) {
        await cleanupPrior(summary, `server-grant ${user.id}/${grant.serverId}`, () =>
          api('DELETE', `/admin/users/${user.id}/server-grants/${grant.serverId}`, adminToken));
      }
    }

    for (const container of priorContainers) {
      await cleanupPrior(summary, `container ${container.name}:${shortId(canonicalContainerId(container))}`, () =>
        api('POST', `${containerPathFromIds(container.serverId, canonicalContainerId(container))}/actions/delete`, adminToken));
    }
    for (const image of priorImages) {
      await cleanupPrior(summary, `image ${image.name}:${image.id}`, () =>
        api('DELETE', `/admin/images/${image.id}`, adminToken));
    }
    for (const user of priorUsers) {
      await cleanupPrior(summary, `user ${user.username}:${user.id}`, () =>
        api('DELETE', `/admin/users/${user.id}`, adminToken));
    }

    const [afterContainers, afterUsers, afterImages] = await Promise.all([
      api<ContainerDto[]>('GET', '/admin/v2/containers', adminToken),
      api<UserDto[]>('GET', '/admin/users', adminToken),
      api<ImageDto[]>('GET', '/admin/images', adminToken),
    ]);
    summary.residuals.containers = afterContainers
      .filter((item) => item.name.startsWith(prior.prefix) || prior.containerContainerIds.includes(shortId(canonicalContainerId(item))))
      .map((item) => `${item.name}:${shortId(canonicalContainerId(item))}`);
    const residualUsers = afterUsers.filter((item) => item.username.startsWith(prior.prefix) || prior.userIds.includes(item.id));
    summary.residuals.users = residualUsers.map((item) => `${item.username}:${item.id}`);
    summary.residuals.images = afterImages
      .filter((item) => item.name.startsWith(prior.prefix) || item.id === prior.imageId)
      .map((item) => `${item.name}:${item.id}`);

    for (const user of residualUsers) {
      const [sshKeys, serverGrants, imageGrants] = await Promise.all([
        api<SshKeyDto[]>('GET', `/admin/users/${user.id}/ssh-keys`, adminToken),
        api<ServerGrantDto[]>('GET', `/admin/users/${user.id}/server-grants`, adminToken),
        api<ImageGrantDto[]>('GET', `/admin/users/${user.id}/image-grants`, adminToken),
      ]);
      summary.residuals.sshKeys.push(...sshKeys
        .filter((key) => key.name.startsWith(prior.prefix))
        .map((key) => `${user.id}/${key.id}`));
      summary.residuals.grants.push(...serverGrants.map((grant) => `${user.id}/server/${grant.serverId}`));
      summary.residuals.grants.push(...imageGrants
        .filter((grant) => grant.imageId === prior.imageId || priorImages.some((image) => image.id === grant.imageId))
        .map((grant) => `${user.id}/image/${grant.imageId}/${grant.serverId}`));
    }

    report.priorPrefixCleanup.push(summary);
    report.cleanup.push(
      `prior prefix ${prior.prefix} scanned c/u/i/g/k=${summary.scanned.containers}/${summary.scanned.users}/${summary.scanned.images}/${summary.scanned.grants}/${summary.scanned.sshKeys}; removed=${summary.removed.length}; residual c/u/i/g/k=${summary.residuals.containers.length}/${summary.residuals.users.length}/${summary.residuals.images.length}/${summary.residuals.grants.length}/${summary.residuals.sshKeys.length}`,
    );
    expect(summary.residuals.containers, `prior prefix ${prior.prefix} residual containers`).toEqual([]);
    expect(summary.residuals.users, `prior prefix ${prior.prefix} residual users`).toEqual([]);
    expect(summary.residuals.images, `prior prefix ${prior.prefix} residual images`).toEqual([]);
    expect(summary.residuals.grants, `prior prefix ${prior.prefix} residual grants`).toEqual([]);
    expect(summary.residuals.sshKeys, `prior prefix ${prior.prefix} residual SSH keys`).toEqual([]);
  }
}

async function cleanupPrior(summary: PriorRunCleanup, label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    summary.removed.push(label);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      summary.removed.push(`${label} already absent`);
      return;
    }
    throw error;
  }
}

async function cleanupBestEffort(input: {
  adminToken?: string;
  userA?: UserDto;
  userB?: UserDto;
  image?: ImageDto;
  userAPassword?: string;
  createdContainers: TestContainer[];
  createdKeyIds: Array<{ actor: Actor; keyId: string; fingerprint: string; name: string }>;
}) {
  const userAToken = input.userA && input.userAPassword
    ? await login(input.userA.username, input.userAPassword).then((r) => r.accessToken).catch(() => undefined)
    : undefined;

  for (const container of [...input.createdContainers].reverse()) {
    if (!userAToken) {
      report.cleanup.push(`container cleanup skipped no User A token ${container.name}:${shortId(container.containerId)}`);
      continue;
    }
    try {
      await api('POST', `${containerPath(container)}/actions/delete`, userAToken);
      report.deletedContainers.push(container);
      report.cleanup.push(`deleted container ${container.name}:${shortId(container.containerId)} with User A credentials`);
    } catch (error) {
      report.cleanup.push(`container cleanup failed ${container.name}:${shortId(container.containerId)} ${describeError(error)}`);
      if (report.status === 'pass') report.status = error instanceof ApiError ? 'fail-product' : 'fail-infra';
    }
  }

  if (userAToken) {
    try {
      const residualContainers = await api<ContainerDto[]>('GET', '/v2/containers', userAToken);
      for (const residual of residualContainers.filter((item) => item.name.startsWith(RUN_PREFIX))) {
        try {
          await api('POST', `${containerPathFromIds(residual.serverId, canonicalContainerId(residual))}/actions/delete`, userAToken);
          report.deletedContainers.push({
            name: residual.name,
            serverId: residual.serverId,
            containerId: canonicalContainerId(residual),
            purpose: 'exact-prefix cleanup residual',
          });
          report.cleanup.push(`deleted exact-prefix residual container ${residual.name}:${shortId(canonicalContainerId(residual))} with User A credentials`);
        } catch (error) {
          report.cleanup.push(`exact-prefix residual container cleanup failed ${residual.name}:${shortId(canonicalContainerId(residual))} ${describeError(error)}`);
          if (report.status === 'pass') report.status = error instanceof ApiError ? 'fail-product' : 'fail-infra';
        }
      }
    } catch (error) {
      report.cleanup.push(`exact-prefix residual scan failed with User A credentials ${describeError(error)}`);
      if (report.status === 'pass') report.status = error instanceof ApiError ? 'fail-product' : 'fail-infra';
    }
  }

  for (const key of [...input.createdKeyIds].reverse()) {
    try {
      await api('DELETE', `/users/${key.actor.user.id}/ssh-keys/${key.keyId}`, key.actor.token);
      report.cleanup.push(`deleted SSH key ${key.keyId} fingerprint ${key.fingerprint} with ${key.actor.label} credentials`);
      report.sshKeys.push({
        userId: key.actor.user.id,
        keyId: key.keyId,
        name: key.name,
        fingerprint: key.fingerprint,
        action: 'deleted',
      });
    } catch (error) {
      report.cleanup.push(`SSH key cleanup failed ${key.keyId} ${describeError(error)}`);
      if (report.status === 'pass') report.status = error instanceof ApiError ? 'fail-product' : 'fail-infra';
    }
  }

  if (input.adminToken) {
    for (const user of [input.userA, input.userB]) {
      if (!user) continue;
      if (input.image && report.server) {
        await cleanupAdmin(`delete image grant ${user.id}`, () =>
          api('DELETE', `/admin/users/${user.id}/image-grants/${input.image!.id}/${report.server!.id}`, input.adminToken));
        await cleanupAdmin(`delete server grant ${user.id}`, () =>
          api('DELETE', `/admin/users/${user.id}/server-grants/${report.server!.id}`, input.adminToken));
      }
    }
    if (input.image) {
      await cleanupAdmin(`delete image row ${input.image.id}`, () => api('DELETE', `/admin/images/${input.image!.id}`, input.adminToken));
    }
    for (const user of [input.userA, input.userB]) {
      if (!user) continue;
      await cleanupAdmin(`delete user row ${user.id}`, () => api('DELETE', `/admin/users/${user.id}`, input.adminToken));
    }
  }
}

async function cleanupAdmin(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    report.cleanup.push(label);
  } catch (error) {
    if (error instanceof ApiError && [404, 204].includes(error.status)) {
      report.cleanup.push(`${label} already absent`);
      return;
    }
    report.cleanup.push(`${label} failed ${describeError(error)}`);
    if (report.status === 'pass') report.status = error instanceof ApiError ? 'fail-product' : 'fail-infra';
  }
}

async function removeTempSecrets() {
  const entries = [
    KNOWN_HOSTS,
    join(TEMP_DIR, 'a-primary.ed25519'),
    join(TEMP_DIR, 'a-primary.ed25519.pub'),
    join(TEMP_DIR, 'a-secondary.ed25519'),
    join(TEMP_DIR, 'a-secondary.ed25519.pub'),
  ];
  for (const path of entries) {
    try {
      await rm(path, { force: true });
      report.cleanup.push(`removed temp file ${basename(path)}`);
    } catch (error) {
      report.cleanup.push(`temp file removal failed ${basename(path)} ${describeError(error)}`);
    }
  }
}

async function api<T = unknown>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(method, path, res.status, data);
  return data as T;
}

async function expectApiError(
  method: string,
  path: string,
  token: string | undefined,
  body: unknown,
  expectedStatuses: number[],
): Promise<ApiError> {
  try {
    await api(method, path, token, body);
  } catch (error) {
    if (error instanceof ApiError) {
      expect(expectedStatuses, `${method} ${path} returned ${error.status}: ${JSON.stringify(error.body)}`).toContain(error.status);
      return error;
    }
    throw error;
  }
  throw new Error(`${method} ${path} unexpectedly succeeded`);
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  return null;
}

function record(
  step: string,
  actor: Actor | undefined,
  method: string,
  path: string,
  status: number,
  ids?: Record<string, unknown>,
) {
  report.evidence.push({
    step,
    actor: actor?.label,
    method,
    path,
    status,
    ids: ids as Record<string, string | number | boolean | null | undefined>,
  });
}

async function writeReports() {
  report.finishedAt = new Date().toISOString();
  await mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
  const json = `${JSON.stringify(redactReport(report), null, 2)}\n`;
  await writeFile(REPORT_JSON, json, { mode: 0o600 });
  await writeFile(REPORT_MD, renderMarkdownReport(redactReport(report)), { mode: 0o600 });

  const leaked = await reportHasSecretLikeMaterial(REPORT_JSON);
  if (leaked) {
    throw new Error(`redacted report contains secret-like material: ${leaked}`);
  }
}

function renderMarkdownReport(value: Report): string {
  const failureRows = value.failures.length === 0
    ? 'none'
    : value.failures.map((f) => `- ${f.test}: ${f.cause} (${f.rootCause})`).join('\n');
  const denialRows = value.denials
    .map((d) => `- ${d.method} ${d.path} -> ${d.status}`)
    .join('\n') || 'none';
  const sshRows = value.sshAttempts
    .map((a) => `- ${a.label} host=${a.host} key=${a.keyFingerprint ?? 'none'} exit=${a.exitCode} stderr=${a.stderrSummary}`)
    .join('\n') || 'none';
  const priorCleanupRows = value.priorPrefixCleanup
    .map((item) => [
      `- ${item.prefix}: scanned c/u/i/g/k=${item.scanned.containers}/${item.scanned.users}/${item.scanned.images}/${item.scanned.grants}/${item.scanned.sshKeys}; removed=${item.removed.length}; residual c/u/i/g/k=${item.residuals.containers.length}/${item.residuals.users.length}/${item.residuals.images.length}/${item.residuals.grants.length}/${item.residuals.sshKeys.length}`,
      ...item.removed.map((removed) => `  - removed ${removed}`),
    ].join('\n'))
    .join('\n') || 'none';
  return `# Dropbear Live Runtime Report

Run prefix: \`${value.runPrefix}\`
Status: \`${value.status}\`
Backend: \`${value.backendUrl}\`
Started: \`${value.startedAt}\`
Finished: \`${value.finishedAt}\`

No raw secrets are recorded. SSH keys are represented by SHA256 fingerprints only.

## Users

${Object.entries(value.users).map(([label, user]) => `- ${label}: ${user.username} ${user.id}, management capabilities: ${user.managementCapabilities.join(', ') || 'none'}`).join('\n') || 'none'}

## Runtime SSH Attempts

${sshRows}

## User B Denials

${denialRows}

## Cleanup

${value.cleanup.map((item) => `- ${item}`).join('\n') || 'none'}

## Prior Prefix Cleanup

${priorCleanupRows}

## Residuals

- Product containers: ${value.residuals.productContainers.join(', ') || 'none'}
- Host-level Docker exact-prefix scan: ${value.residuals.note}

## Failures

${failureRows}
`;
}

function redactReport(value: Report): Report {
  return JSON.parse(JSON.stringify(value)) as Report;
}

async function reportHasSecretLikeMaterial(path: string): Promise<string | null> {
  const text = await readFile(path, 'utf8');
  const checks: Array<[RegExp, string]> = [
    [/BEGIN OPENSSH PRIVATE KEY/, 'private key'],
    [/ADMIN_INIT_PASSWORD/, 'admin env var name'],
    [/Bearer\s+[A-Za-z0-9._-]+/, 'bearer token'],
    [/"accessToken"\s*:/, 'access token field'],
    [/"refreshToken"\s*:/, 'refresh token field'],
    [/"password"\s*:/i, 'password field'],
    [/ssh-ed25519\s+AAAA[0-9A-Za-z+/=]+/, 'raw public key'],
  ];
  for (const [regex, label] of checks) {
    if (regex.test(text)) return label;
  }
  return null;
}

function classifyFailure(error: unknown): Report['status'] {
  if (error instanceof ApiError) {
    if ([401, 403, 404, 409, 422].includes(error.status)) return 'fail-product';
    if ([500, 502, 503, 504].includes(error.status)) return 'fail-infra';
    return 'fail-product';
  }
  const message = describeError(error);
  if (/Cannot read properties of null \(reading 'state'\)|console kill must confirm Dropbear is not still running|Dropbear kill command (?:left live target processes|did not target a process)/i.test(message)) {
    return 'fail-test';
  }
  if (/WebSocket implementation unavailable|ECONNREFUSED|fetch failed|timed out|No route to host|Connection refused/i.test(message)) {
    return 'fail-infra';
  }
  return 'fail-product';
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.method} ${error.path} status=${error.status} body=${JSON.stringify(redactBody(error.body))}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  return JSON.parse(JSON.stringify(body, (key, value) => {
    if (/token|secret|password|keyText|authorization/i.test(key)) return '<redacted>';
    return value;
  }));
}

function sanitizeConsole(output: string): string {
  return output.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '').slice(0, 400);
}

function decodeConsoleData(data: string): string {
  return Buffer.from(data, 'base64').toString('utf-8');
}

function summarizeStderr(stderr: string): string {
  return stderr
    .replace(/Warning: Permanently added .* known hosts\.\s*/g, 'known-host-added ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function canonicalContainerId(container: Pick<ContainerDto, 'id' | 'containerId' | 'spec'>) {
  return container.containerId ?? container.id;
}

function containerPathFromIds(serverId: string, containerId: string, suffix = '') {
  return `/v2/containers/${containerId}${suffix}`;
}

function containerPath(container: TestContainer, suffix = '') {
  return containerPathFromIds(container.serverId, container.containerId, suffix);
}

function redactContainerPath(container: TestContainer, suffix = '') {
  return containerPathFromIds(container.serverId, shortId(container.containerId), suffix);
}

function removeCreatedContainer(containers: TestContainer[], containerId: string) {
  const index = containers.findIndex((item) => item.containerId === containerId);
  if (index !== -1) containers.splice(index, 1);
}

function removeCreatedKey(keys: Array<{ keyId: string }>, keyId: string) {
  const index = keys.findIndex((item) => item.keyId === keyId);
  if (index !== -1) keys.splice(index, 1);
}

function shortId(id: string) {
  return id.slice(0, 12);
}

function parseDropbearKillSummary(output: string): { targetCount: number; aliveAfterKillCount: number } | null {
  const match = /NYABASE_DROPBEAR_KILL_RESULT\s+targets=(\d+)\s+alive=(\d+)/.exec(output);
  if (!match) return null;
  return { targetCount: Number(match[1]), aliveAfterKillCount: Number(match[2]) };
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function strongPassword(label: string) {
  return `Dropbear-${label}-${randomBytes(18).toString('base64url')}1a`;
}

function timestampRunId() {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase()}-${randomBytes(3).toString('hex')}`;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnvValue(key: string): string | undefined {
  try {
    const text = readFileSync('test/config/local.env', 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      if (trimmed.slice(0, eq) === key) return trimmed.slice(eq + 1);
    }
  } catch {
    // Optional local env file.
  }
  return undefined;
}
