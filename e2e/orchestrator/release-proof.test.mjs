import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  deriveReleaseProof,
  validateDeclaredReleaseFullChain,
} from './release-proof.mjs';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(runId, profile, productSourceSha256 = '4'.repeat(64)) {
  return {
    runId,
    profile,
    runtimeDir: `/e2e/.runtime/${runId}`,
    ledgerSha256: '5'.repeat(64),
    cleanup: { manifestSchemaVersion: 2 },
    source: {
      gitSha: 'a'.repeat(40),
      trackedDiffSha256: '1'.repeat(64),
      untrackedSourceSha256: '2'.repeat(64),
      productSourceSha256,
    },
  };
}

function releaseRuns() {
  const fullA = run('release-contract-a', 'full');
  const fullB = run('release-contract-b', 'full');
  const recovery = run('release-contract-recovery', 'recovery');
  fullA.candidate = { sha256: '6'.repeat(64), sequence: 8, standalone: true };
  fullB.fullRunChain = {
    previous: {
      runId: fullA.runId,
      runtimeDir: fullA.runtimeDir,
      sequence: 8,
      receiptSha256: fullA.candidate.sha256,
    },
    current: {
      runId: fullB.runId,
      runtimeDir: fullB.runtimeDir,
      sequence: 9,
    },
  };
  return { fullA, fullB, recovery };
}

test('release proof requires Full A=75, Full B=0, Recovery=0 from one source', () => {
  const runs = releaseRuns();
  const proof = deriveReleaseProof({
    releaseId: 'release-contract',
    ...runs,
    exitStatuses: { fullA: 75, fullB: 0, recovery: 0 },
    observedAt: '2026-07-17T00:00:00.000Z',
  });
  assert.equal(proof.sameSourceFingerprint, true);
  assert.equal(proof.runs.recovery.profile, 'recovery');
  assert.equal(proof.manifestSchemaVersion, 2);
});

test('release proof rejects status, profile, source, and run identity drift', () => {
  const runs = releaseRuns();
  const base = {
    releaseId: 'release-contract',
    ...runs,
    exitStatuses: { fullA: 75, fullB: 0, recovery: 0 },
    observedAt: '2026-07-17T00:00:00.000Z',
  };
  assert.throws(() => deriveReleaseProof({ ...base, exitStatuses: { ...base.exitStatuses, fullA: 0 } }), /exit-status/);
  assert.throws(() => deriveReleaseProof({ ...base, recovery: run('release-contract-recovery', 'full') }), /Recovery/);
  assert.throws(() => deriveReleaseProof({ ...base, recovery: run('release-contract-recovery', 'recovery', '9'.repeat(64)) }), /source fingerprints/);
  assert.throws(() => deriveReleaseProof({ ...base, recovery: run('release-contract-a', 'recovery') }), /distinct runIds/);
  assert.throws(
    () => deriveReleaseProof({
      ...base,
      recovery: { ...base.recovery, cleanup: { manifestSchemaVersion: 1 } },
    }),
    /manifest schema/,
  );
  assert.throws(
    () => deriveReleaseProof({
      ...base,
      fullB: {
        ...base.fullB,
        fullRunChain: {
          ...base.fullB.fullRunChain,
          previous: {
            ...base.fullB.fullRunChain.previous,
            runId: 'release-contract-interloper',
            runtimeDir: '/e2e/.runtime/release-contract-interloper',
          },
        },
      },
    }),
    /declared Full A -> Full B pair/,
  );
  assert.throws(
    () => deriveReleaseProof({
      ...base,
      fullA: {
        ...base.fullA,
        candidate: { ...base.fullA.candidate, standalone: false },
      },
    }),
    /candidate binding is missing/,
  );
});

test('release artifact validator parses B proof and rejects an A -> C -> B substitution', () => {
  const root = mkdtempSync(join(tmpdir(), 'nyabase-release-chain-binding-'));
  const fullA = run('release-artifact-a', 'full');
  const fullB = run('release-artifact-b', 'full');
  fullA.runtimeDir = join(root, fullA.runId);
  fullB.runtimeDir = join(root, fullB.runId);
  mkdirSync(fullA.runtimeDir, { mode: 0o700 });
  mkdirSync(fullB.runtimeDir, { mode: 0o700 });
  const candidatePath = join(fullA.runtimeDir, 'full-run-candidate.json');
  const chainPath = join(fullB.runtimeDir, 'full-run-chain-proof.json');
  const attemptPath = join(fullB.runtimeDir, 'full-run-attempt.json');
  const token = '7'.repeat(64);
  const tokenSha256 = digest(Buffer.from(token));
  const attempt = {
    schemaVersion: 1,
    runId: fullB.runId,
    profile: 'full',
    runtimeDir: fullB.runtimeDir,
    sequence: 12,
    token,
    tokenSha256,
    predecessor: {
      runId: fullA.runId,
      runtimeDir: fullA.runtimeDir,
      sequence: 11,
      receiptPath: candidatePath,
      receiptSha256: '',
    },
  };
  const candidate = {
    schemaVersion: 1,
    runId: fullA.runId,
    profile: 'full',
    runtimeDir: fullA.runtimeDir,
    sequence: 11,
    beganAt: '2026-07-20T00:00:00.000Z',
    completedAt: '2026-07-20T00:01:00.000Z',
    validationMode: 'single-full-candidate',
    receiptPath: candidatePath,
    evidenceSha256: '8'.repeat(64),
    ledgerSha256: fullA.ledgerSha256,
    source: fullA.source,
    playwrightReportSha256: '9'.repeat(64),
    cleanupManifestSha256: 'a'.repeat(64),
    freshMigrationArtifactSha256: 'b'.repeat(64),
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
  const candidateArtifact = {
    path: candidatePath,
    sha256: digest(candidateBytes),
    bytes: candidateBytes,
  };
  attempt.predecessor.receiptSha256 = candidateArtifact.sha256;
  const attemptBytes = Buffer.from(`${JSON.stringify(attempt)}\n`);
  writeFileSync(attemptPath, attemptBytes, { mode: 0o600 });
  Object.assign(fullA, {
    evidence: { sha256: candidate.evidenceSha256 },
    playwright: { sha256: candidate.playwrightReportSha256 },
    cleanup: { ...fullA.cleanup, sha256: candidate.cleanupManifestSha256 },
  });
  Object.assign(fullB, {
    evidence: { sha256: 'c'.repeat(64) },
    build: { sha256: 'd'.repeat(64) },
    playwright: { sha256: 'e'.repeat(64), expected: 200 },
    cleanup: { ...fullB.cleanup, sha256: 'f'.repeat(64) },
  });
  const chain = {
    schemaVersion: 1,
    caseId: 'cleanup.release-evidence.two-consecutive-cold-full-runs',
    producer: 'orchestrator/full-run-chain complete (two consecutive cold full runs)',
    status: 'passed',
    profile: 'full',
    observedAt: '2026-07-20T00:03:00.000Z',
    noInterveningFullAttempt: true,
    sameSourceFingerprint: true,
    distinctColdRuntimeIdentity: true,
    previous: {
      runId: fullA.runId,
      runtimeDir: fullA.runtimeDir,
      sequence: candidate.sequence,
      receiptPath: candidatePath,
      receiptSha256: candidateArtifact.sha256,
      completedAt: candidate.completedAt,
      evidenceSha256: fullA.evidence.sha256,
      ledgerSha256: fullA.ledgerSha256,
      source: fullA.source,
      playwrightReportSha256: fullA.playwright.sha256,
      cleanupManifestSha256: fullA.cleanup.sha256,
      freshMigration: { artifactSha256: candidate.freshMigrationArtifactSha256 },
    },
    current: {
      runId: fullB.runId,
      runtimeDir: fullB.runtimeDir,
      sequence: 12,
      ledgerSha256: fullB.ledgerSha256,
      source: fullB.source,
      buildProvenanceSha256: fullB.build.sha256,
      playwrightReportSha256: fullB.playwright.sha256,
      playwrightExpected: fullB.playwright.expected,
      cleanupManifestSha256: fullB.cleanup.sha256,
    },
    attempt: {
      path: attemptPath,
      sha256: digest(attemptBytes),
      tokenSha256,
      predecessorReceiptSha256: candidateArtifact.sha256,
    },
  };

  function artifactFor(value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    return { path: chainPath, sha256: digest(bytes), bytes };
  }

  try {
    const chainArtifact = artifactFor(chain);
    fullB.fullChainEvidence = {
      caseId: chain.caseId,
      kind: 'evidence',
      source: 'cleanup',
      status: 'passed',
      evidenceProducer: chain.producer,
      artifactPath: chainPath,
      artifactSha256: chainArtifact.sha256,
    };
    assert.doesNotThrow(() => validateDeclaredReleaseFullChain({
      fullA,
      fullB,
      candidateArtifact,
      chainProof: chain,
      chainArtifact,
    }));

    const interloper = structuredClone(chain);
    interloper.previous.runId = 'release-artifact-interloper';
    interloper.previous.runtimeDir = join(root, interloper.previous.runId);
    const interloperArtifact = artifactFor(interloper);
    fullB.fullChainEvidence.artifactSha256 = interloperArtifact.sha256;
    assert.throws(
      () => validateDeclaredReleaseFullChain({
        fullA,
        fullB,
        candidateArtifact,
        chainProof: interloper,
        chainArtifact: interloperArtifact,
      }),
      /predecessor is not the declared Full A candidate/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
