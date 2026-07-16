import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RemoteFsMountSpec, CephFsParams } from '@nyabase/common';
import { FsCleanupIncompleteError, type FsMountDriver, type SelfCheckItem } from './fs-driver.js';
import {
  runIsolatedCommand,
  type IsolatedCommandRunner,
} from './isolated-command.js';

const execFileAsync = promisify(execFile);

const KEYRING_DIR = '/run/nyabase-cephfs';
const CEPH_MOUNT_TIMEOUT_MS = 30_000;
const CEPH_SECRET_CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_STALE_SECRETS_SCRIPT = [
  'set -eu',
  'root=$1',
  'mkdir -p -- "$root"',
  'chmod 0700 "$root"',
  'find "$root" -mindepth 1 -maxdepth 1 \\',
  "  \\( -name 'mount-*' -o -name '*.keyring' \\) -exec rm -rf -- {} +",
].join('\n');

export class CephFsDriver implements FsMountDriver {
  readonly type = 'cephfs';

  constructor(private readonly runCommand: IsolatedCommandRunner = runIsolatedCommand) {}

  async mount(spec: RemoteFsMountSpec): Promise<void> {
    const params = spec.params as CephFsParams;
    await this.cleanupStaleSecretsRequired('before mounting');
    fs.mkdirSync(KEYRING_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(KEYRING_DIR, 0o700);
    const attemptDir = fs.mkdtempSync(path.join(KEYRING_DIR, 'mount-'));
    fs.chmodSync(attemptDir, 0o700);
    const secretPath = path.join(attemptDir, 'secret');

    try {
      // secretfile= expects only the raw base64 secret. It exists for this
      // mount attempt and is removed whether mount succeeds or throws.
      fs.writeFileSync(secretPath, `${params.secret.trim()}\n`, { mode: 0o600 });
      const optParts = [
        `name=${params.clientName}`,
        `secretfile=${secretPath}`,
      ];
      if (params.fsName) optParts.push(`fs=${params.fsName}`);
      if (spec.options) optParts.push(spec.options);

      await this.runCommand('mount', [
        '-t', 'ceph',
        `${params.monHosts}:${params.exportPath}`,
        spec.hostMountPoint,
        '-o', optParts.join(','),
      ], CEPH_MOUNT_TIMEOUT_MS);
    } finally {
      try {
        fs.rmSync(attemptDir, { recursive: true, force: true });
      } catch (error) {
        throw new FsCleanupIncompleteError(
          `CephFS attempt secret cleanup is incomplete for ${spec.id}`,
          error,
        );
      }
    }
  }

  matchesCurrent(spec: RemoteFsMountSpec, current: { src: string; opts: string }): boolean {
    const params = spec.params as CephFsParams;
    const sourceSuffix = `:${params.exportPath}`;
    if (!current.src.endsWith(sourceSuffix)) return false;
    const desiredMonitors = params.monHosts.split(',').map(normalizeMonitorIdentity).filter(Boolean);
    const currentMonitors = new Set(
      current.src.slice(0, -sourceSuffix.length)
        .split(',')
        .map(normalizeMonitorIdentity)
        .filter(Boolean),
    );
    if (!desiredMonitors.every((monitor) => currentMonitors.has(monitor))) return false;
    const options = new Set(current.opts.split(',').filter(Boolean));
    if (!options.has(`name=${params.clientName}`)) return false;
    if (params.fsName && !options.has(`fs=${params.fsName}`) && !options.has(`mds_namespace=${params.fsName}`)) {
      return false;
    }
    return requestedOptions(spec.options).every((option) => options.has(option));
  }

  async cleanup(spec: RemoteFsMountSpec): Promise<void> {
    await this.cleanupStaleSecretsRequired(`while cleaning ${spec.id}`);
  }

  private async cleanupStaleSecretsRequired(context: string): Promise<void> {
    try {
      await this.runCommand(
        '/bin/sh',
        ['-eu', '-c', CLEANUP_STALE_SECRETS_SCRIPT, 'nyabase-ceph-cleanup', KEYRING_DIR],
        CEPH_SECRET_CLEANUP_TIMEOUT_MS,
      );
    } catch (error) {
      throw new FsCleanupIncompleteError(
        `CephFS stale secret cleanup is incomplete ${context}`,
        error,
      );
    }
  }

  async selfCheck(): Promise<SelfCheckItem> {
    // Check for mount.ceph binary
    const cephPaths = ['/sbin/mount.ceph', '/usr/sbin/mount.ceph', '/bin/mount.ceph'];
    const hasBinary = cephPaths.some((p) => fs.existsSync(p));
    if (!hasBinary) {
      try {
        await execFileAsync('which', ['mount.ceph'], { timeout: 3_000 });
      } catch {
        return { id: 'cephfs', label: 'CephFS 客户端工具', status: 'fail', message: 'mount.ceph 未找到，请安装 ceph-common' };
      }
    }
    // Check for ceph kernel module
    try {
      const content = fs.readFileSync('/proc/filesystems', 'utf-8');
      if (!content.includes('ceph')) {
        return { id: 'cephfs', label: 'CephFS 客户端工具', status: 'warn', message: 'ceph 内核模块未加载，挂载可能失败' };
      }
    } catch { /* ignore */ }
    return { id: 'cephfs', label: 'CephFS 客户端工具', status: 'ok', message: 'mount.ceph 已安装' };
  }
}

function requestedOptions(options: string): string[] {
  return options.split(',').map((value) => value.trim()).filter(Boolean);
}

function normalizeMonitorIdentity(raw: string): string {
  const value = raw.trim();
  const bracketed = value.match(/^\[([^\]]+)](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  return (value.match(/:/g)?.length ?? 0) === 1 ? value.split(':')[0] : value;
}
