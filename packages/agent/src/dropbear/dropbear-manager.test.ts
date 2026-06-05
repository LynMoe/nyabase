import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContainerStatus } from '@nyabase/common';
import type { DockerClient } from '../docker/docker-client.js';
import { DropbearManager } from './dropbear-manager.js';
import type { DropbearAsset } from './dropbear-embed.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const execFileMock = vi.mocked(execFile);
const tempDirs: string[] = [];

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function makeAsset(contents = 'dropbear-v1'): DropbearAsset {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyabase-dropbear-test-'));
  tempDirs.push(dir);
  const binaryPath = path.join(dir, 'nyabase-dropbear');
  fs.writeFileSync(binaryPath, contents, { mode: 0o755 });
  return { binaryPath, source: 'env' };
}

class FakeDocker {
  status = 'running';
  pid: number | null = 77;
  nextPid = 88;
  authorizedKeysHash: string | undefined;
  authorizedKeysContent = '';
  binaryHash: string | null = null;
  putFiles: Array<{ path: string; data: Buffer; mode: number }> = [];
  shellScripts: string[] = [];
  startCommands: string[] = [];
  killCount = 0;
  failRootSshSetup = false;

  async inspectContainer() {
    return { State: { Status: this.status } };
  }

  async putFile(_runtimeId: string, containerPath: string, data: Buffer, mode: number) {
    this.putFiles.push({ path: containerPath, data, mode });
    if (containerPath === '/root/.ssh/authorized_keys.tmp') {
      this.authorizedKeysContent = data.toString('utf-8');
      this.authorizedKeysHash = sha256(data);
    }
  }

  async execCapture(_runtimeId: string, cmd: string[]) {
    const script = cmd[2] ?? '';
    this.shellScripts.push(script);

    if (this.failRootSshSetup && script.startsWith("mkdir -p '/root/.ssh'")) {
      return { stdout: '', stderr: 'root setup failed', exitCode: 1 };
    }

    if (script.includes("sha256sum '/root/.ssh/authorized_keys'")) {
      return this.authorizedKeysHash
        ? { stdout: `${this.authorizedKeysHash}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes("cat '/usr/local/bin/nyabase-dropbear.sha256'")) {
      return this.binaryHash
        ? { stdout: `${this.binaryHash}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes("kill -0 \"$pid\"")) {
      return this.pid
        ? { stdout: String(this.pid), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.startsWith('kill ')) {
      this.killCount += 1;
      this.pid = null;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (script.includes("printf %s ") && script.includes("'/usr/local/bin/nyabase-dropbear.sha256'")) {
      const match = script.match(/printf %s '([^']+)'/);
      this.binaryHash = match?.[1] ?? this.binaryHash;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (script.startsWith("'/usr/local/bin/nyabase-dropbear'")) {
      this.startCommands.push(script);
      this.pid = this.nextPid;
      this.nextPid += 1;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

function makeManager(fakeDocker: FakeDocker, asset = makeAsset()) {
  return new DropbearManager(
    fakeDocker as unknown as DockerClient,
    (_dockerId, fn) => fn(),
    asset,
  );
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation(((cmd: string, args: readonly string[], options: unknown, callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: Error | null,
      result?: { stdout: string; stderr: string },
    ) => void;
    expect(args).toEqual(['-h']);
    cb(null, {
      stdout: '',
      stderr: 'Dropbear server usage: dropbear -R -s -p [address:]port -P pidfile -a\n',
    });
  }) as typeof execFile);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('DropbearManager.reconcileContainerSsh', () => {
  it('updates keys without restarting a running process when the binary hash is unchanged', async () => {
    const asset = makeAsset('dropbear-v1');
    const hostHash = sha256(fs.readFileSync(asset.binaryPath));
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = 77;
    fakeDocker.binaryHash = hostHash;
    fakeDocker.authorizedKeysHash = sha256('ssh-ed25519 OLD old@example\n');
    const manager = makeManager(fakeDocker, asset);
    const publicKeys = [' ssh-ed25519 NEW new@example ', '', 'ssh-rsa SECOND second@example'];
    const expectedKeyHash = sha256('ssh-ed25519 NEW new@example\nssh-rsa SECOND second@example\n');

    const result = await manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      publicKeys,
      expectedKeyHash,
    });

    expect(result).toMatchObject({
      enabled: true,
      status: 'running',
      pid: 77,
      binaryUpdated: false,
      keysUpdated: true,
      restarted: false,
    });
    expect(fakeDocker.authorizedKeysContent).toBe(
      'ssh-ed25519 NEW new@example\nssh-rsa SECOND second@example\n',
    );
    expect(fakeDocker.startCommands).toEqual([]);
    expect(fakeDocker.killCount).toBe(0);
  });

  it('starts Dropbear public-key-only for an empty key set and keeps forwarding options open', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = null;
    const manager = makeManager(fakeDocker);

    const result = await manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      publicKeys: [],
      expectedKeyHash: sha256('\n'),
    });

    expect(result).toMatchObject({
      enabled: true,
      status: 'running',
      pid: 88,
      keysUpdated: true,
      restarted: false,
    });
    expect(fakeDocker.authorizedKeysContent).toBe('\n');
    expect(fakeDocker.putFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '/root/.ssh/authorized_keys.tmp',
        mode: 0o600,
      }),
      expect.objectContaining({
        path: '/usr/local/bin/nyabase-dropbear.tmp',
        mode: 0o755,
      }),
    ]));
    expect(fakeDocker.startCommands).toHaveLength(1);
    const command = fakeDocker.startCommands[0];
    expect(command).toContain("'-s'");
    expect(command).toContain("'0.0.0.0:22'");
    expect(command).toContain("'-P' '/run/nyabase-dropbear.pid'");
    expect(command).toContain("'-a'");
    expect(command).not.toContain("'-j'");
    expect(command).not.toContain("'-k'");
    expect(fakeDocker.authorizedKeysContent).not.toContain('no-port-forwarding');
    expect(fakeDocker.authorizedKeysContent).not.toContain('no-agent-forwarding');
  });

  it('replaces a changed binary hash and restarts the running Dropbear process', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = 77;
    fakeDocker.binaryHash = 'old-hash';
    fakeDocker.authorizedKeysHash = sha256('ssh-ed25519 AAAA user@example\n');
    const manager = makeManager(fakeDocker);

    const result = await manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
    });

    expect(result).toMatchObject({
      enabled: true,
      status: 'running',
      pid: 88,
      binaryUpdated: true,
      keysUpdated: false,
      restarted: true,
    });
    expect(fakeDocker.killCount).toBe(1);
    expect(fakeDocker.startCommands).toHaveLength(1);
    expect(fakeDocker.putFiles.some((f) => f.path === '/usr/local/bin/nyabase-dropbear.tmp')).toBe(true);
  });

  it('restarts Dropbear when the pid file process check shows it was killed', async () => {
    const asset = makeAsset('dropbear-v1');
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = null;
    fakeDocker.binaryHash = sha256(fs.readFileSync(asset.binaryPath));
    const manager = makeManager(fakeDocker, asset);

    const result = await manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
    });

    expect(result).toMatchObject({
      enabled: true,
      status: 'running',
      pid: 88,
      binaryUpdated: false,
      restarted: false,
    });
    expect(fakeDocker.startCommands).toHaveLength(1);
  });

  it('treats the reconcile command as authoritative even without an enabled Docker label', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = null;
    const manager = makeManager(fakeDocker);

    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
    })).resolves.toMatchObject({
      enabled: true,
      status: 'running',
    });
    expect(fakeDocker.startCommands).toHaveLength(1);
  });

  it('fails before file writes when the expected public key hash does not match', async () => {
    const fakeDocker = new FakeDocker();
    const manager = makeManager(fakeDocker);

    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
      expectedKeyHash: 'not-the-real-hash',
    })).rejects.toThrow('SSH key hash mismatch');
    expect(fakeDocker.putFiles).toEqual([]);
    expect(fakeDocker.startCommands).toEqual([]);
  });

  it('surfaces a stopped-container error when backend accidentally sends reconcile to a non-running container', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.status = 'exited';
    const manager = makeManager(fakeDocker);

    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      publicKeys: [],
    })).rejects.toThrow('Container docker-a is not running');
  });

  it('fails before Docker work when the Dropbear asset is missing', async () => {
    const fakeDocker = new FakeDocker();
    const asset: DropbearAsset = {
      binaryPath: '',
      source: 'missing',
      missingReason: 'Dropbear binary is not configured for source-mode agent runtime.',
    };
    const manager = makeManager(fakeDocker, asset);

    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
    })).rejects.toThrow('Dropbear binary is not configured for source-mode agent runtime.');

    expect(fakeDocker.shellScripts).toEqual([]);
    expect(fakeDocker.putFiles).toEqual([]);
    expect(fakeDocker.startCommands).toEqual([]);
  });
});

describe('DropbearManager.getSelfCheckItems', () => {
  it('reports a missing source-mode Dropbear asset as a failing binary check', async () => {
    const fakeDocker = new FakeDocker();
    const asset: DropbearAsset = {
      binaryPath: '',
      source: 'missing',
      missingReason: 'Dropbear binary is not configured for source-mode agent runtime.',
    };
    const manager = makeManager(fakeDocker, asset);

    await expect(manager.getSelfCheckItems()).resolves.toEqual([
      {
        id: 'dropbear_binary',
        label: 'Dropbear binary',
        status: 'fail',
        message: 'Dropbear binary is not configured for source-mode agent runtime.',
      },
    ]);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(fakeDocker.shellScripts).toEqual([]);
  });
});

describe('DropbearManager.inspectContainerSshState', () => {
  it('defaults to disabled when no label or runtime SSH marker is visible', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = null;
    const manager = makeManager(fakeDocker);

    await expect(manager.inspectContainerSshState(
      'docker-a',
      false,
      ContainerStatus.Running,
    )).resolves.toEqual({
      enabled: false,
      status: 'disabled',
      user: 'root',
      port: 22,
    });
  });

  it('reports stopped label-enabled containers as enabled container_stopped', async () => {
    const manager = makeManager(new FakeDocker());

    await expect(manager.inspectContainerSshState(
      'docker-a',
      true,
      ContainerStatus.Exited,
    )).resolves.toEqual({
      enabled: true,
      status: 'container_stopped',
      user: 'root',
      port: 22,
    });
  });

  it('reports runtime pid, key hash, and last error visibility after a failed reconcile', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.failRootSshSetup = true;
    const manager = makeManager(fakeDocker);
    const expectedKeyHash = sha256('ssh-ed25519 AAAA user@example\n');
    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      publicKeys: ['ssh-ed25519 AAAA user@example'],
      expectedKeyHash,
    })).rejects.toThrow('root setup failed');

    await expect(manager.inspectContainerSshState(
      'docker-a',
      true,
      ContainerStatus.Running,
    )).resolves.toMatchObject({
      enabled: true,
      status: 'running',
      pid: 77,
      lastError: 'root setup failed',
    });
  });
});
