import type { MouseEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AdminImageDto,
  Role,
  type ContainerDto,
  type ListScope,
  type ServerDto,
  type SharedBackendDto,
  type SharedVolumeDto,
  type StoragePoolDto,
  type UserServerDto,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { ACCESS, canAccess } from '../../lib/route-access.js';
import { useAuthStore } from '../../store/auth.js';
import { opaquePreview, type ResourceRefProps, TechnicalId } from './technical-id.js';

type CatalogUser = {
  id: string;
  username: string;
  displayName: string;
  status: string;
};

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
  // A known name reads as plain text where the viewer has no page to open; only an
  // unresolved ref falls back to the folded id.
  if (name) return <span className="inline-block max-w-full truncate align-bottom">{name}</span>;
  return <TechnicalId label="标识" value={id} kind="opaque" />;
}

const LINK_CLASS = 'inline-block max-w-full truncate align-bottom underline-offset-4 hover:underline';

/** Rows that open their own detail on click must not also fire. */
function keepRowClick(event: MouseEvent) {
  event.stopPropagation();
}

/** The label of a linked ref: its name, or the folded id while the name is unknown. */
function linkText(id: string, name: string | undefined): string {
  return name ?? opaquePreview(id);
}

function useRole(): Role | undefined {
  return useAuthStore((state) => state.user?.role);
}

/**
 * Which surface a container or volume ref opens: `all` the 全平台 pages, `mine`
 * the owner's. Without a scope, whoever may open the 全平台 page goes there.
 */
function useAdminSurface(scope: ListScope | undefined, rule: Role): boolean | null {
  const role = useRole();
  const admin = canAccess(role, rule);
  if (scope === 'mine') return false;
  if (scope === 'all') return admin ? true : null;
  return admin;
}

export function ResourceRef({ kind, id, name, username, scope, serverId }: ResourceRefProps) {
  switch (kind) {
    case 'user':
      return <UserRef id={id} name={name} username={username} />;
    case 'server':
      return <ServerRef id={id} name={name} />;
    case 'container':
      return <ContainerRef id={id} name={name} scope={scope} />;
    case 'volume':
      return <VolumeRef id={id} name={name} scope={scope} />;
    case 'shared-volume':
      return <SharedVolumeRef id={id} name={name} scope={scope} />;
    case 'image':
      return <ImageRef id={id} name={name} />;
    case 'pool':
      return <PoolRef id={id} name={name} serverId={serverId} />;
    case 'shared-backend':
      return <SharedBackendRef id={id} name={name} />;
  }
}

function UserRef({ id, name, username }: { id: string; name?: string; username?: string }) {
  const role = useRole();
  const currentUser = useAuthStore((state) => state.user);
  const explicit = providedName(name);
  const self = currentUser?.id === id ? currentUser : undefined;
  const hasCatalog = canAccess(role, Role.UserAdmin);

  const catalogQuery = useQuery({
    queryKey: queryKeys.catalog.users,
    queryFn: () => api.get<CatalogUser[]>('/admin/catalog/users'),
    enabled: Boolean(id) && hasCatalog && !((explicit && username) || self),
  });
  // Read-only: an admin list already in the cache names owners before the catalog lands.
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerDto[]>('/containers?scope=all'),
    enabled: false,
  });

  if (!id) return <span>—</span>;
  const row = catalogQuery.data?.find((item) => item.id === id);
  const owned = containersQuery.data?.find((item) => item.ownerId === id);
  const label = explicit
    ?? userLabel(self)
    ?? userLabel(row)
    ?? providedName(owned?.ownerDisplayName)
    ?? providedName(owned?.ownerName);
  const handle = providedName(username) ?? self?.username ?? row?.username ?? owned?.ownerName;
  if (!label) return <RefLabel id={id} name={undefined} />;
  const title = handle ? `@${handle}` : undefined;
  if (!canAccess(role, ACCESS.users)) {
    return <span className="inline-block max-w-full truncate align-bottom" title={title}>{label}</span>;
  }
  return (
    <Link to="/users/$id" params={{ id }} title={title} className={LINK_CLASS} onClick={keepRowClick}>
      {label}
    </Link>
  );
}

function ServerRef({ id, name }: { id: string; name?: string }) {
  const role = useRole();
  const explicit = providedName(name);
  const listQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
    enabled: Boolean(id) && !explicit && canAccess(role, Role.UserAdmin),
  });
  const grantTargetsQuery = useQuery({
    queryKey: queryKeys.grants.targets.servers,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
    enabled: false,
  });
  const userQuery = useQuery({
    queryKey: queryKeys.servers.user,
    queryFn: () => api.get<UserServerDto[]>('/servers'),
    enabled: false,
  });
  const resolved = explicit
    ?? listQuery.data?.find((item) => item.id === id)?.name
    ?? grantTargetsQuery.data?.find((item) => item.id === id)?.name
    ?? userQuery.data?.find((item) => item.id === id)?.name;
  if (!id || !canAccess(role, ACCESS.servers)) return <RefLabel id={id} name={resolved} />;
  return (
    <Link to="/servers/$id" params={{ id }} search={{ tab: 'overview' }} className={LINK_CLASS} onClick={keepRowClick}>
      {linkText(id, resolved)}
    </Link>
  );
}

function ContainerRef({ id, name, scope }: { id: string; name?: string; scope?: ListScope }) {
  const role = useRole();
  const explicit = providedName(name);
  const adminSurface = useAdminSurface(scope, ACCESS.manageContainers);
  const query = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerDto[]>('/containers?scope=all'),
    enabled: Boolean(id) && !explicit && canAccess(role, Role.UserAdmin),
  });
  const userQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    enabled: false,
  });
  const resolved = explicit
    ?? query.data?.find((row) => row.id === id)?.name
    ?? userQuery.data?.find((row) => row.id === id)?.name;
  if (!id || adminSurface === null) return <RefLabel id={id} name={resolved} />;
  return adminSurface ? (
    <Link
      to="/manage/containers/$containerId"
      params={{ containerId: id }}
      search={{ tab: 'overview' }}
      className={LINK_CLASS}
      onClick={keepRowClick}
    >
      {linkText(id, resolved)}
    </Link>
  ) : (
    <Link
      to="/containers/$containerId"
      params={{ containerId: id }}
      search={{ tab: 'overview' }}
      className={LINK_CLASS}
      onClick={keepRowClick}
    >
      {linkText(id, resolved)}
    </Link>
  );
}

function VolumeRef({ id, name, scope }: { id: string; name?: string; scope?: ListScope }) {
  const role = useRole();
  const explicit = providedName(name);
  const adminSurface = useAdminSurface(scope, ACCESS.manageVolumes);
  const query = useQuery({
    queryKey: queryKeys.volumes.admin,
    queryFn: () => api.get<VolumeDto[]>('/volumes?scope=all'),
    enabled: Boolean(id) && !explicit && canAccess(role, Role.UserAdmin),
  });
  const userQuery = useQuery({
    queryKey: queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>('/volumes'),
    enabled: false,
  });
  const resolved = explicit
    ?? query.data?.find((row) => row.id === id)?.name
    ?? userQuery.data?.find((row) => row.id === id)?.name;
  if (!id || adminSurface === null) return <RefLabel id={id} name={resolved} />;
  return adminSurface ? (
    <Link to="/manage/volumes" search={{ volume: id }} className={LINK_CLASS} onClick={keepRowClick}>
      {linkText(id, resolved)}
    </Link>
  ) : (
    <Link to="/volumes" search={{ volume: id }} className={LINK_CLASS} onClick={keepRowClick}>
      {linkText(id, resolved)}
    </Link>
  );
}

function SharedVolumeRef({ id, name, scope }: { id: string; name?: string; scope?: ListScope }) {
  const role = useRole();
  const explicit = providedName(name);
  const adminSurface = useAdminSurface(scope, ACCESS.manageVolumes);
  const query = useQuery({
    queryKey: queryKeys.sharedVolumes.admin,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes?scope=all'),
    enabled: Boolean(id) && !explicit && canAccess(role, Role.UserAdmin),
  });
  const userQuery = useQuery({
    queryKey: queryKeys.sharedVolumes.user,
    queryFn: () => api.get<SharedVolumeDto[]>('/shared-volumes'),
    enabled: false,
  });
  const resolved = explicit
    ?? query.data?.find((row) => row.id === id)?.name
    ?? userQuery.data?.find((row) => row.id === id)?.name;
  if (!id || adminSurface === null) return <RefLabel id={id} name={resolved} />;
  return adminSurface ? (
    <Link to="/manage/volumes" search={{ volume: id }} className={LINK_CLASS} onClick={keepRowClick}>
      {linkText(id, resolved)}
    </Link>
  ) : (
    <Link to="/shared-volumes" search={{ volume: id }} className={LINK_CLASS} onClick={keepRowClick}>
      {linkText(id, resolved)}
    </Link>
  );
}

function ImageRef({ id, name }: { id: string; name?: string }) {
  const role = useRole();
  const explicit = providedName(name);
  const query = useQuery({
    queryKey: queryKeys.images.admin,
    queryFn: () => api.get<AdminImageDto[]>('/images?scope=all'),
    enabled: Boolean(id) && !explicit && canAccess(role, Role.Admin),
  });
  const resolved = explicit ?? query.data?.find((row) => row.id === id)?.alias;
  if (!id || !canAccess(role, ACCESS.images)) return <RefLabel id={id} name={resolved} />;
  return (
    <Link to="/images/$id" params={{ id }} search={{ tab: 'overview' }} className={LINK_CLASS} onClick={keepRowClick}>
      {linkText(id, resolved)}
    </Link>
  );
}

/** Pools have no page of their own: the link opens the storage tab of the pool's server. */
function PoolRef({ id, name, serverId }: { id: string; name?: string; serverId?: string }) {
  const role = useRole();
  const queryClient = useQueryClient();
  const explicit = providedName(name);
  const cached = queryClient.getQueriesData<StoragePoolDto[]>({
    predicate: (query) => {
      const root = query.queryKey[0];
      return root === 'storage-pools'
        || (root === 'volume-form' && query.queryKey[1] === 'pools');
    },
  });
  const fromCached = cached
    .flatMap(([, list]) => (Array.isArray(list) ? list : []))
    .find((row) => row.id === id);
  const resolved = explicit ?? poolLabel(fromCached);
  const owner = serverId ?? fromCached?.serverId;
  if (!id || !owner || !canAccess(role, ACCESS.servers)) return <RefLabel id={id} name={resolved} />;
  return (
    <Link
      to="/servers/$id"
      params={{ id: owner }}
      search={{ tab: 'storage' }}
      className={LINK_CLASS}
      onClick={keepRowClick}
    >
      {linkText(id, resolved)}
    </Link>
  );
}

function SharedBackendRef({ id, name }: { id: string; name?: string }) {
  const role = useRole();
  const explicit = providedName(name);
  const listQuery = useQuery({
    queryKey: queryKeys.sharedBackends.admin,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends?scope=all'),
    enabled: Boolean(id) && !explicit && canAccess(role, Role.UserAdmin),
  });
  const grantTargetsQuery = useQuery({
    queryKey: queryKeys.grants.targets.backends,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends?scope=all'),
    enabled: false,
  });
  const row = listQuery.data?.find((item) => item.id === id)
    ?? grantTargetsQuery.data?.find((item) => item.id === id);
  const resolved = explicit ?? backendLabel(row);
  if (!id || !canAccess(role, ACCESS.sharedBackends)) return <RefLabel id={id} name={resolved} />;
  return (
    <Link
      to="/shared-backends/$id"
      params={{ id }}
      search={{ tab: 'overview' }}
      className={LINK_CLASS}
      onClick={keepRowClick}
    >
      {linkText(id, resolved)}
    </Link>
  );
}

export type { ResourceKind, ResourceRefProps } from './technical-id.js';
