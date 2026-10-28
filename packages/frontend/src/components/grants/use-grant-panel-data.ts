import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type EffectiveAccessDto,
  GRANT_EXPIRY_GRACE_DAYS,
  type GrantBundleDto,
  type GrantExpiryPhase,
  type LiveServerAccessDto,
  type ServerGrantDto,
  type SharedBackendDto,
  type SharedBackendGrantDto,
  type StoragePoolDto,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { graceServerAccess, liveServerAccess } from '../../lib/effective-access.js';
import { queryKeys } from '../../lib/query-keys.js';
import { approxGibHint, formatGibInput, GIB } from '../../lib/utils.js';
import { truncateId } from '../refs/technical-id.js';

/** The user's bundle on each server, with its data disks. */
export function useServerGrants(userId: string) {
  return useQuery({
    queryKey: queryKeys.grants.userList(userId, 'servers'),
    queryFn: () => api.get<ServerGrantDto[]>(`/users/${userId}/server-grants`),
  });
}

/** Every user's server grants, for the user list. */
export function useAllServerGrants(enabled = true) {
  return useQuery({
    queryKey: queryKeys.grants.allServers,
    queryFn: () => api.get<ServerGrantDto[]>('/server-grants?scope=all'),
    enabled,
  });
}

export function useBackendGrants(userId: string) {
  return useQuery({
    queryKey: queryKeys.grants.userList(userId, 'backends'),
    queryFn: () => api.get<SharedBackendGrantDto[]>(`/users/${userId}/shared-backend-grants`),
  });
}

function useEffectiveAccess(userId: string) {
  return useQuery({
    queryKey: queryKeys.grants.userList(userId, 'effective-access'),
    queryFn: () => api.get<EffectiveAccessDto>(`/users/${userId}/effective-access`),
  });
}

/** Servers whose access lapsed: stopped now, purged when the grace ends. */
export function useLapsedServers(userId: string) {
  return graceServerAccess(useEffectiveAccess(userId).data?.servers);
}

/** The user's current access on one server (the GPUs picked for them), if live. */
export function useLiveServerAccess(userId: string, serverId: string): LiveServerAccessDto | undefined {
  return liveServerAccess(useEffectiveAccess(userId).data?.servers).find((access) => access.serverId === serverId);
}

/** Every bundle, of every server. */
export function useGrantBundles() {
  return useQuery({
    queryKey: queryKeys.grantBundles.list,
    queryFn: () => api.get<GrantBundleDto[]>('/admin/grant-bundles'),
  });
}

/** Every server an administrator could grant (user admins get the user DTO). */
export function useGrantServers() {
  return useQuery({
    queryKey: queryKeys.grants.targets.servers,
    queryFn: () => api.get<UserServerDto[]>('/servers?scope=all'),
  });
}

export function useGrantBackends() {
  return useQuery({
    queryKey: queryKeys.grants.targets.backends,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends?scope=all'),
  });
}

/**
 * What a grant change can move for the signed-in administrator too (their own
 * grant, or a bundle they follow): their access, storage quotas and the pools
 * the volume form offers them.
 */
export function invalidateOwnAccess(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.meAccess });
  void queryClient.invalidateQueries({ queryKey: queryKeys.storageCapacityAll });
  void queryClient.invalidateQueries({ queryKey: queryKeys.volumeForm.poolsAll });
}

/** Refresh the user's grants, bundle counts and the current user's access after a change. */
export function useInvalidateGrants(userId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants.user(userId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants.allServers });
    void queryClient.invalidateQueries({ queryKey: queryKeys.grantBundles.all });
    invalidateOwnAccess(queryClient);
  };
}

export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function defaultExpiryLocal(): string {
  return toDatetimeLocalValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
}

/** GiB quota input: empty → null (不限); a positive amount → bytes; anything else (0, negative, NaN) → undefined (invalid). */
export function parseGibQuota(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const gib = Number(value);
  if (!Number.isFinite(gib)) return undefined;
  const bytes = Math.round(gib * GIB);
  return bytes > 0 ? bytes : undefined;
}

/** The input text of a GiB limit; '' = 不限. */
export function gibQuotaText(bytes: number | null | undefined): string {
  return bytes == null ? '' : formatGibInput(bytes);
}

/**
 * `parseGibQuota`, except that a text still reading as the stored limit keeps
 * its exact bytes (the input shows at most 3 decimals of GiB).
 */
export function parseGibQuotaKeeping(value: string, stored: number | null | undefined): number | null | undefined {
  if (stored !== undefined && value.trim() === gibQuotaText(stored)) return stored;
  return parseGibQuota(value);
}

export function gibHint(value: string): string | undefined {
  const bytes = parseGibQuota(value);
  if (bytes == null) return undefined;
  return approxGibHint(bytes);
}

export function isoOrNull(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serverName(id: string, servers: UserServerDto[]): string {
  return servers.find((server) => server.id === id)?.name ?? truncateId(id);
}

export function poolLabel(pool: Pick<StoragePoolDto, 'displayName' | 'incusName'>): string {
  return pool.displayName ?? pool.incusName;
}

/** Registered local pools of one server that the grant has no data disk on yet. */
export function addablePools(pools: StoragePoolDto[], grant: ServerGrantDto): StoragePoolDto[] {
  return pools.filter((pool) => (
    pool.registered
    && !pool.shareable
    && pool.serverId === grant.serverId
    && !grant.storagePools.some((row) => row.poolId === pool.id)
  ));
}

export function backendDisplayName(id: string, backends: SharedBackendDto[]): string | undefined {
  const backend = backends.find((item) => item.id === id);
  return backend ? (backend.displayName ?? backend.name) : undefined;
}

export function backendName(id: string, backends: SharedBackendDto[]): string {
  return backendDisplayName(id, backends) ?? truncateId(id);
}

/** Phase of one grant by its own expiry. */
export function expiryPhase(value: string | null): GrantExpiryPhase {
  if (!value) return 'live';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp > Date.now()) return 'live';
  return Date.now() < timestamp + GRANT_EXPIRY_GRACE_DAYS * 86_400_000 ? 'grace' : 'lost';
}

export function expiryLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '永久';
}

export function expirySummary(value: string): string {
  return value ? expiryLabel(isoOrNull(value)) : '永久';
}

export function initialExpiry(expiresAt: string | null | undefined): string {
  return expiresAt ? toDatetimeLocalValue(new Date(expiresAt)) : '';
}
