import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PatchServerRequest, ServerDto, StoragePoolDto } from '@nyabase/common';
import { toast } from '../hooks/use-toast.js';
import { api } from './api.js';
import { errorMessage } from './api-error.js';
import { queryKeys } from './query-keys.js';

/** Storage pools of one server (administrator view). */
export function useServerPools(serverId: string) {
  return useQuery({
    queryKey: queryKeys.servers.pools(serverId, 'all'),
    queryFn: () => api.get<StoragePoolDto[]>(`/servers/${serverId}/storage-pools?scope=all`),
  });
}

/** Refresh the server, its pools and its preflight after a change. */
export function useInvalidateServer(serverId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.detail(serverId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.pools(serverId, 'all') });
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.preflight(serverId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
  };
}

export function useUpdateServer(serverId: string, onSaved?: () => void) {
  const invalidate = useInvalidateServer(serverId);
  return useMutation({
    mutationFn: (body: PatchServerRequest) => api.patch<ServerDto>(`/servers/${serverId}`, body),
    onSuccess: () => {
      onSaved?.();
      toast({ title: '服务器设置已更新' });
      invalidate();
    },
    onError: (error) => toast({ title: '更新失败', description: errorMessage(error), variant: 'destructive' }),
  });
}
