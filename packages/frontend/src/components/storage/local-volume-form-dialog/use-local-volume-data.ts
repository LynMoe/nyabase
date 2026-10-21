import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IntentResourceType,
  type CreateVolumeRequest,
  type IntentAcceptedDto,
  type ListScope,
  type PatchVolumeRequest,
  type ServerDto,
  type StorageCapacityDto,
  type StoragePoolDto,
  type UserServerDto,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../../lib/api.js';
import { errorMessage } from '../../../lib/api-error.js';
import { queryKeys } from '../../../lib/query-keys.js';
import { toast } from '../../../hooks/use-toast.js';
import { isIntentAccepted, resourceIntentsPath, waitForResourceIntent } from '../../../lib/intent-visibility.js';

function storagePoolsPath(scope: ListScope, serverId: string): string {
  return `/servers/${serverId}/storage-pools${scope === 'all' ? '?scope=all' : ''}`;
}

function storageCapacityPath(scope: ListScope, serverId: string): string {
  return `/servers/${serverId}/storage-capacity${scope === 'all' ? '?scope=all' : ''}`;
}

/** The queries and mutations behind the local volume form. */
export function useLocalVolumeData({
  open,
  volume,
  scope,
  serverId,
  onSaved,
  onError,
}: {
  open: boolean;
  volume: VolumeDto | undefined;
  scope: ListScope;
  serverId: string;
  /** Called after a save succeeded and the lists were refreshed. */
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const editing = volume;

  const invalidateVolumeLists = () => {
    if (scope === 'all') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.admin });
    } else {
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.user });
    }
    void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
  };

  const serversQuery = useQuery({
    queryKey: queryKeys.volumeForm.servers,
    queryFn: () => api.get<Array<ServerDto | UserServerDto>>('/servers'),
    enabled: open && !editing && scope !== 'all',
  });
  const poolsQuery = useQuery({
    queryKey: scope === 'all'
      ? queryKeys.servers.pools(serverId, 'all')
      : queryKeys.volumeForm.pools(serverId),
    queryFn: () => api.get<StoragePoolDto[]>(storagePoolsPath(scope, serverId)),
    enabled: open && !editing && serverId.length > 0,
  });
  const capacityQuery = useQuery({
    queryKey: scope === 'all'
      ? (['storage-capacity', 'admin', serverId] as const)
      : queryKeys.storageCapacity(serverId),
    queryFn: () => api.get<StorageCapacityDto>(storageCapacityPath(scope, serverId)),
    enabled: open && serverId.length > 0,
  });
  const createLocal = useMutation({
    mutationFn: (body: CreateVolumeRequest) => api.post<unknown>('/volumes', body),
    onSuccess: () => {
      toast({ title: '创建已提交' });
      invalidateVolumeLists();
      onSaved();
    },
    onError: (mutationError) => onError(errorMessage(mutationError)),
  });
  const patch = useMutation({
    mutationFn: async (body: PatchVolumeRequest) => {
      const volumeId = volume?.id ?? '';
      const accepted = await api.patch<IntentAcceptedDto | VolumeDto>(`/volumes/${volumeId}`, body);
      if (isIntentAccepted(accepted)) {
        await waitForResourceIntent(resourceIntentsPath(scope, IntentResourceType.Volume, volumeId), accepted.intentId);
      }
    },
    onSuccess: () => {
      toast({ title: '已更新' });
      invalidateVolumeLists();
      onSaved();
    },
    onError: (mutationError) => {
      onError(errorMessage(mutationError));
      invalidateVolumeLists();
    },
  });

  return { serversQuery, poolsQuery, capacityQuery, createLocal, patch, invalidateVolumeLists };
}
