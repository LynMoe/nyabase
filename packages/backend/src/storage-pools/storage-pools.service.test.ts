import { describe, expect, it } from 'vitest';
import {
  deriveStoragePoolDiscovery,
  deriveSharedBackendIdentity,
  storagePoolCapability,
} from './storage-pools.service.js';
import { StoragePoolResizeFamily } from '@nyabase/common';

describe('storage pool capability matrix', () => {
  it.each([
    ['dir', 'quota_online'],
    ['btrfs', 'quota_online'],
    ['cephfs', 'quota_online'],
    ['zfs', 'quota_online'],
    ['lvm', 'block_backed'],
    ['lvmcluster', 'block_backed'],
    ['ceph', 'block_backed'],
  ] as const)('%s derives %s', (driver, resizeFamily) => {
    const result = deriveStoragePoolDiscovery({
      serverId: 'server',
      incusName: `${driver}-pool`,
      driver,
      config: driver === 'zfs' ? { 'volume.zfs.block_mode': 'false' } : undefined,
      quotaEffective: driver === 'dir' ? false : true,
    });
    expect(result.resizeFamily).toBe(resizeFamily);
    expect(result.rootDiskCapable).toBe(driver !== 'cephfs');
    expect(result.shareable).toBe(driver === 'cephfs');
    expect(result.blockFilesystem).toBe(resizeFamily === 'block_backed' ? 'ext4' : null);
  });

  it('switches ZFS to block-backed only for block_mode', () => {
    const result = deriveStoragePoolDiscovery({
      serverId: 'server',
      incusName: 'zfs-block',
      driver: 'zfs',
      config: { 'volume.zfs.block_mode': 'true' },
    });
    expect(result.resizeFamily).toBe('block_backed');
    expect(result.rootDiskCapable).toBe(true);
    expect(result.shareable).toBe(false);
    expect(result.blockFilesystem).toBe('ext4');
  });

  it('rejects non-ext4 block-backed filesystems', () => {
    expect(() => deriveStoragePoolDiscovery({
      serverId: 'server',
      incusName: 'lvm-xfs',
      driver: 'lvm',
      config: { 'volume.block.filesystem': 'xfs' },
    })).toThrow(/ext4/i);
  });

  it('normalizes an explicitly configured ext4 filesystem', () => {
    expect(deriveStoragePoolDiscovery({
      serverId: 'server',
      incusName: 'lvm-ext4',
      driver: 'lvm',
      config: { 'volume.block.filesystem': ' EXT4 ' },
    }).blockFilesystem).toBe('ext4');
  });

  it('never marks RBD/Ceph pools shareable', () => {
    const result = deriveStoragePoolDiscovery({
      serverId: 'server',
      incusName: 'ceph-rbd',
      driver: 'ceph',
      config: { 'cephfs.cluster_name': 'ceph', source: 'pool' },
    });
    expect(result.shareable).toBe(false);
    expect(result.rootDiskCapable).toBe(true);
  });

  it('derives a stable CephFS identity from pool configuration', () => {
    expect(deriveSharedBackendIdentity('cephfs', {
      'cephfs.cluster_name': 'ceph',
      source: 'cephfs_a',
      'cephfs.path': '/volumes',
    })).toBe('cephfs:ceph/cephfs_a/volumes');
    expect(deriveSharedBackendIdentity('ceph', {
      'cephfs.cluster_name': 'ceph',
      source: 'cephfs_a',
      'cephfs.path': '/volumes',
    })).toBeNull();
  });

  it('marks a dir pool with null usage as quota-ineffective', () => {
    const result = deriveStoragePoolDiscovery({
      serverId: 'server',
      incusName: 'dir',
      driver: 'dir',
      quotaEffective: false,
    });
    expect(result.quotaEffective).toBe(false);
    expect(storagePoolCapability(
      result.resizeFamily as StoragePoolResizeFamily,
      result.quotaEffective,
    )).toMatchObject({
      growOnline: true,
      shrinkOnline: false,
      shrinkRequiresStop: false,
      shrinkNever: false,
      enforceUsageFloor: false,
    });
    expect(storagePoolCapability(
      StoragePoolResizeFamily.BlockBacked,
      true,
      'xfs',
    )).toMatchObject({
      shrinkOnline: false,
      shrinkRequiresStop: false,
      shrinkNever: true,
      enforceUsageFloor: true,
    });
    expect(storagePoolCapability(
      StoragePoolResizeFamily.BlockBacked,
      true,
      'ext4',
    )).toMatchObject({
      shrinkOnline: false,
      shrinkRequiresStop: true,
      shrinkNever: false,
    });
  });
});
