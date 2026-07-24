#!/usr/bin/env node
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadValidatedRunState } from './run-state-contract.mjs';

const [runtimeDir, proxyTargetTag, registryDigest, sourceImageId] = process.argv.slice(2);
if (!runtimeDir || !proxyTargetTag || !registryDigest || !sourceImageId) {
  throw new Error('usage: seed-full.mjs <runtimeDir> <proxyTargetTag> <registryDigest> <sourceImageId>');
}
const parseEnv = (text) => Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((line) => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
const { state } = await loadValidatedRunState(runtimeDir, { expectedProfile: 'full' });
const secrets = parseEnv(await readFile(join(runtimeDir, 'secrets.env'), 'utf8'));
if (state.NYABASE_E2E_PROFILE !== 'full') throw new Error('Full seed requires the Full profile');
const seedPath = join(runtimeDir, 'seed.json');
const seed = JSON.parse(await readFile(seedPath, 'utf8'));
if (seed.runId !== state.NYABASE_E2E_RUN_ID || !seed.adminUserId || seed.servers?.length !== 2) {
  throw new Error('base seed evidence does not belong to this Full run');
}
const apiBase = `${state.NYABASE_E2E_PUBLIC_URL}/api`;

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
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* body remains withheld */ }
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
  return parsed;
}

const login = await request('POST', '/auth/login', undefined, {
  username: 'admin', password: secrets.ADMIN_INIT_PASSWORD,
});
if (!login?.accessToken || login.user?.id !== seed.adminUserId) {
  throw new Error('Full seed admin identity mismatch');
}
const token = login.accessToken;
const image = await request('POST', '/admin/images', token, {
  name: `${state.NYABASE_E2E_RUN_ID} real proxy target`,
  dockerImage: proxyTargetTag,
  description: 'Per-run Node HTTP/WebSocket target with Agent-injected real SSH/SFTP',
  disableSsh: false,
});
for (const server of seed.servers) {
  await request('POST', `/admin/users/${seed.adminUserId}/image-grants`, token, {
    imageId: image.id,
    serverId: server.serverId,
  });
}
const pull = await request('POST', `/admin/images/${image.id}/pull`, token, {
  serverIds: seed.servers.map((server) => server.serverId),
});
if (pull.rejected?.length) throw new Error('Full proxy target image pull was rejected');
const taskIds = (pull.tasks ?? []).map((task) => task.taskId ?? task.id).filter(Boolean);
if (taskIds.length !== 2) throw new Error('Full proxy target pull did not create two durable tasks');

const pending = new Set(taskIds);
const deadline = Date.now() + 180_000;
while (pending.size > 0 && Date.now() < deadline) {
  for (const taskId of [...pending]) {
    const task = await request('GET', `/admin/agent-tasks/${taskId}`, token);
    if (task.status === 'failed') throw new Error(`Full proxy target pull task failed: ${taskId}`);
    if (task.status === 'succeeded') pending.delete(taskId);
  }
  if (pending.size > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}
if (pending.size > 0) throw new Error('Full proxy target pull tasks timed out');

let inventory = [];
while (Date.now() < deadline) {
  inventory = await request('GET', `/admin/images/${image.id}/status`, token);
  if (
    inventory.length === 2
    && seed.servers.every((server) => inventory.some((row) => (
      row.serverId === server.serverId && row.online === true && row.present === true
    )))
  ) break;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}
if (!seed.servers.every((server) => inventory.some((row) => (
  row.serverId === server.serverId && row.online === true && row.present === true
)))) {
  throw new Error('Full proxy target image inventory did not converge on both CPU nodes');
}

seed.proxyImage = {
  id: image.id,
  dockerImage: proxyTargetTag,
  registryDigest,
  sourceImageId,
  disableSsh: false,
};
seed.taskIds.proxyImagePull = taskIds;
seed.proxyImageInventory = {
  convergedAt: new Date().toISOString(),
  servers: seed.servers.map((server) => ({ serverId: server.serverId, online: true, present: true })),
};
await writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
await chmod(seedPath, 0o600);
console.log('seeded the real Full proxy target image on both CPU nodes');
