#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { validateStorageFixtureInput } from './storage-fixture-contract.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

const execFile = promisify(execFileCallback);
const runtimeDir = resolve(process.argv[2] ?? '');
const runtimeBase = resolve(dirname(new URL(import.meta.url).pathname), '..', '.runtime');
if (!process.argv[2]) throw new Error('usage: storage-fixture-control.mjs <runtimeDir>');
if (!runtimeDir.startsWith(`${runtimeBase}${sep}`) || dirname(runtimeDir) !== runtimeBase) {
  throw new Error('Storage fixture operation escaped the E2E runtime boundary');
}
const runtimeInfo = await lstat(runtimeDir);
if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink() || (runtimeInfo.mode & 0o077) !== 0) {
  throw new Error('Storage fixture runtime directory is not private and real');
}

const parseEnv = (text) => Object.fromEntries(
  text.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('Invalid runtime environment file');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }),
);
const { state } = await loadValidatedRunState(runtimeDir, { expectedProfile: 'full' });
const build = parseEnv(await readFile(join(runtimeDir, 'build.env'), 'utf8'));
if (state.NYABASE_E2E_PROFILE !== 'full') {
  throw new Error('Storage fixture control is available only in the Full profile');
}

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 4096) throw new Error('Storage fixture input is too large');
}
let input;
try {
  input = JSON.parse(raw);
} catch {
  throw new Error('Storage fixture input is not valid JSON');
}
input = validateStorageFixtureInput(input, state.NYABASE_E2E_RUN_ID);
if (input.runId !== runtimeDir.split(sep).at(-1)) {
  throw new Error('Storage fixture runtime identity mismatch');
}

const fixtureContainerName = `${state.NYABASE_E2E_PREFIX}-nfs-fixture`;
const fixtureIp = state.NYABASE_E2E_NFS_IP;
const probeContainerName = `${state.NYABASE_E2E_PREFIX}-independent-client`;
const command = async (args, timeout = 30_000) => execFile('docker', args, {
  encoding: 'utf8', maxBuffer: 64 * 1024, timeout,
});

const fixtureInspect = JSON.parse((await command([
  'inspect', fixtureContainerName, '--format', '{{json .}}',
])).stdout);
if (
  fixtureInspect.Config?.Labels?.['io.nyabase.e2e.run-id'] !== input.runId
  || fixtureInspect.Config?.Labels?.['io.nyabase.e2e.component'] !== 'nfs-fixture'
  || fixtureInspect.Image !== build.NFS_FIXTURE_IMAGE_ID
) {
  throw new Error('Storage fixture is not the current run-owned Full image');
}
const probeInspect = JSON.parse((await command([
  'inspect', probeContainerName, '--format', '{{json .}}',
])).stdout);
if (
  probeInspect.State?.Running !== true
  || probeInspect.Config?.Labels?.['io.nyabase.e2e.run-id'] !== input.runId
  || probeInspect.Config?.Labels?.['io.nyabase.e2e.component'] !== 'independent-network-client'
) {
  throw new Error('Storage fixture probe is not the current run-owned independent client');
}

async function probePort() {
  try {
    await command(['exec', probeContainerName, 'nc', '-z', '-w', '2', fixtureIp, '2049'], 5_000);
    return true;
  } catch (error) {
    if (Number(error?.code) === 1) return false;
    throw error;
  }
}

if (input.action === 'stop') {
  await command(['stop', '--time', '10', fixtureContainerName], 30_000);
} else if (input.action === 'start') {
  await command(['start', fixtureContainerName], 30_000);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await probePort()) {
      ready = true;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  if (!ready) throw new Error('NFS fixture did not recover TCP/2049 readiness');
}

const running = (await command([
  'inspect', fixtureContainerName, '--format', '{{.State.Running}}',
])).stdout.trim() === 'true';
const portReady = running ? await probePort() : false;
if (input.action === 'stop' && (running || portReady)) {
  throw new Error('NFS fixture did not converge stopped');
}
if (input.action === 'start' && (!running || !portReady)) {
  throw new Error('NFS fixture did not converge ready');
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  runId: input.runId,
  fixture: input.fixture,
  action: input.action,
  fixtureContainerName,
  fixtureIp,
  running,
  portReady,
  observedAt: new Date().toISOString(),
})}\n`);
