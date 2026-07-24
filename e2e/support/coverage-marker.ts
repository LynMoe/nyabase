/**
 * Static and runtime coverage binding for a live Playwright test.
 *
 * This only adds report annotations. It does not change requests, fixtures, or
 * assertions. A marker is never closure evidence by itself: the post-run
 * coverage validator also requires a current-build Playwright PASS, matching
 * case events, and a post-down clean manifest.
 */
export function coverageCase(caseId: string, specTestId: string): {
  tag: string[];
  annotation: Array<{ type: string; description: string }>;
} {
  if (!caseId || !specTestId) throw new Error('coverageCase requires caseId and specTestId');
  const coverageCase = caseById.get(caseId);
  if (!coverageCase) throw new Error(`coverageCase ${caseId} is absent from the coverage ledger`);
  return {
    // Pending markers are useful executable scaffolds, but must never enter a
    // release profile until apply-profile-contract explicitly promotes them.
    // Otherwise Playwright can emit evidence which the post-run verifier must
    // (correctly) reject as unreviewed.
    tag: coverageCase.status === 'implemented'
      ? coverageCase.profiles.map((profile) => `@nyabase-profile-${profile}`)
      : ['@nyabase-coverage-pending'],
    annotation: [
      { type: 'nyabase.coverage.case', description: caseId },
      { type: 'nyabase.coverage.test-id', description: specTestId },
    ],
  };
}
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface CoverageLedger {
  features: Array<{
    cases: Array<{
      caseId: string;
      profiles: string[];
      status: 'implemented' | 'pending';
    }>;
  }>;
}

const ledger = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'coverage', 'features.yaml'),
  'utf8',
)) as CoverageLedger;
const caseById = new Map(
  ledger.features.flatMap((feature) => feature.cases.map((entry) => [entry.caseId, entry])),
);
