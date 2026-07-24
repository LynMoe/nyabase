#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadValidatedRunState } from './run-state-contract.mjs';

const runtimeDir = process.argv[2];
if (!runtimeDir) throw new Error('runtime directory is required');

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

const { state } = await loadValidatedRunState(runtimeDir);
const secrets = parseEnv(await readFile(join(runtimeDir, 'secrets.env'), 'utf8'));
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
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* retain text */
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}; response body withheld`);
  }
  return parsed;
}

const login = await request('POST', '/auth/login', undefined, {
  username: 'admin',
  password: secrets.ADMIN_INIT_PASSWORD,
});
const token = login.accessToken;
if (!token) throw new Error('admin login returned no access token');

const existing = await request('GET', '/admin/servers', token);
for (const server of existing) {
  if (server.slug?.startsWith(`${state.NYABASE_E2E_RUN_ID}-`)) {
    await request('DELETE', `/admin/servers/${server.id}`, token);
  }
}

const configsDir = join(runtimeDir, 'agents');
await mkdir(configsDir, { recursive: true, mode: 0o700 });

function workloadPoolReservations(subnet, separatelyOwnedIps) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(subnet);
  if (!match)
    throw new Error(`the Docker DinD provider requires a canonical /24 subnet, got ${subnet}`);
  const prefix = `${match[1]}.${match[2]}.${match[3]}`;
  const separatelyOwned = new Set(separatelyOwnedIps);
  const reservations = [];
  // The provider contract dedicates .101-.199 to product workloads. Reserve
  // every other usable address so future NFS/Ceph/proxy fixtures cannot race
  // the first-fit Backend allocator. The gateway (.1) is a separate durable
  // gateway claim and therefore must not also appear in an Agent reservation.
  for (let host = 2; host <= 254; host += 1) {
    if (host >= 101 && host <= 199) continue;
    const address = `${prefix}.${host}`;
    if (!separatelyOwned.has(address)) reservations.push(address);
  }
  return reservations;
}

const node1Reservations = workloadPoolReservations(state.NYABASE_E2E_SUBNET, [
  state.NYABASE_E2E_NODE2_IP,
]);
const definitions = [
  { key: 'node1', outerIp: state.NYABASE_E2E_NODE1_IP, reservedIps: node1Reservations },
  { key: 'node2', outerIp: state.NYABASE_E2E_NODE2_IP, reservedIps: [state.NYABASE_E2E_NODE2_IP] },
];
const agents = [];

for (const definition of definitions) {
  const created = await request('POST', '/admin/servers', token, {
    name: `${state.NYABASE_E2E_RUN_ID}-${definition.key}`,
    slug: `${state.NYABASE_E2E_RUN_ID}-${definition.key}`,
  });
  if (!created.server?.id || !created.agentToken)
    throw new Error(`server registration failed for ${definition.key}`);
  const configPath = join(configsDir, `${definition.key}.yaml`);
  const yaml = [
    'backendUrl: "wss://edge/ws/agent"',
    `agentToken: ${JSON.stringify(created.agentToken)}`,
    `serverId: ${JSON.stringify(created.server.id)}`,
    'dockerRoot: "/var/lib/nyabase-docker"',
    'parentIface: "eth0"',
    `macvlanCidr: ${JSON.stringify(state.NYABASE_E2E_SUBNET)}`,
    `macvlanGateway: ${JSON.stringify(state.NYABASE_E2E_GATEWAY)}`,
    'reservedIps:',
    ...definition.reservedIps.map((ip) => `  - ${JSON.stringify(ip)}`),
    'metricsIntervalMs: 5000',
    'isGpuServer: false',
    'dockerResourceLimit:',
    '  enabled: false',
    'localDataSources:',
    `  - id: ${JSON.stringify(`${state.NYABASE_E2E_RUN_ID}-${definition.key}-local`)}`,
    '    mountPoint: "/data/nyabase"',
    `    label: ${JSON.stringify(`E2E ${definition.key} local XFS`)}`,
    '',
  ].join('\n');
  await writeFile(configPath, yaml, { mode: 0o600 });
  await chmod(configPath, 0o600);
  agents.push({
    key: definition.key,
    serverId: created.server.id,
    outerIp: definition.outerIp,
    configPath,
  });
}

await writeFile(join(runtimeDir, 'agents.json'), `${JSON.stringify({ agents }, null, 2)}\n`, {
  mode: 0o600,
});
await chmod(join(runtimeDir, 'agents.json'), 0o600);
console.log(`registered ${agents.length} real CPU Agents`);
