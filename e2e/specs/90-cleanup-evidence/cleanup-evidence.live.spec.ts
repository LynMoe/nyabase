import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';

interface ResourceManifest {
  schemaVersion: 2;
  runId: string;
  resources: Array<{
    kind: string;
    name: string;
    labels?: Record<string, string>;
  }>;
}

test.describe('90 cleanup and release evidence', () => {
  test('evidence.cleanup.every-live-resource-owned-by-current-run @smoke', coverageCase(
    'cleanup.release-evidence.pre-down-resource-ownership',
    'evidence.cleanup.every-live-resource-owned-by-current-run',
  ), async ({ anonymousApi }) => {
    await expectJson<Record<string, unknown>>(await anonymousApi.get('/api/public/settings'));

    const runId = currentRunId();
    const manifestPath = requireRuntimeEnv('E2E_RESOURCE_MANIFEST');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ResourceManifest;
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.runId).toBe(runId);
    expect(Array.isArray(manifest.resources)).toBe(true);
    expect(manifest.resources.length).toBeGreaterThan(0);

    const inventoryScript = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'orchestrator',
      'resource-inventory.mjs',
    );
    const inventory = JSON.parse(execFileSync(
      process.execPath,
      [inventoryScript, manifestPath, runId],
      { encoding: 'utf8' },
    )) as {
      ok: boolean;
      declared: string[];
      live: string[];
      undeclaredLive: string[];
      declaredButAbsent: string[];
    };
    expect(inventory.ok).toBe(true);
    expect(inventory.declared).toEqual(inventory.live);
    expect(inventory.declared.length).toBeGreaterThanOrEqual(8);
    expect(inventory.undeclaredLive).toEqual([]);
    expect(inventory.declaredButAbsent).toEqual([]);

    for (const resource of manifest.resources) {
      expect(resource.kind).not.toBe('');
      expect(resource.name).not.toBe('');
      const labelled = resource.labels?.['io.nyabase.e2e.run-id'] === runId;
      expect(
        labelled || resource.name.includes(runId),
        `${resource.kind} ${resource.name} is not owned by run ${runId}`,
      ).toBe(true);
    }

    const serialized = JSON.stringify(manifest).toLowerCase();
    expect(serialized).not.toMatch(/"(?:password|token|secret|privatekey)"\s*:/);
  });
});
