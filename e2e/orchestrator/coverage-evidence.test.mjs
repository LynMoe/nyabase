import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { validateRuntimeEvents } from './coverage-evidence.mjs';

const runtimeBase = resolve(import.meta.dirname, '..', '.runtime');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixtureScenario() {
  const runId = `evidence-${process.pid}-${randomBytes(4).toString('hex')}`;
  const runtimeDir = join(runtimeBase, runId);
  const fixtureDir = join(runtimeDir, 'fixture-evidence');
  await mkdir(fixtureDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(fixtureDir, 0o700);

  const createdAt = '2026-07-16T10:00:00.000Z';
  const fixtureObservedAt = '2026-07-16T10:00:01.000Z';
  const startedAt = '2026-07-16T10:00:02.000Z';
  const behavioralObservedAt = '2026-07-16T10:00:02.500Z';
  const fixtureCaseId = 'foundation.synthetic.fixture';
  const fixtureProducer = 'synthetic fixture producer';
  const proof = {
    schemaVersion: 1,
    runId,
    caseId: fixtureCaseId,
    producer: fixtureProducer,
    status: 'passed',
    observedAt: fixtureObservedAt,
    claims: { real: true },
  };
  const proofBytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
  const proofPath = join(fixtureDir, `${fixtureCaseId}.json`);
  await writeFile(proofPath, proofBytes, { mode: 0o600, flag: 'wx' });
  await chmod(proofPath, 0o600);

  const ledger = {
    schemaVersion: 2,
    features: [
      {
        id: 'foundation.synthetic',
        specs: ['specs/00-foundation/synthetic.live.spec.ts'],
        cases: [
          {
            caseId: fixtureCaseId,
            kind: 'fixture',
            status: 'implemented',
            profiles: ['core'],
            persona: 'platform-operator',
            specTestIds: [],
            httpSurfaces: [],
            fixtureProducer,
          },
          {
            caseId: 'foundation.synthetic.behavior',
            kind: 'behavioral',
            status: 'implemented',
            profiles: ['core'],
            persona: 'administrator',
            specTestIds: ['synthetic.behavior'],
            httpSurfaces: [],
          },
        ],
      },
    ],
  };
  const report = {
    config: { metadata: { runId, profile: 'core', cpuOnly: true } },
    errors: [],
    stats: {
      expected: 1,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
      startTime: startedAt,
      duration: 1_000,
    },
    suites: [
      {
        specs: [
          {
            file: '00-foundation/synthetic.live.spec.ts',
            title: 'synthetic behavior',
            ok: true,
            tests: [
              {
                status: 'expected',
                annotations: [
                  { type: 'nyabase.coverage.case', description: 'foundation.synthetic.behavior' },
                  { type: 'nyabase.coverage.test-id', description: 'synthetic.behavior' },
                ],
                results: [{ status: 'passed' }],
              },
            ],
          },
        ],
      },
    ],
  };
  const fixtureEvent = {
    schemaVersion: 1,
    runId,
    profile: 'core',
    caseId: fixtureCaseId,
    kind: 'fixture',
    source: 'fixture',
    status: 'passed',
    observedAt: fixtureObservedAt,
    fixtureProducer,
    artifactPath: proofPath,
    artifactSha256: sha256(proofBytes),
    persona: 'platform-operator',
    observedHttpSurfaces: [],
  };
  const behaviorEvent = {
    schemaVersion: 1,
    runId,
    profile: 'core',
    caseId: 'foundation.synthetic.behavior',
    kind: 'behavioral',
    source: 'playwright',
    status: 'passed',
    observedAt: behavioralObservedAt,
    specPath: 'specs/00-foundation/synthetic.live.spec.ts',
    specTestId: 'synthetic.behavior',
    persona: 'administrator',
    observedHttpSurfaces: [],
  };
  const input = {
    ledger,
    report,
    runId,
    profile: 'core',
    runtimeDir,
    runCreatedAt: createdAt,
    rawCaseEvents: [fixtureEvent, behaviorEvent],
    rawHttpEvents: [],
  };
  return { input, fixtureEvent, proofPath, runtimeDir };
}

test('fixture evidence accepts a bound private proof and rejects producer/hash tampering', async () => {
  const scenario = await fixtureScenario();
  try {
    const validated = validateRuntimeEvents(scenario.input);
    assert.equal(validated.length, 2);
    assert.equal(validated[0].source, 'fixture');
    assert.equal(validated[0].artifactSha256, scenario.fixtureEvent.artifactSha256);

    assert.throws(
      () =>
        validateRuntimeEvents({
          ...scenario.input,
          rawCaseEvents: [
            { ...scenario.fixtureEvent, fixtureProducer: 'tampered producer' },
            scenario.input.rawCaseEvents[1],
          ],
        }),
      /fixture producer mismatch/,
    );
    assert.throws(
      () =>
        validateRuntimeEvents({
          ...scenario.input,
          rawCaseEvents: [
            { ...scenario.fixtureEvent, artifactSha256: '0'.repeat(64) },
            scenario.input.rawCaseEvents[1],
          ],
        }),
      /fixture artifact hash mismatch/,
    );
  } finally {
    await rm(scenario.runtimeDir, { recursive: true, force: true });
  }
});
