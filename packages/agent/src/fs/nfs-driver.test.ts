import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RemoteFsType, type RemoteFsMountSpec } from '@nyabase/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NfsDriver,
} from './nfs-driver.js';
import {
  IsolatedCommandTimeoutError,
  createIsolatedCommandRunner,
} from './isolated-command.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('NfsDriver', () => {
  it('forces foreground mode in the canonical mount argument', async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const driver = new NfsDriver(runCommand);

    await driver.mount(spec('ro,soft'));

    expect(runCommand).toHaveBeenCalledWith('mount', [
      '-t', 'nfs',
      '-o', 'vers=4.2,fg,ro,soft',
      '10.0.0.10:/exports/project',
      '/mnt/remote-fs/remote-a',
    ], 30_000);
  });

  it('excludes the mount-helper retry policy from physical identity', () => {
    const driver = new NfsDriver(vi.fn());
    const requested = spec('soft,proto=tcp,timeo=1,retrans=1,retry=0');

    expect(driver.matchesCurrent(requested, {
      src: '10.0.0.10:/exports/project',
      opts: 'rw,vers=4.2,soft,proto=tcp,timeo=1,retrans=1',
    })).toBe(true);
    expect(driver.matchesCurrent(requested, {
      src: '10.0.0.10:/exports/project',
      opts: 'rw,vers=4.2,proto=tcp,timeo=1,retrans=1',
    })).toBe(false);
  });

  it('requires exact read/write semantics and rejects contradictory current options', () => {
    const driver = new NfsDriver(vi.fn());
    expect(driver.matchesCurrent(spec(''), {
      src: '10.0.0.10:/exports/project',
      opts: 'ro,vers=4.2',
    })).toBe(false);
    expect(driver.matchesCurrent(spec('ro'), {
      src: '10.0.0.10:/exports/project',
      opts: 'ro,vers=4.2',
    })).toBe(true);
    expect(driver.matchesCurrent(spec('ro'), {
      src: '10.0.0.10:/exports/project',
      opts: 'ro,rw,vers=4.2',
    })).toBe(false);
  });

  it('kills the complete isolated process group on timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyabase-nfs-timeout-'));
    temporaryRoots.push(root);
    const pidPath = path.join(root, 'grandchild.pid');
    const heartbeatPath = path.join(root, 'heartbeat');
    const grandchildScript = [
      "const fs = require('fs');",
      `const file = ${JSON.stringify(heartbeatPath)};`,
      "setInterval(() => fs.appendFileSync(file, 'x'), 20);",
    ].join('\n');
    const leaderScript = [
      "const fs = require('fs');",
      "const { spawn } = require('child_process');",
      `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const fatalHook = vi.fn();
    const runCommand = createIsolatedCommandRunner({
      lockPath: path.join(root, 'physical-mutation.lock'),
      fatalHook,
    });
    const operation = runCommand(process.execPath, ['-e', leaderScript], 300);
    let outcome = 'pending';
    void operation.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(fatalHook.mock.calls[0][0]).toBeInstanceOf(IsolatedCommandTimeoutError);
    expect(outcome).toBe('pending');
    expect(fs.existsSync(pidPath)).toBe(true);

    await delay(120);
    const firstSize = fs.existsSync(heartbeatPath) ? fs.statSync(heartbeatPath).size : 0;
    await delay(160);
    const secondSize = fs.existsSync(heartbeatPath) ? fs.statSync(heartbeatPath).size : 0;
    expect(secondSize).toBe(firstSize);
  });
});

function spec(options: string): RemoteFsMountSpec {
  return {
    id: 'remote-a',
    hostMountPoint: '/mnt/remote-fs/remote-a',
    options,
    params: {
      type: RemoteFsType.Nfs,
      nfsServer: '10.0.0.10',
      exportPath: '/exports/project',
      version: '4.2',
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
