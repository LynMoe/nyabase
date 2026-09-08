import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from './confirm-dialog.js';

afterEach(() => {
  cleanup();
});

const baseProps = {
  title: '删除镜像',
  description: '此操作不可撤销',
  confirmLabel: '删除',
  pendingLabel: '删除中…',
  testId: 'confirm-dialog',
};

describe('ConfirmDialog', () => {
  it('does not unmount on action click (preventDefault keeps it open)', () => {
    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <ConfirmDialog
          {...baseProps}
          open={open}
          pending={false}
          onConfirm={() => undefined}
          onOpenChange={setOpen}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('data-state')).toBe('open');
  });

  it('disables buttons while pending and ignores Radix close', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        {...baseProps}
        open
        pending
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />,
    );

    const confirm = screen.getByRole('button', { name: '删除中…' });
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(confirm).toHaveProperty('disabled', true);
    expect(cancel).toHaveProperty('disabled', true);

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-dialog').getAttribute('data-state')).toBe('open');
  });

  it('forwards className to AlertDialogContent', () => {
    render(
      <ConfirmDialog
        {...baseProps}
        open
        className="sm:max-w-lg"
        onConfirm={() => undefined}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.getByTestId('confirm-dialog').className).toContain('sm:max-w-lg');
  });
});
