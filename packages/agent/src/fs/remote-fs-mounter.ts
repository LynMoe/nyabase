import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RemoteFsMountSpec, RemoteFsMountStatus } from '@nyabase/common';
import type { FsMountDriver } from './fs-driver.js';
import { NfsDriver } from './nfs-driver.js';
import { CephFsDriver } from './cephfs-driver.js';
import { readProcMountsCached } from './proc-mounts.js';


const execFileAsync = promisify(execFile);

interface MountEntry {
  spec: RemoteFsMountSpec;
  status: RemoteFsMountStatus;
  retryTimer?: ReturnType<typeof setTimeout>;
  checkTimer?: ReturnType<typeof setTimeout>;
  retryDelay: number;
}

const RETRY_STEPS = [10_000, 30_000, 60_000];
const HEALTH_CHECK_INTERVAL = 30_000;

export type RemoteFsMountStatusEmitter = (status: RemoteFsMountStatus) => void;

export class RemoteFsMounter {
  private mounts: Map<string, MountEntry> = new Map();
  private onStatus: RemoteFsMountStatusEmitter;
  private drivers: Map<string, FsMountDriver>;

  constructor(onStatus: RemoteFsMountStatusEmitter) {
    this.onStatus = onStatus;
    const drivers: FsMountDriver[] = [new NfsDriver(), new CephFsDriver()];
    this.drivers = new Map<string, FsMountDriver>(
      drivers.map((d) => [d.type, d]),
    );
  }

  async applyMount(spec: RemoteFsMountSpec): Promise<void> {
    const existing = this.mounts.get(spec.id);

    if (existing && existing.status.status === 'mounted' && this.specsEqual(existing.spec, spec)) {
      return;
    }

    if (existing && existing.status.status === 'mounted' && !this.specsEqual(existing.spec, spec)) {
      await this.umountHost(existing.spec);
      this.clearTimers(existing);
    }

    const entry: MountEntry = existing
      ? { ...existing, spec, retryDelay: 0 }
      : {
          spec,
          status: { id: spec.id, hostMountPoint: spec.hostMountPoint, status: 'mounting', lastCheckedAt: Date.now() },
          retryDelay: 0,
        };
    this.mounts.set(spec.id, entry);
    this.emitStatus(entry.status);
    await this.doMount(entry);
  }

  async removeMount(id: string, force = false): Promise<void> {
    const entry = this.mounts.get(id);
    if (!entry) return;

    this.clearTimers(entry);

    if (entry.status.status === 'mounted') {
      try {
        const driver = this.drivers.get(entry.spec.params.type);
        await this.umountHost(entry.spec, force);
        if (driver?.cleanup) {
          await driver.cleanup(entry.spec).catch(() => {});
        }
      } catch (e) {
        if (!force) throw e;
      }
    }
    this.mounts.delete(id);
  }

  getStatus(id: string): RemoteFsMountStatus | undefined {
    return this.mounts.get(id)?.status;
  }

  getAllStatuses(): RemoteFsMountStatus[] {
    return Array.from(this.mounts.values()).map((e) => e.status);
  }

  getDriverSelfChecks() {
    return Array.from(this.drivers.values()).map((d) => d.selfCheck());
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async doMount(entry: MountEntry): Promise<void> {
    const { spec } = entry;
    const driver = this.drivers.get(spec.params.type);
    if (!driver) {
      this.setStatus(entry, 'error', `Unknown filesystem type: ${spec.params.type}`);
      return;
    }

    try {
      fs.mkdirSync(spec.hostMountPoint, { recursive: true });

      const currentMount = await this.getCurrentMount(spec.hostMountPoint);
      if (currentMount) {
        if (driver.matchesCurrent(spec, currentMount)) {
          const usage = await this.readDiskUsage(spec.hostMountPoint);
          this.setStatus(entry, 'mounted', undefined, usage);
          this.scheduleHealthCheck(entry);
          return;
        }
        await this.umountHost(spec);
      }

      if (driver.prepare) {
        await driver.prepare(spec);
      }

      await driver.mount(spec);

      const usage = await this.readDiskUsage(spec.hostMountPoint);
      this.setStatus(entry, 'mounted', undefined, usage);
      entry.retryDelay = 0;
      this.scheduleHealthCheck(entry);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.setStatus(entry, 'error', error);
      this.scheduleRetry(entry);
    }
  }

  private async getCurrentMount(mountPoint: string): Promise<{ src: string; opts: string } | null> {
    try {
      const content = await readProcMountsCached();
      for (const line of content.split('\n')) {
        const parts = line.split(' ');
        if (parts[1] === mountPoint) {
          return { src: parts[0], opts: parts[3] ?? '' };
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  private async umountHost(spec: RemoteFsMountSpec, lazy = false): Promise<void> {
    const args = lazy ? ['-l', spec.hostMountPoint] : [spec.hostMountPoint];
    await execFileAsync('umount', args, { timeout: 15_000 });
  }

  private async readDiskUsage(mountPoint: string): Promise<{ totalBytes: number; usedBytes: number } | null> {
    try {
      const { stdout } = await execFileAsync('df', ['--output=size,used', '-B1', mountPoint], { timeout: 5_000 });
      const lines = stdout.trim().split('\n').filter(Boolean);
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      const totalBytes = parseInt(parts[0], 10);
      const usedBytes = parseInt(parts[1], 10);
      if (isNaN(totalBytes) || isNaN(usedBytes)) return null;
      return { totalBytes, usedBytes };
    } catch {
      return null;
    }
  }

  private setStatus(entry: MountEntry, status: 'mounted' | 'mounting' | 'error', error?: string, usage?: { totalBytes: number; usedBytes: number } | null) {
    entry.status = {
      id: entry.spec.id,
      hostMountPoint: entry.spec.hostMountPoint,
      status,
      error,
      lastCheckedAt: Date.now(),
      ...(usage ? { totalBytes: usage.totalBytes, usedBytes: usage.usedBytes } : {}),
    };
    this.emitStatus(entry.status);
  }

  private emitStatus(status: RemoteFsMountStatus) {
    try { this.onStatus(status); } catch { /* ignore */ }
  }

  private scheduleRetry(entry: MountEntry) {
    const steps = RETRY_STEPS;
    const delay = steps[Math.min(entry.retryDelay, steps.length - 1)];
    if (entry.retryDelay < steps.length) entry.retryDelay++;

    entry.retryTimer = setTimeout(() => {
      if (this.mounts.has(entry.spec.id)) {
        void this.doMount(entry);
      }
    }, delay);
  }

  private scheduleHealthCheck(entry: MountEntry) {
    this.clearCheckTimer(entry);
    entry.checkTimer = setTimeout(async () => {
      if (!this.mounts.has(entry.spec.id)) return;
      try {
        await execFileAsync('stat', ['-f', entry.spec.hostMountPoint], { timeout: 5_000 });
        const usage = await this.readDiskUsage(entry.spec.hostMountPoint);
        this.setStatus(entry, 'mounted', undefined, usage);
        this.scheduleHealthCheck(entry);
      } catch {
        this.setStatus(entry, 'error', 'Health check failed');
        this.scheduleRetry(entry);
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  private clearTimers(entry: MountEntry) {
    this.clearRetryTimer(entry);
    this.clearCheckTimer(entry);
  }

  private clearRetryTimer(entry: MountEntry) {
    if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = undefined; }
  }

  private clearCheckTimer(entry: MountEntry) {
    if (entry.checkTimer) { clearTimeout(entry.checkTimer); entry.checkTimer = undefined; }
  }

  private specsEqual(a: RemoteFsMountSpec, b: RemoteFsMountSpec): boolean {
    return JSON.stringify(a.params) === JSON.stringify(b.params) &&
      a.options === b.options &&
      a.hostMountPoint === b.hostMountPoint;
  }
}
