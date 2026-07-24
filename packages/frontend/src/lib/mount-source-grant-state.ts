import type { MountSourceGrantDto } from '@nyabase/common';

export interface GrantDiskInventoryItem {
  diskId: string;
  serverId: string;
  sourceIdentity: string;
}

export function exactLocalGrantKey(
  serverId: string,
  diskId: string,
  sourceIdentity: string | null,
): string {
  return `local:${serverId}:${diskId}:${sourceIdentity ?? ''}`;
}

export function classifyOrphanedLocalGrants(
  grants: MountSourceGrantDto[],
  disks: GrantDiskInventoryItem[],
): MountSourceGrantDto[] {
  const liveByLogicalKey = new Map(disks.map((disk) => [`${disk.serverId}:${disk.diskId}`, disk]));
  return grants.filter((grant) => {
    if (grant.sourceKind !== 'local' || !grant.serverId) return false;
    const live = liveByLogicalKey.get(`${grant.serverId}:${grant.sourceId}`);
    return !live || !grant.sourceIdentity || live.sourceIdentity !== grant.sourceIdentity;
  });
}
