import { RootPlacement } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import {
  aboveSystemWatermark,
  parsePercentInput,
  poolUsedPercent,
  rootPlacementLabel,
  systemDiskUnsupportedReason,
} from './system-disks.js';

describe('system disks', () => {
  it('describes the root placement', () => {
    expect(rootPlacementLabel({ rootPlacement: RootPlacement.Single, rootPlacementSticky: false })).toMatch(/^单一/);
    expect(rootPlacementLabel({ rootPlacement: RootPlacement.Random, rootPlacementSticky: false })).toMatch(/^随机（/);
    expect(rootPlacementLabel({ rootPlacement: RootPlacement.Random, rootPlacementSticky: true })).toMatch(/用户粘性/);
  });

  it('says why a pool cannot be a system disk', () => {
    expect(systemDiskUnsupportedReason({ registered: false, rootDiskCapable: true, shareable: false })).toMatch(/登记/);
    expect(systemDiskUnsupportedReason({ registered: true, rootDiskCapable: false, shareable: false })).not.toBeNull();
    expect(systemDiskUnsupportedReason({ registered: true, rootDiskCapable: true, shareable: false })).toBeNull();
  });

  it('applies the high-water mark like the backend', () => {
    const pool = { usedBytes: 900, totalBytes: 1_000 };
    expect(aboveSystemWatermark({ ...pool, systemDisk: { weight: 1, maxUsedPercent: 90 } })).toBe(true);
    expect(aboveSystemWatermark({ ...pool, systemDisk: { weight: 1, maxUsedPercent: 91 } })).toBe(false);
    expect(aboveSystemWatermark({ ...pool, systemDisk: { weight: 1, maxUsedPercent: null } })).toBe(false);
    expect(aboveSystemWatermark({ ...pool, systemDisk: null })).toBe(false);
    expect(aboveSystemWatermark({ usedBytes: null, totalBytes: 1_000, systemDisk: { weight: 1, maxUsedPercent: 1 } })).toBe(false);
    expect(poolUsedPercent(pool)).toBe(90);
    expect(poolUsedPercent({ usedBytes: 1, totalBytes: null })).toBeNull();
  });

  it('parses 1-100 percent inputs', () => {
    expect(parsePercentInput('', true)).toBeNull();
    expect(parsePercentInput('', false)).toBeUndefined();
    expect(parsePercentInput(' 90 ', true)).toBe(90);
    expect(parsePercentInput('0', true)).toBeUndefined();
    expect(parsePercentInput('101', true)).toBeUndefined();
    expect(parsePercentInput('9.5', true)).toBeUndefined();
  });
});
