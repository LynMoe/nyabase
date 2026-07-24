import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  captureDiagnosticInput,
  MAX_DIAGNOSTIC_FILE_BYTES,
} from './capture-diagnostic.mjs';

import {
  containsForbiddenCredentialPattern,
  inspectPreReportPlaywrightArtifactPolicy,
  inspectPlaywrightArtifactPolicy,
  MAX_RETAINED_ARTIFACT_BYTES,
  sanitizePlaywrightArtifacts,
} from './playwright-artifact-security.mjs';

async function writePrivate(path, value) {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function walk(path) {
  try {
    const info = await stat(path);
    if (info.isFile()) return [path];
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

async function scenario({ passed = false } = {}) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'nyabase-artifact-'));
  const runId = basename(runtimeDir);
  const reportsDir = join(runtimeDir, 'reports');
  const resultDir = join(runtimeDir, 'test-results', 'browser-secret-failure');
  const htmlDataDir = join(reportsDir, 'html', 'data');
  await mkdir(resultDir, { recursive: true, mode: 0o700 });
  await mkdir(htmlDataDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);

  const sentinel = `sentinel-${runId}-password`;
  const forbiddenBearer = 'bearer-material-not-in-secret-env';
  const privateMaterial = 'private-material-not-in-secret-env';
  await writePrivate(join(runtimeDir, 'state.env'), `NYABASE_E2E_RUN_ID=${runId}\n`);
  await writePrivate(
    join(runtimeDir, 'secrets.env'),
    `ADMIN_INIT_PASSWORD=${sentinel}\nJWT_SECRET=known-jwt-secret-${runId}\n`,
  );

  const report = {
    config: { metadata: { runId, profile: 'full', cpuOnly: true } },
    errors: [],
    stats: passed
      ? { expected: 1, skipped: 0, unexpected: 0, flaky: 0, startTime: '2026-07-20T00:00:00.000Z', duration: 1 }
      : { expected: 0, skipped: 3, unexpected: 1, flaky: 0, startTime: '2026-07-20T00:00:00.000Z', duration: 1 },
    suites: [{
      title: 'browser artifacts',
      specs: [{
        title: passed ? 'safe pass' : 'four secret ingress paths',
        file: '70-browser/browser.live.spec.ts',
        tests: [{
          title: passed ? 'passes' : 'fails safely',
          status: passed ? 'expected' : 'unexpected',
          results: [{
            status: passed ? 'passed' : 'failed',
            errors: passed ? [] : [{
              location: { file: '70-browser/browser.live.spec.ts', line: 387, column: 9 },
              message: `password=${sentinel}; authorization: Bearer ${forbiddenBearer}`,
              stack: `Error: visible one-time token ${sentinel}\n at browser.live.spec.ts:387:9`,
              errorContext: `- textbox "password" [value=${sentinel}]`,
            }],
            attachments: passed ? [] : [
              { name: 'error-context', contentType: 'text/markdown', path: join(resultDir, 'error-context.md') },
              { name: 'screenshot', contentType: 'image/png', path: join(resultDir, 'test-failed-1.png') },
              { name: 'opaque-user-attachment', contentType: 'application/octet-stream', path: join(resultDir, 'raw.bin') },
            ],
          }],
        }],
      }],
    }],
  };
  await writePrivate(join(reportsDir, 'playwright.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writePrivate(
    join(reportsDir, 'junit.xml'),
    passed
      ? '<testsuites tests="1" failures="0"><testcase name="safe pass"/></testsuites>\n'
      : `<testsuites tests="1" failures="1"><testcase name="four paths"><failure>`
        + `password="${sentinel}" -----BEGIN TEST PRIVATE KEY-----${privateMaterial}`
        + '-----END TEST PRIVATE KEY-----</failure></testcase></testsuites>\n',
  );
  await writePrivate(
    join(resultDir, 'error-context.md'),
    `password input value: ${sentinel}\nvisible one-time token: ${sentinel}\nlocator matcher ariaSnapshot: ${sentinel}\n`,
  );
  await writePrivate(join(resultDir, 'test-failed-1.png'), Buffer.from(`opaque raster ${sentinel}`));
  await writePrivate(join(resultDir, 'raw.bin'), Buffer.from(`opaque attachment ${sentinel}`));
  await writePrivate(join(htmlDataDir, 'error-context-copy.md'), `html copy ${sentinel}\n`);

  return { runtimeDir, runId, sentinel, forbiddenBearer, privateMaterial, report };
}

test('pre-report policy accepts only an empty reports and attachment set', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'nyabase-artifact-pre-report-'));
  try {
    await mkdir(join(runtimeDir, 'reports'), { recursive: true });
    await mkdir(join(runtimeDir, 'test-results'), { recursive: true });
    assert.deepEqual(await inspectPreReportPlaywrightArtifactPolicy(runtimeDir), []);
    await writePrivate(join(runtimeDir, 'reports', 'playwright.json'), '{}');
    assert.match(
      (await inspectPreReportPlaywrightArtifactPolicy(runtimeDir)).join('\n'),
      /requires an empty Playwright reports directory/u,
    );
    await rm(join(runtimeDir, 'reports', 'playwright.json'));
    await writePrivate(join(runtimeDir, 'test-results', 'attachment.txt'), 'opaque');
    assert.match(
      (await inspectPreReportPlaywrightArtifactPolicy(runtimeDir)).join('\n'),
      /contains a Playwright attachment/u,
    );
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('artifact audit CLI accepts no public mode selector beyond fixed pre-report', async () => {
  const auditPath = join(import.meta.dirname, 'audit-artifacts.mjs');
  for (const args of [
    ['/tmp/not-a-runtime', '--retained-final'],
    ['/tmp/not-a-runtime', '--unknown'],
    ['/tmp/not-a-runtime', '--pre-report', '--extra'],
  ]) {
    const result = await run(process.execPath, [auditPath, ...args], {});
    assert.notEqual(result.code, 0);
    assert.match(result.stderr.toString('utf8'), /usage: audit-artifacts\.mjs/u);
  }
});

async function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
    }));
  });
}

test('diagnostic capture is byte-bounded and redacts bare Bearer and JWT credentials', async () => {
  const knownSecret = 'known-diagnostic-secret';
  const jwt = 'eyJheader12345.eyJpayload12345.signature12345';
  const bytes = await captureDiagnosticInput(Readable.from([
    `first fault Bearer ${jwt} password=${knownSecret}\n`,
    'x'.repeat(MAX_DIAGNOSTIC_FILE_BYTES * 2),
    `\nfinal state authorization: Bearer ${jwt}\n`,
  ]), [knownSecret]);
  const text = bytes.toString('utf8');

  assert.ok(bytes.length <= MAX_DIAGNOSTIC_FILE_BYTES);
  assert.match(text, /first fault/u);
  assert.match(text, /final state/u);
  assert.match(text, /bounded diagnostic middle omitted/u);
  assert.equal(text.includes(knownSecret), false);
  assert.equal(text.includes(jwt), false);
  assert.equal(containsForbiddenCredentialPattern(text), false);
  assert.equal(containsForbiddenCredentialPattern(`Bearer ${jwt}`), true);
  assert.equal(containsForbiddenCredentialPattern(jwt), true);
});

test('diagnostic truncation drops credential fragments at both head and tail cut points', async () => {
  const half = MAX_DIAGNOSTIC_FILE_BYTES / 2;
  const jwtParts = [
    `eyJ${'h'.repeat(180)}`,
    `eyJ${'p'.repeat(180)}`,
    `s${'q'.repeat(180)}`,
  ];
  const jwt = jwtParts.join('.');
  const knownSecret = `known-${'k'.repeat(400)}-secret`;
  const probes = [jwt, knownSecret];

  for (const credential of probes) {
    const headPrefix = 'retained first fault\n';
    const headPad = 'a'.repeat(half - headPrefix.length - Math.floor(credential.length / 2));
    const headOutput = await captureDiagnosticInput(Readable.from([
      headPrefix,
      headPad,
      credential,
      `\n${'m'.repeat(MAX_DIAGNOSTIC_FILE_BYTES)}\nretained final state\n`,
    ]), [knownSecret]);
    assert.equal(headOutput.includes(Buffer.from(credential.slice(0, 80))), false);
    assert.match(headOutput.toString('utf8'), /retained first fault/u);

    const retainedCredentialBytes = credential.length - Math.floor(credential.length / 2);
    const tailSuffix = `\n${'z'.repeat(half - retainedCredentialBytes - 22)}\nretained final state\n`;
    const tailOutput = await captureDiagnosticInput(Readable.from([
      `retained first fault\n${'m'.repeat(MAX_DIAGNOSTIC_FILE_BYTES)}`,
      credential,
      tailSuffix,
    ]), [knownSecret]);
    assert.equal(tailOutput.includes(Buffer.from(credential.slice(-80))), false);
    assert.match(tailOutput.toString('utf8'), /retained final state/u);
  }
});

test('safe production launcher defeats hostile reporter env and normalizes real Playwright failure state', async () => {
  const e2eRoot = resolve(import.meta.dirname, '..');
  const runtimeDir = await mkdtemp(join(e2eRoot, '.runtime', 'artifact-playwright-'));
  const escapedReportDir = await mkdtemp(join(tmpdir(), 'nyabase-artifact-output-'));
  const runId = basename(runtimeDir);
  const domSentinel = `dom-${runId}-real`;
  const thrownSentinel = `thrown-${runId}-real`;
  const credentialSentinel = `credential-${runId}-real`;
  const metadataSentinel = `metadata-${runId}-real`;
  const configPath = join(runtimeDir, 'probe.config.mjs');
  const specPath = join(runtimeDir, 'probe.spec.mjs');
  const escapedJsonDir = join(escapedReportDir, 'json-dir');
  const escapedJunitDir = join(escapedReportDir, 'junit-dir');
  await chmod(runtimeDir, 0o700);
  await chmod(escapedReportDir, 0o700);
  await writePrivate(configPath, `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: ${JSON.stringify(runtimeDir)},
  testMatch: 'probe.spec.mjs',
  outputDir: ${JSON.stringify(join(runtimeDir, 'test-results'))},
  maxFailures: 1,
  workers: 1,
  retries: 0,
  reporter: [
    [${JSON.stringify(join(e2eRoot, 'support', 'secret-safe-reporter.ts'))}],
    ['json', { outputFile: ${JSON.stringify(join(runtimeDir, 'reports', 'playwright.json'))} }],
    ['junit', { outputFile: ${JSON.stringify(join(runtimeDir, 'reports', 'junit.xml'))} }],
  ],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
`);
  await writePrivate(specPath, `
import { test, expect } from '@playwright/test';
test('real secret-bearing matcher failure', async ({ page }) => {
  process.stderr.write(${JSON.stringify(`password="${credentialSentinel}"\n`)});
  await page.setContent(${JSON.stringify(`<main><label>Password <input type="password" value="${domSentinel}"></label><p>One-time token ${domSentinel}</p></main>`)});
  try {
    await expect(page.locator('main')).toContainText('deliberately absent text', { timeout: 50 });
  } catch (error) {
    error.message += ${JSON.stringify(`\nThrown error string ${thrownSentinel}\npassword="${credentialSentinel}"`)};
    throw error;
  }
});
`);
  try {
    const result = await run(
      'bash',
      [
        join(e2eRoot, 'orchestrator', 'run-playwright-safe.sh'),
        join(e2eRoot, 'node_modules', '.bin', 'playwright'),
        'test',
        '--config',
        configPath,
      ],
      {
        cwd: e2eRoot,
        env: {
          ...process.env,
          PW_TEST_REPORTER: 'line',
          PW_TEST_DEBUG_REPORTERS: '1',
          PW_RUNNER_DEBUG: '1',
          DEBUG: 'pw:test:protocol',
          PLAYWRIGHT_JSON_OUTPUT_FILE: join(escapedReportDir, 'escaped-playwright.json'),
          PLAYWRIGHT_JSON_OUTPUT_DIR: escapedJsonDir,
          PLAYWRIGHT_JSON_OUTPUT_NAME: 'escaped-json-name.json',
          PLAYWRIGHT_JUNIT_OUTPUT_FILE: join(escapedReportDir, 'escaped-junit.xml'),
          PLAYWRIGHT_JUNIT_OUTPUT_DIR: escapedJunitDir,
          PLAYWRIGHT_JUNIT_OUTPUT_NAME: 'escaped-junit-name.xml',
          PLAYWRIGHT_JUNIT_STRIP_ANSI: '0',
          PLAYWRIGHT_JUNIT_INCLUDE_PROJECT_IN_TEST_NAME: '1',
          PLAYWRIGHT_JUNIT_INCLUDE_RETRIES: '1',
          PLAYWRIGHT_JUNIT_SUITE_ID: `password="${metadataSentinel}"`,
          PLAYWRIGHT_JUNIT_SUITE_NAME: `password="${metadataSentinel}"`,
        },
      },
    );
    assert.equal(result.signal, null);
    assert.equal(result.code, 1);
    const capturedOutputs = [
      ['stdout', result.stdout.toString('utf8')],
      ['stderr', result.stderr.toString('utf8')],
    ];
    for (const [stream, output] of capturedOutputs) {
      for (const sentinel of [domSentinel, thrownSentinel, credentialSentinel, metadataSentinel]) {
        assert.equal(output.includes(sentinel), false, `runner ${stream} must not disclose a sentinel`);
      }
      assert.equal(
        containsForbiddenCredentialPattern(output),
        false,
        `runner ${stream} must not disclose a named credential pattern`,
      );
    }
    assert.match(capturedOutputs[0][1], /Playwright run started: tests=1/u);
    assert.match(capturedOutputs[0][1], /Playwright run completed: status=failed/u);
    assert.doesNotMatch(capturedOutputs[0][1], /\[1\/1\]|Running 1 test/u);
    assert.equal(
      capturedOutputs[1][1],
      'Playwright runner error; redacted details are retained in run artifacts\n',
    );
    const configuredJsonPath = join(runtimeDir, 'reports', 'playwright.json');
    const configuredJunitPath = join(runtimeDir, 'reports', 'junit.xml');
    assert.equal((await stat(configuredJsonPath)).isFile(), true);
    assert.equal((await stat(configuredJunitPath)).isFile(), true);
    assert.deepEqual(
      await walk(escapedReportDir),
      [],
      'hostile JSON/JUnit FILE/DIR/NAME variables must not create external raw reports',
    );
    assert.equal(
      (await readFile(configuredJunitPath)).includes(Buffer.from(metadataSentinel)),
      false,
      'hostile JUnit content variables must not alter the configured report',
    );
    const rawFiles = await walk(runtimeDir);
    const rawArtifactFiles = rawFiles.filter((path) => (
      path.includes('/reports/') || path.includes('/test-results/')
    ));
    const rawArtifactBytes = await Promise.all(rawArtifactFiles.map((path) => readFile(path)));
    for (const sentinel of [domSentinel, thrownSentinel, credentialSentinel]) {
      assert.equal(
        rawArtifactBytes.some((bytes) => bytes.includes(Buffer.from(sentinel))),
        true,
        `the deliberate real failure must exercise the raw ${sentinel.split('-')[0]} ingress path`,
      );
    }

    await writePrivate(join(runtimeDir, 'state.env'), `NYABASE_E2E_RUN_ID=${runId}\n`);
    await writePrivate(
      join(runtimeDir, 'secrets.env'),
      `ADMIN_INIT_PASSWORD=${domSentinel}\nTHROWN_SECRET=${thrownSentinel}\nNAMED_SECRET=${credentialSentinel}\nMETADATA_SECRET=${metadataSentinel}\n`,
    );
    const normalized = await sanitizePlaywrightArtifacts(runtimeDir);
    assert.equal(normalized.reportOutcome, 'failed');
    const retained = (await walk(runtimeDir)).filter((path) => path.includes('/reports/'));
    for (const path of retained) {
      const bytes = await readFile(path);
      for (const sentinel of [domSentinel, thrownSentinel, credentialSentinel, metadataSentinel]) {
        assert.equal(bytes.includes(Buffer.from(sentinel)), false, path);
      }
      assert.equal(containsForbiddenCredentialPattern(bytes.toString('utf8')), false, path);
    }
    const summary = JSON.parse(await readFile(join(runtimeDir, 'reports', 'failure-summary.json'), 'utf8'));
    assert.match(summary.failures[0].title, /real secret-bearing matcher failure/u);
    assert.equal(summary.failures[0].status, 'unexpected');
    assert.match(summary.failures[0].errors[0].stack, /probe\.spec\.mjs/u);
    assert.deepEqual(await inspectPlaywrightArtifactPolicy(runtimeDir), []);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(escapedReportDir, { recursive: true, force: true });
  }
});

test('normalization removes all page/matcher/opaque attachments and retains bounded redacted failure evidence', async () => {
  const fixture = await scenario();
  try {
    const result = await sanitizePlaywrightArtifacts(fixture.runtimeDir);
    assert.equal(result.reportOutcome, 'failed');
    assert.equal(result.attachmentsRemoved, 3);
    assert.equal(result.errorContextsRemoved, 1);

    const files = await walk(fixture.runtimeDir);
    const relativeFiles = files.map((path) => path.slice(fixture.runtimeDir.length + 1)).sort();
    assert.deepEqual(relativeFiles.filter((path) => path.startsWith('reports/')), [
      'reports/artifact-normalization.json',
      'reports/failure-summary.json',
      'reports/junit.xml',
      'reports/playwright.json',
    ]);
    assert.equal(relativeFiles.some((path) => path.startsWith('test-results/')), false);

    const retainedArtifacts = files.filter((path) => (
      path.startsWith(`${join(fixture.runtimeDir, 'reports')}/`)
      || path.startsWith(`${join(fixture.runtimeDir, 'test-results')}/`)
    ));
    for (const path of retainedArtifacts) {
      const bytes = await readFile(path);
      assert.equal(bytes.includes(Buffer.from(fixture.sentinel)), false, path);
      assert.equal(bytes.includes(Buffer.from(fixture.forbiddenBearer)), false, path);
      assert.equal(bytes.includes(Buffer.from(fixture.privateMaterial)), false, path);
      assert.equal(containsForbiddenCredentialPattern(bytes.toString('utf8')), false, path);
    }

    const sanitized = JSON.parse(await readFile(join(fixture.runtimeDir, 'reports', 'playwright.json'), 'utf8'));
    assert.deepEqual(sanitized.stats, fixture.report.stats, 'failure/skip statistics must remain truthful');
    const sanitizedTest = sanitized.suites[0].specs[0].tests[0];
    assert.equal(sanitizedTest.status, 'unexpected');
    assert.equal(sanitizedTest.results[0].status, 'failed');
    assert.deepEqual(sanitizedTest.results[0].attachments, []);
    assert.equal(Object.hasOwn(sanitizedTest.results[0].errors[0], 'errorContext'), false);

    const summary = JSON.parse(await readFile(join(fixture.runtimeDir, 'reports', 'failure-summary.json'), 'utf8'));
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.stats, fixture.report.stats);
    assert.match(summary.failures[0].title, /four secret ingress paths.*fails safely/u);
    assert.equal(summary.failures[0].file, '70-browser/browser.live.spec.ts');
    assert.equal(summary.failures[0].line, 387);
    assert.equal(summary.failures[0].column, 9);
    assert.equal(summary.failures[0].status, 'unexpected');
    assert.match(summary.failures[0].errors[0].stack, /browser\.live\.spec\.ts:387:9/u);
    assert.deepEqual(await inspectPlaywrightArtifactPolicy(fixture.runtimeDir), []);

    await writePrivate(join(fixture.runtimeDir, 'reports', 'unknown-opaque.bin'), 'unmanaged attachment');
    assert.match(
      (await inspectPlaywrightArtifactPolicy(fixture.runtimeDir)).join('\n'),
      /outside the retained Playwright artifact allowlist/u,
    );
  } finally {
    await rm(fixture.runtimeDir, { recursive: true, force: true });
  }
});

test('normalization never disguises a passing report as failed or skipped', async () => {
  const fixture = await scenario({ passed: true });
  try {
    const result = await sanitizePlaywrightArtifacts(fixture.runtimeDir);
    assert.equal(result.reportOutcome, 'passed');
    const report = JSON.parse(await readFile(join(fixture.runtimeDir, 'reports', 'playwright.json'), 'utf8'));
    assert.deepEqual(report.stats, fixture.report.stats);
    assert.equal(report.suites[0].specs[0].tests[0].status, 'expected');
    assert.equal(report.suites[0].specs[0].tests[0].results[0].status, 'passed');
    assert.equal((await walk(join(fixture.runtimeDir, 'reports')))
      .some((path) => path.endsWith('failure-summary.json')), false);
    assert.deepEqual(await inspectPlaywrightArtifactPolicy(fixture.runtimeDir), []);
  } finally {
    await rm(fixture.runtimeDir, { recursive: true, force: true });
  }
});

test('retained Playwright policy refuses an oversized file before parsing it', async () => {
  const fixture = await scenario({ passed: true });
  try {
    await sanitizePlaywrightArtifacts(fixture.runtimeDir);
    await writePrivate(
      join(fixture.runtimeDir, 'reports', 'playwright.json'),
      'x'.repeat(MAX_RETAINED_ARTIFACT_BYTES + 1),
    );
    assert.match(
      (await inspectPlaywrightArtifactPolicy(fixture.runtimeDir)).join('\n'),
      /exceeds the .*byte read bound/u,
    );
  } finally {
    await rm(fixture.runtimeDir, { recursive: true, force: true });
  }
});

test('production config and runner pin fail-fast secret-safe Playwright settings', async () => {
  const e2eRoot = resolve(import.meta.dirname, '..');
  const config = await readFile(join(e2eRoot, 'playwright.config.ts'), 'utf8');
  const runner = await readFile(join(e2eRoot, 'orchestrator', 'run.sh'), 'utf8');
  const diagnose = await readFile(join(e2eRoot, 'orchestrator', 'diagnose.sh'), 'utf8');
  const audit = await readFile(join(e2eRoot, 'orchestrator', 'audit-artifacts.mjs'), 'utf8');
  const faultControl = await readFile(join(e2eRoot, 'orchestrator', 'fault-control.mjs'), 'utf8');
  const safeLauncher = await readFile(join(e2eRoot, 'orchestrator', 'run-playwright-safe.sh'), 'utf8');
  assert.match(config, /maxFailures:\s*1/u);
  assert.match(config, /trace:\s*'off'/u);
  assert.match(config, /screenshot:\s*'off'/u);
  assert.match(config, /video:\s*'off'/u);
  assert.doesNotMatch(config, /\['html'/u);
  assert.doesNotMatch(config, /\['list'/u);
  assert.match(config, /secret-safe-reporter\.ts/u);
  assert.match(runner, /run-playwright-safe\.sh"[\s\\]+pnpm/u);
  assert.match(safeLauncher, /unset PW_TEST_REPORTER/u);
  assert.match(safeLauncher, /unset PW_TEST_DEBUG_REPORTERS/u);
  assert.match(safeLauncher, /unset PW_RUNNER_DEBUG/u);
  assert.match(safeLauncher, /unset DEBUG/u);
  for (const name of [
    'PLAYWRIGHT_JSON_OUTPUT_FILE',
    'PLAYWRIGHT_JSON_OUTPUT_DIR',
    'PLAYWRIGHT_JSON_OUTPUT_NAME',
    'PLAYWRIGHT_JUNIT_OUTPUT_FILE',
    'PLAYWRIGHT_JUNIT_OUTPUT_DIR',
    'PLAYWRIGHT_JUNIT_OUTPUT_NAME',
    'PLAYWRIGHT_JUNIT_STRIP_ANSI',
    'PLAYWRIGHT_JUNIT_INCLUDE_PROJECT_IN_TEST_NAME',
    'PLAYWRIGHT_JUNIT_INCLUDE_RETRIES',
    'PLAYWRIGHT_JUNIT_SUITE_ID',
    'PLAYWRIGHT_JUNIT_SUITE_NAME',
  ]) {
    assert.match(safeLauncher, new RegExp(`unset ${name}\\b`, 'u'));
  }
  assert.match(safeLauncher, /export PLAYWRIGHT_NO_COPY_PROMPT=1/u);
  assert.match(diagnose, /docker_compose_for_run logs --no-color 2>&1/u);
  assert.doesNotMatch(diagnose, /docker_compose_for_run logs[^\n]*--tail/u);
  assert.match(
    diagnose,
    /journalctl --no-pager\s*\\\s*-u nyabase-agent\.service -u nyabase-docker\.service 2>&1/u,
  );
  assert.doesNotMatch(diagnose, /journalctl[^\n]*(?:\s-n\s|--lines)/u);
  assert.match(diagnose, /timeout --signal=TERM --kill-after=5s 30s/u);
  assert.match(diagnose, /capture-diagnostic\.mjs/u);
  assert.doesNotMatch(diagnose, /\|\s*sed\b/u);
  assert.match(audit, /MAX_RETAINED_ARTIFACT_BYTES/u);
  assert.match(audit, /info\.size > MAX_RETAINED_ARTIFACT_BYTES/u);
  assert.equal(
    (faultControl.match(/--pre-report/gu) ?? []).length,
    1,
    'only the fixed live provider path may select pre-report audit mode',
  );
  assert.equal(
    (runner.match(/--pre-report/gu) ?? []).length,
    0,
    'runner success and failure paths must always execute the final retained-set audit',
  );
  const finishSource = runner.slice(runner.indexOf('finish() {'), runner.indexOf('\ntrap finish EXIT'));
  const diagnoseIndex = finishSource.indexOf('diagnose.sh');
  const sanitizeIndex = finishSource.indexOf('sanitize-playwright-artifacts.mjs');
  const auditIndex = finishSource.indexOf('audit-artifacts.mjs');
  const downIndex = finishSource.indexOf('down.sh');
  assert.ok(
    diagnoseIndex > 0
      && diagnoseIndex < sanitizeIndex
      && sanitizeIndex < auditIndex
      && auditIndex < downIndex,
    'failure lifecycle must be diagnose -> sanitize -> audit -> scoped teardown',
  );
  assert.match(finishSource, /sanitize-playwright-artifacts\.mjs[\s\S]*\|\| normalization_status=\$\?/u);
  assert.match(finishSource, /audit-artifacts\.mjs[\s\S]*\|\| audit_status=\$\?/u);
  assert.match(
    finishSource,
    /if \(\(normalization_status != 0\)\); then[\s\S]*artifacts_safe=false/u,
    'a sanitizer failure must force fail-closed artifact handling',
  );
  assert.match(
    finishSource,
    /if \(\(audit_status != 0\)\); then[\s\S]*artifacts_safe=false/u,
    'an audit failure must force fail-closed artifact handling',
  );
  const unsafePurgeIndex = finishSource.indexOf('rm -rf "$runtime_dir"');
  const cleanupPrecedenceIndex = finishSource.indexOf('exit "$fallback_cleanup_status"');
  const incomingExitIndex = finishSource.indexOf('exit "$incoming"');
  assert.ok(
    unsafePurgeIndex > downIndex
      && cleanupPrecedenceIndex > unsafePurgeIndex
      && incomingExitIndex > cleanupPrecedenceIndex,
    'unsafe purge must follow scoped teardown and cleanup failure must retain exit precedence',
  );
  const testFailureIndex = runner.indexOf('if ((test_status != 0))');
  const successSanitizeIndex = runner.indexOf('sanitize-playwright-artifacts.mjs', runner.indexOf('set -e', runner.indexOf('test_status=$?')));
  const healthIndex = runner.indexOf('health.sh', successSanitizeIndex);
  assert.ok(
    successSanitizeIndex > testFailureIndex && healthIndex > successSanitizeIndex,
    'success normalization must run only after test PASS and before live success probes',
  );
});
