import { create } from 'zustand';
import type { UserDto } from '@nyabase/common';

export type AuthStatus = 'checking' | 'authenticated' | 'anonymous' | 'error';

/**
 * Tab-local, memory-only session. The refresh secret lives in the HttpOnly
 * `__Host-nyabase_refresh` cookie, so nothing here is persisted: a reload starts in
 * `checking` and recovers the access token through the cookie.
 */
export interface AuthState {
  accessToken: string | null;
  user: UserDto | null;
  /** Monotonic, tab-local epoch used to reject late refresh commits. */
  epoch: number;
  status: AuthStatus;
  authError: string | null;
  setAuth: (accessToken: string, user: UserDto) => void;
  commitRefresh: (expectedEpoch: number, accessToken: string, user: UserDto) => boolean;
  commitCurrentUser: (expectedEpoch: number, expectedAccessToken: string, user: UserDto) => boolean;
  clearAuth: () => void;
  markChecking: () => void;
  markCheckFailed: (message: string) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  accessToken: null,
  user: null,
  epoch: 0,
  status: 'checking',
  authError: null,
  setAuth: (accessToken, user) =>
    set((state) => ({
      accessToken,
      user,
      epoch: state.epoch + 1,
      status: 'authenticated',
      authError: null,
    })),
  commitRefresh: (expectedEpoch, accessToken, user) => {
    let committed = false;
    set((state) => {
      if (state.epoch !== expectedEpoch) return state;
      committed = true;
      return { accessToken, user, status: 'authenticated', authError: null };
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
    user: null,
    epoch: state.epoch + 1,
    status: 'anonymous',
    authError: null,
  })),
  markChecking: () => set({ status: 'checking', authError: null }),
  markCheckFailed: (message) => set({ status: 'error', authError: message }),
}));
