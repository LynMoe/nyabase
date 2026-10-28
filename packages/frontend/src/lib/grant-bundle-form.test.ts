import { describe, expect, it } from 'vitest';
import type { GrantBundleDto } from '@nyabase/common';
import {
  bundleChanges,
  bundleInUseUsers,
  bundleOptionLabel,
  formatQuotaValue,
  isGrantBundleDto,
  overrideDraftFrom,
  overriddenFields,
  parseOverrideDraft,
  parseQuotaText,
  parseQuotaTexts,
  quotasToTexts,
  rebaseBundleDraft,
  toggleOverride,
} from './grant-bundle-form.js';
import { GIB } from './utils.js';

const bundle: GrantBundleDto = {
  id: 'b1',
  serverId: 's1',
  name: '标准',
  cpuCores: 4,
  memBytes: 16 * GIB,
  rootDiskBytes: 100 * GIB,
  gpuCount: null,
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
    expect(parseQuotaText('gpuCount', '')).toBeNull();
    expect(parseQuotaText('gpuCount', '0')).toBe(0);
    expect(parseQuotaText('gpuCount', '-1')).toBeUndefined();
  });

  it('round-trips a bundle through its input texts', () => {
    expect(quotasToTexts(bundle)).toEqual({ cpuCores: '4', memBytes: '16', rootDiskBytes: '100', gpuCount: '' });
    expect(parseQuotaTexts(quotasToTexts(bundle))).toEqual({
      cpuCores: 4, memBytes: 16 * GIB, rootDiskBytes: 100 * GIB, gpuCount: null,
    });
    expect(parseQuotaTexts({ cpuCores: 'x', memBytes: '', rootDiskBytes: '', gpuCount: '' })).toBeUndefined();
  });

  it('formats each field in its own unit', () => {
    expect(formatQuotaValue('cpuCores', null)).toBe('不限');
    expect(formatQuotaValue('cpuCores', 4)).toBe('4 核');
    expect(formatQuotaValue('memBytes', 16 * GIB)).toBe('16 GiB');
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
    expect(rebased.texts).toEqual({ cpuCores: '8', memBytes: '24', rootDiskBytes: '100', gpuCount: '2' });
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
    expect(draft.overridden).toEqual({ cpuCores: true, memBytes: true, rootDiskBytes: false, gpuCount: false });
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
    expect(isGrantBundleDto(null)).toBe(false);
  });

  it('reads the users of GRANT_BUNDLE_IN_USE', () => {
    expect(bundleInUseUsers({ users: [{ userId: 'u1', username: 'alice' }, { userId: 3 }] }))
      .toEqual([{ userId: 'u1', username: 'alice' }]);
    expect(bundleInUseUsers(null)).toEqual([]);
  });

  it('labels a bundle with its server', () => {
    expect(bundleOptionLabel(bundle, 'gpu-1')).toBe('标准 · gpu-1');
  });
});
