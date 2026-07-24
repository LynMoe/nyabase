import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AvailableTopologyProvider,
  ProxyClientControlInput,
  ProxyClientControlResult,
} from '../topology/provider.js';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const operationDeadlineMs = 60_000;
const maxOutputBytes = 64 * 1024;

export async function controlProxyClient(
  provider: AvailableTopologyProvider,
  input: ProxyClientControlInput,
): Promise<ProxyClientControlResult> {
  if (input.runId !== currentRunId()) {
    throw new Error('Proxy client provider operation must target the current E2E run');
  }
  const entrypoint = resolve(repositoryRoot, provider.operations.proxyClientControl.path);
  if (!entrypoint.startsWith(`${repositoryRoot}/e2e/`)) {
    throw new Error('Proxy client provider operation escapes the E2E boundary');
  }
  const stdout = await executeEntrypoint(entrypoint, requireRuntimeEnv('E2E_RUNTIME_ROOT'), input);
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Proxy client provider operation returned invalid JSON');
  }
  assertProxyClientResult(input, value);
  return value;
}

function executeEntrypoint(
  entrypoint: string,
  runtimeRoot: string,
  input: ProxyClientControlInput,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, runtimeRoot], {
      stdio: ['pipe', 'pipe', 'ignore'], env: process.env,
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
      fail(`Proxy client provider operation exceeded ${operationDeadlineMs}ms`);
    }, operationDeadlineMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        child.kill('SIGKILL');
        fail('Proxy client provider operation exceeded its output limit');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timer);
      fail('Proxy client provider operation could not start');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        fail('Proxy client provider operation failed');
        return;
      }
      settled = true;
      resolvePromise(stdout.trim());
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function assertProxyClientResult(
  input: ProxyClientControlInput,
  value: unknown,
): asserts value is ProxyClientControlResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Proxy client provider returned a non-object result');
  }
  const result = value as Record<string, unknown>;
  const expectedKeys = [
    'action', 'defaultSendEnv', 'holdAlive', 'holdPid', 'hostKeyFingerprint', 'hostname',
    'httpProxyIp', 'httpStatus', 'login', 'markerMatched', 'observedAt', 'runId',
    'schemaVersion', 'sftpBytes', 'sftpSha256', 'source', 'sshProxyIp',
  ].sort();
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Proxy client provider returned unknown or missing evidence fields');
  }
  if (
    result.schemaVersion !== 1
    || result.runId !== input.runId
    || result.action !== input.action
    || result.source !== 'host-default-openssh'
    || typeof result.sshProxyIp !== 'string'
    || !/^172\.29\.(?:24[0-9]|25[0-5])\.6$/.test(result.sshProxyIp)
    || typeof result.httpProxyIp !== 'string'
    || !/^172\.29\.(?:24[0-9]|25[0-5])\.7$/.test(result.httpProxyIp)
    || ![null, true, false].includes(result.markerMatched as null | boolean)
    || (result.httpStatus !== null && (!Number.isInteger(result.httpStatus) || Number(result.httpStatus) < 100))
    || (result.sftpBytes !== null && (!Number.isSafeInteger(result.sftpBytes) || Number(result.sftpBytes) < 1))
    || (result.sftpSha256 !== null && (typeof result.sftpSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(result.sftpSha256)))
    || (result.holdPid !== null && (!Number.isSafeInteger(result.holdPid) || Number(result.holdPid) < 1))
    || ![null, true, false].includes(result.holdAlive as null | boolean)
    || (result.defaultSendEnv !== null && (!Array.isArray(result.defaultSendEnv) || result.defaultSendEnv.some((item) => typeof item !== 'string')))
    || typeof result.observedAt !== 'string'
    || Number.isNaN(Date.parse(result.observedAt))
  ) {
    throw new Error('Proxy client provider returned mismatched evidence');
  }
  if ('hostname' in input && result.hostname !== input.hostname) {
    throw new Error('Proxy client hostname evidence mismatch');
  }
  if ('containerName' in input) {
    const expectedLogin = `admin.${input.runId}-${input.nodeKey}.${input.containerName}`;
    if (result.login !== expectedLogin) throw new Error('Proxy client login evidence mismatch');
  }
}
