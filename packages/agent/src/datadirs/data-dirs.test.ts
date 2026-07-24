import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DataDirIdentityConflictError,
  DataDirOperationIncompleteError,
  DataDirsManager,
  type DataDirsManagerOptions,
  type DataSource,
} from './data-dirs.js';
import { unwrapFencedCommandForTest } from '../physical-mutation-fence.js';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(spawn);
const IDENTITY = 'local:xfs:uuid-a';
const RESOURCE_ID = 'datadir-a';

function fakeChild(kill = vi.fn()): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = kill;
  return child;
}

function emitChildExit(child: ChildProcess, code = 0): void {
  queueMicrotask(() => child.emit('close', code, null));
}

function emitChildError(child: ChildProcess, error: Error): void {
  queueMicrotask(() => child.emit('error', error));
}

function parentPath(childPath: string, options: unknown): string {
  const stdio = (options as { stdio: unknown[] }).stdio;
  const sourceFd = stdio[3];
  if (typeof sourceFd !== 'number') throw new Error('source fd was not inherited as child fd 3');
  return childPath.replace('/proc/self/fd/3', `/proc/${process.pid}/fd/${sourceFd}`);
}

function mockSpawn(
  implementation: (file: string, args: readonly string[], options: unknown) => ChildProcess,
): void {
  spawnMock.mockImplementation(((file: string, args: readonly string[], options: unknown) => {
    const logical = unwrapFencedCommandForTest(file, args);
    return implementation(logical.executable, logical.args, options);
  }) as typeof spawn);
}

function logicalSpawnCalls(): Array<[string, readonly string[], unknown]> {
  return spawnMock.mock.calls.map(([file, args, options]) => {
    const logical = unwrapFencedCommandForTest(String(file), args ?? []);
    return [logical.executable, logical.args, options];
  });
}

describe('DataDirsManager resource-id layout', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    mockSpawn((file: string, args: readonly string[], options: unknown) => {
      if (file === 'rm') {
        fs.rmSync(parentPath(String(args.at(-1)), options), { recursive: true, force: true });
      } else if (file === 'mv') {
        fs.renameSync(
          parentPath(String(args.at(-2)), options),
          parentPath(String(args.at(-1)), options),
        );
      }
      const child = fakeChild();
      emitChildExit(child);
      return child;
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    vi.clearAllMocks();
  });

  function managerFor(root: string, options: DataDirsManagerOptions = {}): DataDirsManager {
    const source: DataSource = {
      kind: 'local', id: 'disk-a', root, identity: IDENTITY, quotaEnabled: true,
    };
    const manager = new DataDirsManager(undefined, undefined, (current) => {
      const stat = fs.lstatSync(current.root);
      return {
        sourceId: current.id,
        kind: current.kind,
        root: current.root,
        identity: current.identity,
        configured: true,
        exists: true,
        isDirectory: true,
        mounted: true,
        fsType: 'xfs',
        ready: true,
        device: String(stat.dev),
      };
    }, {
      ...options,
      physicalMutationLockPath: options.physicalMutationLockPath ?? join(root, '.physical-mutation.lock'),
    });
    manager.addSource(source);
    return manager;
  }

  async function fixture(options: DataDirsManagerOptions = {}) {
    const root = await mkdtemp(join(tmpdir(), 'nyabase-data-dirs-'));
    tempDirs.push(root);
    return {
      root,
      manager: managerFor(root, options),
      reopen: (nextOptions: DataDirsManagerOptions = {}) => managerFor(root, nextOptions),
    };
  }

  it('requires one exact stable RemoteFS identity before and after inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyabase-remote-data-dirs-'));
    tempDirs.push(root);
    const source: DataSource = {
      kind: 'remote', id: 'remote-a', root, identity: 'remote:nfs:stable', quotaEnabled: false,
    };
    const observer = (current: DataSource) => ({
      sourceId: current.id,
      kind: current.kind,
      root: current.root,
      identity: current.identity,
      configured: true,
      exists: true,
      isDirectory: true,
      mounted: true,
      fsType: 'nfs',
      ready: true,
      device: String(fs.statSync(current.root).dev),
    });

    const unavailable = new DataDirsManager(undefined, undefined, observer, {
      remoteSourceVerifier: vi.fn().mockResolvedValue(null),
      remoteHelperRunner: vi.fn().mockResolvedValue([]),
    });
    unavailable.addSource(source);
    await expect(unavailable.listAllDirs()).rejects.toThrow('identity is unavailable');

    const swappedVerifier = vi.fn()
      .mockResolvedValueOnce('mount-id-1')
      .mockResolvedValueOnce('mount-id-2');
    const swapped = new DataDirsManager(undefined, undefined, observer, {
      remoteSourceVerifier: swappedVerifier,
      remoteHelperRunner: vi.fn().mockResolvedValue([]),
    });
    swapped.addSource(source);
    await expect(swapped.listAllDirs()).rejects.toThrow('changed during list');

    const stable = new DataDirsManager(undefined, undefined, observer, {
      remoteSourceVerifier: vi.fn().mockResolvedValue('mount-id-1'),
      remoteHelperRunner: vi.fn().mockResolvedValue([]),
    });
    stable.addSource(source);
    await expect(stable.listAllDirs()).resolves.toEqual([]);
  });

  it('leaves all remote target syscalls and stalled work inside the bounded helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyabase-remote-parent-seam-'));
    tempDirs.push(root);
    const source: DataSource = {
      kind: 'remote', id: 'remote-a', root, identity: 'remote:nfs:stable', quotaEnabled: false,
    };
    const helper = vi.fn(() => new Promise<never>(() => { /* helper owns the stall */ }));
    const targetInspector = vi.fn(() => {
      throw new Error('parent attempted a remote target filesystem syscall');
    });
    const manager = new DataDirsManager(undefined, undefined, targetInspector, {
      remoteSourceVerifier: vi.fn().mockResolvedValue('mount-id-1'),
      remoteHelperRunner: helper,
    });
    manager.addSource(source);
    let outcome = 'pending';
    void manager.listAllDirs().then(
      () => { outcome = 'fulfilled'; },
      () => { outcome = 'rejected'; },
    );
    await vi.waitFor(() => expect(helper).toHaveBeenCalledOnce());

    expect(outcome).toBe('pending');
    expect(targetInspector).not.toHaveBeenCalled();
  });

  it('rejects remote helper results that escape or contradict the configured source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nyabase-remote-helper-results-'));
    tempDirs.push(root);
    const source: DataSource = {
      kind: 'remote', id: 'remote-a', root, identity: 'remote:nfs:stable', quotaEnabled: false,
    };
    let response: unknown;
    const manager = new DataDirsManager(undefined, undefined, undefined, {
      remoteSourceVerifier: vi.fn().mockResolvedValue('mount-id-1'),
      remoteHelperRunner: vi.fn(async () => response),
    });
    manager.addSource(source);

    response = {
      path: '/escaped/data', exists: true, isDirectory: true, uid: 1001, gid: 1001,
      resourceId: RESOURCE_ID,
    };
    await expect(manager.inspectDirExact(source.id, RESOURCE_ID)).rejects.toThrow('invalid observation');

    response = [{
      sourceKind: 'remote', sourceId: 'other-source', resourceId: RESOURCE_ID,
      hostPath: join(root, '.nyabase', 'dirs', RESOURCE_ID, 'data'),
    }];
    await expect(manager.listAllDirs()).rejects.toThrow('invalid inventory entry');

    response = { path: '/escaped/data', created: true };
    await expect(manager.createDir(source.id, 1001, RESOURCE_ID, source.identity))
      .rejects.toThrow('invalid create result');

    response = `${join(root, '.nyabase', 'dirs', RESOURCE_ID, 'data')}/../escaped`;
    await expect(manager.verifyOwnership(source.id, 1001, RESOURCE_ID, source.identity))
      .rejects.toThrow('invalid ownership result');
  });

  it('creates, reports, re-enters, and deletes only the resource-id path', async () => {
    const { root, manager } = await fixture();
    const durablePath = join(root, '.nyabase', 'dirs', RESOURCE_ID, 'data');

    await expect(manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY)).resolves.toEqual({
      path: durablePath,
      created: true,
    });
    await expect(manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY)).resolves.toEqual({
      path: durablePath,
      created: false,
    });
    await expect(manager.listAllDirs()).resolves.toEqual([{
      sourceKind: 'local',
      sourceId: 'disk-a',
      resourceId: RESOURCE_ID,
      hostPath: durablePath,
    }]);
    expect(fs.existsSync(join(root, RESOURCE_ID))).toBe(false);

    await manager.deleteDir('disk-a', RESOURCE_ID, IDENTITY);
    await manager.deleteDir('disk-a', RESOURCE_ID, IDENTITY);
    expect(fs.existsSync(durablePath)).toBe(false);
  });

  it('fails authoritative inventory for a corrupt staged entry', async () => {
    const { root, manager } = await fixture();
    const dirsRoot = join(root, '.nyabase', 'dirs');
    fs.mkdirSync(dirsRoot, { recursive: true });
    const creatingRoot = join(dirsRoot, `.creating-${RESOURCE_ID}`);
    fs.mkdirSync(creatingRoot, { mode: 0o700 });
    fs.chmodSync(join(root, '.nyabase'), 0o700);
    fs.chmodSync(dirsRoot, 0o700);
    fs.writeFileSync(join(creatingRoot, 'foreign'), 'unmanaged');

    await expect(manager.listAllDirs()).rejects.toThrow('unmanaged entries');
  });

  it('never adopts or chowns an unmarked resource tree', async () => {
    const { root, manager } = await fixture();
    await mkdir(join(root, '.nyabase', 'dirs', RESOURCE_ID, 'data'), { recursive: true, mode: 0o700 });
    fs.chmodSync(join(root, '.nyabase'), 0o700);
    fs.chmodSync(join(root, '.nyabase', 'dirs'), 0o700);
    fs.chmodSync(join(root, '.nyabase', 'dirs', RESOURCE_ID), 0o700);

    await expect(manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY))
      .rejects.toBeInstanceOf(DataDirIdentityConflictError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('retains the marker and physical reservation after a partial chown failure', async () => {
    const { root, manager } = await fixture();
    mockSpawn((file: string, args: readonly string[], options: unknown) => {
      if (file === 'mv') {
        fs.renameSync(
          parentPath(String(args.at(-2)), options),
          parentPath(String(args.at(-1)), options),
        );
        const child = fakeChild();
        emitChildExit(child);
        return child;
      }
      const child = fakeChild();
      emitChildError(child, new Error('partial chown'));
      return child;
    });

    await expect(manager.createDir('disk-a', 1001, RESOURCE_ID, IDENTITY)).rejects.toThrow('partial chown');
    expect(fs.existsSync(join(root, '.nyabase', 'dirs', RESOURCE_ID, 'marker.json'))).toBe(true);
    expect(manager.inspectDir('disk-a', RESOURCE_ID).resourceId).toBe(RESOURCE_ID);
  });

  it('never resolves or deletes a marker that is not root-only metadata', async () => {
    const { root, manager } = await fixture();
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    const markerPath = join(root, '.nyabase', 'dirs', RESOURCE_ID, 'marker.json');
    fs.chmodSync(markerPath, 0o644);

    await expect(manager.resolveMountPath('disk-a', RESOURCE_ID, IDENTITY))
      .rejects.toBeInstanceOf(DataDirIdentityConflictError);
    await expect(manager.deleteDir('disk-a', RESOURCE_ID, IDENTITY))
      .rejects.toBeInstanceOf(DataDirIdentityConflictError);
    expect(fs.existsSync(join(root, '.nyabase', 'dirs', RESOURCE_ID, 'data'))).toBe(true);
  });

  it('rejects a source identity change before any mutation', async () => {
    const { root, manager } = await fixture();
    await expect(manager.createDir('disk-a', 0, RESOURCE_ID, 'local:xfs:another-uuid'))
      .rejects.toThrow('identity is unavailable or changed');
    expect(fs.existsSync(join(root, '.nyabase'))).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('routes create, ownership, delete rename, and removal through inherited child fd 3', async () => {
    const { manager } = await fixture();
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    await manager.deleteDir('disk-a', RESOURCE_ID, IDENTITY);
    const chownCall = logicalSpawnCalls().find(([file]) => file === 'chown');
    const chownPath = chownCall?.[1]?.at(-1);
    expect(chownPath).toBe(`/proc/self/fd/3/.nyabase/dirs/${RESOURCE_ID}/data`);
    expect(logicalSpawnCalls().map(([file]) => file)).toEqual([
      'mv', 'chown', 'mv', 'rm', 'rm',
    ]);
    for (const call of logicalSpawnCalls()) {
      const [, args, options] = call;
      const paths = (args ?? []).filter((arg) => String(arg).startsWith('/proc/'));
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((entry) => String(entry).startsWith('/proc/self/fd/3/'))).toBe(true);
      expect((options as { stdio: unknown[] }).stdio).toMatchObject([
        'ignore', 'ignore', 'ignore', expect.any(Number),
      ]);
    }
  });

  it('fail-stops a stalled chown and leaves the physical task promise pending', async () => {
    const fatalHook = vi.fn();
    const { root, manager } = await fixture({ mutationTimeoutMs: 15, fatalHook });
    const kill = vi.fn();
    mockSpawn((file: string, args: readonly string[], options: unknown) => {
      if (file === 'chown') {
        return fakeChild(kill);
      }
      if (file === 'mv') {
        fs.renameSync(
          parentPath(String(args.at(-2)), options),
          parentPath(String(args.at(-1)), options),
        );
      }
      const child = fakeChild();
      emitChildExit(child);
      return child;
    });

    const mutation = manager.createDir('disk-a', 1001, RESOURCE_ID, IDENTITY);
    let outcome = 'pending';
    void mutation.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce());
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(logicalSpawnCalls().filter(([file]) => file === 'chown')).toHaveLength(1);
    expect(outcome).toBe('pending');

    const retry = manager.createDir('disk-a', 1001, 'datadir-b', IDENTITY);
    let retryOutcome = 'pending';
    void retry.then(() => { retryOutcome = 'fulfilled'; }, () => { retryOutcome = 'rejected'; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(retryOutcome).toBe('pending');
    expect(logicalSpawnCalls().filter(([file]) => file === 'chown')).toHaveLength(1);
    expect(fs.existsSync(join(root, '.nyabase', 'dirs', '.creating-datadir-b'))).toBe(false);
  });

  it('fail-stops a stalled atomic rename without exposing a create outcome', async () => {
    const fatalHook = vi.fn();
    const { root, manager } = await fixture({ mutationTimeoutMs: 15, fatalHook });
    const kill = vi.fn();
    mockSpawn((file: string) => {
      if (file === 'mv') return fakeChild(kill);
      const child = fakeChild();
      emitChildExit(child);
      return child;
    });

    const mutation = manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    let outcome = 'pending';
    void mutation.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce());

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(outcome).toBe('pending');
    expect(logicalSpawnCalls().filter(([file]) => file === 'mv')).toHaveLength(1);
    expect(logicalSpawnCalls().some(([file]) => file === 'chown')).toBe(false);
    expect(fs.existsSync(join(
      root,
      '.nyabase',
      'dirs',
      `.creating-${RESOURCE_ID}`,
      'marker.json',
    ))).toBe(true);
  });

  it('fail-stops stalled tombstone removal and a replacement Agent resumes it', async () => {
    const fatalHook = vi.fn();
    const { root, manager, reopen } = await fixture({ mutationTimeoutMs: 15, fatalHook });
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    const kill = vi.fn();
    mockSpawn((file: string, args: readonly string[], options: unknown) => {
      if (file === 'rm') return fakeChild(kill);
      if (file === 'mv') {
        fs.renameSync(
          parentPath(String(args.at(-2)), options),
          parentPath(String(args.at(-1)), options),
        );
      }
      const child = fakeChild();
      emitChildExit(child);
      return child;
    });

    const remove = manager.deleteDir('disk-a', RESOURCE_ID, IDENTITY);
    let outcome = 'pending';
    void remove.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce());
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(outcome).toBe('pending');

    const resourceRoot = join(root, '.nyabase', 'dirs', RESOURCE_ID);
    const deletingRoot = join(root, '.nyabase', 'dirs', `.deleting-${RESOURCE_ID}`);
    expect(fs.existsSync(resourceRoot)).toBe(false);
    expect(fs.existsSync(join(deletingRoot, 'marker.json'))).toBe(true);
    expect(manager.inspectDir('disk-a', RESOURCE_ID)).toMatchObject({
      exists: true,
      resourceId: RESOURCE_ID,
    });

    mockSpawn((file: string, args: readonly string[], options: unknown) => {
      if (file === 'rm') {
        fs.rmSync(parentPath(String(args.at(-1)), options), { recursive: true, force: true });
      }
      const child = fakeChild();
      emitChildExit(child);
      return child;
    });
    const recovered = reopen();
    await expect(recovered.listAllDirs()).resolves.toEqual([]);
    await recovered.deleteDir('disk-a', RESOURCE_ID, IDENTITY);
    expect(fs.existsSync(deletingRoot)).toBe(false);
    expect(recovered.inspectDir('disk-a', RESOURCE_ID)).toMatchObject({
      exists: false,
      resourceId: null,
    });
  });

  it('fail-stops a mutation transport error emitted after the child was spawned', async () => {
    const fatalHook = vi.fn();
    const { manager } = await fixture({ mutationTimeoutMs: 1_000, fatalHook });
    const child = fakeChild();
    Object.defineProperty(child, 'pid', { value: 423456, configurable: true });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockSpawn(() => {
      queueMicrotask(() => child.emit('error', new Error('child transport lost')));
      return child;
    });
    try {
      const mutation = manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
      let outcome = 'pending';
      void mutation.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
      await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce());

      expect(killSpy).toHaveBeenCalledWith(-423456, 'SIGKILL');
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        operation: expect.stringContaining('process transport failed after spawn'),
      });
      expect(outcome).toBe('pending');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('publishes a fixed create tombstone after Agent restart', async () => {
    const { root, manager, reopen } = await fixture();
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    const dirsRoot = join(root, '.nyabase', 'dirs');
    const resourceRoot = join(dirsRoot, RESOURCE_ID);
    const creatingRoot = join(dirsRoot, `.creating-${RESOURCE_ID}`);
    fs.renameSync(resourceRoot, creatingRoot);

    const recovered = reopen();
    await expect(recovered.listAllDirs()).resolves.toEqual([]);
    await expect(recovered.createDir('disk-a', 0, RESOURCE_ID, IDENTITY)).resolves.toEqual({
      path: join(resourceRoot, 'data'),
      created: true,
    });
    expect(fs.existsSync(creatingRoot)).toBe(false);
    expect(JSON.parse(fs.readFileSync(join(resourceRoot, 'marker.json'), 'utf8'))).toMatchObject({
      resourceId: RESOURCE_ID,
      sourceId: 'disk-a',
      sourceIdentity: IDENTITY,
    });
  });

  it('deletes a pre-publication create tombstone and can recreate cleanly', async () => {
    const { root, manager, reopen } = await fixture();
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    const dirsRoot = join(root, '.nyabase', 'dirs');
    const resourceRoot = join(dirsRoot, RESOURCE_ID);
    const creatingRoot = join(dirsRoot, `.creating-${RESOURCE_ID}`);
    fs.renameSync(resourceRoot, creatingRoot);

    const recovered = reopen();
    await recovered.deleteDir('disk-a', RESOURCE_ID, IDENTITY);
    expect(fs.existsSync(creatingRoot)).toBe(false);
    expect(fs.existsSync(resourceRoot)).toBe(false);

    await expect(recovered.createDir('disk-a', 0, RESOURCE_ID, IDENTITY)).resolves.toEqual({
      path: join(resourceRoot, 'data'),
      created: true,
    });
    expect(fs.existsSync(join(resourceRoot, 'marker.json'))).toBe(true);
  });

  it('deletes only a controlled unmarked create tombstone', async () => {
    const { root, manager } = await fixture();
    const creatingRoot = join(root, '.nyabase', 'dirs', `.creating-${RESOURCE_ID}`);
    fs.mkdirSync(join(creatingRoot, 'data'), { recursive: true, mode: 0o700 });
    fs.chmodSync(join(root, '.nyabase'), 0o700);
    fs.chmodSync(join(root, '.nyabase', 'dirs'), 0o700);
    fs.chmodSync(creatingRoot, 0o700);
    fs.writeFileSync(join(creatingRoot, '.marker.tmp'), '{partial', { mode: 0o600 });

    await manager.deleteDir('disk-a', RESOURCE_ID, IDENTITY);
    expect(fs.existsSync(creatingRoot)).toBe(false);
  });

  it('refuses to delete a marked create tombstone with another identity', async () => {
    const { root, manager } = await fixture();
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    const dirsRoot = join(root, '.nyabase', 'dirs');
    const creatingRoot = join(dirsRoot, `.creating-${RESOURCE_ID}`);
    fs.renameSync(join(dirsRoot, RESOURCE_ID), creatingRoot);
    const markerPath = join(creatingRoot, 'marker.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(markerPath, `${JSON.stringify({ ...marker, sourceIdentity: 'local:xfs:other' })}\n`, {
      mode: 0o600,
    });

    await expect(manager.deleteDir('disk-a', RESOURCE_ID, IDENTITY))
      .rejects.toBeInstanceOf(DataDirIdentityConflictError);
    expect(fs.existsSync(creatingRoot)).toBe(true);
  });

  it('refuses to delete an unmarked create tombstone with unmanaged entries', async () => {
    const { root, manager } = await fixture();
    const creatingRoot = join(root, '.nyabase', 'dirs', `.creating-${RESOURCE_ID}`);
    fs.mkdirSync(creatingRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(join(root, '.nyabase'), 0o700);
    fs.chmodSync(join(root, '.nyabase', 'dirs'), 0o700);
    fs.chmodSync(creatingRoot, 0o700);
    fs.writeFileSync(join(creatingRoot, 'foreign'), 'do not adopt');

    await expect(manager.deleteDir('disk-a', RESOURCE_ID, IDENTITY))
      .rejects.toBeInstanceOf(DataDirIdentityConflictError);
    expect(fs.existsSync(join(creatingRoot, 'foreign'))).toBe(true);
  });

  it('caps active DataDir child processes globally', async () => {
    const { manager } = await fixture({ childProcessCap: 1, mutationTimeoutMs: 60_000 });
    let releaseFirst: (() => void) | null = null;
    mockSpawn((file: string, args: readonly string[], options: unknown) => {
      if (file === 'chown') {
        const child = fakeChild();
        releaseFirst = () => child.emit('error', new Error('stopped'));
        return child;
      }
      if (file === 'mv') {
        fs.renameSync(
          parentPath(String(args.at(-2)), options),
          parentPath(String(args.at(-1)), options),
        );
      }
      const child = fakeChild();
      emitChildExit(child);
      return child;
    });

    const first = manager.createDir('disk-a', 1001, RESOURCE_ID, IDENTITY);
    first.catch(() => { /* assertion is attached after the controlled callback */ });
    while (releaseFirst === null) await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(manager.createDir('disk-a', 1001, 'datadir-b', IDENTITY))
      .rejects.toBeInstanceOf(DataDirOperationIncompleteError);
    expect(logicalSpawnCalls().filter(([file]) => file === 'chown')).toHaveLength(1);

    const release = releaseFirst as (() => void) | null;
    if (!release) throw new Error('first DataDir child was not captured');
    release();
    await expect(first).rejects.toBeInstanceOf(DataDirOperationIncompleteError);
  });

  it('resumes marker-only tombstone finalization without treating it as identity conflict', async () => {
    const { root, manager, reopen } = await fixture();
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    const resourceRoot = join(root, '.nyabase', 'dirs', RESOURCE_ID);
    const deletingRoot = join(root, '.nyabase', 'dirs', `.deleting-${RESOURCE_ID}`);
    fs.renameSync(resourceRoot, deletingRoot);
    fs.rmSync(join(deletingRoot, 'data'), { recursive: true, force: true });

    const recovered = reopen();
    await expect(recovered.listAllDirs()).resolves.toEqual([]);
    expect(recovered.inspectDir('disk-a', RESOURCE_ID)).toMatchObject({
      exists: false,
      resourceId: RESOURCE_ID,
    });
    await recovered.deleteDir('disk-a', RESOURCE_ID, IDENTITY);
    expect(fs.existsSync(deletingRoot)).toBe(false);
  });

  it('bounds recursive ownership observation by entry count', async () => {
    const { root, manager } = await fixture({ ownershipObservationEntryCap: 2 });
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    const durablePath = join(root, '.nyabase', 'dirs', RESOURCE_ID, 'data');
    fs.writeFileSync(join(durablePath, 'one'), '1');
    fs.writeFileSync(join(durablePath, 'two'), '2');

    await expect(manager.verifyOwnership('disk-a', 0, RESOURCE_ID, IDENTITY))
      .rejects.toBeInstanceOf(DataDirOperationIncompleteError);
  });

  it('fail-stops a stalled tombstone readdir instead of continuing after its libuv timeout', async () => {
    const fatalHook = vi.fn();
    const { root, manager } = await fixture({ mutationTimeoutMs: 25, fatalHook });
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    const dirsRoot = join(root, '.nyabase', 'dirs');
    fs.renameSync(join(dirsRoot, RESOURCE_ID), join(dirsRoot, `.deleting-${RESOURCE_ID}`));
    const spawnCountBeforeProbe = spawnMock.mock.calls.length;
    vi.useFakeTimers();
    let readdirSpy: { mockRestore(): void } | undefined;
    try {
      readdirSpy = vi.spyOn(fs.promises, 'readdir').mockImplementation(
        (() => new Promise<never>(() => {})) as typeof fs.promises.readdir,
      );
      const removal = manager.deleteDir('disk-a', RESOURCE_ID, IDENTITY);
      let outcome = 'pending';
      void removal.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
      await vi.advanceTimersByTimeAsync(25);

      expect(fatalHook).toHaveBeenCalledOnce();
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        operation: `inspect-delete-tombstone(${RESOURCE_ID})`,
      });
      expect(outcome).toBe('pending');
      expect(spawnMock).toHaveBeenCalledTimes(spawnCountBeforeProbe);
    } finally {
      readdirSpy?.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fail-stops a never-resolving ownership probe and never starts a later mutation', async () => {
    const fatalHook = vi.fn();
    const { manager } = await fixture({ ownershipObservationTimeoutMs: 25, fatalHook });
    await manager.createDir('disk-a', 0, RESOURCE_ID, IDENTITY);
    const spawnCountBeforeProbe = spawnMock.mock.calls.length;
    vi.useFakeTimers();
    let lstatSpy: { mockRestore(): void } | undefined;
    try {
      lstatSpy = vi.spyOn(fs.promises, 'lstat').mockImplementation(
        (() => new Promise<never>(() => {})) as typeof fs.promises.lstat,
      );
      const verification = manager.verifyOwnership('disk-a', 0, RESOURCE_ID, IDENTITY);
      let outcome = 'pending';
      void verification.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
      await vi.advanceTimersByTimeAsync(25);
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        operation: expect.stringContaining('ownership-observation'),
      });
      expect(outcome).toBe('pending');

      const retry = manager.createDir('disk-a', 0, 'datadir-b', IDENTITY);
      let retryOutcome = 'pending';
      void retry.then(() => { retryOutcome = 'fulfilled'; }, () => { retryOutcome = 'rejected'; });
      await vi.advanceTimersByTimeAsync(1);
      expect(retryOutcome).toBe('pending');
      expect(spawnMock).toHaveBeenCalledTimes(spawnCountBeforeProbe);
    } finally {
      lstatSpy?.mockRestore();
      vi.useRealTimers();
    }
  });
});
