import { beforeEach, describe, expect, it } from 'vitest';
import { UserStatus, type UserDto } from '@nyabase/common';
import { mergePersistedAuthState, useAuthStore } from './auth.js';

const user: UserDto = {
  id: 'u1',
  username: 'one',
  displayName: 'One',
  status: UserStatus.Active,
  createdAt: '2026-01-01T00:00:00.000Z',
  capabilities: [],
  groups: [],
};

describe('auth epoch compare-and-swap', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 'A1',
      refreshToken: 'R1',
      refreshRequestId: '1'.repeat(64),
      user,
      epoch: 4,
      status: 'authenticated',
      authError: null,
    });
  });

  it('rejects a refresh that completes after logout', () => {
    useAuthStore.getState().clearAuth();
    expect(useAuthStore.getState().commitRefresh(
      4, 'R1', '1'.repeat(64), 'A2', 'R2', '2'.repeat(64), user,
    )).toBe(false);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('rejects a refresh whose captured token is no longer current', () => {
    useAuthStore.getState().applyExternalAuth('A2', 'R2', '2'.repeat(64), user);
    expect(useAuthStore.getState().commitRefresh(
      4, 'R1', '1'.repeat(64), 'stale-A', 'stale-R', '3'.repeat(64), user,
    )).toBe(false);
    expect(useAuthStore.getState().refreshToken).toBe('R2');
  });

  it('rejects a refresh whose idempotency request id changed for the same token', () => {
    useAuthStore.getState().setRefreshRequestId('R1', '9'.repeat(64));
    expect(useAuthStore.getState().commitRefresh(
      4, 'R1', '1'.repeat(64), 'A2', 'R2', '2'.repeat(64), user,
    )).toBe(false);
    expect(useAuthStore.getState().refreshToken).toBe('R1');
  });

  it('fails an incomplete persisted credential tuple closed during hydration', () => {
    const merged = mergePersistedAuthState({
      accessToken: 'persisted-A',
      refreshToken: 'persisted-R',
      refreshRequestId: '5'.repeat(64),
      user: { id: user.id },
    }, useAuthStore.getState());
    expect(merged).toMatchObject({
      accessToken: null,
      refreshToken: null,
      refreshRequestId: null,
      user: null,
      status: 'anonymous',
    });
  });

  it('projects only validated credential fields from anonymous persisted state', () => {
    const current = { ...useAuthStore.getState(), status: 'checking' as const, epoch: 7 };
    const merged = mergePersistedAuthState({
      accessToken: null,
      refreshToken: null,
      refreshRequestId: null,
      user: null,
      status: 'authenticated',
      authError: 'injected',
      epoch: -1,
      clearAuth: 'not-a-function',
    }, current);
    expect(merged).toMatchObject({
      accessToken: null,
      refreshToken: null,
      refreshRequestId: null,
      user: null,
      status: 'checking',
      authError: null,
      epoch: 7,
    });
    expect(merged.clearAuth).toBe(current.clearAuth);
  });

  it('does not let a valid persisted tuple inject runtime state fields', () => {
    const current = { ...useAuthStore.getState(), status: 'checking' as const, epoch: 8 };
    const merged = mergePersistedAuthState({
      accessToken: 'persisted-A',
      refreshToken: 'persisted-R',
      refreshRequestId: '6'.repeat(64),
      user,
      status: 'corrupt',
      authError: 'injected',
      epoch: -1,
    }, current);
    expect(merged).toMatchObject({
      accessToken: 'persisted-A',
      refreshToken: 'persisted-R',
      refreshRequestId: '6'.repeat(64),
      user,
      status: 'checking',
      authError: null,
      epoch: 8,
    });
  });
});
