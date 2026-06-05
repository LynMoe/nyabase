import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type ApiResult<T = unknown> = {
  method: string;
  path: string;
  status: number;
  ok: boolean;
  body: T;
};

type LoginResponse = {
  accessToken: string;
  refreshToken?: string;
  user: UserDto;
};

type UserDto = {
  id: string;
  username: string;
  capabilities: string[];
};

type MountSourceKind = 'local' | 'remote';

type MountSourceDto = {
  kind: MountSourceKind;
  id: string;
  serverId: string;
  label: string;
  hostRoot: string;
};

type DataDirDto = {
  id: string;
  userId: string;
  sourceKind: MountSourceKind;
  sourceId: string;
  name: string;
  hostPath: string;
  serverId: string;
  serverName: string;
  operationId?: string;
  status?: string;
};

type ContainerDto = {
  id: string;
  containerId?: string;
  serverId: string;
  ownerId: string;
  name: string;
  imageId: string;
  phase: string;
  runtime: {
    status: string | null;
    stale?: boolean;
  };
  resources: {
    cpuMillis: number;
    memBytes: number;
    gpuIndices: number[];
  };
  mounts: ContainerMountDto[];
  actions: {
    console?: { enabled: boolean };
    updateMounts?: { enabled: boolean };
  };
};

type ContainerMountDto = {
  id: string;
  sourceKind: MountSourceKind;
  sourceId: string;
  dirName: string;
  containerPath: string;
};

type OperationRef = { ok: true; operationId: string; status: string };

type MountInput = {
  sourceKind: MountSourceKind;
  sourceId: string;
  dirName: string;
  containerPath: string;
  createIfMissing?: boolean;
};

type FixtureUser = {
  id: string;
  username: string;
  displayName: string;
  capabilities: string[];
  verifiedLogin: boolean;
  mountSources: MountSourceDto[];
};

type FixtureState = {
  schema: string;
  createdAt: string;
  backendUrl: string;
  runPrefix: string;
  cpuServerId: string;
  paths: { baseDir: string; exportDir: string; hostMountPoint: string };
  sources: {
    local: { id: string; mountPoint: string; label: string };
    remote: { id: string; name: string; hostMountPoint: string; serverId: string; status: string };
  };
  image: { id: string; dockerImage: string; cmd: string; name: string };
  users: {
    alphaLocal: FixtureUser;
    betaRemote: FixtureUser;
    deltaBoth: FixtureUser;
  };
  credentials: {
    alphaLocal: string;
    betaRemote: string;
    deltaBoth: string;
  };
};

type Persona = 'alphaLocal' | 'betaRemote' | 'deltaBoth';

type Actor = {
  persona: Persona;
  label: string;
  token: string;
  user: UserDto;
};

type TrackedContainer = {
  actor: Actor;
  name: string;
  serverId: string;
  containerId: string;
};

type ReportEntry = {
  step: string;
  actor: string;
  method: string;
  path: string;
  status: number;
  expected: string;
  ids?: Record<string, string | number | boolean | null>;
  bodySummary?: unknown;
};

type CleanupEntry = {
  kind: 'container' | 'data-dir';
  actor: string;
  name?: string;
  id?: string;
  sourceKind?: MountSourceKind;
  sourceId?: string;
  status: string;
};

type Report = {
  runPrefix: string;
  backendUrl: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  status: 'pass' | 'fail-product' | 'fail-test' | 'fail-infra';
  noRawSecretsRecorded: boolean;
  users: Record<string, { id: string; username: string; managementCapabilities: string[]; sourceIds: string[] }>;
  created: {
    containers: Array<{ actor: string; name: string; serverId: string; containerId: string }>;
    dataDirs: Array<{ actor: string; name: string; sourceKind: MountSourceKind; sourceId: string; id?: string }>;
  };
  deleted: {
    containers: Array<{ actor: string; name: string; serverId: string; containerId: string }>;
    dataDirs: Array<{ actor: string; name: string; sourceKind: MountSourceKind; sourceId: string; id?: string }>;
  };
  entries: ReportEntry[];
  cleanup: CleanupEntry[];
  finalResiduals: Record<string, { containers: number; dataDirs: number; containerNames: string[]; dataDirNames: string[] }>;
  failures: Array<{ test: string; cause: string; rootCause: 'product' | 'test' | 'infra'; evidence: string }>;
};

const COORD_DIR = process.env.NYABASE_MOUNT_COORD_DIR ?? 'test/runtime/mount/manual';
const STATE_PATH = process.env.NYABASE_MOUNT_STATE ?? join(COORD_DIR, 'state.json');
const REPORT_MD = process.env.NYABASE_MOUNT_RUNTIME_REPORT_MD ?? join(COORD_DIR, 'mount-runtime-report.md');
const REPORT_JSON = process.env.NYABASE_MOUNT_RUNTIME_REPORT_JSON ?? join(COORD_DIR, 'mount-runtime-report.json');
const COMMAND = `NYABASE_MOUNT_STATE=${STATE_PATH} pnpm exec vitest run test/specs/live/multi-user-redteam-mount-sources.spec.ts --reporter=verbose`;
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
const DENY_STATUSES = [400, 401, 403, 404, 409, 422];
const DELETE_GUARD_STATUSES = [400, 409, 422, 500];

const state = JSON.parse(await readFile(STATE_PATH, 'utf8')) as FixtureState;
const apiBase = `${stripTrailingSlash(process.env.NYABASE_BACKEND_URL ?? state.backendUrl)}/api`;
const runSlug = state.runPrefix.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
const startedAt = new Date().toISOString();
const credentials = {
  alphaLocal: parseEnv(await readFile(state.credentials.alphaLocal, 'utf8')),
  betaRemote: parseEnv(await readFile(state.credentials.betaRemote, 'utf8')),
  deltaBoth: parseEnv(await readFile(state.credentials.deltaBoth, 'utf8')),
};

const createdContainers: TrackedContainer[] = [];
const createdDirs: Array<{ actor: Actor; name: string; sourceKind: MountSourceKind; sourceId: string; id?: string }> = [];
const report: Report = {
  runPrefix: state.runPrefix,
  backendUrl: state.backendUrl,
  command: COMMAND,
  startedAt,
  finishedAt: '',
  status: 'pass',
  noRawSecretsRecorded: true,
  users: {},
  created: { containers: [], dataDirs: [] },
  deleted: { containers: [], dataDirs: [] },
  entries: [],
  cleanup: [],
  finalResiduals: {},
  failures: [],
};

describe('multi-user red-team mount sources runtime matrix', () => {
  it('verifies user-scoped mount source, data-dir, container mount, dynamic patch, and cleanup behavior', async () => {
    let alpha: Actor | undefined;
    let beta: Actor | undefined;
    let delta: Actor | undefined;

    try {
      alpha = await loginPersona('alphaLocal', 'alpha-local');
      beta = await loginPersona('betaRemote', 'beta-remote');
      delta = await loginPersona('deltaBoth', 'delta-both');

      await verifySourceVisibility(alpha, ['local']);
      await verifySourceVisibility(beta, ['remote']);
      await verifySourceVisibility(delta, ['local', 'remote']);

      await expectDeniedSourceUse(alpha, 'remote', state.sources.remote.id, `${runSlug}-alpha-remote-deny`);
      await expectDeniedSourceUse(beta, 'local', state.sources.local.id, `${runSlug}-beta-local-deny`);

      const alphaDir = await createDataDir(alpha, 'local', state.sources.local.id, `${runSlug}-alpha-share`);
      const alphaOne = await createMountedContainer(alpha, `${runSlug}-alpha-one`, 'local', state.sources.local.id, alphaDir.name, '/mnt/shared');
      const alphaTwo = await createMountedContainer(alpha, `${runSlug}-alpha-two`, 'local', state.sources.local.id, alphaDir.name, '/mnt/shared');
      await execWriteRead(alpha, alphaOne, '/mnt/shared', 'alpha-marker', 'alpha-to-alpha');
      await execExpectRead(alpha, alphaTwo, '/mnt/shared/alpha-marker', 'alpha-to-alpha', 'alpha same-owner shared read');

      const guard = await request('DELETE', dataDirPath(alphaDir), alpha.token);
      record('in-use data dir delete guarded', alpha, guard, '400/409/422/500 while mounted container stays healthy', {
        name: alphaDir.name,
        sourceId: state.sources.local.id,
      });
      expect(DELETE_GUARD_STATUSES, `delete in-use data dir returned ${guard.status}: ${JSON.stringify(guard.body)}`).toContain(guard.status);
      const alphaOneAfterGuard = await request<ContainerDto>('GET', containerPath(alphaOne), alpha.token);
      record('mounted container healthy after delete guard', alpha, alphaOneAfterGuard, '200 container remains visible', {
        containerId: shortId(alphaOne.containerId),
      });
      expect(alphaOneAfterGuard.status).toBe(200);
      expect(['running', 'creating', 'exited'].includes(alphaOneAfterGuard.body.runtime.status ?? alphaOneAfterGuard.body.phase)).toBe(true);

      await expectCrossUserDeleteDenied(delta, alphaDir, 'delta guessing alpha local dir while mounted');

      const betaDir = await createDataDir(beta, 'remote', state.sources.remote.id, `${runSlug}-beta-remote`);
      const betaContainer = await createMountedContainer(beta, `${runSlug}-beta-remote`, 'remote', state.sources.remote.id, betaDir.name, '/mnt/remote');
      await execWriteRead(beta, betaContainer, '/mnt/remote', 'beta-marker', 'beta-remote-rw');
      await expectCrossUserDeleteDenied(delta, betaDir, 'delta guessing beta remote dir while mounted');

      const deltaLocalDir = await createDataDir(delta, 'local', state.sources.local.id, `${runSlug}-delta-local`);
      const deltaRemoteDir = await createDataDir(delta, 'remote', state.sources.remote.id, `${runSlug}-delta-remote`);
      const deltaLocalContainer = await createMountedContainer(delta, `${runSlug}-delta-local`, 'local', state.sources.local.id, deltaLocalDir.name, '/mnt/local');
      const deltaRemoteContainer = await createMountedContainer(delta, `${runSlug}-delta-remote`, 'remote', state.sources.remote.id, deltaRemoteDir.name, '/mnt/remote');
      await execWriteRead(delta, deltaLocalContainer, '/mnt/local', 'delta-local-marker', 'delta-local-rw');
      await execWriteRead(delta, deltaRemoteContainer, '/mnt/remote', 'delta-remote-marker', 'delta-remote-rw');

      const patchDir = await createDataDir(delta, 'remote', state.sources.remote.id, `${runSlug}-delta-patch`);
      const patchContainer = await createPlainContainer(delta, `${runSlug}-delta-patch`);
      const emptyDetail = await request<ContainerDto>('GET', containerPath(patchContainer), delta.token);
      record('dynamic patch initial mounts empty', delta, emptyDetail, '200 empty mount list', { containerId: shortId(patchContainer.containerId) });
      expect(emptyDetail.status).toBe(200);
      expect(emptyDetail.body.mounts).toEqual([]);

      await patchMounts(delta, patchContainer, [{
        sourceKind: 'remote',
        sourceId: state.sources.remote.id,
        dirName: patchDir.name,
        containerPath: '/mnt/patch',
        createIfMissing: false,
      }], 'dynamic mount patch add');
      await execWriteRead(delta, patchContainer, '/mnt/patch', 'delta-patch-marker', 'delta-patch-rw');
      await patchMounts(delta, patchContainer, [], 'dynamic mount patch remove');
      const removedDetail = await request<ContainerDto>('GET', containerPath(patchContainer), delta.token);
      record('dynamic patch final mounts empty', delta, removedDetail, '200 empty after remove', { containerId: shortId(patchContainer.containerId) });
      expect(removedDetail.status).toBe(200);
      expect(removedDetail.body.mounts).toEqual([]);

      for (const container of [
        patchContainer,
        deltaRemoteContainer,
        deltaLocalContainer,
        betaContainer,
        alphaTwo,
        alphaOne,
      ]) {
        await removeContainerViaOperation(container.actor, container);
      }

      for (const dir of [patchDir, deltaRemoteDir, deltaLocalDir, betaDir, alphaDir]) {
        await deleteDataDir(dir.actor, dir);
      }

      await expectCrossUserDeleteDenied(delta, alphaDir, 'delta guessing alpha local dir after cleanup');
      await expectCrossUserDeleteDenied(delta, betaDir, 'delta guessing beta remote dir after cleanup');

      await assertNoResiduals(alpha);
      await assertNoResiduals(beta);
      await assertNoResiduals(delta);
    } catch (error) {
      report.status = classifyFailure(error);
      report.failures.push({
        test: 'multi-user red-team mount sources runtime matrix',
        cause: describeError(error),
        rootCause: report.status === 'fail-infra' ? 'infra' : report.status === 'fail-test' ? 'test' : 'product',
        evidence: REPORT_MD,
      });
      throw error;
    } finally {
      await cleanupAll();
      if (alpha) await assertNoResiduals(alpha).catch((error) => recordCleanup('container', alpha, 'residual-check', `failed: ${describeError(error)}`));
      if (beta) await assertNoResiduals(beta).catch((error) => recordCleanup('container', beta, 'residual-check', `failed: ${describeError(error)}`));
      if (delta) await assertNoResiduals(delta).catch((error) => recordCleanup('container', delta, 'residual-check', `failed: ${describeError(error)}`));
      await writeReports();
    }
  }, 420_000);
});

async function loginPersona(persona: Persona, label: string): Promise<Actor> {
  const cred = credentials[persona];
  const expected = state.users[persona];
  expect(cred.NYABASE_USERNAME).toBe(expected.username);
  expect(cred.NYABASE_PASSWORD, `${label} credential file must contain password`).toBeTruthy();

  const login = await request<LoginResponse>('POST', '/auth/login', undefined, {
    username: cred.NYABASE_USERNAME,
    password: cred.NYABASE_PASSWORD,
  });
  record(`login ${label}`, { persona, label, token: '', user: expected } as Actor, login, '200 own credentials');
  expect(login.status).toBe(200);
  expect(login.body.user.id).toBe(expected.id);
  expect(login.body.user.username).toBe(expected.username);
  expect(managementCaps(login.body.user.capabilities)).toEqual([]);

  const actor: Actor = { persona, label, token: login.body.accessToken, user: login.body.user };
  const me = await request<UserDto>('GET', '/auth/me', actor.token);
  record(`/auth/me ${label}`, actor, me, '200 own identity, no management caps');
  expect(me.status).toBe(200);
  expect(me.body.id).toBe(expected.id);
  expect(me.body.username).toBe(expected.username);
  expect(managementCaps(me.body.capabilities)).toEqual([]);

  report.users[label] = {
    id: expected.id,
    username: expected.username,
    managementCapabilities: managementCaps(me.body.capabilities),
    sourceIds: expected.mountSources.map((source) => `${source.kind}:${source.id}`),
  };
  return actor;
}

async function verifySourceVisibility(actor: Actor, expectedKinds: MountSourceKind[]) {
  const sources = await request<MountSourceDto[]>('GET', `/mount-sources?serverId=${encodeURIComponent(state.cpuServerId)}`, actor.token);
  record(`mount sources visible for ${actor.label}`, actor, sources, `200 only ${expectedKinds.join('+')}`, {
    count: Array.isArray(sources.body) ? sources.body.length : -1,
  });
  expect(sources.status).toBe(200);
  expect(sources.body.map((source) => source.kind).sort()).toEqual([...expectedKinds].sort());
  const sourceKeys = sources.body.map((source) => `${source.kind}:${source.id}`).sort();
  const expectedKeys = expectedKinds.map((kind) => `${kind}:${kind === 'local' ? state.sources.local.id : state.sources.remote.id}`).sort();
  expect(sourceKeys).toEqual(expectedKeys);

  const dirs = await listRunDataDirs(actor);
  record(`initial run data dirs ${actor.label}`, actor, dirs.result, '200 no pre-existing runtime dirs', { count: dirs.items.length });
  expect(dirs.items).toEqual([]);
}

async function expectDeniedSourceUse(actor: Actor, sourceKind: MountSourceKind, sourceId: string, name: string) {
  const sources = await request<MountSourceDto[]>('GET', `/mount-sources?serverId=${encodeURIComponent(state.cpuServerId)}`, actor.token);
  record(`${actor.label} cannot list ${sourceKind} source`, actor, sources, '200 list excludes ungranted source', { sourceKind, sourceId });
  expect(sources.status).toBe(200);
  expect(sources.body.some((source) => source.kind === sourceKind && source.id === sourceId)).toBe(false);

  const createDir = await request('POST', '/data-dirs', actor.token, { serverId: state.cpuServerId, sourceKind, sourceId, name });
  record(`${actor.label} cannot create ${sourceKind} data dir`, actor, createDir, 'denied', { sourceKind, sourceId, name });
  expect(DENY_STATUSES).toContain(createDir.status);

  const createContainer = await request('POST', '/v2/containers', actor.token, {
    serverId: state.cpuServerId,
    imageId: state.image.id,
    name: `${name}-ctr`,
    cpuMillis: 1,
    memBytes: 16 * MI_B,
    gpuIndices: [],
    dataDirs: [{
      sourceKind,
      sourceId,
      dirName: name,
      containerPath: '/mnt/deny',
      createIfMissing: true,
    }],
  });
  record(`${actor.label} cannot create container with ${sourceKind} mount`, actor, createContainer, 'denied', { sourceKind, sourceId, name });
  expect(DENY_STATUSES).toContain(createContainer.status);
}

async function createDataDir(actor: Actor, sourceKind: MountSourceKind, sourceId: string, name: string) {
  const result = await request<DataDirDto>('POST', '/data-dirs', actor.token, {
    serverId: state.cpuServerId,
    sourceKind,
    sourceId,
    name,
  });
  record(`create data dir ${name}`, actor, result, '201/200', { sourceKind, sourceId, name });
  expect([200, 201]).toContain(result.status);
  expect(result.body.name).toBe(name);
  expect(result.body.sourceKind).toBe(sourceKind);
  expect(result.body.sourceId).toBe(sourceId);

  if (result.body.operationId) await waitForOperationTerminal(actor, result.body.operationId);

  const dir = { actor, name, sourceKind, sourceId, id: result.body.id };
  createdDirs.push(dir);
  report.created.dataDirs.push(toReportDir(dir));

  const listed = await listRunDataDirs(actor);
  expect(listed.items.some((item) => item.name === name && item.sourceKind === sourceKind && item.sourceId === sourceId)).toBe(true);
  return dir;
}

async function createMountedContainer(
  actor: Actor,
  name: string,
  sourceKind: MountSourceKind,
  sourceId: string,
  dirName: string,
  containerPathValue: string,
) {
  const before = await listRunContainers(actor);
  const result = await request<OperationRef>('POST', '/v2/containers', actor.token, {
    serverId: state.cpuServerId,
    imageId: state.image.id,
    name,
    cpuMillis: 1,
    memBytes: 16 * MI_B,
    gpuIndices: [],
    dataDirs: [{
      sourceKind,
      sourceId,
      dirName,
      containerPath: containerPathValue,
      createIfMissing: false,
    }],
  });
  record(`create mounted container ${name}`, actor, result, '201/200 operation ref', { sourceKind, sourceId, dirName });
  expect([200, 201]).toContain(result.status);
  await waitForOperationTerminal(actor, result.body.operationId);
  const container = await waitForContainerActionable(actor, name, before);
  expect(container.ownerId).toBe(actor.user.id);
  expect(container.imageId).toBe(state.image.id);
  expect(container.mounts).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceKind, sourceId, dirName, containerPath: containerPathValue }),
  ]));
  return trackContainer(actor, name, container);
}

async function createPlainContainer(actor: Actor, name: string) {
  const before = await listRunContainers(actor);
  const result = await request<OperationRef>('POST', '/v2/containers', actor.token, {
    serverId: state.cpuServerId,
    imageId: state.image.id,
    name,
    cpuMillis: 1,
    memBytes: 16 * MI_B,
    gpuIndices: [],
  });
  record(`create plain container ${name}`, actor, result, '201/200 no dataDirs', { name });
  expect([200, 201]).toContain(result.status);
  await waitForOperationTerminal(actor, result.body.operationId);
  const container = await waitForContainerActionable(actor, name, before);
  expect(container.mounts).toEqual([]);
  return trackContainer(actor, name, container);
}

function trackContainer(actor: Actor, name: string, dto: ContainerDto): TrackedContainer {
  const container = {
    actor,
    name,
    serverId: state.cpuServerId,
    containerId: canonicalContainerId(dto),
  };
  createdContainers.push(container);
  report.created.containers.push(toReportContainer(container));
  return container;
}

async function patchMounts(actor: Actor, container: TrackedContainer, mounts: MountInput[], step: string) {
  const result = await request<OperationRef>('POST', `${containerPath(container)}/actions/update-mounts`, actor.token, mounts);
  record(step, actor, result, '200/201 operation ref', { containerId: shortId(container.containerId), count: mounts.length });
  expect([200, 201]).toContain(result.status);
  await waitForOperationTerminal(actor, result.body.operationId);
  const detail = await request<ContainerDto>('GET', containerPath(container), actor.token);
  record(`${step} readback`, actor, detail, '200', { containerId: shortId(container.containerId), count: detail.body.mounts.length });
  expect(detail.status).toBe(200);
  expect(detail.body.mounts).toHaveLength(mounts.length);
  for (const mount of mounts) {
    expect(detail.body.mounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKind: mount.sourceKind,
        sourceId: mount.sourceId,
        dirName: mount.dirName,
        containerPath: mount.containerPath,
      }),
    ]));
  }
}

async function execWriteRead(
  actor: Actor,
  container: TrackedContainer,
  mountPath: string,
  filename: string,
  marker: string,
) {
  const command = `printf '%s\\n' '${marker}' > ${mountPath}/${filename}; cat ${mountPath}/${filename}; exit`;
  const output = await execCommand(actor, container, command);
  record(`exec write/read ${marker}`, actor, { method: 'POST+/ws', path: `${containerPath(container)}/exec-sessions`, status: 200, ok: true, body: { output } }, 'marker echoed', {
    containerId: shortId(container.containerId),
    marker,
  });
  expect(output).toContain(marker);
}

async function execExpectRead(
  actor: Actor,
  container: TrackedContainer,
  filePath: string,
  marker: string,
  step: string,
) {
  const output = await execCommand(actor, container, `cat ${filePath}; exit`);
  record(step, actor, { method: 'POST+/ws', path: `${containerPath(container)}/exec-sessions`, status: 200, ok: true, body: { output } }, 'marker echoed from second container', {
    containerId: shortId(container.containerId),
    marker,
  });
  expect(output).toContain(marker);
}

async function execCommand(actor: Actor, container: TrackedContainer, command: string) {
  if (typeof WebSocket !== 'function') throw new Error('Node WebSocket implementation unavailable');
  const exec = await request<{ sessionId: string }>('POST', `${containerPath(container)}/exec-sessions`, actor.token, {
    shell: 'sh',
    tty: true,
    cols: 100,
    rows: 24,
  });
  record('open exec session', actor, exec, '201/200 sessionId', { containerId: shortId(container.containerId) });
  expect([200, 201]).toContain(exec.status);
  expect(exec.body.sessionId).toEqual(expect.any(String));
  return runConsole(actor.token, exec.body.sessionId, command);
}

async function runConsole(token: string, sessionId: string, command: string) {
  const wsUrl = `${state.backendUrl.replace(/^http/, 'ws')}/ws/console?sessionId=${encodeURIComponent(sessionId)}`;
  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore timeout close failures
      }
      reject(new Error(`console websocket timed out; output=${chunks.join('')}`));
    }, 30_000);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(chunks.join(''));
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: `${command}\n` })), 250);
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string };
      if (message.type === 'data' && message.data) chunks.push(decodeConsoleData(message.data));
      if (message.type === 'eof') finish();
    });
    ws.addEventListener('close', finish);
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('console websocket error'));
    });
  });
}

async function expectCrossUserDeleteDenied(
  actor: Actor,
  dir: { name: string; sourceKind: MountSourceKind; sourceId: string },
  step: string,
) {
  const result = await request('DELETE', dataDirPath(dir), actor.token);
  record(step, actor, result, 'denied/not found', { sourceKind: dir.sourceKind, sourceId: dir.sourceId, name: dir.name });
  expect(DENY_STATUSES).toContain(result.status);
}

async function removeContainerViaOperation(actor: Actor, container: TrackedContainer) {
  const operation = await requestContainerDeleteOperation(actor, container);
  record(`delete container ${container.name} via V2 operation`, actor, operation, '200/201 operation ref', {
    containerId: shortId(container.containerId),
    operationId: shortId(operation.body.operationId),
  });
  expect([200, 201]).toContain(operation.status);
  await waitForOperationTerminal(actor, operation.body.operationId);
  removeCreatedContainer(container.containerId);
  report.deleted.containers.push(toReportContainer(container));
  await waitForContainerGone(actor, container);
}

async function requestContainerDeleteOperation(actor: Actor, container: TrackedContainer) {
  return request<{ ok: true; operationId: string; status: string }>('POST', `/v2/containers/${container.containerId}/actions/delete`, actor.token);
}

async function waitForOperationTerminal(actor: Actor, operationId: string) {
  const terminal = new Set(['succeeded', 'failed', 'cancelled']);
  let finalStatus: string | undefined;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const operation = await request<{ id: string; status: string; lastError: string | null }>('GET', `/operations/${operationId}`, actor.token);
    if (operation.status === 200 && terminal.has(operation.body.status)) {
      finalStatus = operation.body.status;
      expect(operation.body.status, `operation ${operationId} failed: ${operation.body.lastError ?? ''}`).toBe('succeeded');
      return operation.body;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for operation ${operationId}; last status ${finalStatus ?? 'unknown'}`);
}

async function deleteDataDir(actor: Actor, dir: { name: string; sourceKind: MountSourceKind; sourceId: string; id?: string }) {
  const result = await request('DELETE', dataDirPath(dir), actor.token);
  record(`delete data dir ${dir.name}`, actor, result, '200/201 operation ref or 204', { sourceKind: dir.sourceKind, sourceId: dir.sourceId, name: dir.name });
  expect([200, 201, 204]).toContain(result.status);
  const body = result.body as { operationId?: string };
  if (body?.operationId) await waitForOperationTerminal(actor, body.operationId);
  removeCreatedDir(dir);
  report.deleted.dataDirs.push(toReportDir({ actor, ...dir }));
}

async function cleanupAll() {
  for (const container of [...createdContainers].reverse()) {
    try {
      const result = await requestContainerDeleteOperation(container.actor, container);
      recordCleanup('container', container.actor, container.name, `best-effort delete ${result.status}`);
      if ([200, 201].includes(result.status)) {
        await waitForOperationTerminal(container.actor, result.body.operationId);
        await waitForContainerGone(container.actor, container);
        removeCreatedContainer(container.containerId);
      } else if ([403, 404].includes(result.status)) {
        removeCreatedContainer(container.containerId);
      }
    } catch (error) {
      recordCleanup('container', container.actor, container.name, `failed: ${describeError(error)}`);
      if (report.status === 'pass') report.status = 'fail-infra';
    }
  }

  for (const dir of [...createdDirs].reverse()) {
    try {
      const result = await request('DELETE', dataDirPath(dir), dir.actor.token);
      recordCleanup('data-dir', dir.actor, dir.name, `best-effort delete ${result.status}`);
      if ([200, 201].includes(result.status)) {
        const body = result.body as { operationId?: string };
        if (body?.operationId) await waitForOperationTerminal(dir.actor, body.operationId);
        removeCreatedDir(dir);
      } else if ([204, 403, 404].includes(result.status)) removeCreatedDir(dir);
    } catch (error) {
      recordCleanup('data-dir', dir.actor, dir.name, `failed: ${describeError(error)}`);
      if (report.status === 'pass') report.status = 'fail-infra';
    }
  }
}

async function assertNoResiduals(actor: Actor) {
  const containers = await listRunContainers(actor);
  const dirs = await listRunDataDirs(actor);
  report.finalResiduals[actor.label] = {
    containers: containers.length,
    dataDirs: dirs.items.length,
    containerNames: containers.map((container) => container.name),
    dataDirNames: dirs.items.map((dir) => dir.name),
  };
  expect(containers, `${actor.label} run-prefix containers remain`).toEqual([]);
  expect(dirs.items, `${actor.label} run-prefix data dirs remain`).toEqual([]);
}

async function listRunContainers(actor: Actor) {
  const result = await request<ContainerDto[]>('GET', `/v2/containers?serverId=${encodeURIComponent(state.cpuServerId)}`, actor.token);
  record(`list run containers ${actor.label}`, actor, result, '200', { actor: actor.label });
  expect(result.status).toBe(200);
  return result.body.filter((container) => container.name.startsWith(runSlug));
}

async function listRunDataDirs(actor: Actor) {
  const result = await request<DataDirDto[]>('GET', `/data-dirs?serverId=${encodeURIComponent(state.cpuServerId)}`, actor.token);
  expect(result.status).toBe(200);
  return { result, items: result.body.filter((dir) => dir.name.startsWith(runSlug)) };
}

async function waitForContainerActionable(actor: Actor, name: string, before: ContainerDto[]) {
  const beforeIds = new Set(before.map((container) => canonicalContainerId(container)));
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const containers = await listRunContainers(actor);
    const found = containers.find((container) => container.name === name && !beforeIds.has(canonicalContainerId(container)));
    if (found) return found;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for container ${name}`);
}

async function waitForContainerGone(actor: Actor, container: Pick<TrackedContainer, 'serverId' | 'containerId'>) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await request('GET', containerPath(container), actor.token);
    if ([403, 404].includes(result.status)) return;
    if (![200, 503].includes(result.status)) return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for container deletion ${shortId(container.containerId)}`);
}

async function request<T = unknown>(method: string, path: string, token?: string, body?: unknown): Promise<ApiResult<T>> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
  }
  return { method, path, status: response.status, ok: response.ok, body: parsed as T };
}

function record(step: string, actor: Actor, result: Pick<ApiResult, 'method' | 'path' | 'status' | 'body'>, expected: string, ids?: Record<string, string | number | boolean | null>) {
  report.entries.push({
    step,
    actor: actor.label,
    method: result.method,
    path: scrubPath(result.path),
    status: result.status,
    expected,
    ids,
    bodySummary: summarizeBody(result.body),
  });
}

function recordCleanup(kind: 'container' | 'data-dir', actor: Actor, name: string, status: string) {
  report.cleanup.push({ kind, actor: actor.label, name, status });
}

async function writeReports() {
  report.finishedAt = new Date().toISOString();
  report.noRawSecretsRecorded = findSecretLeaks().length === 0;
  if (!report.noRawSecretsRecorded && report.status === 'pass') report.status = 'fail-test';
  await mkdir(COORD_DIR, { recursive: true, mode: 0o700 });
  await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(REPORT_MD, renderMarkdownReport(), { mode: 0o600 });
}

function renderMarkdownReport() {
  const lines = [
    '# Mount Runtime Report',
    '',
    `Run prefix: ${report.runPrefix}`,
    `Backend URL: ${report.backendUrl}`,
    `Command: ${report.command}`,
    `Status: ${report.status}`,
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt}`,
    `No raw secrets recorded: ${report.noRawSecretsRecorded}`,
    '',
    '## Users',
    ...Object.entries(report.users).map(([label, user]) =>
      `- ${label}: user=${user.username} id=${user.id} managementCaps=${user.managementCapabilities.join(',') || 'none'} sources=${user.sourceIds.join(',') || 'none'}`),
    '',
    '## Created',
    ...report.created.dataDirs.map((dir) => `- data-dir ${dir.actor} ${dir.sourceKind}:${dir.sourceId}/${dir.name} id=${dir.id ?? 'n/a'}`),
    ...report.created.containers.map((container) => `- container ${container.actor} ${container.name} server=${container.serverId} container=${shortId(container.containerId)}`),
    ...(report.created.dataDirs.length + report.created.containers.length === 0 ? ['- none'] : []),
    '',
    '## Deleted',
    ...report.deleted.dataDirs.map((dir) => `- data-dir ${dir.actor} ${dir.sourceKind}:${dir.sourceId}/${dir.name} id=${dir.id ?? 'n/a'}`),
    ...report.deleted.containers.map((container) => `- container ${container.actor} ${container.name} server=${container.serverId} container=${shortId(container.containerId)}`),
    ...(report.deleted.dataDirs.length + report.deleted.containers.length === 0 ? ['- none'] : []),
    '',
    '## Status Codes',
    '| Step | Actor | Method | Path | Status | Expected |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.entries.map((entry) =>
      `| ${escapeMd(entry.step)} | ${entry.actor} | ${entry.method} | ${escapeMd(entry.path)} | ${entry.status} | ${escapeMd(entry.expected)} |`),
    '',
    '## Cleanup',
    ...report.cleanup.map((entry) => `- ${entry.kind} ${entry.actor} ${entry.name ?? entry.id ?? 'n/a'}: ${entry.status}`),
    ...(report.cleanup.length === 0 ? ['- normal flow cleanup only'] : []),
    '',
    '## Final Residuals',
    ...Object.entries(report.finalResiduals).map(([actor, residual]) =>
      `- ${actor}: containers=${residual.containers} dataDirs=${residual.dataDirs} containerNames=${residual.containerNames.join(',') || 'none'} dataDirNames=${residual.dataDirNames.join(',') || 'none'}`),
    '',
    '## Failures',
    ...(report.failures.length ? report.failures.map((failure) => `- ${failure.test}: ${escapeMd(failure.cause)} (${failure.rootCause})`) : ['- none']),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function dataDirPath(dir: { sourceKind: MountSourceKind; sourceId: string; name: string }) {
  return `/data-dirs/${state.cpuServerId}/${dir.sourceId}/${encodeURIComponent(dir.name)}?sourceKind=${dir.sourceKind}`;
}

function canonicalContainerId(container: Pick<ContainerDto, 'id' | 'containerId'>) {
  return container.containerId ?? container.id;
}

function containerPath(container: Pick<TrackedContainer, 'serverId' | 'containerId'>) {
  return `/v2/containers/${container.containerId}`;
}

function toReportContainer(container: TrackedContainer) {
  return {
    actor: container.actor.label,
    name: container.name,
    serverId: container.serverId,
    containerId: container.containerId,
  };
}

function toReportDir(dir: { actor: Actor; name: string; sourceKind: MountSourceKind; sourceId: string; id?: string }) {
  return { actor: dir.actor.label, name: dir.name, sourceKind: dir.sourceKind, sourceId: dir.sourceId, id: dir.id };
}

function removeCreatedContainer(containerId: string) {
  const index = createdContainers.findIndex((container) => container.containerId === containerId);
  if (index >= 0) createdContainers.splice(index, 1);
}

function removeCreatedDir(dir: { name: string; sourceKind: MountSourceKind; sourceId: string }) {
  const index = createdDirs.findIndex((item) => item.name === dir.name && item.sourceKind === dir.sourceKind && item.sourceId === dir.sourceId);
  if (index >= 0) createdDirs.splice(index, 1);
}

function parseEnv(contents: string) {
  const env: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function managementCaps(capabilities: string[]) {
  return capabilities.filter((cap) => MANAGEMENT_CAPS.has(cap));
}

function summarizeBody(value: unknown): unknown {
  const redacted = redact(value);
  if (Array.isArray(redacted)) return { count: redacted.length };
  if (!redacted || typeof redacted !== 'object') return redacted;
  const body = redacted as Record<string, unknown>;
  return Object.fromEntries(Object.entries(body).filter(([key]) => !/refreshToken|accessToken|password|secret/i.test(key)).slice(0, 8));
}

function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /token|secret|password/i.test(key) ? '<redacted>' : redact(item),
      ]),
    );
  }
  return value;
}

function redactString(value: string) {
  let redacted = value;
  for (const env of Object.values(credentials)) {
    for (const [key, secret] of Object.entries(env)) {
      if (isSensitiveCredentialKey(key) && secret) redacted = redacted.split(secret).join('<redacted>');
    }
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>')
    .replace(/[0-9a-f]{64}/g, '<redacted-hex-token>');
}

function findSecretLeaks() {
  const text = JSON.stringify(report);
  const leaks: string[] = [];
  for (const env of Object.values(credentials)) {
    for (const [key, secret] of Object.entries(env)) {
      if (isSensitiveCredentialKey(key) && secret && text.includes(secret)) leaks.push(key);
    }
  }
  if (/Bearer\s+[A-Za-z0-9._-]+/.test(text)) leaks.push('bearer-token-pattern');
  if (/"secret"\s*:\s*"[0-9a-f]{64}"/.test(text)) leaks.push('api-secret-pattern');
  return leaks;
}

function isSensitiveCredentialKey(key: string) {
  return /password|token|secret|jwt|refresh/i.test(key);
}

function scrubPath(path: string) {
  return path.replace(/[0-9a-f]{64}/g, '<docker-id>');
}

function decodeConsoleData(value: string) {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return value;
  }
}

function describeError(error: unknown) {
  return redactString(error instanceof Error ? error.message : String(error));
}

function classifyFailure(error: unknown): Report['status'] {
  const message = describeError(error);
  if (/fetch failed|ECONNREFUSED|Agent offline|Service Unavailable|websocket/i.test(message)) return 'fail-infra';
  return 'fail-product';
}

function shortId(id: string) {
  return id.slice(0, 12);
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function escapeMd(value: string) {
  return value.replace(/[|\\]/g, (ch) => `\\${ch}`).replace(/\n/g, ' ');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
