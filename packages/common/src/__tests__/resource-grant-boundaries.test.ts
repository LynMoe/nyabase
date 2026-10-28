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
  zPutStoragePoolGrantRequest,
} from '@nyabase/common';

const serverId = '22222222-2222-4222-8222-222222222222';
const poolId = '33333333-3333-4333-8333-333333333333';
const backendId = '44444444-4444-4444-8444-444444444444';

describe('grant resource bounds', () => {
  const quotas = { cpuCores: null, memBytes: null, rootDiskBytes: null, gpuCount: null };

  it('accepts bundles at the safe numeric limits', () => {
    expect(zCreateGrantBundleRequest.parse({
      serverId,
      name: ' GPU A ',
      cpuCores: MAX_SERVER_LOGICAL_CPU_ID + 1,
      memBytes: MAX_RESOURCE_BYTES,
      rootDiskBytes: MAX_RESOURCE_BYTES,
      gpuCount: MAX_GPU_DEVICES,
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
    expect(zPutStoragePoolGrantRequest.safeParse({ limitBytes: 0 }).success).toBe(false);
    expect(zPutSharedBackendGrantRequest.safeParse({ limitBytes: 0, expiresAt: null }).success).toBe(false);
    expect(zPutSharedBackendGrantRequest.safeParse({ limitBytes: null, expiresAt: null }).success).toBe(true);
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
    expect(zPutServerGrantRequest.safeParse({ bundleId: poolId, overrides: { diskBytes: 1 } }).success).toBe(false);
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

  it('uses independent pool and shared-backend grant bodies', () => {
    expect(zPutStoragePoolGrantRequest.parse({ limitBytes: 10_000 })).toEqual({ limitBytes: 10_000 });
    expect(zPutSharedBackendGrantRequest.parse({
      limitBytes: 10_000,
      expiresAt: '2026-12-01T00:00:00.000Z',
    })).toEqual({
      limitBytes: 10_000,
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(zPutStoragePoolGrantRequest.safeParse({ limitBytes: 10_000, expiresAt: null }).success)
      .toBe(false);
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
