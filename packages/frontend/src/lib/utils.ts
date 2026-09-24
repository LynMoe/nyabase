import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const GIB = 1024 ** 3;

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/** Human-friendly GiB string for number inputs (strips trailing zeros). */
export function formatGibInput(bytes: number): string {
  const gib = bytes / GIB;
  return Number.isInteger(gib) ? String(gib) : parseFloat(gib.toFixed(3)).toString();
}

/** Human-friendly vCPU string for number inputs (millis → cores). */
export function formatVcpuInput(millis: number): string {
  const vcpu = millis / 1000;
  return Number.isInteger(vcpu) ? String(vcpu) : parseFloat(vcpu.toFixed(3)).toString();
}

export function gibToBytes(gib: number): number {
  return Math.round(gib * GIB);
}

export function vcpuToMillis(vcpu: number): number {
  return Math.round(vcpu * 1000);
}

export function formatCpu(millis: number): string {
  if (millis === 0) return '不限制';
  if (millis >= 1000) {
    const cores = millis / 1000;
    const label = Number.isInteger(cores) ? String(cores) : cores.toFixed(1);
    return `${label} 核`;
  }
  return `${millis}m`;
}

/** Soft hint under GiB inputs — avoid raw byte clutter. */
export function approxGibHint(bytes: number): string {
  const gib = bytes / GIB;
  const label = Number.isInteger(gib) ? String(gib) : parseFloat(gib.toFixed(2)).toString();
  return `约 ${label} GiB`;
}

/**
 * Capacity "available" label for grant-backed storage.
 * Unlimited grant + null available ⇒ 「不限」 (not 「未知」).
 */
export function grantAvailableLabel(
  availableBytes: number | null,
  grantLimitBytes: number | null,
): string {
  const unlimited = grantLimitBytes === null || grantLimitBytes === 0;
  if (availableBytes === null && unlimited) return '不限';
  if (availableBytes === null) return '未知';
  return approxGibHint(availableBytes).replace(/^约 /, '');
}

/** Shared-backend available bytes: total × overcommit − used when computable. */
export function sharedBackendAvailableBytes(backend: {
  totalBytes: number | null;
  usedBytes: number | null;
  overcommitRatio: number;
}): number | null {
  if (backend.totalBytes === null || backend.usedBytes === null) return null;
  if (!Number.isFinite(backend.overcommitRatio) || backend.overcommitRatio < 1) return null;
  return Math.max(0, backend.totalBytes * backend.overcommitRatio - backend.usedBytes);
}

/** used / total display; 「未知」 only when values are truly missing. */
export function usedTotalLabel(usedBytes: number | null, totalBytes: number | null): string {
  if (totalBytes === null && usedBytes === null) return '未知';
  if (totalBytes === null) return `${formatBytes(usedBytes ?? 0)} / 未知`;
  return `${formatBytes(usedBytes ?? 0)} / ${formatBytes(totalBytes)}`;
}

export function formatBytesLimit(bytes: number): string {
  return bytes === 0 ? '不限制' : formatBytes(bytes);
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatBytesCompact(bytes: number): string {
  const value = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '';
  if (value >= 1024 ** 4) return `${sign}${(value / 1024 ** 4).toFixed(1)}T`;
  if (value >= 1024 ** 3) return `${sign}${(value / 1024 ** 3).toFixed(1)}G`;
  if (value >= 1024 ** 2) return `${sign}${(value / 1024 ** 2).toFixed(0)}M`;
  if (value >= 1024) return `${sign}${Math.round(value / 1024)}K`;
  return `${sign}${Math.round(value)}B`;
}

/** Bytes per second for performance charts and occupancy lines. */
export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec)) return '—';
  const value = Math.abs(bytesPerSec);
  const sign = bytesPerSec < 0 ? '-' : '';
  const scaled = (amount: number, unit: string) => {
    const text = amount < 10 ? amount.toFixed(1) : String(Math.round(amount));
    return `${sign}${text} ${unit}`;
  };
  if (value >= 1024 ** 3) return scaled(value / 1024 ** 3, 'GB/s');
  if (value >= 1024 ** 2) return scaled(value / 1024 ** 2, 'MB/s');
  if (value >= 1024) return scaled(value / 1024, 'KB/s');
  return `${sign}${Math.round(value)} B/s`;
}

export function formatGpuText(input: {
  usedBytes?: number | null;
  totalBytes?: number | null;
  limitBytes?: number | null;
  ratio?: number | null;
} | null | undefined): string | null {
  if (!input) return null;
  const used = input.usedBytes;
  const total = input.totalBytes ?? input.limitBytes;
  if (typeof input.ratio === 'number' && Number.isFinite(input.ratio) && input.ratio > 0) {
    return formatPercent(input.ratio);
  }
  if (typeof used === 'number' && typeof total === 'number' && total > 0) {
    return formatPercent(used / total);
  }
  if (typeof used === 'number' && used > 0) return formatBytesCompact(used);
  return null;
}

export function formatAssignedGpuText(gpu: {
  usedBytes?: number | null;
  totalBytes?: number | null;
  ratio?: number | null;
  limitBytes?: number | null;
  pciAddresses?: readonly string[];
  cardCount?: number;
} | null | undefined): string | null {
  if (!gpu) return null;
  const assigned = (gpu.pciAddresses?.length ?? 0) > 0 || (gpu.cardCount ?? 0) > 0 || gpu.usedBytes != null;
  return assigned ? formatGpuText(gpu) : null;
}

export function formatHostGpuText(gpus: ReadonlyArray<{
  usedBytes: number | null;
  totalBytes: number | null;
}>): string | null {
  if (gpus.length === 0) return null;
  const finite = (value: number | null): value is number => typeof value === 'number' && Number.isFinite(value);
  const everyUsed = gpus.every((card) => finite(card.usedBytes));
  const everyTotal = gpus.every((card) => finite(card.totalBytes));
  const total = everyTotal ? gpus.reduce((sum, card) => sum + (card.totalBytes as number), 0) : 0;
  if (everyUsed && everyTotal && total > 0) {
    const used = gpus.reduce((sum, card) => sum + (card.usedBytes as number), 0);
    return formatGpuText({ usedBytes: used, totalBytes: total });
  }
  const known = gpus.flatMap((card) => (finite(card.usedBytes) ? [card.usedBytes] : []));
  if (known.length === 0) return null;
  return formatGpuText({ usedBytes: known.reduce((sum, value) => sum + value, 0), totalBytes: null });
}

export function formatAggregateGpuText(items: ReadonlyArray<{
  usedBytes: number | null;
  limitBytes: number | null;
  pciAddresses?: readonly string[];
}>): string | null {
  const included = items.filter((item) => (item.pciAddresses?.length ?? 0) > 0 || item.usedBytes != null);
  if (included.length === 0) return null;
  const finite = (value: number | null): value is number => typeof value === 'number' && Number.isFinite(value);
  const usedValues = included.map((item) => item.usedBytes).filter(finite);
  const used = usedValues.length === 0 ? null : usedValues.reduce((total, value) => total + value, 0);
  const limitsComplete = included.every((item) => finite(item.limitBytes));
  const limit = limitsComplete ? included.reduce((total, item) => total + (item.limitBytes as number), 0) : null;
  return formatGpuText({
    usedBytes: used,
    totalBytes: limit !== null && limit > 0 && used !== null ? limit : null,
  });
}

/**
 * Format a nullable resource limit for display.
 * Null and 0 both mean unlimited.
 */
export function resourceVal(
  value: number | null,
  fmt: (n: number) => string,
): string {
  const v = value ?? 0;
  return v === 0 ? '不限' : fmt(v);
}

export function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '从未';
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}
