import * as fs from 'fs';
import * as path from 'path';

export interface ProcMountEntry {
  source: string;
  mountPoint: string;
  fsType: string;
  options: string;
}

export interface ProcMountInfoEntry extends ProcMountEntry {
  mountId: number;
  parentMountId: number;
  deviceId: string;
  fsRoot: string;
}

/**
 * Cached, async reader for /proc/mounts.
 *
 * Multiple subsystems (remote FS health checks, docker overlay lookup) all
 * read /proc/mounts on overlapping cadences. The file rarely changes between
 * those reads, so a small TTL avoids repeatedly going through the kernel's
 * proc_pid_mounts() path (a non-trivial amount of stringification on hosts
 * with hundreds of mounts).
 *
 * The cache is process-wide and intentionally tiny — there is only ever one
 * entry. In-flight reads are deduped via a shared Promise so a burst of
 * callers triggers at most one syscall.
 */
const TTL_MS = 5_000;

let cache: { value: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

export async function readProcMountsCached(now: number = Date.now()): Promise<string> {
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const value = await fs.promises.readFile('/proc/mounts', 'utf-8');
      cache = { value, expiresAt: Date.now() + TTL_MS };
      return value;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function readProcMountsFresh(): Promise<string> {
  const value = await fs.promises.readFile('/proc/mounts', 'utf-8');
  cache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

export async function readProcMountInfoFresh(): Promise<string> {
  return fs.promises.readFile('/proc/self/mountinfo', 'utf-8');
}

export function parseProcMountInfo(content: string): ProcMountInfoEntry[] {
  const entries: ProcMountInfoEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || separator + 3 >= fields.length) continue;
    const mountId = Number(fields[0]);
    const parentMountId = Number(fields[1]);
    if (!Number.isSafeInteger(mountId) || !Number.isSafeInteger(parentMountId)) continue;
    const mountOptions = fields[5].split(',').filter(Boolean);
    const superOptions = fields[separator + 3].split(',').filter(Boolean);
    entries.push({
      mountId,
      parentMountId,
      deviceId: fields[2],
      fsRoot: decodeProcMountField(fields[3]),
      mountPoint: decodeProcMountField(fields[4]),
      fsType: decodeProcMountField(fields[separator + 1]),
      source: decodeProcMountField(fields[separator + 2]),
      options: [...new Set([...mountOptions, ...superOptions])].join(','),
    });
  }
  return entries;
}

export function parseProcMounts(content: string): ProcMountEntry[] {
  const entries: ProcMountEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;

    entries.push({
      source: decodeProcMountField(parts[0]),
      mountPoint: decodeProcMountField(parts[1]),
      fsType: decodeProcMountField(parts[2]),
      options: decodeProcMountField(parts[3]),
    });
  }

  return entries;
}

export function findLongestContainingProcMount(
  entries: ProcMountEntry[],
  targetPath: string,
): ProcMountEntry | null {
  const normalizedTarget = normalizeMountPath(targetPath);
  let best: ProcMountEntry | null = null;
  let bestLength = -1;

  for (const entry of entries) {
    const mountPoint = normalizeMountPath(entry.mountPoint);
    if (!containsPath(mountPoint, normalizedTarget)) continue;
    if (mountPoint.length > bestLength) {
      best = entry;
      bestLength = mountPoint.length;
    }
  }

  return best;
}

function decodeProcMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match: string, octal: string) => {
    return String.fromCharCode(parseInt(octal, 8));
  });
}

function normalizeMountPath(value: string): string {
  const normalized = path.posix.normalize(value || '/');
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return stripTrailingSlashes(absolute);
}

function stripTrailingSlashes(value: string): string {
  let result = value;
  while (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

function containsPath(mountPoint: string, targetPath: string): boolean {
  if (mountPoint === '/') return targetPath.startsWith('/');
  return targetPath === mountPoint || targetPath.startsWith(`${mountPoint}/`);
}

/** @internal — exposed for tests. */
export function _resetProcMountsCacheForTest(): void {
  cache = null;
  inflight = null;
}
