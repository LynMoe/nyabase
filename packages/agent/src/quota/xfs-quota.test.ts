import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unwrapFencedCommandForTest } from '../physical-mutation-fence.js';
import {
  normalizeXfsQuotaBytes,
  spawnPinnedXfsCommand,
  XfsQuotaManager,
  type XfsQuotaManagerOptions,
} from './xfs-quota.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    realpathSync: vi.fn((value: fs.PathLike) => String(value)),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const spawnMock = vi.fn();
const testFenceRoot = fs.mkdtempSync(join(tmpdir(), 'nyabase-xfs-fence-'));
const testFencePath = join(testFenceRoot, 'physical-mutation.lock');
const existsSyncMock = vi.mocked(fs.existsSync);
const realpathSyncMock = vi.mocked(fs.realpathSync);
const readFileSyncMock = vi.mocked(fs.readFileSync);
const writeFileSyncMock = vi.mocked(fs.writeFileSync);
const renameSyncMock = vi.mocked(fs.renameSync);

const DEFAULT_MOUNTINFO = [
  '23 18 0:20 / / rw,relatime - ext4 /dev/root rw',
  '42 23 8:16 / /data rw,relatime - xfs /dev/sdb rw,prjquota',
].join('\n');

function mockMountInfo(mountInfo = DEFAULT_MOUNTINFO): void {
  readFileSyncMock.mockImplementation((filePath) => {
    if (filePath === '/proc/self/mountinfo') return mountInfo;
    return '';
  });
}

function mockExecFile(
  handler: (cmd: string, args: readonly string[]) => { stdout?: string; stderr?: string; error?: Error },
): void {
  spawnMock.mockImplementation(((cmd: string, args: readonly string[]) => {
    const logical = unwrapFencedCommandForTest(cmd, args);
    const result = handler(logical.executable, logical.args);
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn();
    queueMicrotask(() => {
      const error = result.error as (Error & { code?: unknown; stdout?: string; stderr?: string }) | undefined;
      stdout.end(result.stdout ?? error?.stdout ?? '');
      stderr.end(result.stderr ?? error?.stderr ?? '');
      child.emit('close', error ? (typeof error.code === 'number' ? error.code : 1) : 0, null);
    });
    return child;
  }));
}

function logicalSpawnCalls(): Array<[string, readonly string[], unknown]> {
  return spawnMock.mock.calls.map(([executable, args, options]) => {
    const logical = unwrapFencedCommandForTest(String(executable), args as readonly string[]);
    return [logical.executable, logical.args, options];
  });
}

function fakeChild(): {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn();
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = kill;
  return { child, stdout, stderr, kill };
}

function completedChild(stdoutValue = '', stderrValue = '', code = 0): ChildProcess {
  const current = fakeChild();
  queueMicrotask(() => {
    current.stdout.end(stdoutValue);
    current.stderr.end(stderrValue);
    current.child.emit('close', code, null);
  });
  return current.child;
}

function newManager(
  xfsMount: string,
  additionalXfsRoots: string[] = [],
  options: XfsQuotaManagerOptions = {},
): XfsQuotaManager {
  return new XfsQuotaManager(xfsMount, additionalXfsRoots, {
    ...options,
    spawnProcess: options.spawnProcess ?? spawnMock as unknown as typeof spawn,
    physicalMutationLockPath: options.physicalMutationLockPath ?? testFencePath,
  });
}

afterAll(async () => {
  await rm(testFenceRoot, { recursive: true, force: true });
});

function okQuotaState(accounting = 'ON', enforcement = 'ON'): string {
  return `Project quota state on /data\nAccounting: ${accounting}\nEnforcement: ${enforcement}\n`;
}

describe('XFS quota unit normalization and registration cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    realpathSyncMock.mockImplementation((value) => String(value));
  });

  it('rounds byte limits up to the 1 KiB units reported by xfs_quota', () => {
    expect(normalizeXfsQuotaBytes(0)).toBe(0);
    expect(normalizeXfsQuotaBytes(1)).toBe(1024);
    expect(normalizeXfsQuotaBytes(1024)).toBe(1024);
    expect(normalizeXfsQuotaBytes(1025)).toBe(2048);
    expect(() => normalizeXfsQuotaBytes(-1)).toThrow('Invalid quota byte limit');
  });

  it('removes only the exact user/path registration from /etc/projects', () => {
    readFileSyncMock.mockReturnValue([
      '10007:/data/target',
      '10007:/data/target-child',
      '10008:/data/target',
      '',
    ].join('\n'));

    newManager('/data').removePathFromProject(7, '/data/target');

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      `/etc/projects.nyabase-${process.pid}.tmp`,
      '10007:/data/target-child\n10008:/data/target\n',
      { mode: 0o644 },
    );
    expect(renameSyncMock).toHaveBeenCalledWith(
      `/etc/projects.nyabase-${process.pid}.tmp`,
      '/etc/projects',
    );
  });

  it('removes one exact path without guessing its numeric owner', () => {
    readFileSyncMock.mockReturnValue([
      '10007:/data/target',
      '10008:/data/sibling',
      '',
    ].join('\n'));

    const manager = newManager('/data');
    expect(manager.inspectExactPathRegistration('/data/target')).toEqual({
      path: '/data/target',
      projectId: 10007,
    });
    expect(manager.removeExactPathRegistration('/data/target')).toEqual({
      path: '/data/target',
      projectId: 10007,
    });

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      `/etc/projects.nyabase-${process.pid}.tmp`,
      '10008:/data/sibling\n',
      { mode: 0o644 },
    );
  });

  it('does not rewrite /etc/projects when the exact path is absent', () => {
    readFileSyncMock.mockReturnValue('10007:/data/other\n');

    expect(newManager('/data').removeExactPathRegistration('/data/target')).toEqual({
      path: '/data/target',
      projectId: null,
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(renameSyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate registrations', '10007:/data/target\n10007:/data/target\n'],
    ['conflicting registrations', '10007:/data/target\n10008:/data/target\n'],
    ['malformed project id', 'not-a-project:/data/target\n'],
    ['foreign project id', '9999:/data/target\n'],
    ['non-canonical project id', '010007:/data/target\n'],
    ['out-of-range project id', '4294967296:/data/target\n'],
  ])('fails closed without a write for %s', (_caseName, projects) => {
    readFileSyncMock.mockReturnValue(projects);
    const manager = newManager('/data');

    expect(() => manager.removeExactPathRegistration('/data/target')).toThrow();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(renameSyncMock).not.toHaveBeenCalled();
  });
});

describe('XfsQuotaManager fail-closed command handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    realpathSyncMock.mockImplementation((value) => String(value));
    mockMountInfo();
  });

  it('rejects when xfs_quota command execution fails', async () => {
    mockExecFile((cmd, _args) => {
      expect(cmd).toBe('xfs_quota');
      return {
        error: Object.assign(new Error('xfs_quota failed'), {
          code: 1,
          stdout: 'partial report',
          stderr: 'cannot setup path',
        }),
      };
    });

    await expect(newManager('/data').checkProjectQuotaEnforcement('/data')).rejects.toThrow(
      /check project quota state for \/data failed: command="xfs_quota -x -c state -p \/data"; code=1; message=xfs_quota exited with code 1; stdout=partial report; stderr=cannot setup path/,
    );
  });

  it('rejects when xfs_io verification fails after project assignment', async () => {
    mockExecFile((cmd, args) => {
      if (cmd === 'xfs_quota' && args[2] === 'state -p') {
        return { stdout: okQuotaState() };
      }
      if (cmd === 'xfs_quota' && String(args[2]).startsWith('project -s -p ')) {
        return {};
      }
      if (cmd === 'xfs_io') {
        return {
          error: Object.assign(new Error('xfs_io failed'), {
            code: 5,
            stderr: 'stat failed',
          }),
        };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
    });

    await expect(newManager('/data').addPathToProject(7, '/data/users/alice')).rejects.toThrow(
      /read project metadata for \/data\/users\/alice failed: command="xfs_io -c stat \/data\/users\/alice"; code=5; message=xfs_io exited with code 5; stderr=stat failed/,
    );

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      `/etc/projects.nyabase-${process.pid}.tmp`,
      '10007:/data/users/alice\n',
      { mode: 0o644 },
    );
  });

  it('fail-stops a stalled quota mutation, poisons the manager, and never settles either call', async () => {
    const stalled = fakeChild();
    const fatalHook = vi.fn();
    spawnMock.mockImplementation((cmd: string, args: readonly string[]) => {
      const logical = unwrapFencedCommandForTest(cmd, args);
      if (logical.executable === 'xfs_quota' && logical.args[2] === 'state -p') {
        return completedChild(okQuotaState());
      }
      if (logical.executable === 'xfs_quota' && String(logical.args[2]).startsWith('limit -p ')) {
        return stalled.child;
      }
      throw new Error(`unexpected command ${logical.executable} ${logical.args.join(' ')}`);
    });
    const manager = newManager('/data', [], {
      commandTimeoutMs: 15,
      fatalHook,
    });

    const mutation = manager.setLimit(7, 1024);
    let mutationOutcome = 'pending';
    void mutation.then(() => { mutationOutcome = 'fulfilled'; }, () => { mutationOutcome = 'rejected'; });
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce());

    expect(fatalHook.mock.calls[0][0]).toMatchObject({
      mode: 'mutation',
      operation: expect.stringContaining('set hard limit'),
    });
    expect(stalled.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mutationOutcome).toBe('pending');

    const retry = manager.getAllUsages();
    let retryOutcome = 'pending';
    void retry.then(() => { retryOutcome = 'fulfilled'; }, () => { retryOutcome = 'rejected'; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(retryOutcome).toBe('pending');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('fail-stops a stalled read observation so no later mutation can overlap it', async () => {
    const stalled = fakeChild();
    const fatalHook = vi.fn();
    spawnMock.mockReturnValue(stalled.child);
    const manager = newManager('/data', [], {
      commandTimeoutMs: 15,
      fatalHook,
    });

    const observation = manager.getAllUsages();
    let observationOutcome = 'pending';
    void observation.then(() => { observationOutcome = 'fulfilled'; }, () => { observationOutcome = 'rejected'; });
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce());

    expect(fatalHook.mock.calls[0][0]).toMatchObject({ mode: 'observation' });
    expect(stalled.kill).toHaveBeenCalledWith('SIGKILL');
    expect(observationOutcome).toBe('pending');

    const mutation = manager.setLimit(7, 1024);
    let mutationOutcome = 'pending';
    void mutation.then(() => { mutationOutcome = 'fulfilled'; }, () => { mutationOutcome = 'rejected'; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mutationOutcome).toBe('pending');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('treats a process transport error after spawn as ambiguous and fail-stops', async () => {
    const stalled = fakeChild();
    Object.defineProperty(stalled.child, 'pid', { value: 412345, configurable: true });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const fatalHook = vi.fn();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => stalled.child.emit('error', new Error('transport lost')));
      return stalled.child;
    });
    const manager = newManager('/data', [], { commandTimeoutMs: 1_000, fatalHook });

    const observation = manager.getAllUsages();
    let outcome = 'pending';
    void observation.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce());

    expect(killSpy).toHaveBeenCalledWith(-412345, 'SIGKILL');
    expect(fatalHook.mock.calls[0][0]).toMatchObject({
      mode: 'observation',
      reason: expect.stringContaining('transport lost'),
    });
    expect(outcome).toBe('pending');
    killSpy.mockRestore();
  });

  it('fail-stops when the command leader closes but its process group still has a descendant', async () => {
    const current = fakeChild();
    Object.defineProperty(current.child, 'pid', { value: 434567, configurable: true });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const fatalHook = vi.fn();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => current.child.emit('close', 0, null));
      return current.child;
    });
    const manager = newManager('/data', [], { commandTimeoutMs: 1_000, fatalHook });
    try {
      const observation = manager.getAllUsages();
      let outcome = 'pending';
      void observation.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
      await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce());

      expect(killSpy).toHaveBeenCalledWith(-434567, 0);
      expect(killSpy).toHaveBeenCalledWith(-434567, 'SIGKILL');
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        reason: expect.stringContaining('descendant remained'),
      });
      expect(outcome).toBe('pending');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('fail-stops when captured command output exceeds its hard bound', async () => {
    const current = fakeChild();
    const fatalHook = vi.fn();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => current.stdout.write('too much output'));
      return current.child;
    });
    const manager = newManager('/data', [], {
      commandTimeoutMs: 1_000,
      commandOutputLimitBytes: 4,
      fatalHook,
    });

    const observation = manager.getAllUsages();
    let outcome = 'pending';
    void observation.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce());

    expect(current.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fatalHook.mock.calls[0][0]).toMatchObject({
      reason: expect.stringContaining('output exceeded 4 bytes'),
    });
    expect(outcome).toBe('pending');
  });

  it('does not turn a quota report failure into a successful empty usage snapshot', async () => {
    mockExecFile(() => ({ error: Object.assign(new Error('report failed'), { code: 5 }) }));
    await expect(newManager('/data').getAllUsages()).rejects.toThrow(
      'read project quota report on /data failed',
    );
  });

  it('rejects an exit-zero empty report instead of publishing zero usage', async () => {
    mockExecFile(() => ({ stdout: '' }));
    await expect(newManager('/data').getAllUsages()).rejects.toThrow(
      'Empty or unrecognized project quota report on /data',
    );
  });

  it('accepts a recognized report header when no project rows exist', async () => {
    mockExecFile(() => ({ stdout: 'Project quota on /data (/dev/sdb)\n' }));
    await expect(newManager('/data').getAllUsages()).resolves.toEqual([]);
  });
});

describe('XfsQuotaManager project quota enforcement parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    realpathSyncMock.mockImplementation((value) => String(value));
    mockMountInfo();
  });

  it.each([
    ['ON', 'ON', true, true],
    ['ON', 'OFF', true, false],
    ['OFF', 'ON', false, true],
    ['OFF', 'OFF', false, false],
  ])('parses Accounting=%s and Enforcement=%s from xfs_quota state', async (
    accounting,
    enforcement,
    expectedAccounting,
    expectedEnforcement,
  ) => {
    mockExecFile((cmd, args) => {
      expect(cmd).toBe('xfs_quota');
      expect(args).toEqual(['-x', '-c', 'state -p', '/data']);
      return { stdout: okQuotaState(accounting, enforcement) };
    });

    await expect(newManager('/data').checkProjectQuotaEnforcement()).resolves.toEqual({
      accounting: expectedAccounting,
      enforcement: expectedEnforcement,
      output: okQuotaState(accounting, enforcement).trim(),
    });
  });
});

describe('XfsQuotaManager setLimit report verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    realpathSyncMock.mockImplementation((value) => String(value));
    mockMountInfo();
  });

  it('passes when report -N -p -b -n shows the expected hard limit', async () => {
    mockExecFile((cmd, args) => {
      if (cmd !== 'xfs_quota') throw new Error(`unexpected executable ${cmd}`);
      switch (args[2]) {
        case 'state -p':
          return { stdout: okQuotaState() };
        case 'limit -p bhard=20480k 10005':
          return {};
        case 'report -N -p -b -n -L 10005 -U 10005':
          return { stdout: 'Project quota on /data\n#10005 0 0 20480 0 0\n' };
        default:
          throw new Error(`unexpected quota command ${args[2]}`);
      }
    });

    await expect(newManager('/data').setLimit(5, 20 * 1024 * 1024)).resolves.toBeUndefined();
  });

  it('deduplicates multiple configured mount aliases for one XFS filesystem', async () => {
    mockMountInfo([
      '23 18 0:20 / / rw,relatime - ext4 /dev/root rw',
      '42 23 8:16 / /data rw,relatime - xfs /dev/sdb rw,prjquota',
      '43 23 8:16 /fast /fast rw,relatime - xfs /dev/sdb rw,prjquota',
    ].join('\n'));
    mockExecFile((cmd, args) => {
      if (cmd !== 'xfs_quota') throw new Error(`unexpected executable ${cmd}`);
      if (args[2] === 'state -p') return { stdout: okQuotaState() };
      if (args[2] === 'limit -p bhard=20480k 10005') return {};
      if (args[2] === 'report -N -p -b -n -L 10005 -U 10005') return { stdout: '#10005 0 0 20480 0 0\n' };
      throw new Error(`unexpected quota command ${args[2]}`);
    });

    await expect(newManager('/data', ['/fast']).setLimit(5, 20 * 1024 * 1024))
      .resolves.toBeUndefined();
    const limitTargets = logicalSpawnCalls()
      .filter((call) => call[0] === 'xfs_quota' && call[1]?.[2] === 'limit -p bhard=20480k 10005')
      .map((call) => call[1]?.[3]);
    expect(limitTargets).toEqual(['/data']);
  });

  it('rejects quota roots that resolve to different filesystems', async () => {
    mockMountInfo([
      '23 18 0:20 / / rw,relatime - ext4 /dev/root rw',
      '42 23 8:16 / /data rw,relatime - xfs /dev/sdb rw,prjquota',
      '43 23 8:32 / /fast rw,relatime - xfs /dev/sdc rw,prjquota',
    ].join('\n'));
    await expect(newManager('/data', ['/fast']).setLimit(5, 20 * 1024 * 1024))
      .rejects.toThrow('one shared XFS filesystem');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects when the project is missing from the post-limit report', async () => {
    mockExecFile((cmd, args) => {
      if (cmd !== 'xfs_quota') throw new Error(`unexpected executable ${cmd}`);
      switch (args[2]) {
        case 'state -p':
          return { stdout: okQuotaState() };
        case 'limit -p bhard=20480k 10005':
          return {};
        case 'report -N -p -b -n -L 10005 -U 10005':
          return { stdout: 'Project quota on /data\n#99999 0 0 20480 0 0\n' };
        default:
          throw new Error(`unexpected quota command ${args[2]}`);
      }
    });

    await expect(newManager('/data').setLimit(5, 20 * 1024 * 1024)).rejects.toThrow(
      'Project 10005 is missing from quota report after limit application',
    );
  });

  it('rejects when the post-limit report hard limit does not match', async () => {
    mockExecFile((cmd, args) => {
      if (cmd !== 'xfs_quota') throw new Error(`unexpected executable ${cmd}`);
      switch (args[2]) {
        case 'state -p':
          return { stdout: okQuotaState() };
        case 'limit -p bhard=20480k 10005':
          return {};
        case 'report -N -p -b -n -L 10005 -U 10005':
          return { stdout: 'Project quota on /data\n#10005 0 0 10240 0 0\n' };
        default:
          throw new Error(`unexpected quota command ${args[2]}`);
      }
    });

    await expect(newManager('/data').setLimit(5, 20 * 1024 * 1024)).rejects.toThrow(
      'Project 10005 hard limit mismatch on /data: expected 20971520 bytes, reported 10485760 bytes',
    );
  });
});

describe('XfsQuotaManager addPathToProject verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    realpathSyncMock.mockImplementation((value) => String(value));
    mockMountInfo();
  });

  it('calls project -s -p and verifies project id, inheritance flag, and report presence', async () => {
    mockExecFile((cmd, args) => {
      if (cmd === 'xfs_quota' && args[2] === 'state -p') {
        return { stdout: okQuotaState() };
      }
      if (cmd === 'xfs_quota' && args[2] === 'project -s -p /data/users/alice 10007') {
        return {};
      }
      if (cmd === 'xfs_io' && args[1] === 'stat') {
        return { stdout: 'fsxattr.projid = 10007\nfsxattr.xflags = 0x20000000 [P]\n' };
      }
      if (cmd === 'xfs_quota' && args[2] === 'report -N -p -b -n -L 10007 -U 10007') {
        return { stdout: '#10007 0 0 5120 0 0\n' };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
    });

    await expect(newManager('/data').addPathToProject(7, '/data/users/alice')).resolves.toBeUndefined();

    expect(logicalSpawnCalls()).toContainEqual([
      'xfs_quota',
      ['-x', '-c', 'project -s -p /data/users/alice 10007', '/data'],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ]);
    expect(logicalSpawnCalls()).toContainEqual([
      'xfs_io',
      ['-c', 'stat', '/data/users/alice'],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ]);
    expect(logicalSpawnCalls()).toContainEqual([
      'xfs_quota',
      ['-x', '-c', 'report -N -p -b -n -L 10007 -U 10007', '/data'],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ]);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      `/etc/projects.nyabase-${process.pid}.tmp`,
      '10007:/data/users/alice\n',
      { mode: 0o644 },
    );
  });

  it('rewrites a parent pinned path to child fd 3 for both mutation and observation', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'nyabase-xfs-pinned-unit-'));
    const sourceFd = fs.openSync(sourceRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      const pinnedPath = `/proc/${process.pid}/fd/${sourceFd}/users/alice`;
      existsSyncMock.mockImplementation((value) => String(value) === pinnedPath);
      realpathSyncMock.mockImplementation((value) => String(value) === pinnedPath
        ? '/data/users/alice'
        : String(value));
      mockExecFile((cmd, args) => {
        if (cmd === 'xfs_quota' && args[2] === 'state -p') return { stdout: okQuotaState() };
        if (cmd === 'xfs_quota' && args[2] === 'project -s -p /proc/self/fd/3/users/alice 10007') return {};
        if (cmd === 'xfs_io' && args[2] === '/proc/self/fd/3/users/alice') {
          return { stdout: 'fsxattr.projid = 10007\nfsxattr.xflags = 0x20000000 [P]\n' };
        }
        if (cmd === 'xfs_quota' && args[2] === 'report -N -p -b -n -L 10007 -U 10007') {
          return { stdout: '#10007 0 0 5120 0 0\n' };
        }
        throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
      });

      await expect(newManager('/data').addPathToProject(
        7,
        pinnedPath,
        '/data/users/alice',
      )).resolves.toBeUndefined();

      const pinnedCalls = logicalSpawnCalls().filter(([, args]) =>
        args.some((arg) => String(arg).includes('/proc/self/fd/3')));
      expect(pinnedCalls).toHaveLength(2);
      for (const call of pinnedCalls) {
        expect((call[2] as { stdio: unknown[] }).stdio).toEqual([
          'ignore', 'pipe', 'pipe', sourceFd,
        ]);
      }
      expect(pinnedCalls.some(([cmd]) => cmd === 'xfs_quota')).toBe(true);
      expect(pinnedCalls.some(([cmd]) => cmd === 'xfs_io')).toBe(true);
    } finally {
      fs.closeSync(sourceFd);
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('rejects when assignment metadata lacks the project inheritance flag', async () => {
    mockExecFile((cmd, args) => {
      if (cmd === 'xfs_quota' && args[2] === 'state -p') {
        return { stdout: okQuotaState() };
      }
      if (cmd === 'xfs_quota' && String(args[2]).startsWith('project -s -p ')) {
        return {};
      }
      if (cmd === 'xfs_io') {
        return { stdout: 'fsxattr.projid = 10007\nfsxattr.xflags = 0x0 []\n' };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
    });

    await expect(newManager('/data').addPathToProject(7, '/data/users/alice')).rejects.toThrow(
      'Path /data/users/alice is missing project inheritance flag for project 10007',
    );
  });

  it('reports whether an existing path is assigned to the expected project', async () => {
    mockExecFile((cmd, args) => {
      if (cmd === 'xfs_io' && args[1] === 'stat') {
        return { stdout: 'fsxattr.projid = 10007\nfsxattr.xflags = 0x20000000 [P]\n' };
      }
      if (cmd === 'xfs_quota' && args[2] === 'report -N -p -b -n -L 10007 -U 10007') {
        return { stdout: '#10007 0 0 5120 0 0\n' };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
    });

    await expect(newManager('/data').isPathAssignedToProject(7, '/data/users/alice'))
      .resolves.toBe(true);

    mockExecFile((cmd, args) => {
      if (cmd === 'xfs_io' && args[1] === 'stat') {
        return { stdout: 'fsxattr.projid = 10008\nfsxattr.xflags = 0x20000000 [P]\n' };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
    });

    await expect(newManager('/data').isPathAssignedToProject(7, '/data/users/alice'))
      .resolves.toBe(false);
  });

  it('rejects paths outside configured roots and symlink escapes', async () => {
    await expect(newManager('/data').addPathToProject(7, '/etc/passwd'))
      .rejects.toThrow('outside configured quota roots');

    existsSyncMock.mockReturnValue(true);
    realpathSyncMock.mockReturnValue('/etc/escaped');
    await expect(newManager('/data').addPathToProject(7, '/data/link'))
      .rejects.toThrow('outside configured quota roots');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('XfsQuotaManager quota mount resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    realpathSyncMock.mockImplementation((value) => String(value));
    mockMountInfo();
  });

  it('runs quota state checks for a subdirectory against the containing mount', async () => {
    mockExecFile((cmd, args) => {
      expect(cmd).toBe('xfs_quota');
      expect(args).toEqual(['-x', '-c', 'state -p', '/data']);
      return { stdout: okQuotaState() };
    });

    await expect(
      newManager('/data').checkProjectQuotaEnforcement('/data/users/alice'),
    ).resolves.toMatchObject({
      accounting: true,
      enforcement: true,
    });
  });

  it('runs quota reports for a subdirectory-backed manager against the containing mount', async () => {
    mockExecFile((cmd, args) => {
      expect(cmd).toBe('xfs_quota');
      expect(args).toEqual(['-x', '-c', 'report -N -p -b -n', '/data']);
      return { stdout: '#10007 2 0 5120 0 0\n' };
    });

    await expect(newManager('/data/users/alice').getAllUsages()).resolves.toEqual([
      {
        numericUserId: 7,
        projectId: 10007,
        usedBytes: 2048,
        hardLimitBytes: 5 * 1024 * 1024,
      },
    ]);
  });
});

describe('spawnPinnedXfsCommand real descriptor isolation', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('keeps a late XFS helper on the original source after the Agent reuses its fd number', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'nyabase-xfs-pinned-child-'));
    tempDirs.push(fixtureRoot);
    const sourceA = join(fixtureRoot, 'source-a');
    const sourceB = join(fixtureRoot, 'source-b');
    fs.mkdirSync(sourceA);
    fs.mkdirSync(sourceB);
    const ready = join(fixtureRoot, 'ready');
    const release = join(fixtureRoot, 'release');
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    const parentSourceFd = fs.openSync(sourceA, flags);
    const script = [
      "const fs = require('fs');",
      "fs.writeFileSync(process.argv[1], 'ready');",
      'const timer = setInterval(() => {',
      '  if (!fs.existsSync(process.argv[2])) return;',
      '  clearInterval(timer);',
      "  fs.writeFileSync('/proc/self/fd/3/late-quota-touch', 'original-source');",
      '}, 1);',
    ].join('\n');
    const child = spawnPinnedXfsCommand(
      process.execPath,
      ['-e', script, ready, release],
      parentSourceFd,
      join(fixtureRoot, 'physical-mutation.lock'),
    );
    const childExit = waitForChildExit(child);

    let reusedFd: number | null = null;
    let parentFdOpen = true;
    try {
      await waitUntilAccessible(ready);
      fs.closeSync(parentSourceFd);
      parentFdOpen = false;
      reusedFd = fs.openSync(sourceB, flags);
      expect(reusedFd).toBe(parentSourceFd);

      await writeFile(release, 'go');
      await childExit;
      expect(await readFile(join(sourceA, 'late-quota-touch'), 'utf8')).toBe('original-source');
      expect(() => fs.accessSync(join(sourceB, 'late-quota-touch'))).toThrow();
    } finally {
      if (reusedFd !== null) fs.closeSync(reusedFd);
      if (parentFdOpen) fs.closeSync(parentSourceFd);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});

async function waitUntilAccessible(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      fs.accessSync(filePath);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for child exit')), 5_000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`child exited ${signal ?? String(code)}`));
    });
  });
}
