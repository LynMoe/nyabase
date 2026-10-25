import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Pagination } from './pagination.js';

afterEach(() => {
  cleanup();
});

const noop = () => {};

function button(testId: string): HTMLButtonElement {
  return screen.getByTestId(testId) as HTMLButtonElement;
}

describe('Pagination', () => {
  it('shows "x / y" and bounds next by the total in offset mode', () => {
    render(<Pagination page={1} pageSize={25} total={50} onPageChange={noop} onPageSizeChange={noop} />);
    expect(screen.getByTestId('pagination-page').textContent).toBe('第 2 / 2 页');
    expect(button('pagination-next').disabled).toBe(true);
    expect(button('pagination-prev').disabled).toBe(false);
  });

  it('shows only the page number and follows hasNext in cursor mode', () => {
    const onPageChange = vi.fn();
    const { rerender } = render(
      <Pagination page={0} pageSize={50} hasNext onPageChange={onPageChange} onPageSizeChange={noop} />,
    );
    expect(screen.getByTestId('pagination-page').textContent).toBe('第 1 页');
    expect(button('pagination-prev').disabled).toBe(true);
    fireEvent.click(button('pagination-next'));
    expect(onPageChange).toHaveBeenCalledWith(1);

    rerender(<Pagination page={3} pageSize={50} hasNext={false} onPageChange={onPageChange} onPageSizeChange={noop} />);
    expect(screen.getByTestId('pagination-page').textContent).toBe('第 4 页');
    expect(button('pagination-next').disabled).toBe(true);
    fireEvent.click(button('pagination-prev'));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
  });

  it('disables navigation while the requested page is loading', () => {
    render(<Pagination page={2} pageSize={50} hasNext busy onPageChange={noop} onPageSizeChange={noop} />);
    expect(button('pagination-prev').disabled).toBe(true);
    expect(button('pagination-next').disabled).toBe(true);
  });
});
