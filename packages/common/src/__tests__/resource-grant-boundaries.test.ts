import { describe, expect, it } from 'vitest';
import {
  FailureCode,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_CPU_MILLIS,
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
  it('accepts opaque extension grants at the safe numeric limits', () => {
    expect(zPutServerGrantRequest.parse({
      cpuMillis: MAX_RESOURCE_CPU_MILLIS,
      memBytes: MAX_RESOURCE_BYTES,
      diskBytes: MAX_RESOURCE_BYTES,
      extensionGrants: {},
      expiresAt: null,
    })).toMatchObject({
      cpuMillis: MAX_RESOURCE_CPU_MILLIS,
      extensionGrants: {},
    });
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
      cpuMillis: 1_000,
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
  });
});
