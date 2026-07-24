import type { ContainerView, DataDirDto } from '@nyabase/common';

export function containerUsesDataDir(
  container: Pick<ContainerView, 'serverId' | 'mounts'>,
  dataDir: Pick<DataDirDto, 'serverId' | 'sourceKind' | 'sourceId' | 'name'>,
): boolean {
  if (dataDir.sourceKind === 'local' && container.serverId !== dataDir.serverId) return false;
  return container.mounts.some((mount) =>
    mount.sourceKind === dataDir.sourceKind
    && mount.sourceId === dataDir.sourceId
    && mount.dirName === dataDir.name,
  );
}
