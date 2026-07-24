import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AvailableTopologyProvider,
  ContainerSshClientInput,
  ContainerSshClientResult,
} from '../topology/provider.js';
import { runContainerSshProviderEntrypoint } from './provider-entrypoint-runner.mjs';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fingerprintPattern = /^SHA256:[A-Za-z0-9+/]{43}$/;

export async function probeContainerSsh(
  provider: AvailableTopologyProvider,
  input: ContainerSshClientInput,
): Promise<ContainerSshClientResult> {
  if (input.runId !== currentRunId()) {
    throw new Error('Container SSH provider operation must target the current E2E run');
  }
  if (
    typeof input.privateKey !== 'string' ||
    input.privateKey.length < 100 ||
    input.privateKey.length > 16 * 1024
  ) {
    throw new Error('Container SSH provider operation received an invalid private key envelope');
  }
  const entrypoint = resolve(repositoryRoot, provider.operations.containerSshClient.path);
  if (!entrypoint.startsWith(`${repositoryRoot}/e2e/`)) {
    throw new Error('Container SSH provider operation escapes the E2E boundary');
  }

  const stdout = await runContainerSshProviderEntrypoint(
    entrypoint,
    requireRuntimeEnv('E2E_RUNTIME_ROOT'),
    input,
  );
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('Container SSH provider operation returned invalid JSON');
  }
  assertContainerSshResult(input, result);
  return result;
}

function assertContainerSshResult(
  input: ContainerSshClientInput,
  value: unknown,
): asserts value is ContainerSshClientResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Container SSH provider returned a non-object result');
  }
  const result = value as Record<string, unknown>;
  const expectedKeys = [
    'authenticated',
    'clientKeyFingerprint',
    'containerId',
    'hostKeyFingerprint',
    'marker',
    'nodeKey',
    'observedAt',
    'privateKeyMode',
    'privateKeyRemoved',
    'probeContainerName',
    'remotePort',
    'remoteUser',
    'runId',
    'runtimeId',
    'schemaVersion',
    'serverId',
    'sourceContainerName',
    'sourceIp',
    'targetContainerName',
    'targetIp',
  ].sort();
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Container SSH provider returned unknown or missing evidence fields');
  }
  if (
    result.schemaVersion !== 1 ||
    result.runId !== input.runId ||
    result.nodeKey !== input.nodeKey ||
    result.sourceContainerName !== `nyabase-e2e-${input.runId}-independent-client` ||
    typeof result.sourceIp !== 'string' ||
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(result.sourceIp) ||
    result.sourceIp === input.expectedIp ||
    result.probeContainerName !== `nyabase-e2e-${input.runId}-container-ssh-client` ||
    result.targetContainerName !== `nyabase-e2e-${input.runId}-${input.nodeKey}` ||
    typeof result.serverId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.serverId) ||
    result.containerId !== input.containerId ||
    result.runtimeId !== input.runtimeId ||
    result.targetIp !== input.expectedIp ||
    result.remoteUser !== 'root' ||
    result.remotePort !== 22 ||
    result.clientKeyFingerprint !== input.expectedClientKeyFingerprint ||
    result.hostKeyFingerprint !== input.expectedHostKeyFingerprint ||
    !fingerprintPattern.test(String(result.clientKeyFingerprint)) ||
    !fingerprintPattern.test(String(result.hostKeyFingerprint)) ||
    result.marker !== input.marker ||
    result.authenticated !== true ||
    result.privateKeyMode !== '600' ||
    result.privateKeyRemoved !== true ||
    typeof result.observedAt !== 'string' ||
    Number.isNaN(Date.parse(result.observedAt))
  ) {
    throw new Error('Container SSH provider returned mismatched evidence');
  }
}
