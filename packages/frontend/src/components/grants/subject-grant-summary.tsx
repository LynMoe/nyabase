import { useQueries, useQuery } from '@tanstack/react-query';
import type {
  ServerDto,
  ServerGrantDto,
  SharedBackendDto,
  SharedBackendGrantDto,
  StoragePoolDto,
  StoragePoolGrantDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { Badge } from '../ui/badge.js';
import { grantExpiryPhaseLabel } from '../../lib/display-labels.js';
import { queryKeys } from '../../lib/query-keys.js';

type SubjectKind = 'users' | 'groups';

function expiryPhase(expiresAt: string | null): 'live' | 'grace' | 'lost' {
  if (!expiresAt) return 'live';
  const timestamp = new Date(expiresAt).getTime();
  if (!Number.isFinite(timestamp) || timestamp > Date.now()) return 'live';
  return 'lost';
}

function phaseBadge(expiresAt: string | null) {
  const phase = expiryPhase(expiresAt);
  return (
    <Badge
      variant={phase === 'lost' ? 'destructive' : phase === 'grace' ? 'warning' : 'outline'}
      className="shrink-0"
    >
      {grantExpiryPhaseLabel(phase)}
    </Badge>
  );
}

export function SubjectGrantSummary({
  kind,
  subjectId,
}: {
  kind: SubjectKind;
  subjectId: string;
}) {
  const prefix = `/admin/${kind}/${subjectId}`;
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
  });
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.admin,
    queryFn: () => api.get<SharedBackendDto[]>('/admin/shared-backends'),
  });
  const poolsQuery = useQuery({
    queryKey: ['grant-targets', 'pools'],
    queryFn: async () => {
      const servers = serversQuery.data ?? [];
      const rows = await Promise.all(
        servers.map((server) => api.get<StoragePoolDto[]>(`/admin/servers/${server.id}/storage-pools`)),
      );
      return rows.flat();
    },
    enabled: serversQuery.isSuccess,
  });

  const [serverGrantsQuery, poolGrantsQuery, backendGrantsQuery] = useQueries({
    queries: [
      {
        queryKey: [...queryKeys.grants.subject(kind, subjectId), 'servers'],
        queryFn: () => api.get<ServerGrantDto[]>(`${prefix}/server-grants`),
      },
      {
        queryKey: [...queryKeys.grants.subject(kind, subjectId), 'pools'],
        queryFn: () => api.get<StoragePoolGrantDto[]>(`${prefix}/storage-pool-grants`),
      },
      {
        queryKey: [...queryKeys.grants.subject(kind, subjectId), 'backends'],
        queryFn: () => api.get<SharedBackendGrantDto[]>(`${prefix}/shared-backend-grants`),
      },
    ],
  });

  const servers = serversQuery.data ?? [];
  const pools = poolsQuery.data ?? [];
  const backends = backendsQuery.data ?? [];
  const serverGrants = serverGrantsQuery.data ?? [];
  const poolGrants = poolGrantsQuery.data ?? [];
  const backendGrants = backendGrantsQuery.data ?? [];
  const loading = serverGrantsQuery.isLoading || poolGrantsQuery.isLoading || backendGrantsQuery.isLoading;
  const empty = serverGrants.length === 0 && poolGrants.length === 0 && backendGrants.length === 0;

  if (loading) {
    return <p className="mt-2 text-xs text-muted-foreground">加载授权…</p>;
  }
  if (empty) {
    return <p className="mt-2 text-xs text-muted-foreground">暂无授权</p>;
  }

  return (
    <div className="mt-2 space-y-1.5 text-xs" data-testid="subject-grant-summary">
      {serverGrants.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">已授权服务器</span>
          {serverGrants.map((row) => (
            <span key={row.id} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
              {servers.find((server) => server.id === row.serverId)?.name ?? row.serverId}
              {phaseBadge(row.expiresAt)}
            </span>
          ))}
        </div>
      )}
      {poolGrants.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">已授权存储池</span>
          {poolGrants.map((row) => {
            const pool = pools.find((item) => item.id === row.poolId);
            const label = pool
              ? `${pool.displayName ?? pool.incusName}`
              : row.poolId;
            return (
              <span key={row.id} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
                {label}
                {phaseBadge(row.expiresAt)}
              </span>
            );
          })}
        </div>
      )}
      {backendGrants.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">已授权共享后端</span>
          {backendGrants.map((row) => {
            const backend = backends.find((item) => item.id === row.sharedBackendId);
            const label = backend?.displayName ?? backend?.name ?? row.sharedBackendId;
            return (
              <span key={row.id} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
                {label}
                {phaseBadge(row.expiresAt)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
