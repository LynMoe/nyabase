import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AvailableTopologyProvider,
  RemoteStorageControlInput,
  RemoteStorageControlResult,
} from '../topology/provider.js';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const operationDeadlineMs = 60_000;
const maxOutputBytes = 64 * 1024;

export async function controlRemoteStorage(
  provider: AvailableTopologyProvider,
  input: RemoteStorageControlInput,
): Promise<RemoteStorageControlResult> {
  if (input.runId !== currentRunId()) {
    throw new Error('Remote storage provider operation must target the current E2E run');
  }
  const entrypoint = resolve(repositoryRoot, provider.operations.remoteStorageControl.path);
  if (!entrypoint.startsWith(`${repositoryRoot}/e2e/`)) {
    throw new Error('Remote storage provider operation escapes the E2E boundary');
  }
  const stdout = await executeEntrypoint(
    entrypoint,
    requireRuntimeEnv('E2E_RUNTIME_ROOT'),
    input,
  );
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Remote storage provider operation returned invalid JSON');
  }
  assertRemoteStorageResult(input, value);
  return value;
}

function executeEntrypoint(
  entrypoint: string,
  runtimeRoot: string,
  input: RemoteStorageControlInput,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, runtimeRoot], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: process.env,
    });
    let stdout = '';
    let bytes = 0;
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(`Remote storage provider operation exceeded ${operationDeadlineMs}ms`);
    }, operationDeadlineMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        child.kill('SIGKILL');
        fail('Remote storage provider operation exceeded its output limit');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timer);
      fail('Remote storage provider operation could not start');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        fail('Remote storage provider operation failed');
        return;
      }
      settled = true;
      resolvePromise(stdout.trim());
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function assertRemoteStorageResult(
  input: RemoteStorageControlInput,
  value: unknown,
): asserts value is RemoteStorageControlResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote storage provider returned a non-object result');
  }
  const result = value as Record<string, unknown>;
  const expectedKeys = [
    'action',
    'busyPid',
    'cephSecretArtifactsAbsent',
    'markerMatched',
    'mountId',
    'mountPoint',
    'mounted',
    'nodeContainerName',
    'nodeKey',
    'observedAt',
    'observedFsType',
    'runId',
    'schemaVersion',
    'source',
  ].sort();
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Remote storage provider returned unknown or missing evidence fields');
  }
  const expectedObservedTypes = input.fsType === 'nfs' ? ['nfs', 'nfs4'] : ['ceph'];
  if (
    result.schemaVersion !== 1
    || result.runId !== input.runId
    || result.nodeKey !== input.nodeKey
    || result.nodeContainerName !== `nyabase-e2e-${input.runId}-${input.nodeKey}`
    || result.mountId !== input.mountId
    || result.mountPoint !== `/mnt/remote-fs/${input.mountId}`
    || result.action !== input.action
    || typeof result.mounted !== 'boolean'
    || (
      result.mounted === true
      && (
        typeof result.observedFsType !== 'string'
        || !expectedObservedTypes.includes(result.observedFsType)
        || typeof result.source !== 'string'
        || result.source.length < 1
        || result.source.length > 4096
      )
    )
    || (
      result.mounted === false
      && (result.observedFsType !== null || result.source !== null)
    )
    || ![true, null].includes(result.markerMatched as true | null)
    || (
      result.busyPid !== null
      && (!Number.isSafeInteger(result.busyPid) || Number(result.busyPid) < 1)
    )
    || result.cephSecretArtifactsAbsent !== true
    || typeof result.observedAt !== 'string'
    || Number.isNaN(Date.parse(result.observedAt))
  ) {
    throw new Error('Remote storage provider returned mismatched evidence');
  }
}
