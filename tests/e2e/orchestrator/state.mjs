import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , command, runtimeRoot, runId, phase, status, detail = ''] = process.argv;
if (command !== 'phase' || !runtimeRoot || !runId || !phase || !status) {
  throw new Error('usage: state.mjs phase <runtime-root> <run-id> <phase> <status> [detail]');
}
if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(runId)) {
  throw new Error('unsafe run id');
}
mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
const path = join(runtimeRoot, 'lifecycle.json');
let state = { schemaVersion: 1, runId, phases: {} };
try {
  state = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  // The first phase creates the lifecycle record.
}
if (state.runId !== runId) throw new Error('lifecycle run id mismatch');
state.phases[phase] = {
  status,
  detail,
  observedAt: new Date().toISOString(),
};
writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
