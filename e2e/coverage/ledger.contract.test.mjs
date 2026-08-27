import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = join(import.meta.dirname, '..');

test('the coverage ledger validates against current contracts', () => {
  const output = execFileSync(
    process.execPath,
    [join(root, 'coverage', 'validate.mjs')],
    { cwd: root, encoding: 'utf8' },
  );
  assert.match(output, /canonical HTTP surfaces/);
});

test('blocked hardware and cluster capabilities are explicit', () => {
  const ledger = JSON.parse(readFileSync(join(root, 'coverage', 'features.yaml'), 'utf8'));
  const blocked = new Map(ledger.topology.blocked.map((entry) => [entry.capability, entry]));
  assert.equal(blocked.get('gpu-pci')?.status, 'BLOCKED');
  assert.equal(blocked.get('cephfs-cluster')?.status, 'BLOCKED');
  assert.equal(ledger.topology.storageFamilies.find((entry) => entry.driver === 'dir')
    ?.resizeFamily, 'quota_online');
  assert.equal(ledger.topology.storageFamilies.find((entry) => entry.driver === 'lvm')
    ?.resizeFamily, 'block_backed');
});
