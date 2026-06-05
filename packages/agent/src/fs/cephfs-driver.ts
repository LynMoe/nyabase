import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RemoteFsMountSpec, CephFsParams } from '@nyabase/common';
import type { FsMountDriver, SelfCheckItem } from './fs-driver.js';

const execFileAsync = promisify(execFile);

const KEYRING_DIR = '/run/nyabase-cephfs';

export class CephFsDriver implements FsMountDriver {
  readonly type = 'cephfs';

  async prepare(spec: RemoteFsMountSpec): Promise<void> {
    const params = spec.params as CephFsParams;
    fs.mkdirSync(KEYRING_DIR, { recursive: true });
    try { fs.chmodSync(KEYRING_DIR, 0o700); } catch { /* ignore */ }

    // secretfile= expects a file containing only the raw base64 secret key, not a keyring file
    const keyringPath = path.join(KEYRING_DIR, `${spec.id}.keyring`);
    fs.writeFileSync(keyringPath, params.secret.trim() + '\n', { mode: 0o600 });
  }

  async mount(spec: RemoteFsMountSpec): Promise<void> {
    const params = spec.params as CephFsParams;
    const keyringPath = path.join(KEYRING_DIR, `${spec.id}.keyring`);

    const optParts = [
      `name=${params.clientName}`,
      `secretfile=${keyringPath}`,
    ];
    if (params.fsName) optParts.push(`fs=${params.fsName}`);
    if (spec.options) optParts.push(spec.options);

    await execFileAsync('mount', [
      '-t', 'ceph',
      `${params.monHosts}:${params.exportPath}`,
      spec.hostMountPoint,
      '-o', optParts.join(','),
    ], { timeout: 30_000 });
  }

  matchesCurrent(spec: RemoteFsMountSpec, current: { src: string; opts: string }): boolean {
    const params = spec.params as CephFsParams;
    const expectedSrcSuffix = `:${params.exportPath}`;
    if (!current.src.endsWith(expectedSrcSuffix)) return false;
    return current.opts.includes(`name=${params.clientName}`);
  }

  async cleanup(spec: RemoteFsMountSpec): Promise<void> {
    const keyringPath = path.join(KEYRING_DIR, `${spec.id}.keyring`);
    try { fs.unlinkSync(keyringPath); } catch { /* best-effort */ }
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
