import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLeftoverCustomVolumeName,
  isLeftoverInstanceName,
} from './leftover-inventory.mjs';

const root = join(import.meta.dirname, '..');

test('Incus lifecycle entrypoints are present', () => {
  for (const name of [
    'doctor',
    'build',
    'up',
    'health',
    'diagnose',
    'down',
    'run',
    'replay',
    'start-control-plane',
    'stop-control-plane',
    'release',
  ]) {
    const path = join(root, 'orchestrator', `${name}.sh`);
    assert.equal(existsSync(path), true, `${name}.sh is missing`);
    assert.match(readFileSync(path, 'utf8'), /incus|E2E_/i);
  }
});

test('leftover sweep deletes every lab nyc/nyv instance', () => {
  const source = readFileSync(join(root, 'orchestrator', 'sweep-incus-leftovers.sh'), 'utf8');
  const down = readFileSync(join(root, 'orchestrator', 'down.sh'), 'utf8');
  assert.match(source, /nyc-\*|nyv-\*/);
  assert.match(source, /leftover-inventory\.mjs/);
  assert.match(down, /leftover-inventory\.mjs/);
  assert.equal(source.includes('owned_server_ids'), false);
  assert.equal(source.includes('user.nyabase.server_id'), false);
});

test('leftover inventory classifies instances and custom data volumes', () => {
  assert.equal(isLeftoverInstanceName('nyc-abc'), true);
  assert.equal(isLeftoverInstanceName('nyv-abc'), true);
  assert.equal(isLeftoverInstanceName('e2e-foo'), true);
  assert.equal(isLeftoverInstanceName('nyabase-preflight-x'), true);
  assert.equal(isLeftoverCustomVolumeName('nyv-abc', 'custom'), true);
  assert.equal(isLeftoverCustomVolumeName('e2e-vol', 'custom'), true);
  assert.equal(isLeftoverCustomVolumeName('nyv-abc/snap', 'custom'), true);
  assert.equal(isLeftoverCustomVolumeName('nyabase-e2e-quota-probe', 'custom'), false);
  assert.equal(isLeftoverCustomVolumeName('nyabase-quota-probe', 'custom'), false);
  assert.equal(isLeftoverCustomVolumeName('nyv-abc', 'container'), false);
});

test('lifecycle scripts do not invoke a retired container runtime', () => {
  const scripts = [
    'common.sh',
    'doctor.sh',
    'build.sh',
    'up.sh',
    'health.sh',
    'diagnose.sh',
    'down.sh',
    'run.sh',
    'replay.sh',
    'start-control-plane.sh',
    'stop-control-plane.sh',
    'release.sh',
  ];
  const retired = ['dock', 'er'].join('');
  for (const name of scripts) {
    const source = readFileSync(join(root, 'orchestrator', name), 'utf8');
    assert.equal(source.toLowerCase().includes(retired), false, name);
  }
});
