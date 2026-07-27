import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { compareContainerInventory } from './resource-inventory.mjs';
import { cleanupProbeContainer, settleSshProbeOutcome } from './container-ssh-client.mjs';
import { cleanupFixtureContainer, settleFixtureContainerOutcome } from './fixture-evidence.mjs';
import { validateCleanedManifest, validatePreDownManifest } from './coverage-evidence.mjs';
import { validateFullRunManifest } from './full-run-chain.mjs';
import { manifestSchemaVersion } from './manifest-contract.mjs';
import { validateReleaseRunManifest } from './release-proof.mjs';
import { e2eStateKeys } from './run-state-contract.mjs';
import {
  composeProcessEnvironment,
  matchesExpectedContainerComponent,
} from './fault-control.mjs';

const orchestratorDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(orchestratorDir, '..', '..');
const commonPath = join(orchestratorDir, 'common.sh');
const manifestPath = join(orchestratorDir, 'manifest.mjs');
const downPath = join(orchestratorDir, 'down.sh');
const faultControlPath = join(orchestratorDir, 'fault-control.mjs');
const sanitizerPath = join(orchestratorDir, 'sanitize-playwright-artifacts.mjs');
const releaseRunnerPath = join(orchestratorDir, 'run-full-release.sh');

function parseSimpleEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function runBash(script, args = []) {
  return execFileSync('bash', ['-c', script, 'bash', ...args], { encoding: 'utf8' }).trim();
}

test('run-owned Compose containers may omit the optional component label', () => {
  assert.equal(matchesExpectedContainerComponent({}, undefined), true);
  assert.equal(
    matchesExpectedContainerComponent(
      { 'io.nyabase.e2e.component': 'provider-fault-split-gateway' },
      'provider-fault-split-gateway',
    ),
    true,
  );
  assert.equal(
    matchesExpectedContainerComponent(
      { 'io.nyabase.e2e.component': 'unexpected-component' },
      'provider-fault-split-gateway',
    ),
    false,
  );
});

function createManifestRuntime(prefix, runId) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const runtimeDir = join(root, runId);
  mkdirSync(runtimeDir, { mode: 0o700 });
  return { root, runtimeDir };
}

function runStubbedRelease({ verifyStatus, fullAStatus, fullBStatus, recoveryStatus }) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'nyabase-release-candidate-gate-'));
  const fixtureOrchestrator = join(fixtureRoot, 'e2e', 'orchestrator');
  const callLog = join(fixtureRoot, 'calls.log');
  mkdirSync(fixtureOrchestrator, { recursive: true, mode: 0o700 });
  writeFileSync(join(fixtureOrchestrator, 'run-full-release.sh'), readFileSync(releaseRunnerPath), {
    mode: 0o700,
  });
  writeFileSync(
    join(fixtureOrchestrator, 'common.sh'),
    [
      'E2E_ROOT="${TEST_FAKE_ROOT:?}"',
      'E2E_RUNTIME_BASE="$E2E_ROOT/e2e/.runtime"',
      'validate_run_id() { :; }',
      'runtime_dir_for() { printf "%s/%s\\n" "$E2E_RUNTIME_BASE" "$1"; }',
      'run_full_chain() { node "$E2E_ROOT/e2e/orchestrator/full-run-chain.mjs" "$@"; }',
      'die() { printf "ERROR: %s\\n" "$*" >&2; exit 1; }',
      'log() { :; }',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    join(fixtureOrchestrator, 'run.sh'),
    [
      '#!/usr/bin/env bash',
      'printf "run:%s:%s\\n" "$1" "$2" >> "${TEST_CALL_LOG:?}"',
      'if [[ -n "${3:-}" || -n "${4:-}" ]]; then',
      '  printf "expected:%s:%s\\n" "${3:-}" "${4:-}" >> "${TEST_CALL_LOG:?}"',
      'fi',
      `case "$2" in *-a) exit ${fullAStatus};; *-b) exit ${fullBStatus};; *-recovery) exit ${recoveryStatus};; esac`,
      'exit 99',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  writeFileSync(
    join(fixtureOrchestrator, 'full-run-chain.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      'const [command] = process.argv.slice(2);',
      "if (command === 'invalidate') process.exit(0);",
      "if (command === 'verify-candidate') {",
      "  appendFileSync(process.env.TEST_CALL_LOG, 'verify-candidate\\n');",
      `  if (${verifyStatus} === 0) process.stdout.write('a'.repeat(64) + '\\n');`,
      `  process.exit(${verifyStatus});`,
      '}',
      'process.exit(24);',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    join(fixtureOrchestrator, 'release-proof.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.TEST_CALL_LOG, 'release-proof\\n');",
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  try {
    const result = spawnSync(
      'bash',
      [join(fixtureOrchestrator, 'run-full-release.sh'), 'candidate-gate'],
      {
        env: {
          ...process.env,
          TEST_FAKE_ROOT: fixtureRoot,
          TEST_CALL_LOG: callLog,
        },
        encoding: 'utf8',
      },
    );
    return {
      status: result.status,
      calls: readFileSync(callLog, 'utf8').trim().split('\n'),
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test('release refuses to start Full B when exit 75 has no verified candidate receipt', () => {
  const result = runStubbedRelease({
    verifyStatus: 23,
    fullAStatus: 75,
    fullBStatus: 0,
    recoveryStatus: 0,
  });
  assert.equal(result.status, 23);
  assert.deepEqual(result.calls, ['run:full:candidate-gate-a', 'verify-candidate']);
});

test('release proceeds only after the exact Full A candidate verifies', () => {
  const result = runStubbedRelease({
    verifyStatus: 0,
    fullAStatus: 75,
    fullBStatus: 0,
    recoveryStatus: 0,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [
    'run:full:candidate-gate-a',
    'verify-candidate',
    'run:full:candidate-gate-b',
    `expected:candidate-gate-a:${'a'.repeat(64)}`,
    'run:recovery:candidate-gate-recovery',
    'release-proof',
  ]);
});

test('every operational Full-chain transition is serialized and Full B carries the A receipt', () => {
  const common = readFileSync(commonPath, 'utf8');
  const runner = readFileSync(join(orchestratorDir, 'run.sh'), 'utf8');
  const release = readFileSync(releaseRunnerPath, 'utf8');
  assert.match(
    common,
    /run_full_chain\(\)[\s\S]*?flock --exclusive "\$E2E_RUNTIME_BASE"[\s\S]*?full-run-chain\.mjs/u,
  );
  assert.doesNotMatch(runner, /node .*full-run-chain\.mjs/u);
  assert.doesNotMatch(release, /node .*full-run-chain\.mjs/u);
  assert.match(
    runner,
    /run_full_chain begin "\$NYABASE_E2E_RUNTIME_DIR" "\$run_id"[\s\S]*?"\$expected_predecessor_run_id" "\$expected_predecessor_receipt_sha256"/u,
  );
  assert.match(
    release,
    /first_candidate_sha256="\$\([\s\S]*?run_full_chain verify-candidate[\s\S]*?run\.sh" full "\$second"[\s\S]*?"\$first" "\$first_candidate_sha256"/u,
  );
});

test('top-level runner owns failed-up diagnostics, artifact audit, and exact teardown', () => {
  const runner = readFileSync(join(orchestratorDir, 'run.sh'), 'utf8');
  const up = readFileSync(join(orchestratorDir, 'up.sh'), 'utf8');
  assert.match(
    runner,
    /NYABASE_E2E_PARENT_OWNS_CLEANUP=true[\s\\]*\n\s*"\$E2E_ROOT\/e2e\/orchestrator\/up\.sh" "\$run_id"/,
  );
  assert.match(
    up,
    /"\$\{NYABASE_E2E_PARENT_OWNS_CLEANUP:-false\}" != true[\s\S]*?diagnose\.sh[\s\S]*?down\.sh/,
  );
  assert.match(
    runner,
    /diagnose\.sh[\s\S]*?sanitize-playwright-artifacts\.mjs[\s\S]*?audit-artifacts\.mjs[\s\S]*?down\.sh/,
  );
});

test('real runtime-base flock serializes two concurrent Full-chain processes', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'nyabase-full-chain-flock-'));
  const fixtureOrchestrator = join(fixtureRoot, 'e2e', 'orchestrator');
  const logPath = join(fixtureRoot, 'flock.log');
  const barrierPath = join(fixtureRoot, 'first-started');
  mkdirSync(fixtureOrchestrator, { recursive: true, mode: 0o700 });
  mkdirSync(join(fixtureRoot, 'e2e', '.runtime'), { mode: 0o700 });
  writeFileSync(join(fixtureOrchestrator, 'common.sh'), readFileSync(commonPath), { mode: 0o600 });
  writeFileSync(
    join(fixtureOrchestrator, 'run-state.keys'),
    readFileSync(join(orchestratorDir, 'run-state.keys')),
    { mode: 0o600 },
  );
  writeFileSync(
    join(fixtureOrchestrator, 'full-run-chain.mjs'),
    [
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      'const label = process.argv[3];',
      'appendFileSync(process.env.TEST_FLOCK_LOG, `start:${label}\\n`);',
      "if (label === 'first') {",
      "  writeFileSync(process.env.TEST_FLOCK_BARRIER, 'started');",
      '  await new Promise((resolve) => setTimeout(resolve, 300));',
      '}',
      'appendFileSync(process.env.TEST_FLOCK_LOG, `end:${label}\\n`);',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  const environment = {
    ...process.env,
    TEST_FLOCK_LOG: logPath,
    TEST_FLOCK_BARRIER: barrierPath,
  };
  const invoke = (label) =>
    spawn(
      'bash',
      [
        '-c',
        'source "$1"; run_full_chain hold "$2"',
        'bash',
        join(fixtureOrchestrator, 'common.sh'),
        label,
      ],
      { env: environment, stdio: 'pipe' },
    );
  const exited = (child) =>
    new Promise((resolvePromise, rejectPromise) => {
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', rejectPromise);
      child.once('exit', (code, signal) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`flock child failed (${code ?? signal}): ${stderr}`));
      });
    });

  try {
    const first = invoke('first');
    for (let attempt = 0; attempt < 100 && !existsSync(barrierPath); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.equal(existsSync(barrierPath), true, 'first process did not reach its locked barrier');
    const second = invoke('second');
    await Promise.all([exited(first), exited(second)]);
    assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n'), [
      'start:first',
      'end:first',
      'start:second',
      'end:second',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function ownedSlotLocks(runId) {
  return readdirSync('/tmp')
    .filter((name) => /^nyabase-e2e-slot-(?:[0-9]|1[0-5])\.lock$/.test(name))
    .map((name) => join('/tmp', name))
    .filter((lock) => {
      try {
        return readFileSync(join(lock, 'run-id'), 'utf8').trim() === runId;
      } catch {
        return false;
      }
    });
}

function allSlotLocks() {
  return readdirSync('/tmp')
    .filter((name) => /^nyabase-e2e-slot-(?:[0-9]|1[0-5])\.lock$/.test(name))
    .sort();
}

function listen(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

function close(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

async function occupyCandidatePort(kind) {
  for (let slot = 0; slot < 15; slot += 1) {
    const lock = `/tmp/nyabase-e2e-slot-${slot}.lock`;
    if (existsSync(lock)) continue;
    const servers = [];
    try {
      servers.push(await listen(18443 + slot));
      servers.push(await listen(19443 + slot));
      servers.push(await listen(20443 + slot));
      const selectedIndex = {
        primary: 0,
        'rate-limit': 1,
        'split-gateway': 2,
      }[kind];
      for (const [index, server] of servers.entries()) {
        if (index !== selectedIndex) await close(server);
      }
      return { slot, server: servers[selectedIndex] };
    } catch {
      for (const server of servers) {
        if (server?.listening) await close(server);
      }
    }
  }
  throw new Error(`no candidate slot is available for ${kind} port regression`);
}

for (const kind of ['primary', 'rate-limit', 'split-gateway']) {
  test(`authoritative slot allocator rejects occupied ${kind} port and removes rejected lock`, async () => {
    const occupied = await occupyCandidatePort(kind);
    const runId = `slot-${kind.replace('-', '')}-${process.pid}-${randomBytes(2).toString('hex')}`;
    let selectedLock = '';
    try {
      const output = execFileSync(
        'bash',
        [
          '-c',
          [
            'source "$1"',
            'subnet_overlaps_existing() { return 1; }',
            'reserve_slot_for_run "$2"',
            'printf "%s %s\\n" "$RESERVED_SLOT" "$RESERVED_SLOT_LOCK"',
            'release_slot_lock "$2" "$RESERVED_SLOT_LOCK"',
          ].join('; '),
          'bash',
          commonPath,
          runId,
        ],
        { encoding: 'utf8' },
      ).trim();
      const [selectedSlot, lock] = output.split(' ');
      selectedLock = lock;
      assert.notEqual(Number(selectedSlot), occupied.slot);
      assert.equal(existsSync(`/tmp/nyabase-e2e-slot-${occupied.slot}.lock`), false);
      assert.equal(existsSync(selectedLock), false);
    } finally {
      await close(occupied.server);
      if (selectedLock && existsSync(selectedLock)) {
        execFileSync('bash', [
          '-c',
          'source "$1"; release_slot_lock "$2" "$3"',
          'bash',
          commonPath,
          runId,
          selectedLock,
        ]);
      }
    }
  });
}

test('container inventory comparison is bidirectional', () => {
  const resources = [
    { kind: 'network', name: 'run-network' },
    { kind: 'container', name: 'run-edge' },
    { kind: 'container', name: 'run-backend' },
  ];
  assert.deepEqual(compareContainerInventory(resources, ['run-backend', 'run-edge']), {
    ok: true,
    declared: ['run-backend', 'run-edge'],
    live: ['run-backend', 'run-edge'],
    undeclaredLive: [],
    declaredButAbsent: [],
  });
  assert.deepEqual(
    compareContainerInventory(resources, ['run-backend', 'run-edge', 'run-rate-limit-edge']),
    {
      ok: false,
      declared: ['run-backend', 'run-edge'],
      live: ['run-backend', 'run-edge', 'run-rate-limit-edge'],
      undeclaredLive: ['run-rate-limit-edge'],
      declaredButAbsent: [],
    },
  );
  assert.deepEqual(compareContainerInventory(resources, ['run-edge']).declaredButAbsent, [
    'run-backend',
  ]);
  assert.throws(
    () => compareContainerInventory(resources, ['run-edge', 'run-edge']),
    /duplicate or empty/,
  );
});

test('real manifest lifecycle keeps retired history out of active inventory', () => {
  const runId = `manifest-${process.pid}-${randomBytes(2).toString('hex')}`;
  const { root, runtimeDir } = createManifestRuntime('nyabase-manifest-lifecycle-', runId);
  const invoke = (...args) => execFileSync(process.execPath, [manifestPath, ...args]);
  try {
    invoke('init', runtimeDir, runId);
    invoke('resource', runtimeDir, runId, 'container', 'run-readiness');
    let manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(compareContainerInventory(manifest.resources, ['run-readiness']).ok, true);

    // A crash after recording but before exact removal/retirement stays visible.
    assert.deepEqual(compareContainerInventory(manifest.resources, []).declaredButAbsent, [
      'run-readiness',
    ]);
    assert.throws(
      () => invoke('retire', runtimeDir, 'foreign-run', 'container', 'run-readiness'),
      /Command failed/,
    );
    assert.throws(
      () => invoke('retire', runtimeDir, runId, 'container', 'unknown'),
      /Command failed/,
    );

    invoke('retire', runtimeDir, runId, 'container', 'run-readiness');
    manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.resources[0].active, false);
    assert.match(manifest.resources[0].retiredAt, /^\d{4}-\d{2}-\d{2}T/);
    const retiredAt = manifest.resources[0].retiredAt;
    invoke('retire', runtimeDir, runId, 'container', 'run-readiness');
    manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.resources[0].retiredAt, retiredAt);
    assert.deepEqual(compareContainerInventory(manifest.resources, []), {
      ok: true,
      declared: [],
      live: [],
      undeclaredLive: [],
      declaredButAbsent: [],
    });
    assert.deepEqual(
      compareContainerInventory(manifest.resources, ['run-undeclared']).undeclaredLive,
      ['run-undeclared'],
    );
    assert.throws(
      () =>
        compareContainerInventory(
          [
            { kind: 'container', name: 'duplicate', active: false },
            { kind: 'container', name: 'duplicate', active: true },
          ],
          [],
        ),
      /duplicate or empty/,
    );
    assert.throws(
      () => invoke('resource', runtimeDir, runId, 'container', 'run-readiness'),
      /Command failed/,
    );
    manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.resources[0].active, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real schema-2 manifest crosses coverage, Full-chain, and release-proof consumers', () => {
  const runId = `schema-consumers-${process.pid}-${randomBytes(2).toString('hex')}`;
  const { root, runtimeDir } = createManifestRuntime('nyabase-manifest-consumers-', runId);
  const invoke = (...args) => execFileSync(process.execPath, [manifestPath, ...args]);
  try {
    invoke('init', runtimeDir, runId);
    invoke('phase', runtimeDir, runId, 'tests_passed');
    let manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, manifestSchemaVersion);
    assert.equal(validatePreDownManifest(manifest, runId), manifest);
    assert.throws(
      () => validatePreDownManifest({ ...manifest, schemaVersion: 1 }, runId),
      /schemaVersion must be 2/,
    );
    assert.throws(
      () => validatePreDownManifest({ ...manifest, schemaVersion: 3 }, runId),
      /schemaVersion must be 2/,
    );

    invoke('cleanup', runtimeDir, runId, 'clean');
    manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    const evidenceCleanup = {
      checkedAt: manifest.cleanup.checkedAt,
      manifestSchemaVersion,
    };
    assert.equal(validateCleanedManifest(manifest, runId), manifest);
    assert.equal(validateFullRunManifest(manifest, runId, evidenceCleanup), manifest);
    assert.equal(validateReleaseRunManifest(manifest, runId, evidenceCleanup), manifest);
    assert.throws(
      () =>
        validateReleaseRunManifest(manifest, runId, {
          ...evidenceCleanup,
          manifestSchemaVersion: 1,
        }),
      /does not bind the current manifest schema/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every manifest mutation rejects a tampered embedded runId without writing', () => {
  const runId = `manifest-owner-${process.pid}-${randomBytes(2).toString('hex')}`;
  const { root, runtimeDir } = createManifestRuntime('nyabase-manifest-owner-', runId);
  const invoke = (...args) => execFileSync(process.execPath, [manifestPath, ...args]);
  const manifestFile = join(runtimeDir, 'manifest.json');
  try {
    invoke('init', runtimeDir, runId);
    invoke('resource', runtimeDir, runId, 'container', 'owned-container');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.runId = 'tampered-foreign-run';
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const tamperedBytes = readFileSync(manifestFile);
    const mutationAttempts = [
      ['phase', runtimeDir, runId, 'tests_passed'],
      ['resource', runtimeDir, runId, 'container', 'new-container'],
      ['retire', runtimeDir, runId, 'container', 'owned-container'],
      ['cleanup', runtimeDir, runId, 'clean'],
    ];
    for (const args of mutationAttempts) {
      assert.throws(() => invoke(...args), /Command failed/);
      assert.deepEqual(readFileSync(manifestFile), tamperedBytes);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two-run loader and Compose tampering cannot redirect shell mutation', () => {
  const runA = `load-bind-a-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runB = `load-bind-b-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeA = join(repoRoot, 'e2e', '.runtime', runA);
  const runtimeB = join(repoRoot, 'e2e', '.runtime', runB);
  const stateAPath = join(runtimeA, 'state.env');
  const stateBPath = join(runtimeB, 'state.env');
  const manifestAPath = join(runtimeA, 'manifest.json');
  const manifestBPath = join(runtimeB, 'manifest.json');
  const replaceValue = (text, key, value) =>
    text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  try {
    runBash(
      [
        'source "$1"',
        'subnet_overlaps_existing() { return 1; }',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$2"',
        'release_slot_lock "$2" "$NYABASE_E2E_SLOT_LOCK"',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$3"',
        'release_slot_lock "$3" "$NYABASE_E2E_SLOT_LOCK"',
      ].join('; '),
      [commonPath, runA, runB],
    );
    const stateA = readFileSync(stateAPath, 'utf8');
    const stateB = readFileSync(stateBPath, 'utf8');
    const manifestA = readFileSync(manifestAPath);
    const manifestB = readFileSync(manifestBPath);
    const assertNoMutation = () => {
      assert.deepEqual(readFileSync(manifestAPath), manifestA);
      assert.deepEqual(readFileSync(manifestBPath), manifestB);
      assert.deepEqual(ownedSlotLocks(runA), []);
      assert.deepEqual(ownedSlotLocks(runB), []);
    };

    let tamperedState = replaceValue(stateA, 'NYABASE_E2E_RUN_ID', runB);
    tamperedState = replaceValue(tamperedState, 'NYABASE_E2E_RUNTIME_DIR', runtimeB);
    writeFileSync(stateAPath, tamperedState, { mode: 0o600 });
    assert.throws(
      () =>
        runBash(
          ['source "$1"', 'load_run "$2"', 'manifest_phase cross-run-state-mutation'].join('; '),
          [commonPath, runA],
        ),
      /Command failed/,
    );
    assertNoMutation();

    writeFileSync(stateAPath, stateA, { mode: 0o600 });
    let compose = replaceValue(stateA, 'NYABASE_E2E_RUN_ID', runB);
    compose = replaceValue(compose, 'NYABASE_E2E_RUNTIME_DIR', runtimeB);
    writeFileSync(join(runtimeA, 'compose.env'), compose, { mode: 0o600 });
    assert.throws(
      () =>
        runBash(
          [
            'source "$1"',
            'load_run "$2"',
            'validate_compose_state',
            'manifest_phase cross-run-compose-mutation',
          ].join('; '),
          [commonPath, runA],
        ),
      /Command failed/,
    );
    assertNoMutation();

    compose = replaceValue(stateA, 'NYABASE_E2E_SUBNET', '172.31.255.0/24');
    compose = replaceValue(compose, 'NYABASE_E2E_EDGE_PORT', '65530');
    writeFileSync(join(runtimeA, 'compose.env'), compose, { mode: 0o600 });
    assert.throws(
      () =>
        runBash(
          [
            'source "$1"',
            'load_run "$2"',
            'validate_compose_state',
            'manifest_phase cross-run-compose-security-mutation',
          ].join('; '),
          [commonPath, runA],
        ),
      /Command failed/,
    );
    assertNoMutation();
    assert.notEqual(stateA, stateB);
  } finally {
    rmSync(runtimeA, { recursive: true, force: true });
    rmSync(runtimeB, { recursive: true, force: true });
    for (const lock of [...ownedSlotLocks(runA), ...ownedSlotLocks(runB)]) {
      rmSync(lock, { recursive: true, force: true });
    }
  }
});

test('hostile Compose host environment cannot override the run project', () => {
  const runId = `compose-bind-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  try {
    const output = execFileSync(
      'bash',
      [
        '-c',
        [
          'source "$1"',
          'subnet_overlaps_existing() { return 1; }',
          'export NYABASE_E2E_PROFILE=smoke',
          'initialize_run "$2"',
          'release_slot_lock "$2" "$NYABASE_E2E_SLOT_LOCK"',
          'install -m 0600 "$NYABASE_E2E_RUNTIME_DIR/state.env" "$NYABASE_E2E_RUNTIME_DIR/compose.env"',
          'docker_compose_for_run config --format json',
        ].join('; '),
        'bash',
        commonPath,
        runId,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPOSE_PROJECT_NAME: 'foreign-project-sentinel',
          COMPOSE_FILE: '/tmp/foreign-compose-file-does-not-exist',
          COMPOSE_ENV_FILES: '/tmp/foreign-compose-env-does-not-exist',
          COMPOSE_PROFILES: 'foreign-profile',
          COMPOSE_PATH_SEPARATOR: ';',
          NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS: '12345',
        },
      },
    );
    const config = JSON.parse(output);
    assert.equal(config.name, `nyabase-e2e-${runId}`);
    for (const role of ['api', 'gateway', 'worker']) {
      assert.equal(
        config.services[`backend-${role}`].environment.NYABASE_E2E_CLOCK_OFFSET_MS,
        '0',
      );
    }
    assert.deepEqual(ownedSlotLocks(runId), []);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const lock of ownedSlotLocks(runId)) rmSync(lock, { recursive: true, force: true });
  }
});

test('direct JS Compose environment cannot override validated state interpolation', () => {
  const runId = `js-compose-env-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  try {
    runBash(
      [
        'source "$1"',
        'subnet_overlaps_existing() { return 1; }',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$2"',
        'release_slot_lock "$2" "$NYABASE_E2E_SLOT_LOCK"',
        'install -m 0600 "$NYABASE_E2E_RUNTIME_DIR/state.env" "$NYABASE_E2E_RUNTIME_DIR/compose.env"',
      ].join('; '),
      [commonPath, runId],
    );
    const state = parseSimpleEnv(readFileSync(join(runtimeDir, 'state.env'), 'utf8'));
    const hostileState = Object.fromEntries(e2eStateKeys.map((key) => [key, `foreign-${key}`]));
    const environment = composeProcessEnvironment(
      { NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS: '691200000' },
      {
        ...process.env,
        ...hostileState,
        COMPOSE_PROJECT_NAME: 'foreign-compose-project',
        COMPOSE_PROFILES: 'foreign-profile',
        NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS: '12345',
      },
    );
    for (const key of e2eStateKeys) assert.equal(key in environment, false, key);
    assert.equal(environment.COMPOSE_PROJECT_NAME, undefined);
    assert.equal(environment.COMPOSE_PROFILES, undefined);
    assert.equal(environment.NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS, '691200000');
    const output = execFileSync(
      'docker',
      [
        'compose',
        '--project-name',
        state.NYABASE_E2E_PROJECT,
        '--env-file',
        join(runtimeDir, 'compose.env'),
        '-f',
        join(repoRoot, 'e2e', 'topology', 'docker-dind', 'compose.yaml'),
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8', env: environment },
    );
    const config = JSON.parse(output);
    assert.equal(config.name, state.NYABASE_E2E_PROJECT);
    for (const role of ['api', 'gateway', 'worker']) {
      const service = config.services[`backend-${role}`];
      assert.equal(service.image, state.NYABASE_E2E_BACKEND_IMAGE);
      assert.equal(
        service.networks.cluster.ipv4_address,
        state[`NYABASE_E2E_${role.toUpperCase()}_IP`],
      );
      assert.equal(service.environment.NYABASE_RUNTIME_ROLE, role);
      assert.equal(service.environment.DB_MIGRATIONS_RUN, 'true');
      assert.equal(service.environment.NYABASE_E2E_CLOCK_OFFSET_MS, '691200000');
    }
    assert.equal(config.networks.cluster.name, state.NYABASE_E2E_NETWORK);
    assert.equal(config.networks.cluster.ipam.config[0].subnet, state.NYABASE_E2E_SUBNET);
    assert.equal(config.networks.cluster.ipam.config[0].gateway, state.NYABASE_E2E_GATEWAY);
    assert.equal(
      config.volumes['postgres-data'].name,
      `${state.NYABASE_E2E_PREFIX}-postgres-data`,
    );
    assert.equal(config.services['backend-api'].labels['io.nyabase.e2e.run-id'], runId);
    assert.deepEqual(ownedSlotLocks(runId), []);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const lock of ownedSlotLocks(runId)) rmSync(lock, { recursive: true, force: true });
  }
});

test('production sanitizer rejects tampered state before deleting or rewriting artifacts', () => {
  const runId = `sanitize-bind-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  const statePath = join(runtimeDir, 'state.env');
  const reportsDir = join(runtimeDir, 'reports');
  const testResultsDir = join(runtimeDir, 'test-results');
  const artifactPaths = [
    join(reportsDir, 'playwright.json'),
    join(reportsDir, 'junit.xml'),
    join(reportsDir, 'html', 'sentinel.txt'),
    join(testResultsDir, 'sentinel.txt'),
  ];
  const invoke = (target = runtimeDir) =>
    execFileSync(process.execPath, [sanitizerPath, target], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  try {
    runBash(
      [
        'source "$1"',
        'subnet_overlaps_existing() { return 1; }',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$2"',
        'release_slot_lock "$2" "$NYABASE_E2E_SLOT_LOCK"',
      ].join('; '),
      [commonPath, runId],
    );
    mkdirSync(join(reportsDir, 'html'), { recursive: true, mode: 0o700 });
    mkdirSync(testResultsDir, { recursive: true, mode: 0o700 });
    for (const [index, path] of artifactPaths.entries()) {
      writeFileSync(path, `artifact-sentinel-${index}\n`, { mode: 0o600 });
    }
    const originalState = readFileSync(statePath, 'utf8');
    const artifactBytes = new Map(artifactPaths.map((path) => [path, readFileSync(path)]));
    const assertArtifactsUnchanged = () => {
      for (const [path, bytes] of artifactBytes) {
        assert.equal(existsSync(path), true, path);
        assert.deepEqual(readFileSync(path), bytes, path);
      }
      assert.deepEqual(ownedSlotLocks(runId), []);
    };
    const resetState = () => {
      rmSync(statePath, { recursive: true, force: true });
      writeFileSync(statePath, originalState, { mode: 0o600 });
      chmodSync(statePath, 0o600);
    };
    const replaceValue = (key, value) =>
      originalState.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
    const tamperedStates = [
      `${originalState}NYABASE_E2E_UNKNOWN=foreign\n`,
      originalState.replace(/^NYABASE_E2E_BACKEND_IMAGE=.*\n/m, ''),
      originalState.replace(/^NYABASE_E2E_BACKEND_IMAGE=.*$/m, (line) => `${line}\n${line}`),
      replaceValue('NYABASE_E2E_BACKEND_IMAGE', 'foreign/image:tag'),
      replaceValue('NYABASE_E2E_PROFILE', 'foreign-profile'),
    ];
    for (const tampered of tamperedStates) {
      resetState();
      writeFileSync(statePath, tampered);
      assert.throws(() => invoke(), /Command failed/);
      assertArtifactsUnchanged();
    }
    resetState();
    chmodSync(statePath, 0o644);
    assert.throws(() => invoke(), /Command failed/);
    assertArtifactsUnchanged();

    resetState();
    const stateTarget = join(runtimeDir, 'state-target.env');
    writeFileSync(stateTarget, originalState, { mode: 0o600 });
    rmSync(statePath);
    execFileSync('ln', ['-s', stateTarget, statePath]);
    assert.throws(() => invoke(), /Command failed/);
    assertArtifactsUnchanged();

    const outside = mkdtempSync(join(tmpdir(), 'sanitize-outside-'));
    try {
      const outsideSentinel = join(outside, 'sentinel.txt');
      writeFileSync(outsideSentinel, 'outside-sentinel\n', { mode: 0o600 });
      assert.throws(() => invoke(outside), /Command failed/);
      assert.equal(readFileSync(outsideSentinel, 'utf8'), 'outside-sentinel\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const lock of ownedSlotLocks(runId)) rmSync(lock, { recursive: true, force: true });
  }
});

test('source-first inventory binds every operational JS run-state consumer', () => {
  const sources = readdirSync(orchestratorDir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => [name, readFileSync(join(orchestratorDir, name), 'utf8')]);
  const candidates = sources
    .filter(([, source]) =>
      /state\.env|compose\.env|loadValidatedRunState|parseClosedRunState/.test(source),
    )
    .map(([name]) => name)
    .sort();
  assert.deepEqual(candidates, [
    'api-health.mjs',
    'audit-artifacts.mjs',
    'capture-diagnostic.mjs',
    'capture-probe-evidence.mjs',
    'capture-recovery-proof.mjs',
    'container-ssh-client.mjs',
    'coverage-evidence.mjs',
    'fault-control.mjs',
    'fixture-evidence.mjs',
    'independent-network-client.mjs',
    'network-l2-probe.mjs',
    'playwright-artifact-security.mjs',
    'proxy-client-control.mjs',
    'proxy-health.mjs',
    'register.mjs',
    'remote-storage-control.mjs',
    'run-state-contract.mjs',
    'sanitize-playwright-artifacts.mjs',
    'seed-full.mjs',
    'seed.mjs',
    'storage-fixture-control.mjs',
  ]);
  const allowedExceptions = new Set(['playwright-artifact-security.mjs', 'run-state-contract.mjs']);
  for (const [name, source] of sources.filter(([name]) => candidates.includes(name))) {
    if (allowedExceptions.has(name)) continue;
    assert.match(source, /run-state-contract\.mjs/, name);
    assert.match(source, /loadValidatedRunState|parseClosedRunState/, name);
  }
  const sanitizer = readFileSync(sanitizerPath, 'utf8');
  assert.match(
    sanitizer,
    /loadValidatedRunState\(runtimeDir\)[\s\S]*sanitizePlaywrightArtifacts\(runtimeDir\)/,
  );
  const helper = readFileSync(join(orchestratorDir, 'playwright-artifact-security.mjs'), 'utf8');
  assert.doesNotMatch(helper, /process\.argv/);
});

test('source-first audit binds every operational Compose invocation', () => {
  const sources = readdirSync(orchestratorDir)
    .filter(
      (name) => (name.endsWith('.sh') || name.endsWith('.mjs')) && !name.endsWith('.test.mjs'),
    )
    .map((name) => [name, readFileSync(join(orchestratorDir, name), 'utf8')]);
  const wrapperCallCounts = Object.fromEntries(
    sources
      .map(([name, source]) => [
        name,
        [...source.matchAll(/\bdocker_compose_for_run\s+(?!\(\))/g)].length,
      ])
      .filter(([, count]) => count > 0),
  );
  assert.deepEqual(wrapperCallCounts, {
    'diagnose.sh': 2,
    'down.sh': 1,
    'up.sh': 7,
  });

  const common = readFileSync(commonPath, 'utf8');
  assert.match(common, /docker_compose_for_run\(\)[\s\S]*validate_compose_state/);
  assert.match(common, /key\.startsWith|COMPOSE_\[A-Z0-9_\]/);
  assert.match(common, /docker compose[\s\S]*--project-name "\$NYABASE_E2E_PROJECT"/);
  assert.match(common, /--env-file "\$NYABASE_E2E_RUNTIME_DIR\/compose\.env"/);
  assert.match(common, /-f "\$E2E_COMPOSE_FILE"/);

  const fault = readFileSync(join(orchestratorDir, 'fault-control.mjs'), 'utf8');
  assert.equal([...fault.matchAll(/\n\s*'compose',/g)].length, 1);
  assert.match(
    fault,
    /'compose',[\s\S]*?'--project-name',[\s\S]*?context\.state\.NYABASE_E2E_PROJECT/,
  );
  assert.match(fault, /key\.startsWith\('COMPOSE_'\)[\s\S]*delete environment\[key\]/);
  assert.match(fault, /assertComposeEnv\(context\)[\s\S]*recordManifestResource/);
  assert.match(fault, /delete environment\.NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS/);

  const directShellCompose = sources
    .filter(([, source]) => /\bdocker compose\b/.test(source))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(directShellCompose, ['common.sh', 'doctor.sh']);
  const directJsCompose = sources
    .filter(([, source]) => /['"]compose['"]\s*,/.test(source))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(directJsCompose, ['fault-control.mjs']);
  assert.match(readFileSync(join(orchestratorDir, 'doctor.sh'), 'utf8'), /docker compose version/);
  assert.equal(Object.values(wrapperCallCounts).reduce((sum, count) => sum + count, 0) + 1, 11);
  assert.match(
    readFileSync(downPath, 'utf8'),
    /docker_compose_for_run down --volumes --remove-orphans/,
  );
});

test('Compose interpolation inventory is closed and shell owns the only non-state input', () => {
  const composeSource = readFileSync(
    join(repoRoot, 'e2e', 'topology', 'docker-dind', 'compose.yaml'),
    'utf8',
  );
  const interpolations = [
    ...new Set(
      [...composeSource.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}/g)].map((match) => match[1]),
    ),
  ].sort();
  assert.deepEqual(interpolations, [
    'NYABASE_E2E_API_IP',
    'NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS',
    'NYABASE_E2E_BACKEND_IMAGE',
    'NYABASE_E2E_EDGE_IP',
    'NYABASE_E2E_EDGE_PORT',
    'NYABASE_E2E_GATEWAY',
    'NYABASE_E2E_GATEWAY_IP',
    'NYABASE_E2E_NETWORK',
    'NYABASE_E2E_POSTGRES_IP',
    'NYABASE_E2E_PREFIX',
    'NYABASE_E2E_PROJECT',
    'NYABASE_E2E_RATE_LIMIT_EDGE_IP',
    'NYABASE_E2E_RATE_LIMIT_EDGE_PORT',
    'NYABASE_E2E_REDIS_IP',
    'NYABASE_E2E_REGISTRY_IP',
    'NYABASE_E2E_ROOT',
    'NYABASE_E2E_RUNTIME_DIR',
    'NYABASE_E2E_RUN_ID',
    'NYABASE_E2E_SUBNET',
    'NYABASE_E2E_VMAGENT_IP',
    'NYABASE_E2E_VM_IP',
    'NYABASE_E2E_WORKER_IP',
  ]);
  assert.deepEqual(
    interpolations.filter((key) => !e2eStateKeys.includes(key)),
    ['NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS'],
  );
  const common = readFileSync(commonPath, 'utf8');
  assert.match(common, /NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS=0[\s\S]*docker compose/);
});

test('fault Compose path rejects synchronized state and compose tampering before mutation', () => {
  const runId = `js-state-bind-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  const statePath = join(runtimeDir, 'state.env');
  const composePath = join(runtimeDir, 'compose.env');
  const manifestPathForRun = join(runtimeDir, 'manifest.json');
  const fakeBin = join(runtimeDir, 'fake-bin');
  const dockerMarker = join(runtimeDir, 'docker-observed');
  const replaceValue = (text, key, value) =>
    text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  const invokeFault = () =>
    execFileSync(process.execPath, [faultControlPath, runtimeDir], {
      input: `${JSON.stringify({ fault: 'backendClock', runId, action: 'advance' })}\n`,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  try {
    runBash(
      [
        'source "$1"',
        'subnet_overlaps_existing() { return 1; }',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$2"',
        'release_slot_lock "$2" "$NYABASE_E2E_SLOT_LOCK"',
      ].join('; '),
      [commonPath, runId],
    );
    const state = readFileSync(statePath, 'utf8');
    writeFileSync(composePath, state, { mode: 0o600 });
    mkdirSync(fakeBin, { mode: 0o700 });
    writeFileSync(
      join(fakeBin, 'docker'),
      `#!/bin/sh\n: > ${JSON.stringify(dockerMarker)}\nexit 99\n`,
      { mode: 0o700 },
    );
    const manifest = readFileSync(manifestPathForRun);
    const assertRejectedWithoutMutation = () => {
      assert.throws(invokeFault, /Command failed/);
      assert.deepEqual(readFileSync(manifestPathForRun), manifest);
      assert.equal(existsSync(dockerMarker), false);
      assert.deepEqual(ownedSlotLocks(runId), []);
    };
    const reset = () => {
      rmSync(composePath, { recursive: true, force: true });
      writeFileSync(statePath, state, { mode: 0o600 });
      chmodSync(statePath, 0o600);
      writeFileSync(composePath, state, { mode: 0o600 });
    };

    const synchronizedCases = [
      `${state}NYABASE_E2E_UNKNOWN=foreign\n`,
      state.replace(/^NYABASE_E2E_BACKEND_IMAGE=.*\n/m, ''),
      replaceValue(state, 'NYABASE_E2E_BACKEND_IMAGE', 'foreign/image:tag'),
      replaceValue(state, 'NYABASE_E2E_GATEWAY_IP', '172.31.255.18'),
      replaceValue(state, 'NYABASE_E2E_PROFILE', 'foreign-profile'),
      state.replace(/^NYABASE_E2E_BACKEND_IMAGE=.*$/m, (line) => `${line}\n${line}`),
    ];
    for (const tampered of synchronizedCases) {
      reset();
      writeFileSync(statePath, tampered, { mode: 0o600 });
      writeFileSync(composePath, tampered, { mode: 0o600 });
      assertRejectedWithoutMutation();
    }

    reset();
    chmodSync(statePath, 0o644);
    assertRejectedWithoutMutation();

    reset();
    rmSync(composePath);
    execFileSync('ln', ['-s', statePath, composePath]);
    assertRejectedWithoutMutation();
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const lock of ownedSlotLocks(runId)) rmSync(lock, { recursive: true, force: true });
  }
});

test('SSH temporary-container cleanup retires after absence, including primary failure', async () => {
  const runId = `ssh-retire-${process.pid}-${randomBytes(2).toString('hex')}`;
  const { root, runtimeDir } = createManifestRuntime('nyabase-ssh-retirement-', runId);
  const name = `nyabase-e2e-${runId}-container-ssh-client`;
  const context = { runId };
  const invoke = (...args) => execFileSync(process.execPath, [manifestPath, ...args]);
  const retire = async () => invoke('retire', runtimeDir, runId, 'container', name);
  try {
    invoke('init', runtimeDir, runId);
    invoke('resource', runtimeDir, runId, 'container', name);
    const primary = new Error('injected primary SSH failure');
    await assert.rejects(
      settleSshProbeOutcome({ error: primary }, () =>
        cleanupProbeContainer(context, name, {
          inspect: async () => null,
          retire,
        }),
      ),
      /injected primary SSH failure/,
    );
    let manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.resources[0].active, false);

    const failingName = `${name}-cleanup-failure`;
    invoke('resource', runtimeDir, runId, 'container', failingName);
    const ownedContainer = {
      Name: `/${failingName}`,
      Config: {
        Labels: {
          'io.nyabase.e2e.run-id': runId,
          'io.nyabase.e2e.managed': 'true',
          'io.nyabase.e2e.component': 'provider-container-ssh-client',
        },
      },
    };
    await assert.rejects(
      settleSshProbeOutcome({ error: primary }, () =>
        cleanupProbeContainer(context, failingName, {
          inspect: async () => ownedContainer,
          remove: async () => {
            throw new Error('injected forced cleanup failure');
          },
          retire: async () => invoke('retire', runtimeDir, runId, 'container', failingName),
        }),
      ),
      /SSH proof and provider cleanup failed/,
    );
    manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.resources.find((resource) => resource.name === failingName).active, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture proof containers retire only after exact absence proof', async () => {
  const runId = `fixture-retire-${process.pid}-${randomBytes(2).toString('hex')}`;
  const { root, runtimeDir } = createManifestRuntime('nyabase-fixture-retirement-', runId);
  const context = { runId, runtimeDir };
  const component = 'fixture-fresh-volume-proof';
  const invoke = (...args) => execFileSync(process.execPath, [manifestPath, ...args]);
  try {
    invoke('init', runtimeDir, runId);
    const name = `${runId}-proof`;
    invoke('resource', runtimeDir, runId, 'container', name);
    const primary = new Error('injected fixture proof failure');
    await assert.rejects(
      settleFixtureContainerOutcome({ error: primary }, () =>
        cleanupFixtureContainer(context, name, component, {
          inspect: async () => null,
          retire: async () => invoke('retire', runtimeDir, runId, 'container', name),
        }),
      ),
      /injected fixture proof failure/,
    );
    let manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.resources[0].active, false);

    const failingName = `${runId}-cleanup-failure`;
    invoke('resource', runtimeDir, runId, 'container', failingName);
    const ownedContainer = {
      Name: `/${failingName}`,
      Config: {
        Labels: {
          'io.nyabase.e2e.run-id': runId,
          'io.nyabase.e2e.managed': 'true',
          'io.nyabase.e2e.component': component,
        },
      },
    };
    await assert.rejects(
      settleFixtureContainerOutcome({ error: primary }, () =>
        cleanupFixtureContainer(context, failingName, component, {
          inspect: async () => ownedContainer,
          remove: async () => {
            throw new Error('injected forced cleanup failure');
          },
          retire: async () => invoke('retire', runtimeDir, runId, 'container', failingName),
        }),
      ),
      /fixture operation and provider cleanup failed/,
    );
    manifest = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.resources.find((resource) => resource.name === failingName).active, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider outcome settlement preserves every falsey thrown value', async () => {
  for (const thrown of [undefined, null, false, 0, '']) {
    await assert.rejects(
      settleSshProbeOutcome({ error: thrown }, async () => {}),
      (error) => error === thrown,
    );
    await assert.rejects(
      settleFixtureContainerOutcome({ error: thrown }, async () => {}),
      (error) => error === thrown,
    );
  }
});

test('live E2E primary, cleanup, and discovery failures use explicit presence state', () => {
  const sources = [
    'support/product-network.ts',
    'specs/10-auth-rbac/auth-rbac.live.spec.ts',
    'specs/10-auth-rbac/login-rate-limit.live.spec.ts',
    'specs/20-servers-images/servers-images-tasks.live.spec.ts',
    'specs/40-storage-quota/storage-quota.live.spec.ts',
    'specs/50-proxies-network/proxies-network.live.spec.ts',
    'specs/80-recovery-security/recovery-security.live.spec.ts',
    'orchestrator/network-l2-probe.mjs',
  ].map((path) => [path, readFileSync(join(repoRoot, 'e2e', path), 'utf8')]);

  for (const [path, source] of sources) {
    assert.doesNotMatch(
      source,
      /if\s*\(\s*(?:primary|cleanup|discovery)Error\s*(?:&&|\))/,
      `${path} truth-tests a captured thrown value`,
    );
    assert.doesNotMatch(
      source,
      /\.\.\.\(\s*discoveryError\s*\?/,
      `${path} truth-tests a discovery failure`,
    );
    assert.doesNotMatch(
      source,
      /primaryError\s*!==\s*undefined/,
      `${path} conflates throw undefined with no failure`,
    );
  }
});

test('network L2 cleanup attempts every target outside native finally', () => {
  const source = readFileSync(join(orchestratorDir, 'network-l2-probe.mjs'), 'utf8');
  assert.match(
    source,
    /runCleanupStepsPreservingPrimary\([\s\S]*cleanupTargets\.map\(/,
  );
  assert.doesNotMatch(source, /primaryFailure = \{ error \};\s*\}\s*finally\s*\{/);
  assert.match(source, /try\s*\{[\s\S]*nodeDockerResult\([\s\S]*catch \(error\)/);
});

test('source-first audit enumerates every outer container producer and lifecycle', () => {
  const storage = readFileSync(join(orchestratorDir, 'storage-up.sh'), 'utf8');
  assert.match(
    storage,
    /docker rm -f "\$client_name"[^\n]*\nmanifest_retire_resource container "\$client_name"/,
  );

  const faults = readFileSync(join(orchestratorDir, 'fault-control.mjs'), 'utf8');
  assert.match(
    faults,
    /recordManifestResource\('container', identity\.containerName, context\.runId\)/,
  );
  assert.match(faults, /docker\(\['rm', '-f', containerName\]\)/);
  assert.match(faults, /retireManifestResource\('container', containerName, context\.runId\)/);

  const sshClient = readFileSync(join(orchestratorDir, 'container-ssh-client.mjs'), 'utf8');
  assert.match(sshClient, /async function recordProbeContainer\(context, name\)/);
  assert.match(sshClient, /'manifest\.mjs'[\s\S]*?'resource'[\s\S]*?'container'/);
  assert.match(sshClient, /'run',[\s\S]*?'--rm'/);
  assert.match(sshClient, /\['rm', '--force', probeContainerName\]/);
  assert.match(sshClient, /await retire\(context, probeContainerName\)/);

  const sources = readdirSync(orchestratorDir)
    .filter(
      (name) => (name.endsWith('.sh') || name.endsWith('.mjs')) && !name.endsWith('.test.mjs'),
    )
    .map((name) => [name, readFileSync(join(orchestratorDir, name), 'utf8')]);
  const stripComments = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*#.*$/gm, '')
      .replace(/\/\/.*$/gm, '');
  const creationCandidates = sources
    .map(([name, source]) => [name, stripComments(source)])
    .filter(
      ([, source]) =>
        /\bdocker\s+run\b/.test(source) ||
        /['"]run['"]/.test(source) ||
        /\bdocker\s+compose\b[\s\S]*?\bcreate\b/.test(source) ||
        /\bdocker_compose_for_run\s+create\b/.test(source),
    );
  assert.deepEqual(creationCandidates.map(([name]) => name).sort(), [
    'build.sh',
    'container-ssh-client.mjs',
    'doctor.sh',
    'fault-control.mjs',
    'fixture-evidence.mjs',
    'network-l2-probe.mjs',
    'proxies-up.sh',
    'storage-up.sh',
    'up.sh',
  ]);

  const byName = new Map(creationCandidates);
  const count = (name, pattern) => [...byName.get(name).matchAll(pattern)].length;
  assert.deepEqual(
    {
      buildOuterAnonymousAutoRemove: count('build.sh', /\bdocker\s+run\b/g),
      doctorOuterExactScoped: count('doctor.sh', /\bdocker\s+run\b/g),
      storageOuter: count('storage-up.sh', /\bdocker\s+run\b/g),
      proxiesOuterPersistent: count('proxies-up.sh', /\bdocker\s+run\b/g),
      upOuterRunPersistent: count('up.sh', /\bdocker\s+run\b/g),
      upComposeCreatePersistent: count('up.sh', /\bdocker_compose_for_run\s+create\b/g),
      sshOuterTransient: count('container-ssh-client.mjs', /['"]run['"]/g),
      faultOuterTransient: count('fault-control.mjs', /['"]run['"]/g),
      fixtureOuterTransient: count('fixture-evidence.mjs', /['"]run['"]/g),
      managedDockerdInnerOnly: count('network-l2-probe.mjs', /['"]run['"]/g),
    },
    {
      buildOuterAnonymousAutoRemove: 1,
      doctorOuterExactScoped: 1,
      storageOuter: 3,
      proxiesOuterPersistent: 2,
      upOuterRunPersistent: 2,
      upComposeCreatePersistent: 1,
      sshOuterTransient: 1,
      faultOuterTransient: 3,
      fixtureOuterTransient: 1,
      managedDockerdInnerOnly: 1,
    },
  );

  const fixture = byName.get('fixture-evidence.mjs');
  assert.match(fixture, /recordFixtureContainer\(context, name\)/);
  assert.match(fixture, /cleanupFixtureContainer\(context, name, component\)/);
  assert.match(fixture, /invariant\(\(await inspect\(name\)\) === null/);
  assert.match(fixture, /await retire\(\)/);
  assert.match(fixture, /fixture-fresh-volume-proof/);
  assert.match(fixture, /-postgres-1/);
  assert.match(fixture, /system\.schema_migrations/);
  assert.match(fixture, /live-readonly-psql-catalog-query/);
  assert.match(byName.get('network-l2-probe.mjs'), /nodeDocker\([\s\S]*?['"]run['"]/);
  assert.match(byName.get('build.sh'), /docker run --rm/);
  assert.match(byName.get('doctor.sh'), /trap cleanup EXIT[\s\S]*docker run -d --name "\$probe"/);
  const down = readFileSync(downPath, 'utf8');
  assert.match(down, /label="io\.nyabase\.e2e\.run-id=\$run_id"/);
  assert.match(down, /docker rm -f "\$container_id"/);
});

test('stored run state reacquires its exact released slot lock', () => {
  const runId = `resume-ok-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  try {
    const output = runBash(
      [
        'source "$1"',
        'subnet_overlaps_existing() { return 1; }',
        'stored_subnet_is_available_for_run() { return 0; }',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$2"',
        'lock="$NYABASE_E2E_SLOT_LOCK"',
        'release_slot_lock "$2" "$lock"',
        'initialize_run "$2"',
        'printf "%s %s" "$NYABASE_E2E_SLOT_LOCK" "$(tr -d "\\n" < "$NYABASE_E2E_SLOT_LOCK/run-id")"',
        'release_slot_lock "$2" "$NYABASE_E2E_SLOT_LOCK"',
      ].join('; '),
      [commonPath, runId],
    );
    const [lock, owner] = output.split(' ');
    assert.equal(owner, runId);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const lock of ownedSlotLocks(runId)) rmSync(lock, { recursive: true, force: true });
  }
});

test('fresh slot owner partial-write failure removes every just-created marker and lock', () => {
  const runId = `fresh-marker-${process.pid}-${randomBytes(2).toString('hex')}`;
  const before = allSlotLocks();
  assert.throws(
    () =>
      runBash(
        [
          'source "$1"',
          'subnet_overlaps_existing() { return 1; }',
          'publish_slot_owner() { builtin printf "partial-owner" > "$2/run-id"; return 1; }',
          'reserve_slot_for_run "$2"',
        ].join('; '),
        [commonPath, runId],
      ),
    /Command failed/,
  );
  assert.deepEqual(allSlotLocks(), before);
});

test('resume slot owner partial-write failure removes its exact marker and lock', () => {
  const runId = `resume-marker-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  let lock = '';
  try {
    lock = runBash(
      [
        'source "$1"',
        'subnet_overlaps_existing() { return 1; }',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$2"',
        'printf "%s" "$NYABASE_E2E_SLOT_LOCK"',
        'release_slot_lock "$2" "$NYABASE_E2E_SLOT_LOCK"',
      ].join('; '),
      [commonPath, runId],
    );
    assert.throws(
      () =>
        runBash(
          [
            'source "$1"',
            'stored_subnet_is_available_for_run() { return 0; }',
            'publish_slot_owner() { builtin printf "partial-owner" > "$2/run-id"; return 1; }',
            'export NYABASE_E2E_PROFILE=smoke',
            'initialize_run "$2"',
          ].join('; '),
          [commonPath, runId],
        ),
      /Command failed/,
    );
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    if (lock && existsSync(lock)) rmSync(lock, { recursive: true, force: true });
  }
});

for (const portKind of ['primary', 'rate-limit', 'split-gateway']) {
  test(`stored run resume rejects a real occupied ${portKind} port and releases only its reacquired lock`, async () => {
    const runId = `resume-${portKind.replace('-', '')}-${process.pid}-${randomBytes(2).toString('hex')}`;
    const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
    let server;
    let lock = '';
    try {
      const portVariable = {
        primary: 'NYABASE_E2E_EDGE_PORT',
        'rate-limit': 'NYABASE_E2E_RATE_LIMIT_EDGE_PORT',
        'split-gateway': 'NYABASE_E2E_SPLIT_GATEWAY_EDGE_PORT',
      }[portKind];
      const output = runBash(
        [
          'source "$1"',
          'subnet_overlaps_existing() { return 1; }',
          'export NYABASE_E2E_PROFILE=smoke',
          'initialize_run "$2"',
          `printf "%s %s" "$${portVariable}" "$NYABASE_E2E_SLOT_LOCK"`,
          'release_slot_lock "$2" "$NYABASE_E2E_SLOT_LOCK"',
        ].join('; '),
        [commonPath, runId],
      );
      const [port, selectedLock] = output.split(' ');
      lock = selectedLock;
      server = await listen(Number(port));
      assert.throws(
        () =>
          runBash(
            [
              'source "$1"',
              'stored_subnet_is_available_for_run() { return 0; }',
              'export NYABASE_E2E_PROFILE=smoke',
              'initialize_run "$2"',
            ].join('; '),
            [commonPath, runId],
          ),
        /Command failed/,
      );
      assert.equal(existsSync(lock), false);
    } finally {
      if (server?.listening) await close(server);
      rmSync(runtimeDir, { recursive: true, force: true });
      for (const owned of ownedSlotLocks(runId)) rmSync(owned, { recursive: true, force: true });
    }
  });
}

test('stored run resume rejects a foreign overlapping subnet and releases its reacquired lock', () => {
  const suffix = `${process.pid}-${randomBytes(2).toString('hex')}`;
  const runId = `resume-subnet-${suffix}`;
  const foreignNetwork = `nyabase-e2e-resume-subnet-probe-${suffix}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  let lock = '';
  try {
    const output = runBash(
      [
        'source "$1"',
        'subnet_overlaps_existing() { return 1; }',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$2"',
        'printf "%s %s" "$NYABASE_E2E_SUBNET" "$NYABASE_E2E_SLOT_LOCK"',
        'release_slot_lock "$2" "$NYABASE_E2E_SLOT_LOCK"',
      ].join('; '),
      [commonPath, runId],
    );
    const [subnet, selectedLock] = output.split(' ');
    lock = selectedLock;
    execFileSync('docker', [
      'network',
      'create',
      '--subnet',
      subnet,
      '--label',
      'io.nyabase.e2e.run-id=foreign-owner',
      foreignNetwork,
    ]);
    assert.throws(
      () =>
        runBash(
          ['source "$1"', 'export NYABASE_E2E_PROFILE=smoke', 'initialize_run "$2"'].join('; '),
          [commonPath, runId],
        ),
      /Command failed/,
    );
    assert.equal(existsSync(lock), false);
    assert.doesNotThrow(() => execFileSync('docker', ['network', 'inspect', foreignNetwork]));
  } finally {
    try {
      execFileSync('docker', ['network', 'rm', foreignNetwork], { stdio: 'ignore' });
    } catch {
      // The exact test-owned network may not have been created.
    }
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const owned of ownedSlotLocks(runId)) rmSync(owned, { recursive: true, force: true });
  }
});

test('stored run resume rejects but never deletes a foreign-owned exact lock', () => {
  const runId = `resume-owner-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  let lock = '';
  try {
    lock = runBash(
      [
        'source "$1"',
        'subnet_overlaps_existing() { return 1; }',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$2"',
        'printf "%s" "$NYABASE_E2E_SLOT_LOCK"',
      ].join('; '),
      [commonPath, runId],
    );
    writeFileSync(join(lock, 'run-id'), 'foreign-owner\n');
    assert.throws(
      () =>
        runBash(
          [
            'source "$1"',
            'stored_subnet_is_available_for_run() { return 0; }',
            'export NYABASE_E2E_PROFILE=smoke',
            'initialize_run "$2"',
          ].join('; '),
          [commonPath, runId],
        ),
      /Command failed/,
    );
    assert.equal(readFileSync(join(lock, 'run-id'), 'utf8').trim(), 'foreign-owner');
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    if (lock && existsSync(lock)) rmSync(lock, { recursive: true, force: true });
  }
});

for (const ownership of ['missing', 'foreign']) {
  test(`down fails closed on ${ownership} slot-lock ownership and never certifies clean`, () => {
    const runId = `down-${ownership}-${process.pid}-${randomBytes(2).toString('hex')}`;
    const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
    let lock = '';
    try {
      lock = runBash(
        [
          'source "$1"',
          'subnet_overlaps_existing() { return 1; }',
          'export NYABASE_E2E_PROFILE=smoke',
          'initialize_run "$2"',
          'printf "%s" "$NYABASE_E2E_SLOT_LOCK"',
        ].join('; '),
        [commonPath, runId],
      );
      if (ownership === 'missing') {
        rmSync(lock, { recursive: true, force: true });
      } else {
        writeFileSync(join(lock, 'run-id'), 'foreign-owner\n');
      }
      assert.throws(
        () => execFileSync('bash', [downPath, runId, '--keep-runtime'], { stdio: 'pipe' }),
        /Command failed/,
      );
      const failed = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
      assert.equal(failed.phase, 'cleanup_failed');
      assert.equal(failed.cleanup.status, 'failed');
      assert.match(failed.cleanup.detail, /slot-lock-ownership/);
      assert.notEqual(failed.cleanup.status, 'clean');
      if (ownership === 'foreign') {
        assert.equal(readFileSync(join(lock, 'run-id'), 'utf8').trim(), 'foreign-owner');
      }

      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'run-id'), `${runId}\n`);
      execFileSync('bash', [downPath, runId, '--keep-runtime']);
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      if (lock && existsSync(lock)) rmSync(lock, { recursive: true, force: true });
    }
  });
}

test('cleaned retained runId is terminal and rejected before slot reacquisition', () => {
  const runId = `terminal-run-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  let lock = '';
  try {
    lock = runBash(
      [
        'source "$1"',
        'subnet_overlaps_existing() { return 1; }',
        'export NYABASE_E2E_PROFILE=smoke',
        'initialize_run "$2"',
        'printf "%s" "$NYABASE_E2E_SLOT_LOCK"',
      ].join('; '),
      [commonPath, runId],
    );
    execFileSync('bash', [downPath, runId, '--keep-runtime']);
    assert.equal(existsSync(lock), false);
    const cleaned = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(cleaned.phase, 'cleaned');
    assert.equal(cleaned.cleanup.status, 'clean');

    assert.throws(
      () =>
        runBash(
          [
            'source "$1"',
            'stored_subnet_is_available_for_run() { return 0; }',
            'export NYABASE_E2E_PROFILE=smoke',
            'initialize_run "$2"',
          ].join('; '),
          [commonPath, runId],
        ),
      /Command failed/,
    );
    assert.equal(existsSync(lock), false);
    const unchanged = JSON.parse(readFileSync(join(runtimeDir, 'manifest.json'), 'utf8'));
    assert.equal(unchanged.phase, 'cleaned');
    assert.equal(unchanged.cleanup.status, 'clean');
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    if (lock && existsSync(lock)) rmSync(lock, { recursive: true, force: true });
  }
});

test('new-run initialization failure rolls back its state, manifest, and reserved lock', () => {
  const runId = `init-rollback-${process.pid}-${randomBytes(2).toString('hex')}`;
  const runtimeDir = join(repoRoot, 'e2e', '.runtime', runId);
  try {
    assert.throws(
      () =>
        runBash(
          [
            'source "$1"',
            'subnet_overlaps_existing() { return 1; }',
            'node() { return 1; }',
            'export NYABASE_E2E_PROFILE=smoke',
            'initialize_run "$2"',
          ].join('; '),
          [commonPath, runId],
        ),
      /Command failed/,
    );
    assert.equal(existsSync(join(runtimeDir, 'state.env')), false);
    assert.equal(existsSync(join(runtimeDir, 'manifest.json')), false);
    assert.deepEqual(ownedSlotLocks(runId), []);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    for (const lock of ownedSlotLocks(runId)) rmSync(lock, { recursive: true, force: true });
  }
});

test('Compose manifest boundary covers every declared control-plane service', () => {
  const compose = readFileSync(join(repoRoot, 'e2e/topology/docker-dind/compose.yaml'), 'utf8');
  const servicesBlock = compose.slice(
    compose.indexOf('services:\n'),
    compose.indexOf('\nvolumes:\n'),
  );
  const services = [...servicesBlock.matchAll(/^  ([a-z0-9-]+):$/gm)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(services, [
    'backend-api',
    'backend-gateway',
    'backend-worker',
    'edge',
    'postgres',
    'rate-limit-edge',
    'redis',
    'registry',
    'victoriametrics',
    'vmagent',
  ]);

  const upScript = readFileSync(join(orchestratorDir, 'up.sh'), 'utf8');
  assert.match(upScript, /config --services/);
  assert.match(upScript, /ps -a --format '\{\{\.Name\}\}'/);
  assert.match(upScript, /manifest_resource container "\$compose_container"/);
  const inventoryScript = readFileSync(join(orchestratorDir, 'resource-inventory.mjs'), 'utf8');
  assert.match(inventoryScript, /docker',\s*\['inspect'/);
  assert.match(inventoryScript, /live container lacks exact current-run ownership/);
});

test('E2E access JWT outlives every declared per-test timeout', () => {
  const upScript = readFileSync(join(orchestratorDir, 'up.sh'), 'utf8');
  const jwtMatch = upScript.match(/jwtExpiresIn: (\d+)([mh])/);
  assert.ok(jwtMatch, 'up.sh must declare a bounded E2E access JWT lifetime');
  const jwtLifetimeMs = Number(jwtMatch[1]) * (jwtMatch[2] === 'h' ? 3_600_000 : 60_000);

  const specsRoot = join(repoRoot, 'e2e', 'specs');
  const pending = [specsRoot];
  let longestTestTimeoutMs = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/test\.setTimeout\(([\d_]+)\)/g)) {
        longestTestTimeoutMs = Math.max(longestTestTimeoutMs, Number(match[1].replaceAll('_', '')));
      }
    }
  }

  assert.ok(longestTestTimeoutMs > 0, 'E2E specs must declare focused long-test budgets');
  assert.ok(
    jwtLifetimeMs >= longestTestTimeoutMs + 300_000,
    `E2E JWT lifetime ${jwtLifetimeMs}ms must exceed longest test timeout ${longestTestTimeoutMs}ms by at least five minutes`,
  );
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('shared release pathspec binds root test deletion and .gitignore bytes', () => {
  const pathspecPath = join(orchestratorDir, 'release-source-pathspec.txt');
  const pathspecBytes = readFileSync(pathspecPath);
  const pathspec = pathspecBytes.toString('utf8').split('\n').filter(Boolean);
  assert.ok(pathspec.includes('test'));
  assert.ok(pathspec.includes('.gitignore'));

  const buildScript = readFileSync(join(orchestratorDir, 'build.sh'), 'utf8');
  const validateScript = readFileSync(join(repoRoot, 'e2e/coverage/validate.mjs'), 'utf8');
  assert.match(buildScript, /release-source-pathspec\.txt/);
  assert.match(validateScript, /release-source-pathspec\.txt/);
  assert.match(buildScript, /ROOT_TEST_PATH=ABSENT/);

  const fixture = mkdtempSync(join(tmpdir(), 'nyabase-release-pathspec-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: fixture });
    execFileSync('git', ['config', 'user.email', 'release-boundary@example.invalid'], {
      cwd: fixture,
    });
    execFileSync('git', ['config', 'user.name', 'Release Boundary Test'], { cwd: fixture });
    writeFileSync(join(fixture, '.gitignore'), 'dist/\n');
    mkdirSync(join(fixture, 'test'), { recursive: true });
    writeFileSync(join(fixture, 'test', 'legacy.txt'), 'retired\n');
    execFileSync('git', ['add', '.gitignore', 'test/legacy.txt'], { cwd: fixture });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: fixture });

    const digest = () =>
      sha256(
        execFileSync('git', ['diff', '--binary', 'HEAD', '--', ...pathspec], { cwd: fixture }),
      );
    const clean = digest();
    rmSync(join(fixture, 'test', 'legacy.txt'));
    const deletedRootTest = digest();
    assert.notEqual(deletedRootTest, clean);
    writeFileSync(join(fixture, 'test', 'legacy.txt'), 'retired\n');
    writeFileSync(join(fixture, '.gitignore'), 'dist/\ncoverage/\n');
    assert.notEqual(digest(), clean);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('standalone Agent build resolves and invokes an explicit Cargo binary', () => {
  const script = readFileSync(join(repoRoot, 'scripts/build-agent-binary.sh'), 'utf8');
  assert.match(script, /CARGO_BIN="\$\{CARGO:-\}"/);
  assert.match(script, /command -v cargo/);
  assert.match(script, /\$HOME\/\.cargo\/bin\/cargo/);
  assert.match(script, /"\$CARGO_BIN" build --release --target x86_64-unknown-linux-musl/);
  assert.doesNotMatch(script, /^(?:HOME|home|CODEX_HOME)=/m);
});

test('cross-process E2E diagnostics use one closed transport boundary', () => {
  const runnerPath = join(repoRoot, 'e2e/support/provider-entrypoint-runner.mjs');
  const runner = readFileSync(runnerPath, 'utf8');
  assert.match(runner, /maxDiagnosticBytes\s*=\s*8\s*\*\s*1024/);
  assert.match(runner, /sanitizeDiagnosticText\(stderr,\s*maxDiagnosticChars\)/);
  assert.match(runner, /stdio:\s*\['pipe',\s*'pipe',\s*'pipe'\]/);
  assert.doesNotMatch(runner, /\$\{stderr(?:\.trim\(\))?\}/);
  const runnerExports = [...runner.matchAll(/^export function (\w+)\(/gm)].map(([, name]) => name);
  assert.deepEqual(runnerExports, [
    'runContainerSshProviderEntrypoint',
    'runTopologyFaultProviderEntrypoint',
    'runRecoveryFaultProviderEntrypoint',
  ]);

  const consumers = [
    [join(repoRoot, 'e2e/support/container-ssh-client.ts'), 'runContainerSshProviderEntrypoint'],
    [join(repoRoot, 'e2e/support/provider-fault-control.ts'), 'runTopologyFaultProviderEntrypoint'],
    [join(orchestratorDir, 'capture-recovery-proof.mjs'), 'runRecoveryFaultProviderEntrypoint'],
  ];
  for (const [path, exportName] of consumers) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, new RegExp(`import \\{ ${exportName} \\}`), path);
    assert.match(source, new RegExp(`${exportName}\\(`), path);
    assert.doesNotMatch(source, /\bspawn\s*\(/, path);
    assert.doesNotMatch(source, /sanitizeDiagnosticText/, path);
  }

  for (const name of [
    'fault-control.mjs',
    'container-ssh-client.mjs',
    'network-l2-probe.mjs',
    'fixture-evidence.mjs',
    'capture-probe-evidence.mjs',
  ]) {
    const source = readFileSync(join(orchestratorDir, name), 'utf8');
    assert.match(source, /runEntrypointWithDiagnostics/, name);
    assert.doesNotMatch(source, /\.catch\(console\.(?:error|warn)\)/, name);
  }
});
