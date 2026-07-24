#!/usr/bin/env node
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  assertManifestForRun,
  assertResumableManifest,
  manifestSchemaVersion,
} from './manifest-contract.mjs';

const [command, runtimeDir, ...args] = process.argv.slice(2);
if (!command || !runtimeDir) throw new Error('usage: manifest.mjs <command> <runtimeDir> [args]');
const path = join(runtimeDir, 'manifest.json');

function assertRuntimeIdentity(expectedRunId) {
  if (basename(resolve(runtimeDir)) !== expectedRunId) {
    throw new Error('manifest runtime directory does not match expected runId');
  }
}

async function readManifest(expectedRunId) {
  assertRuntimeIdentity(expectedRunId);
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  assertManifestForRun(manifest, expectedRunId);
  return manifest;
}

async function writeManifest(value) {
  value.resources = (value.resources ?? []).map((entry) => ({
    kind: entry.kind,
    name: entry.name ?? entry.id,
    labels: entry.labels ?? { 'io.nyabase.e2e.run-id': value.runId },
    recordedAt: entry.recordedAt,
    active: entry.active !== false,
    ...(entry.retiredAt ? { retiredAt: entry.retiredAt } : {}),
  }));
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

if (command === 'init') {
  const [runId] = args;
  assertRuntimeIdentity(runId);
  await writeManifest({
    schemaVersion: manifestSchemaVersion,
    runId,
    createdAt: new Date().toISOString(),
    phase: 'initialized',
    resources: [],
    cleanup: null,
  });
} else if (command === 'assert-resumable') {
  const [expectedRunId] = args;
  if (!expectedRunId) {
    throw new Error('usage: manifest.mjs assert-resumable <runtimeDir> <runId>');
  }
  assertResumableManifest(await readManifest(expectedRunId), expectedRunId);
} else if (command === 'phase') {
  const [expectedRunId, phase, detail = ''] = args;
  if (!expectedRunId || !phase) {
    throw new Error('usage: manifest.mjs phase <runtimeDir> <runId> <phase> [detail]');
  }
  const manifest = await readManifest(expectedRunId);
  manifest.phase = phase;
  manifest.phaseDetail = detail;
  manifest.updatedAt = new Date().toISOString();
  await writeManifest(manifest);
} else if (command === 'resource') {
  const [expectedRunId, kind, name] = args;
  if (!expectedRunId || !kind || !name) {
    throw new Error('usage: manifest.mjs resource <runtimeDir> <runId> <kind> <name>');
  }
  const manifest = await readManifest(expectedRunId);
  const existing = manifest.resources.filter(
    (entry) => entry.kind === kind && (entry.name ?? entry.id) === name,
  );
  if (existing.length > 1) {
    throw new Error('resource registration found a duplicate identity');
  }
  if (existing[0]?.active === false) {
    throw new Error('retired resource identity cannot be reused within one run');
  }
  if (existing.length === 0) {
    manifest.resources.push({
      kind,
      name,
      labels: { 'io.nyabase.e2e.run-id': manifest.runId },
      recordedAt: new Date().toISOString(),
      active: true,
    });
  }
  await writeManifest(manifest);
} else if (command === 'retire') {
  const [expectedRunId, kind, name] = args;
  if (!expectedRunId || !kind || !name) {
    throw new Error('usage: manifest.mjs retire <runtimeDir> <runId> <kind> <name>');
  }
  const manifest = await readManifest(expectedRunId);
  if (manifest.runId !== expectedRunId) {
    throw new Error('resource retirement runId does not match the manifest');
  }
  const matches = manifest.resources.filter(
    (entry) => entry.kind === kind && (entry.name ?? entry.id) === name,
  );
  if (matches.length !== 1) {
    throw new Error('resource retirement requires exactly one recorded identity');
  }
  if (matches[0].active === false) {
    // Cleanup/restore is intentionally retryable. Exact identity and run
    // ownership were already validated above, so an already-retired entry is
    // a safe idempotent success rather than a reason to strand teardown.
    await writeManifest(manifest);
  } else {
    matches[0].active = false;
    matches[0].retiredAt = new Date().toISOString();
    await writeManifest(manifest);
  }
} else if (command === 'cleanup') {
  const [expectedRunId, status, detail = ''] = args;
  if (!expectedRunId || !status) {
    throw new Error('usage: manifest.mjs cleanup <runtimeDir> <runId> <status> [detail]');
  }
  const manifest = await readManifest(expectedRunId);
  manifest.phase = status === 'clean' ? 'cleaned' : 'cleanup_failed';
  manifest.cleanup = { status, detail, checkedAt: new Date().toISOString() };
  await writeManifest(manifest);
} else {
  throw new Error(`unknown manifest command: ${command}`);
}
