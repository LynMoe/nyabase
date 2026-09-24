import { StoragePoolDriver } from '@nyabase/common';

export function storagePoolSourceKind(driver: StoragePoolDriver): '挂载点' | '设备' {
  return driver === StoragePoolDriver.Dir ? '挂载点' : '设备';
}

/** Belt helper: leaked executor DTOs must still be rejected as local. */
export function isLocalStoragePool(pool: {
  shareable: boolean;
  driver: string;
  sharedBackendId: string | null;
}): boolean {
  return pool.shareable === false
    && pool.driver !== StoragePoolDriver.CephFs
    && pool.sharedBackendId === null;
}
