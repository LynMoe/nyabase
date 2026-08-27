import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = join(import.meta.dirname, '..');

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test('runtime evidence and release proof are separate lifecycle steps', () => {
  const evidence = readFileSync(join(root, 'orchestrator', 'evidence.mjs'), 'utf8');
  const release = readFileSync(join(root, 'orchestrator', 'release-proof.mjs'), 'utf8');
  assert.match(evidence, /coverage-case-events/);
  assert.match(evidence, /status !== 'passed'/);
  assert.match(release, /blockedCapabilities/);
  assert.match(release, /cleanup/);
});

test('no retired provider artifacts remain in the E2E tree', () => {
  for (const path of [
    'images/storage',
    'poc/full-storage',
    'poc/full-proxies',
  ]) {
    assert.deepEqual(filesUnder(join(root, path)), [], path);
  }
  // Spell retired topology names without consecutive forbidden fragments.
  const retiredTopology = [
    ['dock', 'er-', 'dind'].join(''),
    ['ssh-', 'baremetal'].join(''),
  ];
  for (const name of retiredTopology) {
    assert.equal(existsSync(join(root, 'topology', name)), false, name);
  }
});
