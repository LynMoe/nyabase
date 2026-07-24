import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deriveBeginTransition,
  validateConsecutivePair,
  verifyCandidate,
} from './full-run-chain.mjs';

function pointer(runId, sequence) {
  return {
    runId,
    runtimeDir: `/e2e/.runtime/${runId}`,
    sequence,
    receiptPath: `/e2e/.runtime/${runId}/full-run-candidate.json`,
    receiptSha256: String(sequence).padStart(64, 'a').slice(-64),
  };
}

test('Full begin consumes only the immediately available candidate', () => {
  const candidate = pointer('full-first', 4);
  const beganAt = '2026-07-17T00:10:00.000Z';
  const transition = deriveBeginTransition(
    {
      schemaVersion: 1,
      sequence: 4,
      updatedAt: '2026-07-17T00:00:00.000Z',
      active: null,
      candidate,
    },
    {
      runId: 'full-second',
      runtimeDir: '/e2e/.runtime/full-second',
      beganAt,
      tokenSha256: 'b'.repeat(64),
    },
  );

  assert.equal(transition.sequence, 5);
  assert.deepEqual(transition.predecessor, candidate);
  assert.equal(transition.invalidatedActiveRunId, null);
  assert.deepEqual(transition.state.active.predecessor, candidate);
  assert.equal(transition.state.candidate, null);
});

test('an incomplete intervening Full attempt breaks the candidate chain', () => {
  const transition = deriveBeginTransition(
    {
      schemaVersion: 1,
      sequence: 5,
      updatedAt: '2026-07-17T00:10:00.000Z',
      active: {
        runId: 'full-failed',
        runtimeDir: '/e2e/.runtime/full-failed',
        sequence: 5,
      },
      candidate: pointer('full-first', 4),
    },
    {
      runId: 'full-after-failure',
      runtimeDir: '/e2e/.runtime/full-after-failure',
      beganAt: '2026-07-17T00:20:00.000Z',
      tokenSha256: 'c'.repeat(64),
    },
  );

  assert.equal(transition.sequence, 6);
  assert.equal(transition.predecessor, null);
  assert.equal(transition.invalidatedActiveRunId, 'full-failed');
  assert.equal(transition.state.active.predecessor, null);
});

test('Full begin rejects an available candidate that is not the expected release predecessor', () => {
  const available = pointer('full-interloper', 6);
  assert.throws(
    () => deriveBeginTransition(
      {
        schemaVersion: 1,
        sequence: 6,
        updatedAt: '2026-07-17T00:00:00.000Z',
        active: null,
        candidate: available,
      },
      {
        runId: 'full-release-b',
        runtimeDir: '/e2e/.runtime/full-release-b',
        beganAt: '2026-07-17T00:10:00.000Z',
        tokenSha256: 'b'.repeat(64),
        expectedPredecessor: {
          runId: 'full-release-a',
          receiptSha256: 'c'.repeat(64),
        },
      },
    ),
    /does not match the expected predecessor/,
  );
});

test('real candidate verifier rejects missing state and a missing bound receipt', () => {
  const runtimeBase = mkdtempSync(join(tmpdir(), 'nyabase-real-candidate-verifier-'));
  const runId = 'candidate-verifier-a';
  const runtimeDir = join(runtimeBase, runId);
  const statePath = join(runtimeBase, 'full-run-chain-state.json');
  mkdirSync(runtimeDir, { mode: 0o700 });
  try {
    assert.throws(
      () => verifyCandidate(runtimeDir, runId, { runtimeBase, statePath }),
      /candidate pointer is missing/,
    );
    writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      updatedAt: '2026-07-17T00:00:00.000Z',
      active: null,
      candidate: {
        runId,
        runtimeDir,
        sequence: 1,
        receiptPath: join(runtimeDir, 'full-run-candidate.json'),
        receiptSha256: 'd'.repeat(64),
      },
    })}\n`, { mode: 0o600 });
    assert.throws(
      () => verifyCandidate(runtimeDir, runId, { runtimeBase, statePath }),
      /ENOENT|no such file/i,
    );
  } finally {
    rmSync(runtimeBase, { recursive: true, force: true });
  }
});

function pairScenario() {
  const source = {
    gitSha: 'd'.repeat(40),
    trackedDiffSha256: '1'.repeat(64),
    untrackedSourceSha256: '2'.repeat(64),
    productSourceSha256: '3'.repeat(64),
  };
  const receiptSha256 = '4'.repeat(64);
  const previous = {
    receiptSha256,
    value: { completedAt: '2026-07-17T00:05:00.000Z' },
    snapshot: {
      runId: 'full-first',
      runtimeDir: '/e2e/.runtime/full-first',
      sequence: 8,
      ledgerSha256: '5'.repeat(64),
      source,
      freshMigration: { volumeName: 'nyabase-e2e-full-first-backend-data' },
    },
  };
  const current = {
    runId: 'full-second',
    runtimeDir: '/e2e/.runtime/full-second',
    sequence: 9,
    ledgerSha256: '5'.repeat(64),
    source,
    build: { builtAt: '2026-07-17T00:11:00.000Z' },
    freshMigration: { volumeName: 'nyabase-e2e-full-second-backend-data' },
  };
  const attempt = {
    sequence: 9,
    beganAt: '2026-07-17T00:10:00.000Z',
    predecessor: { receiptSha256 },
  };
  return { previous, current, attempt };
}

test('pair validation requires adjacent sequence, identical source, and distinct cold volume', () => {
  const scenario = pairScenario();
  assert.equal(
    validateConsecutivePair(scenario.previous, scenario.current, scenario.attempt),
    true,
  );

  assert.throws(
    () =>
      validateConsecutivePair(
        scenario.previous,
        { ...scenario.current, sequence: 10 },
        { ...scenario.attempt, sequence: 10 },
      ),
    /sequence is not consecutive/,
  );
  assert.throws(
    () =>
      validateConsecutivePair(scenario.previous, {
        ...scenario.current,
        source: { ...scenario.current.source, productSourceSha256: '9'.repeat(64) },
      }, scenario.attempt),
    /different source fingerprints/,
  );
  assert.throws(
    () =>
      validateConsecutivePair(
        scenario.previous,
        {
          ...scenario.current,
          freshMigration: scenario.previous.snapshot.freshMigration,
        },
        scenario.attempt,
      ),
    /reused the same database volume/,
  );
});
