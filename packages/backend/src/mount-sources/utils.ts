import type { DiskInfo } from '@nyabase/common';

export function dataDiskDisplayName(mountPoint: string, label: string | null | undefined): string {
  if (label) return label;
  const parts = mountPoint.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? mountPoint;
}

/** Never derive an ordinary-user label from a physical host path. */
export function publicDataDiskDisplayName(
  diskId: string,
  label: string | null | undefined,
): string {
  const safeLabel = label?.trim();
  if (safeLabel && safeLabel.length <= 128 && !/[\/\\\0\r\n]/.test(safeLabel)) {
    return safeLabel;
  }
  return `Local disk ${diskId}`;
}

/** A disk id is authoritative only when one exact, physically identified row exists. */
export function exactLocalDisk(disks: readonly DiskInfo[], diskId: string): DiskInfo | null {
  const matches = disks.filter((disk) => disk.diskId === diskId);
  if (matches.length !== 1 || matches[0]!.sourceIdentity.trim() === '') return null;
  return matches[0]!;
}
