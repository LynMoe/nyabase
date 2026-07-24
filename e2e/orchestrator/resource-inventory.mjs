#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertManifestForRun } from './manifest-contract.mjs';

function sortedUnique(values, label) {
  const clean = values.map((value) => String(value).trim()).filter(Boolean);
  const unique = [...new Set(clean)].sort();
  if (unique.length !== clean.length) {
    throw new Error(`${label} contains duplicate or empty container identities`);
  }
  return unique;
}

export function compareContainerInventory(manifestResources, liveContainerNames) {
  const containerResources = manifestResources
    .filter((resource) => resource?.kind === 'container');
  // A resource identity is unique across active and retired history. Validate
  // history before selecting active entries so corruption cannot hide behind
  // a retired duplicate.
  sortedUnique(containerResources.map((resource) => resource.name), 'manifest history');
  const declared = sortedUnique(
    containerResources
      .filter((resource) => resource.active !== false)
      .map((resource) => resource.name),
    'manifest',
  );
  const live = sortedUnique(liveContainerNames, 'live inventory');
  const declaredSet = new Set(declared);
  const liveSet = new Set(live);
  const undeclaredLive = live.filter((name) => !declaredSet.has(name));
  const declaredButAbsent = declared.filter((name) => !liveSet.has(name));
  return {
    ok: undeclaredLive.length === 0 && declaredButAbsent.length === 0,
    declared,
    live,
    undeclaredLive,
    declaredButAbsent,
  };
}

function dockerContainerNames(args) {
  const output = execFileSync('docker', args, { encoding: 'utf8' });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function compareCurrentRunContainerInventory(manifest, runId) {
  assertManifestForRun(manifest, runId);
  const prefix = `nyabase-e2e-${runId}-`;
  const labelled = dockerContainerNames([
    'ps', '-a',
    '--filter', `label=io.nyabase.e2e.run-id=${runId}`,
    '--format', '{{.Names}}',
  ]);
  const prefixed = dockerContainerNames(['ps', '-a', '--format', '{{.Names}}'])
    .filter((name) => name.startsWith(prefix));
  const live = [...new Set([...labelled, ...prefixed])].sort();
  for (const name of live) {
    const actualRunId = execFileSync(
      'docker',
      ['inspect', '--format', '{{index .Config.Labels "io.nyabase.e2e.run-id"}}', name],
      { encoding: 'utf8' },
    ).trim();
    if (actualRunId !== runId) {
      throw new Error(`live container lacks exact current-run ownership: ${name}`);
    }
  }
  return compareContainerInventory(manifest.resources, live);
}

async function main() {
  const [manifestPath, runId] = process.argv.slice(2);
  if (!manifestPath || !runId) {
    throw new Error('usage: resource-inventory.mjs <manifest.json> <runId>');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const comparison = compareCurrentRunContainerInventory(manifest, runId);
  if (!comparison.ok) {
    throw new Error(
      `container manifest/live inventory mismatch: ${JSON.stringify({
        undeclaredLive: comparison.undeclaredLive,
        declaredButAbsent: comparison.declaredButAbsent,
      })}`,
    );
  }
  process.stdout.write(`${JSON.stringify(comparison)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
