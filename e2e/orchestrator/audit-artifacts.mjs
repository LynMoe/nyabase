#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  containsForbiddenCredentialPattern,
  inspectPreReportPlaywrightArtifactPolicy,
  inspectPlaywrightArtifactPolicy,
  knownSecretsFromEnv,
  MAX_RETAINED_ARTIFACT_BYTES,
} from './playwright-artifact-security.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

const runtimeDir = resolve(process.argv[2] ?? '');
const auditMode = process.argv.length === 4 ? process.argv[3] : '--retained-final';
if (
  !process.argv[2]
  || (process.argv.length !== 3 && process.argv.length !== 4)
  || (process.argv.length === 4 && auditMode !== '--pre-report')
) {
  throw new Error('usage: audit-artifacts.mjs <runtimeDir> [--pre-report]');
}
const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const secretValues = knownSecretsFromEnv(await readFile(join(runtimeDir, 'secrets.env'), 'utf8'));
const secrets = secretValues.map((value) => Buffer.from(value));
const { runId } = await loadValidatedRunState(runtimeDir);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function walk(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`artifact path must not be a symlink: ${path}`);
    if (info.isFile()) return [path];
    if (!info.isDirectory()) return [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    files.push(...await walk(join(path, entry.name)));
  }
  return files;
}

const roots = [
  join(runtimeDir, 'reports'),
  join(runtimeDir, 'test-results'),
  join(runtimeDir, 'diagnostics'),
  join(runtimeDir, 'probe-evidence.json'),
  join(runtimeDir, 'recovery-proof.json'),
  join(runtimeDir, 'coverage-case-events.jsonl'),
  join(runtimeDir, 'coverage-http-events.jsonl'),
  join(runtimeDir, 'manifest.json'),
  join(runtimeDir, 'seed.json'),
  join(runtimeDir, 'seed-runtime-patch.json'),
  join(runtimeDir, 'fixture-evidence'),
  join(runtimeDir, 'build.env'),
];
const files = (await Promise.all(roots.map(walk))).flat();
const findings = [];
for (const path of files) {
  if (basename(path) === 'artifact-audit.json') continue;
  const info = await lstat(path);
  if (info.size > MAX_RETAINED_ARTIFACT_BYTES) {
    findings.push(
      `${relative(runtimeDir, path)} exceeds the ${MAX_RETAINED_ARTIFACT_BYTES}-byte artifact audit bound`,
    );
    continue;
  }
  const bytes = await readFile(path);
  if (secrets.some((secret) => bytes.includes(secret))) {
    findings.push(`${relative(runtimeDir, path)} contains a known per-run secret`);
    continue;
  }
  const text = bytes.toString('utf8');
  if (containsForbiddenCredentialPattern(text)) {
    findings.push(`${relative(runtimeDir, path)} contains a forbidden credential pattern`);
  }
}
const playwrightArtifactPolicy = auditMode === '--pre-report'
  ? 'pre-report-empty'
  : 'retained-final';
findings.push(...await (
  auditMode === '--pre-report'
    ? inspectPreReportPlaywrightArtifactPolicy(runtimeDir)
    : inspectPlaywrightArtifactPolicy(runtimeDir)
));

const fixtureDir = join(runtimeDir, 'fixture-evidence');
const fixtureIndexPath = join(fixtureDir, 'index.json');
const ledger = JSON.parse(await readFile(join(e2eRoot, 'coverage', 'features.yaml'), 'utf8'));
const expectedFixtures = new Map(
  ledger.features.flatMap((feature) => feature.cases)
    .filter((coverageCase) => coverageCase.kind === 'fixture')
    .map((coverageCase) => [coverageCase.caseId, coverageCase.fixtureProducer]),
);
if (expectedFixtures.size !== 8) {
  findings.push(`coverage ledger declares ${expectedFixtures.size} fixtures instead of eight`);
}
const fixtureDirInfo = await lstat(fixtureDir);
if (!fixtureDirInfo.isDirectory() || fixtureDirInfo.isSymbolicLink() || (fixtureDirInfo.mode & 0o777) !== 0o700) {
  findings.push('fixture-evidence must be a real mode 0700 directory');
}
const fixtureIndexInfo = await lstat(fixtureIndexPath);
const fixtureIndexReadable = fixtureIndexInfo.isFile()
  && !fixtureIndexInfo.isSymbolicLink()
  && fixtureIndexInfo.size <= MAX_RETAINED_ARTIFACT_BYTES;
if (!fixtureIndexInfo.isFile() || fixtureIndexInfo.isSymbolicLink() || (fixtureIndexInfo.mode & 0o777) !== 0o600) {
  findings.push('fixture-evidence/index.json must be a regular mode 0600 file');
}
if (fixtureIndexInfo.size > MAX_RETAINED_ARTIFACT_BYTES) {
  findings.push('fixture-evidence/index.json exceeds the artifact audit bound');
}
let fixtureIndex = { fixtures: [] };
if (fixtureIndexReadable) {
  try {
    fixtureIndex = JSON.parse(await readFile(fixtureIndexPath, 'utf8'));
  } catch (error) {
    findings.push(`fixture-evidence/index.json is unreadable: ${error.message}`);
  }
}
if (
  fixtureIndex.schemaVersion !== 1
  || fixtureIndex.runId !== runId
  || !Array.isArray(fixtureIndex.fixtures)
  || fixtureIndex.fixtures.length !== 8
) {
  findings.push('fixture-evidence/index.json does not bind exactly eight proofs to this run');
}
const fixtureCaseIds = new Set();
for (const record of fixtureIndex.fixtures ?? []) {
  if (fixtureCaseIds.has(record.caseId)) findings.push(`duplicate fixture proof ${record.caseId}`);
  fixtureCaseIds.add(record.caseId);
  const expectedProducer = expectedFixtures.get(record.caseId);
  if (!expectedProducer) findings.push(`unexpected fixture proof ${String(record.caseId)}`);
  if (record.producer !== expectedProducer) findings.push(`fixture proof ${record.caseId} producer mismatch`);
  if (!/^[0-9a-f]{64}$/.test(record.artifactSha256 ?? '')) {
    findings.push(`fixture proof ${record.caseId} has an invalid artifact hash`);
  }
  const artifactPath = isAbsolute(record.artifactPath)
    ? resolve(record.artifactPath)
    : resolve(runtimeDir, record.artifactPath ?? '');
  if (!artifactPath.startsWith(`${fixtureDir}${sep}`) || dirname(artifactPath) !== fixtureDir) {
    findings.push(`fixture proof ${record.caseId} escapes fixture-evidence`);
    continue;
  }
  try {
    const info = await lstat(artifactPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      findings.push(`fixture proof ${record.caseId} is not a regular file`);
      continue;
    }
    if ((info.mode & 0o777) !== 0o600) findings.push(`fixture proof ${record.caseId} is not mode 0600`);
    if (info.size > MAX_RETAINED_ARTIFACT_BYTES) {
      findings.push(`fixture proof ${record.caseId} exceeds the artifact audit bound`);
      continue;
    }
    const bytes = await readFile(artifactPath);
    if (record.artifactSha256 !== sha256(bytes)) findings.push(`fixture proof ${record.caseId} hash mismatch`);
    const proof = JSON.parse(bytes.toString('utf8'));
    if (
      proof.schemaVersion !== 1
      || proof.runId !== runId
      || proof.caseId !== record.caseId
      || proof.producer !== record.producer
      || proof.status !== 'passed'
      || proof.observedAt !== record.observedAt
      || !proof.claims
      || typeof proof.claims !== 'object'
      || Array.isArray(proof.claims)
    ) {
      findings.push(`fixture proof ${record.caseId} binding mismatch`);
    }
  } catch (error) {
    findings.push(`fixture proof ${record.caseId} is unreadable: ${error.message}`);
  }
}
for (const caseId of expectedFixtures.keys()) {
  if (!fixtureCaseIds.has(caseId)) findings.push(`missing fixture proof ${caseId}`);
}

if (findings.length > 0) {
  throw new Error(`artifact credential audit FAILED: ${findings.join('; ')}`);
}

const evidencePath = join(runtimeDir, 'artifact-audit.json');
await writeFile(evidencePath, `${JSON.stringify({
  schemaVersion: 1,
  runId,
  checkedAt: new Date().toISOString(),
  status: 'clean',
  playwrightArtifactPolicy,
  filesChecked: files.length,
  knownSecretsChecked: secrets.length,
  fixtureProofsChecked: fixtureCaseIds.size,
}, null, 2)}\n`, { mode: 0o600 });
await chmod(evidencePath, 0o600);
console.log(`artifact credential audit PASS: ${files.length} files checked`);
