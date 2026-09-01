import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = join(import.meta.dirname, '..');
const ledgerPath = join(root, 'coverage', 'features.json');

function validate(args = [], options = {}) {
  return execFileSync(
    process.execPath,
    [join(root, 'coverage', 'validate.mjs'), ...args],
    { cwd: root, encoding: 'utf8', ...options },
  );
}

test('the coverage ledger validates against current contracts', () => {
  const output = validate();
  assert.match(output, /canonical HTTP surfaces/);
  assert.match(output, /196 mapped \/ 0 unmapped/);
});

test('schema v4 pins aliases, forbids routeOwners, and records the unmapped budget', () => {
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const blocked = new Map(ledger.topology.blocked.map((entry) => [entry.capability, entry]));
  const profiles = new Set(
    ledger.features.flatMap((feature) => feature.cases.flatMap((entry) => entry.profiles)),
  );
  assert.equal(ledger.schemaVersion, 4);
  assert.equal(ledger.routeOwners, undefined);
  assert.equal(ledger.frontendRoutes, undefined);
  assert.equal(ledger.architecture.testClient, 'node-fetch-api');
  assert.equal(
    ledger.surfaceAliases['GET|/api/admin/images/:imageId/intents'],
    'GET|/api/admin/images/:id/intents',
  );
  assert.equal(
    ledger.surfaceAliases['GET|/api/admin/images/:imageId/assignments/:serverId/intents'],
    'GET|/api/admin/images/:id/assignments/:serverId/intents',
  );
  assert.equal(blocked.has('gpu-pci'), false);
  assert.equal(blocked.has('cephfs-cluster'), false);
  const gpuClaim = ledger.features
    .flatMap((feature) => feature.cases)
    .find((entry) => entry.caseId === 'container-gpu-pci-claim');
  assert.equal(gpuClaim?.status, 'implemented');
  const sharedCeph = ledger.features
    .flatMap((feature) => feature.cases)
    .find((entry) => entry.caseId === 'shared-cephfs-storage');
  assert.equal(sharedCeph?.status, 'implemented');
  assert.equal(ledger.topology.storageFamilies.find((entry) => entry.driver === 'dir')
    ?.resizeFamily, 'quota_online');
  assert.equal(ledger.topology.storageFamilies.find((entry) => entry.driver === 'lvm')
    ?.resizeFamily, 'block_backed');
  assert.equal(ledger.inventory.httpDecoratorCount, 188);
  assert.equal(ledger.inventory.canonicalHttpSurfaceCount, 186);
  assert.equal(ledger.inventory.maxUnmapped, 0);
  assert.deepEqual([...profiles].sort(), ['core', 'full', 'smoke']);
  const caseIds = ledger.features.flatMap((feature) => feature.cases.map((entry) => entry.caseId));
  assert.ok(caseIds.includes('contract-http-inventory'));
  assert.equal(caseIds.includes('canonical-route-inventory'), false);
});

test('--max-unmapped must be a non-negative integer', () => {
  assert.throws(
    () => validate(['--max-unmapped=-1'], { stdio: ['ignore', 'pipe', 'pipe'] }),
    (error) => {
      assert.match(String(error.stderr ?? error.stdout ?? error.message), /non-negative integer/);
      return true;
    },
  );
});
