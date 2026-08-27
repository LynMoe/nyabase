import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface LedgerCase {
  caseId: string;
  status: 'implemented' | 'blocked';
  profiles: string[];
}

interface Feature {
  cases: LedgerCase[];
}

const ledger = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'coverage', 'features.yaml'),
  'utf8',
)) as { features: Feature[] };

const caseById = new Map(
  ledger.features.flatMap((feature) => feature.cases)
    .map((entry) => [entry.caseId, entry]),
);

export function coverageCase(caseId: string, specTestId: string): {
  tag: string[];
  annotation: Array<{ type: string; description: string }>;
} {
  if (!caseId || !specTestId) {
    throw new Error('coverageCase requires caseId and specTestId');
  }
  const entry = caseById.get(caseId);
  if (!entry) {
    throw new Error(`coverageCase ${caseId} is absent from the coverage ledger`);
  }
  return {
    tag: entry.status === 'implemented'
      ? entry.profiles.map((profile) => `@nyabase-profile-${profile}`)
      : ['@nyabase-profile-never'],
    annotation: [
      { type: 'nyabase.coverage.case', description: caseId },
      { type: 'nyabase.coverage.test-id', description: specTestId },
    ],
  };
}
