import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Role, type UserDto } from '@nyabase/common';

const get = vi.fn(async (_path: string): Promise<unknown> => [
  { id: 'u-alice', username: 'alice', displayName: '爱丽丝', status: 'active' },
]);
vi.mock('../../lib/api.js', () => ({ api: { get } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, search, children, ...rest }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children: ReactNode;
  }) => {
    let path = to;
    for (const [key, value] of Object.entries(params ?? {})) path = path.replace(`$${key}`, value);
    const query = search ? `?${new URLSearchParams(search).toString()}` : '';
    return <a href={`${path}${query}`} {...rest}>{children}</a>;
  },
}));

const { ResourceRef } = await import('./resource-ref.js');
const { useAuthStore } = await import('../../store/auth.js');

function signIn(role: Role) {
  useAuthStore.getState().setAuth('token', { id: 'u-me', username: 'me', displayName: '我', role } as UserDto);
}

function renderRef(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function href(name: string) {
  return screen.getByRole('link', { name }).getAttribute('href');
}

afterEach(() => {
  cleanup();
  get.mockClear();
  useAuthStore.getState().clearAuth();
});

describe('ResourceRef kind="user"', () => {
  it('links the display name to the user page, with the username on hover', () => {
    signIn(Role.UserAdmin);
    renderRef(<ResourceRef kind="user" id="u-alice" name="爱丽丝" username="alice" />);
    expect(href('爱丽丝')).toBe('/users/u-alice');
    expect(screen.getByRole('link', { name: '爱丽丝' }).getAttribute('title')).toBe('@alice');
    expect(get).not.toHaveBeenCalled();
  });

  it('resolves the display name from the user catalog when only the id is known', async () => {
    signIn(Role.UserAdmin);
    renderRef(<ResourceRef kind="user" id="u-alice" />);
    const link = await screen.findByRole('link', { name: '爱丽丝' });
    expect(link.getAttribute('title')).toBe('@alice');
    await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/catalog/users'));
  });

  it('shows plain text to viewers who cannot open the users page', () => {
    signIn(Role.User);
    renderRef(<ResourceRef kind="user" id="u-alice" name="爱丽丝" username="alice" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('爱丽丝').getAttribute('title')).toBe('@alice');
  });
});

describe('ResourceRef links to each resource page', () => {
  it('opens containers and volumes on the surface the scope names', () => {
    signIn(Role.UserAdmin);
    renderRef(
      <>
        <ResourceRef kind="container" id="c-1" name="mine-c" scope="mine" />
        <ResourceRef kind="container" id="c-2" name="all-c" scope="all" />
        <ResourceRef kind="container" id="c-3" name="default-c" />
        <ResourceRef kind="volume" id="v-1" name="mine-v" scope="mine" />
        <ResourceRef kind="shared-volume" id="s-1" name="mine-s" scope="mine" />
        <ResourceRef kind="shared-volume" id="s-2" name="all-s" scope="all" />
      </>,
    );
    expect(href('mine-c')).toBe('/containers/c-1?tab=overview');
    expect(href('all-c')).toBe('/manage/containers/c-2?tab=overview');
    expect(href('default-c')).toBe('/manage/containers/c-3?tab=overview');
    expect(href('mine-v')).toBe('/volumes?volume=v-1');
    expect(href('mine-s')).toBe('/shared-volumes?volume=s-1');
    expect(href('all-s')).toBe('/manage/volumes?volume=s-2');
  });

  it('does not link admin-only pages for user admins', () => {
    signIn(Role.UserAdmin);
    renderRef(
      <>
        <ResourceRef kind="server" id="srv-1" name="lab-a" />
        <ResourceRef kind="image" id="img-1" name="ubuntu" />
        <ResourceRef kind="shared-backend" id="b-1" name="ceph" />
        <ResourceRef kind="pool" id="p-1" name="fast" serverId="srv-1" />
      </>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('lab-a')).toBeTruthy();
  });

  it('links servers, images, backends and pools for admins', () => {
    signIn(Role.Admin);
    renderRef(
      <>
        <ResourceRef kind="server" id="srv-1" name="lab-a" />
        <ResourceRef kind="image" id="img-1" name="ubuntu" />
        <ResourceRef kind="shared-backend" id="b-1" name="ceph" />
        <ResourceRef kind="pool" id="p-1" name="fast" serverId="srv-1" />
      </>,
    );
    expect(href('lab-a')).toBe('/servers/srv-1?tab=overview');
    expect(href('ubuntu')).toBe('/images/img-1?tab=overview');
    expect(href('ceph')).toBe('/shared-backends/b-1?tab=overview');
    expect(href('fast')).toBe('/servers/srv-1?tab=storage');
  });

  it('keeps regular users on their own pages and off the 全平台 ones', () => {
    signIn(Role.User);
    renderRef(
      <>
        <ResourceRef kind="container" id="c-1" name="own" />
        <ResourceRef kind="container" id="c-2" name="theirs" scope="all" />
      </>,
    );
    expect(href('own')).toBe('/containers/c-1?tab=overview');
    expect(screen.queryByRole('link', { name: 'theirs' })).toBeNull();
  });
});
