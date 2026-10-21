import { useMemo } from 'react';
import {
  ContainerStatus,
  type ContainerDto,
  type ListScope,
  type VolumeAttachmentDto,
} from '@nyabase/common';
import { OverviewPanel } from '../../components/containers/overview-panel.js';
import { StoragePanel } from '../../components/containers/storage-panel.js';
import { QueryView } from '../../components/layout/query-view.js';
import { filterAttachableSharedVolumes, filterAttachableVolumes } from '../../lib/attachable-volumes.js';
import type { ContainerDetailActions } from './use-container-detail-actions.js';
import type { ContainerDetailData } from './use-container-detail-data.js';

/** The overview tab: resource panel plus the storage panel (root disk and volumes). */
export function ContainerOverviewTab({
  container,
  scope,
  data,
  actions,
  onDetachRequest,
  onRootRequiresStop,
}: {
  container: ContainerDto;
  scope: ListScope;
  data: ContainerDetailData;
  actions: ContainerDetailActions;
  onDetachRequest: (attachment: VolumeAttachmentDto) => void;
  onRootRequiresStop: (sizeBytes: number) => void;
}) {
  const {
    admin,
    canManageVolumes,
    canManageSharedVolumes,
    canViewMetrics,
    attachmentsQuery,
    volumesQuery,
    sharedVolumesQuery,
  } = data;
  const attachments = attachmentsQuery.data
    ?? [...container.volumes, ...container.sharedVolumes];
  const attachedVolumeIds = useMemo(
    () => new Set(attachments.map((attachment) => attachment.volumeId)),
    [attachments],
  );
  const canMutateLocal = !admin || canManageVolumes;
  const canMutateShared = !admin || canManageSharedVolumes;
  const showSharedVolumes = canMutateShared && Boolean(container.serverId);

  return (
    <>
      <OverviewPanel
        container={container}
        scope={scope}
        gpuEnabled={data.serverQuery.data?.gpuEnabled ?? false}
        gpuGrant={data.gpuGrant}
        onRepairSsh={() => actions.repairSsh.mutate()}
        repairPending={actions.repairSsh.isPending}
        onLimits={(body) => actions.updateLimits.mutateAsync(body)}
        limitsPending={actions.updateLimits.isPending}
        onGpuSubmit={(pciAddresses) => actions.updateGpus.mutateAsync(pciAddresses)}
        gpuPending={actions.updateGpus.isPending}
        occupancy={data.occupancyQuery.data}
        occupancyDenied={admin && !canViewMetrics}
      />
      <QueryView
        queries={[
          attachmentsQuery,
          ...(canMutateLocal ? [volumesQuery] : []),
          ...(showSharedVolumes ? [sharedVolumesQuery] : []),
        ]}
        resourceNames={[
          '挂载',
          ...(canMutateLocal ? ['数据卷'] : []),
          ...(showSharedVolumes ? ['共享卷'] : []),
        ]}
        loadingLabel="加载存储..."
      >
        {() => (
          <StoragePanel
            container={container}
            rootCapability={container.rootCapability}
            attachments={attachmentsQuery.data ?? []}
            localVolumes={filterAttachableVolumes(
              volumesQuery.data ?? [],
              container,
              attachedVolumeIds,
            )}
            sharedVolumes={filterAttachableSharedVolumes(
              sharedVolumesQuery.data ?? [],
              container,
              attachedVolumeIds,
            )}
            onAttachLocal={(body) => actions.attachLocal.mutateAsync(body)}
            onAttachShared={(body) => actions.attachShared.mutateAsync(body)}
            onDetachRequest={onDetachRequest}
            usages={[
              ...(volumesQuery.data ?? []).map((volume) => ({
                id: volume.id,
                sizeBytes: volume.sizeBytes,
                usedBytes: volume.usedBytes,
              })),
              ...(sharedVolumesQuery.data ?? []).map((volume) => ({
                id: volume.id,
                sizeBytes: volume.sizeBytes,
                usedBytes: volume.usedBytes,
              })),
            ]}
            onRootApply={(sizeBytes) => actions.resizeRoot.mutateAsync({ sizeBytes })}
            onRootRequiresStop={onRootRequiresStop}
            pending={
              actions.attachLocal.isPending
              || actions.attachShared.isPending
              || actions.detach.isPending
            }
            rootPending={actions.resizeRoot.isPending}
            canMutateLocal={canMutateLocal}
            canMutateShared={canMutateShared}
            localAttachBlockedReason={admin && !canManageVolumes
              ? '挂载与卸载本地数据卷需要「管理本地数据卷」权限；当前账号可以管理容器，但无法列出或挂载本地数据卷。'
              : null}
            sharedAttachBlockedReason={admin && !canManageSharedVolumes
              ? '挂载与卸载共享卷需要「管理共享卷」权限；当前账号可以管理容器，但无法列出或挂载共享卷。'
              : null}
            running={container.actual.status === ContainerStatus.Running}
            allowCreateVolume={!admin}
          />
        )}
      </QueryView>
    </>
  );
}
