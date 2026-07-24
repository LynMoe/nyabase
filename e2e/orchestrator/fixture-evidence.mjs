#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  aggregateErrorWithDiagnostics,
  runEntrypointWithDiagnostics,
} from '../support/error-diagnostics.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const e2eRoot = resolve(dirname(scriptPath), '..');
const runtimeBase = join(e2eRoot, '.runtime');
const ledgerPath = join(e2eRoot, 'coverage', 'features.yaml');
const fixtureCaseIds = [
  'foundation.runtime.fresh-migration',
  'foundation.runtime.two-distinct-cpu-agents',
  'foundation.runtime.systemd-managed-dockerd',
  'foundation.runtime.xfs-project-quota',
  'servers.inventory.create-and-register-two-servers',
  'images.lifecycle.pull-on-both-nodes',
  'images.lifecycle.immutable-digest',
  'network.macvlan.two-agent-inventories-cpu-only',
];
const initialMigration = 'InitialSchema1700000000000';
const maxCommandBuffer = 8 * 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseEnv(text, label) {
  const values = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line) continue;
    const separator = line.indexOf('=');
    invariant(separator > 0, `${label}:${index + 1} is not KEY=value`);
    const key = line.slice(0, separator);
    invariant(/^[A-Z][A-Z0-9_]*$/.test(key), `${label}:${index + 1} has invalid key`);
    invariant(!(key in values), `${label} contains duplicate key ${key}`);
    values[key] = line.slice(separator + 1);
  }
  return values;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function slash(path) {
  return path.split(sep).join('/');
}

function validRunId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{2,47}$/.test(value);
}

function safeJson(bytes, label) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function loadContext(runtimeDirValue, { secrets = false } = {}) {
  invariant(runtimeDirValue, 'runtime directory is required');
  const runtimeDir = resolve(runtimeDirValue);
  invariant(
    runtimeDir.startsWith(`${runtimeBase}${sep}`) && dirname(runtimeDir) === runtimeBase,
    `runtime directory must be a direct child of ${runtimeBase}`,
  );
  const runtimeInfo = await lstat(runtimeDir);
  invariant(
    runtimeInfo.isDirectory() && !runtimeInfo.isSymbolicLink(),
    'runtime directory must be real',
  );
  invariant((runtimeInfo.mode & 0o077) === 0, 'runtime directory must be private');
  const { state, runId } = await loadValidatedRunState(runtimeDir);
  invariant(validRunId(runId) && runId === runtimeDir.split(sep).at(-1), 'runtime runId mismatch');
  invariant(
    resolve(state.NYABASE_E2E_RUNTIME_DIR ?? '') === runtimeDir,
    'state runtimeDir mismatch',
  );
  const context = {
    runtimeDir,
    fixtureDir: join(runtimeDir, 'fixture-evidence'),
    runId,
    state,
  };
  if (secrets) {
    context.secrets = parseEnv(
      await readFile(join(runtimeDir, 'secrets.env'), 'utf8'),
      'secrets.env',
    );
  }
  return context;
}

async function run(command, args, options = {}) {
  const result = await execFile(command, args, {
    encoding: 'utf8',
    maxBuffer: maxCommandBuffer,
    env: options.env ?? process.env,
  });
  return result.stdout.trim();
}

async function runResult(command, args) {
  try {
    return { code: 0, stdout: await run(command, args), stderr: '' };
  } catch (error) {
    if (Number.isInteger(error?.code)) {
      return {
        code: error.code,
        stdout: String(error.stdout ?? '').trim(),
        stderr: String(error.stderr ?? '').trim(),
      };
    }
    throw error;
  }
}

async function docker(args) {
  return run('docker', args);
}

async function mutateManifest(context, command, ...args) {
  return run(process.execPath, [
    join(dirname(scriptPath), 'manifest.mjs'),
    command,
    context.runtimeDir,
    context.runId,
    ...args,
  ]);
}

async function recordFixtureContainer(context, name) {
  await mutateManifest(context, 'resource', 'container', name);
}

async function retireFixtureContainer(context, name) {
  await mutateManifest(context, 'retire', 'container', name);
}

async function inspectFixtureContainer(name) {
  const result = await runResult('docker', ['inspect', name]);
  if (result.code !== 0) {
    invariant(
      /no such (?:object|container)/i.test(result.stderr),
      'fixture container inspection failed inside the provider boundary',
    );
    return null;
  }
  const parsed = safeJson(result.stdout, 'fixture container inspection');
  invariant(
    Array.isArray(parsed) && parsed.length === 1,
    'fixture container identity is ambiguous',
  );
  return parsed[0];
}

export async function cleanupFixtureContainer(context, name, component, dependencies = {}) {
  const inspect = dependencies.inspect ?? inspectFixtureContainer;
  const remove = dependencies.remove ?? (() => docker(['rm', '--force', name]));
  const retire = dependencies.retire ?? (() => retireFixtureContainer(context, name));
  const existing = await inspect(name);
  if (existing) {
    const labels = existing?.Config?.Labels ?? {};
    invariant(existing.Name === `/${name}`, 'fixture container canonical name mismatch');
    invariant(
      labels['io.nyabase.e2e.run-id'] === context.runId &&
        labels['io.nyabase.e2e.managed'] === 'true' &&
        labels['io.nyabase.e2e.component'] === component,
      'fixture container ownership mismatch',
    );
    await remove();
  }
  invariant((await inspect(name)) === null, 'fixture container remains after cleanup');
  await retire();
}

export async function settleFixtureContainerOutcome(primaryFailure, cleanup) {
  let cleanupFailure = null;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = { error };
  }
  if (primaryFailure !== null && cleanupFailure !== null) {
    throw aggregateErrorWithDiagnostics('fixture operation and provider cleanup failed', [
      primaryFailure.error,
      cleanupFailure.error,
    ]);
  }
  if (primaryFailure !== null) throw primaryFailure.error;
  if (cleanupFailure !== null) throw cleanupFailure.error;
}

async function runTransientFixtureContainer(context, name, component, args) {
  await recordFixtureContainer(context, name);
  let output;
  let primaryFailure = null;
  try {
    output = await docker(args);
  } catch (error) {
    primaryFailure = { error };
  }
  await settleFixtureContainerOutcome(primaryFailure, () =>
    cleanupFixtureContainer(context, name, component),
  );
  return output;
}

async function writePrivateAtomic(path, value, knownSecrets = []) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  for (const secret of knownSecrets) {
    if (secret.length >= 8)
      invariant(!serialized.includes(secret), `${path} would contain a per-run secret`);
  }
  invariant(
    !/"(?:password|refreshToken|accessToken|secret|privateKey)"\s*:/i.test(serialized),
    `${path} would contain a forbidden credential field`,
  );
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return { bytes: Buffer.from(serialized), sha256: sha256(serialized) };
}

function fixtureDefinitions(ledger) {
  const byId = new Map(
    ledger.features.flatMap((feature) =>
      feature.cases.map((coverageCase) => [coverageCase.caseId, coverageCase]),
    ),
  );
  const definitions = fixtureCaseIds.map((caseId) => {
    const coverageCase = byId.get(caseId);
    invariant(coverageCase, `fixture ledger case is absent: ${caseId}`);
    invariant(coverageCase.kind === 'fixture', `${caseId} must remain a fixture`);
    invariant(
      typeof coverageCase.fixtureProducer === 'string' && coverageCase.fixtureProducer.length > 0,
      `${caseId} has no fixture producer`,
    );
    invariant(coverageCase.httpSurfaces.length === 0, `${caseId} fixture cannot own HTTP surfaces`);
    return coverageCase;
  });
  const allFixtures = [...byId.values()].filter((coverageCase) => coverageCase.kind === 'fixture');
  invariant(
    allFixtures.length === fixtureCaseIds.length,
    'fixture proof contract must enumerate every ledger fixture',
  );
  return definitions;
}

async function captureMigrationPreflight(runtimeDirValue) {
  const context = await loadContext(runtimeDirValue);
  const volumeName = `${context.state.NYABASE_E2E_PREFIX}-backend-data`;
  const inspected = await runResult('docker', ['volume', 'inspect', volumeName]);
  invariant(
    inspected.code !== 0 && /no such volume/i.test(inspected.stderr),
    inspected.code === 0
      ? `fresh migration requires absent Backend volume, found ${volumeName}`
      : `could not prove Backend volume absence: ${inspected.stderr || inspected.stdout}`,
  );
  await rm(context.fixtureDir, { recursive: true, force: true });
  await mkdir(context.fixtureDir, { recursive: true, mode: 0o700 });
  const observedAt = new Date().toISOString();
  await writePrivateAtomic(join(context.fixtureDir, 'fresh-migration-preflight.json'), {
    schemaVersion: 1,
    runId: context.runId,
    volumeName,
    absentBeforeComposeCreate: true,
    absenceObservedAt: observedAt,
    emptyBeforeBackendStart: false,
  });
  console.log(`fresh migration preflight PASS: ${volumeName} was absent`);
}

async function captureEmptyMigrationVolume(runtimeDirValue) {
  const context = await loadContext(runtimeDirValue);
  const preflightPath = join(context.fixtureDir, 'fresh-migration-preflight.json');
  const preflight = safeJson(await readFile(preflightPath), 'fresh migration preflight');
  const volumeName = `${context.state.NYABASE_E2E_PREFIX}-backend-data`;
  invariant(
    preflight.runId === context.runId &&
      preflight.volumeName === volumeName &&
      preflight.absentBeforeComposeCreate === true,
    'fresh migration preflight does not belong to this run',
  );
  const labels = safeJson(
    await docker(['volume', 'inspect', volumeName, '--format', '{{json .Labels}}']),
    'Backend volume labels',
  );
  invariant(
    labels?.['io.nyabase.e2e.run-id'] === context.runId,
    'Backend volume lacks run ownership',
  );
  invariant(labels?.['io.nyabase.e2e.managed'] === 'true', 'Backend volume lacks managed label');
  const probeName = `${context.state.NYABASE_E2E_PREFIX}-fresh-volume-proof`;
  const component = 'fixture-fresh-volume-proof';
  await runTransientFixtureContainer(context, probeName, component, [
    'run',
    '--rm',
    '--name',
    probeName,
    '--label',
    `io.nyabase.e2e.run-id=${context.runId}`,
    '--label',
    'io.nyabase.e2e.managed=true',
    '--label',
    `io.nyabase.e2e.component=${component}`,
    '--network',
    'none',
    '--read-only',
    '--pull',
    'never',
    '--mount',
    `type=volume,src=${volumeName},dst=/evidence,readonly`,
    'alpine:latest',
    'sh',
    '-ec',
    'test -z "$(find /evidence -mindepth 1 -print -quit)"',
  ]);
  const observedAt = new Date().toISOString();
  await writePrivateAtomic(preflightPath, {
    ...preflight,
    volumeLabels: {
      runId: labels['io.nyabase.e2e.run-id'],
      managed: labels['io.nyabase.e2e.managed'],
    },
    emptyBeforeBackendStart: true,
    emptinessObservedAt: observedAt,
  });
  console.log(`fresh migration empty-volume PASS: ${volumeName} was empty before Backend start`);
}

async function apiRequest(context, method, path, token, body) {
  const response = await fetch(`${context.state.NYABASE_E2E_PUBLIC_URL}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = text;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    /* retain non-JSON for failure only */
  }
  invariant(
    response.ok,
    `${method} ${path} failed with ${response.status}; response body withheld`,
  );
  return value;
}

function sorted(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right)));
}

function assertSameStrings(actual, expected, label) {
  invariant(
    JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected)),
    `${label} mismatch`,
  );
}

async function nodeRuntimeProof(context, nodeKey) {
  const nodeName = `${context.state.NYABASE_E2E_PREFIX}-${nodeKey}`;
  const machineId = await docker(['exec', nodeName, 'cat', '/etc/machine-id']);
  invariant(/^[0-9a-f]{32}$/.test(machineId), `${nodeKey} machine id is invalid`);
  const active = await docker([
    'exec',
    nodeName,
    'systemctl',
    'is-active',
    'nyabase-docker.service',
  ]);
  invariant(active === 'active', `${nodeKey} managed dockerd is not active`);
  const mainPid = await docker([
    'exec',
    nodeName,
    'systemctl',
    'show',
    'nyabase-docker.service',
    '--property=MainPID',
    '--value',
  ]);
  invariant(/^[1-9][0-9]*$/.test(mainPid), `${nodeKey} managed dockerd has no MainPID`);
  const fragmentPath = await docker([
    'exec',
    nodeName,
    'systemctl',
    'show',
    'nyabase-docker.service',
    '--property=FragmentPath',
    '--value',
  ]);
  invariant(
    fragmentPath === '/etc/systemd/system/nyabase-docker.service',
    `${nodeKey} dockerd unit path mismatch`,
  );
  const execStart = await docker([
    'exec',
    nodeName,
    'systemctl',
    'show',
    'nyabase-docker.service',
    '--property=ExecStart',
    '--value',
  ]);
  invariant(
    execStart.includes('/usr/sbin/dockerd'),
    `${nodeKey} dockerd is not systemd-managed production binary`,
  );
  invariant(
    execStart.includes('/run/nyabase-agent/docker.sock'),
    `${nodeKey} dockerd socket mismatch`,
  );
  invariant(execStart.includes('/var/lib/nyabase-docker'), `${nodeKey} dockerd root mismatch`);
  const dockerInfo = await docker([
    'exec',
    nodeName,
    'docker',
    '-H',
    'unix:///run/nyabase-agent/docker.sock',
    'info',
    '--format',
    '{{.Driver}}|{{.DockerRootDir}}|{{.CgroupVersion}}|{{.CgroupDriver}}',
  ]);
  invariant(
    dockerInfo === 'overlay2|/var/lib/nyabase-docker|2|systemd',
    `${nodeKey} dockerd identity mismatch`,
  );
  const mount = await docker([
    'exec',
    nodeName,
    'findmnt',
    '-n',
    '-o',
    'FSTYPE,OPTIONS',
    '--mountpoint',
    '/mnt/nyabase-xfs',
  ]);
  invariant(/^xfs\s/.test(mount), `${nodeKey} fixture filesystem is not XFS`);
  invariant(
    /(^|,)(pquota|prjquota)(,|$)/.test(mount.replace(/^xfs\s+/, '')),
    `${nodeKey} XFS lacks project quota mount option`,
  );
  const quotaState = await docker([
    'exec',
    nodeName,
    'xfs_quota',
    '-x',
    '-c',
    'state',
    '/data/nyabase',
  ]);
  invariant(/Accounting:\s*ON/i.test(quotaState), `${nodeKey} project quota accounting is off`);
  invariant(/Enforcement:\s*ON/i.test(quotaState), `${nodeKey} project quota enforcement is off`);
  return {
    nodeKey,
    nodeName,
    machineIdSha256: sha256(machineId),
    dockerd: {
      active: true,
      mainPid: Number(mainPid),
      fragmentPath,
      binary: '/usr/sbin/dockerd',
      socketPath: '/run/nyabase-agent/docker.sock',
      dockerRoot: '/var/lib/nyabase-docker',
      storageDriver: 'overlay2',
      cgroupVersion: '2',
      cgroupDriver: 'systemd',
    },
    xfs: {
      mountPoint: '/mnt/nyabase-xfs',
      dataPath: '/data/nyabase',
      fsType: 'xfs',
      projectQuotaMountOption: true,
      projectAccounting: true,
      projectEnforcement: true,
    },
  };
}

async function nodeImageProof(context, nodeKey, tag, expectedDigest, expectedImageId) {
  const nodeName = `${context.state.NYABASE_E2E_PREFIX}-${nodeKey}`;
  const imageId = await docker([
    'exec',
    nodeName,
    'docker',
    '-H',
    'unix:///run/nyabase-agent/docker.sock',
    'image',
    'inspect',
    tag,
    '--format',
    '{{.Id}}',
  ]);
  const repoDigests = safeJson(
    await docker([
      'exec',
      nodeName,
      'docker',
      '-H',
      'unix:///run/nyabase-agent/docker.sock',
      'image',
      'inspect',
      tag,
      '--format',
      '{{json .RepoDigests}}',
    ]),
    `${nodeKey} image RepoDigests`,
  );
  invariant(imageId === expectedImageId, `${nodeKey} image id does not match seeded source image`);
  invariant(
    Array.isArray(repoDigests) && repoDigests.includes(expectedDigest),
    `${nodeKey} immutable digest is absent`,
  );
  return { nodeKey, imageId, repoDigests: sorted(repoDigests) };
}

function validateMigrationDatabase(database) {
  invariant(
    Array.isArray(database.migrations) && database.migrations.length > 0,
    'production migrations table is empty',
  );
  invariant(
    database.migrations.some(
      (entry) => entry.name === initialMigration && Number(entry.timestamp) === 1700000000000,
    ),
    `production database lacks ${initialMigration}`,
  );
  invariant(
    Array.isArray(database.tables) &&
      database.tables.includes('migrations') &&
      database.tables.includes('users'),
    'production migration schema is incomplete',
  );
}

function assertProductionMigrationConfig(config) {
  invariant(
    /runtime:\s*\n\s+nodeEnv:\s*production(?:\s|$)/.test(config),
    'Backend fixture is not production mode',
  );
  invariant(
    /database:\s*\n\s+driver:\s*sqlite\s*\n\s+path:\s*\/data\/nyabase\.db\s*\n\s+synchronize:\s*false\s*\n\s+migrationsRun:\s*true(?:\s|$)/.test(
      config,
    ),
    'Backend production migration config mismatch',
  );
}

async function captureMigrationDatabaseProof(runtimeDirValue) {
  const context = await loadContext(runtimeDirValue, { secrets: true });
  const build = parseEnv(
    await readFile(join(context.runtimeDir, 'build.env'), 'utf8'),
    'build.env',
  );
  const backendName = `${context.state.NYABASE_E2E_PREFIX}-backend-1`;
  const liveImageId = await docker(['inspect', backendName, '--format', '{{.Image}}']);
  invariant(
    liveImageId === build.BACKEND_IMAGE_ID,
    'fresh migration Backend is not the current-run image',
  );
  const volumeName = `${context.state.NYABASE_E2E_PREFIX}-backend-data`;
  const proofContainer = `${context.state.NYABASE_E2E_PREFIX}-migration-proof`;
  const script = [
    "const Database=require('better-sqlite3');",
    "const db=new Database('/data/nyabase.db',{readonly:true,fileMustExist:true});",
    "const migrations=db.prepare('SELECT timestamp,name FROM migrations ORDER BY id').all();",
    "const tables=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all().map(r=>r.name);",
    'db.close();',
    'process.stdout.write(JSON.stringify({migrations,tables}));',
  ].join('');
  const config = await readFile(join(context.runtimeDir, 'backend-config', 'config.yaml'), 'utf8');
  assertProductionMigrationConfig(config);

  let database;
  await docker(['stop', '--time', '30', backendName]);
  try {
    const component = 'fixture-migration-proof';
    database = safeJson(
      await runTransientFixtureContainer(context, proofContainer, component, [
        'run',
        '--rm',
        '--name',
        proofContainer,
        '--label',
        `io.nyabase.e2e.run-id=${context.runId}`,
        '--label',
        'io.nyabase.e2e.managed=true',
        '--label',
        `io.nyabase.e2e.component=${component}`,
        '--network',
        'none',
        '--read-only',
        '--mount',
        `type=volume,src=${volumeName},dst=/data,readonly`,
        liveImageId,
        'node',
        '-e',
        script,
      ]),
      'production migration database proof',
    );
    validateMigrationDatabase(database);
  } finally {
    await docker(['start', backendName]);
  }

  const backend = {
    containerName: backendName,
    imageId: liveImageId,
    nodeEnv: 'production',
    database: {
      driver: 'sqlite',
      path: '/data/nyabase.db',
      synchronize: false,
      migrationsRun: true,
      migrations: database.migrations.map((entry) => ({
        name: String(entry.name),
        timestamp: Number(entry.timestamp),
      })),
      tableCount: database.tables.length,
      requiredTables: ['migrations', 'users'],
    },
  };
  const knownSecrets = Object.values(context.secrets).filter((value) => value.length >= 8);
  await writePrivateAtomic(
    join(context.fixtureDir, 'production-migration.json'),
    {
      schemaVersion: 1,
      runId: context.runId,
      observedAt: new Date().toISOString(),
      volumeName,
      lockProtocol: 'clean-stop-readonly-inspection-restart',
      backend,
    },
    knownSecrets,
  );
  console.log(`fresh migration database PASS: ${initialMigration} in current production image`);
}

async function loadMigrationDatabaseProof(context, build) {
  const captured = safeJson(
    await readFile(join(context.fixtureDir, 'production-migration.json')),
    'captured production migration proof',
  );
  invariant(
    captured.schemaVersion === 1 &&
      captured.runId === context.runId &&
      captured.volumeName === `${context.state.NYABASE_E2E_PREFIX}-backend-data` &&
      captured.lockProtocol === 'clean-stop-readonly-inspection-restart',
    'captured production migration proof does not belong to this run',
  );
  invariant(
    captured.backend?.imageId === build.BACKEND_IMAGE_ID,
    'captured migration proof image does not match the current-run build',
  );
  const liveImageId = await docker([
    'inspect',
    captured.backend.containerName,
    '--format',
    '{{.Image}}',
  ]);
  invariant(
    liveImageId === captured.backend.imageId,
    'restarted Backend image changed after migration proof',
  );
  invariant(
    captured.backend.nodeEnv === 'production',
    'captured migration proof is not production',
  );
  invariant(
    captured.backend.database?.driver === 'sqlite' &&
      captured.backend.database.path === '/data/nyabase.db' &&
      captured.backend.database.synchronize === false &&
      captured.backend.database.migrationsRun === true,
    'captured migration database contract mismatch',
  );
  validateMigrationDatabase({
    migrations: captured.backend.database.migrations,
    tables: captured.backend.database.requiredTables,
  });
  return captured.backend;
}

async function writeFixtureProof(context, definitions, caseId, claims, knownSecrets) {
  const coverageCase = definitions.get(caseId);
  invariant(coverageCase, `unknown fixture proof case ${caseId}`);
  const observedAt = new Date().toISOString();
  const artifactPath = join(context.fixtureDir, `${caseId}.json`);
  const proof = {
    schemaVersion: 1,
    runId: context.runId,
    caseId,
    producer: coverageCase.fixtureProducer,
    status: 'passed',
    observedAt,
    claims,
  };
  const written = await writePrivateAtomic(artifactPath, proof, knownSecrets);
  return {
    caseId,
    producer: coverageCase.fixtureProducer,
    observedAt,
    artifactPath: slash(relative(context.runtimeDir, artifactPath)),
    artifactSha256: written.sha256,
  };
}

async function captureFixtureProofs(runtimeDirValue) {
  const context = await loadContext(runtimeDirValue, { secrets: true });
  const ledger = safeJson(await readFile(ledgerPath), 'coverage ledger');
  const definitions = new Map(fixtureDefinitions(ledger).map((entry) => [entry.caseId, entry]));
  const knownSecrets = Object.values(context.secrets).filter((value) => value.length >= 8);
  const preflight = safeJson(
    await readFile(join(context.fixtureDir, 'fresh-migration-preflight.json')),
    'fresh migration preflight',
  );
  invariant(
    preflight.runId === context.runId &&
      preflight.absentBeforeComposeCreate === true &&
      preflight.emptyBeforeBackendStart === true,
    'fresh migration preflight is incomplete',
  );
  const agentsFile = safeJson(
    await readFile(join(context.runtimeDir, 'agents.json')),
    'agents.json',
  );
  const seed = safeJson(await readFile(join(context.runtimeDir, 'seed.json')), 'seed.json');
  const networkL2 = safeJson(
    await readFile(join(context.fixtureDir, 'network-l2-provider-probe.json')),
    'network L2 provider probe',
  );
  const build = parseEnv(
    await readFile(join(context.runtimeDir, 'build.env'), 'utf8'),
    'build.env',
  );
  invariant(
    Array.isArray(agentsFile.agents) && agentsFile.agents.length === 2,
    'fixture requires two registered Agents',
  );
  invariant(
    Array.isArray(seed.servers) && seed.servers.length === 2,
    'seed fixture requires two Servers',
  );
  invariant(
    networkL2.schemaVersion === 1 &&
      networkL2.runId === context.runId &&
      networkL2.capability === 'shared-macvlan-l2' &&
      networkL2.status === 'passed' &&
      networkL2.workloadPool?.cidr === context.state.NYABASE_E2E_SUBNET &&
      networkL2.workloadPool?.firstAddress?.endsWith('.101') &&
      networkL2.workloadPool?.lastAddress?.endsWith('.199') &&
      Array.isArray(networkL2.networks) &&
      networkL2.networks.length === 2 &&
      networkL2.networks.every(
        (network) =>
          network.name === 'nyabase_net' &&
          network.driver === 'macvlan' &&
          network.parent === 'eth0' &&
          network.subnet === context.state.NYABASE_E2E_SUBNET &&
          network.gateway === context.state.NYABASE_E2E_GATEWAY,
      ) &&
      Array.isArray(networkL2.checks) &&
      networkL2.checks.length === 16 &&
      networkL2.checks.every((check) => check.passed === true) &&
      networkL2.cleanup?.status === 'clean' &&
      Array.isArray(networkL2.cleanup.containers) &&
      networkL2.cleanup.containers.length === 4 &&
      networkL2.cleanup.containers.every(
        (container) => container.removalAccepted === true && container.absent === true,
      ),
    'network L2 provider probe is incomplete',
  );
  const independentClientName = `${context.state.NYABASE_E2E_PREFIX}-independent-client`;
  const independentClientInspect = safeJson(
    await docker(['inspect', independentClientName]),
    'independent network client inspect',
  );
  invariant(
    Array.isArray(independentClientInspect) &&
      independentClientInspect.length === 1 &&
      independentClientInspect[0]?.State?.Running === true &&
      independentClientInspect[0]?.Config?.Labels?.['io.nyabase.e2e.run-id'] === context.runId &&
      independentClientInspect[0]?.NetworkSettings?.Networks?.[context.state.NYABASE_E2E_NETWORK]
        ?.IPAddress === context.state.NYABASE_E2E_PROBE_IP,
    'persistent independent network client identity mismatch',
  );
  const expectedServerIds = sorted(agentsFile.agents.map((agent) => agent.serverId));
  assertSameStrings(
    seed.servers.map((server) => server.serverId),
    expectedServerIds,
    'seeded Server ids',
  );

  const login = await apiRequest(context, 'POST', '/auth/login', undefined, {
    username: 'admin',
    password: context.secrets.ADMIN_INIT_PASSWORD,
  });
  invariant(
    typeof login?.accessToken === 'string' && login.accessToken.length > 0,
    'fixture login returned no token',
  );
  const servers = await apiRequest(context, 'GET', '/admin/servers', login.accessToken);
  invariant(
    Array.isArray(servers) && servers.length === 2,
    'fixture API must expose exactly two Servers before tests',
  );
  assertSameStrings(
    servers.map((server) => server.id),
    expectedServerIds,
    'live Server ids',
  );
  const safeServers = sorted(servers.map((server) => server.id)).map((serverId) => {
    const server = servers.find((candidate) => candidate.id === serverId);
    invariant(server.status === 'online', `fixture Server ${serverId} is not online`);
    invariant(server.runtimeReady === true, `fixture Server ${serverId} is not runtime-ready`);
    invariant(
      Array.isArray(server.gpus) && server.gpus.length === 0,
      `fixture Server ${serverId} is not CPU-only`,
    );
    return {
      id: server.id,
      slug: server.slug,
      status: server.status,
      runtimeReady: true,
      gpuCount: 0,
    };
  });
  const expectedSlugs = agentsFile.agents.map((agent) => `${context.runId}-${agent.key}`);
  assertSameStrings(
    safeServers.map((server) => server.slug),
    expectedSlugs,
    'run-scoped Server slugs',
  );

  const nodeProofs = [];
  for (const nodeKey of ['node1', 'node2'])
    nodeProofs.push(await nodeRuntimeProof(context, nodeKey));
  invariant(
    nodeProofs[0].machineIdSha256 !== nodeProofs[1].machineIdSha256,
    'fixture node machine identities are duplicated',
  );

  invariant(
    typeof seed.image?.dockerImage === 'string' &&
      seed.image.dockerImage === `registry:5000/${context.runId}/workload:immutable`,
    'seeded workload tag is not run-scoped',
  );
  invariant(
    typeof seed.image.registryDigest === 'string' &&
      new RegExp(`^registry:5000/${context.runId}/workload@sha256:[0-9a-f]{64}$`).test(
        seed.image.registryDigest,
      ),
    'seeded workload registry digest is not immutable',
  );
  invariant(
    /^sha256:[0-9a-f]{64}$/.test(seed.image.sourceImageId),
    'seeded workload image id is invalid',
  );
  const imageNodes = [];
  for (const nodeKey of ['node1', 'node2']) {
    imageNodes.push(
      await nodeImageProof(
        context,
        nodeKey,
        seed.image.dockerImage,
        seed.image.registryDigest,
        seed.image.sourceImageId,
      ),
    );
  }
  invariant(
    Array.isArray(seed.imageInventory?.servers) && seed.imageInventory.servers.length === 2,
    'seed image inventory is incomplete',
  );
  assertSameStrings(
    seed.imageInventory.servers.map((server) => server.serverId),
    expectedServerIds,
    'image inventory Server ids',
  );
  invariant(
    seed.imageInventory.servers.every(
      (server) => server.online === true && server.present === true,
    ),
    'seeded image inventory did not converge on both Agents',
  );
  invariant(
    Array.isArray(seed.taskIds?.imagePull) && seed.taskIds.imagePull.length === 2,
    'seed must record two image pull tasks',
  );
  const pullTasks = [];
  for (const taskId of seed.taskIds.imagePull) {
    const task = await apiRequest(
      context,
      'GET',
      `/admin/agent-tasks/${taskId}`,
      login.accessToken,
    );
    invariant(task.status === 'succeeded', `image pull task ${taskId} did not succeed`);
    invariant(
      expectedServerIds.includes(task.serverId),
      `image pull task ${taskId} has an unknown Server`,
    );
    pullTasks.push({
      taskId: String(task.id ?? task.taskId ?? taskId),
      serverId: task.serverId,
      kind: task.kind,
      status: task.status,
      completedAt: task.completedAt ?? null,
    });
  }
  assertSameStrings(
    pullTasks.map((task) => task.serverId),
    expectedServerIds,
    'image pull task Server ids',
  );

  const productionMigration = await loadMigrationDatabaseProof(context, build);
  const records = [];
  records.push(
    await writeFixtureProof(
      context,
      definitions,
      'foundation.runtime.fresh-migration',
      {
        volume: {
          name: preflight.volumeName,
          absentBeforeComposeCreate: true,
          absenceObservedAt: preflight.absenceObservedAt,
          emptyBeforeBackendStart: true,
          emptinessObservedAt: preflight.emptinessObservedAt,
          runOwned: true,
        },
        backend: productionMigration,
      },
      knownSecrets,
    ),
  );
  records.push(
    await writeFixtureProof(
      context,
      definitions,
      'foundation.runtime.two-distinct-cpu-agents',
      {
        count: 2,
        agents: agentsFile.agents.map((agent) => ({
          key: agent.key,
          serverId: agent.serverId,
          machineIdSha256: nodeProofs.find((node) => node.nodeKey === agent.key).machineIdSha256,
          runtimeReady: true,
          cpuOnly: true,
        })),
      },
      knownSecrets,
    ),
  );
  records.push(
    await writeFixtureProof(
      context,
      definitions,
      'foundation.runtime.systemd-managed-dockerd',
      {
        nodes: nodeProofs.map((node) => ({ nodeKey: node.nodeKey, ...node.dockerd })),
      },
      knownSecrets,
    ),
  );
  records.push(
    await writeFixtureProof(
      context,
      definitions,
      'foundation.runtime.xfs-project-quota',
      {
        nodes: nodeProofs.map((node) => ({ nodeKey: node.nodeKey, ...node.xfs })),
      },
      knownSecrets,
    ),
  );
  records.push(
    await writeFixtureProof(
      context,
      definitions,
      'servers.inventory.create-and-register-two-servers',
      {
        count: 2,
        serverIds: expectedServerIds,
        servers: safeServers,
      },
      knownSecrets,
    ),
  );
  records.push(
    await writeFixtureProof(
      context,
      definitions,
      'images.lifecycle.pull-on-both-nodes',
      {
        imageId: seed.image.id,
        dockerImage: seed.image.dockerImage,
        registryDigest: seed.image.registryDigest,
        pullTasks: pullTasks.sort((left, right) => left.serverId.localeCompare(right.serverId)),
        inventories: seed.imageInventory.servers
          .map((server) => ({ serverId: server.serverId, online: true, present: true }))
          .sort((left, right) => left.serverId.localeCompare(right.serverId)),
      },
      knownSecrets,
    ),
  );
  records.push(
    await writeFixtureProof(
      context,
      definitions,
      'images.lifecycle.immutable-digest',
      {
        dockerImage: seed.image.dockerImage,
        registryDigest: seed.image.registryDigest,
        sourceImageId: seed.image.sourceImageId,
        nodes: imageNodes.sort((left, right) => left.nodeKey.localeCompare(right.nodeKey)),
      },
      knownSecrets,
    ),
  );
  records.push(
    await writeFixtureProof(
      context,
      definitions,
      'network.macvlan.two-agent-inventories-cpu-only',
      {
        subnet: context.state.NYABASE_E2E_SUBNET,
        workloadPool: networkL2.workloadPool,
        sharedL2: {
          capability: networkL2.capability,
          observedAt: networkL2.observedAt,
          networks: networkL2.networks,
          addresses: networkL2.addresses,
          checks: networkL2.checks,
          cleanup: networkL2.cleanup,
        },
        independentClient: {
          name: independentClientName,
          address: context.state.NYABASE_E2E_PROBE_IP,
          network: context.state.NYABASE_E2E_NETWORK,
          running: true,
        },
        nodes: agentsFile.agents.map((agent) => ({
          key: agent.key,
          serverId: agent.serverId,
          outerIp: agent.outerIp,
          runtimeReady: true,
          gpuCount: 0,
        })),
      },
      knownSecrets,
    ),
  );
  invariant(records.length === fixtureCaseIds.length, 'fixture proof record count mismatch');
  await writePrivateAtomic(
    join(context.fixtureDir, 'index.json'),
    {
      schemaVersion: 1,
      runId: context.runId,
      generatedAt: new Date().toISOString(),
      fixtures: records.sort((left, right) => left.caseId.localeCompare(right.caseId)),
    },
    knownSecrets,
  );
  console.log(`fixture evidence capture PASS: ${records.length} run-scoped proofs`);
}

async function readBoundProof(context, record, coverageCase) {
  invariant(
    record.caseId === coverageCase.caseId,
    `${coverageCase.caseId} fixture index case mismatch`,
  );
  invariant(
    record.producer === coverageCase.fixtureProducer,
    `${coverageCase.caseId} fixture producer mismatch`,
  );
  invariant(
    typeof record.artifactPath === 'string' && record.artifactPath.length > 0,
    `${coverageCase.caseId} lacks artifact path`,
  );
  const artifactPath = isAbsolute(record.artifactPath)
    ? resolve(record.artifactPath)
    : resolve(context.runtimeDir, record.artifactPath);
  invariant(
    artifactPath.startsWith(`${context.fixtureDir}${sep}`) &&
      dirname(artifactPath) === context.fixtureDir,
    `${coverageCase.caseId} artifact escapes fixture directory`,
  );
  const info = await lstat(artifactPath);
  invariant(
    info.isFile() && !info.isSymbolicLink(),
    `${coverageCase.caseId} artifact must be a regular file`,
  );
  invariant((info.mode & 0o777) === 0o600, `${coverageCase.caseId} artifact must be mode 0600`);
  const bytes = await readFile(artifactPath);
  invariant(
    record.artifactSha256 === sha256(bytes),
    `${coverageCase.caseId} artifact hash mismatch`,
  );
  const proof = safeJson(bytes, `${coverageCase.caseId} fixture proof`);
  invariant(
    proof.schemaVersion === 1 &&
      proof.runId === context.runId &&
      proof.caseId === coverageCase.caseId &&
      proof.producer === coverageCase.fixtureProducer &&
      proof.status === 'passed' &&
      proof.observedAt === record.observedAt,
    `${coverageCase.caseId} fixture proof binding mismatch`,
  );
  return { artifactPath, proof };
}

async function emitFixtureEvents(runtimeDirValue, profile) {
  invariant(['smoke', 'core', 'full', 'recovery'].includes(profile), `unknown profile ${profile}`);
  const context = await loadContext(runtimeDirValue);
  const ledger = safeJson(await readFile(ledgerPath), 'coverage ledger');
  const definitions = fixtureDefinitions(ledger);
  const index = safeJson(
    await readFile(join(context.fixtureDir, 'index.json')),
    'fixture evidence index',
  );
  invariant(
    index.schemaVersion === 1 && index.runId === context.runId,
    'fixture evidence index run mismatch',
  );
  invariant(
    Array.isArray(index.fixtures) && index.fixtures.length === fixtureCaseIds.length,
    'fixture evidence index is incomplete',
  );
  const records = new Map(index.fixtures.map((entry) => [entry.caseId, entry]));
  const selected = definitions.filter(
    (coverageCase) =>
      coverageCase.status === 'implemented' && coverageCase.profiles.includes(profile),
  );
  const events = [];
  for (const coverageCase of selected) {
    const record = records.get(coverageCase.caseId);
    invariant(record, `${coverageCase.caseId} has no fixture proof record`);
    const { artifactPath, proof } = await readBoundProof(context, record, coverageCase);
    events.push({
      schemaVersion: 1,
      runId: context.runId,
      profile,
      caseId: coverageCase.caseId,
      kind: 'fixture',
      source: 'fixture',
      status: 'passed',
      observedAt: proof.observedAt,
      fixtureProducer: coverageCase.fixtureProducer,
      artifactPath,
      artifactSha256: record.artifactSha256,
      persona: coverageCase.persona,
      observedHttpSurfaces: [],
    });
  }
  const eventsPath = join(context.runtimeDir, 'coverage-case-events.jsonl');
  const existing = await lstat(eventsPath).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    },
  );
  invariant(!existing, 'fixture events must be emitted before Playwright case events');
  if (events.length > 0) {
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(eventsPath, 0o600);
  }
  console.log(`fixture event emission PASS: ${events.length} ${profile} fixture events`);
}

async function main() {
  const [command, runtimeDir, profile] = process.argv.slice(2);
  if (command === 'pre-migration') await captureMigrationPreflight(runtimeDir);
  else if (command === 'empty-migration-volume') await captureEmptyMigrationVolume(runtimeDir);
  else if (command === 'capture-migration') await captureMigrationDatabaseProof(runtimeDir);
  else if (command === 'capture') await captureFixtureProofs(runtimeDir);
  else if (command === 'emit') await emitFixtureEvents(runtimeDir, profile);
  else {
    throw new Error(
      'usage: fixture-evidence.mjs {pre-migration|empty-migration-volume|capture-migration|capture} <runtimeDir> | emit <runtimeDir> <profile>',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runEntrypointWithDiagnostics(main);
}
