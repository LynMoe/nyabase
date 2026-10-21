import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ContainerDto,
  EffectiveAccessDto,
  ImageDto,
  StorageCapacityDto,
  UserServerDto,
} from '@nyabase/common';
import { api } from '../../../lib/api.js';
import { queryKeys } from '../../../lib/query-keys.js';

/**
 * What the create form can choose from: servers the user currently has access
 * to, the images allowed on the chosen server, and the quota left there.
 */
export function useCreateContainerData(open: boolean, serverId: string) {
  const serversQuery = useQuery({ queryKey: queryKeys.servers.user, queryFn: () => api.get<UserServerDto[]>('/servers'), enabled: open });
  const imagesQuery = useQuery({ queryKey: queryKeys.images.userActive, queryFn: () => api.get<ImageDto[]>('/images?activeOnly=true'), enabled: open });
  const accessQuery = useQuery({ queryKey: queryKeys.meAccess, queryFn: () => api.get<EffectiveAccessDto>('/me/access'), enabled: open });
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    enabled: open,
  });
  const capacityQuery = useQuery({
    queryKey: queryKeys.storageCapacity(serverId),
    queryFn: () => api.get<StorageCapacityDto>(`/servers/${serverId}/storage-capacity`),
    enabled: open && serverId.length > 0,
  });

  const liveServerIds = useMemo(() => new Set(
    (accessQuery.data?.servers ?? []).filter((server) => server.accessPhase === 'live').map((server) => server.serverId),
  ), [accessQuery.data]);
  const servers = useMemo(
    () => (serversQuery.data ?? []).filter((server) => server.status === 'online' && liveServerIds.has(server.id)),
    [serversQuery.data, liveServerIds],
  );
  const selectedAccess = accessQuery.data?.servers.find((server) => server.serverId === serverId);
  const images = useMemo(() => {
    const allowed = new Set(selectedAccess?.allowedImageIds ?? []);
    return (imagesQuery.data ?? []).filter((image) => allowed.has(image.id));
  }, [imagesQuery.data, selectedAccess]);

  return {
    imagesQuery,
    containersQuery,
    capacityQuery,
    servers,
    images,
    selectedAccess,
    serversLoading: open && (serversQuery.isLoading || accessQuery.isLoading),
  };
}
