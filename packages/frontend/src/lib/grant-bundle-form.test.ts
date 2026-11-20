import { describe, expect, it } from 'vitest';
import type { GrantBundleDto } from '@nyabase/common';
import {
  bundleChanges,
  bundleInUseUsers,
  bundleOptionGroups,
  dataDiskSummary,
  formatQuotaValue,
  isGrantBundleDto,
  overrideDraftFrom,
  overriddenFields,
  parseOverrideDraft,
  parseQuotaText,
  quotaSummaryParts,
  parseQuotaTexts,
  quotasToTexts,
  rebaseBundleDraft,
  toggleOverride,
  NEW_BUNDLE_QUOTA_TEXTS,
} from './grant-bundle-form.js';
import {
  dataDiskDraftFrom,
  diffDataDisks,
  formatDiskCap,
  parseCapText,
  sameDataDisks,
  setDataDiskCap,
  toggleDataDisk,
} from './grant-data-disks.js';
import { GIB } from './utils.js';

const bundle: GrantBundleDto = {
  id: 'b1',
  serverId: 's1',
  name: '标准',
  cpuCores: 4,
  memBytes: 16 * GIB,
  diskBytes: 500 * GIB,
  rootDiskBytes: 100 * GIB,
  gpuCount: null,
  dataDisks: [{ poolId: 'p1', capBytes: null }, { poolId: 'p2', capBytes: 200 * GIB }],
  revision: 3,
  grantCount: 2,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('quota inputs', () => {
  it('reads empty as 不限 and rejects what the API would reject', () => {
    expect(parseQuotaText('cpuCores', '')).toBeNull();
    expect(parseQuotaText('cpuCores', '8')).toBe(8);
    expect(parseQuotaText('cpuCores', '0')).toBeUndefined();
    expect(parseQuotaText('cpuCores', '1.5')).toBeUndefined();
    expect(parseQuotaText('memBytes', '2')).toBe(2 * GIB);
    expect(parseQuotaText('rootDiskBytes', '0')).toBeUndefined();
    expect(parseQuotaText('rootDiskBytes', '')).toBeNull();
    // The disk total is required: there is no unlimited one.
    expect(parseQuotaText('diskBytes', '')).toBeUndefined();
    expect(parseQuotaText('diskBytes', '0')).toBeUndefined();
    expect(parseQuotaText('diskBytes', '2')).toBe(2 * GIB);
    expect(parseQuotaText('gpuCount', '')).toBeNull();
    expect(parseQuotaText('gpuCount', '0')).toBe(0);
    expect(parseQuotaText('gpuCount', '-1')).toBeUndefined();
  });

  it('round-trips a bundle through its input texts', () => {
    expect(quotasToTexts(bundle)).toEqual({ cpuCores: '4', memBytes: '16', diskBytes: '500', rootDiskBytes: '100', gpuCount: '' });
    expect(parseQuotaTexts(quotasToTexts(bundle))).toEqual({
      cpuCores: 4, memBytes: 16 * GIB, diskBytes: 500 * GIB, rootDiskBytes: 100 * GIB, gpuCount: null,
    });
    expect(parseQuotaTexts({ cpuCores: 'x', memBytes: '', diskBytes: '1', rootDiskBytes: '', gpuCount: '' })).toBeUndefined();
    // A new bundle cannot be saved until the disk total is filled in.
    expect(parseQuotaTexts(NEW_BUNDLE_QUOTA_TEXTS)).toBeUndefined();
    expect(parseQuotaTexts({ ...NEW_BUNDLE_QUOTA_TEXTS, diskBytes: '100' })).toMatchObject({ diskBytes: 100 * GIB, gpuCount: 0 });
  });

  it('formats each field in its own unit', () => {
    expect(formatQuotaValue('cpuCores', null)).toBe('不限');
    expect(formatQuotaValue('cpuCores', 4)).toBe('4 核');
    expect(formatQuotaValue('memBytes', 16 * GIB)).toBe('16 GiB');
    expect(formatQuotaValue('diskBytes', 2 * 1024 * GIB)).toBe('2 TiB');
    expect(formatQuotaValue('rootDiskBytes', null)).toBe('只受总额限制');
    expect(formatQuotaValue('gpuCount', null)).toBe('全部 GPU');
    expect(formatQuotaValue('gpuCount', 0)).toBe('无');
    expect(formatQuotaValue('gpuCount', null, { gpuEnabled: false })).toBe('无');
    expect(formatQuotaValue('gpuCount', null, { gpuEnabled: true })).toBe('全部 GPU');
  });
});

describe('bundleChanges', () => {
  it('sends only the fields that differ from the stored bundle', () => {
    const texts = quotasToTexts(bundle);
    expect(bundleChanges(bundle, '标准', texts)).toEqual({});
    expect(bundleChanges(bundle, '标准', { ...texts, diskBytes: '' })).toBeUndefined();
    expect(bundleChanges(bundle, '标准', { ...texts, diskBytes: '1024', rootDiskBytes: '' }))
      .toEqual({ diskBytes: 1024 * GIB, rootDiskBytes: null });
    expect(bundleChanges(bundle, ' 大 ', { ...texts, memBytes: '', gpuCount: '1' }))
      .toEqual({ name: '大', memBytes: null, gpuCount: 1 });
    expect(bundleChanges(bundle, '标准', { ...texts, cpuCores: 'x' })).toBeUndefined();
  });

  it('keeps a value the GiB input cannot show exactly as it is (a rename changes nothing else)', () => {
    const odd = { ...bundle, memBytes: GIB + 1, rootDiskBytes: Math.round(2.0004 * GIB) };
    const texts = quotasToTexts(odd);
    expect(texts.memBytes).toBe('1');
    expect(parseQuotaTexts(texts, odd)?.memBytes).toBe(GIB + 1);
    expect(bundleChanges(odd, '改名', texts)).toEqual({ name: '改名' });
    // Typing a different amount is a change again.
    expect(bundleChanges(odd, '标准', { ...texts, memBytes: '2' })).toEqual({ memBytes: 2 * GIB });
  });
});

describe('rebaseBundleDraft', () => {
  it('takes the newer revision for untouched fields and keeps the edited ones', () => {
    const newer = { ...bundle, name: '标准-新', cpuCores: 8, memBytes: 32 * GIB, gpuCount: 2, revision: 4 };
    const edited = { ...quotasToTexts(bundle), memBytes: '24' };
    const rebased = rebaseBundleDraft(bundle, newer, '标准', edited);
    expect(rebased.name).toBe('标准-新');
    expect(rebased.texts).toEqual({ cpuCores: '8', memBytes: '24', diskBytes: '500', rootDiskBytes: '100', gpuCount: '2' });
    expect(bundleChanges(newer, rebased.name, rebased.texts)).toEqual({ memBytes: 24 * GIB });
  });

  it('keeps a renamed draft', () => {
    const newer = { ...bundle, name: '别人改的', revision: 4 };
    expect(rebaseBundleDraft(bundle, newer, '我改的', quotasToTexts(bundle)).name).toBe('我改的');
  });
});

describe('override drafts', () => {
  it('marks the keys present on the grant as overridden, null included', () => {
    const draft = overrideDraftFrom({ memBytes: null, cpuCores: 8 });
    expect(draft.overridden).toEqual({
      cpuCores: true, memBytes: true, diskBytes: false, rootDiskBytes: false, gpuCount: false, dataDisks: false,
    });
    expect(draft.texts.cpuCores).toBe('8');
    expect(draft.texts.memBytes).toBe('');
    expect(overriddenFields({ memBytes: null })).toEqual(['memBytes']);
  });

  it('sends the complete override set: ticked fields only, empty meaning 不限', () => {
    let draft = overrideDraftFrom();
    expect(parseOverrideDraft(draft)).toEqual({});
    draft = toggleOverride(draft, 'memBytes', true, bundle);
    expect(draft.texts.memBytes).toBe('16');
    draft = { ...draft, texts: { ...draft.texts, memBytes: '' } };
    draft = toggleOverride(draft, 'cpuCores', true, bundle);
    expect(parseOverrideDraft(draft)).toEqual({ memBytes: null, cpuCores: 4 });
    draft = toggleOverride(draft, 'cpuCores', false, bundle);
    expect(parseOverrideDraft(draft)).toEqual({ memBytes: null });
    draft = toggleOverride(draft, 'gpuCount', true, bundle);
    draft = { ...draft, texts: { ...draft.texts, gpuCount: '-2' } };
    expect(parseOverrideDraft(draft)).toBeUndefined();
  });

  it('re-saves stored overrides and pre-filled bundle values with their exact bytes', () => {
    const stored = { memBytes: GIB + 1 };
    const draft = toggleOverride(overrideDraftFrom(stored), 'rootDiskBytes', true, { ...bundle, rootDiskBytes: GIB + 7 });
    expect(draft.texts).toMatchObject({ memBytes: '1', rootDiskBytes: '1' });
    expect(parseOverrideDraft(draft, { overrides: stored, bundle: { ...bundle, rootDiskBytes: GIB + 7 } }))
      .toEqual({ memBytes: GIB + 1, rootDiskBytes: GIB + 7 });
  });

  it('does not pre-fill a field whose bundle value is unknown', () => {
    const draft = toggleOverride(overrideDraftFrom(), 'cpuCores', true, {});
    expect(draft.texts.cpuCores).toBe('');
  });
});

describe('bundle conflict payloads', () => {
  it('accepts a well-formed current bundle only', () => {
    expect(isGrantBundleDto(bundle)).toBe(true);
    expect(isGrantBundleDto({ ...bundle, revision: '3' })).toBe(false);
    expect(isGrantBundleDto({ ...bundle, memBytes: 'big' })).toBe(false);
    expect(isGrantBundleDto({ ...bundle, diskBytes: null })).toBe(false);
    expect(isGrantBundleDto({ ...bundle, dataDisks: [{ poolId: 1 }] })).toBe(false);
    expect(isGrantBundleDto(null)).toBe(false);
  });

  it('reads the users of GRANT_BUNDLE_IN_USE', () => {
    expect(bundleInUseUsers({ users: [{ userId: 'u1', username: 'alice' }, { userId: 3 }] }))
      .toEqual([{ userId: 'u1', username: 'alice' }]);
    expect(bundleInUseUsers(null)).toEqual([]);
  });

  it('groups bundles under their server, by name', () => {
    const names: Record<string, string> = { s1: 'gpu-2', s2: 'gpu-1' };
    expect(bundleOptionGroups([
      { id: 'b1', name: '大', serverId: 's1' },
      { id: 'b2', name: '标准', serverId: 's2' },
      { id: 'b3', name: '小', serverId: 's1' },
    ], (id) => names[id]!)).toEqual([
      { key: 's2', label: 'gpu-1', options: [['b2', '标准']] },
      { key: 's1', label: 'gpu-2', options: [['b1', '大'], ['b3', '小']] },
    ]);
  });
});

describe('grant summaries', () => {
  it('names each quota on one line, the disk total with its system-disk ceiling', () => {
    expect(quotaSummaryParts({ cpuCores: 16, memBytes: 32 * GIB, diskBytes: 2 * 1024 * GIB, rootDiskBytes: null, gpuCount: 2 }))
      .toEqual(['CPU 16 核', '内存 32 GiB', '磁盘 2 TiB', '2 张 GPU']);
    expect(quotaSummaryParts(
      { cpuCores: null, memBytes: null, diskBytes: 1024 * GIB, rootDiskBytes: 800 * GIB, gpuCount: null },
      { gpuEnabled: false },
    )).toEqual(['CPU 不限', '内存 不限', '磁盘 1 TiB（系统盘 ≤ 800 GiB）', '无 GPU']);
  });

  it('counts the data disks (they share the disk total, so nothing to sum)', () => {
    expect(dataDiskSummary([])).toBe('无数据盘');
    expect(dataDiskSummary([{ poolId: 'a', capBytes: null }, { poolId: 'b', capBytes: GIB }])).toBe('数据盘 2 块');
  });
});

describe('data-disk lists in bundle drafts', () => {
  it('sends the list only when it really changed, in any order', () => {
    const texts = quotasToTexts(bundle);
    const reordered = dataDiskDraftFrom([...bundle.dataDisks].reverse());
    expect(bundleChanges(bundle, '标准', texts, reordered)).toEqual({});
    const dropped = toggleDataDisk(dataDiskDraftFrom(bundle.dataDisks), 'p1', false);
    expect(bundleChanges(bundle, '标准', texts, dropped)).toEqual({ dataDisks: [{ poolId: 'p2', capBytes: 200 * GIB }] });
    const added = toggleDataDisk(dataDiskDraftFrom(bundle.dataDisks), 'p3', true);
    expect(bundleChanges(bundle, '标准', texts, setDataDiskCap(added, 'p3', '50'))?.dataDisks)
      .toEqual([...bundle.dataDisks, { poolId: 'p3', capBytes: 50 * GIB }]);
    expect(bundleChanges(bundle, '标准', texts, setDataDiskCap(added, 'p3', '0'))).toBeUndefined();
  });

  it('keeps a ceiling the GiB input cannot show exactly, and rebases an untouched list', () => {
    const odd = { ...bundle, dataDisks: [{ poolId: 'p1', capBytes: GIB + 5 }] };
    const draft = dataDiskDraftFrom(odd.dataDisks);
    expect(draft).toEqual([{ poolId: 'p1', capText: '1' }]);
    expect(bundleChanges(odd, '标准', quotasToTexts(odd), draft)).toEqual({});
    const newer = { ...bundle, dataDisks: [{ poolId: 'p9', capBytes: null }], revision: 4 };
    expect(rebaseBundleDraft(odd, newer, '标准', quotasToTexts(odd), draft).disks).toEqual([{ poolId: 'p9', capText: '' }]);
    // An edited list is kept over the newer revision's.
    const edited = toggleDataDisk(draft, 'p2', true);
    expect(rebaseBundleDraft(odd, newer, '标准', quotasToTexts(odd), edited).disks).toEqual(edited);
  });

  it('compares lists and reports what a change adds, removes and re-caps', () => {
    expect(sameDataDisks([{ poolId: 'a', capBytes: null }], [{ poolId: 'a', capBytes: null }])).toBe(true);
    expect(sameDataDisks([{ poolId: 'a', capBytes: null }], [{ poolId: 'a', capBytes: 1 }])).toBe(false);
    expect(diffDataDisks(
      [{ poolId: 'a', capBytes: null }, { poolId: 'b', capBytes: 1 }],
      [{ poolId: 'b', capBytes: 2 }, { poolId: 'c', capBytes: null }],
    )).toEqual({
      added: [{ poolId: 'c', capBytes: null }],
      removed: [{ poolId: 'a', capBytes: null }],
      capChanged: [{ poolId: 'b', before: 1, after: 2 }],
    });
    expect(parseCapText('')).toBeNull();
    expect(parseCapText('-1')).toBeUndefined();
    expect(formatDiskCap(null)).toBe('只受总额限制');
    expect(formatDiskCap(GIB)).toBe('≤ 1 GiB');
  });
});

describe('data-disk overrides', () => {
  it('overrides the whole list, starting from the bundle\'s, and sends [] as a real override', () => {
    let draft = toggleOverride(overrideDraftFrom(), 'dataDisks', true, bundle);
    expect(draft.overridden.dataDisks).toBe(true);
    expect(draft.disks).toEqual(dataDiskDraftFrom(bundle.dataDisks));
    expect(parseOverrideDraft(draft, { bundle })).toEqual({ dataDisks: bundle.dataDisks });
    draft = { ...draft, disks: [] };
    expect(parseOverrideDraft(draft, { bundle })).toEqual({ dataDisks: [] });
    draft = toggleOverride(draft, 'dataDisks', false, bundle);
    expect(parseOverrideDraft(draft, { bundle })).toEqual({});
  });

  it('reads a stored own list back, empty included, and refuses a bad ceiling', () => {
    expect(overrideDraftFrom({ dataDisks: [] }).overridden.dataDisks).toBe(true);
    expect(overriddenFields({ dataDisks: [], diskBytes: GIB })).toEqual(['diskBytes', 'dataDisks']);
    const stored = { dataDisks: [{ poolId: 'p1', capBytes: GIB + 3 }] };
    const draft = overrideDraftFrom(stored);
    expect(parseOverrideDraft(draft, { overrides: stored, bundle })).toEqual(stored);
    expect(parseOverrideDraft({ ...draft, disks: setDataDiskCap(draft.disks, 'p1', 'x') }, { overrides: stored }))
      .toBeUndefined();
  });

  it('overrides the disk total with a value only', () => {
    let draft = toggleOverride(overrideDraftFrom(), 'diskBytes', true, bundle);
    expect(draft.texts.diskBytes).toBe('500');
    expect(parseOverrideDraft(draft, { bundle })).toEqual({ diskBytes: 500 * GIB });
    draft = { ...draft, texts: { ...draft.texts, diskBytes: '' } };
    expect(parseOverrideDraft(draft, { bundle })).toBeUndefined();
  });
});
