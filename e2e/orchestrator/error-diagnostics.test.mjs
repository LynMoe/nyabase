import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  aggregateErrorWithDiagnostics,
  formatErrorDiagnostics,
  runCleanupStepsPreservingPrimary,
  sanitizeDiagnosticText,
} from '../support/error-diagnostics.mjs';

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('nested aggregate and cause leaves are visible in the top-level diagnostic', () => {
  const leaf = new Error('exact cleanup leaf');
  const nested = new AggregateError(
    [new Error('setup leaf'), new Error('wrapper', { cause: leaf })],
    'nested failure',
  );
  const result = aggregateErrorWithDiagnostics('setup and cleanup failed', [nested]);
  assert.match(result.message, /setup leaf/);
  assert.match(result.message, /exact cleanup leaf/);
  assert.match(result.message, /errors\[1\]\.cause/);
  assert.deepEqual(result.errors, [nested]);
  const topLevel = formatErrorDiagnostics(result);
  assert.equal(topLevel.split('setup leaf').length - 1, 1);
  assert.equal(topLevel.split('exact cleanup leaf').length - 1, 1);
});

test('diagnostics redact credentials, ANSI, controls, and private keys', () => {
  const text = sanitizeDiagnosticText(
    '\u001b[31mBearer abc.def.ghi\u001b[0m agentToken="012345-secret" password=hunter2\u0000 ' +
      'https://alice:supersecret@example.test ' +
      '-----BEGIN TEST PRIVATE KEY-----private-material-----END TEST PRIVATE KEY-----',
    2_000,
  );
  for (const secret of [
    'abc.def.ghi',
    '012345-secret',
    'hunter2',
    'supersecret',
    'private-material',
  ]) {
    assert.equal(text.includes(secret), false);
  }
  assert.match(text, /REDACTED/);
  assert.equal(text.includes('\u001b'), false);
  assert.equal(text.includes('\u0000'), false);
});

test('cyclic and oversized chains stay bounded', () => {
  const cyclic = new Error('x'.repeat(4_000));
  cyclic.cause = cyclic;
  const text = formatErrorDiagnostics(cyclic, {
    maxEntryChars: 120,
    maxTotalChars: 220,
  });
  assert.ok(text.length <= 220);
  assert.match(text, /truncated/);
  assert.match(text, /cycle/);
});

test('cleanup runner preserves primary-only, cleanup-only, and combined failures', async () => {
  const primary = new Error('primary failure');
  const cleanup = new Error('cleanup failure');

  await assert.rejects(
    runCleanupStepsPreservingPrimary('cleanup', [async () => {}], { error: primary }),
    (error) => error === primary,
  );
  await assert.rejects(
    runCleanupStepsPreservingPrimary('cleanup', [async () => { throw cleanup; }]),
    (error) => error === cleanup,
  );
  await assert.rejects(
    runCleanupStepsPreservingPrimary(
      'cleanup',
      [async () => { throw cleanup; }],
      { error: primary },
    ),
    (error) => error instanceof AggregateError
      && error.errors[0] === primary
      && error.errors[1] === cleanup,
  );
});

test('cleanup runner does not swallow a primary throw of undefined', async () => {
  let rejected = false;
  try {
    await runCleanupStepsPreservingPrimary('cleanup', [async () => {}], { error: undefined });
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
});

test('cleanup runner preserves a falsey primary, aggregates timeout, and attempts later cleanup', async () => {
  const timeout = Object.assign(new Error('cleanup command timed out'), {
    code: null,
    killed: true,
    signal: 'SIGTERM',
  });
  let laterCleanupAttempts = 0;
  let rejection;
  try {
    await runCleanupStepsPreservingPrimary(
      'network L2 cleanup',
      [
        async () => {
          throw timeout;
        },
        async () => {
          laterCleanupAttempts += 1;
        },
      ],
      { error: undefined },
    );
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection instanceof AggregateError);
  assert.equal(rejection.errors.length, 2);
  assert.equal(rejection.errors[0]?.message, 'undefined');
  assert.equal(rejection.errors[1], timeout);
  assert.equal(laterCleanupAttempts, 1);
});

test('entrypoint failures exit nonzero with only bounded redacted diagnostics', () => {
  const helperUrl = pathToFileURL(resolve(e2eRoot, 'support/error-diagnostics.mjs')).href;
  const aggregateConstructor = ['new', 'AggregateError'].join(' ');
  const source = `
    import { runEntrypointWithDiagnostics } from ${JSON.stringify(helperUrl)};
    await runEntrypointWithDiagnostics(async () => {
      throw ${aggregateConstructor}(
        [new Error('password=hunter2 ' + 'x'.repeat(6_000))],
        'Bearer raw.entrypoint.token',
      );
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.length <= 3_001);
  assert.match(result.stderr, /^root AggregateError: Bearer \[REDACTED\]/u);
  assert.match(result.stderr, /root\.errors\[0\] Error:/u);
  assert.equal(result.stderr.includes('hunter2'), false);
  assert.equal(result.stderr.includes('raw.entrypoint.token'), false);
  assert.equal(result.stderr.includes('AggregateError ['), false);
  assert.equal(result.stderr.includes('file://'), false);
});

test('runtime E2E sources use reporter-safe aggregate diagnostics', () => {
  const pending = [e2eRoot];
  const occurrences = [];
  const nativeAggregateNeedle = ['new', 'AggregateError('].join(' ');
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        ['.runtime', 'node_modules', 'test-results'].includes(entry.name)
      ) {
        continue;
      }
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name)) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/\bnew\s+AggregateError\s*\(/gu)) {
        occurrences.push({
          path: relative(e2eRoot, path).replaceAll('\\', '/'),
          offset: match.index,
        });
      }
    }
  }

  assert.deepEqual(
    occurrences.sort(
      (left, right) => left.path.localeCompare(right.path) || left.offset - right.offset,
    ),
    [
      {
        path: 'orchestrator/error-diagnostics.test.mjs',
        offset: readFileSync(fileURLToPath(import.meta.url), 'utf8').indexOf(nativeAggregateNeedle),
      },
      {
        path: 'support/error-diagnostics.mjs',
        offset: readFileSync(resolve(e2eRoot, 'support/error-diagnostics.mjs'), 'utf8').indexOf(
          nativeAggregateNeedle,
        ),
      },
    ],
  );
});
