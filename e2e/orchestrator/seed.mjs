#!/usr/bin/env node
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadValidatedRunState } from './run-state-contract.mjs';

const reconcileExisting = process.argv[2] === '--reconcile-existing';
const runtimeDir = process.argv[reconcileExisting ? 3 : 2];
const workloadTag = process.argv[3];
const registryDigest = process.argv[4];
const sourceImageId = process.argv[5];
const uiWorkloadTag = process.argv[6];
const uiRegistryDigest = process.argv[7];
if (
  !runtimeDir
  || (!reconcileExisting && (
    !workloadTag
    || !registryDigest
    || !sourceImageId
    || !uiWorkloadTag
    || !uiRegistryDigest
  ))
) {
  throw new Error(
    'usage: seed.mjs <runtimeDir> <immutableWorkloadTag> <registryDigest> <sourceImageId> <uiWorkloadTag> <uiRegistryDigest> | seed.mjs --reconcile-existing <runtimeDir>',
  );
}

const parseEnv = (text) => Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((line) => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
const { state } = await loadValidatedRunState(runtimeDir);
const secrets = parseEnv(await readFile(join(runtimeDir, 'secrets.env'), 'utf8'));
const agents = JSON.parse(await readFile(join(runtimeDir, 'agents.json'), 'utf8')).agents;
const apiBase = `${state.NYABASE_E2E_PUBLIC_URL}/api`;
const seedPath = join(runtimeDir, 'seed.json');
const runtimeOverrides = {
  uid: 0,
  entrypoint: null,
  cmd: [
    '/bin/sh',
    '-ec',
    'mkdir -p /tmp/nyabase-e2e && printf ready > /tmp/nyabase-e2e/marker && exec tail -f /dev/null',
  ],
  init: false,
};

async function request(method, path, token, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* retain text */ }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}; response body withheld`);
  }
  return parsed;
}

async function authenticateAdmin(expectedUserId) {
  const authenticated = await request('POST', '/auth/login', undefined, {
    username: 'admin',
    password: secrets.ADMIN_INIT_PASSWORD,
  });
  if (
    !authenticated.accessToken
    || !authenticated.user?.id
    || (expectedUserId && authenticated.user.id !== expectedUserId)
  ) {
    throw new Error('admin login is missing or changed identity');
  }
  return authenticated;
}

const login = await authenticateAdmin();
let token = login.accessToken;
const adminUserId = login.user?.id;

if (reconcileExisting) {
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  if (seed.runId !== state.NYABASE_E2E_RUN_ID || !seed.image?.id) {
    throw new Error('existing seed evidence does not belong to this run');
  }
  const patchResponse = await request(
    'PATCH',
    `/admin/images/${seed.image.id}`,
    token,
    { runtimeOverrides },
  );
  const observed = await request('GET', `/admin/images/${seed.image.id}`, token);
  if (JSON.stringify(observed.runtimeOverrides) !== JSON.stringify(runtimeOverrides)) {
    throw new Error(`runtime override reconciliation did not converge: ${JSON.stringify(observed)}`);
  }
  const reconciledAt = new Date().toISOString();
  seed.image.runtimeOverrides = runtimeOverrides;
  seed.runtimeOverrideReconciliation = {
    reconciledAt,
    verifiedVia: `GET /admin/images/${seed.image.id}`,
  };
  await writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  await chmod(seedPath, 0o600);
  const evidencePath = join(runtimeDir, 'seed-runtime-patch.json');
  await writeFile(evidencePath, `${JSON.stringify({
    runId: state.NYABASE_E2E_RUN_ID,
    reconciledAt,
    request: { imageId: seed.image.id, runtimeOverrides },
    patchResponse,
    observed,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(evidencePath, 0o600);
  console.log(`reconciled and verified long-lived runtime override for image ${seed.image.id}`);
  process.exit(0);
}

const grantTaskIds = [];
for (const agent of agents) {
  token = (await authenticateAdmin(adminUserId)).accessToken;
  const grant = await request('POST', `/admin/users/${adminUserId}/server-grants/${agent.serverId}`, token, {
    cpuMillis: 2000,
    memBytes: 1073741824,
    diskBytes: 2147483648,
    gpuMode: 'none',
    gpuIndices: [],
  });
  grantTaskIds.push(...(grant.taskIds ?? []));
}

token = (await authenticateAdmin(adminUserId)).accessToken;
const image = await request('POST', '/admin/images', token, {
  name: `${state.NYABASE_E2E_RUN_ID} immutable CPU workload`,
  dockerImage: workloadTag,
  description: 'Per-run real E2E workload published through the TLS registry',
  disableSsh: true,
  runtimeOverrides,
});
for (const agent of agents) {
  token = (await authenticateAdmin(adminUserId)).accessToken;
  await request('POST', `/admin/users/${adminUserId}/image-grants`, token, {
    imageId: image.id,
    serverId: agent.serverId,
  });
}

// DataDir creation deliberately requires an explicit mount-source grant even
// for an administrator acting on their own user. Seed one real pquota source
// per node so storage/browser journeys exercise the production authorization
// path instead of receiving a fixture-induced 403.
const mountSourceGrants = [];
for (const agent of agents) {
  token = (await authenticateAdmin(adminUserId)).accessToken;
  const disks = await request('GET', `/admin/servers/${agent.serverId}/disks`, token);
  const disk = disks.find((candidate) => (
    candidate?.pquotaEnabled === true
    && typeof candidate.diskId === 'string'
    && candidate.diskId.length > 0
    && typeof candidate.sourceIdentity === 'string'
    && candidate.sourceIdentity.length > 0
  ));
  if (!disk) throw new Error(`real pquota mount source is absent on ${agent.key}`);
  const grant = await request(
    'POST',
    `/admin/mount-sources/grants/local/${encodeURIComponent(disk.diskId)}`,
    token,
    { scope: 'user', scopeId: adminUserId, serverId: agent.serverId },
  );
  mountSourceGrants.push({
    grantId: grant.id,
    serverId: agent.serverId,
    diskId: disk.diskId,
    sourceIdentity: disk.sourceIdentity,
  });
}

token = (await authenticateAdmin(adminUserId)).accessToken;
const pull = await request('POST', `/admin/images/${image.id}/pull`, token, {
  serverIds: agents.map((agent) => agent.serverId),
});
if (pull.rejected?.length) throw new Error(`image pull rejected: ${JSON.stringify(pull.rejected)}`);
const pullTaskIds = (pull.tasks ?? []).map((task) => task.taskId ?? task.id).filter(Boolean);

async function waitTasks(taskIds, description) {
  const pending = new Set(taskIds);
  const deadline = Date.now() + 120000;
  while (pending.size && Date.now() < deadline) {
    for (const taskId of [...pending]) {
      const task = await request('GET', `/admin/agent-tasks/${taskId}`, token);
      if (task.status === 'failed') {
        throw new Error(`${description} task ${taskId} failed: ${JSON.stringify(task.error ?? task.errorJson ?? task)}`);
      }
      if (task.status === 'succeeded') pending.delete(taskId);
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (pending.size) throw new Error(`${description} tasks timed out: ${[...pending].join(',')}`);
}

await waitTasks(grantTaskIds, 'quota grant');
await waitTasks(pullTaskIds, 'image pull');

async function waitForImageInventory(imageId, expectedServerIds) {
  const expected = new Set(expectedServerIds);
  const deadline = Date.now() + 120000;
  let observed = [];
  while (Date.now() < deadline) {
    observed = await request('GET', `/admin/images/${imageId}/status`, token);
    const byServer = new Map(observed.map((status) => [status.serverId, status]));
    if (
      byServer.size === expected.size
      && [...expected].every((serverId) => {
        const status = byServer.get(serverId);
        return status?.online === true && status?.present === true;
      })
    ) {
      return {
        convergedAt: new Date().toISOString(),
        servers: [...expected].sort().map((serverId) => ({
          serverId,
          online: true,
          present: true,
        })),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const safeSummary = observed.map(({ serverId, online, present }) => ({
    serverId,
    online,
    present,
  }));
  throw new Error(`image inventory did not converge on every expected server: ${JSON.stringify(safeSummary)}`);
}

// A succeeded pull task proves the physical mutation, while the public image
// and container APIs intentionally consume the Agent's next authoritative full
// inventory. Do not declare the test stack ready until both real nodes have
// published that post-task observation.
const imageInventory = await waitForImageInventory(
  image.id,
  agents.map((agent) => agent.serverId),
);

await writeFile(seedPath, `${JSON.stringify({
  runId: state.NYABASE_E2E_RUN_ID,
  adminUserId,
  image: {
    id: image.id,
    dockerImage: workloadTag,
    registryDigest,
    sourceImageId,
    runtimeOverrides,
  },
  uiImage: {
    dockerImage: uiWorkloadTag,
    registryDigest: uiRegistryDigest,
    sourceImageId,
  },
  servers: agents.map(({ key, serverId, outerIp }) => ({ key, serverId, outerIp })),
  mountSourceGrants,
  taskIds: { quota: grantTaskIds, imagePull: pullTaskIds },
  imageInventory,
}, null, 2)}\n`, { mode: 0o600 });
await chmod(seedPath, 0o600);
console.log(`seeded immutable workload and grants; ${grantTaskIds.length + pullTaskIds.length} durable tasks succeeded`);
