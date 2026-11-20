import type { GrantBundlePreviewEntryDto, GrantBundleQuotas } from '@nyabase/common';
import { sameDataDisks } from './grant-fields.js';

export type DiskEntryWarnings = Pick<
  GrantBundlePreviewEntryDto,
  'rootDiskBytesInUse' | 'diskBytesInUse' | 'dataDisksRevoked' | 'dataDisksOverCap'
>;

/**
 * What one grant holds that a bundle change no longer covers, on disks:
 * system disks over a smaller ceiling, system disks plus data over a smaller
 * total (data only counts on the disks the grant keeps), volumes on data
 * disks leaving the list (they lapse) and data over a lowered ceiling. Each
 * warning is about the change: a grant that was already over keeps no new
 * warning unless the change touches that limit.
 */
export function diskEntryWarnings(input: {
  before: GrantBundleQuotas;
  after: GrantBundleQuotas;
  /** Committed system disks of the user on the server. */
  rootBytes: number;
  /** Data on the user's live volumes of the server, by pool (a volume without usage counts 0). */
  dataByPool: ReadonlyMap<string, number>;
}): DiskEntryWarnings {
  const { before, after, rootBytes, dataByPool } = input;
  const result: DiskEntryWarnings = {
    rootDiskBytesInUse: null,
    diskBytesInUse: null,
    dataDisksRevoked: [],
    dataDisksOverCap: [],
  };
  if (after.rootDiskBytes !== null && rootBytes > after.rootDiskBytes && after.rootDiskBytes !== before.rootDiskBytes) {
    result.rootDiskBytesInUse = rootBytes;
  }
  const listChanged = !sameDataDisks(before.dataDisks, after.dataDisks);
  const charged = rootBytes + after.dataDisks.reduce((sum, disk) => sum + (dataByPool.get(disk.poolId) ?? 0), 0);
  if (charged > after.diskBytes && (after.diskBytes !== before.diskBytes || listChanged)) {
    result.diskBytesInUse = charged;
  }
  const kept = new Set(after.dataDisks.map((disk) => disk.poolId));
  result.dataDisksRevoked = before.dataDisks
    .map((disk) => disk.poolId)
    .filter((poolId) => !kept.has(poolId) && dataByPool.has(poolId))
    .sort();
  const capBefore = new Map(before.dataDisks.map((disk) => [disk.poolId, disk.capBytes]));
  for (const disk of after.dataDisks) {
    const used = dataByPool.get(disk.poolId);
    if (disk.capBytes === null || used === undefined || used <= disk.capBytes) continue;
    if (capBefore.has(disk.poolId) && capBefore.get(disk.poolId) === disk.capBytes) continue;
    result.dataDisksOverCap.push({ poolId: disk.poolId, usedBytes: used, capBytes: disk.capBytes });
  }
  result.dataDisksOverCap.sort((left, right) => (left.poolId < right.poolId ? -1 : 1));
  return result;
}
