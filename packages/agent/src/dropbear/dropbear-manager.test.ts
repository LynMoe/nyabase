import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContainerStatus } from '@nyabase/common';
import type { DockerClient } from '../docker/docker-client.js';
import { DropbearManager, sshSha256FingerprintFromDropbearOutput } from './dropbear-manager.js';
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
  const dropbearKeyPath = path.join(dir, 'nyabase-dropbearkey');
  const sftpServerPath = path.join(dir, 'nyabase-sftp-server');
  fs.writeFileSync(binaryPath, contents, { mode: 0o755 });
  fs.writeFileSync(dropbearKeyPath, 'dropbearkey-v1', { mode: 0o755 });
  fs.writeFileSync(sftpServerPath, 'sftp-v1', { mode: 0o755 });
  return { binaryPath, dropbearKeyPath, sftpServerPath, source: 'env' };
}

const FIXED_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti root@test';
const FIXED_FINGERPRINT = 'SHA256:UCUiLr7Pjs9wFFJMDByLgc3NrtdU344OgUM45wZPcIQ';

class FakeDocker {
  status = 'running';
  pid: number | null = 77;
  nextPid = 88;
  authorizedKeysHash: string | undefined;
  authorizedKeysContent = '';
  keyGeneration: number | undefined;
  binaryHash: string | null = null;
  dropbearKeyHash: string | null = null;
  sftpServerHash: string | null = null;
  hostPublicKey: string | null = FIXED_PUBLIC_KEY;
  putFiles: Array<{ path: string; data: Buffer; mode: number }> = [];
  shellScripts: string[] = [];
  managementExecCalls: Array<{ script: string; timeoutMs: number | undefined }> = [];
  startCommands: string[] = [];
  killCount = 0;
  failRootSshSetup = false;
  foreignPidIdentity = false;
  stopDoesNotExit = false;
  pidRecycledBeforeStop = false;

  async inspectContainer() {
    return { State: { Status: this.status } };
  }

  async putManagementFile(_runtimeId: string, containerPath: string, data: Buffer, mode: number) {
    this.putFiles.push({ path: containerPath, data, mode });
    if (containerPath === '/root/.ssh/authorized_keys.tmp') {
      this.authorizedKeysContent = data.toString('utf-8');
      this.authorizedKeysHash = sha256(data);
    }
  }

  async execManagementCapture(_runtimeId: string, cmd: string[], timeoutMs?: number) {
    const script = cmd[2] ?? '';
    this.shellScripts.push(script);
    this.managementExecCalls.push({ script, timeoutMs });

    if (script.includes('NYABASE_SSH_STATE_V1')) {
      if (this.foreignPidIdentity) {
        return { stdout: '', stderr: 'foreign process identity', exitCode: 42 };
      }
      const process = this.pid ? `${this.pid}:12345` : '-';
      const keyHash = this.authorizedKeysHash ?? '-';
      const generation = this.keyGeneration ?? '-';
      const hostKey = this.hostPublicKey
        ? `NYABASE_SSH_HOST_KEY_BEGIN\nPublic key portion is:\n${this.hostPublicKey}\nFingerprint: ignored\nNYABASE_SSH_HOST_KEY_END\n`
        : '';
      return {
        stdout: `NYABASE_SSH_STATE_V1\nprocess=${process}\nkeyHash=${keyHash}\ngeneration=${generation}\n${hostKey}`,
        stderr: '',
        exitCode: 0,
      };
    }

    if (this.failRootSshSetup && script.startsWith("mkdir -p '/root/.ssh'")) {
      return { stdout: '', stderr: 'root setup failed', exitCode: 1 };
    }

    if (script.includes("sha256sum '/root/.ssh/authorized_keys'")) {
      return this.authorizedKeysHash
        ? { stdout: `${this.authorizedKeysHash}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes("cat '/root/.ssh/authorized_keys'")) {
      return this.authorizedKeysContent
        ? { stdout: this.authorizedKeysContent, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes("cat '/run/nyabase-dropbear.key-generation'")) {
      return this.keyGeneration !== undefined
        ? { stdout: `${this.keyGeneration}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes("cat '/usr/local/bin/nyabase-dropbear.sha256'")) {
      return this.binaryHash
        ? { stdout: `${this.binaryHash}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes("cat '/usr/local/bin/nyabase-dropbearkey.sha256'")) {
      return this.dropbearKeyHash
        ? { stdout: `${this.dropbearKeyHash}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes("cat '/usr/libexec/sftp-server.sha256'")) {
      return this.sftpServerHash
        ? { stdout: `${this.sftpServerHash}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes("'/usr/local/bin/nyabase-dropbearkey' -t ed25519")) {
      this.hostPublicKey = FIXED_PUBLIC_KEY;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (script.includes("'/usr/local/bin/nyabase-dropbearkey' -y") && script.includes('/etc/dropbear/dropbear_ed25519_host_key')) {
      return this.hostPublicKey
        ? { stdout: `Public key portion is:\n${this.hostPublicKey}\nFingerprint: ignored\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes('started=') && script.includes('kill "$pid"')) {
      if (this.pidRecycledBeforeStop) {
        return { stdout: '', stderr: 'pid start time changed', exitCode: 42 };
      }
      this.killCount += 1;
      if (this.stopDoesNotExit) {
        return { stdout: '', stderr: 'process did not exit', exitCode: 1 };
      }
      this.pid = null;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (script.includes("kill -0 \"$pid\"")) {
      if (this.foreignPidIdentity) {
        return { stdout: '', stderr: '', exitCode: 42 };
      }
      return this.pid
        ? { stdout: `${this.pid}:12345`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 };
    }

    if (script.includes("rm -f '/run/nyabase-dropbear.pid'")) {
      this.pid = null;
      this.authorizedKeysHash = undefined;
      this.authorizedKeysContent = '';
      this.keyGeneration = undefined;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (script.includes("printf %s ") && script.includes("'/usr/local/bin/nyabase-dropbear.sha256'")) {
      const match = script.match(/printf %s '([^']+)'/);
      this.binaryHash = match?.[1] ?? this.binaryHash;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (script.includes("printf %s ") && script.includes("'/usr/local/bin/nyabase-dropbearkey.sha256'")) {
      const match = script.match(/printf %s '([^']+)'/);
      this.dropbearKeyHash = match?.[1] ?? this.dropbearKeyHash;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (script.includes("printf %s ") && script.includes("'/usr/libexec/sftp-server.sha256'")) {
      const match = script.match(/printf %s '([^']+)'/);
      this.sftpServerHash = match?.[1] ?? this.sftpServerHash;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (script.includes("printf %s ") && script.includes("'/run/nyabase-dropbear.key-generation'")) {
      const match = script.match(/printf %s '([^']+)'/);
      const parsed = Number(match?.[1]);
      if (Number.isSafeInteger(parsed)) this.keyGeneration = parsed;
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

  async execObservationCapture(runtimeId: string, cmd: string[], timeoutMs?: number) {
    return this.execManagementCapture(runtimeId, cmd, timeoutMs);
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

describe('sshSha256FingerprintFromDropbearOutput', () => {
  it('hashes the SSH public-key wire blob, not the Dropbear private-key file', () => {
    const output = `Public key portion is:\n${FIXED_PUBLIC_KEY}\nFingerprint: ignored`;
    expect(sshSha256FingerprintFromDropbearOutput(output)).toBe(FIXED_FINGERPRINT);
    expect(sshSha256FingerprintFromDropbearOutput(sha256('private-key-bytes'))).toBeUndefined();
  });
});

describe('DropbearManager.reconcileContainerSsh', () => {
  it('updates keys without restarting a running process when the binary hash is unchanged', async () => {
    const asset = makeAsset('dropbear-v1');
    const hostHash = sha256(fs.readFileSync(asset.binaryPath));
    const sftpHash = sha256(fs.readFileSync(asset.sftpServerPath!));
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = 77;
    fakeDocker.binaryHash = hostHash;
    fakeDocker.sftpServerHash = sftpHash;
    fakeDocker.authorizedKeysHash = sha256('ssh-ed25519 OLD old@example\n');
    const manager = makeManager(fakeDocker, asset);
    const internalPublicKey = ' ssh-ed25519 NEW new@example ';
    const expectedKeyHash = sha256('ssh-ed25519 NEW new@example\n');

    const result = await manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey,
      internalKeyGeneration: 3,
      expectedKeyHash,
    });

    expect(result).toMatchObject({
      enabled: true,
      status: 'running',
      pid: 77,
      binaryUpdated: false,
      keysUpdated: true,
      restarted: false,
      appliedKeyGeneration: 3,
      hostKeyFingerprint: FIXED_FINGERPRINT,
    });
    expect(fakeDocker.authorizedKeysContent).toBe('ssh-ed25519 NEW new@example\n');
    expect(fakeDocker.startCommands).toEqual([]);
    expect(fakeDocker.killCount).toBe(0);
  });

  it('refuses a late older key generation before it can overwrite newer container state', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.keyGeneration = 4;
    fakeDocker.authorizedKeysContent = 'ssh-ed25519 NEWER platform@example\n';
    fakeDocker.authorizedKeysHash = sha256(fakeDocker.authorizedKeysContent);
    const manager = makeManager(fakeDocker);

    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 OLDER platform@example',
      internalKeyGeneration: 3,
      expectedKeyHash: sha256('ssh-ed25519 OLDER platform@example\n'),
    })).rejects.toThrow('Refusing stale SSH key generation 3; container already applied 4');

    expect(fakeDocker.authorizedKeysContent).toBe('ssh-ed25519 NEWER platform@example\n');
    expect(fakeDocker.keyGeneration).toBe(4);
    expect(fakeDocker.putFiles).toEqual([]);
  });

  it('starts Dropbear with the internal public key and keeps forwarding options open', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = null;
    const manager = makeManager(fakeDocker);

    const result = await manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 INTERNAL platform@example',
      internalKeyGeneration: 1,
      expectedKeyHash: sha256('ssh-ed25519 INTERNAL platform@example\n'),
    });

    expect(result).toMatchObject({
      enabled: true,
      status: 'running',
      pid: 88,
      keysUpdated: true,
      restarted: false,
    });
    expect(fakeDocker.authorizedKeysContent).toBe('ssh-ed25519 INTERNAL platform@example\n');
    expect(fakeDocker.putFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '/root/.ssh/authorized_keys.tmp',
        mode: 0o600,
      }),
      expect.objectContaining({
        path: '/usr/local/bin/nyabase-dropbear.tmp',
        mode: 0o755,
      }),
      expect.objectContaining({
        path: '/usr/local/bin/nyabase-dropbearkey.tmp',
        mode: 0o755,
      }),
      expect.objectContaining({
        path: '/usr/libexec/sftp-server.tmp',
        mode: 0o755,
      }),
    ]));
    expect(fakeDocker.startCommands).toHaveLength(1);
    const command = fakeDocker.startCommands[0];
    expect(command).toContain("'-s'");
    expect(command).not.toContain("'-R'");
    expect(command).toContain("'-r' '/etc/dropbear/dropbear_ed25519_host_key'");
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
    fakeDocker.sftpServerHash = 'old-sftp-hash';
    fakeDocker.authorizedKeysHash = sha256('ssh-ed25519 AAAA user@example\n');
    const manager = makeManager(fakeDocker);

    const result = await manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
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

  it('refuses a foreign pid-file identity before killing or replacing files', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.foreignPidIdentity = true;
    fakeDocker.binaryHash = 'old-hash';
    const manager = makeManager(fakeDocker);

    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
    })).rejects.toThrow('pid file does not identify');

    expect(fakeDocker.killCount).toBe(0);
    expect(fakeDocker.putFiles).toEqual([]);
  });

  it('does not replace the executable when process exit cannot be confirmed', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.binaryHash = 'old-hash';
    fakeDocker.sftpServerHash = 'old-sftp-hash';
    fakeDocker.stopDoesNotExit = true;
    const manager = makeManager(fakeDocker);

    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
    })).rejects.toThrow('process did not exit');

    expect(fakeDocker.killCount).toBe(1);
    expect(fakeDocker.pid).toBe(77);
    expect(fakeDocker.putFiles).toEqual([]);
    expect(fakeDocker.binaryHash).toBe('old-hash');
  });

  it('does not kill or replace files when the pid start-time token changed', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.binaryHash = 'old-hash';
    fakeDocker.sftpServerHash = 'old-sftp-hash';
    fakeDocker.pidRecycledBeforeStop = true;
    const manager = makeManager(fakeDocker);

    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
    })).rejects.toThrow('pid start time changed');

    expect(fakeDocker.killCount).toBe(0);
    expect(fakeDocker.putFiles).toEqual([]);
    expect(fakeDocker.binaryHash).toBe('old-hash');
  });

  it('restarts Dropbear when the pid file process check shows it was killed', async () => {
    const asset = makeAsset('dropbear-v1');
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = null;
    fakeDocker.binaryHash = sha256(fs.readFileSync(asset.binaryPath));
    fakeDocker.sftpServerHash = sha256(fs.readFileSync(asset.sftpServerPath!));
    const manager = makeManager(fakeDocker, asset);

    const result = await manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
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
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
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
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
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
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
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
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
    })).rejects.toThrow('Dropbear binary is not configured for source-mode agent runtime.');

    expect(fakeDocker.shellScripts).toEqual([]);
    expect(fakeDocker.putFiles).toEqual([]);
    expect(fakeDocker.startCommands).toEqual([]);
  });

  it('fails before starting Dropbear when the SFTP server asset is missing', async () => {
    const fakeDocker = new FakeDocker();
    const asset = makeAsset('dropbear-v1');
    asset.sftpServerPath = path.join(path.dirname(asset.binaryPath), 'missing-sftp-server');
    const manager = makeManager(fakeDocker, asset);

    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 2,
    })).rejects.toThrow('SFTP server asset not found');

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
  it('uses exactly one root exec with a five-second bound for a running container report', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.authorizedKeysHash = sha256('ssh-ed25519 key\n');
    fakeDocker.keyGeneration = 9;
    const manager = makeManager(fakeDocker);

    await expect(manager.inspectContainerSshState(
      'docker-a',
      ContainerStatus.Running,
    )).resolves.toMatchObject({
      status: 'running',
      pid: 77,
      appliedKeyGeneration: 9,
      hostKeyFingerprint: FIXED_FINGERPRINT,
    });

    expect(fakeDocker.managementExecCalls).toHaveLength(1);
    expect(fakeDocker.managementExecCalls[0]).toMatchObject({ timeoutMs: 5_000 });
    expect(fakeDocker.managementExecCalls[0].script).toContain('NYABASE_SSH_STATE_V1');
  });

  it('defaults to disabled when no label or runtime SSH marker is visible', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.pid = null;
    const manager = makeManager(fakeDocker);

    await expect(manager.inspectContainerSshState(
      'docker-a',
      ContainerStatus.Running,
    )).resolves.toEqual({
      enabled: false,
      status: 'disabled',
      user: 'root',
      port: 22,
    });
  });

  it('reports stopped containers without relying on remembered Agent state', async () => {
    const manager = makeManager(new FakeDocker());

    await expect(manager.inspectContainerSshState(
      'docker-a',
      ContainerStatus.Exited,
    )).resolves.toEqual({
      enabled: false,
      status: 'container_stopped',
      user: 'root',
      port: 22,
    });
  });

  it('derives disabled state from the container after disable reconciliation', async () => {
    const fakeDocker = new FakeDocker();
    const manager = makeManager(fakeDocker);

    await manager.reconcileContainerSsh({ runtimeId: 'docker-a', enabled: false });

    await expect(manager.inspectContainerSshState(
      'docker-a',
      ContainerStatus.Running,
    )).resolves.toEqual({
      enabled: false,
      status: 'disabled',
      user: 'root',
      port: 22,
    });
  });

  it('reports the safely stopped physical state after a pre-update reconcile failure', async () => {
    const fakeDocker = new FakeDocker();
    fakeDocker.failRootSshSetup = true;
    const manager = makeManager(fakeDocker);
    const expectedKeyHash = sha256('ssh-ed25519 AAAA user@example\n');
    await expect(manager.reconcileContainerSsh({
      runtimeId: 'docker-a',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA user@example',
      internalKeyGeneration: 7,
      expectedKeyHash,
    })).rejects.toThrow('root setup failed');

    await expect(manager.inspectContainerSshState(
      'docker-a',
      ContainerStatus.Running,
    )).resolves.toMatchObject({
      enabled: false,
      status: 'disabled',
    });
    expect(fakeDocker.killCount).toBe(1);
  });
});
