import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EffectiveAccessDto,
  ServerDto,
  ServerGrantDto,
  SharedBackendDto,
  SharedBackendGrantDto,
  StoragePoolDto,
  StoragePoolGrantDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { grantSubjectPath } from '../../lib/grant-paths.js';
import { queryKeys } from '../../lib/query-keys.js';

export type SubjectKind = 'users' | 'groups';

/**
 * Everything the grant panel shows for one user or group: the grantable
 * resources, the subject's grants of each kind, and what is blocking each
 * "add" button.
 */
export function useGrantPanelData(kind: SubjectKind, subjectId: string) {
  const queryClient = useQueryClient();
  const prefix = grantSubjectPath(kind, subjectId);
  const serversQuery = useQuery({ queryKey: queryKeys.grants.targets.servers, queryFn: () => api.get<ServerDto[]>('/servers?scope=all') });
  const poolsQuery = useQuery({
    queryKey: queryKeys.grants.targets.pools,
    queryFn: async () => {
      const servers = serversQuery.data ?? [];
      const rows = await Promise.all(servers.map(async (server) => api.get<StoragePoolDto[]>(`/servers/${server.id}/storage-pools?scope=all`)));
      return rows.flat();
    },
    enabled: serversQuery.isSuccess,
  });
  const backendsQuery = useQuery({ queryKey: queryKeys.grants.targets.backends, queryFn: () => api.get<SharedBackendDto[]>('/shared-backends?scope=all') });
  const serverGrantsQuery = useQuery({ queryKey: queryKeys.grants.subjectList(kind, subjectId, 'servers'), queryFn: () => api.get<ServerGrantDto[]>(`${prefix}/server-grants`) });
  const poolGrantsQuery = useQuery({ queryKey: queryKeys.grants.subjectList(kind, subjectId, 'pools'), queryFn: () => api.get<StoragePoolGrantDto[]>(`${prefix}/storage-pool-grants`) });
  const backendGrantsQuery = useQuery({ queryKey: queryKeys.grants.subjectList(kind, subjectId, 'backends'), queryFn: () => api.get<SharedBackendGrantDto[]>(`${prefix}/shared-backend-grants`) });
  const effectiveAccessQuery = useQuery({
    queryKey: queryKeys.grants.subjectList(kind, subjectId, 'effective-access'),
    queryFn: () => api.get<EffectiveAccessDto>(`${prefix}/effective-access`),
    enabled: kind === 'users',
  });

  const servers = serversQuery.data ?? [];
  const pools = poolsQuery.data ?? [];
  const backends = backendsQuery.data ?? [];
  const serverGrants = serverGrantsQuery.data ?? [];
  const poolGrants = poolGrantsQuery.data ?? [];
  const backendGrants = backendGrantsQuery.data ?? [];
  const grantedServerIds = new Set(serverGrants.map((row) => row.serverId));
  const ungrantedServers = servers.filter((server) => !grantedServerIds.has(server.id));
  const grantablePools = pools.filter((pool) => (
    pool.registered
    && grantedServerIds.has(pool.serverId)
    && !poolGrants.some((row) => row.poolId === pool.id)
  ));
  const ungrantedBackends = backends.filter((backend) => (
    !backendGrants.some((row) => row.sharedBackendId === backend.id)
  ));

  const serverBlocked = !serversQuery.isSuccess
    ? null
    : servers.length === 0
      ? '还没有服务器，请先在“服务器”页添加。'
      : ungrantedServers.length === 0 ? '所有服务器都已授权。' : null;
  const poolBlocked = serverGrants.length === 0
    ? '请先添加服务器授权。'
    : poolsQuery.isSuccess && grantablePools.length === 0
      ? '已授权服务器上没有其他可授权的存储池。'
      : null;
  const backendBlocked = !backendsQuery.isSuccess
    ? null
    : backends.length === 0
      ? '还没有登记共享存储。'
      : ungrantedBackends.length === 0 ? '所有共享存储都已授权。' : null;
  const lapsedServers = (effectiveAccessQuery.data?.servers ?? [])
    .filter((access) => access.accessPhase === 'grace');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants.subject(kind, subjectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.meAccess });
  };

  return {
    prefix,
    queries: { serversQuery, poolsQuery, backendsQuery },
    grantLists: [serverGrantsQuery, poolGrantsQuery, backendGrantsQuery],
    servers,
    pools,
    backends,
    serverGrants,
    poolGrants,
    backendGrants,
    grantedServerIds,
    ungrantedServers,
    grantablePools,
    ungrantedBackends,
    serverBlocked,
    poolBlocked,
    backendBlocked,
    lapsedServers,
    invalidate,
  };
}

export type GrantPanelData = ReturnType<typeof useGrantPanelData>;
