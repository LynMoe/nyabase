import type { GrantDataDisk } from '@nyabase/common';
import { formatBytes, formatGibInput, GIB } from './utils.js';

/**
 * The data-disk list of a bundle or grant form: the chosen local pools in
 * order, each with the text of its 上限 input ('' = 只受总额限制).
 */
export type DataDiskDraft = Array<{ poolId: string; capText: string }>;

/** The text of a data disk's 上限 input; '' = 只受总额限制. */
export function capToText(capBytes: number | null): string {
  return capBytes === null ? '' : formatGibInput(capBytes);
}

/** A 上限 text: '' → null (只受总额限制), a positive GiB amount → bytes, anything else → undefined. */
export function parseCapText(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  const bytes = Math.round(value * GIB);
  return bytes > 0 ? bytes : undefined;
}

export function capTextError(text: string): string | null {
  return parseCapText(text) === undefined ? '请输入大于 0 的数值，或留空' : null;
}

export function dataDiskDraftFrom(disks: readonly GrantDataDisk[] = []): DataDiskDraft {
  return disks.map((disk) => ({ poolId: disk.poolId, capText: capToText(disk.capBytes) }));
}

/**
 * The list a draft stands for, or undefined while a 上限 is invalid. A text
 * still reading as a ceiling the draft was filled from (`known`: the stored
 * list, the bundle's) keeps that exact value: GiB inputs show at most 3
 * decimals, so re-parsing would turn an untouched ceiling into a change.
 */
export function parseDataDiskDraft(
  draft: DataDiskDraft,
  ...known: Array<readonly GrantDataDisk[] | undefined>
): GrantDataDisk[] | undefined {
  const result: GrantDataDisk[] = [];
  for (const row of draft) {
    const kept = known
      .flatMap((list) => list ?? [])
      .find((disk) => disk.poolId === row.poolId && capToText(disk.capBytes) === row.capText.trim());
    const capBytes = kept ? kept.capBytes : parseCapText(row.capText);
    if (capBytes === undefined) return undefined;
    result.push({ poolId: row.poolId, capBytes });
  }
  return result;
}

/** The same disks with the same ceilings, in any order. */
export function sameDataDisks(left: readonly GrantDataDisk[], right: readonly GrantDataDisk[]): boolean {
  if (left.length !== right.length) return false;
  const caps = new Map(left.map((disk) => [disk.poolId, disk.capBytes]));
  return right.every((disk) => caps.has(disk.poolId) && caps.get(disk.poolId) === disk.capBytes);
}

/** Tick or untick a pool; a pool ticked again starts without a ceiling. */
export function toggleDataDisk(draft: DataDiskDraft, poolId: string, on: boolean): DataDiskDraft {
  if (!on) return draft.filter((row) => row.poolId !== poolId);
  return draft.some((row) => row.poolId === poolId) ? draft : [...draft, { poolId, capText: '' }];
}

export function setDataDiskCap(draft: DataDiskDraft, poolId: string, capText: string): DataDiskDraft {
  return draft.map((row) => (row.poolId === poolId ? { ...row, capText } : row));
}

/** What a list change does: disks added, removed (their volumes lapse), and ceilings changed. */
export function diffDataDisks(
  before: readonly GrantDataDisk[],
  after: readonly GrantDataDisk[],
): {
  added: GrantDataDisk[];
  removed: GrantDataDisk[];
  capChanged: Array<{ poolId: string; before: number | null; after: number | null }>;
} {
  const old = new Map(before.map((disk) => [disk.poolId, disk.capBytes]));
  const next = new Set(after.map((disk) => disk.poolId));
  return {
    added: after.filter((disk) => !old.has(disk.poolId)),
    removed: before.filter((disk) => !next.has(disk.poolId)),
    capChanged: after
      .filter((disk) => old.has(disk.poolId) && old.get(disk.poolId) !== disk.capBytes)
      .map((disk) => ({ poolId: disk.poolId, before: old.get(disk.poolId) ?? null, after: disk.capBytes })),
  };
}

/** A data disk's ceiling for display: 「≤ 500 GiB」, or 只受总额限制. */
export function formatDiskCap(capBytes: number | null): string {
  return capBytes === null ? '只受总额限制' : `≤ ${formatBytes(capBytes)}`;
}

/** 「数据盘 3 块」 / 无数据盘: the disks share the grant's 磁盘总额, so there is no sum to show. */
export function dataDiskSummary(disks: readonly GrantDataDisk[]): string {
  return disks.length === 0 ? '无数据盘' : `数据盘 ${disks.length} 块`;
}
