#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadValidatedRunState } from './run-state-contract.mjs';

const runtimeDir = process.argv[2];
const deadlineMs = Number(process.argv[3] ?? 120000);
if (!runtimeDir) throw new Error('runtime directory is required');
const parseEnv = (text) => Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((line) => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
const { state } = await loadValidatedRunState(runtimeDir);
const secrets = parseEnv(await readFile(join(runtimeDir, 'secrets.env'), 'utf8'));
const expected = JSON.parse(await readFile(join(runtimeDir, 'agents.json'), 'utf8')).agents;
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
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
  return response.json();
}

const login = await request('POST', '/auth/login', undefined, {
  username: 'admin',
  password: secrets.ADMIN_INIT_PASSWORD,
});
const deadline = Date.now() + deadlineMs;
let last = [];
while (Date.now() < deadline) {
  last = await request('GET', '/admin/servers', login.accessToken);
  if (expected.every((agent) => last.some((server) => server.id === agent.serverId && server.status === 'online'))) {
    console.log('backend reports both real CPU Agents online');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
throw new Error(`Agents did not become online: ${JSON.stringify(last.map(({ id, status, quarantineCode }) => ({ id, status, quarantineCode })))}`);
