import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = join(import.meta.dirname, '..');

test('Incus lifecycle entrypoints are present', () => {
  for (const name of ['doctor', 'build', 'up', 'health', 'diagnose', 'down', 'run', 'release']) {
    const path = join(root, 'orchestrator', `${name}.sh`);
    assert.equal(existsSync(path), true, `${name}.sh is missing`);
    assert.match(readFileSync(path, 'utf8'), /incus|E2E_/i);
  }
});

test('lifecycle scripts do not invoke a retired container runtime', () => {
  const scripts = ['common.sh', 'doctor.sh', 'build.sh', 'up.sh', 'health.sh', 'diagnose.sh', 'down.sh', 'run.sh', 'release.sh'];
  const retired = ['dock', 'er'].join('');
  for (const name of scripts) {
    const source = readFileSync(join(root, 'orchestrator', name), 'utf8');
    assert.equal(source.toLowerCase().includes(retired), false, name);
  }
});
