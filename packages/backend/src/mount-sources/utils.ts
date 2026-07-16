import type { DiskInfo } from '@nyabase/common';

export function dataDiskDisplayName(mountPoint: string, label: string | null | undefined): string {
  if (label) return label;
  const parts = mountPoint.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? mountPoint;
}

/** A disk id is authoritative only when one exact, physically identified row exists. */
export function exactLocalDisk(disks: readonly DiskInfo[], diskId: string): DiskInfo | null {
  const matches = disks.filter((disk) => disk.diskId === diskId);
  if (matches.length !== 1 || matches[0]!.sourceIdentity.trim() === '') return null;
  return matches[0]!;
}
