import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatBytes, scaleBytes } from '@nyabase/common';

export { formatBytes };

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const GIB = 1024 ** 3;

/** Human-friendly GiB string for number inputs (strips trailing zeros). */
export function formatGibInput(bytes: number): string {
  const gib = bytes / GIB;
  return Number.isInteger(gib) ? String(gib) : parseFloat(gib.toFixed(3)).toString();
}

export function gibToBytes(gib: number): number {
  return Math.round(gib * GIB);
}

/** Soft hint under GiB inputs: what the typed size amounts to. */
export function approxSizeHint(bytes: number): string {
  return `约 ${formatBytes(bytes)}`;
}

/** A capacity that may be unknown; `empty` for unknown. */
export function formatCapacity(bytes: number | null, empty = '未知'): string {
  return bytes === null ? empty : formatBytes(bytes);
}

/**
 * Capacity "available" label for grant-backed storage.
 * Unlimited grant + null available ⇒ 「不限」 (not 「未知」).
 */
export function grantAvailableLabel(
  availableBytes: number | null,
  grantLimitBytes: number | null,
): string {
  const unlimited = grantLimitBytes === null;
  if (availableBytes === null && unlimited) return '不限';
  if (availableBytes === null) return '未知';
  return formatBytes(availableBytes);
}

/**
 * Shared-backend available bytes: total × overcommit − used when computable.
 * With `ownerUsedBytes`, what that owner can still add: overcommit is shared
 * across owners, one owner's volumes never exceed the physical total.
 */
export function sharedBackendAvailableBytes(
  backend: {
    totalBytes: number | null;
    usedBytes: number | null;
    overcommitRatio: number;
  },
  ownerUsedBytes?: number,
): number | null {
  if (backend.totalBytes === null || backend.usedBytes === null) return null;
  if (!Number.isFinite(backend.overcommitRatio) || backend.overcommitRatio < 1) return null;
  const shared = backend.totalBytes * backend.overcommitRatio - backend.usedBytes;
  const own = ownerUsedBytes === undefined ? shared : backend.totalBytes - ownerUsedBytes;
  return Math.max(0, Math.min(shared, own));
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

/** Bytes for tight spots (chart axes, meters): one decimal from GiB up, whole below. */
export function formatBytesCompact(bytes: number): string {
  const { value, unit } = scaleBytes(Math.abs(bytes), (scale) => (scale === 'KiB' || scale === 'MiB' ? 0 : 1));
  return `${bytes < 0 ? '-' : ''}${value} ${unit}`;
}

/** Bytes per second for performance charts and occupancy lines. */
export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec)) return '—';
  const { value, unit } = scaleBytes(Math.abs(bytesPerSec), 1);
  const text = unit === 'B' || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${bytesPerSec < 0 ? '-' : ''}${text} ${unit}/s`;
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
