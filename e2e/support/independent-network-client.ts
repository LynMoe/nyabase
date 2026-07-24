import { execFile as execFileCallback } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AvailableTopologyProvider } from '../topology/provider.js';
import { requireRuntimeEnv } from './runtime-env.js';

export interface IndependentNetworkProbeResult {
  schemaVersion: 1;
  runId: string;
  sourceIp: string;
  targetIp: string;
  protocols: { icmp: 'passed'; http: 'passed' };
}

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function probeFromIndependentNetworkClient(
  provider: AvailableTopologyProvider,
  targetIp: string,
  expectedBody: string,
): Promise<IndependentNetworkProbeResult> {
  const entrypoint = resolve(repositoryRoot, provider.operations.independentNetworkClient.path);
  if (!entrypoint.startsWith(`${repositoryRoot}/e2e/`)) {
    throw new Error('Topology provider independent client operation escapes the E2E boundary');
  }
  const { stdout } = await execFile(
    process.execPath,
    [entrypoint, requireRuntimeEnv('E2E_RUNTIME_ROOT'), targetIp, expectedBody],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 45_000 },
  );
  const result = JSON.parse(stdout) as IndependentNetworkProbeResult;
  if (
    result.schemaVersion !== 1 ||
    result.runId !== requireRuntimeEnv('E2E_RUN_ID') ||
    result.sourceIp.length === 0 ||
    result.targetIp !== targetIp ||
    result.protocols?.icmp !== 'passed' ||
    result.protocols?.http !== 'passed'
  ) {
    throw new Error('Topology provider returned an invalid independent network probe result');
  }
  return result;
}
