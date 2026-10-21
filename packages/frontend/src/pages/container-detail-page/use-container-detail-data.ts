import { useQuery } from '@tanstack/react-query';
import {
  Capability,
  IntentResourceType,
  type ListScope,
  type ContainerDto,
  type CursorPaginatedResponse,
  type EffectiveAccessDto,
  type IntentDto,
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

import type { DetailTab } from './tabs.js';

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
