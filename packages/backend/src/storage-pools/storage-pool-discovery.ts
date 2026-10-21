import { BadRequestException } from '@nestjs/common';
import {
  FailureCode,
  StoragePoolDriver,
  StoragePoolResizeFamily,
  type StorageDiscoverIssueDto,
} from '@nyabase/common';
import type { StoragePoolDiscovery, StoragePoolsRepository } from './storage-pools.repository.js';

/**
 * Dir-pool project quota is effective only when Incus reports `usage.used`.
 * `{ total: 0 }` without `used`, or a configured `size=`, is not enough:
 * Incus silently ignores size on filesystems without project quota.
 */
export function dirQuotaEffectiveFromVolumeState(
  usage: { used?: unknown; total?: unknown } | null | undefined,
): boolean {
  if (!usage || typeof usage !== 'object') return false;
  const used = usage.used;
  if (typeof used === 'number') return Number.isFinite(used) && used >= 0;
  if (typeof used === 'string' && used.trim().length > 0) {
    const match = /^([0-9]+)(?:\s*)(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i.exec(used.trim());
    return match !== null;
  }
  return false;
}

export function normalizeObservedStoragePoolSource(
  raw: string | null | undefined,
): { source: string | null; discard: 'too_long' | 'control_char' | null; rawLength: number } {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return { source: null, discard: null, rawLength: 0 };
  if (trimmed.length > 1024) {
    return { source: null, discard: 'too_long', rawLength: trimmed.length };
  }
  if (/[\0\r\n]/.test(trimmed)) {
    return { source: null, discard: 'control_char', rawLength: trimmed.length };
  }
  return { source: trimmed, discard: null, rawLength: trimmed.length };
}

export function deriveStoragePoolDiscovery(input: {
  serverId: string;
  incusName: string;
  driver: string;
  config?: Record<string, string | undefined>;
  totalBytes?: number | null;
  usedBytes?: number | null;
  quotaEffective?: boolean | null;
}): StoragePoolDiscovery {
  const driver = input.driver as StoragePoolDiscovery['driver'];
  if (!Object.values(StoragePoolDriver).includes(driver as StoragePoolDriver)) {
    throw new BadRequestException(`Unsupported Incus storage driver: ${input.driver}`);
  }
  const config = input.config ?? {};
  const configuredFilesystem = (
    config['volume.block.filesystem']
    ?? config['block.filesystem']
    ?? null
  )?.trim().toLowerCase() ?? null;
  const zfsBlockMode = driver === StoragePoolDriver.Zfs
    && configValue(config, 'volume.zfs.block_mode')?.toLowerCase() === 'true';
  const quotaOnline =
    driver === StoragePoolDriver.Dir
    || driver === StoragePoolDriver.Btrfs
    || driver === StoragePoolDriver.CephFs
    || (driver === StoragePoolDriver.Zfs && !zfsBlockMode);
  const blockBacked =
    driver === StoragePoolDriver.Lvm
    || driver === StoragePoolDriver.LvmCluster
    || driver === StoragePoolDriver.Ceph
    || zfsBlockMode;
  const resizeFamily = quotaOnline
    ? StoragePoolResizeFamily.QuotaOnline
    : blockBacked
      ? StoragePoolResizeFamily.BlockBacked
      : (() => {
        throw new BadRequestException(`Unsupported Incus storage driver: ${input.driver}`);
      })();
  const blockFilesystem = resizeFamily === StoragePoolResizeFamily.BlockBacked
    ? configuredFilesystem ?? 'ext4'
    : null;
  if (
    resizeFamily === StoragePoolResizeFamily.BlockBacked
    && blockFilesystem?.toLowerCase() !== 'ext4'
  ) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Block-backed storage pools must use ext4',
    });
  }
  const shareable = driver === StoragePoolDriver.CephFs;
  return {
    serverId: input.serverId,
    incusName: input.incusName,
    driver,
    resizeFamily,
    rootDiskCapable: driver !== StoragePoolDriver.CephFs,
    shareable,
    blockFilesystem,
    totalBytes: input.totalBytes ?? null,
    usedBytes: input.usedBytes ?? null,
    quotaEffective: input.quotaEffective
      ?? (driver === StoragePoolDriver.Dir ? false : quotaOnline),
    source: normalizeObservedStoragePoolSource(configValue(config, 'source')).source,
  };
}

export function configValue(
  config: Record<string, string | undefined>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = config[key]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * CephFS identity is based on the Incus pool configuration, never on the
 * local pool name.  FSID is intentionally not part of this value: Incus does
 * not expose it reliably and administrators register it out of band.
 */
export function deriveSharedBackendIdentity(
  driver: string,
  config: Record<string, string | undefined> = {},
): string | null {
  if (driver !== StoragePoolDriver.CephFs) return null;
  const cluster = configValue(config, 'cephfs.cluster_name', 'ceph.cluster_name');
  const source = configValue(config, 'source', 'cephfs.source');
  const path = configValue(config, 'cephfs.path', 'volume.cephfs.path');
  if (!cluster || !source || !path) return null;
  return `cephfs:${cluster}/${source}/${path.replace(/^\/+/, '')}`;
}

export function deriveDiscoveredFsid(
  config: Record<string, string | undefined>,
): string | null {
  return configValue(
    config,
    'cephfs.fsid',
    'cephfs.cluster_fsid',
    'ceph.cluster_fsid',
  )?.toLowerCase() ?? null;
}

export const SHAREABLE_MAPPING_UNIQUE = 'storage_pools_shared_backend_server_unique';

export function isShareableMappingUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      record.code === '23505'
      && String(record.constraint ?? '').includes(SHAREABLE_MAPPING_UNIQUE)
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

export type PendingDiscovery = {
  discovery: StoragePoolDiscovery;
  identityKey: string | null;
  discoveredFsid: string | null;
};

export type StoragePoolRow = NonNullable<Awaited<ReturnType<StoragePoolsRepository['findById']>>>;

export function toDiscoverIssue(input: {
  code: StorageDiscoverIssueDto['code'];
  message: string;
  identityKey?: string | null;
  expectedFsid?: string | null;
  discoveredFsid?: string | null;
  existingIdentityKey?: string | null;
  serverId?: string | null;
  incusName?: string | null;
  poolId?: string | null;
}): StorageDiscoverIssueDto {
  return {
    code: input.code,
    message: input.message,
    identityKey: input.identityKey ?? null,
    expectedFsid: input.expectedFsid ?? null,
    discoveredFsid: input.discoveredFsid ?? null,
    existingIdentityKey: input.existingIdentityKey ?? null,
    serverId: input.serverId ?? null,
    incusName: input.incusName ?? null,
    poolId: input.poolId ?? null,
  };
}

export function optionalByteCount(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    return value;
  }
  return null;
}

