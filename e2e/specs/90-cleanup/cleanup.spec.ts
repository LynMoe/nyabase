import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { runIncus } from '../../support/incus-control.js';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';

function filesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

test(
  'teardown evidence contains no run resources or onboarding secret',
  { ...coverageCase('cleanup-resource-proof', 'cleanup-resource-proof') },
  async () => {
    const result = await runIncus(['list', '--format', 'json']);
    expect(result.code, result.stderr).toBe(0);
    const resources = JSON.parse(result.stdout) as Array<{ name?: string }>;
    expect(resources.some((resource) => resource.name?.startsWith(`e2e-${currentRunId()}`)))
      .toBe(false);

    const secret = requireRuntimeEnv('E2E_INCUS_TRUST_TOKEN');
    const runtimeRoot = requireRuntimeEnv('E2E_RUNTIME_ROOT');
    for (const path of filesUnder(runtimeRoot)) {
      const body = readFileSync(path, 'utf8');
      expect(body.includes(secret), path).toBe(false);
    }
  },
);
