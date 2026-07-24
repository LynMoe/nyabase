#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  aggregateErrorWithDiagnostics,
  runEntrypointWithDiagnostics,
} from '../support/error-diagnostics.mjs';
import { assertManifestForRun } from './manifest-contract.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const orchestratorDir = dirname(scriptPath);
const runtimeBase = resolve(orchestratorDir, '..', '.runtime');
const runtimeDir = resolve(process.argv[2] ?? '');
const maxBuffer = 64 * 1024;
const probeComponent = 'provider-container-ssh-client';
const managedNetwork = 'nyabase_net';
const fingerprintPattern = /^SHA256:[A-Za-z0-9+/]{43}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expected) {
  invariant(
    value && typeof value === 'object' && !Array.isArray(value),
    'SSH input must be an object',
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    'SSH input has unknown or missing fields',
  );
}

async function command(label, program, args, timeout = 15_000) {
  try {
    const result = await execFile(program, args, {
      encoding: 'utf8',
      maxBuffer,
      timeout,
    });
    return result.stdout.trim();
  } catch {
    throw new Error(`${label} failed inside the closed provider boundary`);
  }
}

async function optionalDockerInspect(name) {
  try {
    const output = await execFile('docker', ['inspect', name], {
      encoding: 'utf8',
      maxBuffer,
      timeout: 10_000,
    });
    const parsed = JSON.parse(output.stdout);
    invariant(
      Array.isArray(parsed) && parsed.length === 1,
      'provider container identity is ambiguous',
    );
    return parsed[0];
  } catch (error) {
    if (Number.isInteger(error?.code)) return null;
    throw new Error('provider container inspection failed inside the closed boundary');
  }
}

function commandWithInput(label, program, args, input, timeout = 45_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    let bytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > maxBuffer) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error(`${label} could not start inside the closed provider boundary`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${label} exceeded its finite provider deadline`));
        return;
      }
      if (outputExceeded) {
        reject(new Error(`${label} exceeded its provider output limit`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${label} failed inside the closed provider boundary`));
        return;
      }
      resolvePromise(stdout.trim());
    });
    child.stdin.end(input);
  });
}

async function readBoundedStdin() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk.toString('utf8');
    invariant(Buffer.byteLength(raw) <= 32 * 1024, 'SSH input exceeds 32 KiB');
  }
  invariant(raw.trim().length > 0, 'SSH input is required on stdin');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('SSH input is not valid JSON');
  }
}

export function validateInput(value, context) {
  assertExactKeys(value, [
    'runId',
    'nodeKey',
    'containerId',
    'runtimeId',
    'expectedIp',
    'expectedHostKeyFingerprint',
    'expectedClientKeyFingerprint',
    'privateKey',
    'marker',
  ]);
  invariant(value.runId === context.runId, 'SSH input runId does not match the runtime');
  invariant(value.nodeKey === 'node1' || value.nodeKey === 'node2', 'SSH nodeKey is invalid');
  invariant(
    typeof value.containerId === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.containerId),
    'SSH product container identity is invalid',
  );
  invariant(
    typeof value.runtimeId === 'string' && /^[a-f0-9]{64}$/.test(value.runtimeId),
    'SSH runtime identity must be a full Docker ID',
  );
  const subnet = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(context.state.NYABASE_E2E_SUBNET);
  invariant(subnet, 'provider subnet is not a canonical /24');
  const prefix = `${subnet[1]}.${subnet[2]}.${subnet[3]}`;
  const ip = new RegExp(`^${prefix.replaceAll('.', '\\.')}\\.(\\d+)$`).exec(value.expectedIp);
  invariant(ip, 'SSH expectedIp is outside the current product CIDR');
  const host = Number(ip[1]);
  invariant(host >= 101 && host <= 199, 'SSH expectedIp is outside the product allocation pool');
  invariant(
    fingerprintPattern.test(value.expectedHostKeyFingerprint),
    'SSH expected host-key fingerprint is invalid',
  );
  invariant(
    fingerprintPattern.test(value.expectedClientKeyFingerprint),
    'SSH expected client-key fingerprint is invalid',
  );
  invariant(
    typeof value.privateKey === 'string' &&
      value.privateKey.length >= 100 &&
      value.privateKey.length <= 16 * 1024 &&
      /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END OPENSSH PRIVATE KEY-----\r?\n?$/.test(
        value.privateKey,
      ),
    'SSH private key envelope is invalid',
  );
  invariant(
    typeof value.marker === 'string' && /^[a-z0-9][a-z0-9._:-]{15,127}$/.test(value.marker),
    'SSH marker is outside the closed data vocabulary',
  );
  return value;
}

async function inspectOuterContainer(name, component, context) {
  const raw = await command('run-owned container inspection', 'docker', ['inspect', name]);
  const parsed = JSON.parse(raw);
  invariant(
    Array.isArray(parsed) && parsed.length === 1,
    'run-owned container identity is ambiguous',
  );
  const container = parsed[0];
  const labels = container?.Config?.Labels ?? {};
  invariant(container?.Name === `/${name}`, 'run-owned container canonical name mismatch');
  invariant(container?.State?.Running === true, 'run-owned container is not running');
  invariant(
    labels['io.nyabase.e2e.run-id'] === context.runId,
    'run-owned container label mismatch',
  );
  invariant(labels['io.nyabase.e2e.managed'] === 'true', 'run-owned container is not managed');
  invariant(
    labels['io.nyabase.e2e.component'] === component,
    'run-owned container component mismatch',
  );
  return container;
}

async function readAgents() {
  const value = JSON.parse(await readFile(join(runtimeDir, 'agents.json'), 'utf8'));
  invariant(
    Array.isArray(value?.agents) && value.agents.length === 2,
    'run Agent manifest is invalid',
  );
  return value.agents;
}

async function inspectTargetRuntime(input, context, targetContainerName) {
  const raw = await command(
    'exact inner runtime inspection',
    'docker',
    [
      'exec',
      targetContainerName,
      '/usr/bin/docker',
      '--host',
      'unix:///run/nyabase-agent/docker.sock',
      'inspect',
      input.runtimeId,
    ],
    20_000,
  );
  const parsed = JSON.parse(raw);
  invariant(
    Array.isArray(parsed) && parsed.length === 1,
    'exact inner runtime identity is ambiguous',
  );
  const runtime = parsed[0];
  const labels = runtime?.Config?.Labels ?? {};
  const agents = await readAgents();
  const agent = agents.find((candidate) => candidate?.key === input.nodeKey);
  invariant(
    agent &&
      typeof agent.serverId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agent.serverId),
    'target Agent identity is invalid',
  );
  invariant(runtime?.Id === input.runtimeId, 'exact inner runtime Docker ID changed');
  invariant(
    runtime?.State?.Running === true && runtime?.State?.Status === 'running',
    'target runtime is not active',
  );
  invariant(labels['nyabase.managed'] === 'true', 'target runtime is not nyabase-managed');
  invariant(
    labels['nyabase.container_id'] === input.containerId,
    'target runtime product identity mismatch',
  );
  invariant(
    labels['nyabase.server_id'] === agent.serverId,
    'target runtime Server identity mismatch',
  );
  const targetIp = runtime?.NetworkSettings?.Networks?.[managedNetwork]?.IPAddress;
  invariant(
    targetIp === input.expectedIp,
    'target runtime IP differs from the product observation',
  );
  return { serverId: agent.serverId, targetIp };
}

async function assertBackendImage(context, manifest) {
  const expectedImage = `${context.state.NYABASE_E2E_PREFIX}-backend:worktree`;
  invariant(
    context.state.NYABASE_E2E_BACKEND_IMAGE === expectedImage,
    'Backend image state is not run-scoped',
  );
  invariant(
    manifest.resources?.some(
      (resource) =>
        resource?.kind === 'image' &&
        resource?.name === expectedImage &&
        resource?.labels?.['io.nyabase.e2e.run-id'] === context.runId,
    ),
    'Backend image is absent from the run manifest',
  );
  const raw = await command('Backend image inspection', 'docker', [
    'image',
    'inspect',
    expectedImage,
  ]);
  const parsed = JSON.parse(raw);
  invariant(Array.isArray(parsed) && parsed.length === 1, 'Backend image identity is ambiguous');
  const image = parsed[0];
  const labels = image?.Config?.Labels ?? {};
  invariant(/^sha256:[a-f0-9]{64}$/.test(image?.Id), 'Backend image has an invalid immutable ID');
  invariant(image?.RepoTags?.includes(expectedImage), 'Backend image tag identity changed');
  invariant(labels['io.nyabase.e2e.run-id'] === context.runId, 'Backend image run label mismatch');
  invariant(labels['io.nyabase.e2e.component'] === 'backend', 'Backend image component mismatch');
  return expectedImage;
}

async function recordProbeContainer(context, name) {
  await command('SSH probe manifest registration', process.execPath, [
    join(orchestratorDir, 'manifest.mjs'),
    'resource',
    runtimeDir,
    context.runId,
    'container',
    name,
  ]);
}

async function retireProbeContainer(context, name) {
  await command('SSH probe manifest retirement', process.execPath, [
    join(orchestratorDir, 'manifest.mjs'),
    'retire',
    runtimeDir,
    context.runId,
    'container',
    name,
  ]);
}

function assertProbeIdentity(container, context, probeContainerName) {
  const labels = container?.Config?.Labels ?? {};
  invariant(
    container?.Name === `/${probeContainerName}`,
    'SSH probe container canonical name mismatch',
  );
  invariant(labels['io.nyabase.e2e.run-id'] === context.runId, 'SSH probe run label mismatch');
  invariant(labels['io.nyabase.e2e.managed'] === 'true', 'SSH probe is not provider-managed');
  invariant(labels['io.nyabase.e2e.component'] === probeComponent, 'SSH probe component mismatch');
}

export async function cleanupProbeContainer(context, probeContainerName, dependencies = {}) {
  const inspect = dependencies.inspect ?? optionalDockerInspect;
  const remove =
    dependencies.remove ??
    (async () =>
      command('SSH probe forced cleanup', 'docker', ['rm', '--force', probeContainerName], 15_000));
  const retire = dependencies.retire ?? retireProbeContainer;
  const existing = await inspect(probeContainerName);
  if (existing) {
    assertProbeIdentity(existing, context, probeContainerName);
    await remove();
  }
  invariant(
    (await inspect(probeContainerName)) === null,
    'SSH probe container remains after cleanup',
  );
  await retire(context, probeContainerName);
}

export async function settleSshProbeOutcome(primaryFailure, cleanup) {
  let cleanupFailure = null;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = { error };
  }
  if (primaryFailure !== null && cleanupFailure !== null) {
    throw aggregateErrorWithDiagnostics('SSH proof and provider cleanup failed', [
      primaryFailure.error,
      cleanupFailure.error,
    ]);
  }
  if (primaryFailure !== null) throw primaryFailure.error;
  if (cleanupFailure !== null) throw cleanupFailure.error;
}

export const sshProbeScript = String.raw`
set -eu
umask 077
ip="$1"
expected_host_fingerprint="$2"
expected_client_fingerprint="$3"
marker="$4"
temporary_directory="$(mktemp -d /run/nyabase-e2e-ssh.XXXXXX)"
case "$temporary_directory" in
  /run/nyabase-e2e-ssh.*) ;;
  *) exit 70 ;;
esac
private_key="$temporary_directory/id_ed25519"
known_hosts="$temporary_directory/known_hosts"
cleanup() {
  rm -f -- "$private_key" "$known_hosts"
  rmdir -- "$temporary_directory" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

cat >"$private_key"
chmod 0600 "$private_key"
[ "$(stat -c %a "$private_key")" = 600 ]

client_public="$(timeout --signal=KILL 8 ssh-keygen -y -f "$private_key")"
client_fingerprint_line="$(printf '%s\n' "$client_public" | ssh-keygen -l -E sha256 -f -)"
set -- $client_fingerprint_line
client_fingerprint="$2"
[ "$client_fingerprint" = "$expected_client_fingerprint" ]

scanned="$(timeout --signal=KILL 12 ssh-keyscan -T 8 -t ed25519 -p 22 "$ip" 2>/dev/null)"
host_token="[$ip]:22"
matching_count=0
host_blob=''
while read -r scanned_host scanned_algorithm scanned_blob _rest; do
  [ "$scanned_host" = "$ip" ] || [ "$scanned_host" = "$host_token" ] || continue
  [ "$scanned_algorithm" = ssh-ed25519 ] || continue
  matching_count=$((matching_count + 1))
  host_blob="$scanned_blob"
done <<EOF
$scanned
EOF
[ "$matching_count" = 1 ]
[ -n "$host_blob" ]
printf '%s ssh-ed25519 %s\n' "$host_token" "$host_blob" >"$known_hosts"
chmod 0600 "$known_hosts"
[ "$(stat -c %a "$known_hosts")" = 600 ]
host_fingerprint_line="$(printf 'ssh-ed25519 %s\n' "$host_blob" | ssh-keygen -l -E sha256 -f -)"
set -- $host_fingerprint_line
host_fingerprint="$2"
[ "$host_fingerprint" = "$expected_host_fingerprint" ]

remote_output="$(
  timeout --signal=KILL 20 ssh \
    -F /dev/null \
    -p 22 \
    -i "$private_key" \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no \
    -o PreferredAuthentications=publickey \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$known_hosts" \
    -o GlobalKnownHostsFile=/dev/null \
    -o HostKeyAlias="$host_token" \
    -o CheckHostIP=no \
    -o UpdateHostKeys=no \
    -o HostKeyAlgorithms=ssh-ed25519 \
    -o PubkeyAcceptedAlgorithms=ssh-ed25519 \
    -o ConnectTimeout=8 \
    -o ConnectionAttempts=1 \
    -o ServerAliveInterval=5 \
    -o ServerAliveCountMax=1 \
    -o LogLevel=ERROR \
    "root@$ip" /bin/echo "$marker"
)"
[ "$remote_output" = "$marker" ]

rm -f -- "$private_key" "$known_hosts"
[ ! -e "$private_key" ]
[ ! -e "$known_hosts" ]
rmdir -- "$temporary_directory"
trap - EXIT INT TERM HUP
printf '%s\n' "$remote_output"
`;

async function runSshProbe(input, context, manifest, identity) {
  const probeContainerName = `${context.state.NYABASE_E2E_PREFIX}-container-ssh-client`;
  invariant(
    (await optionalDockerInspect(probeContainerName)) === null,
    'SSH probe container already exists before registration',
  );
  const image = await assertBackendImage(context, manifest);
  await recordProbeContainer(context, probeContainerName);

  let primaryFailure = null;
  let markerOutput = null;
  try {
    markerOutput = await commandWithInput(
      'real Dropbear SSH handshake',
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--pull=never',
        '--name',
        probeContainerName,
        '--label',
        `io.nyabase.e2e.run-id=${context.runId}`,
        '--label',
        'io.nyabase.e2e.managed=true',
        '--label',
        `io.nyabase.e2e.component=${probeComponent}`,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--pids-limit',
        '64',
        '--memory',
        '128m',
        '--cpus',
        '0.5',
        '--network',
        `container:${identity.sourceContainerName}`,
        '--tmpfs',
        '/run:rw,nosuid,nodev,noexec,size=1m,mode=0700',
        '--entrypoint',
        '/bin/sh',
        image,
        '-euc',
        sshProbeScript,
        'nyabase-container-ssh-client',
        input.expectedIp,
        input.expectedHostKeyFingerprint,
        input.expectedClientKeyFingerprint,
        input.marker,
      ],
      input.privateKey,
      45_000,
    );
    invariant(markerOutput === input.marker, 'SSH probe returned an unexpected remote marker');
  } catch (error) {
    primaryFailure = { error };
  }

  await settleSshProbeOutcome(primaryFailure, () =>
    cleanupProbeContainer(context, probeContainerName),
  );

  return {
    schemaVersion: 1,
    runId: context.runId,
    nodeKey: input.nodeKey,
    sourceContainerName: identity.sourceContainerName,
    sourceIp: identity.sourceIp,
    probeContainerName,
    targetContainerName: identity.targetContainerName,
    serverId: identity.serverId,
    containerId: input.containerId,
    runtimeId: input.runtimeId,
    targetIp: input.expectedIp,
    remoteUser: 'root',
    remotePort: 22,
    clientKeyFingerprint: input.expectedClientKeyFingerprint,
    hostKeyFingerprint: input.expectedHostKeyFingerprint,
    marker: markerOutput,
    authenticated: true,
    privateKeyMode: '600',
    privateKeyRemoved: true,
    observedAt: new Date().toISOString(),
  };
}

async function main() {
  invariant(process.argv[2], 'usage: container-ssh-client.mjs <runtimeDir>');
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
  invariant(/^[a-z0-9][a-z0-9-]{2,47}$/.test(runId), 'state runId is invalid');
  invariant(runtimeDir.split(sep).at(-1) === runId, 'runtime runId mismatch');
  invariant(state.NYABASE_E2E_PREFIX === `nyabase-e2e-${runId}`, 'runtime prefix mismatch');
  const context = { runId, state };
  const manifest = JSON.parse(await readFile(join(runtimeDir, 'manifest.json'), 'utf8'));
  assertManifestForRun(manifest, runId);
  const input = validateInput(await readBoundedStdin(), context);

  const targetContainerName = `${state.NYABASE_E2E_PREFIX}-${input.nodeKey}`;
  await inspectOuterContainer(targetContainerName, input.nodeKey, context);
  const sourceContainerName = `${state.NYABASE_E2E_PREFIX}-independent-client`;
  const source = await inspectOuterContainer(
    sourceContainerName,
    'independent-network-client',
    context,
  );
  const sourceIp = source?.NetworkSettings?.Networks?.[state.NYABASE_E2E_NETWORK]?.IPAddress;
  invariant(sourceIp === state.NYABASE_E2E_PROBE_IP, 'SSH source network identity mismatch');
  invariant(
    sourceContainerName !== targetContainerName,
    'SSH source and target containers are identical',
  );
  invariant(sourceIp !== input.expectedIp, 'SSH source and target IPs are identical');
  const runtime = await inspectTargetRuntime(input, context, targetContainerName);

  const result = await runSshProbe(input, context, manifest, {
    sourceContainerName,
    sourceIp,
    targetContainerName,
    serverId: runtime.serverId,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  await runEntrypointWithDiagnostics(main);
}
