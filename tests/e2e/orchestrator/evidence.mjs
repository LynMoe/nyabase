import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , runtimeRoot, profile, ...flags] = process.argv;
if (!runtimeRoot || !profile) throw new Error('usage: evidence.mjs <runtime-root> <profile> [--allow-subset]');
const allowSubset = flags.includes('--allow-subset');
const casePath = join(runtimeRoot, 'coverage-case-events.jsonl');
if (!existsSync(casePath)) throw new Error('BLOCKED: API runner produced no coverage case evidence');
const ledger = JSON.parse(readFileSync(
  join(new URL('.', import.meta.url).pathname, '..', 'coverage', 'features.json'),
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
if (missing.length > 0 && !allowSubset) {
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
if (runId && selected.some((event) => event.runId !== runId || event.source !== 'api-http')) {
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
const aliases = ledger.surfaceAliases ?? {};
const listedByCase = new Map(
  ledger.features.flatMap((feature) => feature.cases ?? [])
    .filter((entry) => entry.status === 'implemented' && entry.kind !== 'static-contract')
    .map((entry) => [
      entry.caseId,
      new Set((entry.httpSurfaces ?? []).map((surface) => aliases[surface] ?? surface)),
    ]),
);
const uncovered = [];
for (const event of selected.filter((entry) => entry.status === 'passed')) {
  const listed = listedByCase.get(event.caseId);
  if (!listed || listed.size === 0) continue;
  const observed = new Set(event.observedHttpSurfaces ?? []);
  const missingSurfaces = [...listed].filter((surface) => !observed.has(surface)).sort();
  if (missingSurfaces.length > 0) {
    uncovered.push(`${event.caseId}: ${missingSurfaces.join(', ')}`);
  }
}
if (uncovered.length > 0) {
  throw new Error(`BLOCKED: listed HTTP surfaces were not observed: ${uncovered.join('; ')}`);
}
const uniqueCases = new Set(selected.map((event) => event.caseId));
console.log(`runtime-evidence=passed profile=${profile} cases=${uniqueCases.size}/${expected.size}`);
