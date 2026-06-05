import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/**
 * XFS project IDs are computed as: numericUserId + XFS_PROJECT_OFFSET.
 * The offset matches the old nextProjectId starting value (10000) so that
 * numeric user IDs starting from 1 yield project IDs starting from 10001.
 */
const XFS_PROJECT_OFFSET = 10000;

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

type ExecError = Error & {
  code?: unknown;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

export class XfsQuotaManager {
  constructor(private xfsMount: string) {}

  private toProjectId(numericUserId: number): number {
    return numericUserId + XFS_PROJECT_OFFSET;
  }

  /**
   * Ensure the XFS project for a user exists and is initialised.
   * This is idempotent: re-running is safe on an already-configured project.
   */
  async ensureProjectForUser(numericUserId: number): Promise<number> {
    const projectId = this.toProjectId(numericUserId);
    const quotaMount = this.getQuotaCommandTarget(this.xfsMount);
    await this.assertProjectQuotaEnforcementOnMount(this.xfsMount, quotaMount);
    if (this.getRegisteredProjectPaths(projectId).length > 0) {
      await this.initProject(projectId, quotaMount);
    }
    return projectId;
  }

  private async initProject(projectId: number, quotaMount: string): Promise<void> {
    await this.runXfsQuota(
      `project -s ${projectId}`,
      quotaMount,
      `initialize project ${projectId}`,
    );
  }

  async addPathToProject(numericUserId: number, dirPath: string): Promise<void> {
    const projectId = this.toProjectId(numericUserId);
    this.assertProjectPathSafe(dirPath);
    const quotaMount = this.getQuotaCommandTarget(dirPath);
    await this.assertProjectQuotaEnforcementOnMount(dirPath, quotaMount);

    // Register the path in /etc/projects so xfs_quota can find it.
    this.appendLineIfMissing('/etc/projects', `${projectId}:${dirPath}`);

    // project -s -p both adds the path AND re-initialises the project in one step.
    await this.runXfsQuota(
      `project -s -p ${this.quoteXfsArg(dirPath)} ${projectId}`,
      quotaMount,
      `assign path ${dirPath} to project ${projectId}`,
    );

    await this.verifyPathAssignedToProject(projectId, dirPath, quotaMount);
  }

  /**
   * Best-effort removal of a path from a project. Used by createContainer
   * compensation: there is no first-class "xfs_quota project -d <path>", so we
   * simply scrub the matching line from /etc/projects. The kernel still
   * accounts the path against the project until the inode is destroyed (which
   * happens when the container is removed), but the line removal prevents the
   * stale entry from rebinding on next agent start.
   */
  removePathFromProject(numericUserId: number, dirPath: string): void {
    const projectId = this.toProjectId(numericUserId);
    const target = `${projectId}:${dirPath}`;
    try {
      if (!fs.existsSync('/etc/projects')) return;
      const existing = fs.readFileSync('/etc/projects', 'utf-8');
      const filtered = existing.split('\n').filter((l) => l !== target).join('\n');
      if (filtered !== existing) fs.writeFileSync('/etc/projects', filtered);
    } catch (err) {
      console.warn(`[XFS] Failed to remove path ${dirPath} from /etc/projects: ${err}`);
    }
  }

  async setLimit(numericUserId: number, hardLimitBytes: number): Promise<void> {
    const projectId = await this.ensureProjectForUser(numericUserId);
    const quotaMount = this.getQuotaCommandTarget(this.xfsMount);
    // xfs_quota report -b shows values in 1K (KiB) blocks.
    const limitKiB = Math.ceil(hardLimitBytes / 1024);
    await this.runXfsQuota(
      `limit -p bhard=${limitKiB}k ${projectId}`,
      quotaMount,
      `set hard limit ${limitKiB} KiB for project ${projectId}`,
    );

    const expectedHardLimitBytes = limitKiB * 1024;
    const usage = await this.getUsageForProject(projectId, quotaMount);
    if (!usage) {
      throw new Error(`[XFS] Project ${projectId} is missing from quota report after limit application`);
    }
    if (usage.hardLimitBytes !== expectedHardLimitBytes) {
      throw new Error(
        `[XFS] Project ${projectId} hard limit mismatch: expected ${expectedHardLimitBytes} bytes, reported ${usage.hardLimitBytes} bytes`,
      );
    }
  }

  async checkProjectQuotaEnforcement(pathOrMount = this.xfsMount): Promise<ProjectQuotaCapability> {
    const quotaMount = this.getQuotaCommandTarget(pathOrMount);
    return this.checkProjectQuotaEnforcementOnMount(quotaMount);
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
    const results: QuotaUsage[] = [];
    try {
      const quotaMount = this.getQuotaCommandTarget(this.xfsMount);
      const { stdout } = await this.runXfsQuota(
        'report -N -p -b -n',
        quotaMount,
        'read project quota report',
      );

      for (const line of stdout.split('\n')) {
        const usage = this.parseUsageLine(line);
        if (usage) results.push(usage);
      }
    } catch (err) {
      console.warn('[XFS] Failed to get all usages:', err);
    }
    return results;
  }

  private parseUsageLine(line: string): QuotaUsage | null {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) return null;

    // xfs_quota report -N outputs "#<projectId>" in the first column.
    const m = /^#(\d+)$/.exec(parts[0]);
    if (!m) return null;

    const projectId = Number(m[1]);
    const numericUserId = projectId - XFS_PROJECT_OFFSET;
    if (numericUserId <= 0) return null;

    const usedBlocks = Number.parseInt(parts[1], 10);
    const hardLimitBlocks = Number.parseInt(parts[3], 10);
    if (!Number.isFinite(usedBlocks) || !Number.isFinite(hardLimitBlocks)) return null;

    return {
      numericUserId,
      projectId,
      usedBytes: usedBlocks * 1024,
      hardLimitBytes: hardLimitBlocks * 1024,
    };
  }

  private appendLineIfMissing(filePath: string, line: string): void {
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    if (!existing.split('\n').includes(line)) {
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(filePath, `${separator}${line}\n`);
    }
  }

  private async getUsageForProject(projectId: number, pathOrMount: string): Promise<QuotaUsage | null> {
    const quotaMount = this.getQuotaCommandTarget(pathOrMount);
    const { stdout } = await this.runXfsQuota(
      'report -N -p -b -n',
      quotaMount,
      `read quota report for project ${projectId}`,
    );
    for (const line of stdout.split('\n')) {
      const usage = this.parseUsageLine(line);
      if (usage?.projectId === projectId) return usage;
    }
    return null;
  }

  private async verifyPathAssignedToProject(projectId: number, dirPath: string, quotaMount: string): Promise<void> {
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
    const mountPoints = this.readMountPoints();
    let best: string | null = null;
    for (const mountPoint of mountPoints) {
      if (!this.isPathOnMount(lookupPath, mountPoint)) continue;
      if (!best || mountPoint.length > best.length) best = mountPoint;
    }
    if (!best) {
      throw new Error(`[XFS] Failed to find containing mount for ${pathOrMount}`);
    }
    return best;
  }

  private normalizePathForMountLookup(value: string): string {
    const resolved = path.resolve(value);
    try {
      return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    } catch {
      return resolved;
    }
  }

  private readMountPoints(): string[] {
    try {
      return fs.readFileSync('/proc/self/mountinfo', 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const fields = line.split(' ');
          if (fields.length < 5) return null;
          return path.resolve(this.decodeMountInfoPath(fields[4]));
        })
        .filter((mountPoint): mountPoint is string => mountPoint !== null);
    } catch (err) {
      throw new Error(`[XFS] Failed to read mount information: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync('xfs_quota', [
        '-x',
        '-c',
        command,
        pathOrMount,
      ], { timeout: 10_000 });
      return {
        stdout: this.outputToString(result.stdout),
        stderr: this.outputToString(result.stderr),
      };
    } catch (err) {
      throw new Error(`[XFS] ${context} failed: ${this.formatExecError(err, command, pathOrMount)}`);
    }
  }

  private async runXfsIo(
    command: string,
    filePath: string,
    context: string,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync('xfs_io', [
        '-c',
        command,
        filePath,
      ], { timeout: 10_000 });
      return {
        stdout: this.outputToString(result.stdout),
        stderr: this.outputToString(result.stderr),
      };
    } catch (err) {
      throw new Error(`[XFS] ${context} failed: ${this.formatExecFileError(err, 'xfs_io', ['-c', command, filePath])}`);
    }
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

  private assertProjectPathSafe(dirPath: string): void {
    if (dirPath.includes('\0') || dirPath.includes('\n')) {
      throw new Error(`[XFS] Invalid project path: ${dirPath}`);
    }
  }

  private quoteXfsArg(value: string): string {
    if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
}
