import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const REDACTED = '[REDACTED]';
const MAX_FAILURES = 4;
const MAX_ERRORS_PER_FAILURE = 4;
const MAX_DIAGNOSTIC_CHARS = 4_000;
export const MAX_RETAINED_ARTIFACT_BYTES = 16 * 1024 * 1024;
const ALLOWED_REPORT_FILES = new Set([
  'artifact-normalization.json',
  'failure-summary.json',
  'junit.xml',
  'playwright.json',
]);

export function parseEnv(text) {
  return Object.fromEntries(
    text.split(/\r?\n/u).filter(Boolean).map((line) => {
      const separator = line.indexOf('=');
      if (separator <= 0) throw new Error('artifact secret environment contains an invalid line');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

export function knownSecretsFromEnv(text) {
  return [...new Set(Object.values(parseEnv(text)).filter((value) => value.length >= 8))]
    .sort((left, right) => right.length - left.length);
}

export function redactArtifactText(value, secrets) {
  let text = String(value ?? '');
  for (const secret of secrets) text = text.split(secret).join(REDACTED);
  return text
    .replace(
      /-----BEGIN [^-\r\n]{1,64}PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]{1,64}PRIVATE KEY-----/giu,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED JWT]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(
      /(["']?(?:agentToken|accessToken|refreshToken|authorization|password|privateKey|secret)["']?\s*[:=]\s*)"[^"\r\n]*"/giu,
      '$1"[REDACTED]"',
    )
    .replace(
      /(["']?(?:agentToken|accessToken|refreshToken|authorization|password|privateKey|secret)["']?\s*[:=]\s*)'[^'\r\n]*'/giu,
      "$1'[REDACTED]'",
    )
    .replace(
      /(["']?(?:agentToken|accessToken|refreshToken|authorization|password|privateKey|secret)["']?\s*[:=]\s*)(?!\[REDACTED\])[^\s,;}]*/giu,
      '$1[REDACTED]',
    );
}

export function containsForbiddenCredentialPattern(value) {
  const text = String(value ?? '');
  return [
    /\bbearer\s+(?!\[REDACTED\])[a-z0-9._~+/=-]+/iu,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
    /authorization\s*[:=]\s*bearer\s+[a-z0-9._~+/=-]+/iu,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /-----END [A-Z ]*PRIVATE KEY-----/u,
    /["']?(?:password|refreshToken|accessToken|agentToken|secret|privateKey)["']?\s*[:=]\s*(?:"(?!\[REDACTED\])[^"\r\n]+"|'(?!\[REDACTED\])[^'\r\n]+'|(?!\[REDACTED\])[^\s,;}]*)/iu,
  ].some((pattern) => pattern.test(text));
}

function sanitizeJson(value, secrets, counters) {
  if (typeof value === 'string') return redactArtifactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => sanitizeJson(entry, secrets, counters));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'errorContext') {
      counters.errorContextsRemoved += 1;
      continue;
    }
    if (key === 'attachments') {
      if (Array.isArray(entry)) counters.attachmentsRemoved += entry.length;
      result[key] = [];
      continue;
    }
    const sanitizedKey = redactArtifactText(key, secrets);
    if (Object.hasOwn(result, sanitizedKey)) {
      throw new Error('Playwright JSON keys collide after credential redaction');
    }
    result[sanitizedKey] = sanitizeJson(entry, secrets, counters);
  }
  return result;
}

function bounded(value, limit = MAX_DIAGNOSTIC_CHARS) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit - 14)}…[truncated]`;
}

function reportOutcome(report) {
  const stats = report?.stats ?? {};
  return stats.unexpected === 0 && stats.skipped === 0 && stats.flaky === 0
    ? 'passed'
    : 'failed';
}

function collectFailures(report) {
  const failures = [];
  const visitSuite = (suite, ancestors = []) => {
    const nextAncestors = suite?.title ? [...ancestors, suite.title] : ancestors;
    for (const spec of suite?.specs ?? []) {
      for (const reportTest of spec.tests ?? []) {
        const failedResults = (reportTest.results ?? []).filter((result) => result.status !== 'passed');
        if (reportTest.status === 'expected' && failedResults.length === 0) continue;
        const errors = failedResults.flatMap((result) => result.errors ?? []).slice(0, MAX_ERRORS_PER_FAILURE);
        const firstLocation = errors.find((error) => error?.location)?.location ?? spec.location ?? {};
        failures.push({
          title: [...nextAncestors, spec.title, reportTest.title].filter(Boolean).join(' > '),
          file: spec.file ?? firstLocation.file ?? null,
          line: firstLocation.line ?? null,
          column: firstLocation.column ?? null,
          status: reportTest.status ?? failedResults[0]?.status ?? 'unknown',
          resultStatuses: (reportTest.results ?? []).map((result) => result.status),
          errors: errors.map((error) => ({
            message: bounded(error?.message),
            stack: bounded(error?.stack ?? error?.message),
          })),
        });
      }
    }
    for (const child of suite?.suites ?? []) visitSuite(child, nextAncestors);
  };
  for (const suite of report?.suites ?? []) visitSuite(suite);
  return failures;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function atomicWrite(path, bytes) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  await chmod(path, 0o600);
}

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`Playwright artifact must be a singly-linked regular file: ${path}`);
  }
  if (info.size > MAX_RETAINED_ARTIFACT_BYTES) {
    throw new Error(
      `Playwright artifact exceeds the ${MAX_RETAINED_ARTIFACT_BYTES}-byte read bound: ${path}`,
    );
  }
  return info;
}

export async function sanitizePlaywrightArtifacts(runtimeDirValue) {
  const runtimeDir = resolve(runtimeDirValue);
  const reportsDir = join(runtimeDir, 'reports');
  const reportPath = join(reportsDir, 'playwright.json');
  const junitPath = join(reportsDir, 'junit.xml');
  const secrets = knownSecretsFromEnv(await readFile(join(runtimeDir, 'secrets.env'), 'utf8'));
  const state = parseEnv(await readFile(join(runtimeDir, 'state.env'), 'utf8'));
  const runId = state.NYABASE_E2E_RUN_ID;
  if (!runId || basename(runtimeDir) !== runId) throw new Error('artifact runtime identity mismatch');

  await Promise.all([regularFile(reportPath), regularFile(junitPath)]);
  const counters = { attachmentsRemoved: 0, errorContextsRemoved: 0 };
  const report = sanitizeJson(JSON.parse(await readFile(reportPath, 'utf8')), secrets, counters);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const junitBytes = Buffer.from(redactArtifactText(await readFile(junitPath, 'utf8'), secrets));

  // Playwright error contexts, HTML payloads, screenshots, traces, videos, and
  // arbitrary test attachments are not in the retained-artifact allowlist.
  await rm(join(reportsDir, 'html'), { recursive: true, force: true });
  await rm(join(runtimeDir, 'test-results'), { recursive: true, force: true });
  await atomicWrite(reportPath, reportBytes);
  await atomicWrite(junitPath, junitBytes);

  const outcome = reportOutcome(report);
  let failureSummarySha256 = null;
  const summaryPath = join(reportsDir, 'failure-summary.json');
  if (outcome === 'failed') {
    const failures = collectFailures(report);
    const summaryBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      runId,
      generatedAt: new Date().toISOString(),
      status: 'failed',
      stats: report.stats,
      failures: failures.slice(0, MAX_FAILURES),
      failuresTruncated: Math.max(0, failures.length - MAX_FAILURES),
    }, null, 2)}\n`);
    failureSummarySha256 = sha256(summaryBytes);
    await atomicWrite(summaryPath, summaryBytes);
  } else {
    await rm(summaryPath, { force: true });
  }

  const normalization = {
    schemaVersion: 1,
    runId,
    normalizedAt: new Date().toISOString(),
    status: 'normalized',
    reportOutcome: outcome,
    attachmentsRemoved: counters.attachmentsRemoved,
    errorContextsRemoved: counters.errorContextsRemoved,
    retainedAttachmentKinds: [],
    playwrightReportSha256: sha256(reportBytes),
    junitReportSha256: sha256(junitBytes),
    failureSummarySha256,
  };
  await atomicWrite(
    join(reportsDir, 'artifact-normalization.json'),
    Buffer.from(`${JSON.stringify(normalization, null, 2)}\n`),
  );
  return normalization;
}

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

function jsonContainsUnsafeAttachment(value) {
  if (Array.isArray(value)) return value.some(jsonContainsUnsafeAttachment);
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, 'errorContext')) return true;
  if (Object.hasOwn(value, 'attachments') && (!Array.isArray(value.attachments) || value.attachments.length > 0)) {
    return true;
  }
  return Object.values(value).some(jsonContainsUnsafeAttachment);
}

export async function inspectPlaywrightArtifactPolicy(runtimeDirValue) {
  const runtimeDir = resolve(runtimeDirValue);
  const reportsDir = join(runtimeDir, 'reports');
  const findings = [];
  const reportFiles = await walk(reportsDir);
  for (const path of reportFiles) {
    const name = relative(reportsDir, path);
    if (name.includes(sep) || !ALLOWED_REPORT_FILES.has(name)) {
      findings.push(`reports/${name} is outside the retained Playwright artifact allowlist`);
    }
  }
  const outputFiles = await walk(join(runtimeDir, 'test-results'));
  if (outputFiles.length > 0) findings.push('test-results contains non-allowlisted Playwright attachments');

  try {
    const state = parseEnv(await readFile(join(runtimeDir, 'state.env'), 'utf8'));
    const runId = state.NYABASE_E2E_RUN_ID;
    const reportPath = join(reportsDir, 'playwright.json');
    const junitPath = join(reportsDir, 'junit.xml');
    const normalizationPath = join(reportsDir, 'artifact-normalization.json');
    await Promise.all([
      regularFile(reportPath),
      regularFile(junitPath),
      regularFile(normalizationPath),
    ]);
    const reportBytes = await readFile(reportPath);
    const junitBytes = await readFile(junitPath);
    const report = JSON.parse(reportBytes);
    const normalization = JSON.parse(await readFile(normalizationPath, 'utf8'));
    if (jsonContainsUnsafeAttachment(report)) findings.push('Playwright JSON retains an attachment or error context');
    if (
      normalization.schemaVersion !== 1
      || normalization.runId !== runId
      || normalization.status !== 'normalized'
      || normalization.playwrightReportSha256 !== sha256(reportBytes)
      || normalization.junitReportSha256 !== sha256(junitBytes)
      || !Array.isArray(normalization.retainedAttachmentKinds)
      || normalization.retainedAttachmentKinds.length !== 0
    ) {
      findings.push('Playwright artifact normalization evidence is invalid');
    }
    const outcome = reportOutcome(report);
    if (normalization.reportOutcome !== outcome) findings.push('normalization report outcome mismatch');
    const summaryPath = join(reportsDir, 'failure-summary.json');
    if (outcome === 'failed') {
      await regularFile(summaryPath);
      const summaryBytes = await readFile(summaryPath);
      const summary = JSON.parse(summaryBytes);
      if (
        summary.schemaVersion !== 1
        || summary.runId !== runId
        || summary.status !== 'failed'
        || normalization.failureSummarySha256 !== sha256(summaryBytes)
        || JSON.stringify(summary.stats) !== JSON.stringify(report.stats)
      ) {
        findings.push('safe Playwright failure summary is invalid');
      }
    } else if (normalization.failureSummarySha256 !== null || reportFiles.includes(summaryPath)) {
      findings.push('passing Playwright report must not have a failure summary');
    }
  } catch (error) {
    findings.push(`Playwright retained artifact set is unreadable: ${error.message}`);
  }
  return findings;
}

export async function inspectPreReportPlaywrightArtifactPolicy(runtimeDirValue) {
  const runtimeDir = resolve(runtimeDirValue);
  const findings = [];
  const reportFiles = await walk(join(runtimeDir, 'reports'));
  if (reportFiles.length > 0) {
    findings.push('pre-report audit requires an empty Playwright reports directory');
  }
  const outputFiles = await walk(join(runtimeDir, 'test-results'));
  if (outputFiles.length > 0) {
    findings.push('test-results contains a Playwright attachment during the pre-report audit');
  }
  return findings;
}
