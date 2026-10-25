import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PageHeader } from './page-header.js';
import { setDocumentBrand } from '../../hooks/use-document-title.js';

afterEach(() => {
  cleanup();
  setDocumentBrand(null);
  document.title = '';
});

describe('PageHeader document title', () => {
  it('titles a list page by its string title', () => {
    render(<PageHeader title="操作记录" />);
    expect(document.title).toBe('操作记录 · nyabase');
  });

  it('titles a detail page by its crumbs, resource first, and updates once it loads', () => {
    const crumbs = (name?: string) => [{ label: '服务器' }, { label: name ?? '…' }];
    const { rerender } = render(<PageHeader title={<span>loading</span>} crumbs={crumbs()} />);
    expect(document.title).toBe('服务器 · nyabase');
    rerender(<PageHeader title={<span>aya-1</span>} crumbs={crumbs('aya-1')} />);
    expect(document.title).toBe('aya-1 · 服务器 · nyabase');
  });

  it('uses documentTitle for a JSX title and follows the configured brand', () => {
    render(<PageHeader title={<span>dev-box</span>} documentTitle={['使用情况', 'dev-box', '容器']} />);
    expect(document.title).toBe('使用情况 · dev-box · 容器 · nyabase');
    act(() => setDocumentBrand('Lab Cloud'));
    expect(document.title).toBe('使用情况 · dev-box · 容器 · Lab Cloud');
  });

  it('leaves the title alone when it cannot derive one', () => {
    document.title = 'previous';
    render(<PageHeader title={<span>x</span>} />);
    expect(document.title).toBe('previous');
  });
});
