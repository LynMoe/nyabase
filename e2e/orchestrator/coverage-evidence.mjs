#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCleanManifest, assertManifestForRun, manifestSchemaVersion } from './manifest-contract.mjs';
import { assertRunStateIdentity, parseClosedRunState } from './run-state-contract.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const e2eRoot = resolve(dirname(scriptPath), '..');
const runtimeBase = join(e2eRoot, '.runtime');
const ledgerPath = join(e2eRoot, 'coverage', 'features.yaml');
const profiles = new Set(['smoke', 'core', 'full', 'recovery']);
const consecutiveFullCaseId = 'cleanup.release-evidence.two-consecutive-cold-full-runs';
const maxBytes = {
  env: 128 * 1024,
  json: 64 * 1024 * 1024,
  ledger: 8 * 1024 * 1024,
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export function parseEnv(text, label = 'env file') {
  const values = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line) continue;
    const separator = line.indexOf('=');
    invariant(separator > 0, `${label}:${index + 1} is not KEY=value`);
    const name = line.slice(0, separator);
    invariant(/^[A-Z][A-Z0-9_]*$/.test(name), `${label}:${index + 1} has invalid key ${name}`);
    invariant(!(name in values), `${label} contains duplicate key ${name}`);
    values[name] = line.slice(separator + 1);
  }
  return values;
}

function isDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function validatePreDownManifest(manifest, runId) {
  assertManifestForRun(manifest, runId, 'pre-down manifest');
  invariant(
    manifest.phase === 'tests_passed' && manifest.cleanup === null,
    'pre-down manifest is not at tests_passed',
  );
  invariant(isDate(manifest.createdAt), 'pre-down manifest createdAt is invalid');
  return manifest;
}

export function validateCleanedManifest(manifest, runId) {
  assertCleanManifest(manifest, runId);
  invariant(
    isDate(manifest.cleanup?.checkedAt),
    'manifest cleanup is not clean',
  );
  invariant(isDate(manifest.createdAt), 'cleaned manifest createdAt is invalid');
  return manifest;
}

function normalizeRuntime(runtimeDirValue) {
  invariant(
    typeof runtimeDirValue === 'string' && runtimeDirValue.length > 0,
    'runtimeDir is required',
  );
  const runtimeDir = resolve(runtimeDirValue);
  invariant(
    runtimeDir.startsWith(`${runtimeBase}${sep}`) && dirname(runtimeDir) === runtimeBase,
    `runtimeDir must be a direct child of ${runtimeBase}`,
  );
  return runtimeDir;
}

async function assertDirectory(path, label) {
  const info = await lstat(path);
  invariant(
    info.isDirectory() && !info.isSymbolicLink(),
    `${label} must be a real directory: ${path}`,
  );
  invariant((info.mode & 0o077) === 0, `${label} must not be group/world accessible: ${path}`);
}

function withinRuntime(runtimeDir, path) {
  return path === runtimeDir || path.startsWith(`${runtimeDir}${sep}`);
}

function validateFixtureArtifact(runtimeDir, event, coverageCase, runId) {
  invariant(
    typeof event.fixtureProducer === 'string',
    `${event.caseId} fixture event lacks producer`,
  );
  invariant(
    event.fixtureProducer === coverageCase.fixtureProducer,
    `${event.caseId} fixture producer mismatch`,
  );
  invariant(
    typeof event.artifactPath === 'string' && event.artifactPath.length > 0,
    `${event.caseId} fixture event lacks artifact path`,
  );
  invariant(
    /^[0-9a-f]{64}$/.test(event.artifactSha256 ?? ''),
    `${event.caseId} fixture event has invalid artifact hash`,
  );
  const artifactPath = isAbsolute(event.artifactPath)
    ? resolve(event.artifactPath)
    : resolve(runtimeDir, event.artifactPath);
  const fixtureDir = join(runtimeDir, 'fixture-evidence');
  invariant(
    artifactPath.startsWith(`${fixtureDir}${sep}`) && dirname(artifactPath) === fixtureDir,
    `${event.caseId} fixture artifact escapes its run directory`,
  );
  const info = lstatSync(artifactPath);
  invariant(
    info.isFile() && !info.isSymbolicLink(),
    `${event.caseId} fixture artifact must be a regular file`,
  );
  invariant(
    info.size > 0 && info.size <= 1024 * 1024,
    `${event.caseId} fixture artifact has unsafe size`,
  );
  invariant((info.mode & 0o777) === 0o600, `${event.caseId} fixture artifact must be mode 0600`);
  const realRuntime = realpathSync(runtimeDir);
  const realArtifact = realpathSync(artifactPath);
  invariant(
    withinRuntime(realRuntime, realArtifact),
    `${event.caseId} fixture artifact resolves outside runtimeDir`,
  );
  const bytes = readFileSync(artifactPath);
  invariant(
    sha256(bytes) === event.artifactSha256,
    `${event.caseId} fixture artifact hash mismatch`,
  );
  const proof = parseJson(bytes, `${event.caseId} fixture proof`);
  invariant(
    proof.schemaVersion === 1 &&
      proof.runId === runId &&
      proof.caseId === event.caseId &&
      proof.producer === coverageCase.fixtureProducer &&
      proof.status === 'passed' &&
      proof.observedAt === event.observedAt &&
      proof.claims &&
      typeof proof.claims === 'object' &&
      !Array.isArray(proof.claims),
    `${event.caseId} fixture proof binding mismatch`,
  );
  return artifactPath;
}

async function readRuntimeFile(
  runtimeDir,
  pathValue,
  label,
  limit = maxBytes.json,
  privateFile = true,
) {
  const path = isAbsolute(pathValue) ? resolve(pathValue) : resolve(runtimeDir, pathValue);
  invariant(withinRuntime(runtimeDir, path), `${label} escapes runtimeDir: ${pathValue}`);
  const info = await lstat(path);
  invariant(
    info.isFile() && !info.isSymbolicLink(),
    `${label} must be a regular non-symlink file: ${path}`,
  );
  invariant(info.size > 0 && info.size <= limit, `${label} has unsafe size ${info.size}`);
  if (privateFile) invariant((info.mode & 0o077) === 0, `${label} must be mode 0600: ${path}`);
  return { path, bytes: await readFile(path) };
}

async function readRepoFile(path, label, limit) {
  const info = await lstat(path);
  invariant(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  invariant(info.size > 0 && info.size <= limit, `${label} has unsafe size ${info.size}`);
  return { path, bytes: await readFile(path) };
}

async function pathAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} must be removed before coverage closure: ${path}`);
}

async function writePrivateAtomic(runtimeDir, filename, value, knownSecrets = []) {
  invariant(basename(filename) === filename, `unsafe output filename ${filename}`);
  const outputPath = join(runtimeDir, filename);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  for (const secret of knownSecrets) {
    if (secret.length >= 8)
      invariant(!serialized.includes(secret), `${filename} would contain a per-run secret`);
  }
  invariant(
    !/"(?:password|refreshToken|accessToken|secret|privateKey)"\s*:/i.test(serialized),
    `${filename} would contain a forbidden credential field`,
  );

  const temporary = join(
    runtimeDir,
    `.${filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, outputPath);
    await chmod(outputPath, 0o600);
    const directory = await open(runtimeDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
  return outputPath;
}

function collectReportSpecs(node, output = []) {
  if (Array.isArray(node?.specs)) output.push(...node.specs);
  for (const suite of node?.suites ?? []) collectReportSpecs(suite, output);
  return output;
}

function reportWindow(report, runId, profile) {
  invariant(report?.config?.metadata?.runId === runId, 'Playwright report runId mismatch');
  invariant(report?.config?.metadata?.profile === profile, 'Playwright report profile mismatch');
  invariant(report?.config?.metadata?.cpuOnly === true, 'Playwright report is not CPU-only');
  invariant(
    Array.isArray(report.errors) && report.errors.length === 0,
    'Playwright report contains top-level errors',
  );
  invariant(report.stats?.expected > 0, 'Playwright report contains no expected tests');
  invariant(report.stats?.skipped === 0, 'Playwright report contains skipped tests');
  invariant(report.stats?.unexpected === 0, 'Playwright report contains unexpected tests');
  invariant(report.stats?.flaky === 0, 'Playwright report contains flaky tests');
  invariant(isDate(report.stats?.startTime), 'Playwright report has invalid startTime');
  invariant(
    Number.isFinite(report.stats?.duration) && report.stats.duration >= 0,
    'Playwright report has invalid duration',
  );
  const startedAt = report.stats.startTime;
  const finishedAt = new Date(Date.parse(startedAt) + report.stats.duration).toISOString();
  return { startedAt, finishedAt };
}

function ledgerCases(ledger) {
  invariant(
    ledger?.schemaVersion === 2 && Array.isArray(ledger.features),
    'coverage ledger schema must be 2',
  );
  const cases = new Map();
  for (const feature of ledger.features) {
    for (const coverageCase of feature.cases ?? []) {
      invariant(!cases.has(coverageCase.caseId), `duplicate ledger case ${coverageCase.caseId}`);
      cases.set(coverageCase.caseId, { feature, coverageCase });
    }
  }
  return cases;
}

function parseJsonLines(bytes, label) {
  const events = [];
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (!line) continue;
    invariant(line.length <= 1024 * 1024, `${label}:${index + 1} exceeds the line-size limit`);
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${label}:${index + 1} is invalid JSON: ${error.message}`);
    }
  }
  invariant(events.length > 0, `${label} contains no events`);
  return events;
}

function surfacePathPattern(surface) {
  const [, method, path] = surface.split('|');
  const pattern = path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return { method, pattern: new RegExp(`^/${pattern}/?$`) };
}

export function validateRuntimeEvents({
  ledger,
  report,
  runId,
  profile,
  runtimeDir,
  runCreatedAt,
  rawCaseEvents,
  rawHttpEvents,
}) {
  const { startedAt, finishedAt } = reportWindow(report, runId, profile);
  invariant(
    typeof runtimeDir === 'string' && withinRuntime(runtimeBase, runtimeDir),
    'runtimeDir is required for event validation',
  );
  invariant(isDate(runCreatedAt), 'run createdAt is invalid');
  const cases = ledgerCases(ledger);
  const passedMarkers = new Map();
  let reportTests = 0;
  for (const spec of collectReportSpecs(report)) {
    const specPath = `specs/${String(spec.file ?? '').replaceAll('\\', '/')}`;
    invariant(spec.ok === true, `Playwright spec did not pass: ${specPath} ${spec.title}`);
    for (const reportTest of spec.tests ?? []) {
      reportTests += 1;
      invariant(
        reportTest.status === 'expected',
        `Playwright test status is not expected: ${spec.title}`,
      );
      invariant(
        (reportTest.results ?? []).some((result) => result.status === 'passed'),
        `Playwright test has no passed result: ${spec.title}`,
      );
      const caseAnnotations = (reportTest.annotations ?? [])
        .filter((entry) => entry.type === 'nyabase.coverage.case')
        .map((entry) => entry.description);
      const testIdAnnotations = (reportTest.annotations ?? [])
        .filter((entry) => entry.type === 'nyabase.coverage.test-id')
        .map((entry) => entry.description);
      invariant(
        caseAnnotations.length === 1,
        `Playwright test must have one case annotation: ${spec.title}`,
      );
      invariant(
        testIdAnnotations.length === 1,
        `Playwright test must have one test-id annotation: ${spec.title}`,
      );
      const caseId = caseAnnotations[0];
      const specTestId = testIdAnnotations[0];
      const key = `${caseId}|${specTestId}|${specPath}`;
      invariant(!passedMarkers.has(key), `duplicate Playwright coverage marker ${key}`);
      passedMarkers.set(key, { caseId, specTestId, specPath });
    }
  }
  invariant(
    reportTests === report.stats.expected,
    'Playwright expected-test count does not match report cases',
  );

  const httpByMarker = new Map();
  for (const event of rawHttpEvents) {
    invariant(event.schemaVersion === 1, 'HTTP event schemaVersion mismatch');
    invariant(
      event.runId === runId && event.profile === profile,
      'HTTP event run/profile mismatch',
    );
    const entry = cases.get(event.caseId);
    invariant(entry, `HTTP event references unknown case ${String(event.caseId)}`);
    const { coverageCase } = entry;
    invariant(
      event.specTestId && coverageCase.specTestIds.includes(event.specTestId),
      `${event.caseId} HTTP event has undeclared test id`,
    );
    invariant(
      event.persona === coverageCase.persona,
      `${event.caseId} HTTP event persona mismatch`,
    );
    invariant(
      typeof event.normalizedSurface === 'string',
      `${event.caseId} HTTP event lacks normalizedSurface`,
    );
    const surfaceOwner = [...cases.values()].find(({ coverageCase: candidate }) =>
      candidate.httpSurfaces.includes(event.normalizedSurface),
    );
    invariant(surfaceOwner, `HTTP event references unknown surface ${event.normalizedSurface}`);
    const { method, pattern } = surfacePathPattern(event.normalizedSurface);
    invariant(
      event.method === method,
      `${event.caseId} HTTP event method does not match normalized surface`,
    );
    invariant(
      typeof event.requestPath === 'string' && pattern.test(event.requestPath),
      `${event.caseId} HTTP event path does not match normalized surface`,
    );
    const countsForCase = coverageCase.httpSurfaces.includes(event.normalizedSurface);
    invariant(
      event.countsForCase === countsForCase,
      `${event.caseId} HTTP event countsForCase is incorrect`,
    );
    invariant(
      Number.isInteger(event.status) && event.status >= 100 && event.status <= 599,
      `${event.caseId} HTTP event has invalid status`,
    );
    invariant(isDate(event.observedAt), `${event.caseId} HTTP event observedAt is invalid`);
    invariant(
      Date.parse(event.observedAt) >= Date.parse(startedAt) - 5000 &&
        Date.parse(event.observedAt) <= Date.parse(finishedAt) + 5000,
      `${event.caseId} HTTP event is outside the Playwright run window`,
    );
    const key = `${event.caseId}|${event.specTestId}`;
    const events = httpByMarker.get(key) ?? [];
    events.push(event);
    httpByMarker.set(key, events);
  }

  const sanitized = [];
  const runtimeMarkers = new Set();
  const fixtureMarkers = new Set();
  for (const event of rawCaseEvents) {
    invariant(event.schemaVersion === 1, 'case event schemaVersion mismatch');
    invariant(
      event.runId === runId && event.profile === profile,
      'case event run/profile mismatch',
    );
    const entry = cases.get(event.caseId);
    invariant(entry, `case event references unknown case ${String(event.caseId)}`);
    const { feature, coverageCase } = entry;
    invariant(
      coverageCase.status === 'implemented',
      `${event.caseId} emitted runtime evidence while not implemented`,
    );
    invariant(
      coverageCase.profiles.includes(profile),
      `${event.caseId} is outside profile ${profile}`,
    );
    invariant(event.kind === coverageCase.kind, `${event.caseId} case event kind mismatch`);
    invariant(event.status === 'passed', `${event.caseId} runtime case event did not pass`);
    invariant(
      event.persona === coverageCase.persona,
      `${event.caseId} case event persona mismatch`,
    );
    invariant(isDate(event.observedAt), `${event.caseId} case event observedAt is invalid`);
    const observed = [...new Set(event.observedHttpSurfaces ?? [])].sort();
    const expected = [...coverageCase.httpSurfaces].sort();
    invariant(
      JSON.stringify(observed) === JSON.stringify(expected),
      `${event.caseId} did not observe its exact declared HTTP surfaces`,
    );
    if (coverageCase.kind === 'fixture') {
      invariant(
        event.source === 'fixture',
        `${event.caseId} fixture event must come from its fixture producer`,
      );
      invariant(
        !event.specPath && !event.specTestId,
        `${event.caseId} fixture event cannot use Playwright identity`,
      );
      invariant(
        Date.parse(event.observedAt) >= Date.parse(runCreatedAt) - 5000 &&
          Date.parse(event.observedAt) <= Date.parse(startedAt) + 5000,
        `${event.caseId} fixture event is outside the current-run setup window`,
      );
      const marker = `${event.caseId}|${event.fixtureProducer}`;
      invariant(!fixtureMarkers.has(marker), `duplicate fixture case event ${marker}`);
      fixtureMarkers.add(marker);
      const artifactPath = validateFixtureArtifact(runtimeDir, event, coverageCase, runId);
      sanitized.push({
        caseId: event.caseId,
        kind: event.kind,
        source: event.source,
        status: event.status,
        observedAt: event.observedAt,
        fixtureProducer: event.fixtureProducer,
        artifactPath,
        artifactSha256: event.artifactSha256,
        observedHttpSurfaces: observed,
      });
      continue;
    }
    invariant(
      event.source === 'playwright',
      `${event.caseId} runtime case event must come from Playwright`,
    );
    invariant(
      Date.parse(event.observedAt) >= Date.parse(startedAt) - 5000 &&
        Date.parse(event.observedAt) <= Date.parse(finishedAt) + 5000,
      `${event.caseId} case event is outside the Playwright run window`,
    );
    invariant(
      feature.specs.includes(event.specPath),
      `${event.caseId} case event has undeclared spec path`,
    );
    invariant(
      coverageCase.specTestIds.includes(event.specTestId),
      `${event.caseId} case event has undeclared test id`,
    );
    const marker = `${event.caseId}|${event.specTestId}|${event.specPath}`;
    invariant(
      passedMarkers.has(marker),
      `${event.caseId} case event has no matching passed Playwright marker`,
    );
    invariant(!runtimeMarkers.has(marker), `duplicate runtime case event ${marker}`);
    runtimeMarkers.add(marker);
    const counted = [
      ...new Set(
        (httpByMarker.get(`${event.caseId}|${event.specTestId}`) ?? [])
          .filter((candidate) => candidate.countsForCase)
          .map((candidate) => candidate.normalizedSurface),
      ),
    ].sort();
    invariant(
      JSON.stringify(counted) === JSON.stringify(expected),
      `${event.caseId} case event is not backed by exact HTTP events`,
    );
    sanitized.push({
      caseId: event.caseId,
      kind: event.kind,
      source: event.source,
      status: event.status,
      observedAt: event.observedAt,
      specPath: event.specPath,
      specTestId: event.specTestId,
      observedHttpSurfaces: observed,
    });
  }
  invariant(
    runtimeMarkers.size === passedMarkers.size,
    'runtime case-event count does not match passed Playwright markers',
  );
  for (const marker of passedMarkers.keys())
    invariant(runtimeMarkers.has(marker), `missing runtime case event ${marker}`);
  const expectedFixtureMarkers = [...cases.values()]
    .filter(
      ({ coverageCase }) =>
        coverageCase.kind === 'fixture' &&
        coverageCase.status === 'implemented' &&
        coverageCase.profiles.includes(profile),
    )
    .map(({ coverageCase }) => `${coverageCase.caseId}|${coverageCase.fixtureProducer}`);
  invariant(
    fixtureMarkers.size === expectedFixtureMarkers.length,
    'runtime fixture-event count does not match profile fixtures',
  );
  for (const marker of expectedFixtureMarkers)
    invariant(fixtureMarkers.has(marker), `missing runtime fixture event ${marker}`);
  return sanitized;
}

async function loadContext(runtimeDirValue, profile, expectedRunId) {
  invariant(profiles.has(profile), `unknown profile ${profile}`);
  invariant(/^[a-z0-9][a-z0-9-]{2,47}$/.test(expectedRunId ?? ''), 'expected runId is invalid');
  const runtimeDir = normalizeRuntime(runtimeDirValue);
  await assertDirectory(runtimeBase, 'runtime base');
  await assertDirectory(runtimeDir, 'runtime directory');
  invariant(
    basename(runtimeDir) === expectedRunId,
    'runtime directory name does not match expected runId',
  );

  const stateFile = await readRuntimeFile(runtimeDir, 'state.env', 'state.env', maxBytes.env);
  const state = parseClosedRunState(stateFile.bytes.toString('utf8'), 'state.env');
  assertRunStateIdentity(state, runtimeDir, profile);
  invariant(state.NYABASE_E2E_RUN_ID === expectedRunId, 'state.env runId mismatch');
  invariant(
    resolve(state.NYABASE_E2E_RUNTIME_DIR ?? '') === runtimeDir,
    'state.env runtimeDir mismatch',
  );
  const ledgerFile = await readRepoFile(ledgerPath, 'coverage ledger', maxBytes.ledger);
  const ledger = parseJson(ledgerFile.bytes, 'coverage ledger');
  return { runtimeDir, runId: expectedRunId, profile, state, ledgerFile, ledger };
}

async function loadReport(context) {
  const reportFile = await readRuntimeFile(
    context.runtimeDir,
    join('reports', 'playwright.json'),
    'Playwright JSON report',
  );
  const report = parseJson(reportFile.bytes, 'Playwright JSON report');
  const window = reportWindow(report, context.runId, context.profile);
  return { reportFile, report, window };
}

async function validatePreDownArtifacts(context, reportFile) {
  const auditFile = await readRuntimeFile(
    context.runtimeDir,
    'artifact-audit.json',
    'artifact audit',
  );
  const audit = parseJson(auditFile.bytes, 'artifact audit');
  invariant(audit.schemaVersion === 1, 'artifact audit schema mismatch');
  invariant(audit.runId === context.runId, 'artifact audit runId mismatch');
  invariant(audit.status === 'clean' && isDate(audit.checkedAt), 'artifact audit is not clean');
  invariant(
    audit.playwrightArtifactPolicy === 'retained-final',
    'artifact audit did not inspect the final retained Playwright set',
  );
  invariant(audit.fixtureProofsChecked === 8, 'artifact audit did not inspect all fixture proofs');

  const probeFile = await readRuntimeFile(
    context.runtimeDir,
    'probe-evidence.json',
    'probe evidence',
  );
  const probe = parseJson(probeFile.bytes, 'probe evidence');
  invariant(
    probe.schemaVersion === 1 && probe.runId === context.runId,
    'probe evidence run mismatch',
  );
  invariant(
    probe.playwright?.status === 'passed',
    'probe evidence does not attest Playwright PASS',
  );
  invariant(
    probe.playwright?.reportSha256 === sha256(reportFile.bytes),
    'probe evidence report hash mismatch',
  );
  invariant(isDate(probe.capturedAt), 'probe evidence capturedAt is invalid');
  invariant(
    probe.productLifecycle?.controlPlaneAbsent === true,
    'probe evidence does not prove public control-plane cleanup',
  );
  invariant(
    Array.isArray(probe.physical?.nodes) &&
      probe.physical.nodes.length === 2 &&
      probe.physical.nodes.every(
        (node) => node.managedContainerCount === 0 && node.deletedRuntimeAbsent === true,
      ),
    'probe evidence does not prove both managed dockerd instances are clean',
  );
  const probeEvidence = {
    path: probeFile.path,
    sha256: sha256(probeFile.bytes),
    capturedAt: probe.capturedAt,
  };
  return {
    artifactAudit: {
      path: auditFile.path,
      sha256: sha256(auditFile.bytes),
      checkedAt: audit.checkedAt,
    },
    probeEvidence,
  };
}

export async function prepareEvidence(runtimeDirValue, profile, expectedRunId) {
  const context = await loadContext(runtimeDirValue, profile, expectedRunId);
  const manifestFile = await readRuntimeFile(
    context.runtimeDir,
    'manifest.json',
    'pre-down manifest',
  );
  const manifest = parseJson(manifestFile.bytes, 'pre-down manifest');
  validatePreDownManifest(manifest, context.runId);

  const { reportFile, report, window } = await loadReport(context);
  const preDown = await validatePreDownArtifacts(context, reportFile);
  const runtimeCaseFile = await readRuntimeFile(
    context.runtimeDir,
    'coverage-case-events.jsonl',
    'runtime case events',
  );
  const runtimeHttpFile = await readRuntimeFile(
    context.runtimeDir,
    'coverage-http-events.jsonl',
    'runtime HTTP events',
  );
  const events = validateRuntimeEvents({
    ledger: context.ledger,
    report,
    runId: context.runId,
    profile: context.profile,
    runtimeDir: context.runtimeDir,
    runCreatedAt: manifest.createdAt,
    rawCaseEvents: parseJsonLines(runtimeCaseFile.bytes, 'runtime case events'),
    rawHttpEvents: parseJsonLines(runtimeHttpFile.bytes, 'runtime HTTP events'),
  });
  const secretsFile = await readRuntimeFile(
    context.runtimeDir,
    'secrets.env',
    'secrets.env',
    maxBytes.env,
  );
  const knownSecrets = Object.values(parseEnv(secretsFile.bytes.toString('utf8'), 'secrets.env'));
  for (const [label, bytes] of [
    ['runtime case events', runtimeCaseFile.bytes],
    ['runtime HTTP events', runtimeHttpFile.bytes],
  ]) {
    const text = bytes.toString('utf8');
    for (const secret of knownSecrets) {
      if (secret.length >= 8)
        invariant(!text.includes(secret), `${label} contains a per-run secret`);
    }
    invariant(
      !/authorization\s*[:=]\s*bearer/i.test(text),
      `${label} contains an authorization header`,
    );
  }
  const capturedAt = new Date().toISOString();
  invariant(
    Date.parse(capturedAt) >= Date.parse(window.finishedAt),
    'case events precede Playwright completion',
  );
  invariant(
    Date.parse(capturedAt) >= Date.parse(preDown.artifactAudit.checkedAt),
    'case events precede artifact audit',
  );
  const value = {
    schemaVersion: 1,
    runId: context.runId,
    profile: context.profile,
    capturedAt,
    ledgerSha256: sha256(context.ledgerFile.bytes),
    playwright: {
      reportPath: reportFile.path,
      reportSha256: sha256(reportFile.bytes),
      startedAt: window.startedAt,
      finishedAt: window.finishedAt,
    },
    preDown,
    runtimeEvents: {
      caseEventsPath: runtimeCaseFile.path,
      caseEventsSha256: sha256(runtimeCaseFile.bytes),
      caseEventCount: events.length,
      httpEventsPath: runtimeHttpFile.path,
      httpEventsSha256: sha256(runtimeHttpFile.bytes),
      httpEventCount: parseJsonLines(runtimeHttpFile.bytes, 'runtime HTTP events').length,
    },
    caseEvents: events,
  };
  const outputPath = await writePrivateAtomic(
    context.runtimeDir,
    'coverage-event-seal.json',
    value,
    knownSecrets,
  );
  console.log(`case-event seal PASS: ${events.length} current-run events -> ${outputPath}`);
  return value;
}

function requireBuildField(build, name, pattern) {
  const value = build[name];
  invariant(typeof value === 'string' && pattern.test(value), `build.env has invalid ${name}`);
  return value;
}

async function revalidateEventSeal(context, reportFile, report, eventSealFile, runCreatedAt) {
  const value = parseJson(eventSealFile.bytes, 'coverage-event-seal.json');
  invariant(value.schemaVersion === 1, 'event seal schema mismatch');
  invariant(
    value.runId === context.runId && value.profile === context.profile,
    'event seal run/profile mismatch',
  );
  invariant(isDate(value.capturedAt), 'event seal capturedAt is invalid');
  invariant(
    value.ledgerSha256 === sha256(context.ledgerFile.bytes),
    'event seal ledger hash is stale',
  );
  invariant(value.playwright?.reportPath === reportFile.path, 'event seal report path mismatch');
  invariant(
    value.playwright?.reportSha256 === sha256(reportFile.bytes),
    'event seal report hash mismatch',
  );
  const preDown = await validatePreDownArtifacts(context, reportFile);
  invariant(
    JSON.stringify(value.preDown) === JSON.stringify(preDown),
    'pre-down artifact bindings changed after capture',
  );
  const runtimeCaseFile = await readRuntimeFile(
    context.runtimeDir,
    'coverage-case-events.jsonl',
    'runtime case events',
  );
  const runtimeHttpFile = await readRuntimeFile(
    context.runtimeDir,
    'coverage-http-events.jsonl',
    'runtime HTTP events',
  );
  invariant(
    value.runtimeEvents?.caseEventsPath === runtimeCaseFile.path,
    'event seal case-event path mismatch',
  );
  invariant(
    value.runtimeEvents?.caseEventsSha256 === sha256(runtimeCaseFile.bytes),
    'runtime case events changed after sealing',
  );
  invariant(
    value.runtimeEvents?.httpEventsPath === runtimeHttpFile.path,
    'event seal HTTP-event path mismatch',
  );
  invariant(
    value.runtimeEvents?.httpEventsSha256 === sha256(runtimeHttpFile.bytes),
    'runtime HTTP events changed after sealing',
  );
  const derived = validateRuntimeEvents({
    ledger: context.ledger,
    report,
    runId: context.runId,
    profile: context.profile,
    runtimeDir: context.runtimeDir,
    runCreatedAt,
    rawCaseEvents: parseJsonLines(runtimeCaseFile.bytes, 'runtime case events'),
    rawHttpEvents: parseJsonLines(runtimeHttpFile.bytes, 'runtime HTTP events'),
  });
  invariant(
    JSON.stringify(value.caseEvents) === JSON.stringify(derived),
    'sealed case events do not match runtime events, report, and ledger',
  );
  return value;
}

export async function finalizeEvidence(runtimeDirValue, profile, expectedRunId) {
  const context = await loadContext(runtimeDirValue, profile, expectedRunId);
  await pathAbsent(join(context.runtimeDir, 'secrets.env'), 'secrets.env');
  await pathAbsent(join(context.runtimeDir, 'backend.yaml'), 'backend.yaml');
  await pathAbsent(join(context.runtimeDir, 'backend-config'), 'Backend config directory');
  await pathAbsent(join(context.runtimeDir, 'certs'), 'certificate directory');
  await pathAbsent(join(context.runtimeDir, 'agents'), 'Agent credential directory');

  const manifestFile = await readRuntimeFile(
    context.runtimeDir,
    'manifest.json',
    'cleaned manifest',
  );
  const manifest = parseJson(manifestFile.bytes, 'cleaned manifest');
  validateCleanedManifest(manifest, context.runId);

  const { reportFile, report, window } = await loadReport(context);
  const eventSealFile = await readRuntimeFile(
    context.runtimeDir,
    'coverage-event-seal.json',
    'coverage event seal',
  );
  const caseEventState = await revalidateEventSeal(
    context,
    reportFile,
    report,
    eventSealFile,
    manifest.createdAt,
  );
  const buildFile = await readRuntimeFile(
    context.runtimeDir,
    'build.env',
    'build.env',
    maxBytes.env,
  );
  const build = parseEnv(buildFile.bytes.toString('utf8'), 'build.env');
  invariant(build.BUILD_SCHEMA_VERSION === '1', 'build.env schema mismatch');
  const gitSha = requireBuildField(build, 'GIT_SHA', /^[0-9a-f]{40}$/);
  const trackedDiffSha256 = requireBuildField(build, 'TRACKED_DIFF_SHA256', /^[0-9a-f]{64}$/);
  const untrackedSourceSha256 = requireBuildField(
    build,
    'UNTRACKED_SOURCE_SHA256',
    /^[0-9a-f]{64}$/,
  );
  const productSourceSha256 = requireBuildField(build, 'PRODUCT_SOURCE_SHA256', /^[0-9a-f]{64}$/);
  const backendImageId = requireBuildField(build, 'BACKEND_IMAGE_ID', /^sha256:[0-9a-f]{64}$/);
  const nodeImageId = requireBuildField(build, 'NODE_IMAGE_ID', /^sha256:[0-9a-f]{64}$/);
  const builtAt = requireBuildField(build, 'BUILT_AT', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  invariant(
    Date.parse(manifest.cleanup.checkedAt) >= Date.parse(caseEventState.capturedAt),
    'cleanup timestamp precedes pre-down case events',
  );

  const generatedAt = new Date().toISOString();
  invariant(
    Date.parse(generatedAt) >= Date.parse(manifest.cleanup.checkedAt),
    'evidence timestamp precedes cleanup',
  );
  const finalizedEvents = context.ledger.features
    .flatMap((feature) => feature.cases ?? [])
    .filter(
      (coverageCase) =>
        coverageCase.status === 'implemented' &&
        coverageCase.kind === 'evidence' &&
        ['evidence', 'cleanup'].includes(coverageCase.evidenceSource) &&
        coverageCase.profiles.includes(context.profile) &&
        // This event is intentionally absent after one Full run. Only the
        // chain verifier may append it after independently revalidating the
        // immediately preceding clean cold Full candidate.
        coverageCase.caseId !== consecutiveFullCaseId,
    )
    .map((coverageCase) => {
      let artifact;
      let observedAt;
      if (coverageCase.evidenceSource === 'evidence') {
        artifact = buildFile;
        observedAt = builtAt;
      } else if (
        [
          'cleanup.release-evidence.public-api-cleanup',
          'cleanup.release-evidence.inner-docker-cleanup',
        ].includes(coverageCase.caseId)
      ) {
        invariant(
          caseEventState.preDown.probeEvidence,
          `${coverageCase.caseId} requires a lifecycle cleanup probe`,
        );
        artifact = {
          path: caseEventState.preDown.probeEvidence.path,
          bytes: readFileSync(caseEventState.preDown.probeEvidence.path),
        };
        observedAt = manifest.cleanup.checkedAt;
      } else if (coverageCase.caseId === 'cleanup.release-evidence.redacted-provenance') {
        artifact = {
          path: caseEventState.preDown.artifactAudit.path,
          bytes: readFileSync(caseEventState.preDown.artifactAudit.path),
        };
        observedAt = manifest.cleanup.checkedAt;
      } else {
        artifact = manifestFile;
        observedAt = manifest.cleanup.checkedAt;
      }
      invariant(
        typeof coverageCase.evidenceProducer === 'string' &&
          coverageCase.evidenceProducer.length > 0,
        `${coverageCase.caseId} lacks a finalized evidence producer`,
      );
      return {
        caseId: coverageCase.caseId,
        kind: coverageCase.kind,
        source: coverageCase.evidenceSource,
        status: 'passed',
        observedAt,
        evidenceProducer: coverageCase.evidenceProducer,
        artifactPath: artifact.path,
        artifactSha256: sha256(artifact.bytes),
        observedHttpSurfaces: [],
      };
    });
  const evidence = {
    schemaVersion: 1,
    runId: context.runId,
    profile: context.profile,
    generatedAt,
    ledgerSha256: sha256(context.ledgerFile.bytes),
    build: {
      provenancePath: buildFile.path,
      provenanceSha256: sha256(buildFile.bytes),
      gitSha,
      trackedDiffSha256,
      untrackedSourceSha256,
      productSourceSha256,
      backendImageId,
      nodeImageId,
      builtAt,
    },
    playwright: {
      status: 'passed',
      reportPath: reportFile.path,
      reportSha256: sha256(reportFile.bytes),
      startedAt: window.startedAt,
      finishedAt: window.finishedAt,
    },
    caseEvents: [...caseEventState.caseEvents, ...finalizedEvents],
    cleanup: {
      phase: 'post-down',
      status: 'clean',
      manifestSchemaVersion,
      manifestPath: manifestFile.path,
      manifestSha256: sha256(manifestFile.bytes),
      checkedAt: manifest.cleanup.checkedAt,
    },
  };
  const outputPath = await writePrivateAtomic(
    context.runtimeDir,
    'coverage-evidence.json',
    evidence,
  );
  console.log(`coverage evidence PASS: post-down current-run evidence -> ${outputPath}`);
  return evidence;
}

async function main() {
  const [command, runtimeDir, profile, expectedRunId] = process.argv.slice(2);
  if (!['prepare', 'finalize'].includes(command) || !runtimeDir || !profile || !expectedRunId) {
    throw new Error(
      'usage: coverage-evidence.mjs {prepare|finalize} <runtimeDir> <profile> <expectedRunId>',
    );
  }
  if (command === 'prepare') await prepareEvidence(runtimeDir, profile, expectedRunId);
  else await finalizeEvidence(runtimeDir, profile, expectedRunId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
