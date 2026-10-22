import { beforeEach, describe, expect, it } from 'vitest';
import { Role, UserStatus, type UserDto } from '@nyabase/common';
import { useAuthStore } from './auth.js';

const user: UserDto = {
  id: 'u1',
  username: 'one',
  displayName: 'One',
  status: UserStatus.Active,
  createdAt: '2026-01-01T00:00:00.000Z',
  role: Role.User,
  groups: [],
};

describe('auth epoch compare-and-swap', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'A1', user, epoch: 4, status: 'authenticated', authError: null });
  });

  it('rejects a refresh that completes after logout', () => {
    useAuthStore.getState().clearAuth();
    expect(useAuthStore.getState().commitRefresh(4, 'A2', user)).toBe(false);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('rejects a refresh that completes after a new login', () => {
    useAuthStore.getState().setAuth('A-new', { ...user, id: 'u2' });
    expect(useAuthStore.getState().commitRefresh(4, 'stale-A', user)).toBe(false);
    expect(useAuthStore.getState().accessToken).toBe('A-new');
  });

  it('rejects a current-user projection for a replaced access token', () => {
    useAuthStore.setState({ accessToken: 'A2' });
    expect(useAuthStore.getState().commitCurrentUser(4, 'A1', { ...user, displayName: 'stale' })).toBe(false);
    expect(useAuthStore.getState().user?.displayName).toBe('One');
  });

  it('never persists credentials', () => {
    expect('persist' in useAuthStore).toBe(false);
  });
});
