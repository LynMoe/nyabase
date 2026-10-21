import { NotFoundException } from '@nestjs/common';
import {
  ServerStatus,
  StoragePoolResizeFamily,
  type SharedBackendExecutorDto,
  type StoragePoolDto,
} from '@nyabase/common';
import { isoDate, numberValue } from '../platform/domain-utils.js';
import { storagePoolCapability } from './storage-pool-capability.js';

interface PoolRowShape {
  id: string;
  server_id: string;
  incus_name: string;
  display_name: string | null;
  source?: string | null;
  driver: string;
  resize_family: string;
  root_disk_capable: boolean;
  shareable: boolean;
  block_filesystem: string | null;
  shared_backend_id: string | null;
  total_bytes: string | number | null;
  used_bytes: string | number | null;
  quota_effective: boolean | null;
  registered: boolean;
  last_observed_at: Date | string | null;
  revision: string | number;
}

function toPoolDto(row: PoolRowShape, source: string | null): StoragePoolDto {
  return {
    id: row.id,
    serverId: row.server_id,
    incusName: row.incus_name,
    displayName: row.display_name,
    source,
    driver: row.driver as StoragePoolDto['driver'],
    resizeFamily: row.resize_family as StoragePoolDto['resizeFamily'],
    rootDiskCapable: row.root_disk_capable,
    shareable: row.shareable,
    blockFilesystem: row.block_filesystem,
    sharedBackendId: row.shared_backend_id,
    totalBytes: row.total_bytes === null ? null : numberValue(row.total_bytes),
    usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
    quotaEffective: row.quota_effective,
    registered: row.registered,
    capability: storagePoolCapability(
      row.resize_family as StoragePoolResizeFamily,
      row.quota_effective,
      row.block_filesystem,
    ),
    lastObservedAt: isoDate(row.last_observed_at),
    revision: numberValue(row.revision),
  };
}

/** Administrators also see the pool's Incus `source`. */
export function toAdminPoolDto(row: PoolRowShape): StoragePoolDto {
  return toPoolDto(row, row.source ?? null);
}

export function toUserPoolDto(row: PoolRowShape): StoragePoolDto {
  return toPoolDto(row, null);
}

export function toExecutorDto(row: {
  id: string;
  shared_backend_id: string | null;
  server_id: string;
  server_name: string;
  server_status: string;
  incus_name: string;
  registered: boolean;
  total_bytes: string | number | null;
  used_bytes: string | number | null;
  last_observed_at: Date | string | null;
  revision: string | number;
}): SharedBackendExecutorDto {
  if (row.shared_backend_id === null) {
    throw new NotFoundException('Storage pool not found');
  }
  return {
    id: row.id,
    backendId: row.shared_backend_id,
    serverId: row.server_id,
    serverName: row.server_name,
    serverStatus: row.server_status as ServerStatus,
    incusName: row.incus_name,
    registered: row.registered,
    totalBytes: row.total_bytes === null ? null : numberValue(row.total_bytes),
    usedBytes: row.used_bytes === null ? null : numberValue(row.used_bytes),
    lastObservedAt: isoDate(row.last_observed_at),
    revision: numberValue(row.revision),
  };
}
