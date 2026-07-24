import assert from 'node:assert/strict';
import test from 'node:test';
import { behavioralClosureLabel, parseValidationMode } from './validation-mode.mjs';

test('static validation cannot masquerade as runtime evidence closure', () => {
  const mode = parseValidationMode([]);
  assert.deepEqual(mode.failures, []);
  assert.equal(
    behavioralClosureLabel({ ...mode, pending: 0 }),
    'STATIC CONTRACT ONLY (runtime evidence not evaluated)',
  );
});

test('evidence and candidate flags require one exact profile mode', () => {
  assert.match(parseValidationMode(['--evidence=proof.json']).failures.join(' '), /requires/);
  assert.match(parseValidationMode(['--full-chain-candidate']).failures.join(' '), /restricted/);
  assert.deepEqual(
    parseValidationMode([
      '--require-profile=full',
      '--evidence=proof.json',
      '--full-chain-candidate',
    ]).failures,
    [],
  );
});

test('duplicate and malformed mode flags fail closed', () => {
  const duplicate = parseValidationMode([
    '--require-profile=full',
    '--require-profile=core',
    '--evidence=a',
    '--evidence=b',
    '--full-chain-candidate',
    '--full-chain-candidate',
  ]);
  assert.equal(duplicate.failures.length, 3);
  assert.match(parseValidationMode(['--evidence']).failures.join(' '), /malformed/);
});

test('runtime labels are profile-specific and candidates disclaim closure', () => {
  assert.equal(
    behavioralClosureLabel({ requiredProfile: 'recovery', fullChainCandidate: false, pending: 0 }),
    'RECOVERY RUNTIME EVIDENCE VERIFIED',
  );
  assert.match(
    behavioralClosureLabel({ requiredProfile: 'full', fullChainCandidate: true, pending: 0 }),
    /release closure not verified/,
  );
});
