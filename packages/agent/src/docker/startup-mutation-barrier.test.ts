import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  PhysicalMutationFenceBusyError,
  fencePhysicalMutationCommand,
} from '../physical-mutation-fence.js';
import {
  quiesceDockerBeforeAgentStartup,
  startupDockerQuiesceCommand,
} from './startup-mutation-barrier.js';

describe('Docker startup mutation barrier', () => {
  it('retries only a proved fence conflict inside one total startup deadline', async () => {
    vi.useFakeTimers();
    try {
      const runCommand = vi.fn()
        .mockRejectedValueOnce(new PhysicalMutationFenceBusyError('/bin/sh'))
        .mockRejectedValueOnce(new PhysicalMutationFenceBusyError('/bin/sh'))
        .mockResolvedValueOnce(undefined);

      const quiesce = quiesceDockerBeforeAgentStartup({
        runCommand,
        timeoutMs: 250,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(runCommand).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(100);
      await expect(quiesce).resolves.toBeUndefined();
      expect(runCommand).toHaveBeenCalledTimes(3);
      expect(runCommand.mock.calls.map((call) => call[2])).toEqual([250, 150, 50]);

      const ordinaryFailure = new Error('systemd proof failed');
      const failImmediately = vi.fn().mockRejectedValue(ordinaryFailure);
      await expect(quiesceDockerBeforeAgentStartup({
        runCommand: failImmediately,
        timeoutMs: 250,
      })).rejects.toBe(ordinaryFailure);
      expect(failImmediately).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never opens startup when the previous physical helper outlives the total deadline', async () => {
    vi.useFakeTimers();
    try {
      const runCommand = vi.fn().mockRejectedValue(
        new PhysicalMutationFenceBusyError('/bin/sh'),
      );
      const quiesce = expect(quiesceDockerBeforeAgentStartup({
        runCommand,
        timeoutMs: 150,
      })).rejects.toThrow(
        'Timed out after 150ms waiting for the previous Agent physical mutation helper',
      );

      await vi.advanceTimersByTimeAsync(150);
      await quiesce;
      expect(runCommand).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps replacement fenced until killed Agent old dockerd finishes its late commit and stops', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyabase-docker-startup-barrier-'));
    const lockPath = path.join(root, 'physical-mutation.lock');
    const fakeSystemctlPath = path.join(root, 'systemctl');
    const cgroupRoot = path.join(root, 'cgroup');
    const daemonPidPath = path.join(root, 'dockerd.pid');
    const daemonReadyPath = path.join(root, 'dockerd.ready');
    const helperPidPath = path.join(root, 'barrier-helper.pid');
    const eventsPath = path.join(root, 'events');
    let daemon: ChildProcess | undefined;
    let worker: ChildProcess | undefined;
    let helperPid: number | undefined;

    try {
      fs.mkdirSync(cgroupRoot, { mode: 0o700 });
      fs.writeFileSync(fakeSystemctlPath, fakeSystemctlScript({
        daemonPidPath,
        eventsPath,
      }), { mode: 0o700 });

      const daemonScript = [
        "const fs = require('fs');",
        `const pidPath = ${JSON.stringify(daemonPidPath)};`,
        `const readyPath = ${JSON.stringify(daemonReadyPath)};`,
        `const eventsPath = ${JSON.stringify(eventsPath)};`,
        "fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 });",
        "fs.writeFileSync(readyPath, 'ready', { mode: 0o600 });",
        'let stopping = false;',
        "process.on('SIGTERM', () => {",
        '  if (stopping) return;',
        '  stopping = true;',
        "  fs.appendFileSync(eventsPath, 'daemon-stop-signal\\n');",
        '  setTimeout(() => {',
        "    fs.appendFileSync(eventsPath, 'old-request-late-commit\\n');",
        '    fs.rmSync(pidPath, { force: true });',
        '    process.exit(0);',
        '  }, 300);',
        '});',
        'setInterval(() => {}, 1_000);',
      ].join('\n');
      daemon = spawn(process.execPath, ['-e', daemonScript], { stdio: 'ignore' });
      const daemonClosed = waitForClose(daemon, 5_000);
      await waitForFile(daemonReadyPath, 3_000);

      const quiesce = startupDockerQuiesceCommand({
        systemctlPath: fakeSystemctlPath,
        cgroupRoot,
      });
      const fenced = fencePhysicalMutationCommand(quiesce.executable, quiesce.args, lockPath);
      const workerScript = [
        "const fs = require('fs');",
        "const { spawn } = require('child_process');",
        'const [command, argsJson, helperPidPath] = process.argv.slice(1);',
        "const helper = spawn(command, JSON.parse(argsJson), { detached: true, stdio: 'ignore' });",
        'fs.writeFileSync(helperPidPath, String(helper.pid), { mode: 0o600 });',
        'helper.unref();',
        'setInterval(() => {}, 1_000);',
      ].join('\n');
      worker = spawn(process.execPath, [
        '-e',
        workerScript,
        fenced.executable,
        JSON.stringify(fenced.args),
        helperPidPath,
      ], { stdio: 'ignore' });

      await waitForEvent(eventsPath, 'systemctl-stop-start', 3_000);
      await waitForFile(helperPidPath, 3_000);
      helperPid = Number.parseInt(fs.readFileSync(helperPidPath, 'utf8'), 10);
      const originalInode = fs.statSync(lockPath).ino;

      const workerClosed = waitForClose(worker, 3_000);
      expect(worker.kill('SIGKILL')).toBe(true);
      await workerClosed;
      expect(() => process.kill(helperPid!, 0)).not.toThrow();

      const replacement = quiesceDockerBeforeAgentStartup({
        physicalMutationLockPath: lockPath,
        systemctlPath: fakeSystemctlPath,
        cgroupRoot,
        timeoutMs: 2_000,
      }).then(() => {
        fs.appendFileSync(eventsPath, 'replacement-open\n');
      });
      await delay(100);
      expect(readEvents(eventsPath)).not.toContain('old-request-late-commit');
      expect(readEvents(eventsPath)).not.toContain('replacement-open');
      expect(fs.statSync(lockPath).ino).toBe(originalInode);

      await daemonClosed;
      await waitForEvent(eventsPath, 'systemctl-stop-done', 3_000);
      await replacement;

      const events = readEvents(eventsPath);
      expect(events.indexOf('old-request-late-commit')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('replacement-open'))
        .toBeGreaterThan(events.indexOf('old-request-late-commit'));
      expect(fs.statSync(lockPath).ino).toBe(originalInode);
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
      if (helperPid !== undefined) {
        try { process.kill(helperPid, 'SIGKILL'); } catch { /* already exited */ }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 12_000);

  it('force-kills residual processes left by an old KillMode=process unit before success', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyabase-docker-old-unit-'));
    const lockPath = path.join(root, 'physical-mutation.lock');
    const fakeSystemctlPath = path.join(root, 'systemctl');
    const cgroupRoot = path.join(root, 'cgroup');
    const unitCgroup = path.join(cgroupRoot, 'system.slice', 'nyabase-docker.service');
    const processesPath = path.join(unitCgroup, 'cgroup.procs');
    const killProofPath = path.join(root, 'kill-proof');
    try {
      fs.mkdirSync(unitCgroup, { recursive: true });
      fs.writeFileSync(processesPath, '4242\n');
      fs.writeFileSync(fakeSystemctlPath, `#!/bin/sh
set -eu
case "$1" in
  stop) exit 0 ;;
  kill) : > ${shellQuote(processesPath)}; printf killed > ${shellQuote(killProofPath)}; exit 0 ;;
  show) printf 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=/system.slice/nyabase-docker.service\n'; exit 0 ;;
esac
exit 2
`, { mode: 0o700 });

      await expect(quiesceDockerBeforeAgentStartup({
        physicalMutationLockPath: lockPath,
        systemctlPath: fakeSystemctlPath,
        cgroupRoot,
        proofAttempts: 2,
        proofPollSeconds: 0.01,
      })).resolves.toBeUndefined();
      expect(fs.readFileSync(killProofPath, 'utf8')).toBe('killed');
      expect(fs.readFileSync(processesPath, 'utf8')).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses success while systemctl still reports an active main process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyabase-docker-active-unit-'));
    const lockPath = path.join(root, 'physical-mutation.lock');
    const fakeSystemctlPath = path.join(root, 'systemctl');
    const cgroupRoot = path.join(root, 'cgroup');
    try {
      fs.mkdirSync(cgroupRoot);
      fs.writeFileSync(fakeSystemctlPath, `#!/bin/sh
set -eu
case "$1" in
  stop|kill) exit 0 ;;
  show) printf 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=1234\nControlGroup=/system.slice/nyabase-docker.service\n'; exit 0 ;;
esac
exit 2
`, { mode: 0o700 });

      await expect(quiesceDockerBeforeAgentStartup({
        physicalMutationLockPath: lockPath,
        systemctlPath: fakeSystemctlPath,
        cgroupRoot,
        proofAttempts: 2,
        proofPollSeconds: 0.01,
      })).rejects.toThrow('/bin/sh exited without success');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function fakeSystemctlScript(paths: {
  daemonPidPath: string;
  eventsPath: string;
}): string {
  return `#!/bin/sh
set -eu
command=$1
if [ "$command" = stop ]; then
  printf '%s\n' systemctl-stop-start >> ${shellQuote(paths.eventsPath)}
  if [ -f ${shellQuote(paths.daemonPidPath)} ]; then
    pid=$(cat ${shellQuote(paths.daemonPidPath)})
    kill -TERM "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do sleep 0.02; done
  fi
  printf '%s\n' systemctl-stop-done >> ${shellQuote(paths.eventsPath)}
  exit 0
fi
if [ "$command" = show ]; then
  if [ -f ${shellQuote(paths.daemonPidPath)} ]; then
    pid=$(cat ${shellQuote(paths.daemonPidPath)})
    active=active
  else
    pid=0
    active=inactive
  fi
  printf 'LoadState=loaded\nActiveState=%s\nSubState=dead\nMainPID=%s\nControlGroup=\n' "$active" "$pid"
  exit 0
fi
exit 2
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForEvent(filePath: string, event: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readEvents(filePath).includes(event)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${event}`);
}

function readEvents(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for pid ${String(child.pid)}`)), timeoutMs);
    timer.unref();
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
