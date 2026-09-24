import { describe, expect, it } from 'vitest';
import { StoragePoolDriver } from '@nyabase/common';
import { storagePoolSourceKind } from './storage-pool-product.js';

describe('storagePoolSourceKind', () => {
  it('labels dir as 挂载点', () => {
    expect(storagePoolSourceKind(StoragePoolDriver.Dir)).toBe('挂载点');
  });

  it.each([
    StoragePoolDriver.Lvm,
    StoragePoolDriver.LvmCluster,
    StoragePoolDriver.Zfs,
    StoragePoolDriver.Btrfs,
    StoragePoolDriver.Ceph,
    StoragePoolDriver.CephFs,
  ] as const)('labels %s as 设备', (driver) => {
    expect(storagePoolSourceKind(driver)).toBe('设备');
  });
});
