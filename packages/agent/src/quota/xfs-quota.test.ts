import { execFile } from 'child_process';
import * as fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { XfsQuotaManager } from './xfs-quota.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

const execFileMock = vi.mocked(execFile);
const existsSyncMock = vi.mocked(fs.existsSync);
const readFileSyncMock = vi.mocked(fs.readFileSync);
const appendFileSyncMock = vi.mocked(fs.appendFileSync);

type ExecFileCallback = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

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

function getExecCallback(args: unknown[]): ExecFileCallback {
  const callback = args[args.length - 1];
  if (typeof callback !== 'function') {
    throw new Error('expected execFile callback');
  }
  return callback as ExecFileCallback;
}

function mockExecFile(
  handler: (cmd: string, args: readonly string[]) => { stdout?: string; stderr?: string; error?: Error },
): void {
  execFileMock.mockImplementation(((cmd: string, args: readonly string[], ...rest: unknown[]) => {
    const callback = getExecCallback(rest);
    const result = handler(cmd, args);
    if (result.error) {
      callback(result.error, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
      return;
    }
    callback(null, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  }) as typeof execFile);
}

function okQuotaState(accounting = 'ON', enforcement = 'ON'): string {
  return `Project quota state on /data\nAccounting: ${accounting}\nEnforcement: ${enforcement}\n`;
}

describe('XfsQuotaManager fail-closed command handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    existsSyncMock.mockReturnValue(false);
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

    await expect(new XfsQuotaManager('/data').checkProjectQuotaEnforcement('/data')).rejects.toThrow(
      /check project quota state for \/data failed: command="xfs_quota -x -c state -p \/data"; code=1; message=xfs_quota failed; stdout=partial report; stderr=cannot setup path/,
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

    await expect(new XfsQuotaManager('/data').addPathToProject(7, '/data/users/alice')).rejects.toThrow(
      /read project metadata for \/data\/users\/alice failed: command="xfs_io -c stat \/data\/users\/alice"; code=5; message=xfs_io failed; stderr=stat failed/,
    );

    expect(appendFileSyncMock).toHaveBeenCalledWith('/etc/projects', '10007:/data/users/alice\n');
  });
});

describe('XfsQuotaManager project quota enforcement parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    existsSyncMock.mockReturnValue(false);
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

    await expect(new XfsQuotaManager('/data').checkProjectQuotaEnforcement()).resolves.toEqual({
      accounting: expectedAccounting,
      enforcement: expectedEnforcement,
      output: okQuotaState(accounting, enforcement).trim(),
    });
  });
});

describe('XfsQuotaManager setLimit report verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    existsSyncMock.mockReturnValue(false);
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
        case 'report -N -p -b -n':
          return { stdout: 'Project quota on /data\n#10005 0 0 20480 0 0\n' };
        default:
          throw new Error(`unexpected quota command ${args[2]}`);
      }
    });

    await expect(new XfsQuotaManager('/data').setLimit(5, 20 * 1024 * 1024)).resolves.toBeUndefined();
  });

  it('rejects when the project is missing from the post-limit report', async () => {
    mockExecFile((cmd, args) => {
      if (cmd !== 'xfs_quota') throw new Error(`unexpected executable ${cmd}`);
      switch (args[2]) {
        case 'state -p':
          return { stdout: okQuotaState() };
        case 'limit -p bhard=20480k 10005':
          return {};
        case 'report -N -p -b -n':
          return { stdout: 'Project quota on /data\n#99999 0 0 20480 0 0\n' };
        default:
          throw new Error(`unexpected quota command ${args[2]}`);
      }
    });

    await expect(new XfsQuotaManager('/data').setLimit(5, 20 * 1024 * 1024)).rejects.toThrow(
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
        case 'report -N -p -b -n':
          return { stdout: 'Project quota on /data\n#10005 0 0 10240 0 0\n' };
        default:
          throw new Error(`unexpected quota command ${args[2]}`);
      }
    });

    await expect(new XfsQuotaManager('/data').setLimit(5, 20 * 1024 * 1024)).rejects.toThrow(
      'Project 10005 hard limit mismatch: expected 20971520 bytes, reported 10485760 bytes',
    );
  });
});

describe('XfsQuotaManager addPathToProject verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    existsSyncMock.mockReturnValue(false);
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
      if (cmd === 'xfs_quota' && args[2] === 'report -N -p -b -n') {
        return { stdout: '#10007 0 0 5120 0 0\n' };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
    });

    await expect(new XfsQuotaManager('/data').addPathToProject(7, '/data/users/alice')).resolves.toBeUndefined();

    expect(execFileMock).toHaveBeenCalledWith(
      'xfs_quota',
      ['-x', '-c', 'project -s -p /data/users/alice 10007', '/data'],
      { timeout: 10_000 },
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      'xfs_io',
      ['-c', 'stat', '/data/users/alice'],
      { timeout: 10_000 },
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenCalledWith(
      'xfs_quota',
      ['-x', '-c', 'report -N -p -b -n', '/data'],
      { timeout: 10_000 },
      expect.any(Function),
    );
    expect(appendFileSyncMock).toHaveBeenCalledWith('/etc/projects', '10007:/data/users/alice\n');
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

    await expect(new XfsQuotaManager('/data').addPathToProject(7, '/data/users/alice')).rejects.toThrow(
      'Path /data/users/alice is missing project inheritance flag for project 10007',
    );
  });
});

describe('XfsQuotaManager quota mount resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    mockMountInfo();
  });

  it('runs quota state checks for a subdirectory against the containing mount', async () => {
    mockExecFile((cmd, args) => {
      expect(cmd).toBe('xfs_quota');
      expect(args).toEqual(['-x', '-c', 'state -p', '/data']);
      return { stdout: okQuotaState() };
    });

    await expect(
      new XfsQuotaManager('/data').checkProjectQuotaEnforcement('/data/users/alice'),
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

    await expect(new XfsQuotaManager('/data/users/alice').getAllUsages()).resolves.toEqual([
      {
        numericUserId: 7,
        projectId: 10007,
        usedBytes: 2048,
        hardLimitBytes: 5 * 1024 * 1024,
      },
    ]);
  });
});
