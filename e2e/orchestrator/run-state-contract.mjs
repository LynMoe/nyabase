import { readFile, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const orchestratorDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(orchestratorDir, '..', '..');
const runtimeBase = join(repositoryRoot, 'e2e', '.runtime');
const keysPath = join(orchestratorDir, 'run-state.keys');

export const e2eStateKeys = Object.freeze(
  readFileSync(keysPath, 'utf8').split(/\r?\n/).filter(Boolean),
);
const keySet = new Set(e2eStateKeys);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseClosedRunState(text, label = 'state.env') {
  const values = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line) continue;
    const separator = line.indexOf('=');
    invariant(separator > 0, `${label}:${index + 1} is not KEY=value`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    invariant(keySet.has(key), `${label}:${index + 1} contains unknown key ${key}`);
    invariant(!(key in values), `${label} contains duplicate key ${key}`);
    values[key] = value;
  }
  invariant(
    Object.keys(values).length === e2eStateKeys.length &&
      e2eStateKeys.every((key) => key in values),
    `${label} does not contain the exact run-state key set`,
  );
  return values;
}

async function readPrivateRegularFile(path, label) {
  const info = await lstat(path);
  invariant(
    info.isFile() && !info.isSymbolicLink() && info.nlink === 1,
    `${label} must be a singly-linked regular file`,
  );
  invariant((info.mode & 0o777) === 0o600, `${label} must have mode 0600`);
  return readFile(path, 'utf8');
}

export function assertRunStateIdentity(state, runtimeDir, expectedProfile) {
  const runId = state.NYABASE_E2E_RUN_ID;
  invariant(/^[a-z0-9][a-z0-9-]{2,47}$/.test(runId), 'state runId is invalid');
  invariant(basename(runtimeDir) === runId, 'runtime runId mismatch');
  invariant(state.NYABASE_E2E_RUNTIME_DIR === runtimeDir, 'state runtimeDir mismatch');
  invariant(state.NYABASE_E2E_ROOT === repositoryRoot, 'state root mismatch');
  invariant(['smoke', 'core', 'full', 'recovery'].includes(state.NYABASE_E2E_PROFILE),
    'state profile is invalid');
  if (expectedProfile !== undefined) {
    invariant(state.NYABASE_E2E_PROFILE === expectedProfile, 'state profile mismatch');
  }
  invariant(/^(?:[0-9]|1[0-5])$/.test(state.NYABASE_E2E_SLOT), 'state slot is invalid');
  const slot = Number(state.NYABASE_E2E_SLOT);
  const thirdOctet = 240 + slot;
  const prefix = `nyabase-e2e-${runId}`;
  const exact = {
    NYABASE_E2E_PREFIX: prefix,
    NYABASE_E2E_PROJECT: prefix,
    NYABASE_E2E_NETWORK: `${prefix}-cluster`,
    NYABASE_E2E_SLOT_LOCK: `/tmp/nyabase-e2e-slot-${slot}.lock`,
    NYABASE_E2E_SUBNET: `172.29.${thirdOctet}.0/24`,
    NYABASE_E2E_GATEWAY: `172.29.${thirdOctet}.1`,
    NYABASE_E2E_BACKEND_IP: `172.29.${thirdOctet}.2`,
    NYABASE_E2E_VM_IP: `172.29.${thirdOctet}.3`,
    NYABASE_E2E_EDGE_IP: `172.29.${thirdOctet}.4`,
    NYABASE_E2E_REGISTRY_IP: `172.29.${thirdOctet}.5`,
    NYABASE_E2E_SSH_PROXY_IP: `172.29.${thirdOctet}.6`,
    NYABASE_E2E_HTTP_PROXY_IP: `172.29.${thirdOctet}.7`,
    NYABASE_E2E_NFS_IP: `172.29.${thirdOctet}.8`,
    NYABASE_E2E_CEPH_IP: `172.29.${thirdOctet}.9`,
    NYABASE_E2E_STORAGE_CLIENT_IP: `172.29.${thirdOctet}.10`,
    NYABASE_E2E_NODE1_IP: `172.29.${thirdOctet}.11`,
    NYABASE_E2E_NODE2_IP: `172.29.${thirdOctet}.12`,
    NYABASE_E2E_RATE_LIMIT_EDGE_IP: `172.29.${thirdOctet}.13`,
    NYABASE_E2E_PROBE_IP: `172.29.${thirdOctet}.20`,
    NYABASE_E2E_EDGE_PORT: String(18443 + slot),
    NYABASE_E2E_PUBLIC_URL: `https://localhost:${18443 + slot}`,
    NYABASE_E2E_RATE_LIMIT_EDGE_PORT: String(19443 + slot),
    NYABASE_E2E_RATE_LIMIT_PUBLIC_URL: `https://localhost:${19443 + slot}`,
    NYABASE_E2E_BACKEND_IMAGE: `${prefix}-backend:worktree`,
    NYABASE_E2E_NODE_IMAGE: `${prefix}-node:worktree`,
    NYABASE_E2E_SSH_PROXY_IMAGE: `${prefix}-ssh-proxy:worktree`,
    NYABASE_E2E_HTTP_PROXY_IMAGE: `${prefix}-http-proxy:worktree`,
    NYABASE_E2E_PROXY_TARGET_IMAGE: `${prefix}-proxy-target:worktree`,
    NYABASE_E2E_NFS_IMAGE: `${prefix}-nfs-fixture:worktree`,
    NYABASE_E2E_CEPH_IMAGE: `${prefix}-ceph-fixture:worktree`,
    NYABASE_E2E_STORAGE_CLIENT_IMAGE: `${prefix}-storage-client:worktree`,
  };
  for (const [key, value] of Object.entries(exact)) {
    invariant(state[key] === value, `${key} does not match the run identity`);
  }
  return state;
}

export async function loadValidatedRunState(runtimeDirValue, options = {}) {
  const runtimeDir = resolve(runtimeDirValue ?? '');
  invariant(
    runtimeDir.startsWith(`${runtimeBase}${sep}`) && dirname(runtimeDir) === runtimeBase,
    `runtime directory must be a direct child of ${runtimeBase}`,
  );
  const runtimeInfo = await lstat(runtimeDir);
  invariant(runtimeInfo.isDirectory() && !runtimeInfo.isSymbolicLink(),
    'runtime directory must be real');
  invariant((runtimeInfo.mode & 0o077) === 0, 'runtime directory must be private');
  const state = parseClosedRunState(
    await readPrivateRegularFile(join(runtimeDir, 'state.env'), 'state.env'),
    'state.env',
  );
  assertRunStateIdentity(state, runtimeDir, options.expectedProfile);
  return { runtimeDir, runId: state.NYABASE_E2E_RUN_ID, state };
}

export async function loadValidatedComposeState(runtimeDir, expectedState) {
  const compose = parseClosedRunState(
    await readPrivateRegularFile(join(runtimeDir, 'compose.env'), 'compose.env'),
    'compose.env',
  );
  invariant(
    e2eStateKeys.every((key) => compose[key] === expectedState[key]),
    'compose.env does not exactly match state.env',
  );
  return compose;
}
