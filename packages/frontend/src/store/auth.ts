import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserDto } from '@nyabase/common';
import { isPersistedAuthCredentials } from '../lib/auth-state-validation.js';

export type AuthStatus = 'checking' | 'authenticated' | 'anonymous' | 'error';

export interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  refreshRequestId: string | null;
  user: UserDto | null;
  /** Monotonic, tab-local generation used to reject late refresh commits. */
  epoch: number;
  status: AuthStatus;
  authError: string | null;
  setAuth: (accessToken: string, refreshToken: string, refreshRequestId: string, user: UserDto) => void;
  applyExternalAuth: (
    accessToken: string,
    refreshToken: string,
    refreshRequestId: string,
    user: UserDto,
    status?: AuthStatus,
    authError?: string | null,
  ) => void;
  setRefreshRequestId: (expectedRefreshToken: string, refreshRequestId: string) => boolean;
  commitRefresh: (
    expectedEpoch: number,
    expectedRefreshToken: string,
    expectedRefreshRequestId: string,
    accessToken: string,
    refreshToken: string,
    refreshRequestId: string,
    user: UserDto,
  ) => boolean;
  commitRefreshPendingUser: (
    expectedEpoch: number,
    expectedRefreshToken: string,
    expectedRefreshRequestId: string,
    accessToken: string,
    refreshToken: string,
    refreshRequestId: string,
    message: string,
  ) => boolean;
  commitCurrentUser: (expectedEpoch: number, expectedAccessToken: string, user: UserDto) => boolean;
  clearAuth: () => void;
  markChecking: () => void;
  markCheckFailed: (message: string) => void;
}

export function mergePersistedAuthState(persistedState: unknown, currentState: AuthState): AuthState {
  if (!isPersistedAuthCredentials(persistedState)) {
    return {
      ...currentState,
      accessToken: null,
      refreshToken: null,
      refreshRequestId: null,
      user: null,
      status: 'anonymous',
      authError: null,
    };
  }
  return {
    ...currentState,
    accessToken: persistedState.accessToken,
    refreshToken: persistedState.refreshToken,
    refreshRequestId: persistedState.refreshRequestId,
    user: persistedState.user,
  };
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      refreshRequestId: null,
      user: null,
      epoch: 0,
      status: 'checking',
      authError: null,
      setAuth: (accessToken, refreshToken, refreshRequestId, user) =>
        set((state) => ({
          accessToken,
          refreshToken,
          refreshRequestId,
          user,
          epoch: state.epoch + 1,
          status: 'authenticated',
          authError: null,
        })),
      applyExternalAuth: (
        accessToken,
        refreshToken,
        refreshRequestId,
        user,
        status = 'authenticated',
        authError = null,
      ) =>
        set((state) => ({
          accessToken,
          refreshToken,
          refreshRequestId,
          user,
          epoch: state.epoch + 1,
          status,
          authError,
        })),
      setRefreshRequestId: (expectedRefreshToken, refreshRequestId) => {
        let committed = false;
        set((state) => {
          if (state.refreshToken !== expectedRefreshToken) return state;
          committed = true;
          return { refreshRequestId };
        });
        return committed;
      },
      commitRefresh: (
        expectedEpoch,
        expectedRefreshToken,
        expectedRefreshRequestId,
        accessToken,
        refreshToken,
        refreshRequestId,
        user,
      ) => {
        let committed = false;
        set((state) => {
          if (state.epoch !== expectedEpoch || state.refreshToken !== expectedRefreshToken
            || state.refreshRequestId !== expectedRefreshRequestId) return state;
          committed = true;
          return { accessToken, refreshToken, refreshRequestId, user, status: 'authenticated', authError: null };
        });
        return committed;
      },
      commitRefreshPendingUser: (
        expectedEpoch,
        expectedRefreshToken,
        expectedRefreshRequestId,
        accessToken,
        refreshToken,
        refreshRequestId,
        message,
      ) => {
        let committed = false;
        set((state) => {
          if (state.epoch !== expectedEpoch || state.refreshToken !== expectedRefreshToken
            || state.refreshRequestId !== expectedRefreshRequestId) return state;
          committed = true;
          return { accessToken, refreshToken, refreshRequestId, status: 'error', authError: message };
        });
        return committed;
      },
      commitCurrentUser: (expectedEpoch, expectedAccessToken, user) => {
        let committed = false;
        set((state) => {
          if (state.epoch !== expectedEpoch || state.accessToken !== expectedAccessToken) return state;
          committed = true;
          return { user, status: 'authenticated', authError: null };
        });
        return committed;
      },
      clearAuth: () => set((state) => ({
        accessToken: null,
        refreshToken: null,
        refreshRequestId: null,
        user: null,
        epoch: state.epoch + 1,
        status: 'anonymous',
        authError: null,
      })),
      markChecking: () => set((state) => state.accessToken || state.refreshToken
        ? { status: 'checking', authError: null }
        : { status: 'anonymous', authError: null }),
      markCheckFailed: (message) => set({ status: 'error', authError: message }),
    }),
    {
      name: 'nyabase-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        refreshRequestId: state.refreshRequestId,
        user: state.user,
      }),
      merge: mergePersistedAuthState,
    },
  ),
);
