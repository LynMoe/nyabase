import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const [, , runtimeRoot, runId, profile] = process.argv;
if (!runtimeRoot || !runId || !profile) {
  throw new Error('usage: release-proof.mjs <runtime-root> <run-id> <profile>');
}
const lifecycle = JSON.parse(readFileSync(join(runtimeRoot, 'lifecycle.json'), 'utf8'));
if (lifecycle.runId !== runId) throw new Error('lifecycle identity mismatch');
for (const phase of ['build', 'up', 'health', 'run', 'down']) {
  if (lifecycle.phases?.[phase]?.status !== 'passed') {
    throw new Error(`release is BLOCKED: phase ${phase} is not passed`);
  }
}
const seedPath = join(runtimeRoot, 'seed-state.json');
if (!existsSync(seedPath)) throw new Error('release is BLOCKED: seed evidence is absent');
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const gpuOk = seed.blocked?.gpu?.startsWith('BLOCKED:') === true
  || seed.blocked?.gpu?.startsWith('PROVEN:') === true;
const cephfsOk = seed.blocked?.cephfs?.startsWith('BLOCKED:') === true
  || seed.blocked?.cephfs?.startsWith('ENABLED:') === true;
if (seed.runId !== runId || !gpuOk || !cephfsOk) {
  throw new Error('release is BLOCKED: seed or explicit capability status markers are invalid');
}
const blockedCapabilities = [];
if (seed.blocked?.gpu?.startsWith('BLOCKED:') === true) {
  blockedCapabilities.push('gpu-pci');
}
if (seed.blocked?.cephfs?.startsWith('BLOCKED:') === true) {
  blockedCapabilities.push('cephfs-cluster');
}
const result = {
  schemaVersion: 1,
  runId,
  profile,
  status: 'passed',
  runtime: 'incus',
  cleanup: 'passed',
  blockedCapabilities,
  observedAt: new Date().toISOString(),
};
const path = join(runtimeRoot, 'release-proof.json');
writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`release-proof=${path}`);
