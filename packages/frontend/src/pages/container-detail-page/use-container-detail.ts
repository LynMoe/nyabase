import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AttachVolumeRequest,
  Capability,
  type ContainerAction,
  type ContainerDto,
  type CursorPaginatedResponse,
  type EffectiveAccessDto,
  type IntentAcceptedDto,
  type IntentDto,
  IntentResourceType,
  type ListScope,
  type PatchContainerLimitsRequest,
  type PatchContainerRootSizeRequest,
  type PerformanceSelfResponse,
  type SharedVolumeDto,
  type UserServerDto,
  type VolumeAttachmentDto,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { bindInProgress, intentListSettled } from '../../lib/in-progress.js';
import { resourceIntentsPath } from '../../lib/intent-visibility.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval, refetchWhileInProgress } from '../../lib/query-lifecycle.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { useAuthStore } from '../../store/auth.js';
import { containerActionSubmittedTitle } from '../../lib/status-labels.js';
import { useActionMutation } from '../../hooks/use-action-mutation.js';

export type DetailTab = 'overview' | 'console';
export const DETAIL_TABS: DetailTab[] = ['overview', 'console'];

export function parseDetailTab(value: unknown): DetailTab {
  return DETAIL_TABS.includes(value as DetailTab) ? (value as DetailTab) : 'overview';
}

/**
 * Everything the container detail page reads: the container, its usage,
 * attachments, the volumes it could still attach, its server and (for owners)
 * the GPU grant. `scope` decides whether the owner or the administrator
 * endpoints and permissions apply.
 */
export function useContainerDetailData({
  containerId,
  scope,
  tab,
  intentsOpen,
}: {
  containerId: string;
  scope: ListScope;
  tab: DetailTab;
  intentsOpen: boolean;
}) {
  const admin = scope === 'all';
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageVolumes = capabilities.includes(Capability.ManageVolumes);
  const canViewMetrics = capabilities.includes(Capability.ViewMetricsAll);
  const canManageSharedVolumes = capabilities.includes(Capability.ManageSharedVolumes);
  const volumesEnabled = tab === 'overview' && (!admin || canManageVolumes || canManageSharedVolumes);

  const base = `/containers/${containerId}`;
  const containerQuery = useQuery({
    queryKey: queryKeys.containers.detail(scope, containerId),
    queryFn: () => api.get<ContainerDto>(base),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
  });
  const occupancyQuery = useQuery({
    queryKey: queryKeys.performance.self(scope, containerId),
    queryFn: () => api.get<PerformanceSelfResponse>(
      scopedPath('/performance/usage', scope, { containerId }),
    ),
    enabled: !admin || canViewMetrics,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const volumesQuery = useQuery({
    queryKey: admin ? queryKeys.volumes.admin : queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>(scopedPath('/volumes', scope)),
    enabled: volumesEnabled && (!admin || canManageVolumes),
  });
  const sharedVolumesQuery = useQuery({
    queryKey: [
      ...queryKeys.sharedVolumes.attachable(containerQuery.data?.serverId ?? ''),
      scope,
    ],
    queryFn: () => api.get<SharedVolumeDto[]>(
      scopedPath('/shared-volumes', scope, { attachableOnServerId: containerQuery.data!.serverId }),
    ),
    enabled: volumesEnabled
      && Boolean(containerQuery.data?.serverId)
      && (!admin || canManageSharedVolumes),
  });
  const intentsQuery = useQuery({
    queryKey: queryKeys.containers.intents(scope, containerId),
    queryFn: () => api.get<CursorPaginatedResponse<IntentDto>>(
      `${resourceIntentsPath(scope, IntentResourceType.Container, containerId)}&limit=50`,
    ),
    enabled: intentsOpen,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (data) => intentListSettled(data.items),
    }),
  });
  const attachmentsQuery = useQuery({
    queryKey: queryKeys.containers.attachments(scope, containerId),
    queryFn: async () => {
      const [local, shared] = await Promise.all([
        api.get<VolumeAttachmentDto[]>(`${base}/volumes`),
        api.get<VolumeAttachmentDto[]>(`${base}/shared-volumes`),
      ]);
      return [...local, ...shared];
    },
    enabled: tab === 'overview',
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (rows) => rows.every((row) => !bindInProgress(row.bindState)),
    }),
  });
  const serverQuery = useQuery({
    queryKey: queryKeys.servers.detail(containerQuery.data?.serverId ?? ''),
    queryFn: () => api.get<UserServerDto>(
      scopedPath(`/servers/${containerQuery.data!.serverId}`, scope),
    ),
    enabled: Boolean(containerQuery.data?.serverId),
  });
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
    enabled: !admin && Boolean(containerQuery.data?.serverId),
  });
  const c = containerQuery.data;
  const gpuPciAddresses = admin
    ? null
    : accessQuery.data?.servers.find((row) => row.serverId === c?.serverId)?.gpuPciAddresses ?? null;

  return {
    admin,
    base,
    canManageVolumes,
    canViewMetrics,
    canManageSharedVolumes,
    containerQuery,
    occupancyQuery,
    volumesQuery,
    sharedVolumesQuery,
    intentsQuery,
    attachmentsQuery,
    serverQuery,
    gpuGrant: gpuPciAddresses ? { pciAddresses: gpuPciAddresses } : null,
  };
}

export type ContainerDetailData = ReturnType<typeof useContainerDetailData>;

/** Every mutation the container detail page can submit; each refreshes the page data on success. */
export function useContainerDetailActions({
  containerId,
  scope,
  base,
  detachTarget,
  onDetached,
}: {
  containerId: string;
  scope: ListScope;
  base: string;
  detachTarget: VolumeAttachmentDto | null;
  onDetached: () => void;
}) {
  const queryClient = useQueryClient();
  const admin = scope === 'all';

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.detail(scope, containerId) });
    void queryClient.invalidateQueries({ queryKey: admin ? queryKeys.containers.adminList : queryKeys.containers.userList });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.attachments(scope, containerId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.intents(scope, containerId) });
  };

  const action = useActionMutation({
    mutationFn: (name: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'delete'>) =>
      api.post<IntentAcceptedDto>(`${base}/actions/${name}`),
    successTitle: (name) => containerActionSubmittedTitle(name),
    errorTitle: '容器操作失败',
    onSuccess: invalidate,
  });
  const updateLimits = useActionMutation({
    mutationFn: (body: PatchContainerLimitsRequest) => api.patch<IntentAcceptedDto>(`${base}/limits`, body),
    successTitle: '已提交规格更新，正在生效',
    errorTitle: '规格更新失败',
    onSuccess: invalidate,
  });
  const resizeRoot = useActionMutation({
    mutationFn: (body: PatchContainerRootSizeRequest) => api.patch<IntentAcceptedDto>(`${base}/root-size`, body),
    successTitle: '已提交系统盘调整，正在生效',
    errorTitle: '系统盘调整失败',
    onSuccess: invalidate,
  });
  const updateGpus = useActionMutation({
    mutationFn: (pciAddresses: string[]) =>
      api.patch<IntentAcceptedDto>(`${base}/gpus`, { pciAddresses }),
    successTitle: '已提交 GPU 更新，正在生效',
    errorTitle: 'GPU 更新失败',
    onSuccess: invalidate,
  });
  const attachLocal = useActionMutation({
    mutationFn: (body: AttachVolumeRequest) => api.post<IntentAcceptedDto>(`${base}/volumes`, body),
    successTitle: '已提交挂载，正在生效',
    errorTitle: '挂载失败',
    onSuccess: invalidate,
  });
  const attachShared = useActionMutation({
    mutationFn: (body: AttachVolumeRequest) => api.post<IntentAcceptedDto>(`${base}/shared-volumes`, body),
    successTitle: '已提交挂载，正在生效',
    errorTitle: '挂载失败',
    onSuccess: invalidate,
  });
  const detach = useActionMutation({
    mutationFn: (attachmentId: string) => {
      const path = detachTarget?.kind === 'shared' ? 'shared-volumes' : 'volumes';
      return api.delete<IntentAcceptedDto>(`${base}/${path}/${attachmentId}`);
    },
    successTitle: '已提交卸载，正在生效',
    errorTitle: '卸载失败',
    onSuccess: () => {
      onDetached();
      invalidate();
    },
  });
  const repairSsh = useActionMutation({
    mutationFn: () => api.post<{ woken: boolean }>(`${base}/actions/repair-ssh`),
    successTitle: '已提交 SSH 修复',
    errorTitle: 'SSH 修复失败',
    onSuccess: invalidate,
  });

  return {
    invalidate,
    action,
    updateLimits,
    resizeRoot,
    updateGpus,
    attachLocal,
    attachShared,
    detach,
    repairSsh,
  };
}

export type ContainerDetailActions = ReturnType<typeof useContainerDetailActions>;
