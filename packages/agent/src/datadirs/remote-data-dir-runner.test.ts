import { spawn, type ChildProcess } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRemoteDataDirHelperRunner,
  RemoteDataDirHelperAmbiguityError,
  RemoteDataDirHelperError,
} from './remote-data-dir-runner.js';

describe('remote DataDir helper runner', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('accepts a bounded success envelope and preserves a settled domain error', async () => {
    const lockPath = await newLockPath();
    const fatalHook = vi.fn();
    const success = createRemoteDataDirHelperRunner({
      command: () => nodeCommand("process.stdout.write(JSON.stringify({ok:true,data:{value:7}}))"),
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
      lockPath,
      fatalHook,
    });
    await expect(success('inspect', {})).resolves.toEqual({ value: 7 });

    const domainFailure = createRemoteDataDirHelperRunner({
      command: () => nodeCommand("process.stdout.write(JSON.stringify({ok:false,error:{name:'DataDirIdentityConflictError',message:'marker conflict',operation:'inspect'}}))"),
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
      lockPath,
      fatalHook,
    });
    await expect(domainFailure('inspect', {})).rejects.toMatchObject({
      name: RemoteDataDirHelperError.name,
      remoteName: 'DataDirIdentityConflictError',
      message: 'marker conflict',
      remoteOperation: 'inspect',
    });
    expect(fatalHook).not.toHaveBeenCalled();
  });

  it('kills the entire helper group on deadline and never publishes a late result', async () => {
    const lockPath = await newLockPath();
    let child: ChildProcess | undefined;
    let signalFatal!: (error: RemoteDataDirHelperAmbiguityError) => void;
    const fatal = new Promise<RemoteDataDirHelperAmbiguityError>((resolve) => { signalFatal = resolve; });
    const captureSpawn = ((file: string, args: readonly string[], options: object) => {
      child = spawn(file, [...args], options);
      return child;
    }) as typeof spawn;
    const runner = createRemoteDataDirHelperRunner({
      command: () => nodeCommand("setTimeout(() => process.stdout.write(JSON.stringify({ok:true,data:'late'})), 250)"),
      timeoutMs: 25,
      outputLimitBytes: 1_024,
      lockPath,
      spawnProcess: captureSpawn,
      fatalHook: signalFatal,
    });

    let outcome = 'pending';
    void runner('list', {}).then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );
    await expect(fatal).resolves.toMatchObject({
      name: RemoteDataDirHelperAmbiguityError.name,
      operation: 'list',
    });
    expect(child?.pid).toBeTypeOf('number');
    await waitForProcessGroupExit(child!.pid!);
    await delay(300);
    expect(outcome).toBe('pending');

    let poisonedOutcome = 'pending';
    void runner('inspect', {}).then(
      () => { poisonedOutcome = 'resolved'; },
      () => { poisonedOutcome = 'rejected'; },
    );
    await delay(20);
    expect(poisonedOutcome).toBe('pending');
  });

  it('kills descendants and fail-stops when the helper leader exits first', async () => {
    const lockPath = await newLockPath();
    let child: ChildProcess | undefined;
    let signalFatal!: (error: RemoteDataDirHelperAmbiguityError) => void;
    const fatal = new Promise<RemoteDataDirHelperAmbiguityError>((resolve) => { signalFatal = resolve; });
    const captureSpawn = ((file: string, args: readonly string[], options: object) => {
      child = spawn(file, [...args], options);
      return child;
    }) as typeof spawn;
    const runner = createRemoteDataDirHelperRunner({
      command: () => nodeCommand([
        "const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});",
        'child.unref();',
      ].join('')),
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
      lockPath,
      spawnProcess: captureSpawn,
      fatalHook: signalFatal,
    });

    void runner('inspect', {});
    await expect(fatal).resolves.toMatchObject({
      reason: 'leader closed while a descendant retained the process group',
    });
    await waitForProcessGroupExit(child!.pid!);
  });

  async function newLockPath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'nyabase-remote-helper-'));
    tempDirs.push(directory);
    return join(directory, 'physical.lock');
  }
});

function nodeCommand(script: string): { executable: string; args: string[] } {
  return { executable: process.execPath, args: ['-e', script] };
}

async function waitForProcessGroupExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Process group ${pid} remained alive after SIGKILL`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
