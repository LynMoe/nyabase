import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { RemoteFsType, type RemoteFsMountSpec } from '@nyabase/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CephFsDriver } from './cephfs-driver.js';
import { FsCleanupIncompleteError } from './fs-driver.js';
import { IsolatedCommandTimeoutError } from './isolated-command.js';
const attemptDirectories = new Set<string>();

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of attemptDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  attemptDirectories.clear();
});

describe('CephFsDriver', () => {
  it.each([false, true])('removes the per-attempt secret after mount (failure=%s)', async (fail) => {
    let secretPath = '';
    const runCommand = vi.fn().mockImplementation(async (commandName: string, args: readonly string[]) => {
      if (commandName === '/bin/sh') return;
      const options = args.at(-1) ?? '';
      secretPath = options.match(/secretfile=([^,]+)/)?.[1] ?? '';
      expect(secretPath).not.toBe('');
      expect(fs.readFileSync(secretPath, 'utf8')).toBe('ceph-secret\n');
      attemptDirectories.add(secretPath.slice(0, secretPath.lastIndexOf('/')));
      if (fail) throw new Error('mount failed');
    });
    const driver = new CephFsDriver(runCommand);

    const operation = driver.mount(spec());
    if (fail) await expect(operation).rejects.toThrow('mount failed');
    else await expect(operation).resolves.toBeUndefined();

    expect(fs.existsSync(secretPath)).toBe(false);
    expect(fs.existsSync(secretPath.slice(0, secretPath.lastIndexOf('/')))).toBe(false);
  });

  it('keeps the secret until the isolated helper group has fully settled on timeout', async () => {
    let rejectCommand!: (error: Error) => void;
    const command = new Promise<void>((_resolve, reject) => { rejectCommand = reject; });
    let secretPath = '';
    const runCommand = vi.fn().mockImplementation((commandName: string, args: readonly string[]) => {
      if (commandName === '/bin/sh') return Promise.resolve();
      const options = args.at(-1) ?? '';
      secretPath = options.match(/secretfile=([^,]+)/)?.[1] ?? '';
      expect(secretPath).not.toBe('');
      attemptDirectories.add(secretPath.slice(0, secretPath.lastIndexOf('/')));
      return command;
    });
    const driver = new CephFsDriver(runCommand);

    const operation = driver.mount(spec());
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(2));
    expect(fs.readFileSync(secretPath, 'utf8')).toBe('ceph-secret\n');

    rejectCommand(new IsolatedCommandTimeoutError('mount', 30_000));
    await expect(operation).rejects.toBeInstanceOf(IsolatedCommandTimeoutError);
    expect(fs.existsSync(secretPath)).toBe(false);
    expect(fs.existsSync(secretPath.slice(0, secretPath.lastIndexOf('/')))).toBe(false);
  });

  it('does not confuse a monitor-address substring with the requested cluster', () => {
    const driver = new CephFsDriver();
    expect(driver.matchesCurrent(spec(), {
      src: '10.0.0.10:6789:/',
      opts: 'rw,name=nyabase,ro',
    })).toBe(false);
    expect(driver.matchesCurrent(spec(), {
      src: '10.0.0.1:6789:/',
      opts: 'rw,name=nyabase,ro',
    })).toBe(true);
  });

  it('classifies stale-secret cleanup failure as retryable incomplete cleanup', async () => {
    const cleanupFailure = new Error('cleanup helper failed');
    const runCommand = vi.fn().mockRejectedValue(cleanupFailure);
    const driver = new CephFsDriver(runCommand);

    await expect(driver.cleanup(spec())).rejects.toMatchObject({
      name: FsCleanupIncompleteError.name,
      cleanupCause: cleanupFailure,
    });
  });
});

function spec(): RemoteFsMountSpec {
  return {
    id: randomUUID(),
    hostMountPoint: '/mnt/remote-fs/ceph-test',
    options: 'ro',
    params: {
      type: RemoteFsType.CephFs,
      monHosts: '10.0.0.1',
      exportPath: '/',
      clientName: 'nyabase',
      secret: 'ceph-secret',
    },
  };
}
