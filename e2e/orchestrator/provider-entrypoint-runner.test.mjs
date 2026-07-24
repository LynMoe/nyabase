import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  runContainerSshProviderEntrypoint,
  runRecoveryFaultProviderEntrypoint,
  runTopologyFaultProviderEntrypoint,
} from '../support/provider-entrypoint-runner.mjs';

const diagnosticsUrl = pathToFileURL(
  resolve(import.meta.dirname, '..', 'support', 'error-diagnostics.mjs'),
).href;
const runners = [
  ['container SSH', runContainerSshProviderEntrypoint],
  ['topology fault', runTopologyFaultProviderEntrypoint],
  ['recovery fault', runRecoveryFaultProviderEntrypoint],
];

async function fixture(t, name, body) {
  const directory = await mkdtemp(resolve(tmpdir(), 'nyabase-provider-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = resolve(directory, `${name}.mjs`);
  await writeFile(
    entrypoint,
    `
      import {
        aggregateErrorWithDiagnostics,
        runEntrypointWithDiagnostics,
      } from ${JSON.stringify(diagnosticsUrl)};

      let inputText = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) inputText += chunk;
      const input = JSON.parse(inputText);
      await runEntrypointWithDiagnostics(async () => {
        ${body}
      });
    `,
    { encoding: 'utf8', mode: 0o600 },
  );
  return { directory, entrypoint };
}

async function rejectionMessage(promise) {
  let rejection;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection instanceof Error, 'provider runner must reject with an Error');
  return rejection.message;
}

function assertSafeOuterDiagnostic(message, markers, secrets) {
  assert.ok(message.length <= 3_200, `outer diagnostic was not bounded: ${message.length}`);
  for (const marker of markers) {
    assert.equal(
      message.split(marker).length - 1,
      1,
      `expected exactly one visible diagnostic leaf for ${marker}`,
    );
  }
  for (const secret of secrets) assert.equal(message.includes(secret), false);
  assert.equal(message.includes('[errors]'), false);
  assert.equal(message.includes('AggregateError ['), false);
  assert.equal(message.includes('file://'), false);
}

test('provider runners preserve successful JSON stdout', async (t) => {
  const { directory, entrypoint } = await fixture(
    t,
    'success',
    `console.log(JSON.stringify({ schemaVersion: 1, marker: input.marker }));`,
  );

  for (const [name, run] of runners) {
    const stdout = await run(entrypoint, directory, { marker: `${name}-success` });
    assert.deepEqual(JSON.parse(stdout), {
      schemaVersion: 1,
      marker: `${name}-success`,
    });
  }
});

test('container SSH runner exposes both safe leaves without private key material', async (t) => {
  const privateKey = 'PRIVATE_KEY_SENTINEL_28D';
  const { directory, entrypoint } = await fixture(
    t,
    'ssh-failure',
    `
      throw aggregateErrorWithDiagnostics(
        \`container SSH fixture failed privateKey=\${input.privateKey}\`,
        [new Error('ssh-child-one-28d'), new Error('ssh-child-two-28d')],
      );
    `,
  );
  const message = await rejectionMessage(
    runContainerSshProviderEntrypoint(entrypoint, directory, { privateKey }),
  );

  assertSafeOuterDiagnostic(message, ['ssh-child-one-28d', 'ssh-child-two-28d'], [privateKey]);
});

test('topology fault runner preserves a nested leaf while redacting credentials', async (t) => {
  const password = 'FAULT_PASSWORD_SENTINEL_28D';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjeWNsZTI4ZCJ9.signature28d';
  const { directory, entrypoint } = await fixture(
    t,
    'fault-failure',
    `
      throw aggregateErrorWithDiagnostics(
        \`fault fixture failed password=\${input.password} Bearer \${input.jwt}\`,
        [new Error('fault-parent-28d', { cause: new Error('fault-nested-28d') })],
      );
    `,
  );
  const message = await rejectionMessage(
    runTopologyFaultProviderEntrypoint(entrypoint, directory, { password, jwt }),
  );

  assertSafeOuterDiagnostic(message, ['fault-nested-28d'], [password, jwt]);
});

test('recovery fault runner exposes a safe leaf without credential material', async (t) => {
  const credential = 'RECOVERY_SECRET_SENTINEL_28D';
  const { directory, entrypoint } = await fixture(
    t,
    'recovery-failure',
    `throw new Error(\`recovery-marker-28d secret=\${input.credential}\`);`,
  );
  const message = await rejectionMessage(
    runRecoveryFaultProviderEntrypoint(entrypoint, directory, { credential }),
  );

  assertSafeOuterDiagnostic(message, ['recovery-marker-28d'], [credential]);
});

test('all provider runners reject hostile diagnostic volume generically', async (t) => {
  const { directory, entrypoint } = await fixture(
    t,
    'hostile-stderr',
    `process.stderr.write('HOSTILE_DIAGNOSTIC_28D'.repeat(512));`,
  );

  for (const [, run] of runners) {
    const message = await rejectionMessage(run(entrypoint, directory, {}));
    assert.match(message, /diagnostic output limit/iu);
    assert.equal(message.includes('HOSTILE_DIAGNOSTIC_28D'), false);
    assert.ok(message.length <= 200);
  }
});
