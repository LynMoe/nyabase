import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminImageDto, ContainerDto, ServerDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import type { PickerOption } from './id-picker.js';

type CatalogUser = { id: string; username: string; displayName: string; status: string };

/**
 * What a script scope can name: servers, images, owners and containers, from
 * the same admin lists (and cache entries) the rest of the app uses.
 */
export function useScopeOptions(enabled: boolean) {
  const servers = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
    enabled,
  });
  const images = useQuery({
    queryKey: queryKeys.images.admin,
    queryFn: () => api.get<AdminImageDto[]>('/images?scope=all'),
    enabled,
  });
  const users = useQuery({
    queryKey: queryKeys.catalog.users,
    queryFn: () => api.get<CatalogUser[]>('/admin/catalog/users'),
    enabled,
  });
  const containers = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerDto[]>('/containers?scope=all'),
    enabled,
  });

  return useMemo(() => ({
    servers: (servers.data ?? [])
      .map((server): PickerOption => ({ id: server.id, label: server.name, hint: server.slug !== server.name ? server.slug : undefined }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
    images: (images.data ?? [])
      .filter((image) => !image.deleting)
      .map((image): PickerOption => ({ id: image.id, label: image.alias, hint: image.isActive ? undefined : '已停用' }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
    users: (users.data ?? [])
      .map((user): PickerOption => ({
        id: user.id,
        label: user.displayName || user.username,
        hint: `@${user.username}${user.status === 'active' ? '' : '（已停用）'}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
    containers: (containers.data ?? [])
      .filter((container) => container.lifecyclePhase !== 'deleting')
      .map((container): PickerOption => ({
        id: container.id,
        label: container.name,
        hint: `${container.ownerDisplayName || container.ownerName || ''} · ${container.serverName}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
    loading: {
      servers: servers.isLoading,
      images: images.isLoading,
      users: users.isLoading,
      containers: containers.isLoading,
    },
  }), [servers.data, images.data, users.data, containers.data, servers.isLoading, images.isLoading, users.isLoading,
    containers.isLoading]);
}

export type ScopeOptions = ReturnType<typeof useScopeOptions>;
