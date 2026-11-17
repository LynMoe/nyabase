import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContainerScriptDto, ContainerScriptPreviewDto } from '@nyabase/common';

const preview: ContainerScriptPreviewDto = {
  total: 3,
  running: 2,
  servers: [{ serverId: 's1', serverName: 'gpu-1', total: 3, running: 2 }],
  containers: [],
  truncated: false,
};
const created = { id: 'cs1', name: 'apt', current: { version: 1 } } as ContainerScriptDto;

const get = vi.fn(async (_path: string): Promise<unknown> => []);
const post = vi.fn(async (path: string, _body?: unknown): Promise<unknown> =>
  (path === '/admin/container-scripts/preview' ? preview : created));
const upload = vi.fn();
vi.mock('../../lib/api.js', () => ({ api: { get, post, upload } }));

const { ScriptFormDialog } = await import('./script-form-dialog.js');

function renderDialog(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  get.mockClear();
  post.mockClear();
});

describe('ScriptFormDialog (create)', () => {
  it('ties 新容器 to 每次开机 and hides the stopped-container choice for it', () => {
    renderDialog(<ScriptFormDialog open onOpenChange={() => undefined} target={{ kind: 'create' }} />);
    const newContainers = screen.getByRole('checkbox', { name: '新容器' });
    expect(newContainers.getAttribute('data-state')).toBe('checked');
    expect(screen.getByRole('radiogroup', { name: '停机容器' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '每次开机' }));
    expect(newContainers.getAttribute('data-state')).toBe('checked');
    expect(newContainers.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('radiogroup', { name: '停机容器' })).toBeNull();
    expect(screen.getByText('勾上：运行中的容器立即执行此版本；不勾：下次开机生效')).toBeTruthy();
  });

  it('previews the scope, shows the count, and creates only after confirming', async () => {
    const onCreated = vi.fn();
    renderDialog(<ScriptFormDialog open onOpenChange={() => undefined} target={{ kind: 'create' }} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'apt' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    await screen.findByTestId('container-script-confirm');
    expect(post).toHaveBeenCalledWith('/admin/container-scripts/preview', {
      scope: { all: true, serverIds: [], imageIds: [], ownerIds: [], containerIds: [], excludeContainerIds: [] },
    });
    expect(screen.getByText('范围内现有的 3 个容器都执行此版本：运行中的 2 个立即执行，停机的 1 个开机后执行')).toBeTruthy();
    expect(post).not.toHaveBeenCalledWith('/admin/container-scripts', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(post).toHaveBeenCalledWith('/admin/container-scripts', expect.objectContaining({
      name: 'apt',
      everyBoot: false,
      applyNow: true,
      onNewContainers: true,
      script: '#!/bin/bash\nset -euo pipefail\n\n',
    }));
  });

  it('stops at the form while something is invalid', () => {
    renderDialog(<ScriptFormDialog open onOpenChange={() => undefined} target={{ kind: 'create' }} />);
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('请填写名称')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
});
