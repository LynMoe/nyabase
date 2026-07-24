#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { validateRemoteStorageInput } from './remote-storage-contract.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

const execFile = promisify(execFileCallback);
const runtimeDir = resolve(process.argv[2] ?? '');
const runtimeBase = resolve(dirname(new URL(import.meta.url).pathname), '..', '.runtime');
const maxBuffer = 64 * 1024;

if (!process.argv[2]) throw new Error('usage: remote-storage-control.mjs <runtimeDir>');
if (!runtimeDir.startsWith(`${runtimeBase}${sep}`) || dirname(runtimeDir) !== runtimeBase) {
  throw new Error('Remote storage operation escaped the E2E runtime boundary');
}
const runtimeInfo = await lstat(runtimeDir);
if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink() || (runtimeInfo.mode & 0o077) !== 0) {
  throw new Error('Remote storage runtime directory is not private and real');
}

const { state } = await loadValidatedRunState(runtimeDir, { expectedProfile: 'full' });

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('Remote storage input is too large');
}
let input;
try {
  input = JSON.parse(raw);
} catch {
  throw new Error('Remote storage input is not valid JSON');
}
input = validateRemoteStorageInput(input, state.NYABASE_E2E_RUN_ID);
if (input.runId !== runtimeDir.split(sep).at(-1)) {
  throw new Error('Remote storage runtime identity mismatch');
}

const nodeContainerName = `${state.NYABASE_E2E_PREFIX}-${input.nodeKey}`;
const mountPoint = `/mnt/remote-fs/${input.mountId}`;
const pidFile = `/run/nyabase-e2e/remote-fs-busy-${input.mountId}.pid`;

async function command(args, options = {}) {
  return execFile('docker', args, {
    encoding: 'utf8',
    maxBuffer,
    timeout: options.timeout ?? 30_000,
  });
}

const inspect = JSON.parse((await command([
  'inspect', nodeContainerName, '--format', '{{json .}}',
])).stdout);
if (
  inspect.State?.Running !== true
  || inspect.Config?.Labels?.['io.nyabase.e2e.run-id'] !== input.runId
  || inspect.Config?.Labels?.['io.nyabase.e2e.component'] !== input.nodeKey
) {
  throw new Error('Remote storage node is not the current run-owned CPU node');
}

async function physicalState() {
  try {
    const { stdout } = await command([
      'exec', nodeContainerName, 'findmnt', '-n', '-o', 'SOURCE,FSTYPE', '--mountpoint', mountPoint,
    ]);
    const line = stdout.trim();
    const separator = line.lastIndexOf(' ');
    if (separator <= 0) throw new Error('Remote storage findmnt output is malformed');
    const source = line.slice(0, separator).trim();
    const observedFsType = line.slice(separator + 1).trim();
    if (!['nfs', 'nfs4', 'ceph'].includes(observedFsType)) {
      throw new Error('Remote storage mount has an unexpected filesystem type');
    }
    if (
      (input.fsType === 'nfs' && !['nfs', 'nfs4'].includes(observedFsType))
      || (input.fsType === 'cephfs' && observedFsType !== 'ceph')
    ) {
      throw new Error('Remote storage mount type does not match the requested fixture');
    }
    return { mounted: true, observedFsType, source };
  } catch (error) {
    if (Number(error?.code) === 1) {
      return { mounted: false, observedFsType: null, source: null };
    }
    throw error;
  }
}

let markerMatched = null;
let busyPid = null;
if (input.action === 'releaseBusy') {
  const { stdout } = await command([
    'exec', nodeContainerName, 'sh', '-eu', '-c', [
      'pid_file=$1',
      'mount_point=$2',
      'test -f "$pid_file" || exit 0',
      'pid=$(tr -d "\\n" < "$pid_file")',
      'case "$pid" in ""|*[!0-9]*) exit 41;; esac',
      'test "$(cat "/proc/$pid/comm" 2>/dev/null || true)" = sleep || exit 42',
      'test "$(readlink "/proc/$pid/cwd" 2>/dev/null || true)" = "$mount_point" || exit 43',
      'kill "$pid"',
      'rm -f "$pid_file"',
      'printf "%s\\n" "$pid"',
    ].join('\n'), 'nyabase-remote-storage-release', pidFile, mountPoint,
  ]);
  busyPid = stdout.trim() ? Number(stdout.trim()) : null;
} else {
  const before = await physicalState();
  if (input.action !== 'probe' && !before.mounted) {
    throw new Error('Remote storage action requires an exact physical mount');
  }
  if (input.action === 'write') {
    await command([
      'exec', nodeContainerName, 'sh', '-eu', '-c',
      'target=$1/.nyabase-e2e-proof; tmp=$target.tmp; umask 077; printf %s "$2" > "$tmp"; mv -f "$tmp" "$target"; sync "$target"',
      'nyabase-remote-storage-write', mountPoint, input.marker,
    ]);
    markerMatched = true;
  } else if (input.action === 'read') {
    await command([
      'exec', nodeContainerName, 'sh', '-eu', '-c',
      'test "$(cat "$1/.nyabase-e2e-proof")" = "$2"',
      'nyabase-remote-storage-read', mountPoint, input.marker,
    ]);
    markerMatched = true;
  } else if (input.action === 'holdBusy') {
    await command([
      'exec', '-d', nodeContainerName, 'sh', '-eu', '-c',
      'umask 077; cd "$1"; printf "%s\\n" "$$" > "$2"; exec sleep 600',
      'nyabase-remote-storage-busy', mountPoint, pidFile,
    ]);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const { stdout } = await command([
          'exec', nodeContainerName, 'sh', '-eu', '-c',
          'pid=$(cat "$1"); test "$(cat "/proc/$pid/comm")" = sleep; test "$(readlink "/proc/$pid/cwd")" = "$2"; printf "%s\\n" "$pid"',
          'nyabase-remote-storage-busy-probe', pidFile, mountPoint,
        ]);
        busyPid = Number(stdout.trim());
        break;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
    if (!Number.isSafeInteger(busyPid) || busyPid < 1) {
      throw new Error('Remote storage busy holder did not become exact');
    }
  }
}

const observed = await physicalState();
const cephSecretArtifactsAbsent = (await command([
  'exec', nodeContainerName, 'sh', '-eu', '-c',
  'test ! -d /run/nyabase-cephfs || test -z "$(find /run/nyabase-cephfs -mindepth 1 -print -quit)"',
])).stdout.trim() === '';
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  runId: input.runId,
  nodeKey: input.nodeKey,
  nodeContainerName,
  mountId: input.mountId,
  mountPoint,
  action: input.action,
  mounted: observed.mounted,
  observedFsType: observed.observedFsType,
  source: observed.source,
  markerMatched,
  busyPid,
  cephSecretArtifactsAbsent,
  observedAt: new Date().toISOString(),
})}\n`);
