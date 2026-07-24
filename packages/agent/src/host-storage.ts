import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig } from './config.js';

export interface MountIdentity {
  /** Kernel mount id (mountinfo field 1), unique for the lifetime of a mount. */
  mountId: number;
  deviceId: string;
  /** Root of this mount inside the backing filesystem (mountinfo field 4). */
  fsRoot: string;
  mountPoint: string;
  fsType: string;
  mountOptions: Set<string>;
  superOptions: Set<string>;
}

export class HostStorageIdentityChangedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HostStorageIdentityChangedError';
  }
}

export interface HostStorageIdentityGuardOptions {
  /** Stable identity used in the Agent fingerprint and wire projections. */
  readIdentity: (root: string) => string;
  /** Boot-lifetime identity that also detects an unmount/remount of the same FS. */
  readRuntimeIdentity?: (root: string) => string;
  assertLayout?: (config: AgentConfig) => void;
  fatalHook?: (error: HostStorageIdentityChangedError) => void;
}

/**
 * Runtime fence for hot unmount/remount or bind-source swaps. The Agent keeps
 * no task state, but it must retain the immutable physical identities proved
 * at startup and fail-stop before any later mutation/report if they change.
 */
export class HostStorageIdentityGuard {
  private readonly expected = new Map<string, string>();
  private readonly expectedRuntime = new Map<string, string>();
  private readonly readIdentity: (root: string) => string;
  private readonly readRuntimeIdentity: (root: string) => string;
  private readonly assertLayout: (config: AgentConfig) => void;
  private readonly fatalHook: (error: HostStorageIdentityChangedError) => void;

  constructor(
    private readonly config: AgentConfig,
    options: HostStorageIdentityGuardOptions,
  ) {
    this.readIdentity = options.readIdentity;
    this.readRuntimeIdentity = options.readRuntimeIdentity ?? options.readIdentity;
    this.assertLayout = options.assertLayout ?? assertHostStorageLayout;
    this.fatalHook = options.fatalHook ?? ((error) => {
      console.error(`[Storage] ${error.message}; terminating Agent before further physical work`);
      process.kill(process.pid, 'SIGKILL');
    });
    for (const root of this.roots()) {
      this.expected.set(root, this.readIdentity(root));
      this.expectedRuntime.set(root, this.readRuntimeIdentity(root));
    }
  }

  get dockerRootIdentity(): string {
    return this.expected.get(path.resolve(this.config.dockerRoot))!;
  }

  assertCurrent(): void {
    try {
      this.assertLayout(this.config);
      for (const root of this.roots()) {
        const expected = this.expected.get(root);
        const expectedRuntime = this.expectedRuntime.get(root);
        const current = this.readIdentity(root);
        const currentRuntime = this.readRuntimeIdentity(root);
        if (!expected || current !== expected || !expectedRuntime || currentRuntime !== expectedRuntime) {
          throw new Error(`storage identity changed at ${root}: expected ${expected}, observed ${current}`);
        }
      }
    } catch (cause) {
      const error = cause instanceof HostStorageIdentityChangedError
        ? cause
        : new HostStorageIdentityChangedError(
            cause instanceof Error ? cause.message : String(cause),
            { cause },
          );
      this.fatalHook(error);
      throw error;
    }
  }

  private roots(): string[] {
    return [
      path.resolve(this.config.dockerRoot),
      ...this.config.localDataSources.map((source) => path.resolve(source.mountPoint)),
    ];
  }
}

/**
 * Prove every quota-bearing root before any systemd or dockerd mutation.
 * A configured root must be a canonical, non-symlink, exact XFS mount with
 * project-quota accounting/enforcement requested by the kernel mount options.
 */
export function assertHostStorageLayout(config: AgentConfig): void {
  const mounts = parseMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
  const roots = [
    config.dockerRoot,
    ...config.localDataSources.map((source) => source.mountPoint),
  ].map((configured) => path.resolve(configured));
  for (const root of roots) {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw new Error(`Configured storage root is not a directory: ${root}`);
    const real = fs.realpathSync(root);
    if (real !== root) {
      throw new Error(`Configured storage root must not be a symlink or alias: ${root} -> ${real}`);
    }
  }
  assertQuotaMountTopology(roots, mounts);
}

export function assertQuotaMountTopology(
  roots: readonly string[],
  mounts: readonly MountIdentity[],
): void {
  const quotaDevices = new Set<string>();
  const physicalRoots = new Set<string>();
  for (const root of roots) {
    const exactMatches = mounts.filter((mount) => mount.mountPoint === root);
    if (exactMatches.length !== 1) {
      throw new Error(
        exactMatches.length === 0
          ? `Configured storage root must be an exact filesystem mount: ${root}`
          : `Configured storage root has an ambiguous stacked mount: ${root}`,
      );
    }
    const exact = exactMatches[0]!;
    if (exact.fsType !== 'xfs') {
      throw new Error(`Configured storage root ${root} uses ${exact.fsType}, expected xfs`);
    }
    const options = new Set([...exact.mountOptions, ...exact.superOptions]);
    if (!options.has('pquota') && !options.has('prjquota')) {
      throw new Error(`Configured XFS root ${root} is missing pquota/prjquota`);
    }
    quotaDevices.add(exact.deviceId);
    const physicalRoot = `${exact.deviceId}\0${exact.fsRoot}`;
    if (physicalRoots.has(physicalRoot)) {
      throw new Error(
        `Configured storage roots must reference distinct filesystem roots; duplicate ${exact.fsRoot}`,
      );
    }
    physicalRoots.add(physicalRoot);
  }
  if (quotaDevices.size !== 1) {
    throw new Error(
      'dockerRoot and every localDataSources mountPoint must reference one shared XFS filesystem',
    );
  }
}

export function parseMountInfo(contents: string): MountIdentity[] {
  const result: MountIdentity[] = [];
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || separator + 3 >= fields.length) continue;
    result.push({
      mountId: Number.parseInt(fields[0], 10),
      deviceId: fields[2],
      fsRoot: path.resolve(decodeMountInfoPath(fields[3])),
      mountPoint: path.resolve(decodeMountInfoPath(fields[4])),
      mountOptions: new Set(fields[5].split(',').filter(Boolean)),
      fsType: fields[separator + 1],
      superOptions: new Set(fields[separator + 3].split(',').filter(Boolean)),
    });
  }
  return result;
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}
