import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND_TITLE, formatDocumentTitle, pageHeaderTitleParts } from './use-document-title.js';

function headerTitle(props: Parameters<typeof pageHeaderTitleParts>[0], brand = 'nyabase'): string | null {
  const parts = pageHeaderTitleParts(props);
  return parts === null ? null : formatDocumentTitle(parts, brand);
}

describe('document titles', () => {
  it('titles a list page "页面名 · brand"', () => {
    expect(headerTitle({ title: '容器' })).toBe('容器 · nyabase');
    expect(headerTitle({ title: '操作记录' }, 'Lab Cloud')).toBe('操作记录 · Lab Cloud');
  });

  it('titles a detail page by its crumbs read backwards', () => {
    expect(headerTitle({
      title: 'ignored',
      crumbs: [{ label: '容器' }, { label: 'dev-box' }],
    })).toBe('dev-box · 容器 · nyabase');
    expect(headerTitle({
      crumbs: [{ label: '服务器' }, { label: 'aya-1' }, { label: 'tank' }],
    })).toBe('tank · aya-1 · 服务器 · nyabase');
  });

  it('drops the loading placeholder crumb', () => {
    expect(headerTitle({ crumbs: [{ label: '服务器' }, { label: '…' }] })).toBe('服务器 · nyabase');
  });

  it('prefers an explicit documentTitle and skips missing parts', () => {
    expect(headerTitle({
      title: '使用情况',
      documentTitle: ['使用情况', undefined, '容器'],
    })).toBe('使用情况 · 容器 · nyabase');
    expect(headerTitle({
      title: 'x',
      crumbs: [{ label: '容器' }],
      documentTitle: 'dev-box · 容器',
    })).toBe('dev-box · 容器 · nyabase');
  });

  it('cannot derive a title from a ReactNode title without crumbs', () => {
    expect(pageHeaderTitleParts({ title: { type: 'span' } as never })).toBeNull();
    expect(pageHeaderTitleParts({ title: '容器', crumbs: [] })).toBe('容器');
  });

  it('falls back to the default brand', () => {
    expect(formatDocumentTitle('登录', '  ')).toBe(`登录 · ${DEFAULT_BRAND_TITLE}`);
    expect(formatDocumentTitle([], 'nyabase')).toBe('nyabase');
  });
});
