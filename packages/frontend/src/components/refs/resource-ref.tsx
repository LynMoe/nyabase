import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Capability,
  type AdminImageDto,
  type ContainerDto,
  type GroupDto,
  type ServerDto,
  type SharedBackendDto,
  type SharedVolumeDto,
  type StoragePoolDto,
  type UserDto,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { useAuthStore } from '../../store/auth.js';
import { TechnicalId } from './technical-id.js';
import type { ResourceRefProps } from './types.js';

type CatalogUser = {
  id: string;
  username: string;
  displayName: string;
  status: string;
};

const USER_NAME_CACHE_KEY = ['resource-names', 'user'] as const;

function hasAny(capabilities: readonly string[], ...needed: Capability[]): boolean {
  return needed.some((cap) => capabilities.includes(cap));
}

function userLabel(row: { displayName?: string | null; username?: string | null } | undefined): string | undefined {
  if (!row) return undefined;
  return row.displayName || row.username || undefined;
}

function backendLabel(row: Pick<SharedBackendDto, 'displayName' | 'name'> | undefined): string | undefined {
  if (!row) return undefined;
  return row.displayName ?? row.name;
}

function poolLabel(row: Pick<StoragePoolDto, 'displayName' | 'incusName'> | undefined): string | undefined {
  if (!row) return undefined;
  return row.displayName ?? row.incusName;
}

function providedName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed || undefined;
}

function RefLabel({ id, name }: { id: string; name: string | undefined }) {
  if (!id) return <span>—</span>;
  if (name) {
    return (
      <TechnicalId
        label={name}
        value={id}
        kind="opaque"
        visible={name}
        className="inline-flex max-w-full truncate text-left"
      />
    );
  }
  return <TechnicalId label="标识" value={id} kind="opaque" />;
}

function useCapabilities(): readonly string[] {
  return useAuthStore((state) => state.user?.capabilities ?? []);
}

export function ResourceRef({ kind, id, name }: ResourceRefProps) {
  switch (kind) {
    case 'user':
      return <UserRef id={id} name={name} />;
    case 'group':
      return <GroupRef id={id} name={name} />;
    case 'server':
      return <ServerRef id={id} name={name} />;
    case 'container':
      return <ContainerRef id={id} name={name} />;
    case 'volume':
      return <VolumeRef id={id} name={name} />;
    case 'shared-volume':
      return <SharedVolumeRef id={id} name={name} />;
    case 'image':
      return <ImageRef id={id} name={name} />;
    case 'pool':
      return <PoolRef id={id} name={name} />;
    case 'shared-backend':
      return <SharedBackendRef id={id} name={name} />;
  }
}

function UserRef({ id, name }: { id: string; name?: string }) {
  const queryClient = useQueryClient();
  const caps = useCapabilities();
  const currentUser = useAuthStore((state) => state.user);
  const explicit = providedName(name);
  const selfName = currentUser?.id === id ? userLabel(currentUser) : undefined;
  const hasCatalog = hasAny(caps, Capability.ManageUsers, Capability.ManageGroups, Capability.ManageGrants);
  const hasUsersList = hasAny(caps, Capability.ManageUsers, Capability.ManageGrants);
  const skipFetch = Boolean(explicit || selfName);

  const catalogQuery = useQuery({
    queryKey: queryKeys.catalog.users,
    queryFn: () => api.get<CatalogUser[]>('/admin/catalog/users'),
    enabled: Boolean(id) && !skipFetch && hasCatalog,
  });
  const usersQuery = useQuery({
    queryKey: queryKeys.users.admin,
    queryFn: () => api.get<UserDto[]>('/admin/users'),
    enabled: Boolean(id) && !skipFetch && !hasCatalog && hasUsersList,
  });
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerDto[]>('/admin/containers'),
    enabled: false,
  });

  useEffect(() => {
    const list = containersQuery.data;
    if (!list) return;
    const names: Record<string, string> = {};
    for (const container of list) {
      if (container.ownerName) names[container.ownerId] = container.ownerName;
    }
    if (Object.keys(names).length === 0) return;
    queryClient.setQueryData<Record<string, string>>(USER_NAME_CACHE_KEY, (current) => ({
      ...current,
      ...names,
    }));
  }, [containersQuery.data, queryClient]);

  const ownerNameCache = useQuery({
    queryKey: USER_NAME_CACHE_KEY,
    queryFn: () => ({} as Record<string, string>),
    enabled: false,
    staleTime: Infinity,
  });

  const resolved = explicit
    ?? selfName
    ?? userLabel(catalogQuery.data?.find((row) => row.id === id))
    ?? userLabel(usersQuery.data?.find((row) => row.id === id))
    ?? ownerNameCache.data?.[id]
    ?? containersQuery.data?.find((row) => row.ownerId === id)?.ownerName
    ?? undefined;

  return <RefLabel id={id} name={resolved} />;
}

function GroupRef({ id, name }: { id: string; name?: string }) {
  const caps = useCapabilities();
  const explicit = providedName(name);
  const query = useQuery({
    queryKey: queryKeys.groups.admin,
    queryFn: () => api.get<GroupDto[]>('/admin/groups'),
    enabled: Boolean(id) && !explicit && hasAny(caps, Capability.ManageGroups, Capability.ManageGrants),
  });
  return <RefLabel id={id} name={explicit ?? query.data?.find((row) => row.id === id)?.name} />;
}

function ServerRef({ id, name }: { id: string; name?: string }) {
  const caps = useCapabilities();
  const explicit = providedName(name);
  const listQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
    enabled: Boolean(id) && !explicit && hasAny(caps, Capability.ManageServers),
  });
  const grantTargetsQuery = useQuery({
    queryKey: queryKeys.grants.targets.servers,
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
    enabled: false,
  });
  const row = listQuery.data?.find((item) => item.id === id)
    ?? grantTargetsQuery.data?.find((item) => item.id === id);
  return <RefLabel id={id} name={explicit ?? row?.name} />;
}

function ContainerRef({ id, name }: { id: string; name?: string }) {
  const caps = useCapabilities();
  const explicit = providedName(name);
  const query = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerDto[]>('/admin/containers'),
    enabled: Boolean(id) && !explicit && hasAny(caps, Capability.ManageContainersAny),
  });
  return <RefLabel id={id} name={explicit ?? query.data?.find((row) => row.id === id)?.name} />;
}

function VolumeRef({ id, name }: { id: string; name?: string }) {
  const caps = useCapabilities();
  const explicit = providedName(name);
  const query = useQuery({
    queryKey: queryKeys.volumes.admin,
    queryFn: () => api.get<VolumeDto[]>('/admin/volumes'),
    enabled: Boolean(id) && !explicit && hasAny(caps, Capability.ManageVolumes),
  });
  return <RefLabel id={id} name={explicit ?? query.data?.find((row) => row.id === id)?.name} />;
}

function SharedVolumeRef({ id, name }: { id: string; name?: string }) {
  const caps = useCapabilities();
  const explicit = providedName(name);
  const query = useQuery({
    queryKey: queryKeys.sharedVolumes.admin,
    queryFn: () => api.get<SharedVolumeDto[]>('/admin/shared-volumes'),
    enabled: Boolean(id) && !explicit && hasAny(caps, Capability.ManageSharedVolumes),
  });
  return <RefLabel id={id} name={explicit ?? query.data?.find((row) => row.id === id)?.name} />;
}

function ImageRef({ id, name }: { id: string; name?: string }) {
  const caps = useCapabilities();
  const explicit = providedName(name);
  const query = useQuery({
    queryKey: queryKeys.images.admin,
    queryFn: () => api.get<AdminImageDto[]>('/admin/images'),
    enabled: Boolean(id) && !explicit && hasAny(caps, Capability.ManageImages),
  });
  return <RefLabel id={id} name={explicit ?? query.data?.find((row) => row.id === id)?.alias} />;
}

function PoolRef({ id, name }: { id: string; name?: string }) {
  const queryClient = useQueryClient();
  const explicit = providedName(name);
  const grantPoolsQuery = useQuery({
    queryKey: queryKeys.grants.targets.pools,
    queryFn: () => Promise.resolve([] as StoragePoolDto[]),
    enabled: false,
  });
  const cached = queryClient.getQueriesData<StoragePoolDto[]>({
    predicate: (query) => {
      const root = query.queryKey[0];
      return root === 'storage-pools'
        || (root === 'grant-targets' && query.queryKey[1] === 'pools')
        || (root === 'volume-form' && query.queryKey[1] === 'pools');
    },
  });
  const fromGrant = grantPoolsQuery.data?.find((row) => row.id === id);
  const fromCached = cached
    .flatMap(([, list]) => (Array.isArray(list) ? list : []))
    .find((row) => row.id === id);
  return <RefLabel id={id} name={explicit ?? poolLabel(fromGrant) ?? poolLabel(fromCached)} />;
}

function SharedBackendRef({ id, name }: { id: string; name?: string }) {
  const caps = useCapabilities();
  const explicit = providedName(name);
  const listQuery = useQuery({
    queryKey: queryKeys.sharedBackends.admin,
    queryFn: () => api.get<SharedBackendDto[]>('/admin/shared-backends'),
    enabled: Boolean(id) && !explicit && hasAny(caps, Capability.ManageSharedBackends, Capability.ManageGrants),
  });
  const grantTargetsQuery = useQuery({
    queryKey: queryKeys.grants.targets.backends,
    queryFn: () => api.get<SharedBackendDto[]>('/admin/shared-backends'),
    enabled: false,
  });
  const row = listQuery.data?.find((item) => item.id === id)
    ?? grantTargetsQuery.data?.find((item) => item.id === id);
  return <RefLabel id={id} name={explicit ?? backendLabel(row)} />;
}

export type { ResourceKind, ResourceRefProps } from './types.js';
