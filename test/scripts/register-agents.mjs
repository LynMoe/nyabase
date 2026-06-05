#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const envPath = join(root, 'test/config/local.env');
const agentsPath = join(root, 'test/config/agents.json');
const runtimeDir = join(root, 'test/runtime/agents');
const env = await loadEnv(envPath);
const config = JSON.parse(await readFile(agentsPath, 'utf8'));

const backendUrl = stripTrailingSlash(process.env.NYABASE_BACKEND_URL ?? env.NYABASE_BACKEND_URL ?? `http://localhost:${env.PORT ?? '3001'}`);
const apiBase = `${backendUrl}/api`;
const adminUsername = process.env.ADMIN_USERNAME ?? env.ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.ADMIN_INIT_PASSWORD ?? env.ADMIN_INIT_PASSWORD;
if (!adminPassword) throw new Error('ADMIN_INIT_PASSWORD must be set in test/config/local.env or env');

await mkdir(join(runtimeDir, 'configs'), { recursive: true });

const admin = await request('POST', '/auth/login', undefined, {
  username: adminUsername,
  password: adminPassword,
});

const existing = await request('GET', '/admin/servers', admin.accessToken);
for (const server of existing) {
  if (config.agents.some((agent) => agent.name === server.name)) {
    await request('DELETE', `/admin/servers/${server.id}`, admin.accessToken);
  }
}

const registered = [];
const secrets = {
  generatedAt: new Date().toISOString(),
  backendUrl,
  backendWsUrl: process.env.NYABASE_AGENT_BACKEND_URL ?? env.NYABASE_AGENT_BACKEND_URL ?? config.backendWsUrl,
  agents: {},
};

for (const agent of config.agents) {
  const body = {
    name: agent.name,
    parentIface: agent.parentIface,
    ipCidr: agent.serverIpCidr,
    gateway: agent.gateway,
    reservedIps: agent.reservedIps,
    isGpuServer: agent.isGpuServer,
    defaultCpuMillis: agent.defaultCpuMillis,
    defaultMemBytes: agent.defaultMemBytes,
    defaultDiskBytes: agent.defaultDiskBytes,
    defaultGpuMode: agent.defaultGpuMode,
    defaultGpuIndices: agent.defaultGpuIndices,
  };
  const created = await request('POST', '/admin/servers', admin.accessToken, body);
  const server = created.server;
  const token = created.agentToken;
  if (!server?.id || !token) throw new Error(`Server creation for ${agent.key} did not return id/token`);

  const generatedConfig = renderAgentYaml(agent, secrets.backendWsUrl, server.id, token);
  const configPath = join(runtimeDir, `configs/${agent.key}.yaml`);
  await writeFile(configPath, generatedConfig, { mode: 0o600 });
  await chmod(configPath, 0o600);

  registered.push({
    key: agent.key,
    name: agent.name,
    serverId: server.id,
    ssh: agent.ssh,
    sudo: agent.sudo,
    isGpuServer: agent.isGpuServer,
    parentIface: agent.parentIface,
    ipCidr: agent.serverIpCidr,
    gateway: agent.gateway,
    reservedIps: agent.reservedIps,
    dockerRoot: agent.dockerRoot,
    status: server.status,
    configPath,
  });
  secrets.agents[agent.key] = {
    serverId: server.id,
    agentToken: token,
    ssh: agent.ssh,
    sudo: agent.sudo,
    configPath,
  };
}

const serversPath = join(runtimeDir, 'servers.json');
const secretsPath = join(runtimeDir, 'agent-secrets.json');
await writeFile(serversPath, JSON.stringify({ generatedAt: secrets.generatedAt, backendUrl, agents: registered }, null, 2) + '\n');
await writeFile(secretsPath, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
await chmod(secretsPath, 0o600);

console.log(`Registered ${registered.length} agents.`);
for (const agent of registered) {
  console.log(`${agent.key}: ${agent.serverId} (${agent.name})`);
}
console.log(`Metadata: ${serversPath}`);
console.log(`Secrets:  ${secretsPath}`);

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
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const text = await readFile(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function renderAgentYaml(agent, backendWsUrl, serverId, token) {
  return [
    `backendUrl: ${JSON.stringify(backendWsUrl)}`,
    `agentToken: ${JSON.stringify(token)}`,
    `serverId: ${JSON.stringify(serverId)}`,
    `dockerRoot: ${JSON.stringify(agent.dockerRoot)}`,
    `parentIface: ${JSON.stringify(agent.parentIface)}`,
    `macvlanCidr: ${JSON.stringify(agent.macvlanCidr)}`,
    `macvlanGateway: ${JSON.stringify(agent.macvlanGateway)}`,
    'metricsIntervalMs: 10000',
    'mountHelperPath: "/var/lib/nyabase-agent/nyabase-mount-helper"',
    `isGpuServer: ${agent.isGpuServer ? 'true' : 'false'}`,
    '',
  ].join('\n');
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}
