import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { createIsolatedCommandRunner } from './fs/isolated-command.js';
import {
  PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE,
  PhysicalMutationFenceBusyError,
  fencePhysicalMutationCommand,
} from './physical-mutation-fence.js';

describe('physical mutation fence', () => {
  it('keeps one stable inode and execs the helper under nonblocking no-fork flock', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyabase-physical-fence-shape-'));
    const lockPath = path.join(root, 'physical-mutation.lock');
    try {
      const first = fencePhysicalMutationCommand('/bin/example', ['one', 'two'], lockPath);
      const firstStat = fs.statSync(lockPath);
      const second = fencePhysicalMutationCommand('/bin/example', ['three'], lockPath);
      const secondStat = fs.statSync(lockPath);

      expect(first).toEqual({
        executable: 'flock',
        args: [
          '--exclusive',
          '--nonblock',
          '--conflict-exit-code',
          String(PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE),
          '--no-fork',
          lockPath,
          '/bin/example',
          'one',
          'two',
        ],
      });
      expect(second.args.at(-2)).toBe('/bin/example');
      expect(secondStat.ino).toBe(firstStat.ino);
      expect(secondStat.mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlink in place of the stable lock file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyabase-physical-fence-symlink-'));
    const target = path.join(root, 'target');
    const lockPath = path.join(root, 'physical-mutation.lock');
    try {
      fs.writeFileSync(target, 'do not follow');
      fs.symlinkSync(target, lockPath);
      expect(() => fencePhysicalMutationCommand('/bin/true', [], lockPath)).toThrow();
      expect(fs.readFileSync(target, 'utf8')).toBe('do not follow');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fences a replacement after the Agent parent is SIGKILLed until the old helper exits', async () => {
    expect(spawnSync('flock', ['--version'], { encoding: 'utf8' }).status).toBe(0);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyabase-physical-fence-restart-'));
    const lockPath = path.join(root, 'physical-mutation.lock');
    const readyPath = path.join(root, 'helper.ready');
    const releasePath = path.join(root, 'helper.release');
    const helperPidPath = path.join(root, 'helper.pid');
    let parent: ChildProcess | undefined;
    let helperPid: number | undefined;

    try {
      const helperScript = [
        "const fs = require('fs');",
        'const [readyPath, releasePath] = process.argv.slice(1);',
        "fs.writeFileSync(readyPath, String(process.pid), { mode: 0o600 });",
        'const timer = setInterval(() => {',
        '  if (!fs.existsSync(releasePath)) return;',
        '  clearInterval(timer);',
        '  process.exit(0);',
        '}, 20);',
      ].join('\n');
      const held = fencePhysicalMutationCommand(
        process.execPath,
        ['-e', helperScript, readyPath, releasePath],
        lockPath,
      );
      const parentScript = [
        "const fs = require('fs');",
        "const { spawn } = require('child_process');",
        'const [command, argsJson, helperPidPath] = process.argv.slice(1);',
        "const helper = spawn(command, JSON.parse(argsJson), { detached: true, stdio: 'ignore' });",
        "helper.once('error', (error) => { fs.writeFileSync(helperPidPath + '.error', error.stack); process.exit(1); });",
        'fs.writeFileSync(helperPidPath, String(helper.pid), { mode: 0o600 });',
        'helper.unref();',
        'setInterval(() => {}, 1_000);',
      ].join('\n');

      parent = spawn(process.execPath, [
        '-e',
        parentScript,
        held.executable,
        JSON.stringify(held.args),
        helperPidPath,
      ], { stdio: 'ignore' });

      await waitForFile(readyPath, 3_000);
      await waitForFile(helperPidPath, 3_000);
      helperPid = Number.parseInt(fs.readFileSync(helperPidPath, 'utf8'), 10);
      expect(Number.isSafeInteger(helperPid) && helperPid > 1).toBe(true);
      const originalInode = fs.statSync(lockPath).ino;

      const parentClosed = waitForClose(parent, 3_000);
      expect(parent.kill('SIGKILL')).toBe(true);
      await parentClosed;
      expectProcessAlive(helperPid);

      const replacement = createIsolatedCommandRunner({
        lockPath,
        fatalHook: (error) => { throw error; },
      });
      await expect(replacement(process.execPath, ['-e', ''], 2_000))
        .rejects.toBeInstanceOf(PhysicalMutationFenceBusyError);
      expect(fs.statSync(lockPath).ino).toBe(originalInode);
      expectProcessAlive(helperPid);

      fs.writeFileSync(releasePath, 'release', { mode: 0o600 });
      await waitForFenceSuccess(replacement, 3_000);
      expect(fs.statSync(lockPath).ino).toBe(originalInode);
    } finally {
      if (parent && parent.exitCode === null && parent.signalCode === null) {
        parent.kill('SIGKILL');
      }
      if (helperPid !== undefined) {
        try { process.kill(helperPid, 'SIGKILL'); } catch { /* already exited */ }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
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

function expectProcessAlive(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow();
}

async function waitForFenceSuccess(
  runner: ReturnType<typeof createIsolatedCommandRunner>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await runner(process.execPath, ['-e', ''], 1_000);
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof PhysicalMutationFenceBusyError)) throw error;
      await delay(20);
    }
  }
  throw lastError ?? new Error('Timed out waiting for physical mutation fence');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
