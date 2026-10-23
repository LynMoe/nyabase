import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const terminateBrowserSession = vi.fn(async () => undefined);
vi.mock('../../lib/auth-session.js', () => ({ terminateBrowserSession }));

const { SessionCheckScreen } = await import('./session-check-screen.js');

afterEach(() => {
  cleanup();
  terminateBrowserSession.mockClear();
});

describe('SessionCheckScreen', () => {
  it('offers sign-out on the throttled screen: the only other exit would be clearing cookies', () => {
    const onRetry = vi.fn();
    render(<SessionCheckScreen title="会话刷新繁忙" message="请稍后重试。" retrying={false} onRetry={onRetry} />);
    expect(screen.getByText('会话刷新繁忙')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(terminateBrowserSession).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('disables retry while one is running, but never sign-out', () => {
    render(<SessionCheckScreen title="无法验证会话" message="请检查网络后重试。" retrying onRetry={vi.fn()} />);
    expect((screen.getByRole('button', { name: '重试中...' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '退出登录' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
