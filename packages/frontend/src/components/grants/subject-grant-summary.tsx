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
import { formatGrantBytes, formatGrantQuotaLine } from '../../lib/grant-quota.js';
import { formatExtensionGrantSummaries } from '../../extensions/registry.js';
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

function poolLabel(pool: StoragePoolDto | undefined, poolId: string): string {
  return pool ? (pool.displayName ?? pool.incusName) : poolId;
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
    queryKey: queryKeys.grants.targets.pools,
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
        queryKey: queryKeys.grants.subjectList(kind, subjectId, 'servers'),
        queryFn: () => api.get<ServerGrantDto[]>(`${prefix}/server-grants`),
      },
      {
        queryKey: queryKeys.grants.subjectList(kind, subjectId, 'pools'),
        queryFn: () => api.get<StoragePoolGrantDto[]>(`${prefix}/storage-pool-grants`),
      },
      {
        queryKey: queryKeys.grants.subjectList(kind, subjectId, 'backends'),
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
  const grantedServerIds = new Set(serverGrants.map((row) => row.serverId));
  const orphanPoolGrants = poolGrants.filter((row) => {
    const pool = pools.find((item) => item.id === row.poolId);
    return !pool || !grantedServerIds.has(pool.serverId);
  });

  if (loading) {
    return <p className="mt-2 text-xs text-muted-foreground">加载授权…</p>;
  }
  if (empty) {
    return <p className="mt-2 text-xs text-muted-foreground">暂无授权</p>;
  }

  return (
    <div className="mt-2 space-y-1.5 text-xs" data-testid="subject-grant-summary">
      {serverGrants.map((row) => {
        const nested = poolGrants.filter((grant) => {
          const pool = pools.find((item) => item.id === grant.poolId);
          return pool?.serverId === row.serverId;
        });
        const quota = formatGrantQuotaLine(row, formatExtensionGrantSummaries(row.extensionGrants));
        return (
          <div key={row.id} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
                {servers.find((server) => server.id === row.serverId)?.name ?? row.serverId}
                <span>{quota}</span>
                {phaseBadge(row.expiresAt)}
              </span>
            </div>
            {nested.length > 0 && (
              <p className="pl-2 text-muted-foreground">
                池：{nested.map((grant) => poolLabel(pools.find((item) => item.id === grant.poolId), grant.poolId)).join('、')}
              </p>
            )}
          </div>
        );
      })}
      {orphanPoolGrants.map((row) => (
        <div key={row.id} className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
            存储池 {poolLabel(pools.find((item) => item.id === row.poolId), row.poolId)}
            {phaseBadge(row.expiresAt)}
          </span>
        </div>
      ))}
      {backendGrants.map((row) => {
        const backend = backends.find((item) => item.id === row.sharedBackendId);
        const label = backend?.displayName ?? backend?.name ?? row.sharedBackendId;
        return (
          <div key={row.id} className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
              {label}
              <span>{formatGrantBytes(row.limitBytes)}</span>
              {phaseBadge(row.expiresAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
