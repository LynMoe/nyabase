import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type EffectiveAccessDto,
  GRANT_EXPIRY_GRACE_DAYS,
  type GrantExpiryPhase,
  type ServerDto,
  type ServerGrantDto,
  type SharedBackendDto,
  type SharedBackendGrantDto,
  type StoragePoolDto,
  type StoragePoolGrantDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { grantSubjectPath } from '../../lib/scoped-paths.js';
import { queryKeys } from '../../lib/query-keys.js';
import { approxGibHint, GIB } from '../../lib/utils.js';
import { truncateId } from '../refs/technical-id.js';

export type SubjectKind = 'users' | 'groups';

/** The user or group whose grants are shown. */
export interface GrantSubject {
  kind: SubjectKind;
  id: string;
}

const GRANT_LIST_PATHS = {
  servers: 'server-grants',
  pools: 'storage-pool-grants',
  backends: 'shared-backend-grants',
} as const;
type GrantListName = keyof typeof GRANT_LIST_PATHS;
type GrantListRow = { servers: ServerGrantDto; pools: StoragePoolGrantDto; backends: SharedBackendGrantDto };

/** One kind of grant the subject holds. */
export function useSubjectGrants<N extends GrantListName>(subject: GrantSubject, name: N) {
  return useQuery({
    queryKey: queryKeys.grants.subjectList(subject.kind, subject.id, name),
    queryFn: () => api.get<Array<GrantListRow[N]>>(`${grantSubjectPath(subject.kind, subject.id)}/${GRANT_LIST_PATHS[name]}`),
  });
}

/** Lapsed (in grace) servers of a user; groups have no effective access of their own. */
export function useLapsedServers(subject: GrantSubject) {
  const { data } = useQuery({
    queryKey: queryKeys.grants.subjectList(subject.kind, subject.id, 'effective-access'),
    queryFn: () => api.get<EffectiveAccessDto>(`${grantSubjectPath(subject.kind, subject.id)}/effective-access`),
    enabled: subject.kind === 'users',
  });
  return (data?.servers ?? []).filter((access) => access.accessPhase === 'grace');
}

/** Every server an administrator could grant. */
export function useGrantServers() {
  return useQuery({
    queryKey: queryKeys.grants.targets.servers,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
  });
}

/** Every storage pool on those servers. */
export function useGrantPools() {
  const serversQuery = useGrantServers();
  return useQuery({
    queryKey: queryKeys.grants.targets.pools,
    queryFn: async () => {
      const rows = await Promise.all((serversQuery.data ?? []).map(
        (server) => api.get<StoragePoolDto[]>(`/servers/${server.id}/storage-pools?scope=all`),
      ));
      return rows.flat();
    },
    enabled: serversQuery.isSuccess,
  });
}

export function useGrantBackends() {
  return useQuery({
    queryKey: queryKeys.grants.targets.backends,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends?scope=all'),
  });
}

/** Refresh the subject's grants and the current user's access after a change. */
export function useInvalidateGrants(subject: GrantSubject) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants.subject(subject.kind, subject.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.meAccess });
  };
}

export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function defaultExpiryLocal(): string {
  return toDatetimeLocalValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
}

export function coresToMillis(value: string): number | null {
  if (!value.trim()) return null;
  const cores = Number(value);
  if (!Number.isFinite(cores) || cores < 0) return null;
  return Math.round(cores * 1000);
}

export function gibToBytes(value: string): number | null {
  if (!value.trim()) return null;
  const gib = Number(value);
  if (!Number.isFinite(gib) || gib < 0) return null;
  return Math.round(gib * GIB);
}

export function gibHint(value: string): string | undefined {
  const bytes = gibToBytes(value);
  if (bytes === null) return undefined;
  return approxGibHint(bytes);
}

export function isoOrNull(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serverName(id: string, servers: ServerDto[]): string {
  return servers.find((server) => server.id === id)?.name ?? truncateId(id);
}

export function poolFullName(id: string, pools: StoragePoolDto[], servers: ServerDto[]): string | undefined {
  const pool = pools.find((item) => item.id === id);
  if (!pool) return undefined;
  return `${pool.displayName ?? pool.incusName} · ${serverName(pool.serverId, servers)}`;
}

export function poolName(id: string, pools: StoragePoolDto[], servers: ServerDto[]): string {
  return poolFullName(id, pools, servers) ?? truncateId(id);
}

export function backendDisplayName(id: string, backends: SharedBackendDto[]): string | undefined {
  const backend = backends.find((item) => item.id === id);
  return backend ? (backend.displayName ?? backend.name) : undefined;
}

export function backendName(id: string, backends: SharedBackendDto[]): string {
  return backendDisplayName(id, backends) ?? truncateId(id);
}

/** Phase of one grant by its own expiry; the access a user actually has is the merge of all of them. */
export function expiryPhase(value: string | null): GrantExpiryPhase {
  if (!value) return 'live';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp > Date.now()) return 'live';
  return Date.now() < timestamp + GRANT_EXPIRY_GRACE_DAYS * 86_400_000 ? 'grace' : 'lost';
}

export function expiryLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '不设期限';
}

export function expirySummary(value: string): string {
  return value ? expiryLabel(isoOrNull(value)) : '不设期限';
}

export function initialExpiry(expiresAt: string | null | undefined): string {
  return expiresAt ? toDatetimeLocalValue(new Date(expiresAt)) : '';
}

/** Registered pools on already granted servers that the subject does not hold a pool grant for yet. */
export function grantablePools(
  pools: StoragePoolDto[],
  grantedServerIds: ReadonlySet<string>,
  poolGrants: StoragePoolGrantDto[],
): StoragePoolDto[] {
  return pools.filter((pool) => (
    pool.registered
    && grantedServerIds.has(pool.serverId)
    && !poolGrants.some((row) => row.poolId === pool.id)
  ));
}
