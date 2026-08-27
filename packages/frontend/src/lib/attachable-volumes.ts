import type { ContainerDto, VolumeDto } from '@nyabase/common';

/**
 * Volumes the attach API will accept: same owner, not deleting/failed, not already
 * attached, and local volumes only on the container's server. Cross-owner attach
 * is forbidden even for ManageContainersAny.
 */
export function filterAttachableVolumes(
  volumes: readonly VolumeDto[],
  container: Pick<ContainerDto, 'ownerId' | 'serverId'>,
  attachedVolumeIds: ReadonlySet<string>,
): VolumeDto[] {
  return volumes.filter((volume) => {
    if (attachedVolumeIds.has(volume.id)) return false;
    if (volume.lifecyclePhase === 'deleting' || volume.lifecyclePhase === 'failed') return false;
    if (volume.ownerId !== container.ownerId) return false;
    if (volume.serverId !== null && volume.serverId !== container.serverId) return false;
    return true;
  });
}
