import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import type { XfsQuotaManager } from '../quota/xfs-quota.js';
import {
  MAX_MANAGED_DATA_DIRS_PER_AGENT,
  zTaskId,
  type DataDirEntry,
} from '@nyabase/common';
import { parseProcMounts } from '../fs/proc-mounts.js';
import {
  PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE,
  PHYSICAL_MUTATION_LOCK_PATH,
  PhysicalMutationFenceBusyError,
  fencePhysicalMutationCommand,
} from '../physical-mutation-fence.js';

const META_DIR = '.nyabase';
const DIRS_DIR = 'dirs';
const MARKER_VERSION = 1;
const DEFAULT_MUTATION_TIMEOUT_MS = 60_000;
const DEFAULT_OWNERSHIP_OBSERVATION_TIMEOUT_MS = 10_000;
const DEFAULT_OWNERSHIP_OBSERVATION_ENTRY_CAP = 100_000;
const DEFAULT_CHILD_PROCESS_CAP = 32;
const CHILD_SOURCE_FD = 3;
const CHILD_SOURCE_ROOT = `/proc/self/fd/${CHILD_SOURCE_FD}`;

export interface DataSource {
  kind: 'local' | 'remote';
  id: string;
  root: string;
  /** Stable physical filesystem identity, never the mutable mount path. */
  identity: string;
  label?: string | null;
  quotaEnabled: boolean;
}

export interface DataDirCreateResult {
  path: string;
  created: boolean;
}

export interface DataDirObservation {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  uid: number | null;
  gid: number | null;
  resourceId: string | null;
}

export interface DataSourceObservation {
  sourceId: string;
  kind: 'local' | 'remote' | null;
  root: string | null;
  identity: string | null;
  configured: boolean;
  exists: boolean;
  isDirectory: boolean;
  mounted: boolean;
  fsType: string | null;
  ready: boolean;
  device: string | null;
}

interface DataDirMarker {
  version: 1;
  resourceId: string;
  sourceId: string;
  sourceIdentity: string;
}

interface PinnedSource {
  source: DataSource;
  root: string;
  fd: number;
}

interface ActiveDataDirChild {
  child: ChildProcess | null;
}

export interface DataDirsManagerOptions {
  mutationTimeoutMs?: number;
  ownershipObservationTimeoutMs?: number;
  ownershipObservationEntryCap?: number;
  childProcessCap?: number;
  /** Production sends SIGKILL; tests inject a recorder that deliberately returns. */
  fatalHook?: (error: DataDirMutationDeadlineError) => void;
  physicalMutationLockPath?: string;
}

export class DataDirIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataDirIdentityConflictError';
  }
}

/**
 * The operation may have partially completed, or its full physical state could
 * not be observed inside a finite budget. Callers must report `incomplete` and
 * reconcile; they must never turn this into a terminal managed failure.
 */
export class DataDirOperationIncompleteError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
  ) {
    super(message);
    this.name = 'DataDirOperationIncompleteError';
  }
}

/**
 * A source mutation child did not reach process exit by its hard deadline.
 * Its physical result is ambiguous, so the Agent must die before Backend can
 * replay the task through a replacement process.
 */
export class DataDirMutationDeadlineError extends Error {
  readonly ambiguous = true;

  constructor(public readonly operation: string, public readonly timeoutMs: number) {
    super(`DataDir mutation exceeded its fail-stop deadline after ${timeoutMs}ms: ${operation}`);
    this.name = 'DataDirMutationDeadlineError';
  }
}

function killAgentAfterAmbiguousDataDirMutation(error: DataDirMutationDeadlineError): void {
  console.error(`[DataDir] ${error.message}; terminating Agent to prevent overlapping replay`);
  process.kill(process.pid, 'SIGKILL');
}

/**
 * Give the mutation process its own reference to the already-verified source.
 * fd 3 belongs to the child, so closing or reusing the parent's numeric fd can
 * never retarget a late syscall that resolves /proc/self/fd/3.
 */
export function spawnPinnedSourceMutation(
  file: string,
  args: readonly string[],
  sourceFd: number,
  lockPath = PHYSICAL_MUTATION_LOCK_PATH,
): ChildProcess {
  const fenced = fencePhysicalMutationCommand(file, args, lockPath);
  return spawn(fenced.executable, fenced.args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', sourceFd],
  });
}

/**
 * Resolve the immutable physical source behind one configured bind mount.
 * UUID alone cannot distinguish two subdirectories bind-mounted from the same
 * XFS filesystem, so the mount's filesystem root is part of the identity.
 */
export function readLocalDataSourceIdentity(root: string): string {
  const resolvedRoot = path.resolve(root);
  const uuid = execFileSync(
    'findmnt',
    ['--noheadings', '--raw', '--output', 'UUID', '--mountpoint', resolvedRoot],
    { encoding: 'utf8', timeout: 5_000 },
  ).trim().split(/\s+/)[0];
  if (!uuid || uuid === '-') {
    throw new Error(`Local XFS source ${root} has no filesystem UUID`);
  }
  const exact = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find((line) => {
    if (!line.trim()) return false;
    const fields = line.split(' ');
    return fields.length > 5
      && path.resolve(decodeMountInfoPath(fields[4])) === resolvedRoot;
  });
  if (!exact) throw new Error(`Local XFS source ${root} is not an exact mount`);
  const fields = exact.split(' ');
  const separator = fields.indexOf('-');
  if (separator < 6 || fields[separator + 1] !== 'xfs') {
    throw new Error(`Local source ${root} is not an exact XFS mount`);
  }
  const fsRoot = path.resolve(decodeMountInfoPath(fields[3]));
  return `local:xfs:${uuid.toLowerCase()}:fsroot=${encodeURIComponent(fsRoot)}`;
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export class DataDirsManager {
  private readonly sources = new Map<string, DataSource>();
  private readonly mutationTimeoutMs: number;
  private readonly ownershipObservationTimeoutMs: number;
  private readonly ownershipObservationEntryCap: number;
  private readonly childProcessCap: number;
  private readonly fatalHook: (error: DataDirMutationDeadlineError) => void;
  private readonly physicalMutationLockPath: string;
  private failStopTriggered = false;
  /** Mutation children remain fenced until their process exit is observable. */
  private readonly activeChildren = new Map<string, ActiveDataDirChild>();

  constructor(
    _quotaManager?: XfsQuotaManager,
    _dockerRoot?: string,
    private readonly sourceObserver?: (source: DataSource) => DataSourceObservation,
    options: DataDirsManagerOptions = {},
  ) {
    this.mutationTimeoutMs = this.positiveInteger(
      options.mutationTimeoutMs,
      DEFAULT_MUTATION_TIMEOUT_MS,
    );
    this.ownershipObservationTimeoutMs = this.positiveInteger(
      options.ownershipObservationTimeoutMs,
      DEFAULT_OWNERSHIP_OBSERVATION_TIMEOUT_MS,
    );
    this.ownershipObservationEntryCap = this.positiveInteger(
      options.ownershipObservationEntryCap,
      DEFAULT_OWNERSHIP_OBSERVATION_ENTRY_CAP,
    );
    this.childProcessCap = this.positiveInteger(
      options.childProcessCap,
      DEFAULT_CHILD_PROCESS_CAP,
    );
    this.fatalHook = options.fatalHook ?? killAgentAfterAmbiguousDataDirMutation;
    this.physicalMutationLockPath = options.physicalMutationLockPath ?? PHYSICAL_MUTATION_LOCK_PATH;
  }

  addSource(src: DataSource): void {
    this.sources.set(src.id, { ...src, root: path.resolve(src.root) });
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  getSource(id: string): DataSource | undefined {
    return this.sources.get(id);
  }

  inspectSource(sourceId: string): DataSourceObservation {
    const source = this.sources.get(sourceId);
    if (!source) return this.missingSourceObservation(sourceId);
    if (this.sourceObserver) return this.sourceObserver(source);

    const root = path.resolve(source.root);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const mount = parseProcMounts(fs.readFileSync('/proc/mounts', 'utf8'))
      .find((entry) => path.resolve(entry.mountPoint) === root);
    const expectedType = source.kind === 'local'
      ? mount?.fsType === 'xfs'
      : mount?.fsType === 'nfs' || mount?.fsType === 'nfs4' || mount?.fsType === 'ceph';
    const mounted = Boolean(mount && expectedType);
    let identityMatches = source.kind === 'remote';
    if (mounted && source.kind === 'local') {
      try {
        identityMatches = readLocalDataSourceIdentity(root) === source.identity;
      } catch {
        identityMatches = false;
      }
    }
    return {
      sourceId,
      kind: source.kind,
      root,
      identity: source.identity,
      configured: true,
      exists: stat !== null,
      isDirectory: stat?.isDirectory() ?? false,
      mounted,
      fsType: mount?.fsType ?? null,
      ready: Boolean(stat?.isDirectory() && mounted && identityMatches),
      device: stat ? String(stat.dev) : null,
    };
  }

  getDirPath(sourceId: string, resourceId: string): string {
    const source = this.requireSource(sourceId);
    return this.dataPath(source.root, resourceId);
  }

  async listAllDirs(): Promise<DataDirEntry[]> {
    if (this.failStopTriggered) return new Promise<DataDirEntry[]>(() => { /* process is terminating */ });
    const entries: DataDirEntry[] = [];
    let scannedChildren = 0;
    for (const source of this.sources.values()) {
      if (!this.inspectSource(source.id).ready) {
        throw new Error(`Data directory source ${source.id} is not safely mounted`);
      }
      const dirsRoot = this.dirsRoot(source.root);
      if (!this.pathExists(dirsRoot)) continue;
      if (!this.isSafeRootDirectory(dirsRoot)) {
        throw new Error(`Data directory inventory root is unsafe: ${dirsRoot}`);
      }
      const directory = fs.opendirSync(dirsRoot);
      try {
        let entry: fs.Dirent | null;
        while ((entry = directory.readSync()) !== null) {
          scannedChildren += 1;
          if (scannedChildren > MAX_MANAGED_DATA_DIRS_PER_AGENT) {
            throw new Error(
              `Data directory inventory exceeds ${MAX_MANAGED_DATA_DIRS_PER_AGENT} filesystem entries`,
            );
          }
          const tombstone = this.parseInventoryTombstoneName(entry.name);
          if (tombstone) {
            if (!entry.isDirectory()) {
              throw new Error(`Data directory inventory tombstone is not a directory: ${entry.name}`);
            }
            this.validateInventoryTombstone(source, tombstone.kind, tombstone.resourceId);
            // Staging/tombstone roots are durable replay evidence, not active
            // data directories. Keep them physically reserved and let the
            // original idempotent task roll forward after reconnect.
            continue;
          }
          if (!entry.isDirectory() || !zTaskId.safeParse(entry.name).success) {
            throw new Error(`Data directory inventory contains unexplained entry ${entry.name}`);
          }
          const marker = this.readMarker(source.root, entry.name);
          const dataPath = this.dataPath(source.root, entry.name);
          if (
            !marker
            || marker.resourceId !== entry.name
            || marker.sourceId !== source.id
            || marker.sourceIdentity !== source.identity
            || !this.isDirectoryWithoutSymlink(dataPath)
          ) {
            throw new Error(`Managed data directory ${entry.name} has corrupt immutable identity`);
          }
          entries.push({
            sourceKind: source.kind,
            sourceId: source.id,
            resourceId: entry.name,
            hostPath: dataPath,
          });
        }
      } finally {
        directory.closeSync();
      }
    }
    return entries;
  }

  private parseInventoryTombstoneName(
    name: string,
  ): { kind: 'creating' | 'deleting'; resourceId: string } | null {
    for (const kind of ['creating', 'deleting'] as const) {
      const prefix = `.${kind}-`;
      if (!name.startsWith(prefix)) continue;
      const resourceId = name.slice(prefix.length);
      return zTaskId.safeParse(resourceId).success ? { kind, resourceId } : null;
    }
    return null;
  }

  private validateInventoryTombstone(
    source: DataSource,
    kind: 'creating' | 'deleting',
    resourceId: string,
  ): void {
    const tombstoneRoot = kind === 'creating'
      ? this.creatingRoot(source.root, resourceId)
      : this.deletingRoot(source.root, resourceId);
    this.ensureRootOnlyDirectory(tombstoneRoot);
    const children = fs.readdirSync(tombstoneRoot);
    const marker = this.readMarkerAt(tombstoneRoot, resourceId);
    const expected = this.expectedMarker(source, resourceId, source.identity);

    if (kind === 'creating') {
      if (marker) {
        this.assertMarker(marker, expected);
        if (children.some((entry) => entry !== 'marker.json' && entry !== 'data')) {
          throw new DataDirIdentityConflictError(
            `Create tombstone for ${resourceId} contains unmanaged entries`,
          );
        }
      } else {
        // A crash before the atomic marker rename has no identity to adopt.
        // Only the exact root-owned pre-marker shape is replayable; the task
        // will discard and rebuild it before publishing anything.
        this.assertControlledUnmarkedCreatingTombstone(tombstoneRoot, resourceId, children);
      }
      this.assertSafeStagedData(tombstoneRoot, resourceId);
      return;
    }

    if (!marker) {
      // Recursive deletion removes user data first and marker/root last. Only
      // an empty unmarked root can be a legitimate interrupted final step.
      if (children.length !== 0) {
        throw new DataDirIdentityConflictError(
          `Unmarked delete tombstone for ${resourceId} contains unmanaged entries`,
        );
      }
      return;
    }
    this.assertMarker(marker, expected);
    if (children.some((entry) => entry !== 'marker.json' && entry !== 'data')) {
      throw new DataDirIdentityConflictError(
        `Delete tombstone for ${resourceId} contains unmanaged entries`,
      );
    }
    const data = path.join(tombstoneRoot, 'data');
    if (this.pathExists(data) && !this.isDirectoryWithoutSymlink(data)) {
      throw new DataDirIdentityConflictError(
        `Delete tombstone data is not a safe directory for ${resourceId}`,
      );
    }
  }

  async createDir(
    sourceId: string,
    uid: number,
    resourceId: string,
    sourceIdentity: string,
  ): Promise<DataDirCreateResult> {
    if (this.failStopTriggered) return new Promise<DataDirCreateResult>(() => { /* process is terminating */ });
    return this.withPinnedSource(sourceId, sourceIdentity, async (pinned) => {
      const { source, root } = pinned;
      this.assertResourceId(resourceId);
      this.ensureMetadataRoots(root);
      const resourceRoot = this.resourceRoot(root, resourceId);
      const marker = this.expectedMarker(source, resourceId, sourceIdentity);
      const deletingRoot = this.deletingRoot(root, resourceId);
      if (this.pathExists(deletingRoot)) {
        // A previous delete may have committed its atomic rename before the
        // Agent disappeared. Finish that exact identity before recreating.
        await this.finishDeletionTombstone(pinned, deletingRoot, marker);
      }
      const existedBefore = this.pathExists(resourceRoot);
      if (existedBefore) {
        const existingMarker = this.readMarker(root, resourceId);
        if (!existingMarker) {
          throw new DataDirIdentityConflictError(`Refusing to adopt unmarked DataDir resource ${resourceId}`);
        }
        this.assertMarker(existingMarker, marker);
        this.ensureRootOnlyDirectory(resourceRoot);
      } else {
        await this.createResourceTree(pinned, marker);
      }

      const dirPath = this.dataPath(root, resourceId);
      const chownOperation = `chown(${resourceId})`;
      const childFence = this.resourceFenceKey(marker);
      try {
        await this.runPinnedChildWithDeadline(
          pinned,
          'chown',
          ['-R', '--', `${uid}:${uid}`, this.childPath(pinned, dirPath)],
          chownOperation,
          childFence,
        );
      } catch (error) {
        // chown can mutate a prefix before returning an error. A recursive
        // fresh observation may roll forward only if the desired owner is
        // already exact; every other outcome remains incomplete for replay.
        const mismatch = await this.findOwnershipMismatch(dirPath, uid);
        // A mutation deadline never reaches this catch: it fail-stops the Agent
        // and deliberately leaves the call pending. Settled child failures can
        // still have partially changed ownership and need exact observation.
        if (error instanceof DataDirOperationIncompleteError) throw error;
        if (mismatch !== null) {
          throw new DataDirOperationIncompleteError(
            `${chownOperation} did not converge at ${mismatch}: ${this.errorMessage(error)}`,
            chownOperation,
          );
        }
      }
      const mismatch = await this.findOwnershipMismatch(dirPath, uid);
      if (mismatch) throw new Error(`Data directory ownership did not converge at ${mismatch}`);
      return { path: this.dataPath(source.root, resourceId), created: !existedBefore };
    });
  }

  async deleteDir(
    sourceId: string,
    resourceId: string,
    sourceIdentity: string,
  ): Promise<void> {
    if (this.failStopTriggered) return new Promise<void>(() => { /* process is terminating */ });
    await this.withPinnedSource(sourceId, sourceIdentity, async (pinned) => {
      const { source, root } = pinned;
      this.assertResourceId(resourceId);
      const resourceRoot = this.resourceRoot(root, resourceId);
      const deletingRoot = this.deletingRoot(root, resourceId);
      const creatingRoot = this.creatingRoot(root, resourceId);
      const expected = this.expectedMarker(source, resourceId, sourceIdentity);

      // A create can die after reserving its fixed staging name but before the
      // atomic publication rename. Absent must remove that reservation too;
      // otherwise a later create could resurrect data after delete succeeded.
      if (this.pathExists(creatingRoot)) {
        await this.discardCreatingTombstoneForDelete(pinned, creatingRoot, expected);
      }

      // A fixed same-parent tombstone is the only durable delete state. It is
      // identity checked and drained first, which also makes a replay after an
      // Agent crash deterministic.
      if (this.pathExists(deletingRoot)) {
        await this.finishDeletionTombstone(pinned, deletingRoot, expected);
      }

      const marker = this.readMarker(root, resourceId);
      if (!marker) {
        if (this.pathExists(resourceRoot)) {
          throw new DataDirIdentityConflictError(`Refusing to delete unmarked DataDir resource ${resourceId}`);
        }
        return;
      }
      this.assertMarker(marker, expected);
      this.ensureRootOnlyDirectory(resourceRoot);
      await this.renameForDeletion(
        pinned,
        resourceRoot,
        deletingRoot,
        resourceId,
        this.resourceFenceKey(expected),
      );
      await this.finishDeletionTombstone(pinned, deletingRoot, expected);
    });
  }

  inspectDir(sourceId: string, resourceId: string): DataDirObservation {
    const source = this.requireSource(sourceId);
    this.assertResourceId(resourceId);
    const dirPath = this.dataPath(source.root, resourceId);
    const marker = this.readMarker(source.root, resourceId);
    try {
      const stat = fs.lstatSync(dirPath);
      return {
        path: dirPath,
        exists: true,
        isDirectory: stat.isDirectory(),
        uid: Number.isSafeInteger(stat.uid) ? stat.uid : null,
        gid: Number.isSafeInteger(stat.gid) ? stat.gid : null,
        resourceId: marker?.resourceId ?? null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (marker) {
          return { path: dirPath, exists: false, isDirectory: false, uid: null, gid: null, resourceId: marker.resourceId };
        }
        return this.inspectDeletionTombstone(source, resourceId, dirPath);
      }
      throw error;
    }
  }

  verifyOwnership(
    sourceId: string,
    uid: number,
    resourceId: string,
    sourceIdentity: string,
  ): Promise<string | null> {
    return this.withPinnedSource(sourceId, sourceIdentity, async ({ source, root }) => {
      const expected = this.expectedMarker(source, resourceId, sourceIdentity);
      const marker = this.readMarker(root, resourceId);
      if (!marker) return this.dataPath(source.root, resourceId);
      this.assertMarker(marker, expected);
      const dirPath = this.dataPath(root, resourceId);
      return this.pathExists(dirPath)
        ? await this.findOwnershipMismatch(dirPath, uid)
        : this.dataPath(source.root, resourceId);
    });
  }

  async withPinnedDir<T>(
    sourceId: string,
    resourceId: string,
    sourceIdentity: string,
    operation: (pinnedPath: string, durablePath: string) => Promise<T>,
  ): Promise<T> {
    return this.withPinnedSource(sourceId, sourceIdentity, async ({ source, root }) => {
      const expected = this.expectedMarker(source, resourceId, sourceIdentity);
      const marker = this.readMarker(root, resourceId);
      if (!marker) throw new DataDirIdentityConflictError(`Data directory marker is missing for ${resourceId}`);
      this.assertMarker(marker, expected);
      const pinnedPath = this.dataPath(root, resourceId);
      const durablePath = this.dataPath(source.root, resourceId);
      if (!this.isDirectoryWithoutSymlink(pinnedPath)) {
        throw new Error(`Data directory is absent or unsafe: ${durablePath}`);
      }
      return operation(pinnedPath, durablePath);
    });
  }

  /** Resolve a Backend resource identity to the only allowed durable bind path. */
  resolveMountPath(sourceId: string, resourceId: string, sourceIdentity: string): Promise<string> {
    return this.withPinnedDir(sourceId, resourceId, sourceIdentity, async (_pinnedPath, durablePath) => durablePath);
  }

  getDiskInfo(sourceId: string): { totalBytes: number; usedBytes: number; pquotaEnabled: boolean; available: boolean } | null {
    const source = this.sources.get(sourceId);
    if (!source || !fs.existsSync(source.root)) return null;
    try {
      const output = execFileSync('df', ['--output=size,used', '-B1', source.root], {
        encoding: 'utf8',
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      });
      const parts = output.trim().split('\n').filter(Boolean).at(-1)?.trim().split(/\s+/) ?? [];
      return {
        totalBytes: Number.parseInt(parts[0], 10),
        usedBytes: Number.parseInt(parts[1], 10),
        pquotaEnabled: source.kind === 'local' && source.quotaEnabled,
        available: true,
      };
    } catch {
      return { totalBytes: 0, usedBytes: 0, pquotaEnabled: false, available: false };
    }
  }

  getLocalDiskInfos(): Array<import('@nyabase/common').DiskInfo> {
    return Array.from(this.sources.values())
      .filter((source): source is DataSource & { kind: 'local' } => source.kind === 'local')
      .map((source) => {
        const info = this.getDiskInfo(source.id);
        return {
          diskId: source.id,
          mountPoint: source.root,
          sourceIdentity: source.identity,
          ...(source.label ? { label: source.label } : {}),
          totalBytes: info?.totalBytes ?? 0,
          usedBytes: info?.usedBytes ?? 0,
          pquotaEnabled: info?.pquotaEnabled ?? false,
        };
      });
  }

  private async withPinnedSource<T>(
    sourceId: string,
    expectedIdentity: string,
    operation: (pinned: PinnedSource) => Promise<T>,
  ): Promise<T> {
    if (this.failStopTriggered) return new Promise<T>(() => { /* process is terminating */ });
    const source = this.requireSource(sourceId);
    const observed = this.inspectSource(sourceId);
    if (!observed.ready || observed.identity !== expectedIdentity || observed.device === null) {
      throw new Error(`Data source identity is unavailable or changed: ${sourceId}`);
    }
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(source.root, flags);
    try {
      const pinnedStat = fs.fstatSync(fd);
      if (!pinnedStat.isDirectory() || String(pinnedStat.dev) !== observed.device) {
        throw new Error(`Data source changed while being pinned: ${sourceId}`);
      }
      const root = `/proc/${process.pid}/fd/${fd}`;
      return await operation({ source, root, fd });
    } finally {
      fs.closeSync(fd);
    }
  }

  private expectedMarker(
    source: DataSource,
    resourceId: string,
    sourceIdentity: string,
  ): DataDirMarker {
    return { version: MARKER_VERSION, resourceId, sourceId: source.id, sourceIdentity };
  }

  private readMarker(root: string, resourceId: string): DataDirMarker | null {
    return this.readMarkerAt(this.resourceRoot(root, resourceId), resourceId);
  }

  private readMarkerAt(resourceRoot: string, resourceId: string): DataDirMarker | null {
    const markerPath = path.join(resourceRoot, 'marker.json');
    let markerStat: fs.Stats;
    try { markerStat = fs.lstatSync(markerPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (
      !markerStat.isFile()
      || markerStat.isSymbolicLink()
      || markerStat.uid !== 0
      || (markerStat.mode & 0o077) !== 0
    ) {
      throw new DataDirIdentityConflictError(`Unsafe DataDir marker for ${resourceId}`);
    }
    let raw: string;
    raw = fs.readFileSync(markerPath, 'utf8');
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new DataDirIdentityConflictError(`Invalid DataDir marker for ${resourceId}`); }
    if (!this.isMarker(value)) throw new DataDirIdentityConflictError(`Invalid DataDir marker for ${resourceId}`);
    return value;
  }

  private inspectDeletionTombstone(
    source: DataSource,
    resourceId: string,
    durablePath: string,
  ): DataDirObservation {
    const deletingRoot = this.deletingRoot(source.root, resourceId);
    if (!this.pathExists(deletingRoot)) {
      return { path: durablePath, exists: false, isDirectory: false, uid: null, gid: null, resourceId: null };
    }
    this.ensureRootOnlyDirectory(deletingRoot);
    const expected = this.expectedMarker(source, resourceId, source.identity);
    const marker = this.readMarkerAt(deletingRoot, resourceId);
    if (marker) this.assertMarker(marker, expected);
    const deletingData = path.join(deletingRoot, 'data');
    try {
      const stat = fs.lstatSync(deletingData);
      return {
        path: durablePath,
        exists: true,
        isDirectory: stat.isDirectory() && !stat.isSymbolicLink(),
        uid: Number.isSafeInteger(stat.uid) ? stat.uid : null,
        gid: Number.isSafeInteger(stat.gid) ? stat.gid : null,
        resourceId,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // marker-last finalization can leave either marker-only or an empty
      // tombstone. Both are observable residue until the root itself is gone.
      return { path: durablePath, exists: false, isDirectory: false, uid: null, gid: null, resourceId };
    }
  }

  private async renameForDeletion(
    pinned: PinnedSource,
    resourceRoot: string,
    deletingRoot: string,
    resourceId: string,
    childFence: string,
  ): Promise<void> {
    let renameError: unknown = null;
    try {
      await this.runPinnedChildWithDeadline(
        pinned,
        'mv',
        [
          '--no-target-directory',
          '--',
          this.childPath(pinned, resourceRoot),
          this.childPath(pinned, deletingRoot),
        ],
        `rename-for-delete(${resourceId})`,
        childFence,
      );
    } catch (error) {
      renameError = error;
    }

    let sourceExists: boolean;
    let tombstoneExists: boolean;
    try {
      sourceExists = this.pathExists(resourceRoot);
      tombstoneExists = this.pathExists(deletingRoot);
    } catch (error) {
      throw new DataDirOperationIncompleteError(
        `Could not observe atomic delete rename for ${resourceId}: ${this.errorMessage(error)}`,
        `rename-for-delete(${resourceId})`,
      );
    }
    if (!sourceExists && tombstoneExists) return;
    throw new DataDirOperationIncompleteError(
      `Atomic delete rename did not converge for ${resourceId}${renameError ? `: ${this.errorMessage(renameError)}` : ''}`,
      `rename-for-delete(${resourceId})`,
    );
  }

  private async finishDeletionTombstone(
    pinned: PinnedSource,
    deletingRoot: string,
    expected: DataDirMarker,
  ): Promise<void> {
    if (!this.pathExists(deletingRoot)) return;
    try {
      await this.finishDeletionTombstoneUnsafe(pinned, deletingRoot, expected);
    } catch (error) {
      let stillExists: boolean;
      try {
        stillExists = this.pathExists(deletingRoot);
      } catch (observationError) {
        throw new DataDirOperationIncompleteError(
          `Could not observe delete tombstone for ${expected.resourceId}: ${this.errorMessage(observationError)}`,
          `inspect-delete-tombstone(${expected.resourceId})`,
        );
      }
      // A previously timed-out rm may finish between probes. Absence is the
      // authoritative desired state and is safe to roll forward.
      if (!stillExists) return;
      if (error instanceof DataDirIdentityConflictError || error instanceof DataDirOperationIncompleteError) {
        throw error;
      }
      throw new DataDirOperationIncompleteError(
        `Could not finish delete tombstone for ${expected.resourceId}: ${this.errorMessage(error)}`,
        `finalize-delete(${expected.resourceId})`,
      );
    }
  }

  private async finishDeletionTombstoneUnsafe(
    pinned: PinnedSource,
    deletingRoot: string,
    expected: DataDirMarker,
  ): Promise<void> {
    const childFence = this.resourceFenceKey(expected);
    this.ensureRootOnlyDirectory(deletingRoot);
    const marker = this.readMarkerAt(deletingRoot, expected.resourceId);
    const children = await this.withObservationDeadline(
      fs.promises.readdir(deletingRoot),
      `inspect-delete-tombstone(${expected.resourceId})`,
    );
    if (!marker) {
      if (children.length !== 0) {
        throw new DataDirIdentityConflictError(
          `Refusing to resume unmarked non-empty delete tombstone for ${expected.resourceId}`,
        );
      }
      await this.removeTree(
        pinned,
        deletingRoot,
        `finalize-delete(${expected.resourceId})`,
        childFence,
      );
      return;
    }
    this.assertMarker(marker, expected);
    if (children.some((entry) => entry !== 'marker.json' && entry !== 'data')) {
      throw new DataDirIdentityConflictError(
        `Delete tombstone for ${expected.resourceId} contains unmanaged entries`,
      );
    }

    const deletingData = path.join(deletingRoot, 'data');
    if (this.pathExists(deletingData)) {
      if (!this.isDirectoryWithoutSymlink(deletingData)) {
        throw new DataDirIdentityConflictError(
          `Delete tombstone data is not a safe directory for ${expected.resourceId}`,
        );
      }
      // Delete user-owned data first. marker.json remains root-owned and
      // identity-bearing across every crash/timeout in this recursive phase.
      await this.removeTree(
        pinned,
        deletingData,
        `remove-data(${expected.resourceId})`,
        childFence,
      );
    }
    await this.removeTree(
      pinned,
      deletingRoot,
      `finalize-delete(${expected.resourceId})`,
      childFence,
    );
  }

  private async discardCreatingTombstoneForDelete(
    pinned: PinnedSource,
    creatingRoot: string,
    expected: DataDirMarker,
  ): Promise<void> {
    try {
      this.ensureRootOnlyDirectory(creatingRoot);
    } catch (error) {
      throw new DataDirIdentityConflictError(
        `Create tombstone root is unsafe for ${expected.resourceId}: ${this.errorMessage(error)}`,
      );
    }
    const marker = this.readMarkerAt(creatingRoot, expected.resourceId);
    const children = await this.withObservationDeadline(
      fs.promises.readdir(creatingRoot),
      `inspect-create-tombstone-for-delete(${expected.resourceId})`,
    );

    if (marker) {
      this.assertMarker(marker, expected);
      if (children.some((entry) => entry !== 'marker.json' && entry !== 'data')) {
        throw new DataDirIdentityConflictError(
          `Create tombstone for ${expected.resourceId} contains unmanaged entries`,
        );
      }
    } else {
      this.assertControlledUnmarkedCreatingTombstone(
        creatingRoot,
        expected.resourceId,
        children,
      );
    }
    this.assertSafeStagedData(creatingRoot, expected.resourceId);
    await this.removeTree(
      pinned,
      creatingRoot,
      `discard-create-for-delete(${expected.resourceId})`,
      this.resourceFenceKey(expected),
    );
  }

  private async createResourceTree(pinned: PinnedSource, marker: DataDirMarker): Promise<void> {
    const { root } = pinned;
    const creatingRoot = this.creatingRoot(root, marker.resourceId);
    const childFence = this.resourceFenceKey(marker);
    if (this.pathExists(creatingRoot)) {
      this.ensureRootOnlyDirectory(creatingRoot);
      const existingMarker = this.readMarkerAt(creatingRoot, marker.resourceId);
      if (!existingMarker) {
        // The fixed staging path is root-only and was never published. A crash
        // before the atomic marker write may leave data/.marker.tmp here; it is
        // safe to discard and rebuild, unlike an identity-bearing resource.
        const children = await this.withObservationDeadline(
          fs.promises.readdir(creatingRoot),
          `inspect-unpublished-create(${marker.resourceId})`,
        );
        this.assertControlledUnmarkedCreatingTombstone(
          creatingRoot,
          marker.resourceId,
          children,
        );
        this.assertSafeStagedData(creatingRoot, marker.resourceId);
        await this.removeTree(
          pinned,
          creatingRoot,
          `discard-unpublished-create(${marker.resourceId})`,
          childFence,
        );
      } else {
        this.assertMarker(existingMarker, marker);
        const children = await this.withObservationDeadline(
          fs.promises.readdir(creatingRoot),
          `inspect-create-tombstone(${marker.resourceId})`,
        );
        if (children.some((entry) => entry !== 'marker.json' && entry !== 'data')) {
          throw new DataDirIdentityConflictError(
            `Create tombstone for ${marker.resourceId} contains unmanaged entries`,
          );
        }
        const stagedData = path.join(creatingRoot, 'data');
        if (!this.pathExists(stagedData)) fs.mkdirSync(stagedData, { mode: 0o700 });
        if (!this.isDirectoryWithoutSymlink(stagedData)) {
          throw new DataDirIdentityConflictError(
            `Create tombstone data is not a safe directory for ${marker.resourceId}`,
          );
        }
      }
    }

    if (!this.pathExists(creatingRoot)) {
      fs.mkdirSync(creatingRoot, { mode: 0o700 });
      fs.mkdirSync(path.join(creatingRoot, 'data'), { mode: 0o700 });
      const markerTemporary = path.join(creatingRoot, '.marker.tmp');
      fs.writeFileSync(markerTemporary, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(markerTemporary, path.join(creatingRoot, 'marker.json'));
    }
    await this.publishCreatingTree(pinned, creatingRoot, marker);
  }

  private assertControlledUnmarkedCreatingTombstone(
    creatingRoot: string,
    resourceId: string,
    children: readonly string[],
  ): void {
    // Before marker.json is atomically published, create can only have made
    // these two root-owned entries. Never adopt an arbitrary unmarked tree.
    if (children.some((entry) => entry !== 'data' && entry !== '.marker.tmp')) {
      throw new DataDirIdentityConflictError(
        `Unmarked create tombstone for ${resourceId} contains unmanaged entries`,
      );
    }
    const temporaryMarker = path.join(creatingRoot, '.marker.tmp');
    if (!this.pathExists(temporaryMarker)) return;
    const stat = fs.lstatSync(temporaryMarker);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.uid !== 0
      || (stat.mode & 0o077) !== 0
    ) {
      throw new DataDirIdentityConflictError(
        `Unmarked create tombstone for ${resourceId} has unsafe temporary metadata`,
      );
    }
  }

  private assertSafeStagedData(creatingRoot: string, resourceId: string): void {
    const stagedData = path.join(creatingRoot, 'data');
    if (!this.pathExists(stagedData)) return;
    try {
      this.ensureRootOnlyDirectory(stagedData);
    } catch (error) {
      throw new DataDirIdentityConflictError(
        `Create tombstone data is unsafe for ${resourceId}: ${this.errorMessage(error)}`,
      );
    }
  }

  private async publishCreatingTree(
    pinned: PinnedSource,
    creatingRoot: string,
    marker: DataDirMarker,
  ): Promise<void> {
    const { root } = pinned;
    const resourceRoot = this.resourceRoot(root, marker.resourceId);
    let publishError: unknown = null;
    try {
      await this.runPinnedChildWithDeadline(
        pinned,
        'mv',
        [
          '--no-target-directory',
          '--',
          this.childPath(pinned, creatingRoot),
          this.childPath(pinned, resourceRoot),
        ],
        `publish-create(${marker.resourceId})`,
        this.resourceFenceKey(marker),
      );
    } catch (error) {
      publishError = error;
    }
    let staged: boolean;
    let published: boolean;
    try {
      staged = this.pathExists(creatingRoot);
      published = this.pathExists(resourceRoot);
    } catch (error) {
      throw new DataDirOperationIncompleteError(
        `Could not observe create publication for ${marker.resourceId}: ${this.errorMessage(error)}`,
        `publish-create(${marker.resourceId})`,
      );
    }
    if (!staged && published) {
      const publishedMarker = this.readMarker(root, marker.resourceId);
      if (!publishedMarker) {
        throw new DataDirOperationIncompleteError(
          `Published DataDir ${marker.resourceId} has no identity marker`,
          `publish-create(${marker.resourceId})`,
        );
      }
      this.assertMarker(publishedMarker, marker);
      return;
    }
    throw new DataDirOperationIncompleteError(
      `Create publication did not converge for ${marker.resourceId}${publishError ? `: ${this.errorMessage(publishError)}` : ''}`,
      `publish-create(${marker.resourceId})`,
    );
  }

  private ensureMetadataRoots(root: string): void {
    const metaRoot = path.join(root, META_DIR);
    this.ensureRootOnlyDirectory(metaRoot, true);
    this.ensureRootOnlyDirectory(this.dirsRoot(root), true);
  }

  private ensureRootOnlyDirectory(target: string, create = false): void {
    try {
      if (create) fs.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) {
      throw new Error(`Unsafe root-owned DataDir directory: ${target}`);
    }
  }

  private assertMarker(actual: DataDirMarker, expected: DataDirMarker): void {
    if (
      actual.version !== expected.version
      || actual.resourceId !== expected.resourceId
      || actual.sourceId !== expected.sourceId
      || actual.sourceIdentity !== expected.sourceIdentity
    ) {
      throw new DataDirIdentityConflictError(`Data directory marker does not match resource ${expected.resourceId}`);
    }
  }

  private isMarker(value: unknown): value is DataDirMarker {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const marker = value as Record<string, unknown>;
    return marker.version === MARKER_VERSION
      && typeof marker.resourceId === 'string'
      && typeof marker.sourceId === 'string'
      && typeof marker.sourceIdentity === 'string';
  }

  private async findOwnershipMismatch(root: string, uid: number): Promise<string | null> {
    try {
      return await this.findOwnershipMismatchUnsafe(root, uid);
    } catch (error) {
      if (error instanceof DataDirOperationIncompleteError) throw error;
      throw new DataDirOperationIncompleteError(
        `Ownership observation failed at ${root}: ${this.errorMessage(error)}`,
        'ownership-observation',
      );
    }
  }

  private async findOwnershipMismatchUnsafe(root: string, uid: number): Promise<string | null> {
    const deadline = Date.now() + this.ownershipObservationTimeoutMs;
    const pending = [root];
    let entries = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      entries += 1;
      if (entries > this.ownershipObservationEntryCap) {
        throw new DataDirOperationIncompleteError(
          `Ownership observation exceeded ${this.ownershipObservationEntryCap} entries at ${root}`,
          'ownership-observation',
        );
      }
      const stat = await this.withOwnershipDeadline(
        fs.promises.lstat(current),
        deadline,
        root,
      );
      if (stat.uid !== uid || stat.gid !== uid) return current;
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const directory = await this.withOwnershipDeadline(
        fs.promises.opendir(current),
        deadline,
        root,
      );
      try {
        while (true) {
          const child = await this.withOwnershipDeadline(directory.read(), deadline, root);
          if (!child) break;
          if (entries + pending.length >= this.ownershipObservationEntryCap) {
            throw new DataDirOperationIncompleteError(
              `Ownership observation exceeded ${this.ownershipObservationEntryCap} entries at ${root}`,
              'ownership-observation',
            );
          }
          pending.push(path.join(current, child.name));
        }
      } finally {
        try {
          await this.withOwnershipDeadline(directory.close(), deadline, root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
        }
      }
    }
    return null;
  }

  private withOwnershipDeadline<T>(promise: Promise<T>, deadline: number, root: string): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.triggerMutationFailStop(new DataDirMutationDeadlineError(
        `ownership-observation(${root})`,
        this.ownershipObservationTimeoutMs,
      ));
      return new Promise<T>(() => { /* process is terminating */ });
    }
    return new Promise<T>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.triggerMutationFailStop(new DataDirMutationDeadlineError(
          `ownership-observation(${root})`,
          this.ownershipObservationTimeoutMs,
        ));
      }, remaining);
      timer.unref();
      promise.then(
        (value) => {
          if (timedOut) return;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (timedOut) return;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * A timed-out libuv filesystem request may still retain a remote inode. It
   * therefore poisons the manager exactly like a mutation child deadline; the
   * original observation remains pending until the Agent is replaced.
   */
  private withObservationDeadline<T>(promise: Promise<T>, operation: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.triggerMutationFailStop(new DataDirMutationDeadlineError(
          operation,
          this.mutationTimeoutMs,
        ));
      }, this.mutationTimeoutMs);
      timer.unref();
      promise.then(
        (value) => {
          if (timedOut) return;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (timedOut) return;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async removeTree(
    pinned: PinnedSource,
    target: string,
    operation: string,
    childFence = operation,
  ): Promise<void> {
    let removeError: unknown = null;
    try {
      await this.runPinnedChildWithDeadline(
        pinned,
        'rm',
        [
          '--recursive',
          '--force',
          '--one-file-system',
          '--preserve-root=all',
          '--',
          this.childPath(pinned, target),
        ],
        operation,
        childFence,
      );
    } catch (error) {
      removeError = error;
    }
    let exists: boolean;
    try {
      exists = this.pathExists(target);
    } catch (error) {
      throw new DataDirOperationIncompleteError(
        `Could not observe ${target} after ${operation}: ${this.errorMessage(error)}`,
        operation,
      );
    }
    // A timed-out child can have unlinked the visible name while still holding
    // and mutating the tree. A deadline therefore never reaches this branch;
    // only a settled child error can be reconciled against observed absence.
    if (!exists && removeError instanceof DataDirOperationIncompleteError) throw removeError;
    if (!exists) return;
    throw new DataDirOperationIncompleteError(
      `Data directory tree still exists after ${operation}: ${target}${removeError ? `: ${this.errorMessage(removeError)}` : ''}`,
      operation,
    );
  }

  private runPinnedChildWithDeadline(
    pinned: PinnedSource,
    file: string,
    args: readonly string[],
    operation: string,
    childFence = operation,
  ): Promise<void> {
    if (this.failStopTriggered) {
      return new Promise<void>(() => { /* process is terminating */ });
    }
    const absoluteArgs = args.filter((arg) => path.isAbsolute(arg));
    if (
      absoluteArgs.length === 0
      || absoluteArgs.some((arg) => arg !== CHILD_SOURCE_ROOT && !arg.startsWith(`${CHILD_SOURCE_ROOT}/`))
    ) {
      throw new Error(`${operation} must address the source only through ${CHILD_SOURCE_ROOT}`);
    }
    if (this.activeChildren.has(childFence)) {
      return Promise.reject(new DataDirOperationIncompleteError(
        `${operation} is fenced by a child process whose exit is not yet observable`,
        operation,
      ));
    }
    if (this.activeChildren.size >= this.childProcessCap) {
      return Promise.reject(new DataDirOperationIncompleteError(
        `${operation} cannot start: ${this.childProcessCap} DataDir child processes are still active`,
        operation,
      ));
    }

    const record: ActiveDataDirChild = { child: null };
    // Register before spawn because tests and alternate implementations may
    // emit an error immediately.
    this.activeChildren.set(childFence, record);
    return new Promise<void>((resolve, reject) => {
      let claimed = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (error?: Error | null) => {
        if (this.activeChildren.get(childFence) === record) {
          this.activeChildren.delete(childFence);
        }
        if (claimed) return;
        claimed = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => {
        if (claimed) return;
        claimed = true;
        // SIGKILL is best-effort: a D-state process can retain fd 3 and finish
        // later. Fail-stop the Agent and never settle the original task call.
        this.killDataDirProcessGroup(record.child);
        this.triggerMutationFailStop(new DataDirMutationDeadlineError(
          operation,
          this.mutationTimeoutMs,
        ));
      }, this.mutationTimeoutMs);
      timer.unref();
      try {
        const child = spawnPinnedSourceMutation(
          file,
          args,
          pinned.fd,
          this.physicalMutationLockPath,
        );
        record.child = child;
        child.once('error', (error) => {
          if (child.pid === undefined) {
            finish(error);
            return;
          }
          if (claimed) return;
          claimed = true;
          if (timer) clearTimeout(timer);
          this.killDataDirProcessGroup(child);
          this.triggerMutationFailStop(new DataDirMutationDeadlineError(
            `${operation}: process transport failed after spawn (${error.message})`,
            this.mutationTimeoutMs,
          ));
        });
        child.once('close', (code, signal) => {
          if (this.isDataDirProcessGroupAlive(child.pid)) {
            if (claimed) return;
            claimed = true;
            if (timer) clearTimeout(timer);
            this.killDataDirProcessGroup(child);
            this.triggerMutationFailStop(new DataDirMutationDeadlineError(
              `${operation}: leader closed while a descendant retained the process group`,
              this.mutationTimeoutMs,
            ));
            return;
          }
          if (code === 0) {
            finish();
            return;
          }
          if (code === PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE) {
            finish(new PhysicalMutationFenceBusyError(file));
            return;
          }
          finish(new Error(
            `${operation} child exited ${signal ? `with signal ${signal}` : `with code ${String(code)}`}`,
          ));
        });
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  private isDataDirProcessGroupAlive(pid: number | undefined): boolean {
    if (pid === undefined) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private killDataDirProcessGroup(child: ChildProcess | null): void {
    if (!child) return;
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGKILL');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      }
    }
    try { child.kill('SIGKILL'); } catch { /* process already exited */ }
  }

  private triggerMutationFailStop(error: DataDirMutationDeadlineError): void {
    if (this.failStopTriggered) return;
    this.failStopTriggered = true;
    try {
      this.fatalHook(error);
    } catch (fatalError) {
      console.error('[DataDir] Injected fatal hook failed; forcing SIGKILL', fatalError);
      killAgentAfterAmbiguousDataDirMutation(error);
    }
  }

  private childPath(pinned: PinnedSource, target: string): string {
    const relative = path.relative(pinned.root, target);
    if (relative === '') return CHILD_SOURCE_ROOT;
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`DataDir mutation path escapes pinned source: ${target}`);
    }
    return path.join(CHILD_SOURCE_ROOT, relative);
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private dataPath(root: string, resourceId: string): string {
    this.assertResourceId(resourceId);
    return path.join(this.resourceRoot(root, resourceId), 'data');
  }

  private resourceRoot(root: string, resourceId: string): string {
    this.assertResourceId(resourceId);
    return path.join(this.dirsRoot(root), resourceId);
  }

  private deletingRoot(root: string, resourceId: string): string {
    this.assertResourceId(resourceId);
    return path.join(this.dirsRoot(root), `.deleting-${resourceId}`);
  }

  private creatingRoot(root: string, resourceId: string): string {
    this.assertResourceId(resourceId);
    return path.join(this.dirsRoot(root), `.creating-${resourceId}`);
  }

  private resourceFenceKey(marker: DataDirMarker): string {
    return JSON.stringify([marker.sourceIdentity, marker.sourceId, marker.resourceId]);
  }

  private dirsRoot(root: string): string {
    return path.join(root, META_DIR, DIRS_DIR);
  }

  private assertResourceId(resourceId: string): void {
    if (!zTaskId.safeParse(resourceId).success) throw new Error(`Invalid DataDir resource id: ${resourceId}`);
  }

  private pathExists(filePath: string): boolean {
    try { fs.lstatSync(filePath); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private isDirectoryWithoutSymlink(filePath: string): boolean {
    try {
      const stat = fs.lstatSync(filePath);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private isSafeRootDirectory(filePath: string): boolean {
    try {
      const stat = fs.lstatSync(filePath);
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o077) === 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private requireSource(sourceId: string): DataSource {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`Unknown source: ${sourceId}`);
    return source;
  }

  private missingSourceObservation(sourceId: string): DataSourceObservation {
    return {
      sourceId,
      kind: null,
      root: null,
      identity: null,
      configured: false,
      exists: false,
      isDirectory: false,
      mounted: false,
      fsType: null,
      ready: false,
      device: null,
    };
  }
}
