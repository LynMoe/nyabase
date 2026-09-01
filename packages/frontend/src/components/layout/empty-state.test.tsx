import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EmptyState } from './empty-state.js';

afterEach(() => {
  cleanup();
});

describe('EmptyState', () => {
  it('always renders the title', () => {
    render(<EmptyState title="暂无服务器" />);
    expect(screen.getByText('暂无服务器')).toBeTruthy();
  });

  it('renders description only when provided', () => {
    const { rerender } = render(<EmptyState title="暂无服务器" />);
    expect(screen.queryByText('去接入一台')).toBeNull();

    rerender(<EmptyState title="暂无服务器" description="去接入一台" />);
    expect(screen.getByText('去接入一台')).toBeTruthy();
    expect(screen.getByText('暂无服务器')).toBeTruthy();
  });
});
