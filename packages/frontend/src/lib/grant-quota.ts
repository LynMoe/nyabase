import { canonicalPciAddress, ContainerPhase, ContainerPowerIntent } from '@nyabase/common';
import { GIB, formatBytesCompact } from './utils.js';

export type CpuMemDisk = {
  /** Whole logical CPUs; null on a grant = every unreserved CPU. */
  cpuCores: number | null;
  memBytes: number | null;
  /** System disks on the server (data disks are per-pool quotas). */
  rootDiskBytes: number | null;
};

const UNLIMITED = '不限';

function formatCompactCpu(cores: number): string {
  return `${cores} 核`;
}

/** Bytes as "16 GiB" (whole GiB stay whole), the unit every quota surface uses. */
export function formatCompactBytes(bytes: number): string {
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
    formatGrantNumber(grant.rootDiskBytes, formatCompactBytes),
  ];
}

export function formatGrantQuotaLine(
  grant: CpuMemDisk,
  gpuSummary: string | null = null,
): string {
  return [...formatGrantQuotaParts(grant), ...(gpuSummary ? [gpuSummary] : [])].join(' / ');
}

/** A GPU count of a grant: null = every card of the server, 0 = none. */
export function formatGpuCount(count: number | null): string {
  if (count === null) return '全部 GPU';
  return count === 0 ? '无' : `${count} 张 GPU`;
}

/**
 * The cards picked for a user by index: GPU 0, 2. While any picked card's
 * index is unknown (inventory not loaded, card not reporting one), the count.
 */
export function grantedGpuIndexLabel(
  pciAddresses: readonly string[],
  inventory: ReadonlyArray<{ index: number | null; pciAddress: string }>,
): string {
  if (pciAddresses.length === 0) return '无';
  const key = (pci: string) => canonicalPciAddress(pci) ?? pci.trim().toLowerCase();
  const indexOf = new Map(inventory.map((gpu) => [key(gpu.pciAddress), gpu.index]));
  const indexes = pciAddresses.map((pci) => indexOf.get(key(pci)) ?? null);
  if (indexes.some((index) => index === null)) return `${pciAddresses.length} 张`;
  return `GPU ${(indexes as number[]).sort((a, b) => a - b).join(', ')}`;
}

/** Allocated/committed usage. 0 → 0 核 / 0 GiB. null = no observation (omit the dim). */
export function formatConsumedQuotaParts(consumed: CpuMemDisk): string[] {
  const parts: string[] = [];
  if (consumed.cpuCores !== null) parts.push(formatCompactCpu(consumed.cpuCores));
  if (consumed.memBytes !== null) parts.push(formatCompactBytes(consumed.memBytes));
  if (consumed.rootDiskBytes !== null) parts.push(formatCompactBytes(consumed.rootDiskBytes));
  return parts;
}

/** Grant ceiling for a byte quota (memory, system disk, data disk, shared backend). null → 不限. */
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
