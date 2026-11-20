import { RootPlacement, type ServerDto, type StoragePoolDto } from '@nyabase/common';

/** How the server places new root disks, in words. */
export function rootPlacementLabel(server: Pick<ServerDto, 'rootPlacement' | 'rootPlacementSticky'>): string {
  if (server.rootPlacement === RootPlacement.Single) return '单一（只有一个系统盘池）';
  return server.rootPlacementSticky
    ? '随机 · 用户粘性（用户已有容器时放到他系统盘最多的池）'
    : '随机（按权重在系统盘池中挑选）';
}

/** Why the pool cannot be a system disk; null when it can. */
export function systemDiskUnsupportedReason(
  pool: Pick<StoragePoolDto, 'registered' | 'rootDiskCapable' | 'shareable'>,
): string | null {
  if (!pool.registered) return '存储池尚未登记，登记后才能作为系统盘。';
  if (!pool.rootDiskCapable || pool.shareable) return '这个存储池不能放容器系统盘。';
  return null;
}

/** Observed used / total in percent (rounded down); null while either is unknown. */
export function poolUsedPercent(pool: Pick<StoragePoolDto, 'usedBytes' | 'totalBytes'>): number | null {
  if (pool.usedBytes === null || pool.totalBytes === null || pool.totalBytes <= 0) return null;
  return Math.floor((pool.usedBytes * 100) / pool.totalBytes);
}

/** True when new root disks skip the pool because its usage reached the high-water mark (the backend rule). */
export function aboveSystemWatermark(pool: Pick<StoragePoolDto, 'systemDisk' | 'usedBytes' | 'totalBytes'>): boolean {
  const mark = pool.systemDisk?.maxUsedPercent ?? null;
  if (mark === null || pool.usedBytes === null || pool.totalBytes === null) return false;
  if (pool.totalBytes <= 0) return true;
  return pool.usedBytes * 100 >= mark * pool.totalBytes;
}

/** A 1..100 integer from a text box; '' = null when `blankIsNull`; undefined when invalid. */
export function parsePercentInput(text: string, blankIsNull: boolean): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return blankIsNull ? null : undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= 100 ? value : undefined;
}
