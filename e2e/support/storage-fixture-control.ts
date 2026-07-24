import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AvailableTopologyProvider,
  StorageFixtureControlInput,
  StorageFixtureControlResult,
} from '../topology/provider.js';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const operationDeadlineMs = 90_000;
const maxOutputBytes = 64 * 1024;

export async function controlStorageFixture(
  provider: AvailableTopologyProvider,
  input: StorageFixtureControlInput,
): Promise<StorageFixtureControlResult> {
  if (input.runId !== currentRunId()) {
    throw new Error('Storage fixture provider operation must target the current E2E run');
  }
  const entrypoint = resolve(repositoryRoot, provider.operations.storageFixtureControl.path);
  if (!entrypoint.startsWith(`${repositoryRoot}/e2e/`)) {
    throw new Error('Storage fixture provider operation escapes the E2E boundary');
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
    throw new Error('Storage fixture provider operation returned invalid JSON');
  }
  assertStorageFixtureResult(input, value);
  return value;
}

function executeEntrypoint(
  entrypoint: string,
  runtimeRoot: string,
  input: StorageFixtureControlInput,
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
      fail(`Storage fixture provider operation exceeded ${operationDeadlineMs}ms`);
    }, operationDeadlineMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        child.kill('SIGKILL');
        fail('Storage fixture provider operation exceeded its output limit');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timer);
      fail('Storage fixture provider operation could not start');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        fail('Storage fixture provider operation failed');
        return;
      }
      settled = true;
      resolvePromise(stdout.trim());
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function assertStorageFixtureResult(
  input: StorageFixtureControlInput,
  value: unknown,
): asserts value is StorageFixtureControlResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Storage fixture provider returned a non-object result');
  }
  const result = value as Record<string, unknown>;
  const expectedKeys = [
    'action',
    'fixture',
    'fixtureContainerName',
    'fixtureIp',
    'observedAt',
    'portReady',
    'runId',
    'running',
    'schemaVersion',
  ].sort();
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Storage fixture provider returned unknown or missing evidence fields');
  }
  if (
    result.schemaVersion !== 1
    || result.runId !== input.runId
    || result.fixture !== input.fixture
    || result.action !== input.action
    || result.fixtureContainerName !== `nyabase-e2e-${input.runId}-nfs-fixture`
    || typeof result.fixtureIp !== 'string'
    || !/^172\.29\.(?:24[0-9]|25[0-5])\.8$/.test(result.fixtureIp)
    || typeof result.running !== 'boolean'
    || typeof result.portReady !== 'boolean'
    || (result.portReady === true && result.running !== true)
    || typeof result.observedAt !== 'string'
    || Number.isNaN(Date.parse(result.observedAt))
  ) {
    throw new Error('Storage fixture provider returned mismatched evidence');
  }
}
