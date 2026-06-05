import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import type { RemoteFsMountSpec, NfsParams } from '@nyabase/common';
import type { FsMountDriver, SelfCheckItem } from './fs-driver.js';

const execFileAsync = promisify(execFile);

export class NfsDriver implements FsMountDriver {
  readonly type = 'nfs';

  async mount(spec: RemoteFsMountSpec): Promise<void> {
    const params = spec.params as NfsParams;
    const opts = [`vers=${params.version}`, spec.options].filter(Boolean).join(',');
    await execFileAsync('mount', [
      '-t', 'nfs',
      ...(opts ? ['-o', opts] : []),
      `${params.nfsServer}:${params.exportPath}`,
      spec.hostMountPoint,
    ], { timeout: 30_000 });
  }

  matchesCurrent(spec: RemoteFsMountSpec, current: { src: string; opts: string }): boolean {
    const params = spec.params as NfsParams;
    const expectedSrc = `${params.nfsServer}:${params.exportPath}`;
    if (current.src !== expectedSrc) return false;
    return current.opts.includes(`vers=${params.version}`);
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
