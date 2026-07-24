import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import type { RemoteFsMountSpec, NfsParams } from '@nyabase/common';
import type { FsMountDriver, SelfCheckItem } from './fs-driver.js';
import {
  runIsolatedCommand,
  type IsolatedCommandRunner,
} from './isolated-command.js';

const execFileAsync = promisify(execFile);
const NFS_MOUNT_TIMEOUT_MS = 30_000;
// retry is consumed by mount.nfs while establishing a foreground mount and is
// not retained in the kernel mount table. It controls command convergence, not
// the identity of the mounted filesystem.
const NFS_HELPER_ONLY_OPTION_KEYS = new Set(['retry']);

export class NfsDriver implements FsMountDriver {
  readonly type = 'nfs';

  constructor(private readonly runCommand: IsolatedCommandRunner = runIsolatedCommand) {}

  async mount(spec: RemoteFsMountSpec): Promise<void> {
    const params = spec.params as NfsParams;
    // fg is not user-configurable. Combined with schema-level bg rejection it
    // prevents mount.nfs from intentionally leaving a retry daemon behind.
    const opts = [`vers=${params.version}`, 'fg', spec.options].filter(Boolean).join(',');
    await this.runCommand('mount', [
      '-t', 'nfs',
      ...(opts ? ['-o', opts] : []),
      `${params.nfsServer}:${params.exportPath}`,
      spec.hostMountPoint,
    ], NFS_MOUNT_TIMEOUT_MS);
  }

  matchesCurrent(spec: RemoteFsMountSpec, current: { src: string; opts: string }): boolean {
    const params = spec.params as NfsParams;
    const expectedSrc = `${params.nfsServer}:${params.exportPath}`;
    if (current.src !== expectedSrc) return false;
    const options = new Set(current.opts.split(',').filter(Boolean));
    const requested = spec.options.split(',').map((value) => value.trim()).filter(Boolean);
    const desiredReadOnly = requested.includes('ro');
    if (options.has('ro') === options.has('rw')) return false;
    if (desiredReadOnly ? !options.has('ro') : !options.has('rw')) return false;
    return options.has(`vers=${params.version}`)
      && requested
        .every((option) => (
          NFS_HELPER_ONLY_OPTION_KEYS.has(option.split('=', 1)[0]!.toLowerCase())
          || options.has(option)
        ));
  }

  async selfCheck(): Promise<SelfCheckItem> {
    const nfsPaths = ['/sbin/mount.nfs', '/usr/sbin/mount.nfs', '/bin/mount.nfs'];
    if (nfsPaths.some((p) => fs.existsSync(p))) {
      return { id: 'nfs', label: 'NFS 客户端工具', status: 'ok', message: 'mount.nfs 已安装' };
    }
    try {
      await execFileAsync('which', ['mount.nfs'], { timeout: 3_000 });
      return { id: 'nfs', label: 'NFS 客户端工具', status: 'ok', message: 'mount.nfs 已安装' };
    } catch {
      return { id: 'nfs', label: 'NFS 客户端工具', status: 'fail', message: 'mount.nfs 未找到，请安装 nfs-utils 或 nfs-common' };
    }
  }
}
