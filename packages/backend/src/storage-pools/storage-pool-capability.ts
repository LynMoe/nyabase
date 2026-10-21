import {
  StoragePoolDriver,
  StoragePoolResizeFamily,
  type StoragePoolCapabilityDto,
} from '@nyabase/common';

/** infra.storage_pools / repository rows */
export function isLocalPoolRow(row: {
  shareable: boolean;
  driver: string;
  shared_backend_id: string | null;
}): boolean {
  return row.shareable === false
    && row.driver !== StoragePoolDriver.CephFs
    && row.shared_backend_id === null;
}

/** StoragePoolDto — frontend belt helper `isLocalStoragePool` may keep this shape */
export function isLocalPoolDto(pool: {
  shareable: boolean;
  driver: string;
  sharedBackendId: string | null;
}): boolean {
  return pool.shareable === false
    && pool.driver !== StoragePoolDriver.CephFs
    && pool.sharedBackendId === null;
}

export function storagePoolCapability(
  family: StoragePoolResizeFamily,
  quotaEffective: boolean | null,
  blockFilesystem: string | null = null,
): StoragePoolCapabilityDto {
  if (family === StoragePoolResizeFamily.QuotaOnline) {
    return {
      growOnline: true,
      shrinkOnline: quotaEffective === true,
      shrinkRequiresStop: false,
      shrinkNever: false,
      enforceUsageFloor: quotaEffective === true,
    };
  }
  const shrinkNever = blockFilesystem?.toLowerCase() === 'xfs';
  return {
    growOnline: true,
    shrinkOnline: false,
    shrinkRequiresStop: !shrinkNever,
    shrinkNever,
    enforceUsageFloor: true,
  };
}

/** When the pool row is missing, refuse shrink rather than implying an online path. */
export function missingStoragePoolCapability(): StoragePoolCapabilityDto {
  return {
    growOnline: true,
    shrinkOnline: false,
    shrinkRequiresStop: false,
    shrinkNever: true,
    enforceUsageFloor: true,
  };
}
