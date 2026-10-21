import {
  type ContainerDto,
  ContainerStatus,
  type ListScope,
  type VolumeAttachmentDto,
} from '@nyabase/common';
import { History } from 'lucide-react';
import { useMemo } from 'react';
import { ContainerActionBar } from '../../components/containers/container-action-bar.js';
import { PageHeader } from '../../components/layout/page-header.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { containerLifecyclePending, containerStatusPending } from '../../lib/in-progress.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';
import { OverviewPanel } from '../../components/containers/overview-panel.js';
import { StoragePanel } from '../../components/containers/storage-panel.js';
import { QueryView } from '../../components/layout/query-view.js';
import { filterAttachableSharedVolumes, filterAttachableVolumes } from '../../lib/attachable-volumes.js';
import type { ContainerDetailActions, ContainerDetailData } from './use-container-detail.js';

/** Container name with its status badges, breadcrumbs, the history button and the power actions. */
export function ContainerDetailHeader({
  container: c,
  admin,
  actionPending,
  onShowHistory,
  onAction,
}: {
  container: ContainerDto | undefined;
  admin: boolean;
  actionPending: boolean;
  onShowHistory: () => void;
  onAction: (name: 'start' | 'stop' | 'restart' | 'delete') => Promise<void>;
}) {
  const running = c?.actual.status === ContainerStatus.Running;
  return (
    <PageHeader
      title={
        c ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{c.name}</span>
            <StatusBadge
              label={containerStatusLabel(c.actual.status)}
              raw={c.actual.status}
              pending={containerStatusPending(c)}
              variant={running ? 'success' : c.needsAttention ? 'destructive' : 'secondary'}
            />
            {c.lifecyclePhase !== 'active' && (
              <StatusBadge
                label={lifecyclePhaseLabel(c.lifecyclePhase)}
                raw={c.lifecyclePhase}
                pending={containerLifecyclePending(c)}
                variant="warning"
              />
            )}
          </span>
        ) : '容器'
      }
      description={c ? c.serverName : undefined}
      crumbs={[
        admin
          ? { label: '全平台容器', to: '/manage/containers' }
          : { label: '容器', to: '/containers' },
        { label: c?.name ?? '…' },
      ]}
      actions={c ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9"
            data-testid="open-intent-history"
            onClick={onShowHistory}
          >
            <History className="h-4 w-4" />操作记录
          </Button>
          <ContainerActionBar
            container={c}
            layout="labeled"
            pending={actionPending}
            showDelete
            onAction={onAction}
          />
        </div>
      ) : undefined}
    />
  );
}

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
