#!/usr/bin/env node
import { chmod, lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRecoveryFaultProviderEntrypoint } from '../support/provider-entrypoint-runner.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const orchestratorDir = dirname(scriptPath);
const runtimeBase = resolve(orchestratorDir, '..', '.runtime');
const runtimeDir = resolve(process.argv[2] ?? '');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

invariant(process.argv[2], 'usage: capture-recovery-proof.mjs <runtimeDir>');
invariant(
  runtimeDir.startsWith(`${runtimeBase}${sep}`) && dirname(runtimeDir) === runtimeBase,
  `runtime directory must be a direct child of ${runtimeBase}`,
);
const runtimeInfo = await lstat(runtimeDir);
invariant(
  runtimeInfo.isDirectory() && !runtimeInfo.isSymbolicLink() && (runtimeInfo.mode & 0o077) === 0,
  'runtime directory must be a private real directory',
);
const { state, runId } = await loadValidatedRunState(runtimeDir, {
  expectedProfile: 'recovery',
});
invariant(runtimeDir.split(sep).at(-1) === runId, 'runtime runId mismatch');
invariant(state.NYABASE_E2E_PROFILE === 'recovery', 'Recovery proof requires the recovery profile');

const fault = JSON.parse(
  await runRecoveryFaultProviderEntrypoint(join(orchestratorDir, 'fault-control.mjs'), runtimeDir, {
    fault: 'backendService',
    runId,
    action: 'restart',
    role: 'all',
  }),
);
invariant(
  fault?.schemaVersion === 1 &&
    fault.runId === runId &&
    fault.fault === 'backendService' &&
    fault.action === 'restart' &&
    fault.role === 'all' &&
    Array.isArray(fault.runtimes) &&
    fault.runtimes.length === 3 &&
    fault.restarted === true &&
    fault.before?.healthy === true &&
    fault.after?.healthy === true &&
    /^[a-f0-9]{64}$/.test(fault.before.generation ?? '') &&
    /^[a-f0-9]{64}$/.test(fault.after.generation ?? '') &&
    fault.before.generation !== fault.after.generation,
  'Backend restart did not produce a valid Recovery proof',
);

const proof = {
  schemaVersion: 1,
  runId,
  fault: {
    kind: fault.fault,
    target: fault.containerName,
    appliedAt: fault.observedAt,
  },
  before: fault.before,
  after: fault.after,
};
const proofPath = join(runtimeDir, 'recovery-proof.json');
const temporaryPath = `${proofPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(proof, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
await rename(temporaryPath, proofPath);
await chmod(proofPath, 0o600);
console.log(`Recovery fault proof captured: ${runId}`);
