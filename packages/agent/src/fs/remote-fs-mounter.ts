import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RemoteFsMountSpec, RemoteFsMountStatus } from '@nyabase/common';
import type { FsMountDriver } from './fs-driver.js';
import { NfsDriver } from './nfs-driver.js';
import {
  createIsolatedCommandRunner,
  type IsolatedCommandRunner,
} from './isolated-command.js';
import { CephFsDriver } from './cephfs-driver.js';
import { parseProcMounts, readProcMountsFresh } from './proc-mounts.js';
import type { PhysicalReferenceGuard } from '../docker/physical-reference-guard.js';

const execFileAsync = promisify(execFile);
const MAX_PENDING_MUTATIONS = 2;

interface MountEntry {
  spec: RemoteFsMountSpec;
  status: RemoteFsMountStatus;
}

const DEFAULT_ALLOWED_HOST_MOUNT_ROOTS = ['/mnt/remote-fs'];
const FORBIDDEN_HOST_MOUNT_PREFIXES = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var',
];

export type RemoteFsMountStatusEmitter = (status: RemoteFsMountStatus) => void;

export interface RemoteFsMounterOptions {
  /** Last-mile fence before any physical unmount. Omission fails closed. */
  physicalReferenceGuard?: PhysicalReferenceGuard;
  /** Test seam; production uses one fenced runner for mount and unmount. */
  physicalMutationRunner?: IsolatedCommandRunner;
  /** Test/packaging seam. Production defaults to the host-stable lock path. */
  physicalMutationLockPath?: string;
  allowedHostMountRoots?: string[];
  /** Static host roots that must never overlap a Backend-owned RemoteFS path. */
  forbiddenHostPaths?: string[];
}

/** Full physical identity required before an absent operation may unmount. */
export type RemoteFsMountRemovalFallback = Pick<
  RemoteFsMountSpec,
  'hostMountPoint' | 'options' | 'params'
>;

/**
 * Stateless RemoteFS reconciler.
 *
 * The map is only the current process' bootstrapped working set. It is never
 * written to disk, never schedules background retries, and every decision that
 * can change a mount is based on a fresh /proc/mounts read.
 */
export class RemoteFsMounter {
  private readonly mounts = new Map<string, MountEntry>();
  private readonly drivers: Map<string, FsMountDriver>;
  private readonly allowedHostMountRoots: string[];
  private readonly forbiddenHostPaths: string[];
  private readonly physicalReferenceGuard: PhysicalReferenceGuard;
  private readonly physicalMutationRunner: IsolatedCommandRunner;
  private mutationTail: Promise<void> = Promise.resolve();
  private pendingMutations = 0;

  constructor(
    private readonly onStatus: RemoteFsMountStatusEmitter,
    options: RemoteFsMounterOptions = {},
  ) {
    this.physicalReferenceGuard = options.physicalReferenceGuard ?? {
      assertNoRunningBindReferences: async (targetPath) => {
        throw new Error(`Physical reference guard is not configured for ${targetPath}`);
      },
    };
    this.allowedHostMountRoots = (options.allowedHostMountRoots ?? DEFAULT_ALLOWED_HOST_MOUNT_ROOTS)
      .map((root) => path.resolve(root));
    this.forbiddenHostPaths = (options.forbiddenHostPaths ?? [])
      .map((root) => path.resolve(root));
    this.physicalMutationRunner = options.physicalMutationRunner
      ?? createIsolatedCommandRunner({ lockPath: options.physicalMutationLockPath });
    const drivers: FsMountDriver[] = [
      new NfsDriver(this.physicalMutationRunner),
      new CephFsDriver(this.physicalMutationRunner),
    ];
    this.drivers = new Map(drivers.map((driver) => [driver.type, driver]));
  }

  applyMount(spec: RemoteFsMountSpec): Promise<RemoteFsMountSpec> {
    return this.enqueueMutation(() => this.applyMountInternal(spec));
  }

  removeMount(
    id: string,
    fallback?: RemoteFsMountRemovalFallback,
  ): Promise<void> {
    return this.enqueueMutation(() => this.removeMountInternal(id, fallback));
  }

  /**
   * Adopt Backend-confirmed stable identities into connection-local memory.
   * Bootstrap is observation-only: all mount/unmount effects belong to tasks.
   */
  adoptSnapshot(specs: readonly RemoteFsMountSpec[]): Promise<RemoteFsMountStatus[]> {
    return this.enqueueMutation(async () => {
      const canonicalSpecs: RemoteFsMountSpec[] = [];
      const ids = new Set<string>();

      // Validate the whole snapshot before replacing any transient state.
      for (const spec of specs) {
        const canonical = await this.canonicalSpec(spec, false);
        if (ids.has(canonical.id)) {
          throw new Error(`RemoteFS bootstrap has duplicate id ${canonical.id}`);
        }
        const overlap = canonicalSpecs.find((existing) =>
          this.pathsOverlap(existing.hostMountPoint, canonical.hostMountPoint));
        if (overlap) {
          throw new Error(
            `RemoteFS bootstrap paths overlap: ${overlap.hostMountPoint} and ${canonical.hostMountPoint}`,
          );
        }
        ids.add(canonical.id);
        canonicalSpecs.push(canonical);
      }

      this.mounts.clear();
      for (const spec of canonicalSpecs) {
        this.mounts.set(spec.id, this.createEntry(spec));
      }

      try {
        return await this.getAllStatusesFresh();
      } catch (error) {
        const message = `RemoteFS observation failed: ${this.errorMessage(error)}`;
        const now = Date.now();
        for (const entry of this.mounts.values()) {
          entry.status = {
            id: entry.spec.id,
            hostMountPoint: entry.spec.hostMountPoint,
            status: 'error',
            error: message,
            lastCheckedAt: now,
          };
        }
        return Array.from(this.mounts.values()).map((entry) => ({ ...entry.status }));
      }
    });
  }

  /** A disconnect discards only transient ownership; it never changes mounts. */
  resetConnection(): void {
    this.mounts.clear();
  }

  getStatus(id: string): RemoteFsMountStatus | undefined {
    const status = this.mounts.get(id)?.status;
    return status ? { ...status } : undefined;
  }

  getSpec(id: string): RemoteFsMountSpec | undefined {
    const spec = this.mounts.get(id)?.spec;
    return spec ? this.cloneSpec(spec) : undefined;
  }

  getAllSpecs(): RemoteFsMountSpec[] {
    return Array.from(this.mounts.values()).map((entry) => this.cloneSpec(entry.spec));
  }

  async verifyMounted(spec: RemoteFsMountSpec): Promise<boolean> {
    const canonical = await this.canonicalSpec(spec, false);
    const entry = this.mounts.get(canonical.id);
    if (entry && !this.specsEqual(entry.spec, canonical)) return false;
    const driver = this.requireDriver(canonical);
    const current = await this.getCurrentMount(canonical.hostMountPoint);
    const mounted = Boolean(current && driver.matchesCurrent(canonical, current));
    if (mounted) {
      const activeEntry = entry ?? this.createEntry(canonical);
      this.mounts.set(canonical.id, activeEntry);
      const usage = await this.readDiskUsage(canonical.hostMountPoint);
      this.setStatus(activeEntry, 'mounted', undefined, usage);
    } else if (entry) {
      this.setStatus(
        entry,
        'error',
        current
          ? 'Current mount does not match the requested physical identity'
          : 'Mount is absent',
      );
    }
    return mounted;
  }

  async verifyUnmounted(
    id: string,
    fallback?: RemoteFsMountRemovalFallback,
  ): Promise<boolean> {
    const spec = await this.resolveRemovalSpec(id, fallback);
    return (await this.getCurrentMount(spec.hostMountPoint)) === null;
  }

  /** A state report is itself a fresh observation, never a timer/cache replay. */
  async getAllStatuses(): Promise<RemoteFsMountStatus[]> {
    return this.getAllStatusesFresh();
  }

  getDriverSelfChecks() {
    return Array.from(this.drivers.values()).map((driver) => driver.selfCheck());
  }

  private enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
    if (this.pendingMutations >= MAX_PENDING_MUTATIONS) {
      return Promise.reject(new Error('RemoteFS mutation queue is full'));
    }
    this.pendingMutations += 1;
    const execution = this.mutationTail.then(work, work);
    this.mutationTail = execution.then(() => undefined, () => undefined);
    return execution.finally(() => {
      this.pendingMutations -= 1;
    });
  }

  private async applyMountInternal(input: RemoteFsMountSpec): Promise<RemoteFsMountSpec> {
    const spec = await this.canonicalSpec(input, true);
    const driver = this.requireDriver(spec);
    const previous = this.mounts.get(spec.id);
    const pointOwner = Array.from(this.mounts.values()).find((entry) => (
      entry.spec.id !== spec.id && entry.spec.hostMountPoint === spec.hostMountPoint
    ));
    if (pointOwner) {
      throw new Error(
        `RemoteFS mount point ${spec.hostMountPoint} is already assigned to ${pointOwner.spec.id}`,
      );
    }

    if (previous && previous.spec.hostMountPoint !== spec.hostMountPoint) {
      try {
        await this.removePhysicalMount(previous.spec);
      } catch (error) {
        this.setStatus(previous, 'error', this.errorMessage(error));
        throw error;
      }
    }

    const entry = this.createEntry(spec);
    this.mounts.set(spec.id, entry);
    this.setStatus(entry, 'mounting');

    try {

      const current = await this.getCurrentMount(spec.hostMountPoint);
      if (current && driver.matchesCurrent(spec, current)) {
        if (driver.cleanup) await driver.cleanup(spec);
        const usage = await this.readDiskUsage(spec.hostMountPoint);
        this.setStatus(entry, 'mounted', undefined, usage);
        return this.cloneSpec(spec);
      }

      if (current) {
        // The allowlisted root is Agent-owned. Ensure is allowed to replace a
        // stale physical mount so a changed Backend spec can converge.
        await this.ensureUnmounted(spec.hostMountPoint);
      }

      // Mounting over an absent path can still strand an already-running bind
      // on the old underlying directory. The healthy exact-mount fast path
      // above is observation-only; every path that will actually mount must
      // pass the same fresh Docker reference fence as unmount/replace.
      await this.physicalReferenceGuard.assertNoRunningBindReferences(
        spec.hostMountPoint,
      );
      await driver.mount(spec);

      const mounted = await this.getCurrentMount(spec.hostMountPoint);
      if (!mounted || !driver.matchesCurrent(spec, mounted)) {
        throw new Error(`RemoteFS ${spec.id} mount command completed without the requested mount identity`);
      }
      const usage = await this.readDiskUsage(spec.hostMountPoint);
      this.setStatus(entry, 'mounted', undefined, usage);
      return this.cloneSpec(spec);
    } catch (error) {
      // mount(8) may return an ambiguous transport error after the kernel has
      // completed the effect. Only the fresh physical postcondition decides.
      try {
        const current = await this.getCurrentMount(spec.hostMountPoint);
        if (current && driver.matchesCurrent(spec, current)) {
          const usage = await this.readDiskUsage(spec.hostMountPoint);
          this.setStatus(entry, 'mounted', undefined, usage);
          return this.cloneSpec(spec);
        }
      } catch (probeError) {
        this.setStatus(entry, 'error', this.errorMessage(probeError));
        throw probeError;
      }
      this.setStatus(entry, 'error', this.errorMessage(error));
      throw error;
    }
  }

  private async removeMountInternal(
    id: string,
    fallback?: RemoteFsMountRemovalFallback,
  ): Promise<void> {
    const spec = await this.resolveRemovalSpec(id, fallback);
    const entry = this.mounts.get(id);
    const driver = this.requireDriver(spec);

    try {
      const current = await this.getCurrentMount(spec.hostMountPoint);
      if (current) {
        if (!driver.matchesCurrent(spec, current)) {
          throw new Error(
            `Refusing to unmount ${spec.hostMountPoint}: current mount does not match the full absent spec`,
          );
        }
        await this.ensureUnmounted(spec.hostMountPoint);
      }
      if (driver.cleanup) await driver.cleanup(spec);
      this.mounts.delete(id);
    } catch (error) {
      if (entry) this.setStatus(entry, 'error', this.errorMessage(error));
      throw error;
    }
  }

  private async removePhysicalMount(spec: RemoteFsMountSpec): Promise<void> {
    const driver = this.requireDriver(spec);
    const current = await this.getCurrentMount(spec.hostMountPoint);
    if (!current) return;
    if (!driver.matchesCurrent(spec, current)) {
      throw new Error(
        `Refusing to replace ${spec.hostMountPoint}: current mount does not match its known spec`,
      );
    }
    await this.ensureUnmounted(spec.hostMountPoint);
    if (driver.cleanup) await driver.cleanup(spec);
  }

  private async resolveRemovalSpec(
    id: string,
    fallback?: RemoteFsMountRemovalFallback,
  ): Promise<RemoteFsMountSpec> {
    if (fallback) {
      return this.canonicalSpec({ id, ...fallback }, false);
    }
    const spec = this.mounts.get(id)?.spec;
    if (!spec) {
      throw new Error(`RemoteFS absent ${id} requires a full spec when no bootstrapped entry exists`);
    }
    return this.cloneSpec(spec);
  }

  private async getAllStatusesFresh(): Promise<RemoteFsMountStatus[]> {
    const currentByPoint = new Map(
      parseProcMounts(await readProcMountsFresh()).map((entry) => [
        entry.mountPoint,
        { src: entry.source, opts: entry.options },
      ]),
    );
    const statuses: RemoteFsMountStatus[] = [];
    for (const entry of this.mounts.values()) {
      const driver = this.requireDriver(entry.spec);
      const current = currentByPoint.get(entry.spec.hostMountPoint) ?? null;
      if (current && driver.matchesCurrent(entry.spec, current)) {
        entry.status = {
          ...entry.status,
          status: 'mounted',
          error: undefined,
          lastCheckedAt: Date.now(),
        };
      } else {
        entry.status = {
          id: entry.spec.id,
          hostMountPoint: entry.spec.hostMountPoint,
          status: 'error',
          error: current
            ? 'Current mount does not match the requested physical identity'
            : 'Mount is absent',
          lastCheckedAt: Date.now(),
        };
      }
      statuses.push({ ...entry.status });
    }
    return statuses;
  }

  private async canonicalSpec(
    spec: RemoteFsMountSpec,
    createMountPoint: boolean,
  ): Promise<RemoteFsMountSpec> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(spec.id)) {
      throw new Error(`Invalid RemoteFS id ${spec.id}`);
    }
    const hostMountPoint = await this.canonicalizeHostMountPoint(
      spec.hostMountPoint,
      createMountPoint,
    );
    const allowedRoots = await this.getCanonicalAllowedRoots(false);
    if (!allowedRoots.some((root) => hostMountPoint === path.join(root, spec.id))) {
      throw new Error(
        `RemoteFS ${spec.id} path must be exactly <allowed-root>/${spec.id}: ${hostMountPoint}`,
      );
    }
    for (const forbidden of this.forbiddenHostPaths) {
      if (this.pathsOverlap(hostMountPoint, forbidden)) {
        throw new Error(
          `RemoteFS path ${hostMountPoint} overlaps protected host path ${forbidden}`,
        );
      }
    }
    return {
      ...this.cloneSpec(spec),
      hostMountPoint,
    };
  }

  private async canonicalizeHostMountPoint(
    rawMountPoint: string,
    createMountPoint: boolean,
  ): Promise<string> {
    if (rawMountPoint.includes('\0')) {
      throw new Error('remote-fs hostMountPoint must not contain NUL bytes');
    }
    if (rawMountPoint.includes('\\')) {
      throw new Error('remote-fs hostMountPoint must use POSIX path separators');
    }
    if (!path.isAbsolute(rawMountPoint)) {
      throw new Error(`remote-fs hostMountPoint must be absolute: ${rawMountPoint}`);
    }
    const rawSegments = rawMountPoint.split('/').filter(Boolean);
    if (rawSegments.some((segment) => segment === '.' || segment === '..')) {
      throw new Error(`remote-fs hostMountPoint must not contain . or .. segments: ${rawMountPoint}`);
    }

    const normalized = path.resolve(rawMountPoint);
    this.assertNotSystemPath(normalized);
    for (const allowedRoot of await this.getCanonicalAllowedRoots(createMountPoint)) {
      if (!this.isStrictlyInside(normalized, allowedRoot)) continue;
      await this.assertNoExistingSymlinkPath(allowedRoot, normalized);
      if (createMountPoint) fs.mkdirSync(normalized, { recursive: true });
      await this.assertNoExistingSymlinkPath(allowedRoot, normalized);
      let canonical = normalized;
      try {
        canonical = await fs.promises.realpath(normalized);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || createMountPoint) throw error;
      }
      if (canonical !== normalized) {
        throw new Error(`remote-fs hostMountPoint must not resolve through symlinks: ${rawMountPoint} -> ${canonical}`);
      }
      if (!this.isStrictlyInside(canonical, allowedRoot)) {
        throw new Error(`remote-fs hostMountPoint resolved outside allowed root ${allowedRoot}: ${canonical}`);
      }
      return canonical;
    }
    throw new Error(
      `remote-fs hostMountPoint must be under ${this.allowedHostMountRoots.join(', ')}: ${rawMountPoint}`,
    );
  }

  private async getCanonicalAllowedRoots(create: boolean): Promise<string[]> {
    const roots: string[] = [];
    for (const rawRoot of this.allowedHostMountRoots) {
      if (!path.isAbsolute(rawRoot)) {
        throw new Error(`remote-fs allowed host mount root must be absolute: ${rawRoot}`);
      }
      const normalizedRoot = path.resolve(rawRoot);
      this.assertNotSystemPath(normalizedRoot);
      await this.assertNoExistingSymlinkPath(path.parse(normalizedRoot).root, normalizedRoot);
      if (create) fs.mkdirSync(normalizedRoot, { recursive: true });
      let canonicalRoot = normalizedRoot;
      try {
        canonicalRoot = await fs.promises.realpath(normalizedRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || create) throw error;
      }
      if (canonicalRoot !== normalizedRoot) {
        throw new Error(`remote-fs allowed host mount root must not resolve through symlinks: ${rawRoot} -> ${canonicalRoot}`);
      }
      roots.push(canonicalRoot);
    }
    return roots;
  }

  private assertNotSystemPath(candidate: string): void {
    if (candidate === '/') throw new Error('remote-fs hostMountPoint must not be the filesystem root');
    for (const forbidden of FORBIDDEN_HOST_MOUNT_PREFIXES) {
      if (candidate === forbidden || candidate.startsWith(`${forbidden}/`)) {
        throw new Error(`remote-fs hostMountPoint must not be under system path ${forbidden}: ${candidate}`);
      }
    }
  }

  private async assertNoExistingSymlinkPath(root: string, target: string): Promise<void> {
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`remote-fs hostMountPoint must be below allowed root ${root}: ${target}`);
    }
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new Error(`remote-fs hostMountPoint must not contain symlinks: ${current}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`remote-fs hostMountPoint component is not a directory: ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }

  private isStrictlyInside(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  private pathsOverlap(a: string, b: string): boolean {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return left === right
      || this.isStrictlyInside(left, right)
      || this.isStrictlyInside(right, left);
  }

  private async getCurrentMount(mountPoint: string): Promise<{ src: string; opts: string } | null> {
    const entries = parseProcMounts(await readProcMountsFresh());
    const current = entries.find((entry) => entry.mountPoint === mountPoint);
    return current ? { src: current.source, opts: current.options } : null;
  }

  private async umountHost(mountPoint: string): Promise<void> {
    await this.physicalMutationRunner('umount', [mountPoint], 15_000);
  }

  private async ensureUnmounted(mountPoint: string): Promise<void> {
    // Keep the proof adjacent to the destructive effect. In particular, a
    // matching Ensure never reaches this fence, while both stale-target and
    // old-path replacement unmounts do.
    await this.physicalReferenceGuard.assertNoRunningBindReferences(mountPoint);
    let commandError: unknown;
    try {
      await this.umountHost(mountPoint);
    } catch (error) {
      commandError = error;
    }
    const remaining = await this.getCurrentMount(mountPoint);
    if (!remaining) return;
    if (commandError) throw commandError;
    throw new Error(`RemoteFS mount point ${mountPoint} remained mounted after umount`);
  }

  private async readDiskUsage(
    mountPoint: string,
  ): Promise<{ totalBytes: number; usedBytes: number } | null> {
    try {
      const { stdout } = await execFileAsync(
        'df',
        ['--output=size,used', '-B1', mountPoint],
        { timeout: 5_000 },
      );
      const parts = stdout.trim().split('\n').filter(Boolean).at(-1)?.trim().split(/\s+/) ?? [];
      const totalBytes = Number.parseInt(parts[0], 10);
      const usedBytes = Number.parseInt(parts[1], 10);
      return Number.isFinite(totalBytes) && Number.isFinite(usedBytes)
        ? { totalBytes, usedBytes }
        : null;
    } catch {
      return null;
    }
  }

  private createEntry(spec: RemoteFsMountSpec): MountEntry {
    return {
      spec: this.cloneSpec(spec),
      status: {
        id: spec.id,
        hostMountPoint: spec.hostMountPoint,
        status: 'mounting',
        lastCheckedAt: Date.now(),
      },
    };
  }

  private setStatus(
    entry: MountEntry,
    status: 'mounted' | 'mounting' | 'error',
    error?: string,
    usage?: { totalBytes: number; usedBytes: number } | null,
  ): void {
    entry.status = {
      id: entry.spec.id,
      hostMountPoint: entry.spec.hostMountPoint,
      status,
      ...(error ? { error } : {}),
      lastCheckedAt: Date.now(),
      ...(usage ? { totalBytes: usage.totalBytes, usedBytes: usage.usedBytes } : {}),
    };
    try {
      this.onStatus({ ...entry.status });
    } catch {
      // Status reporting cannot change the physical operation outcome.
    }
  }

  private requireDriver(spec: RemoteFsMountSpec): FsMountDriver {
    const driver = this.drivers.get(spec.params.type);
    if (!driver) throw new Error(`Unknown filesystem type: ${spec.params.type}`);
    return driver;
  }

  private specsEqual(a: RemoteFsMountSpec, b: RemoteFsMountSpec): boolean {
    return a.id === b.id
      && a.hostMountPoint === b.hostMountPoint
      && a.options === b.options
      && JSON.stringify(a.params) === JSON.stringify(b.params);
  }

  private cloneSpec(spec: RemoteFsMountSpec): RemoteFsMountSpec {
    return {
      ...spec,
      params: JSON.parse(JSON.stringify(spec.params)) as RemoteFsMountSpec['params'],
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
