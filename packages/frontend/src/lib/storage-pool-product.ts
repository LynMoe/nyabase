import { StoragePoolDriver } from '@nyabase/common';

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
