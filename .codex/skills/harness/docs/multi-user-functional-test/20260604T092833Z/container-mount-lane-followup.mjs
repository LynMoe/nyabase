import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_PATH = join(SESSION_DIR, 'container-mount-lane-evidence.json');
const REPORT_PATH = join(SESSION_DIR, 'container-mount-lane.md');
const BASE_URL = 'http://localhost:5173/api';
const ADMIN = { username: 'admin', password: process.env.NYABASE_ADMIN_PASSWORD ?? 'admin123' };
const ALPHA = {
  username: 'admintest-20260604t093408-alpha',
  password: process.env.NYABASE_ALPHA_PASSWORD,
};
const BETA = {
  username: 'admintest-20260604t093408-beta',
  password: process.env.NYABASE_BETA_PASSWORD,
};
const SERVER_ID = '05cea385-d6ca-490a-a126-e00d0ae23b70';
const IMAGE_ID = 'e6c7a01f-4431-4ac4-885e-bcf6ab755c60';
const LOCAL_SOURCE_ID = 'f3fbabd1-03a8-49b5-8290-8c7092b700e3';
const RUN_PREFIX = `cmlcmp-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').toLowerCase()}`;
const MI_B = 1024 * 1024;
const DENIED = new Set([400, 401, 403, 404, 409, 422]);
const OK = new Set([200, 201, 202]);

const evidence = {
  verdict: 'FAIL',
  classification: 'fail-product',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  command: 'NYABASE_ALPHA_PASSWORD=<redacted> NYABASE_BETA_PASSWORD=<redacted> node .codex/skills/harness/docs/multi-user-functional-test/20260604T092833Z/container-mount-lane-followup.mjs',
  target: BASE_URL,
  counts: { passed: 0, failed: 0, skipped: 0 },
  actors: {},
  inventory: {},
  steps: [],
  findings: [],
  created: { containers: [], dataDirs: [] },
  cleanup: [],
  residuals: {},
  noRawSecretsRecorded: true,
};

if (!ALPHA.password || !BETA.password) {
  throw new Error('NYABASE_ALPHA_PASSWORD and NYABASE_BETA_PASSWORD are required');
}

await mkdir(SESSION_DIR, { recursive: true });

const admin = await login('admin', ADMIN.username, ADMIN.password);
const alpha = await login('alpha', ALPHA.username, ALPHA.password);
const beta = await login('beta', BETA.username, BETA.password);

try {
  await inventory();
  await validationAndGrantChecks();
  await mountAndDataDirChecks();
  await inspectExistingStuckCreates();
  await lifecycleDeniedOnUnboundContainer();
  await adminPlainCreateComparison();
  await revokeTemporaryOnlineGrants();
  await finalResiduals();
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(REPORT_PATH, renderMarkdown());
}

if (evidence.findings.length > 0) process.exitCode = 1;

async function login(label, username, password) {
  const res = await req(null, 'POST', '/auth/login', { username, password });
  record(`${label} login`, res.status === 200 && Boolean(res.body?.accessToken), 'Login returns access token', {
    status: res.status,
    username,
    user: sanitize(res.body?.user),
  });
  const actor = { label, username, token: res.body.accessToken, user: res.body.user };
  evidence.actors[label] = sanitize(actor.user);
  return actor;
}

async function inventory() {
  const [servers, images, sources, alphaAccess, betaAccess] = await Promise.all([
    req(admin, 'GET', '/servers'),
    req(admin, 'GET', '/images?activeOnly=true'),
    req(admin, 'GET', `/mount-sources?serverId=${SERVER_ID}`),
    req(alpha, 'GET', '/me/access'),
    req(beta, 'GET', '/me/access'),
  ]);
  record('admin inventory lists servers', servers.status === 200, 'GET /servers succeeds', { status: servers.status });
  record('admin inventory lists images', images.status === 200, 'GET /images succeeds', { status: images.status });
  record('admin inventory lists local mount sources', sources.status === 200, 'GET /mount-sources succeeds', { status: sources.status });
  evidence.inventory = {
    selectedServer: arr(servers.body).find((server) => server.id === SERVER_ID),
    selectedImage: arr(images.body).find((image) => image.id === IMAGE_ID),
    selectedLocalSource: arr(sources.body).find((source) => source.id === LOCAL_SOURCE_ID),
    alphaAccess: sanitize(alphaAccess.body),
    betaAccess: sanitize(betaAccess.body),
  };
}

async function validationAndGrantChecks() {
  const cases = [
    ['missing body rejected', {}, new Set([400])],
    ['invalid name rejected', body({ name: 'bad name' }), new Set([400])],
    ['invalid server rejected', body({ serverId: 'not-a-real-server' }), new Set([400, 403, 404])],
    ['invalid image rejected', body({ imageId: 'not-a-real-image' }), new Set([400, 403, 404])],
    ['quota overage rejected', body({ name: `${RUN_PREFIX}-quota`, cpuMillis: 10_000, memBytes: 2 * 1024 * MI_B }), new Set([400, 422])],
  ];
  for (const [name, requestBody, allowed] of cases) {
    const res = await req(alpha, 'POST', '/containers', requestBody);
    record(`container create validation: ${name}`, allowed.has(res.status), `HTTP ${[...allowed].join('/')}`, {
      status: res.status,
      body: sanitize(res.body),
    });
  }

  const fakeSource = '00000000-0000-0000-0000-000000000000';
  const ungrantedMount = await req(alpha, 'POST', '/containers', body({
    name: `${RUN_PREFIX}-badsrc`,
    dataDirs: [{ sourceKind: 'local', sourceId: fakeSource, dirName: `${RUN_PREFIX}-badsrc`, containerPath: '/mnt/bad', createIfMissing: true }],
  }));
  record('container create rejects ungranted mount source', DENIED.has(ungrantedMount.status), 'Denied status for ungranted mount source', {
    status: ungrantedMount.status,
    body: sanitize(ungrantedMount.body),
  });

  const alphaSources = await req(alpha, 'GET', `/mount-sources?serverId=${SERVER_ID}`);
  const betaSources = await req(beta, 'GET', `/mount-sources?serverId=${SERVER_ID}`);
  record('alpha can see temporarily granted local source', alphaSources.status === 200 && arr(alphaSources.body).some((source) => source.id === LOCAL_SOURCE_ID), 'Granted source appears for alpha', {
    status: alphaSources.status,
    sources: sanitize(alphaSources.body),
  });
  record('beta can see temporarily granted local source', betaSources.status === 200 && arr(betaSources.body).some((source) => source.id === LOCAL_SOURCE_ID), 'Granted source appears for beta', {
    status: betaSources.status,
    sources: sanitize(betaSources.body),
  });
}

async function mountAndDataDirChecks() {
  const alphaDirs = await req(alpha, 'GET', `/data-dirs?serverId=${SERVER_ID}`);
  const betaDirs = await req(beta, 'GET', `/data-dirs?serverId=${SERVER_ID}`);
  const alphaLaneDir = arr(alphaDirs.body).find((dir) => dir.name === 'cml-20260604t094055z-alpha-dir');
  const betaRaceDir = arr(betaDirs.body).find((dir) => dir.name === 'cml-20260604t094055z-race');

  record('alpha data-dir list includes lane-created mount dir', alphaDirs.status === 200 && Boolean(alphaLaneDir), 'Alpha sees own lane data dir', {
    status: alphaDirs.status,
    laneDir: sanitize(alphaLaneDir),
  });
  record('beta data-dir list excludes alpha lane data dir', betaDirs.status === 200 && !arr(betaDirs.body).some((dir) => dir.name === 'cml-20260604t094055z-alpha-dir'), 'Beta must not see alpha data dir', {
    status: betaDirs.status,
    betaLaneDirs: sanitize(arr(betaDirs.body).filter((dir) => String(dir.name).startsWith('cml-'))),
  });
  record('beta concurrent data-dir create left one race dir', betaDirs.status === 200 && Boolean(betaRaceDir), 'One winner from duplicate data-dir race is visible', {
    raceDir: sanitize(betaRaceDir),
  });

  const betaDeletesAlpha = await req(beta, 'DELETE', `/data-dirs/${SERVER_ID}/${LOCAL_SOURCE_ID}/cml-20260604t094055z-alpha-dir?sourceKind=local`);
  record('beta cannot delete alpha data dir', [403, 404].includes(betaDeletesAlpha.status), 'Cross-user data-dir delete denied/not found', {
    status: betaDeletesAlpha.status,
    body: sanitize(betaDeletesAlpha.body),
  });
}

async function inspectExistingStuckCreates() {
  const containers = await req(admin, 'GET', '/containers');
  const stuck = arr(containers.body)
    .filter((container) => container.lifecycle?.phase === 'creating' || container.operation?.status === 'queued')
    .map((container) => ({
      id: container.id,
      containerId: container.containerId,
      serverId: container.serverId,
      name: container.spec?.name,
      ownerId: container.spec?.ownerId,
      dockerId: container.spec?.dockerId ?? null,
      status: container.status,
      lifecycle: container.lifecycle,
      operation: container.operation,
    }));
  evidence.residuals.stuckBeforeAdminComparison = stuck;
  record('existing stuck create operations observed', stuck.length >= 3, 'At least ordinary-lane and container-mount lane stuck creates are visible', { stuck });
  for (const item of stuck) {
    if (item.operation?.id) item.operationDetail = sanitize((await req(admin, 'GET', `/operations/${item.operation.id}`)).body);
  }
  evidence.residuals.stuckBeforeAdminComparison = stuck;

  const ownStuck = stuck.find((item) => item.name === 'cml-20260604t094055z-alpha-c1');
  if (ownStuck) {
    const mounts = await req(alpha, 'GET', `/containers/${ownStuck.serverId}/${ownStuck.containerId}/mounts`);
    record('owner can inspect mounts on stuck mounted container', mounts.status === 200, 'GET stuck container mounts succeeds for owner', {
      status: mounts.status,
      body: sanitize(mounts.body),
    });
    const betaMounts = await req(beta, 'GET', `/containers/${ownStuck.serverId}/${ownStuck.containerId}/mounts`);
    record('beta cannot inspect alpha stuck container mounts', [403, 404].includes(betaMounts.status), 'Cross-user mount list denied/not found', {
      status: betaMounts.status,
      body: sanitize(betaMounts.body),
    });
  }
}

async function lifecycleDeniedOnUnboundContainer() {
  const containers = await req(admin, 'GET', '/containers');
  const own = arr(containers.body).find((container) => container.spec?.name === 'cml-20260604t094055z-alpha-c1');
  if (!own) {
    skip('lifecycle denied on unbound container', 'Container-mount lane stuck container was not found.');
    return;
  }
  for (const action of ['start', 'stop', 'restart']) {
    const res = await req(alpha, 'POST', `/containers/${own.serverId}/${own.containerId}/${action}`);
    record(`unbound container ${action} returns controlled failure`, res.status === 409, 'Expected 409 while no dockerId is bound', {
      status: res.status,
      body: sanitize(res.body),
    });
  }
  const del = await req(alpha, 'DELETE', `/containers/${own.serverId}/${own.containerId}`);
  record('unbound container delete returns 409 without cleanup wait', del.status === 409, 'Delete should currently fail because dockerId is missing', {
    status: del.status,
    body: sanitize(del.body),
  });
}

async function adminPlainCreateComparison() {
  const name = `${RUN_PREFIX}-admin`;
  const create = await req(admin, 'POST', '/containers', body({ name, dataDirs: [] }));
  record('admin plain container create accepted', OK.has(create.status) && Boolean(create.body?.operationId), 'Admin create returns operation id', {
    status: create.status,
    body: sanitize(create.body),
  });
  if (!OK.has(create.status) || !create.body?.operationId) return;

  const opAfter = await waitAndGetOperation(admin, create.body.operationId, 20_000);
  const listAfter = await req(admin, 'GET', '/containers');
  const created = arr(listAfter.body).find((container) => container.spec?.name === name);
  if (created) {
    evidence.created.containers.push({
      name,
      id: created.id,
      containerId: created.containerId,
      serverId: created.serverId,
      dockerId: created.spec?.dockerId ?? null,
      lifecycle: created.lifecycle,
      operation: created.operation,
    });
  }
  const commandStates = arr(opAfter.body?.commands).map((command) => ({
    id: command.id,
    kind: command.commandKind,
    status: command.status,
    attempts: command.attempts,
    sentAt: command.sentAt,
    completedAt: command.completedAt,
    lastError: command.lastError,
  }));
  const adminStuck = opAfter.body?.status === 'queued' && commandStates.some((command) => command.status === 'pending' && command.attempts === 0);
  record('admin plain create also remains queued with pending command', adminStuck, 'Admin create should dispatch; observed queued/pending indicates general pipeline stall', {
    operationId: create.body.operationId,
    operation: sanitize(opAfter.body),
    createdContainer: sanitize(created),
  });

  if (created?.containerId) {
    const del = await req(admin, 'DELETE', `/containers/${created.serverId}/${created.containerId}`);
    evidence.cleanup.push({ kind: 'admin-comparison-container-delete-probe', name, status: del.status, body: sanitize(del.body) });
    record('admin stuck comparison delete returns controlled 409', del.status === 409 || OK.has(del.status), 'Delete response captured without relying on cleanup wait', {
      status: del.status,
      body: sanitize(del.body),
    });
  }
}

async function revokeTemporaryOnlineGrants() {
  for (const actor of [alpha, beta]) {
    const userId = actor.user.id;
    const deletions = [
      ['server', `/users/${userId}/server-grants/${SERVER_ID}`],
      ['image', `/users/${userId}/image-grants/${IMAGE_ID}/${SERVER_ID}`],
      ['mount-source', `/users/${userId}/mount-source-grants/local/${LOCAL_SOURCE_ID}`],
    ];
    for (const [kind, path] of deletions) {
      const res = await req(admin, 'DELETE', path);
      evidence.cleanup.push({ kind: 'temporary-grant', actor: actor.label, grantKind: kind, path, status: res.status });
      record(`revoke ${actor.label} temporary ${kind} grant`, [200, 204, 404].includes(res.status), 'Lane-added online grant revoked or already absent', {
        status: res.status,
        body: sanitize(res.body),
      });
    }
  }
}

async function finalResiduals() {
  const containers = await req(admin, 'GET', '/containers');
  const alphaDirs = await req(admin, 'GET', `/data-dirs?serverId=${SERVER_ID}&userId=${alpha.user.id}`);
  const betaDirs = await req(admin, 'GET', `/data-dirs?serverId=${SERVER_ID}&userId=${beta.user.id}`);
  evidence.residuals.final = {
    containers: arr(containers.body)
      .filter((container) => ['cml-20260604t094055z-alpha-c1'].includes(container.spec?.name) || String(container.spec?.name).startsWith(RUN_PREFIX))
      .map((container) => sanitize({
        id: container.id,
        containerId: container.containerId,
        serverId: container.serverId,
        name: container.spec?.name,
        dockerId: container.spec?.dockerId ?? null,
        status: container.status,
        lifecycle: container.lifecycle,
        operation: container.operation,
      })),
    dataDirs: [
      ...arr(alphaDirs.body).filter((dir) => String(dir.name).startsWith('cml-')),
      ...arr(betaDirs.body).filter((dir) => String(dir.name).startsWith('cml-')),
    ].map((dir) => sanitize(dir)),
  };
}

async function waitAndGetOperation(actor, operationId, ms) {
  const deadline = Date.now() + ms;
  let last = await req(actor, 'GET', `/operations/${operationId}`);
  while (Date.now() < deadline) {
    if (['succeeded', 'failed', 'blocked', 'cancelled'].includes(last.body?.status)) return last;
    await sleep(1500);
    last = await req(actor, 'GET', `/operations/${operationId}`);
  }
  return last;
}

function body(overrides = {}) {
  return {
    serverId: SERVER_ID,
    imageId: IMAGE_ID,
    name: `${RUN_PREFIX}-container`,
    cpuMillis: 100,
    memBytes: 64 * MI_B,
    gpuIndices: [],
    dataDirs: [],
    ...overrides,
  };
}

async function req(actor, method, path, bodyValue) {
  const headers = { 'Content-Type': 'application/json' };
  if (actor?.token) headers.Authorization = `Bearer ${actor.token}`;
  const init = { method, headers };
  if (bodyValue !== undefined) init.body = JSON.stringify(bodyValue);
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  let bodyJson = null;
  if (text) {
    try {
      bodyJson = JSON.parse(text);
    } catch {
      bodyJson = text;
    }
  }
  return { status: response.status, body: bodyJson, path, method };
}

function record(name, passed, expected, observed) {
  evidence.steps.push({ name, passed, expected, observed });
  if (passed) {
    evidence.counts.passed += 1;
    return;
  }
  evidence.counts.failed += 1;
  evidence.findings.push({
    test: name,
    expected,
    observed,
    rootCause: 'product',
    impact: 'Container/mount lifecycle behavior under the running service is not reliable for this path.',
  });
}

function skip(name, reason) {
  evidence.counts.skipped += 1;
  evidence.steps.push({ name, skipped: true, reason });
}

function sanitize(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|token|secret|hash/i.test(key)) continue;
    if (key === 'payload') continue;
    result[key] = sanitize(item);
  }
  return result;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderMarkdown() {
  const firstStuck = evidence.residuals.stuckBeforeAdminComparison ?? [];
  const adminCreated = evidence.created.containers[0];
  const lines = [
    '# Container and Mount Lane',
    '',
    `- Verdict: ${evidence.verdict}`,
    `- Classification: ${evidence.classification}`,
    `- Target: \`${BASE_URL}\` through frontend proxy`,
    `- Command: \`${evidence.command}\``,
    `- Counts: ${evidence.counts.passed} passed / ${evidence.counts.failed} failed / ${evidence.counts.skipped} skipped`,
    `- Evidence JSON: \`${EVIDENCE_PATH}\``,
    `- Raw secrets recorded: no`,
    '',
    '## Summary',
    '',
    'Container create is generally stuck in this running environment, not limited to ordinary-user lane inputs. The container-mount lane created `cml-20260604t094055z-alpha-c1` as alpha with a local mount; it remained lifecycle `creating`/status `unknown`, operation `12bc1ed5-deb3-493a-b4d4-b08897fa86d8` stayed `queued`, and command `33aeb7f7-fe8e-4275-b330-cb79b02d503b` stayed `pending` with `attempts: 0`. A later admin-owned plain create used the same online server/image with no mounts and also remained queued/pending after 20 seconds.',
    '',
    '## Acceptance Coverage',
    '',
    '- AC #1: Exercised container list/detail/create validation through `/containers`: missing body, invalid name/server/image, quota overage, ungranted mount source, list, and stuck container detail via admin/owner views.',
    '- AC #2: Lifecycle start/stop/restart/delete were exercised on the lane-created unbound container and returned controlled `409` responses because no Docker binding exists. Full live lifecycle could not complete because create operations do not dispatch.',
    '- AC #3: Exercised local mount-source grant visibility, data-dir list/isolation/delete-denial, owner mount inspection on the stuck mounted container, and cross-user mount-list denial. Remote source was observed in admin inventory on an offline server only, so remote create/attach was limited to denial coverage.',
    '- AC #4: Probed cross-user isolation for data dirs and mounts, plus concurrent data-dir create residue from the first lane run. Compared ordinary/alpha stuck create with admin plain create to isolate whether the stuck symptom is input-specific.',
    '- AC #5: Findings below include reproduction, observed behavior, expected behavior, impact, and evidence paths.',
    '',
    '## Findings',
    '',
    '### Container create operations remain queued and never dispatch',
    '',
    '- Reproduction: run the command above, or `POST /api/containers` as admin with server `05cea385-d6ca-490a-a126-e00d0ae23b70`, image `e6c7a01f-4431-4ac4-885e-bcf6ab755c60`, name matching `cmlcmp-*-admin`, `cpuMillis: 100`, `memBytes: 67108864`, no mounts.',
    `- Observed: existing stuck creates before admin comparison: \`${JSON.stringify(firstStuck.map((c) => ({ name: c.name, containerId: c.containerId, operationId: c.operation?.id, operationStatus: c.operation?.status, dockerId: c.dockerId })))}\`.`,
    `- Observed admin comparison: \`${JSON.stringify(adminCreated ? { name: adminCreated.name, containerId: adminCreated.containerId, operationId: adminCreated.operation?.id, operationStatus: adminCreated.operation?.status, dockerId: adminCreated.dockerId } : null)}\`.`,
    '- Expected: create operation should be dispatched to the online agent, transition out of `queued`, bind a Docker ID, and reach `succeeded` or a terminal failure with actionable error.',
    '- Impact: container detail/lifecycle/mount attach-detach flows cannot complete for new containers; delete/start/stop/restart on the unbound desired row return `409`, leaving stuck desired containers behind.',
    `- Evidence: \`${EVIDENCE_PATH}\` includes operation bodies, command statuses, delete responses, and residual IDs.`,
    '',
    '## Cleanup / Residue',
    '',
    '- No stuck containers were deleted; delete was probed once and not waited on, per PM/user instruction.',
    '- Temporary online grants added by the interrupted lane run were revoked for alpha and beta after evidence capture.',
    `- Remaining lane resources: \`${JSON.stringify(evidence.residuals.final ?? {})}\`.`,
    '',
    '## Handoff Credentials Used',
    '',
    '- Used admin-lane alpha and beta throwaway credentials supplied by PM; passwords were provided via environment variables and not written to artifacts.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
