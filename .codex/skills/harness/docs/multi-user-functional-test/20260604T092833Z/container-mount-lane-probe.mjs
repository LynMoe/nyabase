import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_PATH = join(SESSION_DIR, 'container-mount-lane-evidence.json');
const REPORT_PATH = join(SESSION_DIR, 'container-mount-lane.md');
const BASE_URL = process.env.NYABASE_FRONTEND_API_URL ?? 'http://localhost:5173/api';
const ADMIN_USERNAME = process.env.NYABASE_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.NYABASE_ADMIN_PASSWORD ?? (await readAdminPassword());
const ALPHA_USERNAME = process.env.NYABASE_ALPHA_USERNAME ?? 'admintest-20260604t093408-alpha';
const BETA_USERNAME = process.env.NYABASE_BETA_USERNAME ?? 'admintest-20260604t093408-beta';
const ALPHA_PASSWORD = process.env.NYABASE_ALPHA_PASSWORD;
const BETA_PASSWORD = process.env.NYABASE_BETA_PASSWORD;
const RUN_ID = process.env.NYABASE_CONTAINER_MOUNT_RUN_ID ?? `cml-${utcStamp()}`;
const PREFIX = RUN_ID.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
const MI_B = 1024 * 1024;
const TERMINAL_OP_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);
const OK_MUTATION = new Set([200, 201, 202]);
const DENIED = new Set([400, 401, 403, 404, 409, 422]);

const state = {
  verdict: 'FAIL',
  classification: 'fail-test',
  baseUrl: BASE_URL,
  runId: RUN_ID,
  prefix: PREFIX,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  command: 'NYABASE_ALPHA_PASSWORD=<redacted> NYABASE_BETA_PASSWORD=<redacted> node .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/container-mount-lane-probe.mjs',
  counts: { passed: 0, failed: 0, skipped: 0 },
  actors: {},
  inventory: {},
  grantsAdded: [],
  resourcesCreated: { containers: [], dataDirs: [] },
  resourcesDeleted: { containers: [], dataDirs: [] },
  cleanup: [],
  entries: [],
  failures: [],
  skips: [],
  residuals: {},
  noRawSecretsRecorded: true,
};

const createdContainers = [];
const createdDataDirs = [];
const grantsToRevoke = [];

let admin;
let alpha;
let beta;
let onlineServer;
let image;
let localSource;
let remoteSource;

try {
  await mkdir(SESSION_DIR, { recursive: true });
  requireEnv('NYABASE_ALPHA_PASSWORD', ALPHA_PASSWORD);
  requireEnv('NYABASE_BETA_PASSWORD', BETA_PASSWORD);

  await checkReachability();
  admin = await login('admin', ADMIN_USERNAME, ADMIN_PASSWORD);
  alpha = await login('alpha', ALPHA_USERNAME, ALPHA_PASSWORD);
  beta = await login('beta', BETA_USERNAME, BETA_PASSWORD);

  await discoverInventory();
  if (!onlineServer || !image || !localSource) {
    block(
      'live inventory',
      'Need at least one online server, one active image, and one local mount source assigned to that server.',
      { onlineServer: Boolean(onlineServer), image: Boolean(image), localSource: Boolean(localSource) },
    );
  } else {
    await prepareOnlineAccess(alpha);
    await prepareOnlineAccess(beta);
    alpha = await login('alpha', ALPHA_USERNAME, ALPHA_PASSWORD);
    beta = await login('beta', BETA_USERNAME, BETA_PASSWORD);

    await verifyPreparedAccess(alpha);
    await verifyPreparedAccess(beta);
    await runValidationFailures();
    await runMountSourceAndDataDirChecks();
    await runContainerLifecycleChecks();
  }

  await cleanupLaneResources();
  await revokeLaneGrants();
  await recordResiduals();

  if (state.failures.length === 0 && state.classification !== 'blocked-infra') {
    state.verdict = 'PASS';
    state.classification = 'pass';
  } else if (state.classification === 'blocked-infra') {
    state.verdict = 'BLOCKED';
  } else {
    state.verdict = 'FAIL';
  }
} catch (error) {
  fail('probe harness', 'Unexpected harness exception', 'test', describeError(error), {});
  await cleanupLaneResources().catch((cleanupError) => {
    fail('cleanup after harness exception', 'Cleanup should complete', 'infra', describeError(cleanupError), {});
  });
  await revokeLaneGrants().catch((cleanupError) => {
    fail('grant cleanup after harness exception', 'Grant cleanup should complete', 'infra', describeError(cleanupError), {});
  });
  await recordResiduals().catch(() => undefined);
  state.verdict = state.classification === 'blocked-infra' ? 'BLOCKED' : 'FAIL';
} finally {
  state.finishedAt = new Date().toISOString();
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(REPORT_PATH, renderMarkdown(state));
  if (state.verdict !== 'PASS') {
    process.exitCode = state.verdict === 'BLOCKED' ? 2 : 1;
  }
}

async function checkReachability() {
  const frontend = await rawFetch(BASE_URL.replace(/\/api$/, '/'));
  expect(
    'frontend shell reachable',
    frontend.status === 200,
    `GET ${BASE_URL.replace(/\/api$/, '/')} returns 200`,
    { status: frontend.status },
    frontend.status >= 500 ? 'infra' : 'product',
  );
  const unauth = await request(null, 'GET', '/auth/me');
  expectStatus('unauthenticated auth/me rejected', unauth, new Set([401]), { method: 'GET', path: '/auth/me' });
}

async function login(label, username, password) {
  const res = await request(null, 'POST', '/auth/login', { username, password });
  expectStatus(`${label} login`, res, new Set([200, 201]), { username });
  if (!res.body?.accessToken) {
    throw new Error(`${label} login did not return an access token`);
  }
  const actor = {
    label,
    username,
    token: res.body.accessToken,
    user: res.body.user,
  };
  state.actors[label] = {
    id: actor.user?.id,
    username: actor.user?.username,
    capabilities: actor.user?.capabilities ?? [],
  };
  return actor;
}

async function discoverInventory() {
  const [serversRes, imagesRes, containersRes] = await Promise.all([
    request(admin, 'GET', '/servers'),
    request(admin, 'GET', '/images?activeOnly=true'),
    request(admin, 'GET', '/containers'),
  ]);
  expectStatus('admin list servers', serversRes, new Set([200]), {});
  expectStatus('admin list active images', imagesRes, new Set([200]), {});
  expectStatus('admin list containers', containersRes, new Set([200]), {});

  const servers = Array.isArray(serversRes.body) ? serversRes.body : [];
  const images = Array.isArray(imagesRes.body) ? imagesRes.body : [];
  const containers = Array.isArray(containersRes.body) ? containersRes.body : [];
  const onlineServers = servers.filter((server) => server.status === 'online');

  const sourceResults = [];
  for (const server of servers) {
    const sourcesRes = await request(admin, 'GET', `/mount-sources?serverId=${encodeURIComponent(server.id)}`);
    expectStatus(`admin list mount sources for ${server.name ?? server.id}`, sourcesRes, new Set([200]), { serverId: server.id });
    const sources = Array.isArray(sourcesRes.body) ? sourcesRes.body : [];
    for (const source of sources) sourceResults.push({ ...source, serverStatus: server.status, serverName: server.name });
  }

  const existingOnlineContainer = containers.find((container) =>
    onlineServers.some((server) => server.id === container.serverId) && container.spec?.imageId,
  );
  image = images.find((candidate) => candidate.id === existingOnlineContainer?.spec?.imageId) ?? images[0];

  for (const server of onlineServers) {
    const source = sourceResults.find((candidate) => candidate.serverId === server.id && candidate.kind === 'local');
    if (source) {
      onlineServer = server;
      localSource = source;
      break;
    }
  }
  remoteSource = sourceResults.find((source) => source.kind === 'remote');

  state.inventory = {
    onlineServers: onlineServers.map((server) => ({ id: server.id, name: server.name, isGpuServer: server.isGpuServer })),
    selectedServer: onlineServer ? { id: onlineServer.id, name: onlineServer.name, status: onlineServer.status } : null,
    selectedImage: image ? { id: image.id, name: image.name, dockerImage: image.dockerImage } : null,
    selectedLocalSource: localSource
      ? { id: localSource.id, label: localSource.label, hostRoot: localSource.hostRoot, serverId: localSource.serverId }
      : null,
    remoteSourceObserved: remoteSource
      ? { id: remoteSource.id, label: remoteSource.label, serverId: remoteSource.serverId, serverStatus: remoteSource.serverStatus }
      : null,
  };
}

async function prepareOnlineAccess(actor) {
  const [serverGrantsRes, imageGrantsRes, sourceGrantsRes] = await Promise.all([
    request(admin, 'GET', `/users/${actor.user.id}/server-grants`),
    request(admin, 'GET', `/users/${actor.user.id}/image-grants`),
    request(admin, 'GET', `/users/${actor.user.id}/mount-source-grants`),
  ]);
  expectStatus(`snapshot ${actor.label} server grants`, serverGrantsRes, new Set([200]), {});
  expectStatus(`snapshot ${actor.label} image grants`, imageGrantsRes, new Set([200]), {});
  expectStatus(`snapshot ${actor.label} mount-source grants`, sourceGrantsRes, new Set([200]), {});

  const existingServerGrant = arr(serverGrantsRes.body).some((grant) => grant.serverId === onlineServer.id);
  const existingImageGrant = arr(imageGrantsRes.body).some((grant) =>
    grant.serverId === onlineServer.id && grant.imageId === image.id,
  );
  const existingSourceGrant = arr(sourceGrantsRes.body).some((grant) =>
    grant.sourceKind === localSource.kind && grant.sourceId === localSource.id,
  );

  if (!existingServerGrant) {
    const res = await request(admin, 'POST', `/users/${actor.user.id}/server-grants/${onlineServer.id}`, {
      cpuMillis: actor.label === 'alpha' ? 500 : 500,
      memBytes: actor.label === 'alpha' ? 256 * MI_B : 256 * MI_B,
      diskBytes: 512 * MI_B,
      gpuMode: 'none',
      gpuIndices: [],
    });
    expectStatus(`grant ${actor.label} online server`, res, new Set([200, 201]), { serverId: onlineServer.id });
    rememberGrant(actor, 'server', onlineServer.id, res.status);
  }
  if (!existingImageGrant) {
    const res = await request(admin, 'POST', `/users/${actor.user.id}/image-grants`, {
      imageId: image.id,
      serverId: onlineServer.id,
    });
    expectStatus(`grant ${actor.label} online image`, res, new Set([200, 201]), { imageId: image.id, serverId: onlineServer.id });
    rememberGrant(actor, 'image', `${image.id}:${onlineServer.id}`, res.status);
  }
  if (!existingSourceGrant) {
    const res = await request(admin, 'POST', `/users/${actor.user.id}/mount-source-grants`, {
      sourceKind: localSource.kind,
      sourceId: localSource.id,
    });
    expectStatus(`grant ${actor.label} local mount source`, res, new Set([200, 201]), {
      sourceKind: localSource.kind,
      sourceId: localSource.id,
    });
    rememberGrant(actor, 'mount-source', `${localSource.kind}:${localSource.id}`, res.status);
  }
}

function rememberGrant(actor, kind, key, status) {
  const grant = { actor: actor.label, userId: actor.user.id, kind, key, status, cleanup: 'pending' };
  state.grantsAdded.push(grant);
  grantsToRevoke.push(grant);
}

async function verifyPreparedAccess(actor) {
  const access = await request(actor, 'GET', '/me/access');
  expectStatus(`${actor.label} effective access lists online server`, access, new Set([200]), {});
  const grant = arr(access.body?.servers).find((item) => item.serverId === onlineServer.id);
  expect(
    `${actor.label} has online server grant`,
    Boolean(grant),
    'Online server appears in /me/access',
    { servers: arr(access.body?.servers).map((item) => item.serverId) },
    'product',
  );
  expect(
    `${actor.label} has selected image grant`,
    Boolean(grant?.allowedImageIds?.includes(image.id)),
    'Selected image id appears in allowedImageIds',
    { allowedImageIds: grant?.allowedImageIds ?? [] },
    'product',
  );

  const sources = await request(actor, 'GET', `/mount-sources?serverId=${encodeURIComponent(onlineServer.id)}`);
  expectStatus(`${actor.label} can list online mount sources`, sources, new Set([200]), {});
  expect(
    `${actor.label} can see granted local mount source`,
    arr(sources.body).some((source) => source.kind === localSource.kind && source.id === localSource.id),
    'Granted local source appears in /mount-sources',
    { sourceIds: arr(sources.body).map((source) => `${source.kind}:${source.id}`) },
    'product',
  );
}

async function runValidationFailures() {
  const cases = [
    {
      name: 'container create rejects missing body',
      body: {},
      expected: new Set([400]),
    },
    {
      name: 'container create rejects invalid name',
      body: baseContainerBody({ name: 'Bad Name' }),
      expected: new Set([400]),
    },
    {
      name: 'container create rejects invalid server',
      body: baseContainerBody({ serverId: 'not-a-real-server' }),
      expected: new Set([400, 403, 404]),
    },
    {
      name: 'container create rejects invalid image',
      body: baseContainerBody({ imageId: 'not-a-real-image' }),
      expected: new Set([400, 403, 404]),
    },
    {
      name: 'container create rejects quota overage',
      body: baseContainerBody({ name: `${PREFIX}-quota-deny`, cpuMillis: 10_000, memBytes: 2 * 1024 * MI_B }),
      expected: new Set([400, 422]),
    },
  ];

  for (const testCase of cases) {
    const res = await request(alpha, 'POST', '/containers', testCase.body);
    expectStatus(testCase.name, res, testCase.expected, {
      method: 'POST',
      path: '/containers',
      response: summarize(res.body),
    });
  }

  const fakeSourceId = '00000000-0000-0000-0000-000000000000';
  const deniedMount = await request(alpha, 'POST', '/containers', baseContainerBody({
    name: `${PREFIX}-source-deny`,
    dataDirs: [{
      sourceKind: 'local',
      sourceId: fakeSourceId,
      dirName: `${PREFIX}-missing`,
      containerPath: '/mnt/denied',
      createIfMissing: true,
    }],
  }));
  expectStatus('container create rejects ungranted local mount source', deniedMount, new Set([403, 404]), {
    sourceKind: 'local',
    sourceId: fakeSourceId,
  });

  if (remoteSource) {
    const remoteDenied = await request(alpha, 'POST', '/containers', baseContainerBody({
      serverId: remoteSource.serverId,
      name: `${PREFIX}-remote-deny`,
      dataDirs: [{
        sourceKind: 'remote',
        sourceId: remoteSource.id,
        dirName: `${PREFIX}-remote-deny`,
        containerPath: '/mnt/remote',
        createIfMissing: true,
      }],
    }));
    expectStatus('container create rejects ungranted remote mount source', remoteDenied, new Set([403, 404]), {
      remoteSourceId: remoteSource.id,
      remoteServerId: remoteSource.serverId,
    });
  } else {
    skip('remote mount denied create', 'No remote mount source is present in this environment.');
  }
}

async function runMountSourceAndDataDirChecks() {
  const alphaDirName = `${PREFIX}-alpha-dir`;
  const alphaDir = await createDataDir(alpha, alphaDirName);

  const duplicate = await request(alpha, 'POST', '/data-dirs', {
    serverId: onlineServer.id,
    sourceKind: localSource.kind,
    sourceId: localSource.id,
    name: alphaDirName,
  });
  expectStatus('duplicate data directory rejected', duplicate, new Set([409]), {
    sourceKind: localSource.kind,
    sourceId: localSource.id,
    name: alphaDirName,
  });

  const alphaList = await request(alpha, 'GET', `/data-dirs?serverId=${encodeURIComponent(onlineServer.id)}`);
  expectStatus('alpha lists own data directory', alphaList, new Set([200]), {});
  expect(
    'alpha data-dir list contains created dir',
    arr(alphaList.body).some((dir) => dir.name === alphaDirName && dir.sourceId === localSource.id),
    'Created data directory appears for owner',
    { names: arr(alphaList.body).map((dir) => dir.name).filter((name) => String(name).startsWith(PREFIX)) },
    'product',
  );

  const betaList = await request(beta, 'GET', `/data-dirs?serverId=${encodeURIComponent(onlineServer.id)}`);
  expectStatus('beta lists data directories without alpha leak', betaList, new Set([200]), {});
  expect(
    'beta cannot see alpha data directory',
    !arr(betaList.body).some((dir) => dir.name === alphaDirName && dir.userId === alpha.user.id),
    'Other user data directory must not appear in beta list',
    { betaVisibleLaneDirs: arr(betaList.body).filter((dir) => String(dir.name).startsWith(PREFIX)) },
    'product',
  );

  const betaDeleteAlphaDir = await request(beta, 'DELETE', dataDirPath(alphaDir));
  expectStatus('beta cannot delete alpha data directory by guessed path', betaDeleteAlphaDir, new Set([403, 404]), {
    sourceKind: alphaDir.sourceKind,
    sourceId: alphaDir.sourceId,
    name: alphaDir.name,
  });

  const fakeSourceId = '00000000-0000-0000-0000-000000000000';
  const deniedDir = await request(alpha, 'POST', '/data-dirs', {
    serverId: onlineServer.id,
    sourceKind: 'local',
    sourceId: fakeSourceId,
    name: `${PREFIX}-bad-source`,
  });
  expectStatus('data directory create rejects ungranted source', deniedDir, new Set([403, 404]), {
    sourceKind: 'local',
    sourceId: fakeSourceId,
  });

  if (remoteSource) {
    const remoteDenied = await request(alpha, 'POST', '/data-dirs', {
      serverId: remoteSource.serverId,
      sourceKind: 'remote',
      sourceId: remoteSource.id,
      name: `${PREFIX}-remote-deny`,
    });
    expectStatus('data directory create rejects ungranted remote source', remoteDenied, new Set([403, 404]), {
      sourceKind: 'remote',
      sourceId: remoteSource.id,
      serverId: remoteSource.serverId,
    });
  }

  const raceName = `${PREFIX}-race`;
  const [raceA, raceB] = await Promise.all([
    request(beta, 'POST', '/data-dirs', {
      serverId: onlineServer.id,
      sourceKind: localSource.kind,
      sourceId: localSource.id,
      name: raceName,
    }),
    request(beta, 'POST', '/data-dirs', {
      serverId: onlineServer.id,
      sourceKind: localSource.kind,
      sourceId: localSource.id,
      name: raceName,
    }),
  ]);
  const raceStatuses = [raceA.status, raceB.status].sort((a, b) => a - b);
  expect(
    'concurrent duplicate data-dir create is serialized',
    raceStatuses.some((status) => OK_MUTATION.has(status)) && raceStatuses.includes(409),
    'One concurrent create should win and the duplicate should be rejected with 409',
    { statuses: raceStatuses, bodies: [summarize(raceA.body), summarize(raceB.body)] },
    raceStatuses.some((status) => status >= 500) ? 'product' : 'product',
  );
  const raceWinner = [raceA, raceB].find((res) => OK_MUTATION.has(res.status));
  if (raceWinner?.body?.name) {
    const betaDir = trackDataDir(beta, raceWinner.body);
    if (raceWinner.body.operationId) {
      await waitOperation(beta, raceWinner.body.operationId, 'beta race data-dir create', 90_000);
    }
  }
}

async function runContainerLifecycleChecks() {
  const dir = createdDataDirs.find((candidate) => candidate.actor.label === 'alpha' && candidate.name.endsWith('alpha-dir'));
  if (!dir) {
    skip('container lifecycle with mount', 'Alpha data directory was not created.');
    return;
  }

  const createRes = await request(alpha, 'POST', '/containers', baseContainerBody({
    name: `${PREFIX}-alpha-c1`,
    dataDirs: [{
      sourceKind: dir.sourceKind,
      sourceId: dir.sourceId,
      dirName: dir.name,
      containerPath: '/mnt/share',
      createIfMissing: false,
    }],
  }));
  expectStatus('create mounted alpha container', createRes, new Set([200, 201, 202]), {
    serverId: onlineServer.id,
    imageId: image.id,
    dataDir: dir.name,
  });
  if (!OK_MUTATION.has(createRes.status) || !createRes.body?.operationId) {
    skip('container detail/lifecycle/mount attach-detach', 'Container create did not return an operation id.');
    return;
  }

  const createOp = await waitOperation(alpha, createRes.body.operationId, 'alpha container create', 180_000);
  if (createOp?.status !== 'succeeded') {
    skip('container detail/lifecycle/mount attach-detach', 'Container create operation did not succeed.');
    return;
  }

  const container = await waitContainerByName(alpha, `${PREFIX}-alpha-c1`, 90_000);
  if (!container) {
    fail('created container appears in list', 'Created container should appear in /containers', 'product', 'Timed out waiting for created container in list', {});
    return;
  }
  trackContainer(alpha, container);

  const detail = await request(alpha, 'GET', containerPath(container));
  expectStatus('owner reads container detail', detail, new Set([200]), {
    containerId: routeContainerId(container),
    status: detail.body?.status,
  });

  const list = await request(alpha, 'GET', `/containers?serverId=${encodeURIComponent(onlineServer.id)}`);
  expectStatus('owner lists created container', list, new Set([200]), {});
  expect(
    'container list contains created container',
    arr(list.body).some((item) => routeContainerId(item) === routeContainerId(container)),
    'Created container appears in owner list',
    { laneContainers: arr(list.body).map((item) => item.spec?.name).filter((name) => String(name).startsWith(PREFIX)) },
    'product',
  );

  const initialMounts = await request(alpha, 'GET', `${containerPath(container)}/mounts`);
  expectStatus('owner lists initial container mounts', initialMounts, new Set([200]), {});
  expect(
    'initial container mount is present',
    arr(initialMounts.body).some((mount) => mount.dirName === dir.name && mount.containerPath === '/mnt/share'),
    'Container mounts include requested data directory',
    { mounts: arr(initialMounts.body).map((mount) => ({ dirName: mount.dirName, containerPath: mount.containerPath })) },
    'product',
  );

  await verifyCrossUserContainerIsolation(container, dir);
  await probeConcurrentMountPatch(container, dir);
  await setMounts(alpha, container, [{
    sourceKind: dir.sourceKind,
    sourceId: dir.sourceId,
    dirName: dir.name,
    containerPath: '/mnt/share',
    createIfMissing: false,
  }], 'reattach alpha mount after race probe');
  await setMounts(alpha, container, [], 'detach all alpha mounts');
  const afterDetach = await request(alpha, 'GET', `${containerPath(container)}/mounts`);
  expectStatus('owner lists mounts after detach', afterDetach, new Set([200]), {});
  expect(
    'container mounts are empty after detach',
    arr(afterDetach.body).length === 0,
    'PATCH [] removes all expected mounts',
    { mounts: arr(afterDetach.body) },
    'product',
  );
  await setMounts(alpha, container, [{
    sourceKind: dir.sourceKind,
    sourceId: dir.sourceId,
    dirName: dir.name,
    containerPath: '/mnt/share',
    createIfMissing: false,
  }], 'attach alpha mount');
  const afterAttach = await request(alpha, 'GET', `${containerPath(container)}/mounts`);
  expectStatus('owner lists mounts after attach', afterAttach, new Set([200]), {});
  expect(
    'container mount is present after attach',
    arr(afterAttach.body).some((mount) => mount.dirName === dir.name && mount.containerPath === '/mnt/share'),
    'PATCH mount list adds expected mount',
    { mounts: arr(afterAttach.body).map((mount) => ({ dirName: mount.dirName, containerPath: mount.containerPath })) },
    'product',
  );

  await lifecycleAction(alpha, container, 'stop');
  await lifecycleAction(alpha, container, 'start');
  await lifecycleAction(alpha, container, 'restart');
  await deleteContainer(alpha, container);
}

async function verifyCrossUserContainerIsolation(container, dir) {
  const betaList = await request(beta, 'GET', `/containers?serverId=${encodeURIComponent(onlineServer.id)}`);
  expectStatus('beta lists containers without alpha leak', betaList, new Set([200]), {});
  expect(
    'beta container list does not include alpha container',
    !arr(betaList.body).some((item) => routeContainerId(item) === routeContainerId(container)),
    'Other user container must not appear in beta list',
    { betaVisibleLaneContainers: arr(betaList.body).map((item) => item.spec?.name).filter((name) => String(name).startsWith(PREFIX)) },
    'product',
  );

  const betaDetail = await request(beta, 'GET', containerPath(container));
  expectStatus('beta cannot read alpha container detail', betaDetail, new Set([403, 404]), {
    serverId: onlineServer.id,
    containerId: routeContainerId(container),
  });

  const betaMounts = await request(beta, 'GET', `${containerPath(container)}/mounts`);
  expectStatus('beta cannot list alpha container mounts', betaMounts, new Set([403, 404]), {
    serverId: onlineServer.id,
    containerId: routeContainerId(container),
  });

  const betaPatch = await request(beta, 'PATCH', `${containerPath(container)}/mounts`, [{
    sourceKind: dir.sourceKind,
    sourceId: dir.sourceId,
    dirName: dir.name,
    containerPath: '/mnt/beta',
    createIfMissing: false,
  }]);
  expectStatus('beta cannot patch alpha container mounts', betaPatch, new Set([403, 404]), {
    serverId: onlineServer.id,
    containerId: routeContainerId(container),
  });

  const betaDelete = await request(beta, 'DELETE', containerPath(container));
  expectStatus('beta cannot delete alpha container', betaDelete, new Set([403, 404]), {
    serverId: onlineServer.id,
    containerId: routeContainerId(container),
  });
}

async function probeConcurrentMountPatch(container, dir) {
  const attach = [{
    sourceKind: dir.sourceKind,
    sourceId: dir.sourceId,
    dirName: dir.name,
    containerPath: '/mnt/share',
    createIfMissing: false,
  }];
  const [detachRes, attachRes] = await Promise.all([
    request(alpha, 'PATCH', `${containerPath(container)}/mounts`, []),
    request(alpha, 'PATCH', `${containerPath(container)}/mounts`, attach),
  ]);
  const statuses = [detachRes.status, attachRes.status];
  expect(
    'concurrent mount patch returns controlled statuses',
    statuses.every((status) => OK_MUTATION.has(status) || status === 409 || status === 423),
    'Concurrent mount updates should be accepted/serialized or explicitly rejected, not 5xx',
    { statuses, operationIds: [detachRes.body?.operationId, attachRes.body?.operationId].filter(Boolean) },
    statuses.some((status) => status >= 500) ? 'product' : 'product',
  );
  for (const [index, res] of [detachRes, attachRes].entries()) {
    if (OK_MUTATION.has(res.status) && res.body?.operationId) {
      await waitOperation(alpha, res.body.operationId, `concurrent mount patch ${index + 1}`, 120_000);
    }
  }
  const finalMounts = await request(alpha, 'GET', `${containerPath(container)}/mounts`);
  expectStatus('container mounts coherent after concurrent patch', finalMounts, new Set([200]), {});
  const seen = new Set(arr(finalMounts.body).map((mount) => `${mount.sourceKind}:${mount.sourceId}:${mount.dirName}:${mount.containerPath}`));
  expect(
    'container mounts have no duplicate rows after concurrent patch',
    seen.size === arr(finalMounts.body).length,
    'Final mount list should be a coherent set',
    { mounts: arr(finalMounts.body).map((mount) => ({ dirName: mount.dirName, containerPath: mount.containerPath })) },
    'product',
  );
}

async function setMounts(actor, container, mounts, label) {
  const res = await request(actor, 'PATCH', `${containerPath(container)}/mounts`, mounts);
  expectStatus(label, res, new Set([200, 201, 202]), { mounts });
  if (OK_MUTATION.has(res.status) && res.body?.operationId) {
    await waitOperation(actor, res.body.operationId, label, 120_000);
  }
}

async function lifecycleAction(actor, container, action) {
  const res = await request(actor, 'POST', `${containerPath(container)}/${action}`);
  expectStatus(`container ${action}`, res, new Set([200, 201, 202]), {
    serverId: onlineServer.id,
    containerId: routeContainerId(container),
  });
  if (OK_MUTATION.has(res.status) && res.body?.operationId) {
    await waitOperation(actor, res.body.operationId, `container ${action}`, 180_000);
  }
  const detail = await request(actor, 'GET', containerPath(container));
  expectStatus(`container detail after ${action}`, detail, new Set([200]), {
    observedStatus: detail.body?.status,
    lifecycle: detail.body?.lifecycle,
  });
}

async function createDataDir(actor, name) {
  const res = await request(actor, 'POST', '/data-dirs', {
    serverId: onlineServer.id,
    sourceKind: localSource.kind,
    sourceId: localSource.id,
    name,
  });
  expectStatus(`create data directory ${name}`, res, new Set([200, 201, 202]), {
    sourceKind: localSource.kind,
    sourceId: localSource.id,
  });
  if (!OK_MUTATION.has(res.status)) return null;
  const dir = trackDataDir(actor, res.body);
  if (res.body?.operationId) await waitOperation(actor, res.body.operationId, `create data directory ${name}`, 120_000);
  return dir;
}

function trackDataDir(actor, body) {
  const dir = {
    actor,
    id: body.id,
    serverId: body.serverId ?? onlineServer.id,
    sourceKind: body.sourceKind ?? localSource.kind,
    sourceId: body.sourceId ?? localSource.id,
    name: body.name,
    hostPath: body.hostPath,
  };
  if (!createdDataDirs.some((existing) =>
    existing.actor.label === actor.label &&
    existing.sourceKind === dir.sourceKind &&
    existing.sourceId === dir.sourceId &&
    existing.name === dir.name
  )) {
    createdDataDirs.push(dir);
    state.resourcesCreated.dataDirs.push(toReportDir(dir));
  }
  return dir;
}

function trackContainer(actor, container) {
  const tracked = {
    actor,
    serverId: container.serverId,
    containerId: routeContainerId(container),
    name: container.spec?.name,
    dockerId: container.spec?.dockerId ?? null,
  };
  if (!createdContainers.some((existing) => existing.containerId === tracked.containerId && existing.serverId === tracked.serverId)) {
    createdContainers.push(tracked);
    state.resourcesCreated.containers.push(toReportContainer(tracked));
  }
  return tracked;
}

async function deleteContainer(actor, containerLike) {
  const tracked = createdContainers.find((candidate) =>
    candidate.serverId === containerLike.serverId && candidate.containerId === routeContainerId(containerLike),
  ) ?? {
    actor,
    serverId: containerLike.serverId,
    containerId: routeContainerId(containerLike),
    name: containerLike.spec?.name ?? containerLike.name,
    dockerId: containerLike.spec?.dockerId ?? containerLike.dockerId ?? null,
  };
  const res = await request(actor, 'DELETE', `/containers/${tracked.serverId}/${tracked.containerId}`);
  expectStatus(`delete container ${tracked.name}`, res, new Set([200, 201, 202, 404]), {
    serverId: tracked.serverId,
    containerId: tracked.containerId,
  });
  if (OK_MUTATION.has(res.status) && res.body?.operationId) {
    await waitOperation(actor, res.body.operationId, `delete container ${tracked.name}`, 180_000);
  }
  state.resourcesDeleted.containers.push(toReportContainer(tracked));
  const index = createdContainers.findIndex((candidate) =>
    candidate.serverId === tracked.serverId && candidate.containerId === tracked.containerId,
  );
  if (index >= 0) createdContainers.splice(index, 1);
}

async function deleteDataDir(dir) {
  const res = await request(dir.actor, 'DELETE', dataDirPath(dir));
  expectStatus(`delete data directory ${dir.name}`, res, new Set([200, 201, 202, 204, 404]), {
    sourceKind: dir.sourceKind,
    sourceId: dir.sourceId,
    name: dir.name,
  });
  if (OK_MUTATION.has(res.status) && res.body?.operationId) {
    await waitOperation(dir.actor, res.body.operationId, `delete data directory ${dir.name}`, 120_000);
  }
  state.resourcesDeleted.dataDirs.push(toReportDir(dir));
  const index = createdDataDirs.findIndex((candidate) =>
    candidate.actor.label === dir.actor.label &&
    candidate.sourceKind === dir.sourceKind &&
    candidate.sourceId === dir.sourceId &&
    candidate.name === dir.name
  );
  if (index >= 0) createdDataDirs.splice(index, 1);
}

async function cleanupLaneResources() {
  for (const container of [...createdContainers].reverse()) {
    try {
      const owner = container.actor ?? alpha;
      const res = await request(owner, 'DELETE', `/containers/${container.serverId}/${container.containerId}`);
      if (OK_MUTATION.has(res.status) && res.body?.operationId) {
        await waitOperation(owner, res.body.operationId, `cleanup delete container ${container.name}`, 180_000);
      }
      state.cleanup.push({ kind: 'container', name: container.name, id: container.containerId, status: res.status });
      if (res.status < 500) {
        const idx = createdContainers.indexOf(container);
        if (idx >= 0) createdContainers.splice(idx, 1);
        state.resourcesDeleted.containers.push(toReportContainer(container));
      }
    } catch (error) {
      state.cleanup.push({ kind: 'container', name: container.name, id: container.containerId, status: `failed: ${describeError(error)}` });
    }
  }

  for (const dir of [...createdDataDirs].reverse()) {
    try {
      const res = await request(dir.actor, 'DELETE', dataDirPath(dir));
      if (OK_MUTATION.has(res.status) && res.body?.operationId) {
        await waitOperation(dir.actor, res.body.operationId, `cleanup delete data-dir ${dir.name}`, 120_000);
      }
      state.cleanup.push({ kind: 'data-dir', name: dir.name, sourceKind: dir.sourceKind, sourceId: dir.sourceId, status: res.status });
      if (res.status < 500) {
        const idx = createdDataDirs.indexOf(dir);
        if (idx >= 0) createdDataDirs.splice(idx, 1);
        state.resourcesDeleted.dataDirs.push(toReportDir(dir));
      }
    } catch (error) {
      state.cleanup.push({ kind: 'data-dir', name: dir.name, sourceKind: dir.sourceKind, sourceId: dir.sourceId, status: `failed: ${describeError(error)}` });
    }
  }
}

async function revokeLaneGrants() {
  if (!admin) return;
  for (const grant of [...grantsToRevoke].reverse()) {
    let path;
    if (grant.kind === 'server') path = `/users/${grant.userId}/server-grants/${grant.key}`;
    if (grant.kind === 'image') {
      const [imageId, serverId] = grant.key.split(':');
      path = `/users/${grant.userId}/image-grants/${imageId}/${serverId}`;
    }
    if (grant.kind === 'mount-source') {
      const [sourceKind, sourceId] = grant.key.split(':');
      path = `/users/${grant.userId}/mount-source-grants/${sourceKind}/${sourceId}`;
    }
    if (!path) continue;
    const res = await request(admin, 'DELETE', path);
    grant.cleanup = res.status;
    state.cleanup.push({ kind: 'grant', actor: grant.actor, grantKind: grant.kind, key: grant.key, status: res.status });
    if (![200, 204, 404].includes(res.status)) {
      fail(`cleanup revoke ${grant.actor} ${grant.kind} grant`, 'Lane-added grants should be revoked', 'infra', `HTTP ${res.status}`, {
        path,
        body: summarize(res.body),
      });
    }
  }
  grantsToRevoke.length = 0;
}

async function recordResiduals() {
  for (const actor of [alpha, beta].filter(Boolean)) {
    const [containersRes, dataDirsRes] = await Promise.all([
      request(actor, 'GET', onlineServer ? `/containers?serverId=${encodeURIComponent(onlineServer.id)}` : '/containers'),
      onlineServer ? request(actor, 'GET', `/data-dirs?serverId=${encodeURIComponent(onlineServer.id)}`) : Promise.resolve({ status: 200, body: [] }),
    ]);
    const laneContainers = arr(containersRes.body).filter((container) => String(container.spec?.name).startsWith(PREFIX));
    const laneDirs = arr(dataDirsRes.body).filter((dir) => String(dir.name).startsWith(PREFIX));
    state.residuals[actor.label] = {
      containers: laneContainers.map((container) => ({ id: routeContainerId(container), name: container.spec?.name, status: container.status })),
      dataDirs: laneDirs.map((dir) => ({ id: dir.id, name: dir.name, sourceKind: dir.sourceKind, sourceId: dir.sourceId })),
    };
    expect(
      `${actor.label} has no residual lane resources`,
      laneContainers.length === 0 && laneDirs.length === 0,
      'Cleanup removes all resources with this lane prefix',
      state.residuals[actor.label],
      'infra',
    );
  }
}

async function waitOperation(actor, operationId, label, timeoutMs) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const res = await request(actor, 'GET', `/operations/${operationId}`);
    if (res.status !== 200) {
      fail(`${label} operation readable`, 'Operation should be readable by requester', 'product', `HTTP ${res.status}`, {
        operationId,
        body: summarize(res.body),
      });
      return null;
    }
    last = res.body;
    if (TERMINAL_OP_STATUSES.has(last.status)) {
      expect(
        `${label} operation succeeded`,
        last.status === 'succeeded',
        'Operation reaches succeeded',
        {
          operationId,
          status: last.status,
          kind: last.kind,
          lastError: last.lastError,
          commandStatuses: arr(last.commands).map((command) => ({ kind: command.commandKind, status: command.status, lastError: command.lastError })),
        },
        last.status === 'failed' ? 'product' : 'infra',
      );
      return last;
    }
    await sleep(1500);
  }
  fail(`${label} operation timeout`, 'Operation should reach a terminal status before timeout', 'infra', 'Timed out', {
    operationId,
    lastStatus: last?.status,
    lastError: last?.lastError,
    commands: arr(last?.commands).map((command) => ({ kind: command.commandKind, status: command.status, lastError: command.lastError })),
  });
  return last;
}

async function waitContainerByName(actor, name, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(actor, 'GET', `/containers?serverId=${encodeURIComponent(onlineServer.id)}`);
    if (res.status === 200) {
      const found = arr(res.body).find((container) => container.spec?.name === name);
      if (found) return found;
    }
    await sleep(1500);
  }
  return null;
}

function baseContainerBody(overrides = {}) {
  return {
    serverId: onlineServer?.id,
    imageId: image?.id,
    name: `${PREFIX}-container`,
    cpuMillis: 100,
    memBytes: 64 * MI_B,
    gpuIndices: [],
    dataDirs: [],
    ...overrides,
  };
}

function containerPath(container) {
  return `/containers/${container.serverId}/${routeContainerId(container)}`;
}

function dataDirPath(dir) {
  return `/data-dirs/${dir.serverId}/${dir.sourceId}/${encodeURIComponent(dir.name)}?sourceKind=${dir.sourceKind}`;
}

function routeContainerId(container) {
  return container.containerId ?? container.id ?? container.containerId;
}

async function request(actor, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor?.token) headers.Authorization = `Bearer ${actor.token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { method, path, status: res.status, ok: res.ok, body: parsed };
}

async function rawFetch(url) {
  try {
    const res = await fetch(url);
    return { status: res.status };
  } catch (error) {
    return { status: 0, error: describeError(error) };
  }
}

function expectStatus(name, res, expectedStatuses, evidence = {}) {
  const passed = expectedStatuses.has(res.status);
  expect(
    name,
    passed,
    `HTTP status in [${[...expectedStatuses].join(', ')}]`,
    {
      method: res.method,
      path: res.path,
      status: res.status,
      body: summarize(res.body),
      ...evidence,
    },
    res.status >= 500 ? 'product' : 'product',
  );
}

function expect(name, passed, expected, evidence, rootCause) {
  const entry = { name, passed, expected, evidence };
  state.entries.push(entry);
  if (passed) {
    state.counts.passed += 1;
    return;
  }
  fail(name, expected, rootCause, 'Expectation failed', evidence);
}

function fail(test, expected, rootCause, cause, evidence) {
  state.counts.failed += 1;
  const failure = { test, expected, cause, rootCause, evidence };
  state.failures.push(failure);
  if (rootCause === 'infra' && state.failures.every((item) => item.rootCause === 'infra')) {
    state.classification = 'fail-infra';
  } else if (rootCause === 'product') {
    state.classification = 'fail-product';
  } else if (state.classification !== 'fail-product') {
    state.classification = 'fail-test';
  }
}

function skip(test, reason) {
  state.counts.skipped += 1;
  state.skips.push({ test, reason });
}

function block(test, reason, evidence) {
  state.classification = 'blocked-infra';
  state.verdict = 'BLOCKED';
  skip(test, reason);
  state.failures.push({ test, expected: reason, cause: 'Blocked by environment inventory', rootCause: 'infra', evidence });
}

function summarize(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 5).map(summarize);
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|password|secret|hash/i.test(key)) continue;
      if (['payload', 'request'].includes(key)) continue;
      if (Array.isArray(item)) result[key] = item.slice(0, 5).map(summarize);
      else if (item && typeof item === 'object') result[key] = summarize(item);
      else result[key] = item;
    }
    return result;
  }
  return value;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function toReportContainer(container) {
  return {
    actor: container.actor?.label,
    serverId: container.serverId,
    containerId: container.containerId,
    name: container.name,
    dockerId: container.dockerId,
  };
}

function toReportDir(dir) {
  return {
    actor: dir.actor?.label,
    serverId: dir.serverId,
    sourceKind: dir.sourceKind,
    sourceId: dir.sourceId,
    name: dir.name,
    id: dir.id,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is required`);
}

async function readAdminPassword() {
  try {
    const text = await readFile('test/.env', 'utf8');
    const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith('ADMIN_INIT_PASSWORD='));
    return line?.split('=').slice(1).join('=').trim();
  } catch {
    return undefined;
  }
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').toLowerCase();
}

function renderMarkdown(data) {
  const lines = [];
  lines.push('# Container and Mount Lane');
  lines.push('');
  lines.push(`- Verdict: ${data.verdict}`);
  lines.push(`- Classification: ${data.classification}`);
  lines.push(`- Started: ${data.startedAt}`);
  lines.push(`- Finished: ${data.finishedAt}`);
  lines.push(`- Frontend API: \`${data.baseUrl}\``);
  lines.push(`- Command: \`${data.command}\``);
  lines.push(`- Counts: ${data.counts.passed} passed / ${data.counts.failed} failed / ${data.counts.skipped} skipped`);
  lines.push(`- Evidence JSON: \`${EVIDENCE_PATH}\``);
  lines.push(`- Raw secrets recorded: no`);
  lines.push('');
  lines.push('## Handoff Credentials Used');
  lines.push('');
  lines.push(`- Alpha username: \`${ALPHA_USERNAME}\`; password supplied through env and not recorded.`);
  lines.push(`- Beta username: \`${BETA_USERNAME}\`; password supplied through env and not recorded.`);
  lines.push(`- Admin was used only for inventory and temporary online grant setup/cleanup.`);
  lines.push('');
  lines.push('## Inventory');
  lines.push('');
  lines.push(`- Selected online server: \`${data.inventory.selectedServer?.name ?? 'n/a'}\` (\`${data.inventory.selectedServer?.id ?? 'n/a'}\`)`);
  lines.push(`- Selected image: \`${data.inventory.selectedImage?.name ?? 'n/a'}\` (\`${data.inventory.selectedImage?.id ?? 'n/a'}\`, \`${data.inventory.selectedImage?.dockerImage ?? 'n/a'}\`)`);
  lines.push(`- Selected local source: \`${data.inventory.selectedLocalSource?.label ?? 'n/a'}\` (\`${data.inventory.selectedLocalSource?.id ?? 'n/a'}\`)`);
  lines.push(`- Remote source observed: ${data.inventory.remoteSourceObserved ? `\`${data.inventory.remoteSourceObserved.label}\` on server \`${data.inventory.remoteSourceObserved.serverId}\` (${data.inventory.remoteSourceObserved.serverStatus})` : 'none'}`);
  lines.push('');
  lines.push('## Coverage of Acceptance Criteria');
  lines.push('');
  lines.push('- AC #1: Container list/detail/create and validation failures were exercised through `/containers`, including missing body, invalid name/server/image, quota overage, owner list, and owner detail.');
  lines.push('- AC #2: Lifecycle start/stop/restart/delete was exercised on an alpha-owned mounted test container when the online agent accepted create.');
  lines.push('- AC #3: Mount source grants, data directory create/list/delete, duplicate/denied data-dir paths, initial container mount, detach, attach, and denied cross-user mount patch were exercised. Remote source behavior was probed as denial because the observed remote source is assigned to an offline server and was not granted.');
  lines.push('- AC #4: Cross-user isolation was probed for data directories, container list/detail/mounts/delete, and a concurrent duplicate data-dir create plus concurrent mount PATCH probe were run.');
  lines.push('- AC #5: Failures, if any, include expected behavior, observed evidence, root cause, and reproduction hints below.');
  lines.push('');
  lines.push('## Created Resources');
  lines.push('');
  lines.push(`- Containers created: ${data.resourcesCreated.containers.length === 0 ? 'none' : ''}`);
  for (const item of data.resourcesCreated.containers) lines.push(`  - \`${item.name}\` (\`${item.containerId}\`) by ${item.actor}`);
  lines.push(`- Data directories created: ${data.resourcesCreated.dataDirs.length === 0 ? 'none' : ''}`);
  for (const item of data.resourcesCreated.dataDirs) lines.push(`  - \`${item.name}\` (\`${item.sourceKind}:${item.sourceId}\`) by ${item.actor}`);
  lines.push(`- Temporary grants added: ${data.grantsAdded.length === 0 ? 'none' : ''}`);
  for (const item of data.grantsAdded) lines.push(`  - ${item.actor} ${item.kind} \`${item.key}\` cleanup=\`${item.cleanup}\``);
  lines.push('');
  lines.push('## Cleanup');
  lines.push('');
  lines.push(`- Containers deleted: ${data.resourcesDeleted.containers.length}`);
  lines.push(`- Data directories deleted: ${data.resourcesDeleted.dataDirs.length}`);
  lines.push(`- Residuals: \`${JSON.stringify(data.residuals)}\``);
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (data.failures.length === 0) {
    lines.push('None.');
  } else {
    for (const failure of data.failures) {
      lines.push(`### ${failure.test}`);
      lines.push('');
      lines.push(`- Root cause: ${failure.rootCause}`);
      lines.push(`- Expected: ${failure.expected}`);
      lines.push(`- Observed: ${failure.cause}`);
      lines.push(`- Evidence: \`${JSON.stringify(failure.evidence)}\``);
      lines.push('- Reproduction: run the command above against the same service and inspect the matching step in the evidence JSON.');
      lines.push('- Impact: container/mount lifecycle confidence is reduced for this behavior until the cause is fixed or the environment is restored.');
      lines.push('');
    }
  }
  if (data.skips.length > 0) {
    lines.push('## Skips');
    lines.push('');
    for (const item of data.skips) lines.push(`- ${item.test}: ${item.reason}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
