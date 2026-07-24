#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanManifest, manifestSchemaVersion } from './manifest-contract.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const e2eRoot = resolve(dirname(scriptPath), '..');
const runtimeBase = join(e2eRoot, '.runtime');
const statePath = join(runtimeBase, 'full-run-chain-state.json');
const validatorPath = join(e2eRoot, 'coverage', 'validate.mjs');
const caseId = 'cleanup.release-evidence.two-consecutive-cold-full-runs';
const evidenceProducer =
  'orchestrator/full-run-chain complete (two consecutive cold full runs)';
const candidateExitCode = 75;
const shaPattern = /^[0-9a-f]{64}$/;
const runIdPattern = /^[a-z0-9][a-z0-9-]{2,47}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateFullRunManifest(manifest, runId, evidenceCleanup) {
  assertCleanManifest(manifest, runId, 'clean manifest');
  invariant(
    manifest.cleanup.checkedAt === evidenceCleanup?.checkedAt &&
      evidenceCleanup?.manifestSchemaVersion === manifestSchemaVersion,
    'clean manifest does not prove post-down zero-leak completion',
  );
  invariant(isDate(manifest.createdAt), 'manifest createdAt is invalid');
  return manifest;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function within(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function assertPrivateDirectory(path, label) {
  const info = lstatSync(path);
  invariant(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  invariant((info.mode & 0o077) === 0, `${label} must not be group/world accessible`);
}

function assertPrivateFile(path, label, maximum = 64 * 1024 * 1024) {
  const info = lstatSync(path);
  invariant(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  invariant(info.size > 0 && info.size <= maximum, `${label} has unsafe size ${info.size}`);
  invariant((info.mode & 0o077) === 0, `${label} must be mode 0600`);
  return readFileSync(path);
}

function normalizeRuntime(runtimeDirValue, expectedRunId, base = runtimeBase) {
  invariant(runIdPattern.test(expectedRunId ?? ''), 'runId is invalid');
  const normalizedBase = resolve(base);
  const runtimeDir = resolve(runtimeDirValue ?? '');
  invariant(
    dirname(runtimeDir) === normalizedBase && basename(runtimeDir) === expectedRunId,
    `runtimeDir must be the direct ${expectedRunId} child of ${normalizedBase}`,
  );
  assertPrivateDirectory(normalizedBase, 'runtime base');
  assertPrivateDirectory(runtimeDir, 'runtime directory');
  invariant(within(realpathSync(normalizedBase), realpathSync(runtimeDir)), 'runtimeDir escapes runtime base');
  return { runtimeDir, runtimeBase: normalizedBase };
}

function atomicPrivateJson(path, value) {
  const parent = dirname(path);
  assertPrivateDirectory(parent, `parent of ${basename(path)}`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  invariant(
    !/"(?:password|refreshToken|accessToken|secret|privateKey)"\s*:/i.test(serialized),
    `${basename(path)} would contain a forbidden credential field`,
  );
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, serialized, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const directoryFd = openSync(parent, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
  return Buffer.from(serialized);
}

function readState(path = statePath) {
  if (!existsSync(path)) {
    return {
      schemaVersion: 1,
      sequence: 0,
      updatedAt: new Date(0).toISOString(),
      active: null,
      candidate: null,
    };
  }
  const value = parseJson(assertPrivateFile(path, 'Full chain state', 1024 * 1024), 'Full chain state');
  invariant(value.schemaVersion === 1, 'Full chain state schema mismatch');
  invariant(Number.isInteger(value.sequence) && value.sequence >= 0, 'Full chain sequence is invalid');
  invariant(isDate(value.updatedAt), 'Full chain updatedAt is invalid');
  invariant(value.active === null || typeof value.active === 'object', 'Full chain active state is invalid');
  invariant(
    value.candidate === null || typeof value.candidate === 'object',
    'Full chain candidate state is invalid',
  );
  return value;
}

function checkedPath(runtimeDir, pathValue, label) {
  invariant(typeof pathValue === 'string' && pathValue.length > 0, `${label} is missing`);
  const path = isAbsolute(pathValue) ? resolve(pathValue) : resolve(runtimeDir, pathValue);
  invariant(within(runtimeDir, path), `${label} escapes ${runtimeDir}`);
  const bytes = assertPrivateFile(path, label);
  invariant(within(realpathSync(runtimeDir), realpathSync(path)), `${label} resolves outside runtimeDir`);
  return { path, bytes };
}

function requiredSha(value, label) {
  invariant(shaPattern.test(value ?? ''), `${label} must be a SHA-256 digest`);
  return value;
}

function sourceFingerprint(evidence) {
  return {
    gitSha: evidence.build?.gitSha,
    trackedDiffSha256: requiredSha(
      evidence.build?.trackedDiffSha256,
      'trackedDiffSha256',
    ),
    untrackedSourceSha256: requiredSha(
      evidence.build?.untrackedSourceSha256,
      'untrackedSourceSha256',
    ),
    productSourceSha256: requiredSha(
      evidence.build?.productSourceSha256,
      'productSourceSha256',
    ),
  };
}

function validateFreshMigration(runtimeDir, runId, evidence) {
  const event = evidence.caseEvents?.find((candidate) => candidate.caseId === 'foundation.runtime.fresh-migration');
  invariant(event?.kind === 'fixture' && event.source === 'fixture', 'fresh migration event is missing');
  const artifact = checkedPath(runtimeDir, event.artifactPath, 'fresh migration proof');
  invariant(event.artifactSha256 === sha256(artifact.bytes), 'fresh migration proof hash mismatch');
  const proof = parseJson(artifact.bytes, 'fresh migration proof');
  const expectedVolume = `nyabase-e2e-${runId}-backend-data`;
  invariant(
    proof.schemaVersion === 1 &&
      proof.runId === runId &&
      proof.caseId === 'foundation.runtime.fresh-migration' &&
      proof.status === 'passed',
    'fresh migration proof identity mismatch',
  );
  invariant(
    proof.claims?.volume?.name === expectedVolume &&
      proof.claims.volume.absentBeforeComposeCreate === true &&
      proof.claims.volume.emptyBeforeBackendStart === true &&
      proof.claims.volume.runOwned === true,
    'fresh migration proof does not establish a cold run-owned database volume',
  );
  invariant(
    proof.claims?.backend?.nodeEnv === 'production' &&
      proof.claims.backend.database?.driver === 'sqlite' &&
      proof.claims.backend.database?.synchronize === false &&
      proof.claims.backend.database?.migrationsRun === true,
    'fresh migration proof does not establish the production migration path',
  );
  invariant(
    isDate(proof.claims.volume.absenceObservedAt) &&
      isDate(proof.claims.volume.emptinessObservedAt),
    'fresh migration proof timestamps are invalid',
  );
  return {
    artifactPath: artifact.path,
    artifactSha256: event.artifactSha256,
    volumeName: expectedVolume,
    absenceObservedAt: proof.claims.volume.absenceObservedAt,
    emptinessObservedAt: proof.claims.volume.emptinessObservedAt,
  };
}

function loadRunSnapshot(runtimeDirValue, runId, sequence, base = runtimeBase) {
  const normalized = normalizeRuntime(runtimeDirValue, runId, base);
  const evidenceFile = checkedPath(normalized.runtimeDir, 'coverage-evidence.json', 'coverage evidence');
  const evidence = parseJson(evidenceFile.bytes, 'coverage evidence');
  invariant(
    evidence.schemaVersion === 1 && evidence.runId === runId && evidence.profile === 'full',
    'coverage evidence is not for this Full run',
  );
  invariant(evidence.playwright?.status === 'passed', 'Full Playwright evidence did not pass');
  invariant(evidence.cleanup?.status === 'clean', 'Full cleanup evidence is not clean');
  invariant(isDate(evidence.generatedAt), 'coverage evidence generatedAt is invalid');
  requiredSha(evidence.ledgerSha256, 'ledgerSha256');
  invariant(/^[0-9a-f]{40}$/.test(evidence.build?.gitSha ?? ''), 'gitSha is invalid');

  const reportFile = checkedPath(normalized.runtimeDir, evidence.playwright.reportPath, 'Playwright report');
  invariant(evidence.playwright.reportSha256 === sha256(reportFile.bytes), 'Playwright report hash mismatch');
  const report = parseJson(reportFile.bytes, 'Playwright report');
  invariant(
    report.config?.metadata?.runId === runId &&
      report.config?.metadata?.profile === 'full' &&
      report.config?.metadata?.cpuOnly === true &&
      report.stats?.unexpected === 0 &&
      report.stats?.flaky === 0 &&
      report.stats?.skipped === 0 &&
      report.stats?.expected > 0,
    'Playwright report is not an all-green CPU-only Full report',
  );

  const manifestFile = checkedPath(normalized.runtimeDir, evidence.cleanup.manifestPath, 'clean manifest');
  invariant(evidence.cleanup.manifestSha256 === sha256(manifestFile.bytes), 'clean manifest hash mismatch');
  const manifest = parseJson(manifestFile.bytes, 'clean manifest');
  validateFullRunManifest(manifest, runId, evidence.cleanup);

  const buildFile = checkedPath(normalized.runtimeDir, evidence.build.provenancePath, 'build provenance');
  invariant(evidence.build.provenanceSha256 === sha256(buildFile.bytes), 'build provenance hash mismatch');
  invariant(isDate(evidence.build.builtAt), 'build timestamp is invalid');
  invariant(isDate(evidence.playwright.startedAt), 'Playwright start timestamp is invalid');
  invariant(isDate(evidence.playwright.finishedAt), 'Playwright finish timestamp is invalid');
  invariant(isDate(evidence.cleanup.checkedAt), 'cleanup timestamp is invalid');
  invariant(
    Date.parse(manifest.createdAt) <= Date.parse(evidence.build.builtAt) &&
      Date.parse(evidence.build.builtAt) <= Date.parse(evidence.playwright.startedAt) &&
      Date.parse(evidence.playwright.startedAt) <= Date.parse(evidence.playwright.finishedAt) &&
      Date.parse(evidence.playwright.finishedAt) <= Date.parse(evidence.cleanup.checkedAt) &&
      Date.parse(evidence.cleanup.checkedAt) <= Date.parse(evidence.generatedAt),
    'Full run phases are not ordered cold setup -> build -> Playwright -> cleanup -> evidence',
  );

  return {
    schemaVersion: 1,
    runId,
    profile: 'full',
    runtimeDir: normalized.runtimeDir,
    sequence,
    manifestCreatedAt: manifest.createdAt,
    evidencePath: evidenceFile.path,
    evidenceSha256: sha256(evidenceFile.bytes),
    ledgerSha256: evidence.ledgerSha256,
    source: sourceFingerprint(evidence),
    build: {
      provenancePath: buildFile.path,
      provenanceSha256: evidence.build.provenanceSha256,
      backendImageId: evidence.build.backendImageId,
      nodeImageId: evidence.build.nodeImageId,
      builtAt: evidence.build.builtAt,
    },
    playwright: {
      reportPath: reportFile.path,
      reportSha256: evidence.playwright.reportSha256,
      startedAt: evidence.playwright.startedAt,
      finishedAt: evidence.playwright.finishedAt,
      expected: report.stats.expected,
    },
    cleanup: {
      manifestSchemaVersion,
      manifestPath: manifestFile.path,
      manifestSha256: evidence.cleanup.manifestSha256,
      checkedAt: evidence.cleanup.checkedAt,
    },
    freshMigration: validateFreshMigration(normalized.runtimeDir, runId, evidence),
  };
}

function loadCandidate(pointer, base = runtimeBase) {
  invariant(pointer && typeof pointer === 'object', 'candidate pointer is missing');
  invariant(runIdPattern.test(pointer.runId ?? ''), 'candidate runId is invalid');
  invariant(Number.isInteger(pointer.sequence) && pointer.sequence > 0, 'candidate sequence is invalid');
  const normalized = normalizeRuntime(pointer.runtimeDir, pointer.runId, base);
  const receipt = checkedPath(normalized.runtimeDir, pointer.receiptPath, 'Full candidate receipt');
  invariant(pointer.receiptSha256 === sha256(receipt.bytes), 'Full candidate receipt hash mismatch');
  const value = parseJson(receipt.bytes, 'Full candidate receipt');
  invariant(
    value.schemaVersion === 1 &&
      value.runId === pointer.runId &&
      value.profile === 'full' &&
      value.sequence === pointer.sequence &&
      value.runtimeDir === normalized.runtimeDir &&
      value.receiptPath === receipt.path &&
      value.validationMode === 'single-full-candidate' &&
      isDate(value.completedAt),
    'Full candidate receipt binding mismatch',
  );
  const snapshot = loadRunSnapshot(normalized.runtimeDir, pointer.runId, pointer.sequence, base);
  invariant(snapshot.evidenceSha256 === value.evidenceSha256, 'candidate evidence changed after acceptance');
  invariant(JSON.stringify(snapshot.source) === JSON.stringify(value.source), 'candidate source changed');
  invariant(snapshot.ledgerSha256 === value.ledgerSha256, 'candidate ledger changed');
  invariant(
    snapshot.playwright.reportSha256 === value.playwrightReportSha256 &&
      snapshot.cleanup.manifestSha256 === value.cleanupManifestSha256 &&
      snapshot.freshMigration.artifactSha256 === value.freshMigrationArtifactSha256,
    'candidate bound artifacts changed after acceptance',
  );
  return { pointer, receiptPath: receipt.path, receiptSha256: pointer.receiptSha256, value, snapshot };
}

export function deriveBeginTransition(
  previousState,
  { runId, runtimeDir, beganAt, tokenSha256, expectedPredecessor = null },
) {
  invariant(previousState.schemaVersion === 1, 'previous state schema mismatch');
  if (expectedPredecessor !== null) {
    invariant(
      runIdPattern.test(expectedPredecessor?.runId ?? '')
        && shaPattern.test(expectedPredecessor?.receiptSha256 ?? ''),
      'expected Full predecessor binding is invalid',
    );
    invariant(previousState.active === null, 'expected Full predecessor is blocked by an active attempt');
    invariant(
      previousState.candidate?.runId === expectedPredecessor.runId
        && previousState.candidate?.receiptSha256 === expectedPredecessor.receiptSha256,
      'available Full candidate does not match the expected predecessor',
    );
  }
  const sequence = previousState.sequence + 1;
  const predecessor = previousState.active === null ? previousState.candidate : null;
  return {
    state: {
      schemaVersion: 1,
      sequence,
      updatedAt: beganAt,
      active: {
        runId,
        runtimeDir,
        sequence,
        beganAt,
        tokenSha256,
        predecessor: predecessor ?? null,
      },
      candidate: null,
    },
    sequence,
    predecessor: predecessor ?? null,
    invalidatedActiveRunId: previousState.active?.runId ?? null,
  };
}

export function validateConsecutivePair(previous, current, attempt) {
  invariant(
    previous.snapshot.runId !== current.runId,
    'consecutive Full runs must have distinct runIds',
  );
  invariant(
    previous.snapshot.runtimeDir !== current.runtimeDir,
    'consecutive Full runs must use distinct runtime directories',
  );
  invariant(
    previous.snapshot.sequence + 1 === current.sequence,
    'Full run sequence is not consecutive',
  );
  invariant(attempt.sequence === current.sequence, 'attempt sequence does not match current run');
  invariant(
    attempt.predecessor?.receiptSha256 === previous.receiptSha256,
    'attempt is not bound to the predecessor candidate receipt',
  );
  invariant(
    JSON.stringify(previous.snapshot.source) === JSON.stringify(current.source),
    'consecutive Full runs used different source fingerprints',
  );
  invariant(
    previous.snapshot.ledgerSha256 === current.ledgerSha256,
    'consecutive Full runs used different coverage ledgers',
  );
  invariant(
    previous.snapshot.freshMigration.volumeName !== current.freshMigration.volumeName,
    'consecutive Full runs reused the same database volume',
  );
  invariant(
    Date.parse(previous.value.completedAt) <= Date.parse(attempt.beganAt) &&
      Date.parse(attempt.beganAt) <= Date.parse(current.build.builtAt),
    'predecessor completion, current begin, and current build are not ordered',
  );
  return true;
}

export function validateFullRunChainArtifact({
  runtimeDir,
  runId,
  evidence,
  event,
  runtimeBase: base = runtimeBase,
}) {
  const normalized = normalizeRuntime(runtimeDir, runId, base);
  invariant(
    event?.caseId === caseId &&
      event.kind === 'evidence' &&
      event.source === 'cleanup' &&
      event.status === 'passed' &&
      event.evidenceProducer === evidenceProducer,
    'two-run event identity mismatch',
  );
  const proofFile = checkedPath(
    normalized.runtimeDir,
    event.artifactPath,
    'two-consecutive Full proof',
  );
  invariant(event.artifactSha256 === sha256(proofFile.bytes), 'two-run proof hash mismatch');
  const proof = parseJson(proofFile.bytes, 'two-consecutive Full proof');
  invariant(
    proof.schemaVersion === 1 &&
      proof.caseId === caseId &&
      proof.producer === evidenceProducer &&
      proof.status === 'passed' &&
      proof.profile === 'full' &&
      proof.observedAt === event.observedAt &&
      proof.observedAt === evidence.generatedAt &&
      proof.noInterveningFullAttempt === true &&
      proof.sameSourceFingerprint === true &&
      proof.distinctColdRuntimeIdentity === true,
    'two-run proof contract is incomplete',
  );
  const attemptRecord = readAttempt(normalized.runtimeDir, runId);
  invariant(
    proof.attempt?.path === attemptRecord.path &&
      proof.attempt.sha256 === attemptRecord.sha256 &&
      proof.attempt.tokenSha256 === attemptRecord.attempt.tokenSha256 &&
      proof.attempt.predecessorReceiptSha256 ===
        attemptRecord.attempt.predecessor?.receiptSha256,
    'two-run proof is not bound to the immutable current attempt record',
  );
  invariant(
    Number.isInteger(proof.current?.sequence) && proof.current.sequence > 1,
    'two-run proof current sequence is invalid',
  );
  const current = loadRunSnapshot(
    normalized.runtimeDir,
    runId,
    proof.current.sequence,
    base,
  );
  invariant(
    JSON.stringify(proof.current) === JSON.stringify(proofCurrent(current, attemptRecord.attempt)),
    'two-run proof current-run bindings do not match retained evidence',
  );
  const previous = loadCandidate(proof.previous, base);
  invariant(
    proof.previous.completedAt === previous.value.completedAt &&
      proof.previous.evidenceSha256 === previous.snapshot.evidenceSha256 &&
      proof.previous.ledgerSha256 === previous.snapshot.ledgerSha256 &&
      JSON.stringify(proof.previous.source) === JSON.stringify(previous.snapshot.source) &&
      proof.previous.playwrightReportSha256 === previous.snapshot.playwright.reportSha256 &&
      proof.previous.cleanupManifestSha256 === previous.snapshot.cleanup.manifestSha256 &&
      JSON.stringify(proof.previous.freshMigration) ===
        JSON.stringify(previous.snapshot.freshMigration),
    'two-run proof predecessor bindings do not match the retained candidate',
  );
  validateConsecutivePair(previous, current, attemptRecord.attempt);
  invariant(
    evidence.runId === current.runId &&
      evidence.profile === 'full' &&
      evidence.ledgerSha256 === current.ledgerSha256 &&
      JSON.stringify(sourceFingerprint(evidence)) === JSON.stringify(current.source),
    'two-run proof does not bind the current coverage evidence',
  );
  return proof;
}

function runValidator(runtimeDir, runId, candidate) {
  const args = [validatorPath, '--require-profile=full', `--evidence=${join(runtimeDir, 'coverage-evidence.json')}`];
  if (candidate) args.push('--full-chain-candidate');
  const result = spawnSync(process.execPath, args, {
    cwd: e2eRoot,
    env: {
      ...process.env,
      E2E_RUN_ID: runId,
      E2E_RUNTIME_ROOT: runtimeDir,
      E2E_COVERAGE_EVIDENCE: join(runtimeDir, 'coverage-evidence.json'),
    },
    stdio: 'inherit',
  });
  invariant(result.error === undefined, `coverage validator failed to start: ${result.error?.message}`);
  invariant(result.status === 0, `coverage validator rejected Full run ${runId}`);
}

function begin(runtimeDirValue, runId, options = {}) {
  const base = options.runtimeBase ?? runtimeBase;
  const chainPath = options.statePath ?? (base === runtimeBase ? statePath : join(base, 'full-run-chain-state.json'));
  const normalized = normalizeRuntime(runtimeDirValue, runId, base);
  const attemptPath = join(normalized.runtimeDir, 'full-run-attempt.json');
  invariant(!existsSync(attemptPath), `runId ${runId} already has a Full attempt record`);
  const previous = readState(chainPath);
  const expectedPredecessor = options.expectedPredecessor ?? null;
  let discardedCandidateReason = null;
  if (previous.active === null && previous.candidate !== null) {
    try {
      loadCandidate(previous.candidate, base);
    } catch (error) {
      discardedCandidateReason = error.message;
      previous.candidate = null;
    }
  }
  if (expectedPredecessor !== null) {
    invariant(
      discardedCandidateReason === null,
      `expected Full predecessor is invalid: ${discardedCandidateReason}`,
    );
  }
  const beganAt = new Date().toISOString();
  const token = randomBytes(32).toString('hex');
  const transition = deriveBeginTransition(previous, {
    runId,
    runtimeDir: normalized.runtimeDir,
    beganAt,
    tokenSha256: sha256(token),
    expectedPredecessor,
  });
  // State is committed first. If the process dies before the attempt record is
  // durable, the active marker still breaks the chain on the next Full begin.
  atomicPrivateJson(chainPath, transition.state);
  const attempt = {
    schemaVersion: 1,
    runId,
    profile: 'full',
    runtimeDir: normalized.runtimeDir,
    sequence: transition.sequence,
    beganAt,
    token,
    tokenSha256: sha256(token),
    predecessor: transition.predecessor,
    invalidatedActiveRunId: transition.invalidatedActiveRunId,
    discardedCandidateReason,
  };
  atomicPrivateJson(attemptPath, attempt);
  console.log(
    `Full chain begin: runId=${runId} sequence=${attempt.sequence} predecessor=${attempt.predecessor?.runId ?? 'none'}`,
  );
  if (attempt.invalidatedActiveRunId) {
    console.log(`Full chain broken by prior incomplete attempt ${attempt.invalidatedActiveRunId}`);
  }
  if (discardedCandidateReason) {
    console.log(`Full chain discarded an invalid candidate: ${discardedCandidateReason}`);
  }
  return attempt;
}

function readAttempt(runtimeDir, runId) {
  const file = checkedPath(runtimeDir, 'full-run-attempt.json', 'Full attempt record');
  const attempt = parseJson(file.bytes, 'Full attempt record');
  invariant(
    attempt.schemaVersion === 1 &&
      attempt.runId === runId &&
      attempt.profile === 'full' &&
      attempt.runtimeDir === runtimeDir &&
      Number.isInteger(attempt.sequence) &&
      attempt.sequence > 0 &&
      isDate(attempt.beganAt) &&
      /^[0-9a-f]{64}$/.test(attempt.token ?? '') &&
      attempt.tokenSha256 === sha256(attempt.token),
    'Full attempt record binding mismatch',
  );
  return { attempt, path: file.path, sha256: sha256(file.bytes) };
}

function assertActiveState(state, attempt) {
  invariant(state.active !== null, 'Full chain has no active attempt');
  invariant(
    state.active.runId === attempt.runId &&
      state.active.runtimeDir === attempt.runtimeDir &&
      state.active.sequence === attempt.sequence &&
      state.active.beganAt === attempt.beganAt &&
      state.active.tokenSha256 === attempt.tokenSha256 &&
      JSON.stringify(state.active.predecessor) === JSON.stringify(attempt.predecessor),
    'Full chain active attempt was superseded or tampered with',
  );
}

function writeCandidate(runtimeDir, attempt, snapshot, chainPath) {
  const completedAt = new Date().toISOString();
  const receiptPath = join(runtimeDir, 'full-run-candidate.json');
  const receipt = {
    schemaVersion: 1,
    runId: attempt.runId,
    profile: 'full',
    runtimeDir,
    sequence: attempt.sequence,
    beganAt: attempt.beganAt,
    completedAt,
    validationMode: 'single-full-candidate',
    receiptPath,
    evidenceSha256: snapshot.evidenceSha256,
    ledgerSha256: snapshot.ledgerSha256,
    source: snapshot.source,
    playwrightReportSha256: snapshot.playwright.reportSha256,
    cleanupManifestSha256: snapshot.cleanup.manifestSha256,
    freshMigrationArtifactSha256: snapshot.freshMigration.artifactSha256,
  };
  const receiptBytes = atomicPrivateJson(receiptPath, receipt);
  const pointer = {
    runId: attempt.runId,
    runtimeDir,
    sequence: attempt.sequence,
    receiptPath,
    receiptSha256: sha256(receiptBytes),
  };
  const currentState = readState(chainPath);
  assertActiveState(currentState, attempt);
  atomicPrivateJson(chainPath, {
    schemaVersion: 1,
    sequence: attempt.sequence,
    updatedAt: completedAt,
    active: null,
    candidate: pointer,
  });
  return { receipt, pointer };
}

function proofCurrent(snapshot, attempt) {
  return {
    runId: snapshot.runId,
    runtimeDir: snapshot.runtimeDir,
    sequence: snapshot.sequence,
    beganAt: attempt.beganAt,
    manifestCreatedAt: snapshot.manifestCreatedAt,
    ledgerSha256: snapshot.ledgerSha256,
    source: snapshot.source,
    buildProvenanceSha256: snapshot.build.provenanceSha256,
    builtAt: snapshot.build.builtAt,
    playwrightReportSha256: snapshot.playwright.reportSha256,
    playwrightStartedAt: snapshot.playwright.startedAt,
    playwrightFinishedAt: snapshot.playwright.finishedAt,
    playwrightExpected: snapshot.playwright.expected,
    cleanupManifestSha256: snapshot.cleanup.manifestSha256,
    cleanupCheckedAt: snapshot.cleanup.checkedAt,
    freshMigration: snapshot.freshMigration,
  };
}

function patchCurrentEvidence(runtimeDir, attemptRecord, previous, current) {
  const evidenceFile = checkedPath(runtimeDir, 'coverage-evidence.json', 'coverage evidence');
  const evidence = parseJson(evidenceFile.bytes, 'coverage evidence');
  invariant(
    !(evidence.caseEvents ?? []).some((event) => event.caseId === caseId),
    `${caseId} was emitted before the two-run chain was proved`,
  );
  const observedAt = new Date().toISOString();
  const proofPath = join(runtimeDir, 'full-run-chain-proof.json');
  const proof = {
    schemaVersion: 1,
    caseId,
    producer: evidenceProducer,
    status: 'passed',
    profile: 'full',
    observedAt,
    noInterveningFullAttempt: true,
    sameSourceFingerprint: true,
    distinctColdRuntimeIdentity: true,
    previous: {
      ...previous.pointer,
      completedAt: previous.value.completedAt,
      evidenceSha256: previous.snapshot.evidenceSha256,
      ledgerSha256: previous.snapshot.ledgerSha256,
      source: previous.snapshot.source,
      playwrightReportSha256: previous.snapshot.playwright.reportSha256,
      cleanupManifestSha256: previous.snapshot.cleanup.manifestSha256,
      freshMigration: previous.snapshot.freshMigration,
    },
    current: proofCurrent(current, attemptRecord.attempt),
    attempt: {
      path: attemptRecord.path,
      sha256: attemptRecord.sha256,
      tokenSha256: attemptRecord.attempt.tokenSha256,
      predecessorReceiptSha256: previous.receiptSha256,
    },
  };
  const proofBytes = atomicPrivateJson(proofPath, proof);
  evidence.generatedAt = observedAt;
  evidence.caseEvents.push({
    caseId,
    kind: 'evidence',
    source: 'cleanup',
    status: 'passed',
    observedAt,
    evidenceProducer,
    artifactPath: proofPath,
    artifactSha256: sha256(proofBytes),
    observedHttpSurfaces: [],
  });
  atomicPrivateJson(evidenceFile.path, evidence);
  return proof;
}

function complete(runtimeDirValue, runId, options = {}) {
  const base = options.runtimeBase ?? runtimeBase;
  const chainPath = options.statePath ?? (base === runtimeBase ? statePath : join(base, 'full-run-chain-state.json'));
  const normalized = normalizeRuntime(runtimeDirValue, runId, base);
  const attemptRecord = readAttempt(normalized.runtimeDir, runId);
  const state = readState(chainPath);
  assertActiveState(state, attemptRecord.attempt);

  // A candidate is a complete single cold Full run, not release closure. The
  // deliberately narrow validator exception permits exactly the absent
  // two-consecutive event and nothing else.
  runValidator(normalized.runtimeDir, runId, true);
  let current = loadRunSnapshot(
    normalized.runtimeDir,
    runId,
    attemptRecord.attempt.sequence,
    base,
  );

  if (!attemptRecord.attempt.predecessor) {
    writeCandidate(normalized.runtimeDir, attemptRecord.attempt, current, chainPath);
    console.log(
      `Full chain CANDIDATE ONLY: ${runId} is one clean cold Full run; a second consecutive run is required`,
    );
    return { status: 'candidate', exitCode: candidateExitCode };
  }

  const previous = loadCandidate(attemptRecord.attempt.predecessor, base);
  runValidator(previous.snapshot.runtimeDir, previous.snapshot.runId, true);
  validateConsecutivePair(previous, current, attemptRecord.attempt);
  patchCurrentEvidence(normalized.runtimeDir, attemptRecord, previous, current);

  // The ordinary Full validator has no exception here. It independently
  // checks the final two-run artifact and all current-run behavioral evidence.
  runValidator(normalized.runtimeDir, runId, false);
  current = loadRunSnapshot(
    normalized.runtimeDir,
    runId,
    attemptRecord.attempt.sequence,
    base,
  );
  writeCandidate(normalized.runtimeDir, attemptRecord.attempt, current, chainPath);
  console.log(
    `Full chain PASS: ${previous.snapshot.runId} -> ${runId} are consecutive clean cold Full runs`,
  );
  return { status: 'passed', exitCode: 0 };
}

function verifyCandidate(runtimeDirValue, runId, options = {}) {
  const base = options.runtimeBase ?? runtimeBase;
  const chainPath = options.statePath
    ?? (base === runtimeBase ? statePath : join(base, 'full-run-chain-state.json'));
  const normalized = normalizeRuntime(runtimeDirValue, runId, base);
  const state = readState(chainPath);
  invariant(state.active === null, 'Full chain still has an active attempt');
  invariant(state.candidate !== null, 'Full chain candidate pointer is missing');
  invariant(
    state.candidate.runId === runId
      && state.candidate.runtimeDir === normalized.runtimeDir,
    'Full chain candidate does not match the expected release run',
  );
  const candidate = loadCandidate(state.candidate, base);
  invariant(
    candidate.snapshot.runId === runId
      && candidate.snapshot.runtimeDir === normalized.runtimeDir,
    'Full chain candidate snapshot does not match the expected release run',
  );
  return candidate;
}

function invalidate(options = {}) {
  const base = options.runtimeBase ?? runtimeBase;
  const chainPath = options.statePath ?? (base === runtimeBase ? statePath : join(base, 'full-run-chain-state.json'));
  assertPrivateDirectory(base, 'runtime base');
  const previous = readState(chainPath);
  const updatedAt = new Date().toISOString();
  atomicPrivateJson(chainPath, {
    schemaVersion: 1,
    sequence: previous.sequence,
    updatedAt,
    active: previous.active,
    candidate: null,
  });
  console.log(
    `Full chain candidate invalidated; active=${previous.active?.runId ?? 'none'} sequence=${previous.sequence}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const [
    command,
    runtimeDirValue,
    runId,
    expectedPredecessorRunId = '',
    expectedPredecessorReceiptSha256 = '',
  ] = args;
  if (command === 'invalidate') {
    invariant(args.length === 1, 'invalidate does not accept additional arguments');
    invalidate();
    return;
  }
  invariant(
    ['begin', 'complete', 'verify-candidate'].includes(command) && runtimeDirValue && runId,
    'usage: full-run-chain.mjs {begin|complete|verify-candidate} <runtimeDir> <runId> | invalidate',
  );
  if (command === 'begin') {
    invariant(
      args.length === 3 || args.length === 5,
      'begin accepts either no expected predecessor or one exact runId/SHA pair',
    );
    invariant(
      (expectedPredecessorRunId === '') === (expectedPredecessorReceiptSha256 === ''),
      'expected Full predecessor runId and receipt SHA-256 must be supplied together',
    );
    begin(runtimeDirValue, runId, {
      expectedPredecessor: expectedPredecessorRunId === '' ? null : {
        runId: expectedPredecessorRunId,
        receiptSha256: expectedPredecessorReceiptSha256,
      },
    });
  }
  else if (command === 'complete') {
    invariant(args.length === 3, 'complete does not accept additional arguments');
    const result = complete(runtimeDirValue, runId);
    process.exitCode = result.exitCode;
  } else {
    invariant(args.length === 3, 'verify-candidate does not accept additional arguments');
    const candidate = verifyCandidate(runtimeDirValue, runId);
    console.error(
      `Full chain candidate VERIFIED: runId=${runId} sequence=${candidate.snapshot.sequence}`,
    );
    process.stdout.write(`${candidate.receiptSha256}\n`);
  }
}

export {
  begin,
  complete,
  verifyCandidate,
  invalidate,
  candidateExitCode,
  caseId,
  evidenceProducer,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
