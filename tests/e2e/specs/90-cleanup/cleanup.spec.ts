import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { runCommand } from '../../support/incus-control.js';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';

const leftoverInventory = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../orchestrator/leftover-inventory.mjs',
);

function leftoverApiName(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return (
    value.startsWith(`e2e-${currentRunId()}`)
    || value.startsWith('e2e-')
    || value.startsWith('nyc-')
    || value.startsWith('nyv-')
    || value.startsWith('nyabase-preflight-')
  );
}

function asItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> => (
      Boolean(entry) && typeof entry === 'object'
    ));
  }
  if (value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)) {
    return ((value as { items: unknown[] }).items).filter((entry): entry is Record<string, unknown> => (
      Boolean(entry) && typeof entry === 'object'
    ));
  }
  return [];
}

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
  async ({ adminApi, seedState }) => {
    const extraSsh = (seedState.labServers ?? [])
      .map((worker) => worker.ssh)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const inventory = await runCommand('node', [leftoverInventory, ...extraSsh]);
    expect(inventory.code, `${inventory.stdout}\n${inventory.stderr}`).toBe(0);
    expect(inventory.stdout.trim()).toBe('');

    const containers = asItems(await expectJson(await adminApi.get('/api/admin/containers')));
    expect(
      containers
        .filter((entry) => leftoverApiName(entry.name) || leftoverApiName(entry.instanceName))
        .map((entry) => entry.name ?? entry.instanceName),
    ).toEqual([]);
    const volumes = asItems(await expectJson(await adminApi.get('/api/admin/volumes')));
    expect(
      volumes
        .filter((entry) => leftoverApiName(entry.name) || leftoverApiName(entry.volumeName))
        .map((entry) => entry.name ?? entry.volumeName),
    ).toEqual([]);
    const sharedVolumes = asItems(await expectJson(await adminApi.get('/api/admin/shared-volumes')));
    expect(
      sharedVolumes
        .filter((entry) => leftoverApiName(entry.name) || leftoverApiName(entry.volumeName))
        .map((entry) => entry.name ?? entry.volumeName),
    ).toEqual([]);

    const secret = requireRuntimeEnv('E2E_INCUS_TRUST_TOKEN');
    const runtimeRoot = requireRuntimeEnv('E2E_RUNTIME_ROOT');
    for (const path of filesUnder(runtimeRoot)) {
      const body = readFileSync(path, 'utf8');
      expect(body.includes(secret), path).toBe(false);
    }
  },
);
