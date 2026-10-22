import { ContainerPhase, ContainerPowerIntent } from '@nyabase/common';
import { GIB, formatBytesCompact } from './utils.js';

export type CpuMemDisk = {
  /** Whole logical CPUs; null on a grant = every unreserved CPU. */
  cpuCores: number | null;
  memBytes: number | null;
  diskBytes: number | null;
};

const UNLIMITED = '不限';

function formatCompactCpu(cores: number): string {
  return `${cores} 核`;
}

function formatCompactBytes(bytes: number): string {
  if (bytes === 0) return '0 GiB';
  const gib = bytes / GIB;
  if (gib >= 0.95) {
    const label = Number.isInteger(gib) ? String(gib) : parseFloat(gib.toFixed(2)).toString();
    return `${label} GiB`;
  }
  return formatBytesCompact(bytes);
}

function formatGrantNumber(value: number | null, fmt: (n: number) => string): string {
  if (value === null) return UNLIMITED;
  return fmt(value);
}

/** Grant ceilings only. null → 不限. Never pass consumed sums here. */
export function formatGrantQuotaParts(grant: CpuMemDisk): string[] {
  return [
    formatGrantNumber(grant.cpuCores, formatCompactCpu),
    formatGrantNumber(grant.memBytes, formatCompactBytes),
    formatGrantNumber(grant.diskBytes, formatCompactBytes),
  ];
}

export function formatGrantQuotaLine(
  grant: CpuMemDisk,
  gpuSummary: string | null = null,
): string {
  return [...formatGrantQuotaParts(grant), ...(gpuSummary ? [gpuSummary] : [])].join(' / ');
}

/** Allocated/committed usage. 0 → 0 核 / 0 GiB. null = no observation (omit the dim). */
export function formatConsumedQuotaParts(consumed: CpuMemDisk): string[] {
  const parts: string[] = [];
  if (consumed.cpuCores !== null) parts.push(formatCompactCpu(consumed.cpuCores));
  if (consumed.memBytes !== null) parts.push(formatCompactBytes(consumed.memBytes));
  if (consumed.diskBytes !== null) parts.push(formatCompactBytes(consumed.diskBytes));
  return parts;
}

/** Grant ceiling for a byte quota (shared backend limit). null → 不限. */
export function formatGrantBytes(bytes: number | null): string {
  return formatGrantNumber(bytes, formatCompactBytes);
}

/** Remaining of a byte grant. Unlimited grant → 不限; else consumed formatter. */
export function formatRemainingBytes(grantBytes: number | null, usedBytes: number): string {
  if (grantBytes === null) return UNLIMITED;
  return formatCompactBytes(Math.max(0, grantBytes - usedBytes));
}

/**
 * used / limit / remaining of a byte grant (memory, disk, shared storage).
 * CPU is not a budget split across containers: each user gets one pinned CPU set per server.
 */
export function formatQuotaDimension(
  grant: number | null,
  used: number,
): { used: string; limit: string; remaining: string } {
  return {
    used: formatCompactBytes(used),
    limit: formatGrantBytes(grant),
    remaining: formatRemainingBytes(grant, used),
  };
}

/** Memory counted against the server grant: containers whose desired state is running. */
export function runningMemBytes(
  containers: ReadonlyArray<{ memBytes: number; powerIntent: ContainerPowerIntent; lifecyclePhase: ContainerPhase }>,
): number {
  return containers.reduce(
    (sum, item) => item.powerIntent === ContainerPowerIntent.Running
      && item.lifecyclePhase !== ContainerPhase.Failed
      && item.lifecyclePhase !== ContainerPhase.Deleting
      ? sum + item.memBytes
      : sum,
    0,
  );
}
