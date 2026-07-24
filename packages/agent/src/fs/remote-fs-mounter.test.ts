import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RemoteFsType, type RemoteFsMountSpec } from '@nyabase/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalReferenceGuardError } from '../docker/physical-reference-guard.js';
import { unwrapFencedCommandForTest } from '../physical-mutation-fence.js';
import { RemoteFsMounter } from './remote-fs-mounter.js';
import { readProcMountInfoFresh } from './proc-mounts.js';
import { FsCleanupIncompleteError, type FsMountDriver } from './fs-driver.js';
import { EXACT_UNMOUNT_HELPER_SCRIPT } from './exact-unmount-helper.js';

vi.mock('child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('./proc-mounts.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./proc-mounts.js')>(),
  readProcMountInfoFresh: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);
const spawnMock = vi.mocked(spawn);
const readProcMountInfoFreshMock = vi.mocked(readProcMountInfoFresh);
const allowReferences = {
  assertNoRunningBindReferences: vi.fn().mockResolvedValue(undefined),
};

type ExecFileCallback = (
  error: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

function callbackFrom(args: unknown[]): ExecFileCallback {
  const callback = args.at(-1);
  if (typeof callback !== 'function') throw new Error('expected execFile callback');
  return callback as ExecFileCallback;
}

describe('RemoteFsMounter', () => {
  let tmpRoot: string;
  let allowedRoot: string;
  let procMounts: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nyabase-remote-fs-'));
    allowedRoot = path.join(tmpRoot, 'remote-fs');
    fs.mkdirSync(allowedRoot, { recursive: true });
    procMounts = '';
    readProcMountInfoFreshMock.mockImplementation(async () => mountInfoFromProcMounts(procMounts));
    mockLogicalSpawn((command, commandArgs) => {
      if (command === 'mount') {
        return fakeSpawn(() => {
          const source = commandArgs.at(-2) ?? '';
          const mountPoint = commandArgs.at(-1) ?? '';
          const version = commandArgs.join(',').includes('vers=4.1') ? '4.1' : '4.2';
          procMounts += `${source} ${mountPoint} nfs rw,vers=${version} 0 0\n`;
        });
      }
      if (command === 'umount') {
        return fakeSpawn(() => {
          const mountPoint = commandArgs.at(-1);
          procMounts = procMounts.split('\n')
            .filter((line) => line && line.split(/\s+/)[1] !== mountPoint)
            .map((line) => `${line}\n`)
            .join('');
        });
      }
      throw new Error(`unexpected spawned command ${command}`);
    });
    execFileMock.mockImplementation(((command: string, _commandArgs: readonly string[], ...rest: unknown[]) => {
      const callback = callbackFrom(rest);
      if (command === 'df') {
        callback(null, { stdout: '1B-blocks Used\n1024 256\n', stderr: '' });
        return;
      }
      throw new Error(`unexpected command ${command}`);
    }) as typeof execFile);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function createMounter(
    onStatus: ConstructorParameters<typeof RemoteFsMounter>[0],
    options: ConstructorParameters<typeof RemoteFsMounter>[1] = {},
  ): RemoteFsMounter {
    return new RemoteFsMounter(onStatus, {
      physicalMutationLockPath: path.join(tmpRoot, 'physical-mutation.lock'),
      physicalReferenceGuard: allowReferences,
      ...options,
    });
  }

  it('uses fresh probes and skips an already matching physical mount', async () => {
    const statuses: unknown[] = [];
    const mounter = createMounter((status) => statuses.push(status), {
      allowedHostMountRoots: [allowedRoot],
    });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));

    await mounter.applyMount(spec);
    await mounter.applyMount(spec);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(readProcMountInfoFreshMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(statuses).toContainEqual(expect.objectContaining({
      id: spec.id,
      status: 'mounted',
    }));
  });

  it('throws mount failures synchronously and never schedules an autonomous retry', async () => {
    mockLogicalSpawn(() => fakeSpawn(() => {}, 32));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));

    await expect(mounter.applyMount(spec)).rejects.toThrow('mount exited without success');
    await Promise.resolve();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(mounter.getStatus(spec.id)).toMatchObject({ status: 'error' });
    setTimeoutSpy.mockRestore();
  });

  it('does not report success when mount returns but a fresh probe cannot see it', async () => {
    mockLogicalSpawn(() => fakeSpawn(() => {}));
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));

    await expect(mounter.applyMount(spec)).rejects.toThrow('without the requested mount identity');
    expect(mounter.getStatus(spec.id)).toMatchObject({ status: 'error' });
  });

  it('accepts an errored mount command only when a fresh probe proves completion', async () => {
    mockLogicalSpawn((_command, commandArgs) => (
      fakeSpawn(() => {
        procMounts = `${commandArgs.at(-2)} ${commandArgs.at(-1)} nfs rw,vers=4.2 0 0\n`;
      }, 32)
    ));
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));

    await expect(mounter.applyMount(spec)).resolves.toMatchObject({ id: spec.id });
    expect(mounter.getStatus(spec.id)).toMatchObject({ status: 'mounted' });
  });

  it('never converts incomplete Ceph secret cleanup into mount success', async () => {
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    const cleanupFailure = new FsCleanupIncompleteError(
      'CephFS attempt secret cleanup is incomplete',
      new Error('secret unlink failed'),
    );
    const driver: FsMountDriver = {
      type: 'nfs',
      mount: vi.fn(async () => {
        procMounts = `10.0.0.10:/exports/project ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
        throw cleanupFailure;
      }),
      matchesCurrent: (_requested, current) => current.src === '10.0.0.10:/exports/project',
      selfCheck: vi.fn(async () => ({
        id: 'nfs',
        label: 'test driver',
        status: 'ok' as const,
        message: 'test driver ready',
      })),
    };
    (mounter as unknown as { drivers: Map<string, FsMountDriver> }).drivers.set('nfs', driver);

    await expect(mounter.applyMount(spec)).rejects.toBe(cleanupFailure);
    expect(mounter.getStatus(spec.id)).toMatchObject({
      status: 'error',
      error: 'CephFS attempt secret cleanup is incomplete',
    });
  });

  it('rejects incomplete secret cleanup on the exact-mount fast path', async () => {
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    procMounts = `10.0.0.10:/exports/project ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
    const cleanupFailure = new FsCleanupIncompleteError(
      'CephFS stale secret cleanup is incomplete',
      new Error('stale secret unlink failed'),
    );
    const mount = vi.fn(async () => {});
    const driver: FsMountDriver = {
      type: 'nfs',
      mount,
      cleanup: vi.fn(async () => {
        throw cleanupFailure;
      }),
      matchesCurrent: (_requested, current) => current.src === '10.0.0.10:/exports/project',
      selfCheck: vi.fn(async () => ({
        id: 'nfs',
        label: 'test driver',
        status: 'ok' as const,
        message: 'test driver ready',
      })),
    };
    (mounter as unknown as { drivers: Map<string, FsMountDriver> }).drivers.set('nfs', driver);

    await expect(mounter.applyMount(spec)).rejects.toBe(cleanupFailure);
    expect(mount).not.toHaveBeenCalled();
    expect(mounter.getStatus(spec.id)).toMatchObject({
      status: 'error',
      error: 'CephFS stale secret cleanup is incomplete',
    });
  });

  it('fails closed for absent without a full known spec or with a mismatched mount', async () => {
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));

    await expect(mounter.removeMount(spec.id)).rejects.toThrow('requires a full spec');

    procMounts = `10.0.0.99:/other ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
    await expect(mounter.removeMount(spec.id, {
      hostMountPoint: spec.hostMountPoint,
      options: spec.options,
      params: spec.params,
    })).rejects.toThrow('does not match the full absent spec');
    expect(logicalSpawnCalls().some(([command]) => command === 'umount')).toBe(false);
  });

  it('refuses to replace a stale/unknown mount even when Docker has no references', async () => {
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    procMounts = `10.0.0.99:/stale ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
    const physicalReferenceGuard = { assertNoRunningBindReferences: vi.fn() };
    const mounter = createMounter(() => {}, {
      allowedHostMountRoots: [allowedRoot],
      physicalReferenceGuard,
    });

    await expect(mounter.applyMount(spec)).rejects.toThrow('immutable Backend spec');
    expect(physicalReferenceGuard.assertNoRunningBindReferences).not.toHaveBeenCalled();
    expect(logicalSpawnCalls().some(([command]) => command === 'umount')).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('checks fresh Docker references before mounting onto an absent path', async () => {
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    const physicalReferenceGuard = {
      assertNoRunningBindReferences: vi.fn().mockRejectedValue(new PhysicalReferenceGuardError(
        'physical_path_referenced',
        'runtime retains the underlying directory',
        { targetPath: spec.hostMountPoint, runtimeId: 'runtime-a' },
      )),
    };
    const mounter = createMounter(() => {}, {
      allowedHostMountRoots: [allowedRoot],
      physicalReferenceGuard,
    });

    await expect(mounter.applyMount(spec)).rejects.toMatchObject({
      code: 'physical_path_referenced',
    });
    expect(physicalReferenceGuard.assertNoRunningBindReferences)
      .toHaveBeenCalledWith(spec.hostMountPoint);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('unmounts only after the full absent spec matches and verifies absence freshly', async () => {
    const mounter = createMounter(() => {}, {
      allowedHostMountRoots: [allowedRoot],
      physicalReferenceGuard: allowReferences,
    });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    procMounts = `10.0.0.10:/exports/project ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;

    await mounter.removeMount(spec.id, {
      hostMountPoint: spec.hostMountPoint,
      options: spec.options,
      params: spec.params,
    });
    await mounter.removeMount(spec.id, {
      hostMountPoint: spec.hostMountPoint,
      options: spec.options,
      params: spec.params,
    });

    expect(logicalSpawnCalls()).toContainEqual(['umount', ['--', spec.hostMountPoint]]);
    expect(logicalSpawnCalls().filter(([command]) => command === 'umount')).toHaveLength(1);
    expect(readProcMountInfoFreshMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects stacked exact mounts without calling umount', async () => {
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    procMounts = [
      `10.0.0.10:/exports/project ${spec.hostMountPoint} nfs rw,vers=4.2 0 0`,
      `10.0.0.10:/exports/project ${spec.hostMountPoint} nfs rw,vers=4.2 0 0`,
      '',
    ].join('\n');
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });

    await expect(mounter.removeMount(spec.id, {
      hostMountPoint: spec.hostMountPoint,
      options: spec.options,
      params: spec.params,
    })).rejects.toThrow('ambiguous stacked mount');
    expect(logicalSpawnCalls().some(([command]) => command === 'umount')).toBe(false);
  });

  it('rechecks exact mount identity after the Docker reference scan', async () => {
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    procMounts = `10.0.0.10:/exports/project ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
    const physicalReferenceGuard = {
      assertNoRunningBindReferences: vi.fn().mockImplementation(async () => {
        procMounts = `10.0.0.99:/foreign ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
      }),
    };
    const mounter = createMounter(() => {}, {
      allowedHostMountRoots: [allowedRoot],
      physicalReferenceGuard,
    });

    await expect(mounter.removeMount(spec.id, {
      hostMountPoint: spec.hostMountPoint,
      options: spec.options,
      params: spec.params,
    })).rejects.toThrow('mount identity changed');
    expect(logicalSpawnCalls().some(([command]) => command === 'umount')).toBe(false);
  });

  it('accepts an errored umount only when a fresh probe proves absence', async () => {
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    procMounts = `10.0.0.10:/exports/project ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
    mockLogicalSpawn((command) => {
      if (command !== 'umount') throw new Error(`unexpected command ${command}`);
      return fakeSpawn(() => { procMounts = ''; }, 32);
    });
    const mounter = createMounter(() => {}, {
      allowedHostMountRoots: [allowedRoot],
      physicalReferenceGuard: allowReferences,
    });

    await expect(mounter.removeMount(spec.id, {
      hostMountPoint: spec.hostMountPoint,
      options: spec.options,
      params: spec.params,
    })).resolves.toBeUndefined();
  });

  it('adopts a fully validated bootstrap without performing mount effects', async () => {
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    await expect(mounter.adoptSnapshot([
      remoteSpec(path.join(allowedRoot, 'remote-1'), 'remote-1'),
      remoteSpec(path.join(allowedRoot, 'remote-1'), 'remote-1'),
    ])).rejects.toThrow('duplicate id');
    expect(spawnMock).not.toHaveBeenCalled();

    const healthy = remoteSpec(path.join(allowedRoot, 'remote-healthy'), 'remote-healthy');
    procMounts = `10.0.0.10:/exports/project ${healthy.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
    const statuses = await mounter.adoptSnapshot([
      remoteSpec(path.join(allowedRoot, 'remote-failed'), 'remote-failed'),
      healthy,
    ]);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'remote-failed', status: 'error' }),
      expect.objectContaining({ id: 'remote-healthy', status: 'mounted' }),
    ]));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(logicalSpawnCalls().some(([command]) => command === 'umount')).toBe(false);
  });

  it('uses only lexical validation and fresh mountinfo for bootstrap identity observations', async () => {
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    procMounts = `10.0.0.10:/exports/project ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
    const lstatSpy = vi.spyOn(fs.promises, 'lstat');
    const realpathSpy = vi.spyOn(fs.promises, 'realpath');
    try {
      const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
      await mounter.adoptSnapshot([spec]);
      await expect(mounter.observeMountedIdentity(spec)).resolves.toEqual(expect.any(String));

      expect(lstatSpy).not.toHaveBeenCalled();
      expect(realpathSpy).not.toHaveBeenCalled();
      expect(readProcMountInfoFreshMock).toHaveBeenCalled();
    } finally {
      lstatSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });

  it('turns a bootstrap observation failure into per-mount error state', async () => {
    readProcMountInfoFreshMock.mockRejectedValueOnce(new Error('proc unavailable'));
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });

    await expect(mounter.adoptSnapshot([
      remoteSpec(path.join(allowedRoot, 'remote-1')),
    ])).resolves.toContainEqual(expect.objectContaining({
      id: 'remote-1',
      status: 'error',
      error: expect.stringContaining('proc unavailable'),
    }));
  });

  it('forgets connection-local specs without unmounting physical resources', async () => {
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    procMounts = `10.0.0.10:/exports/project ${spec.hostMountPoint} nfs rw,vers=4.2 0 0\n`;
    await mounter.adoptSnapshot([spec]);

    mounter.resetConnection();

    expect(mounter.getAllSpecs()).toEqual([]);
    expect(logicalSpawnCalls().some(([command]) => command === 'umount')).toBe(false);
  });

  it('refreshes reported status from /proc instead of replaying an in-memory mounted flag', async () => {
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    const spec = remoteSpec(path.join(allowedRoot, 'remote-1'));
    await mounter.applyMount(spec);
    procMounts = '';

    await expect(mounter.getAllStatuses()).resolves.toContainEqual(expect.objectContaining({
      id: spec.id,
      status: 'error',
      error: 'Mount is absent',
    }));
  });

  it('rejects traversal, paths outside the allowlist, and symlink components', async () => {
    const mounter = createMounter(() => {}, { allowedHostMountRoots: [allowedRoot] });
    await expect(mounter.applyMount(remoteSpec(`${allowedRoot}/../escape`)))
      .rejects.toThrow('must not contain . or ..');
    await expect(mounter.applyMount(remoteSpec(path.join(tmpRoot, 'elsewhere'))))
      .rejects.toThrow('must be under');

    const target = path.join(tmpRoot, 'target');
    const link = path.join(allowedRoot, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    await expect(mounter.applyMount(remoteSpec(path.join(link, 'remote-1'))))
      .rejects.toThrow('must not contain symlinks');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

function mountInfoFromProcMounts(procMounts: string): string {
  return procMounts.split('\n').filter(Boolean).map((line, index) => {
    const [source, mountPoint, fsType, options] = line.split(/\s+/);
    return `${100 + index} 1 0:${100 + index} / ${mountPoint} ${options} - ${fsType} ${source} ${options}`;
  }).join('\n');
}

function remoteSpec(hostMountPoint: string, id = 'remote-1'): RemoteFsMountSpec {
  return {
    id,
    hostMountPoint,
    options: '',
    params: {
      type: RemoteFsType.Nfs,
      nfsServer: '10.0.0.10',
      exportPath: '/exports/project',
      version: '4.2',
    },
  };
}

function fakeSpawn(effect: () => void, exitCode = 0) {
  const child = {
    pid: 42_424,
    kill: vi.fn(),
    once: vi.fn(),
  };
  child.once.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'close') {
      queueMicrotask(() => {
        effect();
        listener(exitCode, null);
      });
    }
    return child;
  });
  return child as never;
}

function mockLogicalSpawn(
  implementation: (command: string, args: readonly string[]) => ReturnType<typeof fakeSpawn>,
): void {
  spawnMock.mockImplementation(((command: string, args: readonly string[]) => {
    const logical = unwrapFencedCommandForTest(command, args);
    const normalized = normalizeExactUnmountCommand(logical.executable, logical.args);
    return implementation(normalized[0], normalized[1]);
  }) as unknown as typeof spawn);
}

function logicalSpawnCalls(): Array<[string, readonly string[]]> {
  return spawnMock.mock.calls.map(([command, args]) => {
    const logical = unwrapFencedCommandForTest(
      String(command),
      Array.isArray(args) ? args as string[] : [],
    );
    return normalizeExactUnmountCommand(logical.executable, logical.args);
  });
}

function normalizeExactUnmountCommand(
  executable: string,
  args: readonly string[],
): [string, readonly string[]] {
  if (executable !== process.execPath || args[0] !== '-e' || args[1] !== EXACT_UNMOUNT_HELPER_SCRIPT) {
    return [executable, args];
  }
  const expected = JSON.parse(args[2]) as { mountPoint: string };
  return ['umount', ['--', expected.mountPoint]];
}
