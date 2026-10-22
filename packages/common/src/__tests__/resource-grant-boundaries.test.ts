import { describe, expect, it } from 'vitest';
import {
  FailureCode,
  MAX_RESOURCE_BYTES,
  MAX_SERVER_LOGICAL_CPU_ID,
  zCreateContainerRequest,
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
  it('accepts GPU grants at the safe numeric limits', () => {
    expect(zPutServerGrantRequest.parse({
      cpuCores: MAX_SERVER_LOGICAL_CPU_ID + 1,
      memBytes: MAX_RESOURCE_BYTES,
      diskBytes: MAX_RESOURCE_BYTES,
      gpuPciAddresses: [],
      expiresAt: null,
    })).toMatchObject({
      cpuCores: MAX_SERVER_LOGICAL_CPU_ID + 1,
      gpuPciAddresses: [],
    });
  });

  it('grants CPU only in whole cores', () => {
    const base = { memBytes: null, diskBytes: null, gpuPciAddresses: [], expiresAt: null };
    expect(zPutServerGrantRequest.safeParse({ ...base, cpuCores: null }).success).toBe(true);
    expect(zPutServerGrantRequest.safeParse({ ...base, cpuCores: 4 }).success).toBe(true);
    expect(zPutServerGrantRequest.safeParse({ ...base, cpuCores: 0 }).success).toBe(false);
    expect(zPutServerGrantRequest.safeParse({ ...base, cpuCores: 1.5 }).success).toBe(false);
    expect(zPutServerGrantRequest.safeParse({ ...base, cpuMillis: 1_000 }).success).toBe(false);
  });

  it('spells unlimited only as null: a zero quota is rejected', () => {
    const base = { cpuCores: null, memBytes: null, diskBytes: null, gpuPciAddresses: [], expiresAt: null };
    expect(zPutServerGrantRequest.safeParse({ ...base, memBytes: 0 }).success).toBe(false);
    expect(zPutServerGrantRequest.safeParse({ ...base, diskBytes: 0 }).success).toBe(false);
    expect(zPutSharedBackendGrantRequest.safeParse({ limitBytes: 0, expiresAt: null }).success).toBe(false);
    expect(zPutSharedBackendGrantRequest.safeParse({ limitBytes: null, expiresAt: null }).success).toBe(true);
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
    expect(zPutStoragePoolGrantRequest.parse({ expiresAt: null })).toEqual({ expiresAt: null });
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
