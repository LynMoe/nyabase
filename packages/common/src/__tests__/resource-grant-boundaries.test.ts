import { describe, expect, it } from 'vitest';
import {
  FailureCode,
  MAX_RESOURCE_BYTES,
  MAX_GPU_DEVICES,
  MAX_SERVER_LOGICAL_CPU_ID,
  zCreateContainerRequest,
  zCreateGrantBundleRequest,
  zPatchGrantBundleRequest,
  zPatchServerGrantRequest,
  zServerGrantOverrides,
  zCreateSharedBackendRequest,
  zPatchSharedBackendRequest,
  zPutServerGrantRequest,
  zPutSharedBackendGrantRequest,
  MAX_GRANT_DATA_DISKS,
  systemDiskRoom,
} from '@nyabase/common';

const serverId = '22222222-2222-4222-8222-222222222222';
const poolId = '33333333-3333-4333-8333-333333333333';
const backendId = '44444444-4444-4444-8444-444444444444';

describe('grant resource bounds', () => {
  const quotas = { cpuCores: null, memBytes: null, diskBytes: 1_024, rootDiskBytes: null, gpuCount: null, dataDisks: [] };

  it('accepts bundles at the safe numeric limits', () => {
    expect(zCreateGrantBundleRequest.parse({
      serverId,
      name: ' GPU A ',
      cpuCores: MAX_SERVER_LOGICAL_CPU_ID + 1,
      memBytes: MAX_RESOURCE_BYTES,
      diskBytes: MAX_RESOURCE_BYTES,
      rootDiskBytes: MAX_RESOURCE_BYTES,
      gpuCount: MAX_GPU_DEVICES,
      dataDisks: [{ poolId, capBytes: MAX_RESOURCE_BYTES }],
    })).toMatchObject({ name: 'GPU A', cpuCores: MAX_SERVER_LOGICAL_CPU_ID + 1, gpuCount: MAX_GPU_DEVICES });
    expect(zCreateGrantBundleRequest.safeParse({ serverId, name: 'x', ...quotas, gpuCount: MAX_GPU_DEVICES + 1 }).success)
      .toBe(false);
  });

  it('grants CPU only in whole cores', () => {
    const base = { serverId, name: 'b', ...quotas };
    expect(zCreateGrantBundleRequest.safeParse({ ...base, cpuCores: 4 }).success).toBe(true);
    expect(zCreateGrantBundleRequest.safeParse({ ...base, cpuCores: 0 }).success).toBe(false);
    expect(zCreateGrantBundleRequest.safeParse({ ...base, cpuCores: 1.5 }).success).toBe(false);
    expect(zCreateGrantBundleRequest.safeParse({ ...base, cpuMillis: 1_000 }).success).toBe(false);
  });

  it('spells unlimited only as null: a zero quota is rejected, zero GPUs is allowed', () => {
    const base = { serverId, name: 'b', ...quotas };
    expect(zCreateGrantBundleRequest.safeParse({ ...base, memBytes: 0 }).success).toBe(false);
    expect(zCreateGrantBundleRequest.safeParse({ ...base, rootDiskBytes: 0 }).success).toBe(false);
    expect(zCreateGrantBundleRequest.safeParse({ ...base, gpuCount: 0 }).success).toBe(true);
    expect(zServerGrantOverrides.safeParse({ memBytes: 0 }).success).toBe(false);
    expect(zCreateGrantBundleRequest.safeParse({ ...base, diskBytes: 0 }).success).toBe(false);
    expect(zCreateGrantBundleRequest.safeParse({ ...base, dataDisks: [{ poolId, capBytes: 0 }] }).success).toBe(false);
    expect(zPutSharedBackendGrantRequest.safeParse({ limitBytes: 0, expiresAt: null }).success).toBe(false);
  });

  it('always sizes storage: there is no unlimited disk total or shared backend', () => {
    const base = { serverId, name: 'b', ...quotas };
    expect(zCreateGrantBundleRequest.safeParse({ ...base, diskBytes: null }).success).toBe(false);
    expect(zServerGrantOverrides.safeParse({ diskBytes: null }).success).toBe(false);
    expect(zPatchGrantBundleRequest.safeParse({ expectedRevision: 1, diskBytes: null }).success).toBe(false);
    expect(zPutSharedBackendGrantRequest.safeParse({ limitBytes: null, expiresAt: null }).success).toBe(false);
    // A data disk's ceiling and the system disks' ceiling may be null: only the total then.
    expect(zCreateGrantBundleRequest.safeParse({ ...base, dataDisks: [{ poolId, capBytes: null }] }).success).toBe(true);
  });

  it('lists each data disk once, up to the limit, and needs the whole list', () => {
    const base = { serverId, name: 'b', ...quotas };
    expect(zCreateGrantBundleRequest.safeParse({ ...base, dataDisks: [{ poolId, capBytes: null }, { poolId, capBytes: 1 }] })
      .success).toBe(false);
    const many = Array.from({ length: MAX_GRANT_DATA_DISKS + 1 }, (_, index) => ({
      poolId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
      capBytes: null,
    }));
    expect(zCreateGrantBundleRequest.safeParse({ ...base, dataDisks: many }).success).toBe(false);
    const withoutDisks: Partial<typeof base> = { ...base };
    delete withoutDisks.dataDisks;
    expect(zCreateGrantBundleRequest.safeParse(withoutDisks).success).toBe(false);
    // A patch without `dataDisks` keeps the list (no default fills it in).
    expect(zPatchGrantBundleRequest.parse({ expectedRevision: 1, diskBytes: 2 })).toEqual({ expectedRevision: 1, diskBytes: 2 });
    expect(zServerGrantOverrides.parse({ diskBytes: 2 })).toEqual({ diskBytes: 2 });
    expect(zCreateGrantBundleRequest.safeParse({ ...base, dataDisks: [{ poolId, capBytes: null, limitBytes: 1 }] })
      .success).toBe(false);
  });

  it('gives a system disk what both the total and the ceiling leave', () => {
    const gib = 1024 ** 3;
    expect(systemDiskRoom({ diskBytes: 100 * gib, rootDiskBytes: null, rootCommittedBytes: 30 * gib, dataUsedBytes: 50 * gib }))
      .toBe(20 * gib);
    expect(systemDiskRoom({ diskBytes: 100 * gib, rootDiskBytes: 40 * gib, rootCommittedBytes: 30 * gib, dataUsedBytes: 0 }))
      .toBe(10 * gib);
    expect(systemDiskRoom({ diskBytes: 100 * gib, rootDiskBytes: 40 * gib, rootCommittedBytes: 50 * gib, dataUsedBytes: 0 }))
      .toBe(0);
    expect(systemDiskRoom({ diskBytes: 10 * gib, rootDiskBytes: null, rootCommittedBytes: 0, dataUsedBytes: 20 * gib }))
      .toBe(0);
  });

  it('keeps an override key with null (unlimited) apart from an absent key (follow the bundle)', () => {
    const parsed = zPutServerGrantRequest.parse({ bundleId: poolId, overrides: { memBytes: null, gpuCount: 2 } });
    expect(parsed).toEqual({
      bundleId: poolId,
      overrides: { memBytes: null, gpuCount: 2 },
      expiresAt: null,
      replace: false,
    });
    expect('cpuCores' in parsed.overrides).toBe(false);
    expect(zPutServerGrantRequest.safeParse({ bundleId: poolId, overrides: { volumeBytes: 1 } }).success).toBe(false);
    expect(zPutServerGrantRequest.parse({ bundleId: poolId, overrides: { diskBytes: 1, dataDisks: [] } }).overrides)
      .toEqual({ diskBytes: 1, dataDisks: [] });
  });

  it('needs at least one field to patch a bundle or a grant', () => {
    expect(zPatchGrantBundleRequest.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(zPatchGrantBundleRequest.safeParse({ expectedRevision: 1, gpuCount: null }).success).toBe(true);
    expect(zPatchServerGrantRequest.safeParse({}).success).toBe(false);
    expect(zPatchServerGrantRequest.safeParse({ overrides: {} }).success).toBe(true);
    expect(zPatchServerGrantRequest.safeParse({ expiresAt: null }).success).toBe(true);
  });

  it('never lets a container request a CPU size or zero memory', () => {
    const base = {
      serverId,
      imageId: poolId,
      name: 'work',
      rootSizeBytes: 1_024,
      powerIntent: 'running',
    };
    expect(zCreateContainerRequest.safeParse({ ...base, memBytes: 1_024 }).success).toBe(true);
    expect(zCreateContainerRequest.safeParse({ ...base, memBytes: 0 }).success).toBe(false);
    expect(zCreateContainerRequest.safeParse({ ...base, memBytes: 1_024, cpuMillis: 0 }).success).toBe(false);
  });

  it('uses a shared-backend grant body without an expiry-free limit', () => {
    expect(zPutSharedBackendGrantRequest.parse({
      limitBytes: 10_000,
      expiresAt: '2026-12-01T00:00:00.000Z',
    })).toEqual({
      limitBytes: 10_000,
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
  });
});

describe('canonical resource mutation boundaries', () => {
  it('rejects old display-index and volume source fields', () => {
    expect(zCreateContainerRequest.safeParse({
      serverId,
      imageId: poolId,
      name: 'work',
      rootSizeBytes: 1_024,
      memBytes: 1_024,
            powerIntent: 'running',
      volumeSource: backendId,
    }).success).toBe(false);
  });

  it('validates shared backend metadata without physical mutation fields', () => {
    expect(zCreateSharedBackendRequest.parse({
      name: 'cephfs-main',
      displayName: null,
      identityKey: 'cephfs:cluster-a/fs-a',
      cephFsid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      overcommitRatio: 1,
    }).identityKey).toBe('cephfs:cluster-a/fs-a');
    expect(zPatchSharedBackendRequest.safeParse({
      expectedRevision: 1,
      identityKey: 'changed',
    }).success).toBe(false);
  });

  it('keeps structured failure codes stable', () => {
    expect(FailureCode.VolumeShrinkRequiresDetach).toBe('VOLUME_SHRINK_REQUIRES_DETACH');
    expect(FailureCode.VolumeUsageUnknown).toBe('VOLUME_USAGE_UNKNOWN');
    expect(FailureCode.RootUsageUnknown).toBe('ROOT_USAGE_UNKNOWN');
  });
});
