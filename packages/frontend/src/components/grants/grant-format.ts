import {
  GRANT_EXPIRY_GRACE_DAYS,
  type GrantExpiryPhase,
  type ServerDto,
  type SharedBackendDto,
  type StoragePoolDto,
} from '@nyabase/common';
import { GIB, approxGibHint } from '../../lib/utils.js';
import { truncateId } from '../refs/truncate-id.js';

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
