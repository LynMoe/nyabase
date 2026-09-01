import type { ContainerDto, SharedVolumeDto, VolumeDto } from '@nyabase/common';

/**
 * Local volumes the attach API will accept: same owner, not deleting/failed, not
 * already attached, and only on the container's server. Shared volumes use
 * filterAttachableSharedVolumes against GET ?attachableOnServerId=.
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
    if (volume.serverId !== container.serverId) return false;
    return true;
  });
}

export function filterAttachableSharedVolumes(
  volumes: readonly SharedVolumeDto[],
  container: Pick<ContainerDto, 'ownerId'>,
  attachedVolumeIds: ReadonlySet<string>,
): SharedVolumeDto[] {
  return volumes.filter((volume) => {
    if (attachedVolumeIds.has(volume.id)) return false;
    if (volume.lifecyclePhase === 'deleting' || volume.lifecyclePhase === 'failed') return false;
    if (volume.ownerId !== container.ownerId) return false;
    return true;
  });
}
