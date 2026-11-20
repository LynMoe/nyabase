import type { GrantBundleQuotas } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { diskEntryWarnings } from './grant-preview.js';

const base: GrantBundleQuotas = {
  cpuCores: null,
  memBytes: null,
  diskBytes: 1_000,
  rootDiskBytes: null,
  gpuCount: null,
  dataDisks: [{ poolId: 'a', capBytes: null }, { poolId: 'b', capBytes: 500 }],
};

describe('diskEntryWarnings', () => {
  it('warns about nothing when nothing the user holds is affected', () => {
    expect(diskEntryWarnings({ before: base, after: { ...base, diskBytes: 900 }, rootBytes: 100, dataByPool: new Map([['a', 200]]) }))
      .toEqual({ rootDiskBytesInUse: null, diskBytesInUse: null, dataDisksRevoked: [], dataDisksOverCap: [] });
  });

  it('charges the total with system disks plus data on the disks the grant keeps', () => {
    const dataByPool = new Map([['a', 300], ['b', 400]]);
    // b leaves the list: its data no longer counts, its volume lapses.
    const after = { ...base, diskBytes: 350, dataDisks: [{ poolId: 'a', capBytes: null }] };
    expect(diskEntryWarnings({ before: base, after, rootBytes: 100, dataByPool })).toEqual({
      rootDiskBytesInUse: null,
      diskBytesInUse: 400,
      dataDisksRevoked: ['b'],
      dataDisksOverCap: [],
    });
  });

  it('only names a revoked disk where the user has a volume', () => {
    const after = { ...base, dataDisks: [] };
    expect(diskEntryWarnings({ before: base, after, rootBytes: 0, dataByPool: new Map([['b', 0]]) }).dataDisksRevoked)
      .toEqual(['b']);
  });

  it('warns about data over a ceiling only when the ceiling changes', () => {
    const dataByPool = new Map([['a', 300], ['b', 600]]);
    // b is already over its unchanged 500: no new warning; a gets a new 200.
    const after = { ...base, dataDisks: [{ poolId: 'a', capBytes: 200 }, { poolId: 'b', capBytes: 500 }] };
    expect(diskEntryWarnings({ before: base, after, rootBytes: 0, dataByPool }).dataDisksOverCap)
      .toEqual([{ poolId: 'a', usedBytes: 300, capBytes: 200 }]);
  });

  it('keeps an already-exceeded total quiet unless the total or the list changes', () => {
    const dataByPool = new Map([['a', 2_000]]);
    expect(diskEntryWarnings({ before: base, after: { ...base, cpuCores: 4 }, rootBytes: 0, dataByPool }).diskBytesInUse)
      .toBeNull();
    expect(diskEntryWarnings({ before: base, after: { ...base, diskBytes: 999 }, rootBytes: 0, dataByPool }).diskBytesInUse)
      .toBe(2_000);
  });

  it('warns about system disks over a lowered ceiling', () => {
    expect(diskEntryWarnings({
      before: base, after: { ...base, rootDiskBytes: 50 }, rootBytes: 100, dataByPool: new Map(),
    }).rootDiskBytesInUse).toBe(100);
  });
});
