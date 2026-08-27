import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , runtimeRoot, profile] = process.argv;
if (!runtimeRoot || !profile) throw new Error('usage: evidence.mjs <runtime-root> <profile>');
const casePath = join(runtimeRoot, 'coverage-case-events.jsonl');
if (!existsSync(casePath)) throw new Error('BLOCKED: Playwright produced no coverage case evidence');
const ledger = JSON.parse(readFileSync(
  join(new URL('.', import.meta.url).pathname, '..', 'coverage', 'features.yaml'),
  'utf8',
));

const events = readFileSync(casePath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const selected = events.filter((event) => event.profile === profile);
if (selected.length === 0) {
  throw new Error(`BLOCKED: no coverage events for profile ${profile}`);
}
const expected = new Set(
  ledger.features.flatMap((feature) => feature.cases ?? [])
    .filter((entry) => entry.status === 'implemented' && entry.profiles.includes(profile))
    .map((entry) => entry.caseId),
);
const observed = new Set(selected.map((event) => event.caseId));
const missing = [...expected].filter((caseId) => !observed.has(caseId));
if (missing.length > 0) {
  throw new Error(
    `BLOCKED: profile ${profile} did not execute expected coverage cases: ${missing.join(', ')}`,
  );
}
const unexpected = [...observed].filter((caseId) => !expected.has(caseId));
if (unexpected.length > 0) {
  throw new Error(
    `E2E runtime evidence contains cases outside profile ${profile}: ${unexpected.join(', ')}`,
  );
}
const runId = process.env.E2E_RUN_ID;
const coverageNonce = process.env.E2E_COVERAGE_RUN_NONCE;
if (runId && selected.some((event) => event.runId !== runId || event.source !== 'playwright')) {
  throw new Error(`E2E runtime evidence contains events from another run or source`);
}
if (
  coverageNonce
  && selected.some((event) => event.coverageNonce !== coverageNonce)
) {
  throw new Error(`E2E runtime evidence contains stale coverage artifacts`);
}
const failed = selected.filter((event) => event.status !== 'passed');
if (failed.length > 0) {
  throw new Error(`E2E runtime evidence contains ${failed.length} failed case(s)`);
}
const uniqueCases = new Set(selected.map((event) => event.caseId));
console.log(`runtime-evidence=passed profile=${profile} cases=${uniqueCases.size}/${expected.size}`);
