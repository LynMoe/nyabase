#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadValidatedRunState } from './run-state-contract.mjs';

const runtimeDir = process.argv[2];
const deadlineMs = Number(process.argv[3] ?? 120_000);
if (!runtimeDir) throw new Error('runtime directory is required');
const parseEnv = (text) => Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((line) => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
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
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* body remains withheld */ }
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
  return parsed;
}

const login = await request('POST', '/auth/login', undefined, {
  username: 'admin', password: secrets.ADMIN_INIT_PASSWORD,
});
if (!login?.accessToken) throw new Error('admin login returned no access token');
const deadline = Date.now() + deadlineMs;
while (Date.now() < deadline) {
  const [ssh, http, hostKey] = await Promise.all([
    request('GET', '/admin/ssh-proxy/status', login.accessToken),
    request('GET', '/admin/http-proxy/status', login.accessToken),
    request('GET', '/admin/ssh-proxy/host-key', login.accessToken),
  ]);
  if (
    ssh?.connectedProxies === 1
    && Array.isArray(ssh.proxies)
    && ssh.proxies.length === 1
    && Number.isInteger(ssh.proxies[0]?.lastSnapshotGeneration)
    && http?.connectedProxies === 1
    && Array.isArray(http.proxies)
    && http.proxies.length === 1
    && Number.isInteger(http.proxies[0]?.lastSnapshotGeneration)
    && typeof hostKey?.fingerprint === 'string'
    && /^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey.fingerprint)
  ) {
    console.log('Backend reports one current SSH proxy and one current HTTP proxy online');
    process.exit(0);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}
throw new Error('real Rust proxies did not acknowledge Backend snapshots before the deadline');
