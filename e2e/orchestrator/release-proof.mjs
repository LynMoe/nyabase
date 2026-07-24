#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanManifest, manifestSchemaVersion } from './manifest-contract.mjs';
import { validateFullRunChainArtifact } from './full-run-chain.mjs';

const orchestratorDir = dirname(fileURLToPath(import.meta.url));
const e2eRoot = resolve(orchestratorDir, '..');
const defaultRuntimeBase = join(e2eRoot, '.runtime');
const runIdPattern = /^[a-z0-9][a-z0-9-]{2,47}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const fullChainCaseId = 'cleanup.release-evidence.two-consecutive-cold-full-runs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function privateFile(path, label, maximum = 64 * 1024 * 1024) {
  const info = lstatSync(path);
  invariant(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  invariant(info.size > 0 && info.size <= maximum, `${label} has unsafe size`);
  invariant((info.mode & 0o077) === 0, `${label} must be mode 0600`);
  return readFileSync(path);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export function validateReleaseRunManifest(manifest, runId, evidenceCleanup) {
  assertCleanManifest(manifest, runId, `${runId} cleanup manifest`);
  invariant(
    evidenceCleanup?.manifestSchemaVersion === manifestSchemaVersion,
    `${runId} evidence does not bind the current manifest schema`,
  );
  return manifest;
}

function checkedRuntime(runId, runtimeBase) {
  invariant(runIdPattern.test(runId), `invalid release runId ${runId}`);
  const base = resolve(runtimeBase);
  const baseInfo = lstatSync(base);
  invariant(baseInfo.isDirectory() && !baseInfo.isSymbolicLink(), 'runtime base is invalid');
  invariant((baseInfo.mode & 0o077) === 0, 'runtime base must be private');
  const runtimeDir = resolve(base, runId);
  invariant(dirname(runtimeDir) === base && basename(runtimeDir) === runId, 'runtime path escapes base');
  const info = lstatSync(runtimeDir);
  invariant(info.isDirectory() && !info.isSymbolicLink(), `${runId} runtime directory is invalid`);
  invariant((info.mode & 0o077) === 0, `${runId} runtime directory must be private`);
  invariant(
    realpathSync(runtimeDir).startsWith(`${realpathSync(base)}${sep}`),
    `${runId} runtime directory resolves outside base`,
  );
  return runtimeDir;
}

function checkedArtifact(runtimeDir, value, expectedSha, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} path is missing`);
  invariant(shaPattern.test(expectedSha ?? ''), `${label} hash is invalid`);
  const path = isAbsolute(value) ? resolve(value) : resolve(runtimeDir, value);
  invariant(path.startsWith(`${runtimeDir}${sep}`), `${label} escapes runtime directory`);
  const bytes = privateFile(path, label);
  invariant(realpathSync(path).startsWith(`${realpathSync(runtimeDir)}${sep}`), `${label} symlink escapes runtime`);
  invariant(sha256(bytes) === expectedSha, `${label} hash mismatch`);
  return { path, sha256: expectedSha, bytes };
}

function sourceFingerprint(evidence) {
  const source = {
    gitSha: evidence.build?.gitSha,
    trackedDiffSha256: evidence.build?.trackedDiffSha256,
    untrackedSourceSha256: evidence.build?.untrackedSourceSha256,
    productSourceSha256: evidence.build?.productSourceSha256,
  };
  invariant(/^[0-9a-f]{40}$/.test(source.gitSha ?? ''), 'release git SHA is invalid');
  for (const [key, value] of Object.entries(source).slice(1)) {
    invariant(shaPattern.test(value ?? ''), `release ${key} is invalid`);
  }
  return source;
}

function loadRun(runId, profile, runtimeBase) {
  const runtimeDir = checkedRuntime(runId, runtimeBase);
  const evidencePath = join(runtimeDir, 'coverage-evidence.json');
  const evidenceBytes = privateFile(evidencePath, `${runId} coverage evidence`);
  const evidence = parseJson(evidenceBytes, `${runId} coverage evidence`);
  invariant(
    evidence.schemaVersion === 1
      && evidence.runId === runId
      && evidence.profile === profile
      && evidence.playwright?.status === 'passed'
      && evidence.cleanup?.phase === 'post-down'
      && evidence.cleanup?.status === 'clean',
    `${runId} is not a passed, post-down-clean ${profile} run`,
  );
  const report = checkedArtifact(
    runtimeDir,
    evidence.playwright.reportPath,
    evidence.playwright.reportSha256,
    `${runId} Playwright report`,
  );
  const reportJson = parseJson(report.bytes, `${runId} Playwright report`);
  invariant(
    reportJson.config?.metadata?.runId === runId
      && reportJson.config?.metadata?.profile === profile
      && reportJson.stats?.unexpected === 0
      && reportJson.stats?.flaky === 0
      && reportJson.stats?.skipped === 0
      && reportJson.stats?.expected > 0,
    `${runId} Playwright report is not all-green`,
  );
  const manifest = checkedArtifact(
    runtimeDir,
    evidence.cleanup.manifestPath,
    evidence.cleanup.manifestSha256,
    `${runId} cleanup manifest`,
  );
  const manifestJson = parseJson(manifest.bytes, `${runId} cleanup manifest`);
  validateReleaseRunManifest(manifestJson, runId, evidence.cleanup);
  const provenance = checkedArtifact(
    runtimeDir,
    evidence.build?.provenancePath,
    evidence.build?.provenanceSha256,
    `${runId} build provenance`,
  );
  const fullChainEvents = (evidence.caseEvents ?? []).filter(
    (event) => event.caseId === fullChainCaseId,
  );
  invariant(fullChainEvents.length <= 1, `${runId} has duplicate Full-chain evidence`);
  const fullChainEvidence = fullChainEvents[0] ?? null;
  return {
    runId,
    profile,
    runtimeDir,
    source: sourceFingerprint(evidence),
    ledgerSha256: evidence.ledgerSha256,
    evidence: { path: evidencePath, sha256: sha256(evidenceBytes) },
    build: { path: provenance.path, sha256: provenance.sha256 },
    playwright: { path: report.path, sha256: report.sha256, expected: reportJson.stats.expected },
    cleanup: {
      path: manifest.path,
      sha256: manifest.sha256,
      manifestSchemaVersion,
    },
    fullChainEvidence,
    coverageEvidence: evidence,
  };
}

function requiredRunArtifact(run, filename, label) {
  const path = join(run.runtimeDir, filename);
  const bytes = privateFile(path, label);
  return { path, sha256: sha256(bytes), bytes };
}

export function validateDeclaredReleaseFullChain({
  fullA,
  fullB,
  candidateArtifact,
  chainProof,
  chainArtifact,
}) {
  const candidate = parseJson(candidateArtifact.bytes, 'Full A candidate receipt');
  invariant(
    candidate.schemaVersion === 1
      && candidate.runId === fullA.runId
      && candidate.profile === 'full'
      && candidate.runtimeDir === fullA.runtimeDir
      && Number.isInteger(candidate.sequence)
      && candidate.sequence > 0
      && isDate(candidate.beganAt)
      && isDate(candidate.completedAt)
      && candidate.validationMode === 'single-full-candidate'
      && candidate.receiptPath === candidateArtifact.path,
    'Full A candidate receipt identity mismatch',
  );
  invariant(
    candidate.evidenceSha256 === fullA.evidence.sha256
      && candidate.ledgerSha256 === fullA.ledgerSha256
      && JSON.stringify(candidate.source) === JSON.stringify(fullA.source)
      && candidate.playwrightReportSha256 === fullA.playwright.sha256
      && candidate.cleanupManifestSha256 === fullA.cleanup.sha256
      && shaPattern.test(candidate.freshMigrationArtifactSha256 ?? ''),
    'Full A candidate receipt does not bind the declared Full A run',
  );
  invariant(
    chainProof.previous?.runId === fullA.runId
      && chainProof.previous.runtimeDir === fullA.runtimeDir
      && chainProof.previous.sequence === candidate.sequence
      && chainProof.previous.receiptPath === candidateArtifact.path
      && chainProof.previous.receiptSha256 === candidateArtifact.sha256,
    'Full B chain proof predecessor is not the declared Full A candidate',
  );
  invariant(
    chainProof.current?.runId === fullB.runId
      && chainProof.current.runtimeDir === fullB.runtimeDir
      && chainProof.current.sequence === candidate.sequence + 1,
    'Full B chain proof current run is not the declared Full B run',
  );

  return {
    candidate: {
      path: candidateArtifact.path,
      sha256: candidateArtifact.sha256,
      sequence: candidate.sequence,
    },
    fullRunChain: {
      path: chainArtifact.path,
      sha256: chainArtifact.sha256,
      previous: {
        runId: chainProof.previous.runId,
        runtimeDir: chainProof.previous.runtimeDir,
        sequence: chainProof.previous.sequence,
        receiptSha256: chainProof.previous.receiptSha256,
      },
      current: {
        runId: chainProof.current.runId,
        runtimeDir: chainProof.current.runtimeDir,
        sequence: chainProof.current.sequence,
      },
    },
  };
}

export function deriveReleaseProof({ releaseId, fullA, fullB, recovery, exitStatuses, observedAt }) {
  invariant(runIdPattern.test(releaseId), 'releaseId is invalid');
  invariant(fullA.profile === 'full' && fullB.profile === 'full', 'release requires two Full runs');
  invariant(recovery.profile === 'recovery', 'release requires one Recovery run');
  invariant(
    exitStatuses.fullA === 75 && exitStatuses.fullB === 0 && exitStatuses.recovery === 0,
    'release run exit-status contract is incomplete',
  );
  invariant(
    [fullA, fullB, recovery].every(
      (run) => run.cleanup?.manifestSchemaVersion === manifestSchemaVersion,
    ),
    'release runs do not bind the current manifest schema',
  );
  invariant(
    new Set([fullA.runId, fullB.runId, recovery.runId]).size === 3,
    'release runs must have distinct runIds',
  );
  const source = JSON.stringify(fullA.source);
  invariant(
    JSON.stringify(fullB.source) === source && JSON.stringify(recovery.source) === source,
    'release runs used different source fingerprints',
  );
  invariant(
    shaPattern.test(fullA.ledgerSha256 ?? '')
      && fullA.ledgerSha256 === fullB.ledgerSha256
      && fullB.ledgerSha256 === recovery.ledgerSha256,
    'release runs used different coverage ledgers',
  );
  invariant(
    shaPattern.test(fullA.candidate?.sha256 ?? '')
      && Number.isInteger(fullA.candidate?.sequence)
      && fullA.candidate.sequence > 0
      && fullA.candidate.standalone === true,
    'release Full A candidate binding is missing',
  );
  invariant(
    fullB.fullRunChain?.previous?.runId === fullA.runId
      && fullB.fullRunChain.previous.runtimeDir === fullA.runtimeDir
      && fullB.fullRunChain.previous.sequence === fullA.candidate.sequence
      && fullB.fullRunChain.previous.receiptSha256 === fullA.candidate.sha256
      && fullB.fullRunChain?.current?.runId === fullB.runId
      && fullB.fullRunChain.current.runtimeDir === fullB.runtimeDir
      && fullB.fullRunChain.current.sequence === fullA.candidate.sequence + 1,
    'release Full B chain does not bind the declared Full A -> Full B pair',
  );
  return {
    schemaVersion: 1,
    releaseId,
    status: 'passed',
    observedAt,
    sameSourceFingerprint: true,
    manifestSchemaVersion,
    source: fullA.source,
    ledgerSha256: fullA.ledgerSha256,
    exitStatuses,
    runs: { fullA, fullB, recovery },
  };
}

function atomicPrivateJson(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  invariant(!/(?:password|accessToken|refreshToken|agentToken|privateKey|secret)"?\s*:/i.test(serialized), 'release proof contains a credential field');
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, serialized, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const parentFd = openSync(dirname(path), 'r');
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function createReleaseProof(input, options = {}) {
  const runtimeBase = options.runtimeBase ?? defaultRuntimeBase;
  const fullA = loadRun(input.fullAId, 'full', runtimeBase);
  const fullB = loadRun(input.fullBId, 'full', runtimeBase);
  const recovery = loadRun(input.recoveryId, 'recovery', runtimeBase);
  const candidateArtifact = requiredRunArtifact(
    fullA,
    'full-run-candidate.json',
    'Full A candidate',
  );
  invariant(
    fullA.fullChainEvidence === null,
    'release Full A must be a standalone candidate, not a prior chain closure',
  );
  const candidateReceipt = parseJson(candidateArtifact.bytes, 'Full A candidate receipt');
  const fullAAttemptArtifact = requiredRunArtifact(
    fullA,
    'full-run-attempt.json',
    'Full A attempt record',
  );
  const fullAAttempt = parseJson(fullAAttemptArtifact.bytes, 'Full A attempt record');
  invariant(
    fullAAttempt.schemaVersion === 1
      && fullAAttempt.runId === fullA.runId
      && fullAAttempt.profile === 'full'
      && fullAAttempt.runtimeDir === fullA.runtimeDir
      && fullAAttempt.sequence === candidateReceipt.sequence
      && fullAAttempt.beganAt === candidateReceipt.beganAt
      && fullAAttempt.predecessor === null
      && /^[0-9a-f]{64}$/.test(fullAAttempt.token ?? '')
      && fullAAttempt.tokenSha256 === sha256(Buffer.from(fullAAttempt.token)),
    'release Full A attempt is not a standalone candidate attempt',
  );
  const chainArtifact = requiredRunArtifact(
    fullB,
    'full-run-chain-proof.json',
    'Full B chain proof',
  );
  const eventChainArtifact = checkedArtifact(
    fullB.runtimeDir,
    fullB.fullChainEvidence?.artifactPath,
    fullB.fullChainEvidence?.artifactSha256,
    'Full B chain evidence artifact',
  );
  invariant(
    eventChainArtifact.path === chainArtifact.path
      && eventChainArtifact.sha256 === chainArtifact.sha256,
    'Full B chain evidence does not use the canonical chain proof artifact',
  );
  const chainProof = validateFullRunChainArtifact({
    runtimeDir: fullB.runtimeDir,
    runId: fullB.runId,
    evidence: fullB.coverageEvidence,
    event: fullB.fullChainEvidence,
    runtimeBase,
  });
  const chainBinding = validateDeclaredReleaseFullChain({
    fullA,
    fullB,
    candidateArtifact,
    chainProof,
    chainArtifact,
  });
  chainBinding.candidate.standalone = true;
  chainBinding.candidate.attempt = {
    path: fullAAttemptArtifact.path,
    sha256: fullAAttemptArtifact.sha256,
  };
  fullA.candidate = chainBinding.candidate;
  fullB.fullRunChain = chainBinding.fullRunChain;
  delete fullA.fullChainEvidence;
  delete fullB.fullChainEvidence;
  delete recovery.fullChainEvidence;
  delete fullA.coverageEvidence;
  delete fullB.coverageEvidence;
  delete recovery.coverageEvidence;
  const proof = deriveReleaseProof({
    releaseId: input.releaseId,
    fullA,
    fullB,
    recovery,
    exitStatuses: input.exitStatuses,
    observedAt: new Date().toISOString(),
  });
  const outputPath = join(resolve(runtimeBase), `${input.releaseId}-release-proof.json`);
  atomicPrivateJson(outputPath, proof);
  return { outputPath, proof, sha256: sha256(readFileSync(outputPath)) };
}

async function main() {
  const [command, releaseId, fullAId, fullBId, recoveryId, fullAStatus, fullBStatus, recoveryStatus] = process.argv.slice(2);
  invariant(command === 'create', 'usage: release-proof.mjs create <releaseId> <fullA> <fullB> <recovery> <75> <0> <0>');
  const result = createReleaseProof({
    releaseId,
    fullAId,
    fullBId,
    recoveryId,
    exitStatuses: {
      fullA: Number(fullAStatus),
      fullB: Number(fullBStatus),
      recovery: Number(recoveryStatus),
    },
  });
  console.log(`release proof PASS: path=${result.outputPath} sha256=${result.sha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
