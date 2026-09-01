import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Page } from './page.js';

afterEach(() => {
  cleanup();
});

describe('Page', () => {
  it('renders children, sets data-testid, and stays full width', () => {
    render(
      <Page testId="servers-page">
        <span>page body</span>
      </Page>,
    );

    const page = screen.getByTestId('servers-page');
    expect(page.textContent).toContain('page body');
    expect(page.classList.contains('w-full')).toBe(true);
    expect(page.classList.contains('min-w-0')).toBe(true);
    expect(page.classList.contains('max-w-7xl')).toBe(false);
  });
});
