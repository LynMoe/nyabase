import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function formatCpu(millis: number): string {
  if (millis === 0) return '不限制';
  if (millis >= 1000) return `${(millis / 1000).toFixed(1)} vCPU`;
  return `${millis}m`;
}

export function formatBytesLimit(bytes: number): string {
  return bytes === 0 ? '不限制' : formatBytes(bytes);
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatBytesCompact(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)}T`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

/** Human-readable data disk title: prefer admin label, else last path segment (no leading slash). */
export function dataDiskDisplayName(mountPoint: string, label?: string | null): string {
  const t = label?.trim();
  if (t) return t;
  const trimmed = mountPoint.replace(/\/+$/, '');
  const seg = trimmed.split('/').filter(Boolean).pop();
  return seg ?? mountPoint;
}

/**
 * Format a nullable resource limit for display.
 * Falls back to serverDefault when null; shows '不限' when the resolved value is 0.
 */
export function resourceVal(
  value: number | null,
  serverDefault: number,
  fmt: (n: number) => string,
): string {
  const v = value ?? serverDefault;
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
