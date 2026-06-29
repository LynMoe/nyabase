import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import type { XfsQuotaManager } from '../quota/xfs-quota.js';
import { DataDirEntry } from '@nyabase/common';

const execFileAsync = promisify(execFile);
const DOCKER_ROOT_RESERVED_DIRS = new Set([
  'buildkit',
  'containers',
  'engine-id',
  'image',
  'network',
  'overlay2',
  'plugins',
  'runtimes',
  'swarm',
  'tmp',
  'volumes',
]);

export interface DataSource {
  kind: 'local' | 'remote';
  id: string;       // diskId or remoteFsMountId
  root: string;     // mountPoint or hostMountPoint
  quotaEnabled: boolean;
}

export class DataDirsManager {
  private sources: Map<string, DataSource> = new Map();
  private dockerRoot: string | null;

  constructor(_quotaManager?: XfsQuotaManager, dockerRoot?: string) {
    this.dockerRoot = dockerRoot ? path.resolve(dockerRoot) : null;
  }

  addSource(src: DataSource): void {
    this.sources.set(src.id, src);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  getSource(id: string): DataSource | undefined {
    return this.sources.get(id);
  }

  getDirPath(sourceId: string, name: string): string {
    const src = this.sources.get(sourceId);
    if (!src) throw new Error(`Unknown source: ${sourceId}`);
    return path.join(src.root, name);
  }

  /** List all directories across all sources (single-layer: {root}/{name}/) */
  async listAllDirs(): Promise<DataDirEntry[]> {
    const entries: DataDirEntry[] = [];
    for (const src of this.sources.values()) {
      if (!fs.existsSync(src.root)) continue;
      let dirEntries: fs.Dirent[];
      try { dirEntries = fs.readdirSync(src.root, { withFileTypes: true }); } catch { continue; }
      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        if (this.isReservedDockerRootDir(src, entry.name)) continue;
        entries.push({
          sourceKind: src.kind,
          sourceId: src.id,
          name: entry.name,
          hostPath: path.join(src.root, entry.name),
        });
      }
    }
    return entries;
  }

  private isReservedDockerRootDir(src: DataSource, name: string): boolean {
    return src.kind === 'local' &&
      this.dockerRoot !== null &&
      path.resolve(src.root) === this.dockerRoot &&
      DOCKER_ROOT_RESERVED_DIRS.has(name);
  }

  /** Create a directory at {root}/{name}/ */
  async createDir(sourceId: string, name: string, uid: number): Promise<string> {
    const src = this.sources.get(sourceId);
    if (!src) throw new Error(`Unknown source: ${sourceId}`);

    const dirPath = path.join(src.root, name);
    fs.mkdirSync(dirPath, { recursive: true });

    try {
      await execFileAsync('chown', ['-R', `${uid}:${uid}`, dirPath]);
    } catch (e) {
      if (src.kind === 'remote') {
        console.warn(`[DataDirs] chown failed for remote FS dir ${dirPath} (root_squash / permissions?): ${e}`);
      } else {
        throw e;
      }
    }

    return dirPath;
  }

  /** Delete directory at {root}/{name}/ */
  async deleteDir(sourceId: string, name: string): Promise<void> {
    const src = this.sources.get(sourceId);
    if (!src) throw new Error(`Unknown source: ${sourceId}`);

    const dirPath = path.join(src.root, name);
    if (!fs.existsSync(dirPath)) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
  }

  getDiskInfo(sourceId: string): { totalBytes: number; usedBytes: number; pquotaEnabled: boolean; available: boolean } | null {
    const src = this.sources.get(sourceId);
    if (!src || !fs.existsSync(src.root)) return null;

    try {
      const output = execFileSync('df', ['--output=size,used', '-B1', src.root], { encoding: 'utf-8' });
      const lines = output.trim().split('\n').filter(Boolean);
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      return {
        totalBytes: parseInt(parts[0], 10),
        usedBytes: parseInt(parts[1], 10),
        pquotaEnabled: src.kind === 'local' && src.quotaEnabled,
        available: true,
      };
    } catch {
      return { totalBytes: 0, usedBytes: 0, pquotaEnabled: false, available: false };
    }
  }

  getLocalDiskInfos(): Array<import('@nyabase/common').DiskInfo> {
    return Array.from(this.sources.values())
      .filter((s): s is DataSource & { kind: 'local' } => s.kind === 'local')
      .map((src) => {
        const info = this.getDiskInfo(src.id);
        return {
          diskId: src.id,
          mountPoint: src.root,
          totalBytes: info?.totalBytes ?? 0,
          usedBytes: info?.usedBytes ?? 0,
          pquotaEnabled: info?.pquotaEnabled ?? false,
        };
      });
  }
}
