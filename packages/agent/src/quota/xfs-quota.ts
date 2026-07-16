import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_AGENT_XFS_PROJECTS,
  XFS_PROJECT_ID_MAX,
  XFS_PROJECT_ID_OFFSET,
  normalizeXfsQuotaBytes,
} from '@nyabase/common';
import {
  PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE,
  PHYSICAL_MUTATION_LOCK_PATH,
  PhysicalMutationFenceBusyError,
  fencePhysicalMutationCommand,
} from '../physical-mutation-fence.js';

export { normalizeXfsQuotaBytes } from '@nyabase/common';

/**
 * XFS project IDs are computed as: numericUserId + XFS_PROJECT_ID_OFFSET.
 * The offset matches the old nextProjectId starting value (10000) so that
 * numeric user IDs starting from 1 yield project IDs starting from 10001.
 */
const XFS_QUOTA_BLOCK_BYTES = 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_QUEUE_CAP = 32;
const CHILD_SOURCE_FD = 3;
const CHILD_SOURCE_ROOT = `/proc/self/fd/${CHILD_SOURCE_FD}`;

type XfsCommandMode = 'mutation' | 'observation';

interface XfsCommandResult {
  stdout: string;
  stderr: string;
}

export interface XfsQuotaManagerOptions {
  commandTimeoutMs?: number;
  commandOutputLimitBytes?: number;
  commandQueueCap?: number;
  physicalMutationLockPath?: string;
  /** Production sends SIGKILL; tests inject a recorder that deliberately returns. */
  fatalHook?: (error: XfsCommandAmbiguityError) => void;
  /** Test seam. Production always uses child_process.spawn. */
  spawnProcess?: typeof spawn;
}

export class XfsCommandAmbiguityError extends Error {
  readonly ambiguous = true;

  constructor(
    readonly operation: string,
    readonly mode: XfsCommandMode,
    readonly reason: string,
  ) {
    super(`XFS ${mode} command became ambiguous during ${operation}: ${reason}`);
    this.name = 'XfsCommandAmbiguityError';
  }
}

function killAgentAfterAmbiguousXfsCommand(error: XfsCommandAmbiguityError): void {
  console.error(`[XFS] ${error.message}; terminating Agent to prevent overlapping quota work`);
  process.kill(process.pid, 'SIGKILL');
}

/**
 * Spawn an XFS helper with the verified source descriptor owned by the child.
 * The child always refers to it as /proc/self/fd/3, so reuse of the same fd
 * number in the Agent can never retarget a late syscall.
 */
export function spawnPinnedXfsCommand(
  file: string,
  args: readonly string[],
  sourceFd: number,
  lockPath = PHYSICAL_MUTATION_LOCK_PATH,
): ChildProcess {
  const fenced = fencePhysicalMutationCommand(file, args, lockPath);
  return spawn(fenced.executable, fenced.args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', sourceFd],
  });
}
export interface QuotaUsage {
  numericUserId: number;
  projectId: number;
  usedBytes: number;
  hardLimitBytes: number;
}

export interface ProjectQuotaCapability {
  accounting: boolean;
  enforcement: boolean;
  output: string;
}

export interface ProjectPathObservation {
  path: string;
  expectedProjectId: number;
  registered: boolean;
  reportedProjectId: number | null;
  inheritance: boolean;
  quotaPresent: boolean;
  assigned: boolean;
}

export interface ExactProjectPathRegistration {
  path: string;
  projectId: number | null;
}

type ExecError = Error & {
  code?: unknown;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export class XfsQuotaManager {
  private readonly quotaRoots: string[];
  private readonly commandTimeoutMs: number;
  private readonly commandOutputLimitBytes: number;
  private readonly fatalHook: (error: XfsCommandAmbiguityError) => void;
  private readonly spawnProcess: typeof spawn;
  private readonly physicalMutationLockPath: string;
  private commandTail: Promise<void> = Promise.resolve();
  private readonly commandQueueCap: number;
  private pendingCommands = 0;
  private poisoned = false;

  constructor(
    private xfsMount: string,
    additionalXfsRoots: string[] = [],
    options: XfsQuotaManagerOptions = {},
  ) {
    this.quotaRoots = [...new Set([xfsMount, ...additionalXfsRoots].map((root) => path.resolve(root)))];
    this.commandTimeoutMs = this.positiveInteger(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    this.commandOutputLimitBytes = this.positiveInteger(
      options.commandOutputLimitBytes,
      DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES,
    );
    this.commandQueueCap = this.positiveInteger(
      options.commandQueueCap,
      DEFAULT_COMMAND_QUEUE_CAP,
    );
    this.fatalHook = options.fatalHook ?? killAgentAfterAmbiguousXfsCommand;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.physicalMutationLockPath = options.physicalMutationLockPath ?? PHYSICAL_MUTATION_LOCK_PATH;
  }

  private toProjectId(numericUserId: number): number {
    if (
      !Number.isSafeInteger(numericUserId)
      || numericUserId <= 0
      || numericUserId > XFS_PROJECT_ID_MAX - XFS_PROJECT_ID_OFFSET
    ) {
      throw new Error(`[XFS] Invalid numeric user ID ${String(numericUserId)}`);
    }
    return numericUserId + XFS_PROJECT_ID_OFFSET;
  }

  projectIdForUser(numericUserId: number): number {
    return this.toProjectId(numericUserId);
  }

  /**
   * Ensure the XFS project for a user exists and is initialised.
   * This is idempotent: re-running is safe on an already-configured project.
   */
  async ensureProjectForUser(numericUserId: number): Promise<number> {
    const projectId = this.toProjectId(numericUserId);
    for (const quotaMount of this.getQuotaCommandTargets()) {
      await this.assertProjectQuotaEnforcementOnMount(quotaMount, quotaMount);
      if (this.getRegisteredProjectPaths(projectId).some((registered) => this.isPathOnMount(registered, quotaMount))) {
        await this.initProject(projectId, quotaMount);
      }
    }
    return projectId;
  }

  private async initProject(projectId: number, quotaMount: string): Promise<void> {
    await this.runXfsQuota(
      `project -s ${projectId}`,
      quotaMount,
      `initialize project ${projectId}`,
      'mutation',
    );
  }

  async addPathToProject(
    numericUserId: number,
    dirPath: string,
    durablePath = dirPath,
  ): Promise<void> {
    const projectId = this.toProjectId(numericUserId);
    this.assertProjectPathSafe(dirPath);
    const quotaMount = this.getQuotaCommandTarget(dirPath);
    await this.assertProjectQuotaEnforcementOnMount(dirPath, quotaMount);
    const pinned = this.preparePinnedPath(dirPath);

    // Register the path in /etc/projects so xfs_quota can find it.
    this.assertProjectPathSafe(durablePath);
    this.appendLineIfMissing('/etc/projects', `${projectId}:${durablePath}`);

    // project -s -p both adds the path AND re-initialises the project in one step.
    await this.runXfsQuota(
      `project -s -p ${this.quoteXfsArg(pinned.childPath)} ${projectId}`,
      quotaMount,
      `assign path ${dirPath} to project ${projectId}`,
      'mutation',
      pinned.sourceFd,
    );

    await this.verifyPathAssignedToProject(projectId, dirPath, quotaMount, durablePath);
  }

  async isPathAssignedToProject(numericUserId: number, dirPath: string): Promise<boolean> {
    try {
      const projectId = this.toProjectId(numericUserId);
      const quotaMount = this.getQuotaCommandTarget(dirPath);
      await this.verifyPathAssignedToProject(projectId, dirPath, quotaMount);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Observe an assignment without collapsing command failures into `false`.
   * Callers can therefore retry unavailable tooling, while treating a fully
   * observed mismatch as a terminal managed-resource failure.
   */
  async inspectPathAssignment(
    numericUserId: number,
    dirPath: string,
    durablePath = dirPath,
  ): Promise<ProjectPathObservation> {
    const expectedProjectId = this.toProjectId(numericUserId);
    this.assertProjectPathSafe(dirPath);
    const quotaMount = this.getQuotaCommandTarget(dirPath);
    const stat = await this.runXfsIo('stat', dirPath, `read project metadata for ${dirPath}`);
    const reportedProjectId = this.extractProjectId(stat.stdout);
    const inheritance = this.hasProjectInheritanceFlag(stat.stdout);
    const quotaPresent = Boolean(await this.getUsageForProject(expectedProjectId, quotaMount));
    this.assertProjectPathSafe(durablePath);
    const registered = this.getRegisteredProjectPaths(expectedProjectId).includes(durablePath);
    return {
      path: durablePath,
      expectedProjectId,
      registered,
      reportedProjectId,
      inheritance,
      quotaPresent,
      assigned: registered && reportedProjectId === expectedProjectId && inheritance && quotaPresent,
    };
  }

  /** Remove the durable path registration after its inode has been deleted. */
  removePathFromProject(numericUserId: number, dirPath: string): void {
    if (this.poisoned) {
      throw new Error('[XFS] Quota manager is poisoned by an ambiguous command');
    }
    const projectId = this.toProjectId(numericUserId);
    const target = `${projectId}:${dirPath}`;
    this.assertProjectPathSafe(dirPath);
    if (!fs.existsSync('/etc/projects')) return;
    try {
      const existing = fs.readFileSync('/etc/projects', 'utf-8');
      const lines = existing.split('\n');
      const filtered = lines.filter((line) => line !== target);
      if (filtered.length === lines.length) return;
      this.atomicWriteFile('/etc/projects', filtered.join('\n'));
    } catch (err) {
      throw new Error(`[XFS] Failed to remove path ${dirPath} from /etc/projects: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  isPathRegisteredToProject(numericUserId: number, dirPath: string): boolean {
    const projectId = this.toProjectId(numericUserId);
    this.assertProjectPathSafe(dirPath);
    return this.getRegisteredProjectPaths(projectId).includes(dirPath);
  }

  /**
   * Read one exact durable path registration without guessing its owner.
   * Duplicate, malformed, or non-Nyabase registrations are deliberately
   * rejected so a cleanup task cannot erase ambiguous external state.
   */
  inspectExactPathRegistration(dirPath: string): ExactProjectPathRegistration {
    const registration = this.readExactPathRegistration(dirPath);
    return { path: dirPath, projectId: registration?.projectId ?? null };
  }

  /** Remove one unambiguous Nyabase registration by exact path. */
  removeExactPathRegistration(dirPath: string): ExactProjectPathRegistration {
    if (this.poisoned) {
      throw new Error('[XFS] Quota manager is poisoned by an ambiguous command');
    }
    const registration = this.readExactPathRegistration(dirPath);
    if (!registration) return { path: dirPath, projectId: null };
    try {
      const filtered = registration.lines.filter((_line, index) => index !== registration.lineIndex);
      this.atomicWriteFile('/etc/projects', filtered.join('\n'));
      return { path: dirPath, projectId: registration.projectId };
    } catch (error) {
      throw new Error(
        `[XFS] Failed to remove exact path ${dirPath} from /etc/projects: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async setLimit(numericUserId: number, hardLimitBytes: number): Promise<void> {
    const projectId = await this.ensureProjectForUser(numericUserId);
    // xfs_quota report -b shows values in 1K (KiB) blocks.
    const expectedHardLimitBytes = normalizeXfsQuotaBytes(hardLimitBytes);
    const limitKiB = expectedHardLimitBytes / XFS_QUOTA_BLOCK_BYTES;
    for (const quotaMount of this.getQuotaCommandTargets()) {
      await this.runXfsQuota(
        `limit -p bhard=${limitKiB}k ${projectId}`,
        quotaMount,
        `set hard limit ${limitKiB} KiB for project ${projectId} on ${quotaMount}`,
        'mutation',
      );

      const usage = await this.getUsageForProject(projectId, quotaMount);
      if (!usage) {
        throw new Error(`[XFS] Project ${projectId} is missing from quota report after limit application on ${quotaMount}`);
      }
      if (usage.hardLimitBytes !== expectedHardLimitBytes) {
        throw new Error(
          `[XFS] Project ${projectId} hard limit mismatch on ${quotaMount}: expected ${expectedHardLimitBytes} bytes, reported ${usage.hardLimitBytes} bytes`,
        );
      }
    }
  }

  async checkProjectQuotaEnforcement(pathOrMount = this.xfsMount): Promise<ProjectQuotaCapability> {
    const quotaMount = this.getQuotaCommandTarget(pathOrMount);
    return this.checkProjectQuotaEnforcementOnMount(quotaMount);
  }

  /** Tool self-checks share the same bounded, fail-stop command lane. */
  async checkToolAvailable(): Promise<void> {
    await this.runCommand(
      'xfs_quota',
      ['-V'],
      'check xfs_quota availability',
      'observation',
    );
  }

  private async checkProjectQuotaEnforcementOnMount(
    quotaMount: string,
  ): Promise<ProjectQuotaCapability> {
    const { stdout, stderr } = await this.runXfsQuota(
      'state -p',
      quotaMount,
      `check project quota state for ${quotaMount}`,
    );
    const output = `${stdout}\n${stderr}`.trim();
    const accounting = this.extractQuotaState(output, 'Accounting');
    const enforcement = this.extractQuotaState(output, 'Enforcement');
    return {
      accounting: accounting === true,
      enforcement: enforcement === true,
      output,
    };
  }

  async assertProjectQuotaEnforcement(pathOrMount = this.xfsMount): Promise<void> {
    const quotaMount = this.getQuotaCommandTarget(pathOrMount);
    await this.assertProjectQuotaEnforcementOnMount(pathOrMount, quotaMount);
  }

  private async assertProjectQuotaEnforcementOnMount(pathOrMount: string, quotaMount: string): Promise<void> {
    const capability = await this.checkProjectQuotaEnforcementOnMount(quotaMount);
    if (!capability.accounting || !capability.enforcement) {
      const status = `accounting=${capability.accounting ? 'on' : 'off'}, enforcement=${capability.enforcement ? 'on' : 'off'}`;
      throw new Error(
        `[XFS] Project quota is not enforcing on ${quotaMount} for ${pathOrMount} (${status})${capability.output ? `: ${capability.output}` : ''}`,
      );
    }
  }

  async getAllUsages(): Promise<QuotaUsage[]> {
    const byProject = new Map<number, QuotaUsage>();
    for (const quotaMount of this.getQuotaCommandTargets()) {
      const { stdout } = await this.runXfsQuota(
        'report -N -p -b -n',
        quotaMount,
        `read project quota report on ${quotaMount}`,
      );
      for (const usage of this.parseQuotaReport(stdout, quotaMount)) {
        const current = byProject.get(usage.projectId);
        if (!current) byProject.set(usage.projectId, usage);
        else {
          byProject.set(usage.projectId, {
            ...current,
            usedBytes: current.usedBytes + usage.usedBytes,
            hardLimitBytes: Math.min(current.hardLimitBytes, usage.hardLimitBytes),
          });
        }
      }
    }
    if (byProject.size > MAX_AGENT_XFS_PROJECTS) {
      throw new Error(
        `[XFS] Project inventory exceeds the protocol limit of ${MAX_AGENT_XFS_PROJECTS}`,
      );
    }
    return [...byProject.values()];
  }

  /** Read one user's quota without hiding command or parse failures. */
  async getUsageForUser(numericUserId: number): Promise<QuotaUsage | null> {
    const projectId = this.toProjectId(numericUserId);
    const usages: QuotaUsage[] = [];
    for (const quotaMount of this.getQuotaCommandTargets()) {
      const usage = await this.getUsageForProject(projectId, quotaMount);
      if (!usage) return null;
      usages.push(usage);
    }
    if (usages.length === 0) return null;
    const hardLimitBytes = usages[0].hardLimitBytes;
    if (usages.some((usage) => usage.hardLimitBytes !== hardLimitBytes)) {
      throw new Error(`[XFS] Project ${projectId} hard limit differs across configured XFS sources`);
    }
    return {
      ...usages[0],
      usedBytes: usages.reduce((sum, usage) => sum + usage.usedBytes, 0),
    };
  }

  private getQuotaCommandTargets(): string[] {
    const mounts = this.readMountRecords();
    const byFilesystem = new Map<string, string>();
    for (const root of this.quotaRoots) {
      const target = this.findContainingMount(this.normalizePathForMountLookup(root), mounts);
      if (!target) throw new Error(`[XFS] Failed to find containing mount for ${root}`);
      if (!byFilesystem.has(target.deviceId)) byFilesystem.set(target.deviceId, target.mountPoint);
    }
    if (byFilesystem.size !== 1) {
      throw new Error('[XFS] All quota roots must reference one shared XFS filesystem');
    }
    return [...byFilesystem.values()];
  }

  private parseUsageLine(line: string): QuotaUsage | null {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) return null;

    // xfs_quota report -N outputs "#<projectId>" in the first column.
    const m = /^#(\d+)$/.exec(parts[0]);
    if (!m) return null;

    const projectId = Number(m[1]);
    const numericUserId = projectId - XFS_PROJECT_ID_OFFSET;
    if (
      !Number.isSafeInteger(projectId)
      || projectId > XFS_PROJECT_ID_MAX
      || !Number.isSafeInteger(numericUserId)
      || numericUserId <= 0
    ) return null;

    if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[3])) return null;
    const usedBlocks = Number(parts[1]);
    const hardLimitBlocks = Number(parts[3]);
    const usedBytes = usedBlocks * XFS_QUOTA_BLOCK_BYTES;
    const hardLimitBytes = hardLimitBlocks * XFS_QUOTA_BLOCK_BYTES;
    if (
      !Number.isSafeInteger(usedBytes)
      || !Number.isSafeInteger(hardLimitBytes)
    ) return null;

    return {
      numericUserId,
      projectId,
      usedBytes,
      hardLimitBytes,
    };
  }

  private parseQuotaReport(output: string, quotaMount: string): QuotaUsage[] {
    const usages: QuotaUsage[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const usage = this.parseUsageLine(trimmed);
      if (usage) {
        usages.push(usage);
        continue;
      }
      if (trimmed.startsWith('#')) {
        throw new Error(`[XFS] Malformed project row in quota report on ${quotaMount}: ${trimmed}`);
      }
    }
    if (usages.length === 0 && !/\bProject quota on\b/i.test(output)) {
      throw new Error(`[XFS] Empty or unrecognized project quota report on ${quotaMount}`);
    }
    return usages;
  }

  private appendLineIfMissing(filePath: string, line: string): void {
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    if (!existing.split('\n').includes(line)) {
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      this.atomicWriteFile(filePath, `${existing}${separator}${line}\n`);
    }
  }

  private atomicWriteFile(filePath: string, contents: string): void {
    const temporaryPath = `${filePath}.nyabase-${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, contents, { mode: 0o644 });
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* no temporary file */ }
      throw error;
    }
  }

  private async getUsageForProject(projectId: number, pathOrMount: string): Promise<QuotaUsage | null> {
    const quotaMount = this.getQuotaCommandTarget(pathOrMount);
    const { stdout } = await this.runXfsQuota(
      `report -N -p -b -n -L ${projectId} -U ${projectId}`,
      quotaMount,
      `read quota report for project ${projectId}`,
    );
    for (const usage of this.parseQuotaReport(stdout, quotaMount)) {
      if (usage?.projectId === projectId) return usage;
    }
    return null;
  }

  private async verifyPathAssignedToProject(
    projectId: number,
    dirPath: string,
    quotaMount: string,
    _durablePath = dirPath,
  ): Promise<void> {
    const stat = await this.runXfsIo(
      'stat',
      dirPath,
      `read project metadata for ${dirPath}`,
    );
    const reportedProjectId = this.extractProjectId(stat.stdout);
    if (reportedProjectId !== projectId) {
      throw new Error(
        `[XFS] Path ${dirPath} project ID mismatch: expected ${projectId}, reported ${reportedProjectId ?? 'unknown'}`,
      );
    }
    if (!this.hasProjectInheritanceFlag(stat.stdout)) {
      throw new Error(`[XFS] Path ${dirPath} is missing project inheritance flag for project ${projectId}`);
    }

    const usage = await this.getUsageForProject(projectId, quotaMount);
    if (!usage) {
      throw new Error(`[XFS] Project ${projectId} is missing from quota report after assigning path ${dirPath}`);
    }
  }

  private getQuotaCommandTarget(pathOrMount: string): string {
    const lookupPath = this.normalizePathForMountLookup(pathOrMount);
    const best = this.findContainingMount(lookupPath, this.readMountRecords());
    if (!best) {
      throw new Error(`[XFS] Failed to find containing mount for ${pathOrMount}`);
    }
    return best.mountPoint;
  }

  private normalizePathForMountLookup(value: string): string {
    const resolved = path.resolve(value);
    try {
      return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    } catch {
      return resolved;
    }
  }

  private readMountRecords(): Array<{ deviceId: string; mountPoint: string }> {
    try {
      return fs.readFileSync('/proc/self/mountinfo', 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const fields = line.split(' ');
          if (fields.length < 5) return null;
          return {
            deviceId: fields[2],
            mountPoint: path.resolve(this.decodeMountInfoPath(fields[4])),
          };
        })
        .filter((mount): mount is { deviceId: string; mountPoint: string } => mount !== null);
    } catch (err) {
      throw new Error(`[XFS] Failed to read mount information: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private findContainingMount(
    lookupPath: string,
    mounts: readonly { deviceId: string; mountPoint: string }[],
  ): { deviceId: string; mountPoint: string } | null {
    let best: { deviceId: string; mountPoint: string } | null = null;
    for (const mount of mounts) {
      if (!this.isPathOnMount(lookupPath, mount.mountPoint)) continue;
      if (!best || mount.mountPoint.length > best.mountPoint.length) best = mount;
    }
    return best;
  }

  private decodeMountInfoPath(value: string): string {
    return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
  }

  private isPathOnMount(value: string, mountPoint: string): boolean {
    if (mountPoint === '/') return true;
    return value === mountPoint || value.startsWith(`${mountPoint}/`);
  }

  private extractProjectId(output: string): number | null {
    const match = /\bfsxattr\.projid\s*=\s*(\d+)\b/.exec(output);
    if (!match) return null;
    const projectId = Number.parseInt(match[1], 10);
    return Number.isFinite(projectId) ? projectId : null;
  }

  private hasProjectInheritanceFlag(output: string): boolean {
    const match = /\bfsxattr\.xflags\s*=\s*0x[0-9a-f]+\s*\[([^\]]*)\]/i.exec(output);
    if (!match) return false;
    const flags = match[1];
    const normalized = flags.replace(/[\s_-]/g, '').toLowerCase();
    return flags.includes('P') || normalized.includes('projinherit') || normalized.includes('projectinherit');
  }

  private extractQuotaState(output: string, label: 'Accounting' | 'Enforcement'): boolean | null {
    const pattern = new RegExp(`\\b${label}:\\s*(ON|OFF)\\b`, 'i');
    const match = pattern.exec(output);
    if (!match) return null;
    return match[1].toUpperCase() === 'ON';
  }

  private async runXfsQuota(
    command: string,
    pathOrMount: string,
    context: string,
    mode: XfsCommandMode = 'observation',
    sourceFd?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.runCommand('xfs_quota', [
        '-x',
        '-c',
        command,
        pathOrMount,
      ], context, mode, sourceFd);
    } catch (err) {
      if (err instanceof XfsCommandAmbiguityError) {
        return new Promise<XfsCommandResult>(() => { /* process is terminating */ });
      }
      throw new Error(`[XFS] ${context} failed: ${this.formatExecError(err, command, pathOrMount)}`);
    }
  }

  private async runXfsIo(
    command: string,
    filePath: string,
    context: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const pinned = this.preparePinnedPath(filePath);
    try {
      return await this.runCommand('xfs_io', [
        '-c',
        command,
        pinned.childPath,
      ], context, 'observation', pinned.sourceFd);
    } catch (err) {
      if (err instanceof XfsCommandAmbiguityError) {
        return new Promise<XfsCommandResult>(() => { /* process is terminating */ });
      }
      throw new Error(`[XFS] ${context} failed: ${this.formatExecFileError(err, 'xfs_io', ['-c', command, filePath])}`);
    }
  }

  /**
   * Serialize every XFS observation and mutation. If a child becomes
   * unobservable, its call and this tail remain pending forever; a replacement
   * Agent is the only process allowed to resume physical work.
   */
  private runCommand(
    executable: string,
    args: readonly string[],
    operation: string,
    mode: XfsCommandMode,
    sourceFd?: number,
  ): Promise<XfsCommandResult> {
    if (this.poisoned) return new Promise<XfsCommandResult>(() => { /* process is terminating */ });
    if (this.pendingCommands >= this.commandQueueCap) {
      return Promise.reject(new Error(`[XFS] Command queue limit (${this.commandQueueCap}) reached`));
    }
    this.pendingCommands += 1;
    const execution = this.commandTail.then(
      () => this.poisoned
        ? new Promise<XfsCommandResult>(() => { /* process is terminating */ })
        : this.executeCommand(executable, args, operation, mode, sourceFd),
    );
    this.commandTail = execution.then(() => undefined, () => undefined);
    return execution.finally(() => {
      this.pendingCommands -= 1;
    });
  }

  private executeCommand(
    executable: string,
    args: readonly string[],
    operation: string,
    mode: XfsCommandMode,
    sourceFd?: number,
  ): Promise<XfsCommandResult> {
    return new Promise<XfsCommandResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        const fenced = fencePhysicalMutationCommand(
          executable,
          args,
          this.physicalMutationLockPath,
        );
        child = this.spawnProcess(fenced.executable, fenced.args, {
          detached: true,
          stdio: sourceFd === undefined
            ? ['ignore', 'pipe', 'pipe']
            : ['ignore', 'pipe', 'pipe', sourceFd],
        });
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let ambiguous = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const timer = setTimeout(() => {
        if (settled || ambiguous) return;
        ambiguous = true;
        this.makeCommandAmbiguous(
          child,
          new XfsCommandAmbiguityError(
            operation,
            mode,
            `deadline exceeded after ${this.commandTimeoutMs}ms`,
          ),
        );
      }, this.commandTimeoutMs);
      timer.unref();

      const finish = (error?: Error): void => {
        if (settled || ambiguous) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          const detailed = error as ExecError;
          detailed.stdout = stdout;
          detailed.stderr = stderr;
          reject(detailed);
        } else {
          resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
        }
      };
      const collect = (stream: 'stdout' | 'stderr', chunk: string | Buffer): void => {
        if (settled || ambiguous) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stream === 'stdout') stdout = Buffer.concat([stdout, bytes]);
        else stderr = Buffer.concat([stderr, bytes]);
        if (stdout.length + stderr.length <= this.commandOutputLimitBytes) return;
        ambiguous = true;
        clearTimeout(timer);
        this.makeCommandAmbiguous(
          child,
          new XfsCommandAmbiguityError(
            operation,
            mode,
            `output exceeded ${this.commandOutputLimitBytes} bytes`,
          ),
        );
      };
      const streamError = (stream: string, error: Error): void => {
        if (settled || ambiguous) return;
        ambiguous = true;
        clearTimeout(timer);
        this.makeCommandAmbiguous(
          child,
          new XfsCommandAmbiguityError(
            operation,
            mode,
            `${stream} transport failed after spawn: ${error.message}`,
          ),
        );
      };

      child.stdout?.on('data', (chunk: string | Buffer) => collect('stdout', chunk));
      child.stderr?.on('data', (chunk: string | Buffer) => collect('stderr', chunk));
      child.stdout?.once('error', (error) => streamError('stdout', error));
      child.stderr?.once('error', (error) => streamError('stderr', error));
      child.once('error', (error) => {
        if (child.pid === undefined) {
          finish(error);
          return;
        }
        if (settled || ambiguous) return;
        ambiguous = true;
        clearTimeout(timer);
        this.makeCommandAmbiguous(
          child,
          new XfsCommandAmbiguityError(
            operation,
            mode,
            `process transport failed after spawn: ${error.message}`,
          ),
        );
      });
      child.once('close', (code, signal) => {
        if (ambiguous) return;
        if (this.isProcessGroupAlive(child.pid)) {
          ambiguous = true;
          clearTimeout(timer);
          this.makeCommandAmbiguous(
            child,
            new XfsCommandAmbiguityError(
              operation,
              mode,
              'leader closed while a descendant remained in its process group',
            ),
          );
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        if (code === PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE) {
          finish(new PhysicalMutationFenceBusyError(executable));
          return;
        }
        const error = new Error(
          `${executable} exited ${signal ? `with signal ${signal}` : `with code ${String(code)}`}`,
        ) as ExecError;
        error.code = code ?? signal ?? 'unknown';
        finish(error);
      });
    });
  }

  private isProcessGroupAlive(pid: number | undefined): boolean {
    if (pid === undefined) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private makeCommandAmbiguous(child: ChildProcess, error: XfsCommandAmbiguityError): void {
    this.poisoned = true;
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (killError) {
        if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') {
          try { child.kill('SIGKILL'); } catch { /* child may already be gone */ }
        }
      }
    } else {
      try { child.kill('SIGKILL'); } catch { /* child never started */ }
    }
    try {
      this.fatalHook(error);
    } catch (fatalError) {
      console.error('[XFS] Injected fatal hook failed; forcing SIGKILL', fatalError);
      killAgentAfterAmbiguousXfsCommand(error);
    }
  }

  private preparePinnedPath(filePath: string): { childPath: string; sourceFd?: number } {
    const prefix = new RegExp(`^/proc/(?:self|${process.pid})/fd/(\\d+)(/.*)?$`);
    const match = prefix.exec(filePath);
    if (!match) {
      if (/^\/proc\/(?:self|\d+)\/fd\//.test(filePath)) {
        throw new Error(`[XFS] Refusing a foreign or malformed process fd path: ${filePath}`);
      }
      return { childPath: filePath };
    }
    const sourceFd = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(sourceFd) || sourceFd <= 2) {
      throw new Error(`[XFS] Invalid pinned source fd in path: ${filePath}`);
    }
    try {
      fs.fstatSync(sourceFd);
    } catch (error) {
      throw new Error(`[XFS] Pinned source fd is not open for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      childPath: `${CHILD_SOURCE_ROOT}${match[2] ?? ''}`,
      sourceFd,
    };
  }

  private formatExecError(err: unknown, command: string, pathOrMount: string): string {
    return this.formatExecFileError(err, 'xfs_quota', ['-x', '-c', command, pathOrMount]);
  }

  private formatExecFileError(err: unknown, executable: string, args: string[]): string {
    const e = err as ExecError;
    const parts = [
      `command="${[executable, ...args].join(' ')}"`,
      e.code !== undefined ? `code=${String(e.code)}` : '',
      e.message ? `message=${e.message}` : '',
      this.outputToString(e.stdout).trim() ? `stdout=${this.outputToString(e.stdout).trim()}` : '',
      this.outputToString(e.stderr).trim() ? `stderr=${this.outputToString(e.stderr).trim()}` : '',
    ].filter(Boolean);
    return parts.join('; ');
  }

  private outputToString(output: string | Buffer | undefined): string {
    if (output === undefined) return '';
    return typeof output === 'string' ? output : output.toString('utf-8');
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
  }

  private getRegisteredProjectPaths(projectId: number): string[] {
    try {
      if (!fs.existsSync('/etc/projects')) return [];
      const prefix = `${projectId}:`;
      return fs.readFileSync('/etc/projects', 'utf-8')
        .split('\n')
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length))
        .filter((line) => line.length > 0);
    } catch (err) {
      throw new Error(`[XFS] Failed to read /etc/projects for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readExactPathRegistration(
    dirPath: string,
  ): { projectId: number; lines: string[]; lineIndex: number } | null {
    this.assertProjectPathSafe(dirPath);
    if (!fs.existsSync('/etc/projects')) return null;
    try {
      const lines = fs.readFileSync('/etc/projects', 'utf-8').split('\n');
      const matches = lines.flatMap((line, lineIndex) => {
        const separator = line.indexOf(':');
        if (separator < 0 || line.slice(separator + 1) !== dirPath) return [];
        return [{ projectText: line.slice(0, separator), lineIndex }];
      });
      if (matches.length === 0) return null;
      if (matches.length !== 1) {
        throw new Error(`ambiguous duplicate registrations (${matches.length})`);
      }
      const match = matches[0];
      if (!/^\d+$/.test(match.projectText)) {
        throw new Error(`malformed project id ${JSON.stringify(match.projectText)}`);
      }
      const projectId = Number(match.projectText);
      if (
        !Number.isSafeInteger(projectId)
        || projectId <= XFS_PROJECT_ID_OFFSET
        || projectId > 0xffff_ffff
        || String(projectId) !== match.projectText
      ) {
        throw new Error(`non-Nyabase project id ${match.projectText}`);
      }
      return { projectId, lines, lineIndex: match.lineIndex };
    } catch (error) {
      throw new Error(
        `[XFS] Cannot resolve exact registration for ${dirPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private assertProjectPathSafe(dirPath: string): void {
    if (
      dirPath.includes('\0')
      || dirPath.includes('\n')
      || dirPath.includes('\r')
      || !path.isAbsolute(dirPath)
      || path.resolve(dirPath) !== dirPath
    ) {
      throw new Error(`[XFS] Invalid project path: ${dirPath}`);
    }
    let physicalPath = dirPath;
    if (fs.existsSync(dirPath)) {
      try {
        physicalPath = fs.realpathSync(dirPath);
      } catch (error) {
        throw new Error(`[XFS] Cannot resolve project path ${dirPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const insideConfiguredRoot = this.quotaRoots.some((root) =>
      physicalPath !== root && physicalPath.startsWith(`${root}${path.sep}`));
    if (!insideConfiguredRoot) {
      throw new Error(`[XFS] Project path is outside configured quota roots: ${dirPath}`);
    }
  }

  private quoteXfsArg(value: string): string {
    if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
}
