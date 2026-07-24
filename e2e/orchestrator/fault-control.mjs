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

function validateInput(value, runId) {
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
    assertExactKeys(value, ['fault', 'runId', 'action']);
    invariant(value.action === 'restart' || value.action === 'probe', 'unsupported Backend action');
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
    labels['io.nyabase.e2e.component'] === expectedComponent,
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
  return {
    containerName: `${context.state.NYABASE_E2E_PREFIX}-fault-duplicate-claim`,
    // Docker names can exceed the Linux hostname limit. Keep the hostname
    // independent from the caller-selected run ID so the longest valid run
    // still starts its private systemd namespace.
    hostname: duplicateClaimFaultHostname,
    // .13 is the isolated rate-limit edge and .20 is the independent probe.
    // Keep this transient provider node on its dedicated otherwise-unused
    // address so fault injection cannot collide before exercising the product.
    outerIp: `${prefix}.14`,
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
    backendIp: context.state.NYABASE_E2E_BACKEND_IP,
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

async function backendSnapshot(context) {
  const containerName = `${context.state.NYABASE_E2E_PREFIX}-backend-1`;
  const result = await dockerResult(['inspect', containerName]);
  invariant(result.code === 0, `run-owned Backend ${containerName} does not exist`);
  const parsed = JSON.parse(result.stdout);
  invariant(Array.isArray(parsed) && parsed.length === 1, 'Backend identity is ambiguous');
  const container = parsed[0];
  const labels = container?.Config?.Labels ?? {};
  invariant(container?.Name === `/${containerName}`, 'Backend canonical name mismatch');
  invariant(
    labels['io.nyabase.e2e.run-id'] === context.runId &&
      labels['io.nyabase.e2e.managed'] === 'true' &&
      labels['com.docker.compose.service'] === 'backend',
    'Backend ownership labels mismatch',
  );
  invariant(container?.State?.Running === true, 'Backend container is not running');
  invariant(/^[a-f0-9]{64}$/.test(container.Id ?? ''), 'Backend container ID is invalid');
  invariant(
    typeof container.State.StartedAt === 'string' &&
      !Number.isNaN(Date.parse(container.State.StartedAt)),
    'Backend StartedAt is invalid',
  );
  const clockEntry = (container.Config.Env ?? []).find((entry) =>
    entry.startsWith('NYABASE_E2E_CLOCK_OFFSET_MS='),
  );
  const offsetMs = Number(clockEntry?.slice(clockEntry.indexOf('=') + 1) ?? 0);
  invariant(
    offsetMs === 0 || offsetMs === advancedClockOffsetMs,
    'Backend clock offset is outside the closed provider vocabulary',
  );
  return {
    containerName,
    containerId: container.Id,
    generation: sha256(`${container.Id}\n${container.State.StartedAt}\n${offsetMs}\n`),
    offsetMs,
  };
}

async function controlBackendService(input, context) {
  const before = backendSnapshot(context);
  const beforeSnapshot = await before;
  await waitForBackendHealthy(context);
  await recordManifestResource('provider-fault', 'backend-service:restart', context.runId);
  if (input.action === 'restart') {
    await docker(['restart', '--time', '30', beforeSnapshot.containerName], { timeout: 60_000 });
  }
  await waitForBackendHealthy(context);
  const after = await backendSnapshot(context);
  invariant(
    input.action !== 'restart' || beforeSnapshot.generation !== after.generation,
    'Backend restart did not change its process generation',
  );
  invariant(
    beforeSnapshot.containerId === after.containerId,
    'Backend restart unexpectedly replaced the durable Compose container',
  );
  return {
    schemaVersion: 1,
    runId: context.runId,
    fault: input.fault,
    action: input.action,
    containerName: after.containerName,
    containerId: after.containerId,
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
        'backend',
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
  const snapshot = await backendSnapshot(context);
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
  } else if (input.fault === 'dockerdService') {
    result = await controlDockerdService(input, context);
  } else if (input.fault === 'duplicateAgentSession') {
    result = await controlDuplicateAgentSession(input, context);
  } else {
    result = await controlArtifactAudit(input, context);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  await runEntrypointWithDiagnostics(main);
}
