import { GIB, formatBytesCompact } from './utils.js';

export type CpuMemDisk = {
  cpuMillis: number | null;
  memBytes: number | null;
  diskBytes: number | null;
};

const UNLIMITED = '不限';

function formatCompactCpu(millis: number): string {
  const cores = millis / 1000;
  const label = Number.isInteger(cores) ? String(cores) : parseFloat(cores.toFixed(3)).toString();
  return `${label}C`;
}

function formatCompactBytes(bytes: number): string {
  if (bytes === 0) return '0G';
  const gib = bytes / GIB;
  if (gib >= 0.95) {
    const label = Number.isInteger(gib) ? String(gib) : parseFloat(gib.toFixed(2)).toString();
    return `${label}G`;
  }
  return formatBytesCompact(bytes);
}

function formatGrantNumber(value: number | null, fmt: (n: number) => string): string {
  if (value === null || value === 0) return UNLIMITED;
  return fmt(value);
}

/** Grant ceilings only. null/0 → 不限. Never pass consumed sums here. */
export function formatGrantQuotaParts(grant: CpuMemDisk): string[] {
  return [
    formatGrantNumber(grant.cpuMillis, formatCompactCpu),
    formatGrantNumber(grant.memBytes, formatCompactBytes),
    formatGrantNumber(grant.diskBytes, formatCompactBytes),
  ];
}

export function formatGrantQuotaLine(
  grant: CpuMemDisk,
  extensionChips: readonly string[] = [],
): string {
  return [...formatGrantQuotaParts(grant), ...extensionChips].join(' / ');
}

/** Allocated/committed usage. 0 → 0C / 0G. null = no observation (omit the dim). */
export function formatConsumedQuotaParts(consumed: CpuMemDisk): string[] {
  const parts: string[] = [];
  if (consumed.cpuMillis !== null) parts.push(formatCompactCpu(consumed.cpuMillis));
  if (consumed.memBytes !== null) parts.push(formatCompactBytes(consumed.memBytes));
  if (consumed.diskBytes !== null) parts.push(formatCompactBytes(consumed.diskBytes));
  return parts;
}

/** Grant ceiling for a byte quota (shared backend limit). 0/null → 不限. */
export function formatGrantBytes(bytes: number | null): string {
  return formatGrantNumber(bytes, formatCompactBytes);
}

/** Allocated CPU/mem. Empty list → 0C / 0G, never 不限. */
export function formatAllocatedCpuMem(
  containers: readonly { cpuMillis: number; memBytes: number }[],
): string {
  return formatConsumedQuotaParts({
    cpuMillis: containers.reduce((sum, item) => sum + item.cpuMillis, 0),
    memBytes: containers.reduce((sum, item) => sum + item.memBytes, 0),
    diskBytes: null,
  }).join(' / ');
}

function remainingOf(grant: number | null, used: number, kind: 'cpu' | 'bytes'): string {
  if (grant === null || grant === 0) return UNLIMITED;
  const left = Math.max(0, grant - used);
  const parts = kind === 'cpu'
    ? formatConsumedQuotaParts({ cpuMillis: left, memBytes: null, diskBytes: null })
    : formatConsumedQuotaParts({ cpuMillis: null, memBytes: left, diskBytes: null });
  return parts[0] ?? UNLIMITED;
}

/** Remaining of a CPU grant. Unlimited grant → 不限; else consumed formatter. */
export function formatRemainingCpu(grantMillis: number | null, usedMillis: number): string {
  return remainingOf(grantMillis, usedMillis, 'cpu');
}

/** Remaining of a byte grant. Unlimited grant → 不限; else consumed formatter. */
export function formatRemainingBytes(grantBytes: number | null, usedBytes: number): string {
  return remainingOf(grantBytes, usedBytes, 'bytes');
}
