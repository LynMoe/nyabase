#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  aggregateErrorWithDiagnostics,
  runEntrypointWithDiagnostics,
} from '../support/error-diagnostics.mjs';
import { assertManifestForRun } from './manifest-contract.mjs';
import {
  e2eStateKeys,
  loadValidatedComposeState,
  loadValidatedRunState,
} from './run-state-contract.mjs';

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const orchestratorDir = dirname(scriptPath);
const runtimeBase = resolve(orchestratorDir, '..', '.runtime');
const runtimeDir = resolve(process.argv[2] ?? '');
const maxBuffer = 2 * 1024 * 1024;
const agentUnit = 'nyabase-agent.service';
const faultComponent = 'provider-fault-node';
const localDataRoot = '/data/nyabase';
const wireProxyUnit = 'nyabase-e2e-agent-task-wire.service';
const wireProxyRoot = '/var/lib/nyabase-e2e/agent-task-wire';
const wireProxyPort = 18443;
const dockerUnit = 'nyabase-docker.service';
const advancedClockOffsetMs = 8 * 24 * 60 * 60_000;
const repositoryRoot = resolve(orchestratorDir, '..', '..');
const requireFromBackend = createRequire(
  join(repositoryRoot, 'packages', 'backend', 'package.json'),
);
export const duplicateClaimFaultHostname = 'nyabase-e2e-duplicate-claim';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertComposeEnv(context) {
  await loadValidatedComposeState(runtimeDir, context.state);
}

export function composeProcessEnvironment(overrides = {}, sourceEnvironment = process.env) {
  const environment = { ...sourceEnvironment };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('COMPOSE_')) delete environment[key];
  }
  for (const key of e2eStateKeys) delete environment[key];
  delete environment.NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS;
  const requestedOffset = overrides.NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS;
  invariant(
    requestedOffset === undefined ||
      requestedOffset === '0' ||
      requestedOffset === String(advancedClockOffsetMs),
    'backend clock offset is outside the closed provider vocabulary',
  );
  return { ...environment, ...overrides };
}

async function command(program, args, options = {}) {
  const result = await execFile(program, args, {
    encoding: 'utf8',
    maxBuffer,
    timeout: options.timeout ?? 30_000,
    ...(options.env ? { env: options.env } : {}),
  });
  return result.stdout.trim();
}

async function commandResult(program, args, options = {}) {
  try {
    return { code: 0, stdout: await command(program, args, options), stderr: '' };
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

function commandWithInput(program, args, input, timeout = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${program} exceeded its ${timeout}ms provider deadline`));
    }, timeout);
    timer.unref?.();
    const collect = (chunk, target) => {
      bytes += chunk.byteLength;
      if (bytes > maxBuffer) {
        child.kill('SIGKILL');
        reject(new Error(`${program} exceeded the provider output limit`));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${program} failed (${String(code ?? signal)}): ${stderr.trim()}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
    child.stdin.end(input);
  });
}

const docker = (args, options) => command('docker', args, options);
const dockerResult = (args, options) => commandResult('docker', args, options);

async function readBoundedStdin() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk.toString('utf8');
    invariant(Buffer.byteLength(raw) <= 32 * 1024, 'fault-control input exceeds 32 KiB');
  }
  invariant(raw.trim().length > 0, 'fault-control input is required on stdin');
  return JSON.parse(raw);
}

function assertExactKeys(value, expected) {
  invariant(
    value && typeof value === 'object' && !Array.isArray(value),
    'fault input must be an object',
  );
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(wanted),
    'fault input has unknown or missing fields',
  );
}

function assertNodeKey(value) {
  invariant(value === 'node1' || value === 'node2', 'nodeKey must be node1 or node2');
}

export function validateInput(value, runId) {
  invariant(value?.runId === runId, 'fault input runId does not match the runtime');
  if (value?.fault === 'agentService') {
    assertExactKeys(value, ['fault', 'runId', 'nodeKey', 'action']);
    assertNodeKey(value.nodeKey);
    invariant(
      ['stop', 'start', 'restart', 'probe'].includes(value.action),
      'unsupported Agent service action',
    );
    return value;
  }
  if (value?.fault === 'localDataDirOrphan') {
    assertExactKeys(value, ['fault', 'runId', 'nodeKey', 'action']);
    assertNodeKey(value.nodeKey);
    invariant(['inject', 'probe', 'restore'].includes(value.action), 'unsupported orphan action');
    return value;
  }
  if (value?.fault === 'duplicateNetworkClaim') {
    const inject = value.action === 'inject';
    assertExactKeys(
      value,
      inject
        ? ['fault', 'runId', 'action', 'serverId', 'agentToken']
        : ['fault', 'runId', 'action', 'serverId'],
    );
    invariant(
      ['inject', 'probe', 'restore'].includes(value.action),
      'unsupported duplicate claim action',
    );
    invariant(
      typeof value.serverId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.serverId),
      'duplicate claim serverId is invalid',
    );
    if (inject) {
      invariant(
        typeof value.agentToken === 'string' && /^[a-f0-9]{64}$/.test(value.agentToken),
        'duplicate claim Agent token is invalid',
      );
    }
    return value;
  }
  if (value?.fault === 'agentTaskWire') {
    assertExactKeys(value, [
      'fault',
      'runId',
      'nodeKey',
      'mode',
      'action',
      'taskId',
      'payloadHash',
    ]);
    assertNodeKey(value.nodeKey);
    invariant(
      value.mode === 'drop-terminal-once' ||
        value.mode === 'hold-terminal-until-release' ||
        value.mode === 'mutate-image-ref-once',
      'unsupported Agent task wire mode',
    );
    invariant(
      ['inject', 'probe', 'release', 'restore'].includes(value.action),
      'unsupported Agent task wire action',
    );
    invariant(
      value.mode === 'drop-terminal-once' ||
        value.mode === 'hold-terminal-until-release' ||
        value.action !== 'release',
      'only the terminal-drop wire fault can be released',
    );
    invariant(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.taskId),
      'Agent task wire taskId is invalid',
    );
    invariant(
      typeof value.payloadHash === 'string' && /^[a-f0-9]{64}$/.test(value.payloadHash),
      'Agent task wire payloadHash is invalid',
    );
    return value;
  }
  if (value?.fault === 'containerRuntimeDrift') {
    assertExactKeys(value, ['fault', 'runId', 'nodeKey', 'action', 'containerId', 'runtimeId']);
    assertNodeKey(value.nodeKey);
    invariant(
      ['remove', 'stop', 'start', 'probe'].includes(value.action),
      'unsupported runtime drift action',
    );
    invariant(
      typeof value.containerId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.containerId),
      'runtime drift containerId is invalid',
    );
    invariant(
      typeof value.runtimeId === 'string' && /^[a-f0-9]{64}$/.test(value.runtimeId),
      'runtime drift runtimeId must be a full Docker identity',
    );
    return value;
  }
  if (value?.fault === 'backendService') {
    assertExactKeys(
      value,
      value.role === undefined
        ? ['fault', 'runId', 'action']
        : ['fault', 'runId', 'action', 'role'],
    );
    invariant(value.action === 'restart' || value.action === 'probe', 'unsupported Backend action');
    invariant(
      value.role === undefined || ['api', 'gateway', 'worker', 'all'].includes(value.role),
      'unsupported split Backend role',
    );
    return value;
  }
  if (value?.fault === 'backendClock') {
    assertExactKeys(value, ['fault', 'runId', 'action']);
    invariant(
      ['advance', 'restore', 'probe'].includes(value.action),
      'unsupported Backend clock action',
    );
    return value;
  }
  if (value?.fault === 'redisService') {
    assertExactKeys(value, ['fault', 'runId', 'action']);
    invariant(
      ['stop', 'flush', 'restart', 'probe'].includes(value.action),
      'unsupported Redis service action',
    );
    return value;
  }
  if (value?.fault === 'telemetryService') {
    assertExactKeys(value, ['fault', 'runId', 'service', 'action']);
    invariant(
      value.service === 'vmagent' || value.service === 'victoriametrics',
      'unsupported telemetry service',
    );
    invariant(
      ['stop', 'start', 'restart', 'probe'].includes(value.action),
      'unsupported telemetry service action',
    );
    return value;
  }
  if (value?.fault === 'dockerdService') {
    assertExactKeys(value, ['fault', 'runId', 'nodeKey', 'action']);
    assertNodeKey(value.nodeKey);
    invariant(value.action === 'restart' || value.action === 'probe', 'unsupported dockerd action');
    return value;
  }
  if (value?.fault === 'duplicateAgentSession') {
    assertExactKeys(value, ['fault', 'runId', 'nodeKey', 'action']);
    assertNodeKey(value.nodeKey);
    invariant(value.action === 'probe', 'duplicate Agent session supports only probe');
    return value;
  }
  if (value?.fault === 'splitGatewaySessionRace') {
    assertExactKeys(
      value,
      value.action === 'inject'
        ? ['fault', 'runId', 'nodeKey', 'action', 'staleExecSessionId']
        : value.action === 'probe' && value.expectedClosedExecSessionIds !== undefined
          ? ['fault', 'runId', 'nodeKey', 'action', 'expectedClosedExecSessionIds']
          : ['fault', 'runId', 'nodeKey', 'action'],
    );
    assertNodeKey(value.nodeKey);
    invariant(
      ['inject', 'probe', 'restore'].includes(value.action),
      'split Gateway session race action is unsupported',
    );
    invariant(
      value.action !== 'inject'
        || /^[0-9a-f-]{36}$/.test(value.staleExecSessionId),
      'split Gateway injection requires the stale Console session identity',
    );
    invariant(
      value.action !== 'probe'
        || value.expectedClosedExecSessionIds === undefined
        || (
          Array.isArray(value.expectedClosedExecSessionIds)
          && value.expectedClosedExecSessionIds.length >= 1
          && value.expectedClosedExecSessionIds.length <= 4
          && new Set(value.expectedClosedExecSessionIds).size
            === value.expectedClosedExecSessionIds.length
          && value.expectedClosedExecSessionIds.every((id) =>
            typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))
        ),
      'split Gateway closed Console session identities are invalid',
    );
    return value;
  }
  if (value?.fault === 'artifactAudit') {
    assertExactKeys(value, ['fault', 'runId', 'action']);
    invariant(value.action === 'capture', 'artifact audit supports only capture');
    return value;
  }
  throw new Error('unsupported topology fault');
}

async function inspectContainer(name, expectedComponent, runId, optional = false, serverId) {
  const result = await dockerResult(['inspect', name]);
  if (result.code !== 0 && optional) return null;
  invariant(result.code === 0, `run-owned container ${name} does not exist`);
  const parsed = JSON.parse(result.stdout);
  invariant(
    Array.isArray(parsed) && parsed.length === 1,
    `container ${name} identity is ambiguous`,
  );
  const container = parsed[0];
  const labels = container?.Config?.Labels ?? {};
  invariant(container?.Name === `/${name}`, `container ${name} canonical name mismatch`);
  invariant(labels['io.nyabase.e2e.run-id'] === runId, `container ${name} run label mismatch`);
  invariant(
    labels['io.nyabase.e2e.managed'] === 'true',
    `container ${name} is not provider-managed`,
  );
  invariant(
    matchesExpectedContainerComponent(labels, expectedComponent),
    `container ${name} component mismatch`,
  );
  if (serverId !== undefined) {
    invariant(
      labels['io.nyabase.e2e.fault-server-id'] === serverId,
      `container ${name} fault Server identity mismatch`,
    );
  }
  return container;
}

export function matchesExpectedContainerComponent(labels, expectedComponent) {
  return expectedComponent === undefined
    || labels['io.nyabase.e2e.component'] === expectedComponent;
}

async function recordManifestResource(kind, name, runId) {
  await command(process.execPath, [
    join(orchestratorDir, 'manifest.mjs'),
    'resource',
    runtimeDir,
    runId,
    kind,
    name,
  ]);
}

async function retireManifestResource(kind, name, runId) {
  await command(process.execPath, [
    join(orchestratorDir, 'manifest.mjs'),
    'retire',
    runtimeDir,
    runId,
    kind,
    name,
  ]);
}

async function serviceActive(containerName) {
  const result = await dockerResult(['exec', containerName, 'systemctl', 'is-active', agentUnit]);
  return result.code === 0 && result.stdout === 'active';
}

async function waitForService(containerName, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await serviceActive(containerName)) === expected) return expected;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `${agentUnit} in ${containerName} did not become ${expected ? 'active' : 'inactive'} within ${timeoutMs}ms`,
  );
}

async function setAgentService(containerName, action) {
  await docker(['exec', containerName, 'systemctl', action, agentUnit], { timeout: 45_000 });
  return waitForService(containerName, action !== 'stop');
}

function assertRuntimeContainerIdList(ids, label) {
  invariant(Array.isArray(ids), `${label} must be an array`);
  invariant(
    ids.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)),
    `${label} contains an invalid full Docker identity`,
  );
  invariant(new Set(ids).size === ids.length, `${label} contains duplicate Docker identities`);
  invariant(
    JSON.stringify(ids) === JSON.stringify([...ids].sort()),
    `${label} is not canonically sorted`,
  );
}

export function validateRuntimeContainerIdentitySets(
  runtimeContainerIds,
  activeRuntimeContainerIds,
) {
  assertRuntimeContainerIdList(runtimeContainerIds, 'all Agent runtime identities');
  assertRuntimeContainerIdList(activeRuntimeContainerIds, 'active Agent runtime identities');
  const all = new Set(runtimeContainerIds);
  invariant(
    activeRuntimeContainerIds.every((id) => all.has(id)),
    'active Agent runtime identities are not a subset of all runtime identities',
  );
  return { runtimeContainerIds, activeRuntimeContainerIds };
}

async function runtimeContainerIds(containerName, activeOnly = false) {
  const output = await docker([
    'exec',
    containerName,
    'docker',
    '--host',
    'unix:///run/nyabase-agent/docker.sock',
    'ps',
    ...(activeOnly ? [] : ['--all']),
    '--no-trunc',
    '--quiet',
  ]);
  const ids = output.split('\n').filter(Boolean).sort();
  assertRuntimeContainerIdList(ids, 'Agent runtime identities');
  return ids;
}

async function controlAgentService(input, context) {
  const containerName = `${context.state.NYABASE_E2E_PREFIX}-${input.nodeKey}`;
  const inspected = await inspectContainer(containerName, input.nodeKey, context.runId);
  invariant(inspected?.State?.Running === true, `node ${input.nodeKey} is not running`);
  await recordManifestResource('provider-fault', `agent-service:${input.nodeKey}`, context.runId);
  const active =
    input.action === 'probe'
      ? await serviceActive(containerName)
      : await setAgentService(containerName, input.action);
  invariant(input.action !== 'probe' || active, 'Agent service probe requires an active unit');
  const runtimeIds = input.action === 'probe' ? await runtimeContainerIds(containerName) : null;
  const activeRuntimeIds =
    input.action === 'probe' ? await runtimeContainerIds(containerName, true) : null;
  if (runtimeIds && activeRuntimeIds) {
    validateRuntimeContainerIdentitySets(runtimeIds, activeRuntimeIds);
  }
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    nodeKey: input.nodeKey,
    containerName,
    action: input.action,
    serviceActive: active,
    runtimeContainerIds: runtimeIds,
    activeRuntimeContainerIds: activeRuntimeIds,
    observedAt: new Date().toISOString(),
  };
}

function decodeMountInfoPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

async function localSourceIdentity(containerName) {
  const uuid = (
    await docker([
      'exec',
      containerName,
      'findmnt',
      '--noheadings',
      '--raw',
      '--output',
      'UUID',
      '--mountpoint',
      localDataRoot,
    ])
  )
    .split(/\s+/)[0]
    ?.toLowerCase();
  invariant(uuid && /^[a-f0-9-]{16,64}$/.test(uuid), 'local XFS source has no stable UUID');
  const mountInfo = await docker(['exec', containerName, 'cat', '/proc/self/mountinfo']);
  const line = mountInfo.split('\n').find((candidate) => {
    const fields = candidate.split(' ');
    return fields.length > 5 && decodeMountInfoPath(fields[4]) === localDataRoot;
  });
  invariant(line, 'local data root is not an exact mount');
  const fields = line.split(' ');
  const separator = fields.indexOf('-');
  invariant(separator >= 6 && fields[separator + 1] === 'xfs', 'local data root is not XFS');
  const fsRoot = resolve('/', decodeMountInfoPath(fields[3]));
  return `local:xfs:${uuid}:fsroot=${encodeURIComponent(fsRoot)}`;
}

async function pathExists(containerName, path) {
  return (await dockerResult(['exec', containerName, 'test', '-e', path])).code === 0;
}

async function assertOrphanShape(containerName, path, marker) {
  if (!(await pathExists(containerName, path))) return false;
  invariant(
    (await dockerResult(['exec', containerName, 'test', '!', '-L', path])).code === 0,
    'provider orphan root became a symlink',
  );
  const rootStat = await docker(['exec', containerName, 'stat', '-c', '%F|%u|%a', path]);
  invariant(rootStat === 'directory|0|700', 'provider orphan root ownership or mode changed');
  const children = (await docker(['exec', containerName, 'ls', '-A1', path]))
    .split('\n')
    .filter(Boolean)
    .sort();
  invariant(
    JSON.stringify(children) === JSON.stringify(['data', 'marker.json']),
    'provider orphan shape changed',
  );
  const markerPath = `${path}/marker.json`;
  const markerStat = await docker(['exec', containerName, 'stat', '-c', '%F|%u|%a', markerPath]);
  invariant(
    markerStat === 'regular file|0|600',
    'provider orphan marker ownership or mode changed',
  );
  const observedMarker = JSON.parse(await docker(['exec', containerName, 'cat', markerPath]));
  invariant(
    JSON.stringify(observedMarker) === JSON.stringify(marker),
    'provider orphan identity changed',
  );
  const dataPath = `${path}/data`;
  const dataStat = await docker(['exec', containerName, 'stat', '-c', '%F|%u|%a', dataPath]);
  invariant(dataStat === 'directory|0|700', 'provider orphan data path ownership or mode changed');
  return true;
}

async function assertSafeRootDirectory(containerName, path) {
  invariant(await pathExists(containerName, path), `safe DataDir parent ${path} is absent`);
  invariant(
    (await dockerResult(['exec', containerName, 'test', '!', '-L', path])).code === 0,
    `safe DataDir parent ${path} became a symlink`,
  );
  const observed = await docker(['exec', containerName, 'stat', '-c', '%F|%u|%g|%a', path]);
  invariant(
    observed === 'directory|0|0|700',
    `safe DataDir parent ${path} must be a root-owned 0700 directory`,
  );
}

function orphanControlStatePath(nodeKey) {
  return join(runtimeDir, 'agents', `fault-local-data-dir-orphan-${nodeKey}.json`);
}

async function readOrphanControlState(statePath, expected) {
  let info;
  try {
    info = await lstat(statePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  invariant(info.isFile() && !info.isSymbolicLink(), 'provider orphan control state is not a file');
  invariant(
    info.uid === 0 && (info.mode & 0o077) === 0,
    'provider orphan control state is not private',
  );
  const value = JSON.parse(await readFile(statePath, 'utf8'));
  assertExactKeys(value, [
    'version',
    'resourceId',
    'sourceId',
    'sourceIdentity',
    'createdMetaRoot',
    'createdDirsRoot',
  ]);
  invariant(value.version === 1, 'provider orphan control state version mismatch');
  invariant(value.resourceId === expected.resourceId, 'provider orphan resource state mismatch');
  invariant(value.sourceId === expected.sourceId, 'provider orphan source state mismatch');
  invariant(
    value.sourceIdentity === expected.sourceIdentity,
    'provider orphan source identity state mismatch',
  );
  invariant(
    typeof value.createdMetaRoot === 'boolean' && typeof value.createdDirsRoot === 'boolean',
    'provider orphan parent ownership state is invalid',
  );
  invariant(
    !value.createdMetaRoot || value.createdDirsRoot,
    'provider orphan parent ownership state is impossible',
  );
  return value;
}

async function publishOrphanControlState(statePath, value) {
  await writeFile(statePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(statePath, 0o600);
}

async function ensureOrphanParents(containerName, metaRoot, dirsRoot, state) {
  if (!(await pathExists(containerName, metaRoot))) {
    invariant(state.createdMetaRoot, 'refusing to recreate a parent not owned by this fault');
    await docker([
      'exec',
      containerName,
      'install',
      '-d',
      '-m',
      '0700',
      '-o',
      'root',
      '-g',
      'root',
      '--',
      metaRoot,
    ]);
  }
  await assertSafeRootDirectory(containerName, metaRoot);
  if (!(await pathExists(containerName, dirsRoot))) {
    invariant(
      state.createdDirsRoot,
      'refusing to recreate an inventory root not owned by this fault',
    );
    await docker([
      'exec',
      containerName,
      'install',
      '-d',
      '-m',
      '0700',
      '-o',
      'root',
      '-g',
      'root',
      '--',
      dirsRoot,
    ]);
  }
  await assertSafeRootDirectory(containerName, dirsRoot);
}

async function injectOrphan(containerName, path, temporaryPath, marker) {
  if (await assertOrphanShape(containerName, path, marker)) return;
  invariant(
    !(await pathExists(containerName, temporaryPath)),
    'provider orphan staging path already exists',
  );
  await docker(['exec', containerName, 'mkdir', '--mode=0700', '--', temporaryPath]);
  await docker(['exec', containerName, 'mkdir', '--mode=0700', '--', `${temporaryPath}/data`]);
  await commandWithInput(
    'docker',
    ['exec', '-i', containerName, 'tee', `${temporaryPath}/marker.json`],
    `${JSON.stringify(marker)}\n`,
  );
  await docker(['exec', containerName, 'chmod', '0600', `${temporaryPath}/marker.json`]);
  await docker(['exec', containerName, 'mv', '--no-target-directory', '--', temporaryPath, path]);
  invariant(
    await assertOrphanShape(containerName, path, marker),
    'provider orphan publication failed',
  );
}

async function removeOrphan(containerName, path, temporaryPath, marker) {
  if (await pathExists(containerName, path)) {
    invariant(
      await assertOrphanShape(containerName, path, marker),
      'refusing to remove changed orphan identity',
    );
    const firstDataEntry = await docker([
      'exec',
      containerName,
      'find',
      `${path}/data`,
      '-mindepth',
      '1',
      '-print',
      '-quit',
    ]);
    invariant(firstDataEntry === '', 'refusing to remove a provider orphan containing user data');
    await docker(['exec', containerName, 'rm', '-rf', '--', path]);
  }
  if (await pathExists(containerName, temporaryPath)) {
    await docker(['exec', containerName, 'rm', '-rf', '--', temporaryPath]);
  }
  invariant(!(await pathExists(containerName, path)), 'provider orphan still exists after restore');
}

async function controlLocalDataDirOrphan(input, context) {
  const containerName = `${context.state.NYABASE_E2E_PREFIX}-${input.nodeKey}`;
  const inspected = await inspectContainer(containerName, input.nodeKey, context.runId);
  invariant(inspected?.State?.Running === true, `node ${input.nodeKey} is not running`);
  const sourceId = `${context.runId}-${input.nodeKey}-local`;
  const sourceIdentity = await localSourceIdentity(containerName);
  const resourceId = `${context.runId}:provider-orphan:${input.nodeKey}`;
  const hostPath = `${localDataRoot}/.nyabase/dirs/${resourceId}`;
  const temporaryPath = `${localDataRoot}/.nyabase/dirs/.fault-inject-${resourceId}`;
  const dirsRoot = dirname(hostPath);
  const metaRoot = dirname(dirsRoot);
  const statePath = orphanControlStatePath(input.nodeKey);
  const marker = { version: 1, resourceId, sourceId, sourceIdentity };
  await recordManifestResource(
    'provider-fault',
    `local-data-dir-orphan:${input.nodeKey}:${resourceId}`,
    context.runId,
  );

  if (input.action !== 'probe') {
    const wasActive = await serviceActive(containerName);
    invariant(
      input.action !== 'inject' || wasActive,
      `${agentUnit} must be active before ${input.action}`,
    );
    if (wasActive) await setAgentService(containerName, 'stop');
    try {
      let state = await readOrphanControlState(statePath, marker);
      if (input.action === 'inject') {
        if (!state) {
          const metaRootExists = await pathExists(containerName, metaRoot);
          const dirsRootExists = await pathExists(containerName, dirsRoot);
          invariant(
            metaRootExists || !dirsRootExists,
            'DataDir inventory root exists without its parent',
          );
          if (metaRootExists) await assertSafeRootDirectory(containerName, metaRoot);
          if (dirsRootExists) await assertSafeRootDirectory(containerName, dirsRoot);
          state = {
            ...marker,
            createdMetaRoot: !metaRootExists,
            createdDirsRoot: !dirsRootExists,
          };
          await publishOrphanControlState(statePath, state);
        }
        await ensureOrphanParents(containerName, metaRoot, dirsRoot, state);
        await injectOrphan(containerName, hostPath, temporaryPath, marker);
      } else if (state) {
        await ensureOrphanParents(containerName, metaRoot, dirsRoot, state);
        await removeOrphan(containerName, hostPath, temporaryPath, marker);
        if (state.createdDirsRoot) {
          await docker(['exec', containerName, 'rmdir', '--', dirsRoot]);
        }
        if (state.createdMetaRoot) {
          await docker(['exec', containerName, 'rmdir', '--', metaRoot]);
        }
        await rm(statePath, { force: true });
      } else {
        invariant(
          !(await pathExists(containerName, hostPath)),
          'refusing to remove an orphan without provider ownership state',
        );
      }
    } finally {
      // Restore is also the crash-recovery entrypoint. A killed provider child
      // may have left the unit inactive at any point after publishing its
      // private ownership state, so convergence always ends by starting and
      // observing the fixed Agent unit.
      await setAgentService(containerName, 'start');
    }
  }

  const state = await readOrphanControlState(statePath, marker);
  if (state) {
    await assertSafeRootDirectory(containerName, metaRoot);
    await assertSafeRootDirectory(containerName, dirsRoot);
  }
  const present = state ? await assertOrphanShape(containerName, hostPath, marker) : false;
  invariant(
    state || !(await pathExists(containerName, hostPath)),
    'provider orphan exists without ownership state',
  );
  invariant(input.action !== 'inject' || present, 'provider orphan injection is absent');
  invariant(input.action !== 'restore' || !present, 'provider orphan restore left residue');
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    nodeKey: input.nodeKey,
    containerName,
    action: input.action,
    resourceId,
    sourceId,
    sourceIdentity,
    hostPath: `${hostPath}/data`,
    present,
    serviceActive: await serviceActive(containerName),
    observedAt: new Date().toISOString(),
  };
}

export function duplicateFaultIdentity(context) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(context.state.NYABASE_E2E_SUBNET);
  invariant(match, 'provider subnet is not a canonical /24');
  const prefix = `${match[1]}.${match[2]}.${match[3]}`;
  invariant(
    context.state.NYABASE_E2E_DUPLICATE_FAULT_IP === `${prefix}.23`,
    'duplicate-claim fault address is outside its dedicated reservation',
  );
  return {
    containerName: `${context.state.NYABASE_E2E_PREFIX}-fault-duplicate-claim`,
    // Docker names can exceed the Linux hostname limit. Keep the hostname
    // independent from the caller-selected run ID so the longest valid run
    // still starts its private systemd namespace.
    hostname: duplicateClaimFaultHostname,
    // The transient provider node has an explicit run-state reservation. It
    // must not borrow an address from the production-like Compose services
    // (.14 is PostgreSQL), the independent probe (.20), or the split-Gateway
    // fault pair (.21/.22).
    outerIp: context.state.NYABASE_E2E_DUPLICATE_FAULT_IP,
    conflictingAddress: context.state.NYABASE_E2E_NODE1_IP,
    configPath: join(runtimeDir, 'agents', 'fault-duplicate-claim.yaml'),
  };
}

export function duplicateFaultDockerRunArgs(input, context, identity) {
  return [
    'run',
    '-d',
    '--pull=never',
    '--name',
    identity.containerName,
    '--hostname',
    identity.hostname,
    '--label',
    `io.nyabase.e2e.run-id=${context.runId}`,
    '--label',
    'io.nyabase.e2e.managed=true',
    '--label',
    `io.nyabase.e2e.component=${faultComponent}`,
    '--label',
    `io.nyabase.e2e.fault-server-id=${input.serverId}`,
    '--privileged',
    '--cgroupns=private',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',
    '--tmpfs',
    '/tmp',
    '--network',
    context.state.NYABASE_E2E_NETWORK,
    '--ip',
    identity.outerIp,
    '--mount',
    `type=bind,src=${identity.configPath},dst=/run/nyabase-e2e/agent.yaml,readonly`,
    '--mount',
    `type=bind,src=${join(runtimeDir, 'certs', 'ca.crt')},dst=/run/nyabase-e2e/ca.crt,readonly`,
    context.state.NYABASE_E2E_NODE_IMAGE,
  ];
}

async function assertOuterIpFree(state, address) {
  const parsed = JSON.parse(await docker(['network', 'inspect', state.NYABASE_E2E_NETWORK]));
  invariant(
    Array.isArray(parsed) && parsed.length === 1,
    'provider outer network identity is ambiguous',
  );
  const endpoints = Object.values(parsed[0]?.Containers ?? {});
  invariant(
    !endpoints.some((endpoint) => String(endpoint?.IPv4Address ?? '').split('/')[0] === address),
    `provider fault address ${address} is already attached`,
  );
}

async function waitForSystemd(containerName) {
  const deadline = Date.now() + 60_000;
  let state = '';
  while (Date.now() < deadline) {
    const result = await dockerResult(['exec', containerName, 'systemctl', 'is-system-running']);
    state = result.stdout;
    if (state === 'running' || state === 'degraded') return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`fault node systemd did not become ready; last=${state}`);
}

export function faultNodeCleanupMode(inspected) {
  if (inspected?.State?.Running === true) return 'physical';
  if (inspected?.State?.Running === false && inspected.State.Status === 'created') {
    // Docker has created the metadata object but OCI never started PID 1, so
    // setup-node could not have allocated a loop device or mounted XFS.
    return 'discard-unstarted';
  }
  throw new Error('provider fault node is not running for physical cleanup');
}

export function manifestHasResourceIdentity(manifest, kind, name) {
  return Array.isArray(manifest?.resources)
    && manifest.resources.some((entry) =>
      entry?.kind === kind && (entry.name ?? entry.id) === name);
}

async function cleanupFaultNode(containerName, context, serverId, configPath) {
  const inspected = await inspectContainer(
    containerName,
    faultComponent,
    context.runId,
    true,
    serverId,
  );
  let loopDevice = null;
  if (inspected) {
    const cleanupMode = faultNodeCleanupMode(inspected);
    if (cleanupMode === 'physical') {
      const loop = await dockerResult([
        'exec',
        containerName,
        'cat',
        '/var/lib/nyabase-e2e/loop-device',
      ]);
      if (loop.code === 0) {
        invariant(
          /^\/dev\/loop\d+$/.test(loop.stdout),
          'fault node loop device evidence is invalid',
        );
        loopDevice = loop.stdout;
      }
      await docker(['exec', containerName, '/usr/local/libexec/nyabase-e2e/cleanup-node'], {
        timeout: 60_000,
      });
    }
    await docker(['rm', '-f', containerName]);
  }
  await rm(configPath, { force: true });
  invariant(
    (await inspectContainer(containerName, faultComponent, context.runId, true, serverId)) === null,
    'provider fault node remains after restore',
  );
  const manifest = JSON.parse(await readFile(join(runtimeDir, 'manifest.json'), 'utf8'));
  if (manifestHasResourceIdentity(manifest, 'container', containerName)) {
    await retireManifestResource('container', containerName, context.runId);
  }
  if (loopDevice) {
    invariant(
      (await commandResult('losetup', [loopDevice])).code !== 0,
      `provider fault node leaked ${loopDevice}`,
    );
  }
}

async function injectDuplicateClaim(input, context, identity) {
  invariant(
    (await inspectContainer(
      identity.containerName,
      faultComponent,
      context.runId,
      true,
      input.serverId,
    )) === null,
    'duplicate claim fault node already exists',
  );
  await assertOuterIpFree(context.state, identity.outerIp);
  const agentsInfo = await lstat(dirname(identity.configPath));
  invariant(
    agentsInfo.isDirectory() && !agentsInfo.isSymbolicLink(),
    'Agent config directory is invalid',
  );
  invariant((agentsInfo.mode & 0o077) === 0, 'Agent config directory must be private');
  const yaml = [
    'backendUrl: "wss://edge/ws/agent"',
    `agentToken: ${JSON.stringify(input.agentToken)}`,
    `serverId: ${JSON.stringify(input.serverId)}`,
    'dockerRoot: "/var/lib/nyabase-docker"',
    'parentIface: "eth0"',
    `macvlanCidr: ${JSON.stringify(context.state.NYABASE_E2E_SUBNET)}`,
    `macvlanGateway: ${JSON.stringify(context.state.NYABASE_E2E_GATEWAY)}`,
    'reservedIps:',
    `  - ${JSON.stringify(identity.conflictingAddress)}`,
    'metricsIntervalMs: 5000',
    'isGpuServer: false',
    'dockerResourceLimit:',
    '  enabled: false',
    'localDataSources:',
    `  - id: ${JSON.stringify(`${context.runId}-fault-duplicate-local`)}`,
    '    mountPoint: "/data/nyabase"',
    '    label: "E2E duplicate network claim fault"',
    '',
  ].join('\n');

  await recordManifestResource(
    'provider-fault',
    `duplicate-network-claim:${input.serverId}`,
    context.runId,
  );
  await recordManifestResource('product-server', input.serverId, context.runId);
  await recordManifestResource('container', identity.containerName, context.runId);
  await writeFile(identity.configPath, yaml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(identity.configPath, 0o600);
  try {
    await docker(duplicateFaultDockerRunArgs(input, context, identity), { timeout: 60_000 });
    await inspectContainer(
      identity.containerName,
      faultComponent,
      context.runId,
      false,
      input.serverId,
    );
    await waitForSystemd(identity.containerName);
    await docker(
      [
        'exec',
        '-e',
        'NYABASE_E2E_NODE_ID=node1',
        '-e',
        `NYABASE_E2E_RUN_ID=${context.runId}`,
        identity.containerName,
        '/usr/local/libexec/nyabase-e2e/setup-node',
      ],
      { timeout: 75_000 },
    );
  } catch (error) {
    try {
      // `docker run` may create a labelled container and then fail during OCI
      // start. Re-inspect on every failure instead of trusting command success
      // as the resource-ownership boundary.
      await cleanupFaultNode(identity.containerName, context, input.serverId, identity.configPath);
    } catch (cleanupError) {
      throw aggregateErrorWithDiagnostics('duplicate claim injection and cleanup failed', [
        error,
        cleanupError,
      ]);
    }
    throw error;
  }
}

async function controlDuplicateNetworkClaim(input, context) {
  const identity = duplicateFaultIdentity(context);
  if (input.action === 'inject') await injectDuplicateClaim(input, context, identity);
  if (input.action === 'restore') {
    await cleanupFaultNode(identity.containerName, context, input.serverId, identity.configPath);
  }
  const inspected = await inspectContainer(
    identity.containerName,
    faultComponent,
    context.runId,
    true,
    input.serverId,
  );
  const present = inspected !== null;
  invariant(
    input.action !== 'inject' || present,
    'duplicate claim fault node is absent after injection',
  );
  invariant(
    input.action !== 'restore' || !present,
    'duplicate claim fault node remains after restore',
  );
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    containerName: identity.containerName,
    serverId: input.serverId,
    conflictingAddress: identity.conflictingAddress,
    present,
    serviceActive: present ? await serviceActive(identity.containerName) : false,
    observedAt: new Date().toISOString(),
  };
}

function wireControlIdentity(input, context) {
  return {
    containerName: `${context.state.NYABASE_E2E_PREFIX}-${input.nodeKey}`,
    statePath: join(runtimeDir, 'agents', `fault-agent-task-wire-${input.nodeKey}.json`),
    comment: `nyabase-e2e-${context.runId}-agent-task-wire-${input.nodeKey}`,
    unitPath: `/etc/systemd/system/${wireProxyUnit}`,
    scriptPath: `${wireProxyRoot}/proxy.mjs`,
    configPath: `${wireProxyRoot}/config.json`,
    evidencePath: `${wireProxyRoot}/evidence.json`,
    releasePath: `${wireProxyRoot}/release`,
    certificatePath: `${wireProxyRoot}/edge.crt`,
    privateKeyPath: `${wireProxyRoot}/edge.key`,
  };
}

function wireControlState(input, identity) {
  return {
    version: 1,
    runId: input.runId,
    nodeKey: input.nodeKey,
    mode: input.mode,
    taskId: input.taskId,
    payloadHash: input.payloadHash,
    comment: identity.comment,
    listenPort: wireProxyPort,
  };
}

async function readWireControlState(statePath, expected) {
  let info;
  try {
    info = await lstat(statePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  invariant(
    info.isFile() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o077) === 0,
    'Agent task wire control state is not a private regular file',
  );
  const value = JSON.parse(await readFile(statePath, 'utf8'));
  assertExactKeys(value, [
    'version',
    'runId',
    'nodeKey',
    'mode',
    'taskId',
    'payloadHash',
    'comment',
    'listenPort',
  ]);
  for (const key of Object.keys(expected)) {
    invariant(value[key] === expected[key], `Agent task wire control state ${key} mismatch`);
  }
  return value;
}

async function publishWireControlState(statePath, value) {
  const parent = await lstat(dirname(statePath));
  invariant(
    parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0,
    'Agent task wire control directory is not private',
  );
  await writeFile(statePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(statePath, 0o600);
}

function wireRuleArgs(identity, operation) {
  return [
    'exec',
    identity.containerName,
    'iptables',
    '--wait',
    '5',
    '-t',
    'nat',
    `-${operation}`,
    'OUTPUT',
    '-p',
    'tcp',
    '-d',
    identity.edgeIp,
    '--dport',
    '443',
    '-m',
    'comment',
    '--comment',
    identity.comment,
    '-j',
    'REDIRECT',
    '--to-ports',
    String(wireProxyPort),
  ];
}

async function wireRouteActive(identity) {
  return (await dockerResult(wireRuleArgs(identity, 'C'))).code === 0;
}

async function wireProxyActive(containerName) {
  const result = await dockerResult([
    'exec',
    containerName,
    'systemctl',
    'is-active',
    wireProxyUnit,
  ]);
  return result.code === 0 && result.stdout === 'active';
}

async function wireReleasePublished(identity) {
  if (!(await pathExists(identity.containerName, identity.releasePath))) return false;
  invariant(
    (await dockerResult(['exec', identity.containerName, 'test', '!', '-L', identity.releasePath]))
      .code === 0,
    'Agent task wire release became a symlink',
  );
  const releaseStat = await docker([
    'exec',
    identity.containerName,
    'stat',
    '-c',
    '%F|%u|%g|%a',
    identity.releasePath,
  ]);
  invariant(
    releaseStat === 'regular empty file|0|0|600',
    'Agent task wire release ownership changed',
  );
  return true;
}

async function wirePortActive(containerName) {
  const result = await dockerResult(['exec', containerName, 'ss', '-H', '-ltn']);
  invariant(result.code === 0, 'could not inspect Agent task wire listener ownership');
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .some((line) => line.split(/\s+/).some((field) => field.endsWith(`:${wireProxyPort}`)));
}

async function wireRuleLines(identity) {
  const result = await dockerResult(['exec', identity.containerName, 'iptables-save', '-t', 'nat']);
  invariant(result.code === 0, 'could not inspect Agent task wire route ownership');
  return result.stdout
    .split('\n')
    .filter(
      (line) => line.includes(identity.comment) || line.includes(`--to-ports ${wireProxyPort}`),
    );
}

async function assertNoWireResidual(identity) {
  invariant(
    !(await pathExists(identity.containerName, wireProxyRoot)),
    'Agent task wire root already exists',
  );
  invariant(
    !(await pathExists(identity.containerName, identity.unitPath)),
    'Agent task wire unit already exists',
  );
  invariant(
    !(await wireProxyActive(identity.containerName)),
    'Agent task wire unit is already active',
  );
  invariant(
    !(await wirePortActive(identity.containerName)),
    'Agent task wire port is already occupied',
  );
  invariant((await wireRuleLines(identity)).length === 0, 'Agent task wire route already exists');
}

async function assertOwnedWireFiles(identity) {
  if (!(await pathExists(identity.containerName, wireProxyRoot))) return;
  const rootStat = await docker([
    'exec',
    identity.containerName,
    'stat',
    '-c',
    '%F|%u|%g|%a',
    wireProxyRoot,
  ]);
  invariant(rootStat === 'directory|0|0|700', 'Agent task wire root ownership changed');
  const children = (
    await docker([
      'exec',
      identity.containerName,
      'find',
      wireProxyRoot,
      '-mindepth',
      '1',
      '-maxdepth',
      '1',
      '-printf',
      '%f|%y\n',
    ])
  )
    .split('\n')
    .filter(Boolean);
  const fixedNames = new Set([
    'proxy.mjs',
    'config.json',
    'evidence.json',
    'release',
    'edge.crt',
    'edge.key',
  ]);
  for (const child of children) {
    const separator = child.lastIndexOf('|');
    const name = child.slice(0, separator);
    const kind = child.slice(separator + 1);
    invariant(
      kind === 'f' && (fixedNames.has(name) || /^evidence\.json\.tmp-\d+$/.test(name)),
      'Agent task wire root contains an unowned entry',
    );
  }
  if (await pathExists(identity.containerName, identity.unitPath)) {
    const unitStat = await docker([
      'exec',
      identity.containerName,
      'stat',
      '-c',
      '%F|%u|%g',
      identity.unitPath,
    ]);
    invariant(unitStat === 'regular file|0|0', 'Agent task wire unit ownership changed');
  }
}

function emptyWireEvidence(input) {
  return {
    version: 1,
    runId: input.runId,
    nodeKey: input.nodeKey,
    mode: input.mode,
    taskId: input.taskId,
    payloadHash: input.payloadHash,
    executeCount: 0,
    terminalCount: 0,
    droppedCount: 0,
    mutatedCount: 0,
    forwardedTerminalCount: 0,
    firstExecuteAt: null,
    lastExecuteAt: null,
    firstTerminalAt: null,
    lastForwardedTerminalAt: null,
  };
}

async function readWireEvidence(input, identity, optional = false) {
  if (!(await pathExists(identity.containerName, identity.evidencePath))) {
    invariant(optional, 'Agent task wire evidence is absent');
    return emptyWireEvidence(input);
  }
  const stat = await docker([
    'exec',
    identity.containerName,
    'stat',
    '-c',
    '%F|%u|%g|%a',
    identity.evidencePath,
  ]);
  invariant(stat === 'regular file|0|0|600', 'Agent task wire evidence ownership changed');
  const value = JSON.parse(
    await docker(['exec', identity.containerName, 'cat', identity.evidencePath]),
  );
  assertExactKeys(value, Object.keys(emptyWireEvidence(input)));
  for (const key of ['runId', 'nodeKey', 'mode', 'taskId', 'payloadHash']) {
    invariant(value[key] === input[key], `Agent task wire evidence ${key} mismatch`);
  }
  for (const key of [
    'executeCount',
    'terminalCount',
    'droppedCount',
    'mutatedCount',
    'forwardedTerminalCount',
  ]) {
    invariant(
      Number.isSafeInteger(value[key]) && value[key] >= 0,
      `Agent task wire evidence ${key} is invalid`,
    );
  }
  invariant(
    value.droppedCount <= 1 && value.mutatedCount <= 1,
    'Agent task wire mutated more than once',
  );
  for (const key of [
    'firstExecuteAt',
    'lastExecuteAt',
    'firstTerminalAt',
    'lastForwardedTerminalAt',
  ]) {
    invariant(
      value[key] === null ||
        (typeof value[key] === 'string' && !Number.isNaN(Date.parse(value[key]))),
      `Agent task wire evidence ${key} is invalid`,
    );
  }
  return value;
}

async function writeContainerFile(containerName, path, content, mode) {
  await commandWithInput(
    'docker',
    ['exec', '-i', containerName, 'dd', `of=${path}`, 'status=none'],
    content,
  );
  await docker(['exec', containerName, 'chown', 'root:root', path]);
  await docker(['exec', containerName, 'chmod', mode, path]);
}

async function waitForWireProxy(input, identity) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      (await wireProxyActive(identity.containerName)) &&
      (await wirePortActive(identity.containerName)) &&
      (await pathExists(identity.containerName, identity.evidencePath))
    ) {
      return readWireEvidence(input, identity);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('Agent task wire proxy did not become ready');
}

async function installWireProxy(input, context, identity) {
  await docker([
    'exec',
    identity.containerName,
    'install',
    '-d',
    '-m',
    '0700',
    '-o',
    'root',
    '-g',
    'root',
    wireProxyRoot,
  ]);
  await docker([
    'cp',
    join(orchestratorDir, 'agent-task-wire-proxy.mjs'),
    `${identity.containerName}:${identity.scriptPath}`,
  ]);
  await docker([
    'cp',
    join(runtimeDir, 'certs', 'edge.crt'),
    `${identity.containerName}:${identity.certificatePath}`,
  ]);
  await docker([
    'cp',
    join(runtimeDir, 'certs', 'edge.key'),
    `${identity.containerName}:${identity.privateKeyPath}`,
  ]);
  for (const [path, mode] of [
    [identity.scriptPath, '0700'],
    [identity.certificatePath, '0600'],
    [identity.privateKeyPath, '0600'],
  ]) {
    await docker(['exec', identity.containerName, 'chown', 'root:root', path]);
    await docker(['exec', identity.containerName, 'chmod', mode, path]);
  }
  const config = {
    version: 1,
    runId: context.runId,
    nodeKey: input.nodeKey,
    mode: input.mode,
    taskId: input.taskId,
    payloadHash: input.payloadHash,
    gatewayIp: context.state.NYABASE_E2E_GATEWAY_IP,
    listenPort: wireProxyPort,
  };
  await writeContainerFile(
    identity.containerName,
    identity.configPath,
    `${JSON.stringify(config)}\n`,
    '0600',
  );
  const unit = [
    '[Unit]',
    'Description=nyabase E2E exact Agent task wire fault',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'User=root',
    `ExecStart=/usr/local/bin/node ${identity.scriptPath}`,
    'Restart=on-failure',
    'RestartSec=1',
    'NoNewPrivileges=true',
    'StandardOutput=null',
    'StandardError=null',
    '',
  ].join('\n');
  await writeContainerFile(identity.containerName, identity.unitPath, unit, '0644');
  await docker(['exec', identity.containerName, 'systemctl', 'daemon-reload']);
  await docker(['exec', identity.containerName, 'systemctl', 'start', wireProxyUnit]);
  await waitForWireProxy(input, identity);
  await docker(wireRuleArgs(identity, 'A'));
  invariant(await wireRouteActive(identity), 'Agent task wire route was not installed');
}

async function cleanupWireProxy(identity) {
  await assertOwnedWireFiles(identity);
  const routeLines = await wireRuleLines(identity);
  invariant(
    routeLines.every((line) => line.includes(identity.comment)),
    'Agent task wire port is owned by a different route',
  );
  await dockerResult(['exec', identity.containerName, 'systemctl', 'stop', wireProxyUnit]);
  while (await wireRouteActive(identity)) await docker(wireRuleArgs(identity, 'D'));
  invariant(
    (await wireRuleLines(identity)).length === 0,
    'Agent task wire route remains after restore',
  );
  if (await pathExists(identity.containerName, identity.unitPath)) {
    await docker(['exec', identity.containerName, 'rm', '-f', '--', identity.unitPath]);
  }
  if (await pathExists(identity.containerName, wireProxyRoot)) {
    await docker(['exec', identity.containerName, 'rm', '-rf', '--', wireProxyRoot]);
  }
  await docker(['exec', identity.containerName, 'systemctl', 'daemon-reload']);
  await assertNoWireResidual(identity);
}

async function restoreWireProxy(input, context, identity, hasState) {
  let evidence = emptyWireEvidence(input);
  const errors = [];
  if (hasState) {
    try {
      evidence = await readWireEvidence(input, identity, true);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    if (hasState) {
      if (await serviceActive(identity.containerName)) {
        await setAgentService(identity.containerName, 'stop');
      }
      await cleanupWireProxy(identity);
      await rm(identity.statePath, { force: true });
    } else {
      await assertNoWireResidual(identity);
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await setAgentService(identity.containerName, 'start');
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw aggregateErrorWithDiagnostics('Agent task wire restore failed', errors);
  }
  return evidence;
}

async function controlAgentTaskWire(input, context) {
  const identity = {
    ...wireControlIdentity(input, context),
    edgeIp: context.state.NYABASE_E2E_EDGE_IP,
  };
  const inspected = await inspectContainer(identity.containerName, input.nodeKey, context.runId);
  invariant(inspected?.State?.Running === true, `node ${input.nodeKey} is not running`);
  const expectedState = wireControlState(input, identity);
  let state = await readWireControlState(identity.statePath, expectedState);
  await recordManifestResource(
    'provider-fault',
    `agent-task-wire:${input.nodeKey}:${input.taskId}:${input.mode}`,
    context.runId,
  );

  let evidence = emptyWireEvidence(input);
  if (input.action === 'inject') {
    invariant(state === null, 'Agent task wire fault is already owned');
    invariant(
      !(await serviceActive(identity.containerName)),
      'Agent must be inactive before wire fault injection',
    );
    await assertNoWireResidual(identity);
    await publishWireControlState(identity.statePath, expectedState);
    state = expectedState;
    try {
      await installWireProxy(input, context, identity);
      await setAgentService(identity.containerName, 'start');
      evidence = await readWireEvidence(input, identity);
    } catch (error) {
      try {
        await restoreWireProxy(input, context, identity, true);
      } catch (cleanupError) {
        throw aggregateErrorWithDiagnostics('Agent task wire injection and restore both failed', [
          error,
          cleanupError,
        ]);
      }
      throw error;
    }
  } else if (input.action === 'restore') {
    evidence = await restoreWireProxy(input, context, identity, state !== null);
    state = null;
  } else {
    invariant(state !== null, 'Agent task wire fault has no owned control state');
    evidence = await readWireEvidence(input, identity);
    if (input.action === 'release') {
      invariant(
        input.mode === 'drop-terminal-once' || input.mode === 'hold-terminal-until-release',
        'only a dropped or held terminal can be released',
      );
      invariant(evidence.droppedCount === 1, 'exact terminal was not dropped before release');
      if (!(await pathExists(identity.containerName, identity.releasePath))) {
        await docker([
          'exec',
          identity.containerName,
          'install',
          '-m',
          '0600',
          '-o',
          'root',
          '-g',
          'root',
          '/dev/null',
          identity.releasePath,
        ]);
      }
      invariant(await wireReleasePublished(identity), 'Agent task wire release was not published');
    }
  }

  const proxyActive = await wireProxyActive(identity.containerName);
  const routeActive = await wireRouteActive(identity);
  const released = await wireReleasePublished(identity);
  const active = await serviceActive(identity.containerName);
  if (input.action === 'restore') {
    invariant(
      !proxyActive && !routeActive && !released,
      'Agent task wire path remains after restore',
    );
    invariant(active, 'Agent is inactive after Agent task wire restore');
  } else {
    invariant(proxyActive && routeActive && active, 'Agent task wire fault is not fully active');
  }
  if (input.action === 'release') invariant(released, 'Agent task wire release was not published');
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    mode: input.mode,
    nodeKey: input.nodeKey,
    containerName: identity.containerName,
    taskId: input.taskId,
    payloadHash: input.payloadHash,
    serviceActive: active,
    proxyActive,
    routeActive,
    released,
    executeCount: evidence.executeCount,
    terminalCount: evidence.terminalCount,
    droppedCount: evidence.droppedCount,
    mutatedCount: evidence.mutatedCount,
    forwardedTerminalCount: evidence.forwardedTerminalCount,
    firstExecuteAt: evidence.firstExecuteAt,
    lastExecuteAt: evidence.lastExecuteAt,
    firstTerminalAt: evidence.firstTerminalAt,
    lastForwardedTerminalAt: evidence.lastForwardedTerminalAt,
    observedAt: new Date().toISOString(),
  };
}

async function readAgents() {
  const value = JSON.parse(await readFile(join(runtimeDir, 'agents.json'), 'utf8'));
  invariant(
    Array.isArray(value?.agents) && value.agents.length === 2,
    'run Agent manifest is invalid',
  );
  return value.agents;
}

export function managedRuntimeInspectIsAbsent(result, runtimeId) {
  const diagnostics = `${String(result?.stdout ?? '')}\n${String(result?.stderr ?? '')}`;
  const escapedRuntimeId = runtimeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:No such (?:object|container):\\s*|404[^\\n]*Not Found[^\\n]*)${escapedRuntimeId}(?:\\s|$)`,
    'i',
  ).test(diagnostics);
}

async function inspectInnerRuntime(containerName, runtimeId, optional = false) {
  const deadline = Date.now() + 30_000;
  let lastResult = null;
  while (Date.now() < deadline) {
    const result = await dockerResult([
      'exec',
      containerName,
      '/usr/bin/docker',
      '--host',
      'unix:///run/nyabase-agent/docker.sock',
      'inspect',
      runtimeId,
    ]);
    if (result.code === 0) {
      const parsed = JSON.parse(result.stdout);
      invariant(
        Array.isArray(parsed) && parsed.length === 1,
        'managed runtime identity is ambiguous',
      );
      return parsed[0];
    }
    if (managedRuntimeInspectIsAbsent(result, runtimeId)) {
      if (optional) return null;
      throw new Error(`managed runtime ${runtimeId} does not exist`);
    }
    lastResult = result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  const diagnostics = [lastResult?.stderr, lastResult?.stdout]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' | ');
  throw new Error(
    `managed runtime ${runtimeId} inspect remained unavailable after 30000ms` +
      (diagnostics ? `: ${diagnostics}` : ''),
  );
}

function assertManagedRuntimeIdentity(runtime, input, serverId) {
  const labels = runtime?.Config?.Labels ?? {};
  invariant(runtime?.Id === input.runtimeId, 'managed runtime immutable Docker identity changed');
  invariant(labels['nyabase.managed'] === 'true', 'runtime is not nyabase-managed');
  invariant(
    labels['nyabase.container_id'] === input.containerId,
    'runtime product container label mismatch',
  );
  invariant(labels['nyabase.server_id'] === serverId, 'runtime Server label mismatch');
  invariant(
    typeof labels['nyabase.spec_generation'] === 'string' &&
      /^[1-9]\d{0,19}$/.test(labels['nyabase.spec_generation']),
    'runtime spec generation label is invalid',
  );
  invariant(
    typeof labels['nyabase.runtime_spec_hash'] === 'string' &&
      /^[a-f0-9]{64}$/.test(labels['nyabase.runtime_spec_hash']),
    'runtime spec hash label is invalid',
  );
}

async function controlContainerRuntimeDrift(input, context) {
  const containerName = `${context.state.NYABASE_E2E_PREFIX}-${input.nodeKey}`;
  const inspectedNode = await inspectContainer(containerName, input.nodeKey, context.runId);
  invariant(inspectedNode?.State?.Running === true, `node ${input.nodeKey} is not running`);
  const agents = await readAgents();
  const agent = agents.find((candidate) => candidate?.key === input.nodeKey);
  invariant(
    agent &&
      typeof agent.serverId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agent.serverId),
    `run Agent identity is missing for ${input.nodeKey}`,
  );
  await recordManifestResource(
    'provider-fault',
    `container-runtime-drift:${input.nodeKey}:${input.containerId}:${input.runtimeId}`,
    context.runId,
  );
  const before = await inspectInnerRuntime(
    containerName,
    input.runtimeId,
    input.action === 'probe',
  );
  if (before) assertManagedRuntimeIdentity(before, input, agent.serverId);
  if (input.action === 'remove') {
    invariant(before, 'managed runtime is already absent before drift injection');
    await docker(
      [
        'exec',
        containerName,
        '/usr/bin/docker',
        '--host',
        'unix:///run/nyabase-agent/docker.sock',
        'rm',
        '--force',
        input.runtimeId,
      ],
      { timeout: 45_000 },
    );
  } else if (input.action === 'stop') {
    invariant(before, 'managed runtime is already absent before power-race injection');
    await docker(
      [
        'exec',
        containerName,
        '/usr/bin/docker',
        '--host',
        'unix:///run/nyabase-agent/docker.sock',
        'stop',
        '--time',
        '30',
        input.runtimeId,
      ],
      { timeout: 45_000 },
    );
  } else if (input.action === 'start') {
    invariant(before, 'managed runtime is absent before power-race restoration');
    await docker(
      [
        'exec',
        containerName,
        '/usr/bin/docker',
        '--host',
        'unix:///run/nyabase-agent/docker.sock',
        'start',
        input.runtimeId,
      ],
      { timeout: 45_000 },
    );
  }
  const after = await inspectInnerRuntime(containerName, input.runtimeId, true);
  if (after) assertManagedRuntimeIdentity(after, input, agent.serverId);
  const physicalAbsent = after === null;
  const physicalRunning = after?.State?.Running === true;
  invariant(
    input.action !== 'remove' || physicalAbsent,
    'managed runtime remains after drift injection',
  );
  invariant(
    input.action !== 'stop' || (!physicalAbsent && !physicalRunning),
    'managed runtime did not stop',
  );
  invariant(input.action !== 'start' || physicalRunning, 'managed runtime did not start');
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    nodeKey: input.nodeKey,
    containerName,
    containerId: input.containerId,
    runtimeId: input.runtimeId,
    serverId: agent.serverId,
    physicalAbsent,
    physicalRunning,
    observedAt: new Date().toISOString(),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function waitForBackendHealthy(context, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const caPath = join(runtimeDir, 'certs', 'ca.crt');
  while (Date.now() < deadline) {
    const result = await commandResult(
      'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '5',
        '--cacert',
        caPath,
        `${context.state.NYABASE_E2E_PUBLIC_URL}/api/public/settings`,
      ],
      { timeout: 10_000 },
    );
    if (result.code === 0) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('Backend did not become healthy through the run TLS edge');
}

async function backendSnapshot(context, requestedRole = 'all') {
  const roles = requestedRole === 'all' ? ['api', 'gateway', 'worker'] : [requestedRole];
  const runtimes = [];
  for (const role of roles) {
    invariant(['api', 'gateway', 'worker'].includes(role), 'invalid split runtime role');
    const containerName = `${context.state.NYABASE_E2E_PREFIX}-backend-${role}-1`;
    const result = await dockerResult(['inspect', containerName]);
    invariant(result.code === 0, `run-owned ${role} runtime ${containerName} does not exist`);
    const parsed = JSON.parse(result.stdout);
    invariant(Array.isArray(parsed) && parsed.length === 1, `${role} identity is ambiguous`);
    const container = parsed[0];
    const labels = container?.Config?.Labels ?? {};
    invariant(container?.Name === `/${containerName}`, `${role} canonical name mismatch`);
    invariant(
      labels['io.nyabase.e2e.run-id'] === context.runId &&
        labels['io.nyabase.e2e.managed'] === 'true' &&
        labels['com.docker.compose.service'] === `backend-${role}`,
      `${role} ownership labels mismatch`,
    );
    invariant(container?.State?.Running === true, `${role} container is not running`);
    invariant(/^[a-f0-9]{64}$/.test(container.Id ?? ''), `${role} container ID is invalid`);
    invariant(
      typeof container.State.StartedAt === 'string' &&
        !Number.isNaN(Date.parse(container.State.StartedAt)),
      `${role} StartedAt is invalid`,
    );
    invariant(
      (container.Config.Env ?? []).includes(`NYABASE_RUNTIME_ROLE=${role}`),
      `${role} runtime role fingerprint mismatch`,
    );
    const clockEntry = (container.Config.Env ?? []).find((entry) =>
      entry.startsWith('NYABASE_E2E_CLOCK_OFFSET_MS='),
    );
    const offsetMs = Number(clockEntry?.slice(clockEntry.indexOf('=') + 1) ?? 0);
    invariant(
      offsetMs === 0 || offsetMs === advancedClockOffsetMs,
      `${role} clock offset is outside the closed provider vocabulary`,
    );
    runtimes.push({
      role,
      containerName,
      containerId: container.Id,
      generation: sha256(`${container.Id}\n${container.State.StartedAt}\n${offsetMs}\n`),
      offsetMs,
    });
  }
  const generation = sha256(
    runtimes.map((runtime) => `${runtime.role}:${runtime.generation}`).join('\n'),
  );
  return {
    role: requestedRole,
    containerName:
      requestedRole === 'all'
        ? `${context.state.NYABASE_E2E_PREFIX}-split-control-plane`
        : runtimes[0].containerName,
    containerId: sha256(runtimes.map((runtime) => runtime.containerId).join('\n')),
    generation,
    offsetMs: runtimes[0].offsetMs,
    runtimes,
  };
}

async function controlBackendService(input, context) {
  const role = input.role ?? 'all';
  const before = backendSnapshot(context, role);
  const beforeSnapshot = await before;
  await waitForBackendHealthy(context);
  await recordManifestResource('provider-fault', `backend-service:${role}:restart`, context.runId);
  if (input.action === 'restart') {
    await docker(
      [
        'restart',
        '--time',
        '30',
        ...beforeSnapshot.runtimes.map((runtime) => runtime.containerName),
      ],
      { timeout: 120_000 },
    );
  }
  await waitForBackendHealthy(context);
  const after = await backendSnapshot(context, role);
  invariant(
    input.action !== 'restart' || beforeSnapshot.generation !== after.generation,
    'Backend restart did not change its process generation',
  );
  invariant(
    beforeSnapshot.runtimes.every(
      (runtime, index) => runtime.containerId === after.runtimes[index]?.containerId,
    ),
    'Backend restart unexpectedly replaced a durable Compose container',
  );
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    role,
    containerName: after.containerName,
    containerId: after.containerId,
    runtimes: after.runtimes,
    before: { generation: beforeSnapshot.generation, healthy: true },
    after: { generation: after.generation, healthy: true },
    restarted: input.action === 'restart',
    observedAt: new Date().toISOString(),
  };
}

async function controlBackendClock(input, context) {
  const expectedOffset = input.action === 'advance' ? advancedClockOffsetMs : 0;
  if (input.action !== 'probe') await assertComposeEnv(context);
  await recordManifestResource('provider-fault', `backend-clock:${expectedOffset}`, context.runId);
  if (input.action !== 'probe') {
    await command(
      'docker',
      [
        'compose',
        '--project-name',
        context.state.NYABASE_E2E_PROJECT,
        '--env-file',
        join(runtimeDir, 'compose.env'),
        '-f',
        join(repositoryRoot, 'e2e', 'topology', 'docker-dind', 'compose.yaml'),
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        'backend-api',
        'backend-gateway',
        'backend-worker',
      ],
      {
        timeout: 120_000,
        env: composeProcessEnvironment({
          NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS: String(expectedOffset),
        }),
      },
    );
  }
  await waitForBackendHealthy(context);
  const snapshot = await backendSnapshot(context, 'all');
  invariant(
    input.action === 'probe' || snapshot.offsetMs === expectedOffset,
    'Backend clock recreation did not apply the requested fixed offset',
  );
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    containerName: snapshot.containerName,
    offsetMs: snapshot.offsetMs,
    generation: snapshot.generation,
    healthy: true,
    observedAt: new Date().toISOString(),
  };
}

async function dependencySnapshot(context, service) {
  const containerName = `${context.state.NYABASE_E2E_PREFIX}-${service}-1`;
  const result = await dockerResult(['inspect', containerName]);
  invariant(result.code === 0, `run-owned ${service} ${containerName} does not exist`);
  const [container] = JSON.parse(result.stdout);
  const labels = container?.Config?.Labels ?? {};
  invariant(
    container?.Name === `/${containerName}` &&
      labels['io.nyabase.e2e.run-id'] === context.runId &&
      labels['io.nyabase.e2e.managed'] === 'true' &&
      labels['com.docker.compose.service'] === service,
    `${service} dependency ownership mismatch`,
  );
  invariant(/^[a-f0-9]{64}$/.test(container.Id ?? ''), `${service} container ID is invalid`);
  const startedAt = container.State?.StartedAt;
  const running = container.State?.Running === true;
  const healthy = running && container.State?.Health?.Status === 'healthy';
  return {
    containerName,
    containerId: container.Id,
    generation: sha256(`${container.Id}\n${startedAt}\n`),
    running,
    healthy,
  };
}

async function waitForDependency(context, service, expectedHealthy, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await dependencySnapshot(context, service);
    if (snapshot.healthy === expectedHealthy) return snapshot;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${service} did not reach expected health=${expectedHealthy}`);
}

async function controlRedisService(input, context) {
  await recordManifestResource('provider-fault', `redis:${input.action}`, context.runId);
  const before = await dependencySnapshot(context, 'redis');
  invariant(
    input.action === 'restart' || before.healthy,
    'Redis must be healthy before stop, flush, or probe fault control',
  );
  let redisContract =
    input.action === 'stop' ? await inspectRedisContract(before, context.runId) : null;
  if (input.action === 'flush') {
    await docker([
      'exec',
      before.containerName,
      'sh',
      '-ec',
      'REDISCLI_AUTH="$0" redis-cli FLUSHALL >/dev/null',
      context.runId,
    ]);
  } else if (input.action === 'stop') {
    await docker(['stop', '--time', '30', before.containerName], { timeout: 60_000 });
  } else if (input.action === 'restart') {
    await docker(['restart', '--time', '30', before.containerName], { timeout: 60_000 });
  }
  const after = await waitForDependency(context, 'redis', input.action !== 'stop');
  redisContract ??= await inspectRedisContract(after, context.runId);
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    containerName: after.containerName,
    containerId: after.containerId,
    generation: after.generation,
    running: after.running,
    healthy: after.healthy,
    keyCount: redisContract.keyCount,
    flushed: input.action === 'flush',
    persistenceDisabled: true,
    observedAt: new Date().toISOString(),
  };
}

async function inspectRedisContract(snapshot, password) {
  invariant(snapshot.healthy, 'Redis contract inspection requires a healthy service');
  const redisConfig = await docker([
    'exec',
    snapshot.containerName,
    'sh',
    '-ec',
    'REDISCLI_AUTH="$0" redis-cli --raw CONFIG GET save; REDISCLI_AUTH="$0" redis-cli --raw CONFIG GET appendonly; REDISCLI_AUTH="$0" redis-cli --raw DBSIZE',
    password,
  ]);
  const lines = redisConfig.split('\n');
  invariant(
    lines[0] === 'save' &&
      lines[1] === '' &&
      lines[2] === 'appendonly' &&
      lines[3] === 'no' &&
      /^[0-9]+$/.test(lines[4] ?? ''),
    'Redis disposable-cache contract mismatch',
  );
  return {
    keyCount: Number(lines[4]),
  };
}

async function controlTelemetryService(input, context) {
  await recordManifestResource(
    'provider-fault',
    `telemetry:${input.service}:${input.action}`,
    context.runId,
  );
  const before = await dependencySnapshot(context, input.service);
  if (input.action === 'stop' && before.running) {
    await docker(['stop', '--time', '30', before.containerName], { timeout: 60_000 });
  } else if (input.action === 'start' && !before.running) {
    await docker(['start', before.containerName], { timeout: 60_000 });
  } else if (input.action === 'restart') {
    await docker(['restart', '--time', '30', before.containerName], { timeout: 60_000 });
  }
  const expectedHealthy = input.action !== 'stop';
  const after = await waitForDependency(context, input.service, expectedHealthy);
  const queuePendingBytes =
    input.service === 'vmagent' && expectedHealthy
      ? await inspectVmagentQueue(after.containerName)
      : null;
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    service: input.service,
    action: input.action,
    containerName: after.containerName,
    containerId: after.containerId,
    generation: after.generation,
    healthy: after.healthy,
    queuePendingBytes,
    observedAt: new Date().toISOString(),
  };
}

async function inspectVmagentQueue(containerName) {
  const metrics = await docker([
    'exec',
    containerName,
    'wget',
    '-qO-',
    'http://127.0.0.1:8429/metrics',
  ]);
  return parseVmagentQueueMetrics(metrics);
}

export function parseVmagentQueueMetrics(metrics) {
  for (const metricName of [
    'vm_persistentqueue_bytes_pending',
    'vmagent_remotewrite_pending_data_bytes',
    'vmagent_remotewrite_pending_bytes',
  ]) {
    const values = metrics
      .split('\n')
      .map((line) => {
        const match = new RegExp(
          `^${metricName}(?:\\{.*\\})?\\s+([^\\s]+)(?:\\s|$)`,
        ).exec(line);
        return match ? Number(match[1]) : null;
      })
      .filter((value) => value !== null);
    if (values.length > 0) {
      invariant(
        values.every((value) => Number.isFinite(value) && value >= 0),
        `vmagent ${metricName} contains an invalid queue value`,
      );
      const total = values.reduce((sum, value) => sum + value, 0);
      invariant(
        Number.isSafeInteger(total),
        `vmagent ${metricName} exceeds the safe queue evidence range`,
      );
      return total;
    }
  }
  throw new Error('vmagent did not expose a recognized persistent-queue backlog metric');
}

async function dockerdSnapshot(containerName) {
  const show = await docker([
    'exec',
    containerName,
    'systemctl',
    'show',
    dockerUnit,
    '--property=ActiveState,SubState,MainPID,ActiveEnterTimestampMonotonic',
  ]);
  const properties = Object.fromEntries(
    show
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  invariant(
    properties.ActiveState === 'active' &&
      properties.SubState === 'running' &&
      /^[1-9]\d*$/.test(properties.MainPID ?? '') &&
      /^\d+$/.test(properties.ActiveEnterTimestampMonotonic ?? ''),
    'nyabase-managed dockerd is not active with a concrete systemd generation',
  );
  await docker([
    'exec',
    containerName,
    'docker',
    '--host',
    'unix:///run/nyabase-agent/docker.sock',
    'info',
    '--format',
    '{{.ServerVersion}}',
  ]);
  return {
    generation: sha256(`${properties.MainPID}\n${properties.ActiveEnterTimestampMonotonic}\n`),
    runtimeContainerIds: await runtimeContainerIds(containerName),
    activeRuntimeContainerIds: await runtimeContainerIds(containerName, true),
  };
}

async function waitForDockerd(containerName, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await dockerdSnapshot(containerName);
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  throw new Error('nyabase-managed dockerd did not recover within its provider deadline');
}

async function controlDockerdService(input, context) {
  const containerName = `${context.state.NYABASE_E2E_PREFIX}-${input.nodeKey}`;
  const inspected = await inspectContainer(containerName, input.nodeKey, context.runId);
  invariant(inspected?.State?.Running === true, `node ${input.nodeKey} is not running`);
  const before = await dockerdSnapshot(containerName);
  await recordManifestResource('provider-fault', `dockerd-service:${input.nodeKey}`, context.runId);
  if (input.action === 'restart') {
    const restart = await dockerResult(
      ['exec', containerName, 'systemctl', 'restart', dockerUnit],
      {
        timeout: 60_000,
      },
    );
    // Restart=always can win the final start transaction after systemctl has
    // already stopped the real daemon. systemd then reports the initiating
    // job as cancelled even though a new healthy generation is starting. This
    // exact result is an accepted race only because the generation and full
    // runtime identity set are independently verified below.
    invariant(
      restart.code === 0 ||
        (restart.code === 1 && restart.stderr === `Job for ${dockerUnit} canceled.`),
      `dockerd restart command failed unexpectedly: ${restart.stderr}`,
    );
  }
  const after = await waitForDockerd(containerName);
  invariant(
    JSON.stringify(before.runtimeContainerIds) === JSON.stringify(after.runtimeContainerIds),
    'dockerd restart changed the immutable managed runtime identity set',
  );
  invariant(
    input.action !== 'restart' || before.generation !== after.generation,
    'dockerd restart did not change its systemd process generation',
  );
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    nodeKey: input.nodeKey,
    containerName,
    beforeGeneration: before.generation,
    afterGeneration: after.generation,
    serviceActive: true,
    runtimeContainerIdsBefore: before.runtimeContainerIds,
    runtimeContainerIdsAfter: after.runtimeContainerIds,
    activeRuntimeContainerIdsAfter: after.activeRuntimeContainerIds,
    observedAt: new Date().toISOString(),
  };
}

async function controlDuplicateAgentSession(input, context) {
  const agents = await readAgents();
  const agent = agents.find((candidate) => candidate?.key === input.nodeKey);
  invariant(agent && typeof agent.serverId === 'string', 'Agent identity is absent');
  const configPath = resolve(agent.configPath ?? '');
  invariant(
    dirname(configPath) === join(runtimeDir, 'agents') &&
      configPath === join(runtimeDir, 'agents', `${input.nodeKey}.yaml`),
    'Agent config path escapes the current run',
  );
  const configInfo = await lstat(configPath);
  invariant(
    configInfo.isFile() && !configInfo.isSymbolicLink() && (configInfo.mode & 0o077) === 0,
    'Agent config is not a private regular file',
  );
  const config = await readFile(configPath, 'utf8');
  const token = config.match(/^agentToken:\s*"([a-f0-9]{64})"$/m)?.[1];
  const serverId = config.match(/^serverId:\s*"([^"\r\n]+)"$/m)?.[1];
  invariant(token && serverId === agent.serverId, 'Agent config identity mismatch');
  const ca = await readFile(join(runtimeDir, 'certs', 'ca.crt'));
  const { WebSocket } = requireFromBackend('ws');
  const url = new URL('/ws/agent', context.state.NYABASE_E2E_PUBLIC_URL);
  url.protocol = 'wss:';
  await recordManifestResource(
    'provider-fault',
    `duplicate-agent-session:${input.nodeKey}`,
    context.runId,
  );

  const observed = await new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-nyabase-e2e-run': context.runId,
      },
      ca,
      rejectUnauthorized: true,
      perMessageDeflate: false,
    });
    let opened = false;
    let admissionReceived = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        // already closed
      }
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(
      () => finish(new Error('duplicate Agent session was not fenced within 15 seconds')),
      15_000,
    );
    socket.once('open', () => {
      opened = true;
    });
    socket.on('message', (data) => {
      try {
        if (JSON.parse(data.toString())?.kind === 'admission.ready.v1') admissionReceived = true;
      } catch {
        // Any invalid response remains non-admission evidence.
      }
    });
    socket.once('close', () => {
      if (!opened) {
        finish(new Error('duplicate Agent probe did not complete a real WebSocket upgrade'));
        return;
      }
      if (admissionReceived) {
        finish(new Error('duplicate Agent session received authoritative admission'));
        return;
      }
      finish(null, { opened: true, admissionReceived: false, closed: true });
    });
    socket.once('error', (error) => {
      if (!opened) finish(error);
    });
  });
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    nodeKey: input.nodeKey,
    serverId: agent.serverId,
    ...observed,
    observedAt: new Date().toISOString(),
  };
}

const splitGatewayRaceComponent = 'provider-fault-split-gateway';
const splitGatewayRaceStateFile = 'split-gateway-session-race.json';
const splitGatewayRaceEdgeConfigFile = 'split-gateway-session-race-edge.conf';

function splitGatewayRaceIdentity(input, context) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(context.state.NYABASE_E2E_SUBNET);
  invariant(match, 'provider subnet is not a canonical /24');
  const prefix = `${match[1]}.${match[2]}.${match[3]}`;
  const secondaryEdgeHostPort = Number(
    context.state.NYABASE_E2E_SPLIT_GATEWAY_EDGE_PORT,
  );
  invariant(
    Number.isInteger(secondaryEdgeHostPort)
      && secondaryEdgeHostPort >= 1
      && secondaryEdgeHostPort <= 65_535,
    'split Gateway edge host port is invalid',
  );
  return {
    nodeContainer: `${context.state.NYABASE_E2E_PREFIX}-${input.nodeKey}`,
    primaryGatewayContainer: `${context.state.NYABASE_E2E_PREFIX}-backend-gateway-1`,
    secondaryGatewayContainer: `${context.state.NYABASE_E2E_PREFIX}-fault-gateway-b`,
    secondaryEdgeContainer: `${context.state.NYABASE_E2E_PREFIX}-fault-edge-b`,
    secondaryGatewayIp: `${prefix}.21`,
    secondaryEdgeIp: `${prefix}.22`,
    secondaryEdgeHostPort,
    secondaryEdgeHostPortResource: `tcp://127.0.0.1:${secondaryEdgeHostPort}`,
    secondaryConsoleUrl:
      `wss://localhost:${secondaryEdgeHostPort}/ws/console`,
    routeComment: `nyabase-e2e-${context.runId}-split-gateway`,
    statePath: join(runtimeDir, splitGatewayRaceStateFile),
    edgeConfigPath: join(runtimeDir, splitGatewayRaceEdgeConfigFile),
  };
}

function splitGatewayRouteArgs(identity, edgeIp, operation) {
  return [
    'exec',
    identity.nodeContainer,
    'iptables',
    '--wait',
    '5',
    '-t',
    'nat',
    `-${operation}`,
    'OUTPUT',
    '-p',
    'tcp',
    '-d',
    edgeIp,
    '--dport',
    '443',
    '-m',
    'comment',
    '--comment',
    identity.routeComment,
    '-j',
    'DNAT',
    '--to-destination',
    `${identity.secondaryEdgeIp}:443`,
  ];
}

async function splitGatewayRouteActive(identity, context) {
  return (
    await dockerResult(splitGatewayRouteArgs(identity, context.state.NYABASE_E2E_EDGE_IP, 'C'))
  ).code === 0;
}

async function splitGatewayContainerActive(name, component, context, optional = false) {
  const inspected = await inspectContainer(name, component, context.runId, optional);
  return inspected?.State?.Running === true;
}

async function readSplitGatewayRaceState(identity, input, optional = false) {
  let value;
  try {
    const info = await lstat(identity.statePath);
    invariant(
      info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600,
      'split Gateway race state is not a private regular file',
    );
    value = JSON.parse(await readFile(identity.statePath, 'utf8'));
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  assertExactKeys(value, [
    'schemaVersion',
    'runId',
    'nodeKey',
    'serverId',
    'staleExecSessionId',
    'baselineGatewayId',
    'primaryGatewayProcessGeneration',
  ]);
  invariant(
    value.schemaVersion === 2
      && value.runId === input.runId
      && value.nodeKey === input.nodeKey
      && /^[0-9a-f-]{36}$/.test(value.serverId)
      && /^[0-9a-f-]{36}$/.test(value.staleExecSessionId)
      && typeof value.baselineGatewayId === 'string'
      && value.baselineGatewayId.length > 0
      && /^[a-f0-9]{64}$/.test(value.primaryGatewayProcessGeneration),
    'split Gateway race state identity mismatch',
  );
  return value;
}

async function closedExecSessionEvidence(context, sessionIds) {
  invariant(
    Array.isArray(sessionIds)
      && sessionIds.length >= 1
      && sessionIds.length <= 4
      && new Set(sessionIds).size === sessionIds.length
      && sessionIds.every((id) => /^[0-9a-f-]{36}$/.test(id)),
    'closed exec session evidence identities are invalid',
  );
  const postgres = `${context.state.NYABASE_E2E_PREFIX}-postgres-1`;
  const ids = sessionIds.map((id) => `'${id}'::uuid`).join(', ');
  const sql = [
    "SELECT COALESCE(json_agg(json_build_object(",
    "'sessionId', id,",
    "'state', state,",
    "'closedAt', closed_at,",
    "'closeReason', close_reason,",
    "'agentSessionId', agent_session_id,",
    "'gatewayId', gateway_id",
    ') ORDER BY id), \'[]\'::json)',
    'FROM workflow.exec_sessions',
    `WHERE id IN (${ids});`,
  ].join(' ');
  const deadline = Date.now() + 15_000;
  let rows = [];
  while (Date.now() < deadline) {
    const result = await dockerResult([
      'exec',
      '-e',
      `PGPASSWORD=${context.runId}`,
      postgres,
      'psql',
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--username',
      'nyabase',
      '--dbname',
      'nyabase',
      '--command',
      sql,
    ]);
    invariant(result.code === 0, 'could not inspect durable exec session closure');
    rows = JSON.parse(result.stdout);
    if (
      Array.isArray(rows)
      && rows.length === sessionIds.length
      && sessionIds.every((id) => rows.some((row) => row?.sessionId === id))
      && rows.every((row) =>
        /^[0-9a-f-]{36}$/.test(row?.sessionId)
        && row.state === 'closed'
        && typeof row.closedAt === 'string'
        && !Number.isNaN(Date.parse(row.closedAt))
        && typeof row.closeReason === 'string'
        && row.closeReason.length > 0
        && /^[0-9a-f-]{36}$/.test(row.agentSessionId)
        && typeof row.gatewayId === 'string'
        && row.gatewayId.length > 0)
    ) {
      return rows;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`exec sessions did not close durably: ${JSON.stringify(rows)}`);
}

async function currentAgentSession(context, serverId) {
  invariant(/^[0-9a-f-]{36}$/.test(serverId), 'Agent Server identity is invalid');
  const postgres = `${context.state.NYABASE_E2E_PREFIX}-postgres-1`;
  const sql = [
    'SELECT json_build_object(',
    "'sessionId', session.id,",
    "'generation', session.generation,",
    "'gatewayId', session.gateway_id,",
    "'serverOnline', server.status = 'online',",
    "'runtimeReady', COALESCE(projection.runtime_ready, false)",
    ')',
    'FROM workflow.agent_sessions AS session',
    'JOIN infra.servers AS server ON server.id = session.server_id',
    'LEFT JOIN workflow.agent_runtime_projections AS projection',
    '  ON projection.session_id = session.id',
    `WHERE session.server_id = '${serverId}'::uuid`,
    "  AND session.state = 'ready'",
    'ORDER BY session.generation DESC',
    'LIMIT 1;',
  ].join(' ');
  const result = await dockerResult([
    'exec',
    '-e',
    `PGPASSWORD=${context.runId}`,
    postgres,
    'psql',
    '--no-psqlrc',
    '--tuples-only',
    '--no-align',
    '--set',
    'ON_ERROR_STOP=1',
    '--username',
    'nyabase',
    '--dbname',
    'nyabase',
    '--command',
    sql,
  ]);
  invariant(result.code === 0, 'could not inspect durable Agent session ownership');
  if (!result.stdout) return null;
  const value = JSON.parse(result.stdout);
  invariant(
    typeof value.sessionId === 'string'
      && /^[0-9a-f-]{36}$/.test(value.sessionId)
      && Number.isSafeInteger(value.generation)
      && value.generation > 0
      && typeof value.gatewayId === 'string'
      && value.gatewayId.length > 0
      && typeof value.serverOnline === 'boolean'
      && typeof value.runtimeReady === 'boolean',
    'durable Agent session evidence is invalid',
  );
  return value;
}

async function waitForAgentSessionOwner(
  context,
  serverId,
  accept,
  description,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await currentAgentSession(context, serverId);
    if (last && accept(last)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Agent session did not reach ${description}; last=${JSON.stringify(last)}`,
  );
}

async function waitForLocalGateway(containerName, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await dockerResult([
      'exec',
      containerName,
      'node',
      '-e',
      "fetch('http://127.0.0.1:3001/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
    ]);
    if (probe.code === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Gateway ${containerName} did not become locally ready`);
}

async function cutAgentEdgeConnection(identity, context) {
  const connectionArgs = [
    'exec',
    identity.nodeContainer,
    'ss',
    '-Htn',
    'state',
    'established',
    'dst',
    context.state.NYABASE_E2E_EDGE_IP,
    'dport',
    '=',
    ':443',
  ];
  const before = await dockerResult(connectionArgs);
  invariant(
    before.code === 0 && before.stdout.split('\n').filter(Boolean).length === 1,
    'selected Agent does not have exactly one established control connection',
  );
  const killed = await dockerResult([
    'exec',
    identity.nodeContainer,
    'ss',
    '--kill',
    'dst',
    context.state.NYABASE_E2E_EDGE_IP,
    'dport',
    '=',
    ':443',
  ]);
  invariant(killed.code === 0, 'could not cut the selected Agent control connection');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const remaining = await dockerResult(connectionArgs);
    if (remaining.code === 0 && !remaining.stdout) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('selected Agent retained its pre-fault control connection');
}

async function pausePrimaryGatewayAtDatabaseStablePoint(identity, context) {
  const postgres = `${context.state.NYABASE_E2E_PREFIX}-postgres-1`;
  const sql = [
    'SELECT count(*)',
    'FROM pg_stat_activity AS activity',
    'WHERE activity.datname = current_database()',
    `  AND activity.client_addr = '${context.state.NYABASE_E2E_GATEWAY_IP}'::inet`,
    '  AND (',
    "    activity.state = 'active'",
    '    OR activity.xact_start IS NOT NULL',
    '    OR EXISTS (',
    '      SELECT 1 FROM pg_locks AS held',
    '      WHERE held.pid = activity.pid',
    "        AND held.locktype = 'advisory'",
    '        AND held.granted',
    '    )',
    '  );',
  ].join(' ');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await docker(['pause', identity.primaryGatewayContainer]);
    const inspected = await dockerResult([
      'exec',
      '-e',
      `PGPASSWORD=${context.runId}`,
      postgres,
      'psql',
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--username',
      'nyabase',
      '--dbname',
      'nyabase',
      '--command',
      sql,
    ]);
    invariant(inspected.code === 0, 'could not inspect paused Gateway database work');
    if (inspected.stdout === '0') return;
    await docker(['unpause', identity.primaryGatewayContainer]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('primary Gateway could not be paused outside authority work');
}

async function assertStableAgentSessionOwner(
  context,
  serverId,
  expected,
  durationMs = 12_000,
) {
  const deadline = Date.now() + durationMs;
  let samples = 0;
  while (Date.now() < deadline) {
    const current = await currentAgentSession(context, serverId);
    invariant(
      current?.sessionId === expected.sessionId
        && current.gatewayId === expected.gatewayId
        && current.generation === expected.generation
        && current.serverOnline
        && current.runtimeReady,
      `delayed primary cleanup changed the secondary Agent owner: ${JSON.stringify(current)}`,
    );
    samples += 1;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  invariant(samples >= 20, 'delayed primary cleanup observation window was too short');
  return expected;
}

async function createSplitGatewayRaceResources(identity, context) {
  await assertOuterIpFree(context.state, identity.secondaryGatewayIp);
  await assertOuterIpFree(context.state, identity.secondaryEdgeIp);
  const edgeConfig = [
    'server {',
    '  listen 443 ssl;',
    '  server_name edge;',
    '  ssl_certificate /etc/nginx/tls/edge.crt;',
    '  ssl_certificate_key /etc/nginx/tls/edge.key;',
    '  ssl_protocols TLSv1.2 TLSv1.3;',
    '  ssl_session_tickets off;',
    '  client_max_body_size 32m;',
    '  proxy_read_timeout 3600s;',
    '  proxy_send_timeout 3600s;',
    '  location ~ ^/ws/(agent|console|ssh-proxy|http-proxy)$ {',
    '    proxy_pass http://gateway-b:3001;',
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-Proto https;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header Upgrade $http_upgrade;',
    '    proxy_set_header Connection "upgrade";',
    '  }',
    '  location / { return 404; }',
    '}',
    '',
  ].join('\n');
  await writeFile(identity.edgeConfigPath, edgeConfig, { mode: 0o600, flag: 'wx' });
  await chmod(identity.edgeConfigPath, 0o600);

  await recordManifestResource(
    'container',
    identity.secondaryGatewayContainer,
    context.runId,
  );
  await docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    identity.secondaryGatewayContainer,
    '--label',
    `io.nyabase.e2e.run-id=${context.runId}`,
    '--label',
    'io.nyabase.e2e.managed=true',
    '--label',
    `io.nyabase.e2e.component=${splitGatewayRaceComponent}`,
    '--network',
    context.state.NYABASE_E2E_NETWORK,
    '--network-alias',
    'gateway-b',
    '--ip',
    identity.secondaryGatewayIp,
    '--env',
    'NYABASE_CONFIG_FILE=/etc/nyabase/config.yaml',
    '--env',
    'NYABASE_RUNTIME_ROLE=gateway',
    '--env',
    `NYABASE_CONSOLE_PUBLIC_URL=${identity.secondaryConsoleUrl}`,
    '--env',
    `DATABASE_URL=postgresql://nyabase:${context.runId}@postgres:5432/nyabase`,
    '--env',
    'DB_MIGRATIONS_RUN=true',
    '--env',
    `REDIS_URL=redis://:${context.runId}@redis:6379/0`,
    '--env',
    `REDIS_KEY_PREFIX=nyabase:${context.runId}:`,
    '--env',
    'VICTORIA_METRICS_URL=http://victoriametrics:8428',
    '--env',
    'VMAGENT_URL=http://vmagent:8429',
    '--env',
    'NODE_OPTIONS=--require=/run/nyabase-e2e/backend-clock-shim.cjs',
    '--env',
    'NYABASE_E2E_CLOCK_OFFSET_MS=0',
    '--mount',
    `type=bind,src=${join(runtimeDir, 'backend-config', 'config.yaml')},dst=/etc/nyabase/config.yaml,readonly`,
    '--mount',
    `type=bind,src=${join(orchestratorDir, 'backend-clock-shim.cjs')},dst=/run/nyabase-e2e/backend-clock-shim.cjs,readonly`,
    context.state.NYABASE_E2E_BACKEND_IMAGE,
  ], { timeout: 120_000 });
  await waitForLocalGateway(identity.secondaryGatewayContainer);

  const primaryEdge = await inspectContainer(
    `${context.state.NYABASE_E2E_PREFIX}-edge-1`,
    undefined,
    context.runId,
  );
  const edgeImage = primaryEdge?.Config?.Image;
  invariant(typeof edgeImage === 'string' && edgeImage.length > 0, 'edge image is invalid');
  await recordManifestResource(
    'host-port',
    identity.secondaryEdgeHostPortResource,
    context.runId,
  );
  await recordManifestResource('container', identity.secondaryEdgeContainer, context.runId);
  await docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    identity.secondaryEdgeContainer,
    '--label',
    `io.nyabase.e2e.run-id=${context.runId}`,
    '--label',
    'io.nyabase.e2e.managed=true',
    '--label',
    `io.nyabase.e2e.component=${splitGatewayRaceComponent}`,
    '--network',
    context.state.NYABASE_E2E_NETWORK,
    '--ip',
    identity.secondaryEdgeIp,
    '--publish',
    `127.0.0.1:${identity.secondaryEdgeHostPort}:443`,
    '--mount',
    `type=bind,src=${identity.edgeConfigPath},dst=/etc/nginx/conf.d/default.conf,readonly`,
    '--mount',
    `type=bind,src=${join(runtimeDir, 'certs')},dst=/etc/nginx/tls,readonly`,
    edgeImage,
  ]);
  const edgeReady = await dockerResult([
    'exec',
    identity.secondaryEdgeContainer,
    'nginx',
    '-t',
  ]);
  invariant(edgeReady.code === 0, 'secondary split Gateway edge is not ready');
}

async function cleanupSplitGatewayRace(identity, context) {
  const errors = [];
  try {
    while (await splitGatewayRouteActive(identity, context)) {
      await docker(
        splitGatewayRouteArgs(identity, context.state.NYABASE_E2E_EDGE_IP, 'D'),
      );
    }
  } catch (error) {
    errors.push(error);
  }
  for (const containerName of [
    identity.secondaryEdgeContainer,
    identity.secondaryGatewayContainer,
  ]) {
    try {
      const result = await dockerResult(['inspect', containerName]);
      if (result.code === 0) {
        const [container] = JSON.parse(result.stdout);
        invariant(
          container?.Config?.Labels?.['io.nyabase.e2e.run-id'] === context.runId
            && container?.Config?.Labels?.['io.nyabase.e2e.managed'] === 'true'
            && container?.Config?.Labels?.['io.nyabase.e2e.component']
              === splitGatewayRaceComponent,
          `split Gateway cleanup ownership mismatch for ${containerName}`,
        );
        await docker(['rm', '-f', containerName]);
      }
      const manifest = JSON.parse(await readFile(join(runtimeDir, 'manifest.json'), 'utf8'));
      assertManifestForRun(manifest, context.runId);
      if (manifestHasResourceIdentity(manifest, 'container', containerName)) {
        await retireManifestResource('container', containerName, context.runId);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const listener = await commandResult('ss', [
      '-H',
      '-ltn',
      'sport',
      '=',
      `:${identity.secondaryEdgeHostPort}`,
    ]);
    invariant(
      listener.code === 0 && listener.stdout === '',
      'split Gateway browser edge retained its run-owned host listener',
    );
    const manifest = JSON.parse(await readFile(join(runtimeDir, 'manifest.json'), 'utf8'));
    assertManifestForRun(manifest, context.runId);
    if (
      manifestHasResourceIdentity(
        manifest,
        'host-port',
        identity.secondaryEdgeHostPortResource,
      )
    ) {
      await retireManifestResource(
        'host-port',
        identity.secondaryEdgeHostPortResource,
        context.runId,
      );
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    const primary = await dockerResult(['inspect', identity.primaryGatewayContainer]);
    invariant(primary.code === 0, 'primary Gateway container is absent during cleanup');
    const [container] = JSON.parse(primary.stdout);
    if (container?.State?.Paused === true) {
      await docker(['unpause', identity.primaryGatewayContainer]);
    } else if (container?.State?.Running !== true) {
      await docker(['start', identity.primaryGatewayContainer], { timeout: 120_000 });
    }
    await waitForLocalGateway(identity.primaryGatewayContainer);
  } catch (error) {
    errors.push(error);
  }
  try {
    await setAgentService(identity.nodeContainer, 'restart');
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw aggregateErrorWithDiagnostics(
      'split Gateway race cleanup was incomplete',
      errors,
    );
  }
}

async function splitGatewayRaceEvidence(
  input,
  context,
  identity,
  state,
  owner,
  expectedClosedExecSessionIds = [state.staleExecSessionId],
) {
  const primary = await backendSnapshot(context, 'gateway');
  const primaryInspection = await inspectContainer(
    identity.primaryGatewayContainer,
    undefined,
    context.runId,
  );
  const primaryGatewayActive = await splitGatewayContainerActive(
    identity.primaryGatewayContainer,
    undefined,
    context,
  );
  const secondaryGatewayActive = await splitGatewayContainerActive(
    identity.secondaryGatewayContainer,
    splitGatewayRaceComponent,
    context,
    true,
  );
  const secondaryEdgeActive = await splitGatewayContainerActive(
    identity.secondaryEdgeContainer,
    splitGatewayRaceComponent,
    context,
    true,
  );
  const routeActive = await splitGatewayRouteActive(identity, context);
  const secondaryEdgeListener = await commandResult('ss', [
    '-H',
    '-ltn',
    'sport',
    '=',
    `:${identity.secondaryEdgeHostPort}`,
  ]);
  invariant(secondaryEdgeListener.code === 0, 'could not inspect split Gateway host listener');
  const secondaryEdgeHostPortActive = secondaryEdgeListener.stdout !== '';
  const manifest = JSON.parse(await readFile(join(runtimeDir, 'manifest.json'), 'utf8'));
  assertManifestForRun(manifest, context.runId);
  const secondaryEdgeHostPortOwned = manifest.resources.some((entry) =>
    entry?.kind === 'host-port'
      && (entry.name ?? entry.id) === identity.secondaryEdgeHostPortResource
      && entry.active !== false);
  const closedExecSessions = await closedExecSessionEvidence(
    context,
    expectedClosedExecSessionIds,
  );
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    nodeKey: input.nodeKey,
    serverId: state.serverId,
    primaryGatewayContainer: identity.primaryGatewayContainer,
    secondaryGatewayContainer: identity.secondaryGatewayContainer,
    secondaryEdgeContainer: identity.secondaryEdgeContainer,
    secondaryEdgeHostPort: identity.secondaryEdgeHostPort,
    secondaryConsoleUrl: identity.secondaryConsoleUrl,
    primaryGatewayProcessGeneration: primary.generation,
    baselineGatewayId: state.baselineGatewayId,
    ownerGatewayId: owner.gatewayId,
    ownerSessionId: owner.sessionId,
    ownerGeneration: owner.generation,
    serverOnline: owner.serverOnline,
    runtimeReady: owner.runtimeReady,
    primaryGatewayActive,
    primaryGatewayPaused: primaryInspection?.State?.Paused === true,
    delayedPrimaryCleanupReleased: true,
    secondaryGatewayActive,
    secondaryEdgeActive,
    secondaryEdgeHostPortActive,
    secondaryEdgeHostPortOwned,
    routeActive,
    cleanupComplete:
      !secondaryGatewayActive
      && !secondaryEdgeActive
      && !secondaryEdgeHostPortActive
      && !secondaryEdgeHostPortOwned
      && !routeActive,
    closedExecSessions,
    observedAt: new Date().toISOString(),
  };
}

async function controlSplitGatewaySessionRace(input, context) {
  const identity = splitGatewayRaceIdentity(input, context);
  const agents = await readAgents();
  const agent = agents.find((candidate) => candidate.key === input.nodeKey);
  invariant(agent && /^[0-9a-f-]{36}$/.test(agent.serverId), 'Agent identity is invalid');
  await recordManifestResource(
    'provider-fault',
    `split-gateway-session-race:${input.nodeKey}:${input.action}`,
    context.runId,
  );

  if (input.action === 'inject') {
    invariant(
      !(await readSplitGatewayRaceState(identity, input, true)),
      'split Gateway session race is already active',
    );
    const baseline = await waitForAgentSessionOwner(
      context,
      agent.serverId,
      (candidate) => candidate.serverOnline && candidate.runtimeReady,
      'online baseline owner',
    );
    const primary = await backendSnapshot(context, 'gateway');
    const state = {
      schemaVersion: 2,
      runId: context.runId,
      nodeKey: input.nodeKey,
      serverId: agent.serverId,
      staleExecSessionId: input.staleExecSessionId,
      baselineGatewayId: baseline.gatewayId,
      primaryGatewayProcessGeneration: primary.generation,
    };
    await writeFile(identity.statePath, `${JSON.stringify(state)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(identity.statePath, 0o600);
    try {
      await createSplitGatewayRaceResources(identity, context);
      await docker(
        splitGatewayRouteArgs(identity, context.state.NYABASE_E2E_EDGE_IP, 'A'),
      );
      invariant(
        await splitGatewayRouteActive(identity, context),
        'split Gateway Agent route was not installed',
      );
      await pausePrimaryGatewayAtDatabaseStablePoint(identity, context);
      await cutAgentEdgeConnection(identity, context);
      const owner = await waitForAgentSessionOwner(
        context,
        agent.serverId,
        (candidate) =>
          candidate.gatewayId !== baseline.gatewayId
          && candidate.generation > baseline.generation
          && candidate.serverOnline
          && candidate.runtimeReady,
        'secondary Gateway owner after frozen primary lease expiry',
      );
      await docker(['unpause', identity.primaryGatewayContainer]);
      await waitForLocalGateway(identity.primaryGatewayContainer);
      const releasedPrimary = await backendSnapshot(context, 'gateway');
      invariant(
        releasedPrimary.generation === state.primaryGatewayProcessGeneration,
        'primary Gateway process changed instead of releasing delayed in-memory cleanup',
      );
      const stableOwner = await waitForAgentSessionOwner(
        context,
        agent.serverId,
        (candidate) =>
          candidate.sessionId === owner.sessionId
          && candidate.gatewayId === owner.gatewayId
          && candidate.serverOnline
          && candidate.runtimeReady,
        'secondary owner immediately after delayed primary cleanup release',
      );
      await assertStableAgentSessionOwner(
        context,
        agent.serverId,
        stableOwner,
      );
      return splitGatewayRaceEvidence(input, context, identity, state, stableOwner);
    } catch (error) {
      try {
        await cleanupSplitGatewayRace(identity, context);
      } catch (cleanupError) {
        throw aggregateErrorWithDiagnostics(
          'split Gateway injection and rollback both failed',
          [error, cleanupError],
        );
      }
      await rm(identity.statePath, { force: true });
      await rm(identity.edgeConfigPath, { force: true });
      throw error;
    }
  }

  const state = await readSplitGatewayRaceState(identity, input);
  if (input.action === 'probe') {
    const owner = await waitForAgentSessionOwner(
      context,
      state.serverId,
      (candidate) =>
        candidate.gatewayId !== state.baselineGatewayId
        && candidate.serverOnline
        && candidate.runtimeReady,
      'secondary Gateway owner probe',
    );
    return splitGatewayRaceEvidence(
      input,
      context,
      identity,
      state,
      owner,
      input.expectedClosedExecSessionIds ?? [state.staleExecSessionId],
    );
  }

  const secondaryOwner = await currentAgentSession(context, state.serverId);
  invariant(secondaryOwner, 'split Gateway restore has no current Agent owner');
  await cleanupSplitGatewayRace(identity, context);
  const restoredOwner = await waitForAgentSessionOwner(
    context,
    state.serverId,
    (candidate) =>
      candidate.gatewayId === state.baselineGatewayId
      && candidate.generation > secondaryOwner.generation
      && candidate.serverOnline
      && candidate.runtimeReady,
    'primary Gateway owner after exact cleanup',
  );
  await rm(identity.statePath, { force: true });
  await rm(identity.edgeConfigPath, { force: true });
  return splitGatewayRaceEvidence(input, context, identity, state, restoredOwner);
}

async function controlArtifactAudit(input, context) {
  await recordManifestResource('provider-fault', 'artifact-audit:capture', context.runId);
  await command('bash', [join(orchestratorDir, 'diagnose.sh'), context.runId], {
    timeout: 90_000,
  });
  await command(
    process.execPath,
    [join(orchestratorDir, 'audit-artifacts.mjs'), runtimeDir, '--pre-report'],
    { timeout: 90_000 },
  );
  const evidencePath = join(runtimeDir, 'artifact-audit.json');
  const bytes = await readFile(evidencePath);
  const evidence = JSON.parse(bytes.toString('utf8'));
  invariant(
    evidence.schemaVersion === 1 &&
      evidence.runId === context.runId &&
      evidence.status === 'clean' &&
      evidence.playwrightArtifactPolicy === 'pre-report-empty' &&
      Number.isSafeInteger(evidence.filesChecked) &&
      Number.isSafeInteger(evidence.knownSecretsChecked),
    'artifact audit did not produce current-run clean evidence',
  );
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    evidencePath,
    evidenceSha256: sha256(bytes),
    status: 'clean',
    playwrightArtifactPolicy: evidence.playwrightArtifactPolicy,
    filesChecked: evidence.filesChecked,
    knownSecretsChecked: evidence.knownSecretsChecked,
    observedAt: new Date().toISOString(),
  };
}

async function main() {
  invariant(process.argv[2], 'usage: fault-control.mjs <runtimeDir>');
  const { state, runId } = await loadValidatedRunState(runtimeDir);
  const manifest = JSON.parse(await readFile(join(runtimeDir, 'manifest.json'), 'utf8'));
  assertManifestForRun(manifest, runId);
  const input = validateInput(await readBoundedStdin(), runId);
  const context = { runId, state };
  let result;
  if (input.fault === 'agentService') result = await controlAgentService(input, context);
  else if (input.fault === 'localDataDirOrphan')
    result = await controlLocalDataDirOrphan(input, context);
  else if (input.fault === 'duplicateNetworkClaim') {
    result = await controlDuplicateNetworkClaim(input, context);
  } else if (input.fault === 'agentTaskWire') {
    result = await controlAgentTaskWire(input, context);
  } else if (input.fault === 'containerRuntimeDrift') {
    result = await controlContainerRuntimeDrift(input, context);
  } else if (input.fault === 'backendService') {
    result = await controlBackendService(input, context);
  } else if (input.fault === 'backendClock') {
    result = await controlBackendClock(input, context);
  } else if (input.fault === 'redisService') {
    result = await controlRedisService(input, context);
  } else if (input.fault === 'telemetryService') {
    result = await controlTelemetryService(input, context);
  } else if (input.fault === 'dockerdService') {
    result = await controlDockerdService(input, context);
  } else if (input.fault === 'duplicateAgentSession') {
    result = await controlDuplicateAgentSession(input, context);
  } else if (input.fault === 'splitGatewaySessionRace') {
    result = await controlSplitGatewaySessionRace(input, context);
  } else {
    result = await controlArtifactAudit(input, context);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  await runEntrypointWithDiagnostics(main);
}
