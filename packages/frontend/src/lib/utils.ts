import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const GIB = 1024 ** 3;

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  // Binary units everywhere, matching the GiB the forms ask for.
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
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

/** Capacity as plain GiB ("12.5 GiB"); `empty` for unknown. */
export function formatGib(bytes: number | null, empty = '未知'): string {
  return bytes === null ? empty : approxGibHint(bytes).replace(/^约 /, '');
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

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatBytesCompact(bytes: number): string {
  const value = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '';
  const scaled = (amount: number, unit: string) => {
    const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
    return `${sign}${text} ${unit}`;
  };
  if (value >= 1024 ** 4) return scaled(value / 1024 ** 4, 'TiB');
  if (value >= 1024 ** 3) return scaled(value / 1024 ** 3, 'GiB');
  if (value >= 1024 ** 2) return `${sign}${(value / 1024 ** 2).toFixed(0)} MiB`;
  if (value >= 1024) return `${sign}${Math.round(value / 1024)} KiB`;
  return `${sign}${Math.round(value)} B`;
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
