import { describe, expect, it } from 'vitest';
import { FailureCode, type StoragePoolCapabilityDto } from '@nyabase/common';
import { ApiError } from './api-error.js';
import {
  classifySizeChange,
  formatDetachProgress,
  formatObservedUsage,
  isQuotaIneffectiveCapability,
  observedRootUsedBytes,
  identityConflictFromDiscoverIssue,
  parseSharedBackendFsidConflict,
  parseVolumeShrinkAttachments,
  quotaIneffectiveCreateHint,
  shrinkNeverTooltip,
  validateShrinkFloor,
  waitUntil,
} from './storage-shrink.js';

const online: StoragePoolCapabilityDto = {
  growOnline: true,
  shrinkOnline: true,
  shrinkRequiresStop: false,
  shrinkNever: false,
  enforceUsageFloor: true,
};

const requiresStop: StoragePoolCapabilityDto = {
  growOnline: true,
  shrinkOnline: false,
  shrinkRequiresStop: true,
  shrinkNever: false,
  enforceUsageFloor: true,
};

const never: StoragePoolCapabilityDto = {
  growOnline: true,
  shrinkOnline: false,
  shrinkRequiresStop: false,
  shrinkNever: true,
  enforceUsageFloor: true,
};

const quotaOnlineIneffective: StoragePoolCapabilityDto = {
  growOnline: true,
  shrinkOnline: false,
  shrinkRequiresStop: false,
  shrinkNever: false,
  enforceUsageFloor: false,
};

describe('classifySizeChange', () => {
  it('uses capability flags instead of driver names', () => {
    expect(classifySizeChange(online, 10, 20)).toBe('grow');
    expect(classifySizeChange(online, 10, 10)).toBe('unchanged');
    expect(classifySizeChange(online, 10, 8)).toBe('online');
    expect(classifySizeChange(requiresStop, 10, 8)).toBe('requires_stop');
    expect(classifySizeChange(never, 10, 8)).toBe('never');
  });

  it('classifies quota-online shrinkOnline:false as never, not online', () => {
    expect(isQuotaIneffectiveCapability(quotaOnlineIneffective)).toBe(true);
    expect(classifySizeChange(quotaOnlineIneffective, 10, 8)).toBe('never');
    expect(classifySizeChange(quotaOnlineIneffective, 10, 20)).toBe('grow');
    expect(quotaIneffectiveCreateHint()).toMatch(/配额未生效/);
  });
});

describe('observedRootUsedBytes', () => {
  it('never treats pending desired size as used bytes', () => {
    expect(observedRootUsedBytes({ rootSizePendingBytes: 8 })).toBeNull();
    expect(observedRootUsedBytes({ rootUsedBytes: 3, rootSizePendingBytes: 8 })).toBe(3);
  });
});

describe('validateShrinkFloor', () => {
  it('rejects targets below used when usage floor is enforced', () => {
    expect(validateShrinkFloor(online, 4, 5)).toMatch(/已用量/);
    expect(validateShrinkFloor(online, 4, 5)).not.toMatch(/5 字节/);
    expect(validateShrinkFloor(online, 6, 5)).toBeNull();
  });

  it('rejects quota-online used===size as real usage, not phantom empty', () => {
    expect(validateShrinkFloor(online, 4, 10, 10)).toMatch(/已用量/);
  });

  it('rejects quota-online shrink when used bytes are unknown', () => {
    expect(validateShrinkFloor(online, 4, null)).toMatch(/已用量未知/);
    expect(validateShrinkFloor(quotaOnlineIneffective, 4, null)).toBeNull();
  });

  it('treats used=0 as a known empty floor, not unknown', () => {
    expect(validateShrinkFloor(online, 4, 0)).toBeNull();
  });
});

describe('formatObservedUsage', () => {
  it('prints 未知 for null and never coalesces to 0B', () => {
    expect(formatObservedUsage(null)).toBe('未知');
    expect(formatObservedUsage(null)).not.toMatch(/0\s*B|0\s*GiB/);
    expect(formatObservedUsage(0)).toMatch(/0/);
    expect(formatObservedUsage(0)).not.toBe('未知');
  });
});

describe('shrinkNeverTooltip', () => {
  it('stays capability-driven without hardcoding XFS', () => {
    expect(shrinkNeverTooltip()).not.toMatch(/XFS/i);
    expect(shrinkNeverTooltip()).toMatch(/不支持缩容/);
  });
});

describe('parseVolumeShrinkAttachments', () => {
  it('reads VOLUME_SHRINK_REQUIRES_DETACH attachment details', () => {
    const error = new ApiError(409, FailureCode.VolumeShrinkRequiresDetach, 'detach first', {
      code: FailureCode.VolumeShrinkRequiresDetach,
      message: 'detach first',
      details: {
        attachments: [
          { attachmentId: 'a1', containerId: 'c1', containerPath: '/data' },
          { attachmentId: 'bad' },
        ],
      },
    });
    expect(parseVolumeShrinkAttachments(error)).toEqual([
      { attachmentId: 'a1', containerId: 'c1', containerPath: '/data' },
    ]);
  });
});

describe('parseSharedBackendFsidConflict', () => {
  it('surfaces identity/FSID conflict payload fields', () => {
    const error = new ApiError(409, FailureCode.SharedBackendIdentityConflict, 'FSID mismatch', {
      code: FailureCode.SharedBackendIdentityConflict,
      message: 'FSID mismatch',
      details: {
        identityKey: 'cephfs:ceph/fs/data',
        expectedFsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        discoveredFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });
    expect(parseSharedBackendFsidConflict(error)).toEqual({
      identityKey: 'cephfs:ceph/fs/data',
      expectedFsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      conflictingFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      message: 'FSID mismatch',
      details: {
        identityKey: 'cephfs:ceph/fs/data',
        expectedFsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        discoveredFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });
  });
});

describe('identityConflictFromDiscoverIssue', () => {
  it('maps a sidecar identity conflict onto the FSID alert shape', () => {
    expect(identityConflictFromDiscoverIssue({
      code: FailureCode.SharedBackendIdentityConflict,
      message: 'The discovered CephFS identity is bound to another FSID',
      identityKey: 'cephfs:ceph/fs/data',
      expectedFsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      discoveredFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      existingIdentityKey: null,
      serverId: '11111111-1111-4111-8111-111111111111',
      incusName: 'cephfs-a',
      poolId: null,
    })).toEqual({
      identityKey: 'cephfs:ceph/fs/data',
      expectedFsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      conflictingFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      message: 'The discovered CephFS identity is bound to another FSID',
      details: {
        identityKey: 'cephfs:ceph/fs/data',
        expectedFsid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        discoveredFsid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        existingIdentityKey: null,
        serverId: '11111111-1111-4111-8111-111111111111',
        incusName: 'cephfs-a',
        poolId: null,
      },
    });
  });

  it('ignores non-identity sidecar codes', () => {
    expect(identityConflictFromDiscoverIssue({
      code: FailureCode.StoragePoolInUse,
      message: 'in use',
      identityKey: null,
      expectedFsid: null,
      discoveredFsid: null,
      existingIdentityKey: null,
      serverId: null,
      incusName: null,
      poolId: null,
    })).toBeNull();
  });
});

describe('formatDetachProgress', () => {
  it('renders partial failure progress explicitly', () => {
    expect(formatDetachProgress(3, 4, null, null)).toBe('已卸载 3/4');
    expect(formatDetachProgress(3, 4, 3, 'busy')).toBe('卸载成功 3 个，第 4 个失败：busy');
  });
});

describe('waitUntil', () => {
  it('surfaces onTimeout intent failure instead of the generic timeout string', async () => {
    await expect(waitUntil(async () => false, {
      timeoutMs: 20,
      intervalMs: 5,
      label: '操作',
      onTimeout: async () => 'VOLUME_RESIZE: disk full',
    })).rejects.toThrow('VOLUME_RESIZE: disk full');
  });

  it('keeps the generic timeout copy when no persistent intent failure exists', async () => {
    await expect(waitUntil(async () => false, {
      timeoutMs: 20,
      intervalMs: 5,
      label: '操作',
    })).rejects.toThrow('操作超时，请检查容器状态后重试');
  });
});
