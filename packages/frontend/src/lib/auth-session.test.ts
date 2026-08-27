import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserStatus, type UserDto } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';
import { api, authApiTestables } from './api.js';
import {
  authSessionTestables,
  clearLocalSession,
  ensureAuthoritativeSessionRecord,
  installLoginSession,
  notifyCurrentPrincipalAccessChanged,
  notifyAccessChangedForSubject,
  notifyGroupMembershipChangedForUser,
  withCrossTabRefreshLock,
} from './auth-session.js';
import { terminateBrowserSession } from './session-termination.js';
import { queryClient } from './query-client.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const user: UserDto = {
  id: 'u1', username: 'one', displayName: 'One', status: UserStatus.Active,
  createdAt: '2026-01-01T00:00:00.000Z', capabilities: [], groups: [],
};

let storage: MemoryStorage;

function sessionMessage(refreshToken = 'R2') {
  return {
    id: `message-${refreshToken}`,
    source: 'another-tab',
    type: 'session' as const,
    sessionId: `session-${refreshToken}`,
    principalId: user.id,
    sessionRevision: { clock: Date.now() + 50, source: 'another-tab' },
    revision: { clock: Date.now() + 100, source: 'another-tab' },
    transition: 'login' as const,
    accessRevision: 0,
    accessToken: `A-${refreshToken}`,
    refreshToken,
    refreshRequestId: 'b'.repeat(64),
    user,
    status: 'authenticated' as const,
    authError: null,
  };
}

function stubBrowser(withWebLocks = true) {
  storage = new MemoryStorage();
  vi.stubGlobal('window', {
    localStorage: storage,
    setTimeout: (handler: TimerHandler, timeout?: number) => setTimeout(handler, timeout),
    setInterval: (handler: TimerHandler, timeout?: number) => setInterval(handler, timeout),
    clearInterval: (id: number) => clearInterval(id),
  });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('navigator', withWebLocks ? {
    locks: { request: async (_name: string, callback: () => Promise<unknown>) => callback() },
  } : {});
}

describe('auth session coordination', () => {
  beforeEach(() => {
    stubBrowser();
    authSessionTestables.resetForTests();
    useAuthStore.setState({ accessToken: null, refreshToken: null, refreshRequestId: null, user: null, epoch: 0, status: 'anonymous', authError: null });
    installLoginSession('A1', 'R1', user);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('clears cached principal data before installing a login', () => {
    queryClient.setQueryData(['secret'], { owner: 'old-user' });
    installLoginSession('new-A', 'new-R', { ...user, id: 'u2', username: 'two' });
    expect(queryClient.getQueryData(['secret'])).toBeUndefined();
    expect(useAuthStore.getState().user?.id).toBe('u2');
  });

  it('resets access-derived caches only when the current principal is affected', () => {
    queryClient.setQueryData(['servers', 'user'], [{ id: 's1' }]);
    queryClient.setQueryData(['volumes', 'user'], [{ id: 'v1' }]);
    queryClient.setQueryData(['container', 'user', 'c1'], { id: 'c1' });
    queryClient.setQueryData(['servers', 'admin'], [{ id: 'admin-s1' }]);
    queryClient.setQueryData(['users', 'admin'], [{ id: 'u2' }]);
    expect(notifyAccessChangedForSubject({ type: 'user', id: 'someone-else' })).toBe(false);
    expect(queryClient.getQueryData(['servers', 'user'])).toBeDefined();

    expect(notifyAccessChangedForSubject({ type: 'user', id: user.id })).toBe(true);
    expect(queryClient.getQueryData(['servers', 'user'])).toBeUndefined();
    expect(queryClient.getQueryData(['volumes', 'user'])).toBeUndefined();
    expect(queryClient.getQueryData(['container', 'user', 'c1'])).toBeUndefined();
    expect(queryClient.getQueryData(['servers', 'admin'])).toBeDefined();
    expect(queryClient.getQueryData(['users', 'admin'])).toBeDefined();
  });

  it('resets ordinary caches for a current-member group but not an unrelated group', () => {
    const member = {
      ...user,
      groups: [{ id: 'g-current', name: 'Current', priority: 10, isSystem: false }],
    };
    installLoginSession('member-A', 'member-R', member);
    queryClient.setQueryData(['shared-backends', 'user'], [{ id: 'b1' }]);
    expect(notifyAccessChangedForSubject({ type: 'group', id: 'g-other' })).toBe(false);
    expect(queryClient.getQueryData(['shared-backends', 'user'])).toBeDefined();
    expect(notifyAccessChangedForSubject({ type: 'group', id: 'g-current' })).toBe(true);
    expect(queryClient.getQueryData(['shared-backends', 'user'])).toBeUndefined();
  });

  it('uses immediate membership transitions while the refreshed user projection is still in flight', () => {
    queryClient.setQueryData(['images', 'user', 'active'], [{ id: 'before-join' }]);
    expect(notifyGroupMembershipChangedForUser(user.id, 'g-new', true)).toBe(true);
    queryClient.setQueryData(['images', 'user', 'active'], [{ id: 'after-join' }]);
    expect(notifyAccessChangedForSubject({ type: 'group', id: 'g-new' })).toBe(true);
    expect(queryClient.getQueryData(['images', 'user', 'active'])).toBeUndefined();

    notifyGroupMembershipChangedForUser(user.id, 'g-new', false);
    queryClient.setQueryData(['images', 'user', 'active'], [{ id: 'after-leave' }]);
    expect(notifyAccessChangedForSubject({ type: 'group', id: 'g-new' })).toBe(false);
    expect(queryClient.getQueryData(['images', 'user', 'active'])).toBeDefined();
  });

  it('adopts a cross-tab access revision for the same qualified session', () => {
    queryClient.setQueryData(['images', 'user', 'active'], [{ id: 'image-old' }]);
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as {
      sessionId: string; principalId: string; sessionRevision: { clock: number; source: string }; revision: { clock: number };
    };
    authSessionTestables.receiveMessage({
      id: 'access-change',
      source: 'another-tab',
      type: 'access',
      sessionId: current.sessionId,
      principalId: current.principalId,
      sessionRevision: current.sessionRevision,
      revision: { clock: current.revision.clock + 1, source: 'another-tab' },
      accessRevision: current.revision.clock + 1,
    });
    expect(queryClient.getQueryData(['images', 'user', 'active'])).toBeUndefined();
  });

  it('orders access signals by immutable session identity before a stale mutable clock', () => {
    const oldFamily = {
      id: 'old-access', source: 'old-tab', type: 'access' as const,
      sessionId: 'old-session', principalId: user.id,
      sessionRevision: { clock: 10, source: 'old-tab' },
      revision: { clock: 1_000, source: 'old-tab' }, accessRevision: 1_000,
    };
    const newFamily = {
      id: 'new-access', source: 'new-tab', type: 'access' as const,
      sessionId: 'new-session', principalId: user.id,
      sessionRevision: { clock: 20, source: 'new-tab' },
      revision: { clock: 21, source: 'new-tab' }, accessRevision: 21,
    };
    expect(authSessionTestables.chooseAuthoritativeMessage(oldFamily, newFamily)).toBe(newFamily);
    expect(authSessionTestables.chooseAuthoritativeMessage(newFamily, oldFamily)).toBe(newFamily);
  });

  it('keeps an in-flight old-principal query from repopulating cache after login', async () => {
    let resolveOldQuery!: (value: { owner: string }) => void;
    const oldQuery = queryClient.fetchQuery({
      queryKey: ['delayed-secret'],
      queryFn: () => new Promise<{ owner: string }>((resolve) => { resolveOldQuery = resolve; }),
    });
    installLoginSession('new-A', 'new-R', { ...user, id: 'u2', username: 'two' });
    resolveOldQuery({ owner: 'old-user' });
    await oldQuery.catch(() => undefined);
    expect(queryClient.getQueryData(['delayed-secret'])).toBeUndefined();
  });

  it('adopts a persisted R2 after lock acquisition before sending stale R1', async () => {
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(sessionMessage()));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(authApiTestables.tryRefresh()).resolves.toBe('A-R2');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().refreshToken).toBe('R2');
  });

  it('does not clear a newer shared session when stale R1 receives 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(sessionMessage()));
      return new Response(null, { status: 401, statusText: 'Unauthorized' });
    }));
    await expect(authApiTestables.tryRefresh()).resolves.toBe('A-R2');
    expect(useAuthStore.getState().refreshToken).toBe('R2');
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!).type).toBe('session');
  });

  it('prefers the latest persisted session over a late logout event', () => {
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(sessionMessage('R3')));
    authSessionTestables.receiveMessage({
      id: 'late-logout',
      source: 'stale-tab',
      type: 'logout',
      sessionId: 'old-session',
      principalId: user.id,
      sessionRevision: { clock: Date.now() - 10, source: 'stale-tab' },
      revision: { clock: Date.now() - 1, source: 'stale-tab' },
    });
    expect(useAuthStore.getState().refreshToken).toBe('R3');
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('does not broadcast an old-session logout over a persisted new login', () => {
    const nextUser = { ...user, id: 'u2', username: 'two' };
    const next = { ...sessionMessage('R-next'), principalId: nextUser.id, user: nextUser };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(next));
    // Calling the public logout transition reconciles the authoritative login
    // before it can write a qualified logout for the stale session.
    expect(clearLocalSession()).toEqual({ accessToken: 'A1', refreshToken: 'R1' });
    expect(useAuthStore.getState().user?.id).toBe(nextUser.id);
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!).type).toBe('session');
  });

  it('adopts an authoritative newer family when its latest snapshot is a refresh', async () => {
    const original = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const nextUser = { ...user, id: 'u2', username: 'two' };
    const next = {
      ...sessionMessage('R-next-refresh'),
      source: 'new-family-tab',
      principalId: nextUser.id,
      user: nextUser,
      transition: 'refresh' as const,
      sessionRevision: { clock: original.sessionRevision.clock + 1, source: 'new-family-tab' },
      revision: { clock: original.revision.clock + 2, source: 'new-family-tab' },
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(next));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await terminateBrowserSession();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ refreshToken: 'R1' });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'A-R-next-refresh',
      refreshToken: 'R-next-refresh',
      user: { id: nextUser.id },
      status: 'authenticated',
    });
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!)).toMatchObject({
      id: next.id,
      sessionId: next.sessionId,
      transition: 'refresh',
    });
  });

  it('revokes the latest persisted successor when a stale tab logs out the same session', async () => {
    const original = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const r2 = {
      ...original,
      id: 'same-family-r2',
      source: 'refresh-tab',
      transition: 'refresh' as const,
      revision: { clock: original.revision.clock + 1, source: 'refresh-tab' },
      accessToken: 'A2',
      refreshToken: 'R2',
      refreshRequestId: '2'.repeat(64),
    };
    const r3 = {
      ...r2,
      id: 'same-family-r3',
      revision: { clock: r2.revision.clock + 1, source: 'refresh-tab' },
      accessToken: 'A3',
      refreshToken: 'R3',
      refreshRequestId: '3'.repeat(64),
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(r2));
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(r3));
    expect(useAuthStore.getState().refreshToken).toBe('R1');

    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await terminateBrowserSession();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/logout');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ refreshToken: 'R3' });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!)).toMatchObject({
      type: 'logout',
      sessionId: original.sessionId,
    });
  });

  it('does not let a newer foreign logout tombstone block local fail-closed termination', async () => {
    const original = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify({
      id: 'newer-foreign-logout',
      source: 'other-login-tab',
      type: 'logout',
      sessionId: 'different-newer-session',
      principalId: user.id,
      sessionRevision: { clock: original.sessionRevision.clock + 1, source: 'other-login-tab' },
      revision: { clock: original.revision.clock + 2, source: 'other-login-tab' },
    }));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await terminateBrowserSession();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ refreshToken: 'R1' });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!)).toMatchObject({
      type: 'logout',
      sessionId: 'different-newer-session',
    });
  });

  it('keeps a persisted logout terminal across cold hydration of stale credentials', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify({
      id: 'cold-hydrate-logout',
      source: 'logout-tab',
      type: 'logout',
      sessionId: current.sessionId,
      principalId: current.principalId,
      sessionRevision: current.sessionRevision,
      revision: { clock: current.revision.clock + 1, source: 'logout-tab' },
    }));
    authSessionTestables.resetForTests();

    expect(() => ensureAuthoritativeSessionRecord()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!)).toMatchObject({
      type: 'logout',
      id: 'cold-hydrate-logout',
    });
  });

  it('rejects an authoritative-looking foreign session with empty credentials', async () => {
    const original = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const invalid = {
      ...sessionMessage('invalid-empty-token'),
      transition: 'refresh' as const,
      sessionRevision: { clock: original.sessionRevision.clock + 1, source: 'invalid-tab' },
      revision: { clock: original.revision.clock + 2, source: 'invalid-tab' },
      accessToken: '',
      refreshToken: '',
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(invalid));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await terminateBrowserSession();

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ refreshToken: 'R1' });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
  });

  it('rejects malformed persisted session snapshots without adopting them', () => {
    const malformedUser = {
      ...sessionMessage('malformed-user'),
      user: { id: user.id },
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(malformedUser));
    expect(() => ensureAuthoritativeSessionRecord()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({ refreshToken: 'R1', user });

    const invalidStatus = {
      ...sessionMessage('invalid-status'),
      status: 'corrupt',
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(invalidStatus));
    expect(() => ensureAuthoritativeSessionRecord()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({ refreshToken: 'R1', user });

    const anonymousWithCredentials = {
      ...sessionMessage('invalid-anonymous'),
      status: 'anonymous',
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(anonymousWithCredentials));
    expect(() => ensureAuthoritativeSessionRecord()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({ refreshToken: 'R1', user });

    const unsafeAccessRevision = {
      ...sessionMessage('unsafe-access-revision'),
      accessRevision: Number.MAX_SAFE_INTEGER,
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(unsafeAccessRevision));
    expect(() => ensureAuthoritativeSessionRecord()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({ refreshToken: 'R1', user });

    const reversedBase = Date.now();
    const reversedSession = {
      ...sessionMessage('reversed-session'),
      sessionRevision: { clock: reversedBase + 20, source: 'reversed-tab' },
      revision: { clock: reversedBase + 10, source: 'reversed-tab' },
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(reversedSession));
    expect(() => ensureAuthoritativeSessionRecord()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({ refreshToken: 'R1', user });

    const reversedLogout = {
      id: 'reversed-logout',
      source: 'reversed-tab',
      type: 'logout',
      sessionId: reversedSession.sessionId,
      principalId: user.id,
      sessionRevision: { clock: reversedBase + 40, source: 'reversed-tab' },
      revision: { clock: reversedBase + 30, source: 'reversed-tab' },
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(reversedLogout));
    expect(() => ensureAuthoritativeSessionRecord()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({ refreshToken: 'R1', user });

    const reversedAccessRevision = {
      ...sessionMessage('reversed-access-revision'),
      revision: { clock: reversedBase + 50, source: 'reversed-tab' },
      sessionRevision: { clock: reversedBase + 40, source: 'reversed-tab' },
      accessRevision: reversedBase + 51,
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(reversedAccessRevision));
    expect(() => ensureAuthoritativeSessionRecord()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({ refreshToken: 'R1', user });
  });

  it('rejects an access signal whose access revision is ahead of its message clock', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const invalidAccess = {
      id: 'access-ahead-of-clock',
      source: 'access-tab',
      type: 'access',
      sessionId: current.sessionId,
      principalId: current.principalId,
      sessionRevision: current.sessionRevision,
      revision: { clock: current.revision.clock + 1, source: 'access-tab' },
      accessRevision: current.revision.clock + 2,
    };
    expect(authSessionTestables.isSessionMessage(invalidAccess)).toBe(false);
    storage.setItem(authSessionTestables.accessSyncStorageKey, JSON.stringify(invalidAccess));

    notifyCurrentPrincipalAccessChanged();

    const persisted = JSON.parse(storage.getItem(authSessionTestables.accessSyncStorageKey)!) as {
      id: string; revision: { clock: number }; accessRevision: number;
    };
    expect(persisted.id).not.toBe(invalidAccess.id);
    expect(persisted.accessRevision).toBeLessThanOrEqual(persisted.revision.clock);
  });

  it('fails a persisted same-id family mutation closed without blocking a real new login', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const mutated = {
      ...current,
      id: 'mutated-family-identity',
      source: 'mutating-tab',
      transition: 'refresh' as const,
      sessionRevision: { clock: current.sessionRevision.clock + 10, source: 'mutating-tab' },
      revision: { clock: Number.MAX_SAFE_INTEGER - 1, source: 'mutating-tab' },
      accessToken: 'mutated-A',
      refreshToken: 'mutated-R',
      refreshRequestId: '7'.repeat(64),
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(mutated));

    ensureAuthoritativeSessionRecord();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    const nextUser = { ...user, id: 'u2', username: 'two' };
    expect(() => installLoginSession('new-A', 'new-R', nextUser, '8'.repeat(64))).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'new-A', refreshToken: 'new-R', user: { id: nextUser.id }, status: 'authenticated',
    });
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!)).toMatchObject({
      type: 'session',
      principalId: nextUser.id,
      accessToken: 'new-A',
    });
  });

  it('does not let an older family exhausted message clock poison access notification', () => {
    const oldFamily = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    installLoginSession('newer-A', 'newer-R', user, 'b'.repeat(64));
    const newerFamily = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify({
      ...oldFamily,
      id: 'old-family-exhausted-message-clock',
      source: 'old-family-tab',
      transition: 'refresh',
      revision: { clock: Number.MAX_SAFE_INTEGER - 1, source: 'old-family-tab' },
    }));

    notifyCurrentPrincipalAccessChanged();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'newer-A', refreshToken: 'newer-R', user: { id: user.id }, status: 'authenticated',
    });
    const access = JSON.parse(storage.getItem(authSessionTestables.accessSyncStorageKey)!) as {
      sessionId: string; sessionRevision: { clock: number; source: string };
      revision: { clock: number }; accessRevision: number;
    };
    expect(access.sessionId).toBe(newerFamily.sessionId);
    expect(access.sessionRevision).toEqual(newerFamily.sessionRevision);
    expect(access.accessRevision).toBeLessThanOrEqual(access.revision.clock);
    expect(() => installLoginSession('newest-A', 'newest-R', user, 'c'.repeat(64))).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'newest-A', refreshToken: 'newest-R', status: 'authenticated',
    });
  });

  it('removes a write-race access conflict so one real login restores notifications', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const conflict = {
      id: 'write-race-access-conflict',
      source: 'racing-tab',
      type: 'access',
      sessionId: current.sessionId,
      principalId: current.principalId,
      sessionRevision: { clock: current.sessionRevision.clock + 10, source: 'racing-tab' },
      revision: { clock: current.revision.clock + 20, source: 'racing-tab' },
      accessRevision: current.revision.clock + 20,
    };
    const originalSetItem = storage.setItem.bind(storage);
    let injected = false;
    const setItem = vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (!injected && key === authSessionTestables.accessSyncStorageKey) {
        injected = true;
        originalSetItem(key, JSON.stringify(conflict));
        return;
      }
      originalSetItem(key, value);
    });

    notifyCurrentPrincipalAccessChanged();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(storage.getItem(authSessionTestables.accessSyncStorageKey)).toBeNull();
    setItem.mockRestore();
    installLoginSession('recovered-A', 'recovered-R', user, 'd'.repeat(64));
    notifyCurrentPrincipalAccessChanged();
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'recovered-A', refreshToken: 'recovered-R', status: 'authenticated',
    });
    expect(JSON.parse(storage.getItem(authSessionTestables.accessSyncStorageKey)!)).toMatchObject({
      type: 'access',
      principalId: user.id,
    });
  });

  it('preserves a legitimate newer-family access signal that wins the write race', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const nextUser = { ...user, id: 'u2', username: 'two' };
    const nextSession = {
      ...sessionMessage('race-new-family'),
      source: 'race-new-tab',
      principalId: nextUser.id,
      user: nextUser,
      sessionRevision: { clock: current.sessionRevision.clock + 1, source: 'race-new-tab' },
      revision: { clock: current.revision.clock + 2, source: 'race-new-tab' },
    };
    const nextAccess = {
      id: 'race-new-family-access',
      source: 'race-new-tab',
      type: 'access',
      sessionId: nextSession.sessionId,
      principalId: nextSession.principalId,
      sessionRevision: nextSession.sessionRevision,
      revision: { clock: nextSession.revision.clock + 1, source: 'race-new-tab' },
      accessRevision: nextSession.revision.clock + 1,
    };
    const originalSetItem = storage.setItem.bind(storage);
    let injected = false;
    const setItem = vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (!injected && key === authSessionTestables.accessSyncStorageKey) {
        injected = true;
        originalSetItem(authSessionTestables.syncStorageKey, JSON.stringify(nextSession));
        originalSetItem(authSessionTestables.accessSyncStorageKey, JSON.stringify(nextAccess));
        return;
      }
      originalSetItem(key, value);
    });

    notifyCurrentPrincipalAccessChanged();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: nextSession.accessToken,
      refreshToken: nextSession.refreshToken,
      user: { id: nextUser.id },
      status: 'authenticated',
    });
    expect(JSON.parse(storage.getItem(authSessionTestables.accessSyncStorageKey)!)).toMatchObject({
      id: nextAccess.id,
      sessionId: nextSession.sessionId,
      principalId: nextUser.id,
    });
    setItem.mockRestore();
  });

  it('fails a persisted same-family principal switch closed', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const otherUser = { ...user, id: 'u2', username: 'two' };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify({
      ...current,
      id: 'same-family-principal-switch',
      source: 'switch-tab',
      transition: 'refresh',
      principalId: otherUser.id,
      user: otherUser,
      revision: { clock: current.revision.clock + 1, source: 'switch-tab' },
      accessToken: 'switched-A',
      refreshToken: 'switched-R',
      refreshRequestId: '9'.repeat(64),
    }));

    ensureAuthoritativeSessionRecord();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
  });

  it('rejects an envelope whose claimed source differs from its revision source', () => {
    const message = sessionMessage('source-mismatch');
    expect(authSessionTestables.isSessionMessage({
      ...message,
      source: 'claimed-source',
      revision: { ...message.revision, source: 'actual-revision-source' },
    })).toBe(false);
  });

  it('does not ignore an unremembered persisted message merely because it claims this source', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const unremembered = {
      ...current,
      id: 'unremembered-same-source-message',
      transition: 'refresh' as const,
      revision: { clock: current.revision.clock + 1, source: current.source },
      accessToken: 'same-source-A2',
      refreshToken: 'same-source-R2',
      refreshRequestId: 'a'.repeat(64),
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(unremembered));

    authSessionTestables.receiveMessage(unremembered);

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'same-source-A2',
      refreshToken: 'same-source-R2',
      status: 'authenticated',
    });
  });

  it('fails a persisted same-id access family mutation closed before it can raise the clock', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const conflict = {
      id: 'mutated-access-family',
      source: 'mutated-access-tab',
      type: 'access',
      sessionId: current.sessionId,
      principalId: current.principalId,
      sessionRevision: { clock: current.sessionRevision.clock + 10, source: 'mutated-access-tab' },
      revision: { clock: current.revision.clock + 20, source: 'mutated-access-tab' },
      accessRevision: current.revision.clock + 20,
    };
    storage.setItem(authSessionTestables.accessSyncStorageKey, JSON.stringify(conflict));

    notifyCurrentPrincipalAccessChanged();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(storage.getItem(authSessionTestables.accessSyncStorageKey)).toBeNull();
  });

  it('clears both coordination slots for one persisted collision family', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const conflictSession = {
      ...current,
      id: 'dual-slot-conflict-session',
      source: 'dual-conflict-tab',
      transition: 'refresh' as const,
      sessionRevision: { clock: current.sessionRevision.clock + 10, source: 'dual-conflict-tab' },
      revision: { clock: Number.MAX_SAFE_INTEGER - 2, source: 'dual-conflict-tab' },
      accessToken: 'dual-conflict-A',
      refreshToken: 'dual-conflict-R',
      refreshRequestId: '1'.repeat(64),
    };
    const conflictAccess = {
      id: 'dual-slot-conflict-access',
      source: 'dual-conflict-tab',
      type: 'access',
      sessionId: conflictSession.sessionId,
      principalId: conflictSession.principalId,
      sessionRevision: conflictSession.sessionRevision,
      revision: { clock: Number.MAX_SAFE_INTEGER - 1, source: 'dual-conflict-tab' },
      accessRevision: Number.MAX_SAFE_INTEGER - 1,
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(conflictSession));
    storage.setItem(authSessionTestables.accessSyncStorageKey, JSON.stringify(conflictAccess));

    notifyCurrentPrincipalAccessChanged();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(storage.getItem(authSessionTestables.syncStorageKey)).toBeNull();
    expect(storage.getItem(authSessionTestables.accessSyncStorageKey)).toBeNull();
    installLoginSession('dual-recovered-A', 'dual-recovered-R', user, '2'.repeat(64));
    notifyCurrentPrincipalAccessChanged();
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'dual-recovered-A', refreshToken: 'dual-recovered-R', status: 'authenticated',
    });
  });

  it('reconciles a persisted logout before attempting an access notification', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify({
      id: 'logout-before-access-notify',
      source: 'logout-tab',
      type: 'logout',
      sessionId: current.sessionId,
      principalId: current.principalId,
      sessionRevision: current.sessionRevision,
      revision: { clock: current.revision.clock + 1, source: 'logout-tab' },
    }));

    notifyCurrentPrincipalAccessChanged();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(storage.getItem(authSessionTestables.accessSyncStorageKey)).toBeNull();
  });

  it('adopts a newer persisted login without emitting the old family access signal', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const nextUser = { ...user, id: 'u2', username: 'two' };
    const next = {
      ...sessionMessage('access-notify-new-family'),
      source: 'new-login-tab',
      principalId: nextUser.id,
      user: nextUser,
      sessionRevision: { clock: current.sessionRevision.clock + 1, source: 'new-login-tab' },
      revision: { clock: current.revision.clock + 2, source: 'new-login-tab' },
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(next));

    notifyCurrentPrincipalAccessChanged();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      user: { id: nextUser.id },
      status: 'authenticated',
    });
    expect(storage.getItem(authSessionTestables.accessSyncStorageKey)).toBeNull();
  });

  it('fails closed without emitting access when coordination storage is unreadable', () => {
    storage.setItem(authSessionTestables.syncStorageKey, '{');

    notifyCurrentPrincipalAccessChanged();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(storage.getItem(authSessionTestables.accessSyncStorageKey)).toBeNull();
  });

  it('never writes an unsafe logout envelope when the persisted clock is exhausted', async () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const saturated = {
      ...current,
      id: 'saturated-session-clock',
      source: 'saturated-tab',
      revision: { clock: Number.MAX_SAFE_INTEGER - 1, source: 'saturated-tab' },
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(saturated));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await terminateBrowserSession();

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ refreshToken: 'R1' });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!)).toMatchObject({
      id: saturated.id,
      type: 'session',
      revision: saturated.revision,
    });
    expect(() => installLoginSession('after-saturation-A', 'after-saturation-R', user, 'e'.repeat(64)))
      .not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'after-saturation-A',
      refreshToken: 'after-saturation-R',
      status: 'authenticated',
    });
  });

  it('does not adopt a different session id that reuses the current family birth revision during logout', async () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const conflict = {
      ...sessionMessage('birth-revision-collision'),
      source: 'collision-tab',
      sessionRevision: current.sessionRevision,
      revision: { clock: current.revision.clock + 1, source: 'collision-tab' },
      accessToken: 'collision-A',
      refreshToken: 'collision-R',
      refreshRequestId: 'f'.repeat(64),
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(conflict));
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await terminateBrowserSession();

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ refreshToken: 'R1' });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!)).toMatchObject({
      type: 'logout',
      sessionId: current.sessionId,
      sessionRevision: current.sessionRevision,
    });
  });

  it('fails malformed hydrated credential tuples closed before bootstrap use', () => {
    useAuthStore.setState({
      accessToken: 'bad-A',
      refreshToken: 'bad-R',
      refreshRequestId: '4'.repeat(64),
      user: { id: user.id } as UserDto,
      status: 'authenticated',
    });

    expect(() => ensureAuthoritativeSessionRecord()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null,
      refreshToken: null,
      refreshRequestId: null,
      user: null,
      status: 'anonymous',
    });
  });

  it('returns the captured session and fails closed when persisted auth cleanup throws', () => {
    const originalSetItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === 'nyabase-auth') throw new DOMException('blocked');
      originalSetItem(key, value);
    });

    expect(clearLocalSession()).toEqual({ accessToken: 'A1', refreshToken: 'R1' });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null,
      refreshToken: null,
      user: null,
      status: 'anonymous',
    });
  });

  it('applies a qualified logout to every tab in the same session family', () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as {
      sessionId: string; principalId: string;
      sessionRevision: { clock: number; source: string };
      revision: { clock: number; source: string };
    };
    const logout = {
      id: 'self-credential-logout', source: 'credential-tab', type: 'logout' as const,
      sessionId: current.sessionId, principalId: current.principalId,
      sessionRevision: current.sessionRevision,
      revision: { clock: current.revision.clock + 1, source: 'credential-tab' },
    };
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(logout));
    authSessionTestables.receiveMessage(logout);
    expect(useAuthStore.getState()).toMatchObject({ user: null, refreshToken: null, status: 'anonymous' });
  });

  it('keeps a newer explicit session authoritative over a later old-family refresh write', () => {
    const newLogin = sessionMessage('new-family');
    const oldRefresh = {
      ...sessionMessage('old-family-r2'),
      sessionId: 'old-family',
      sessionRevision: { clock: newLogin.sessionRevision.clock - 1, source: 'old-tab' },
      revision: { clock: newLogin.revision.clock + 100, source: 'old-tab' },
      transition: 'refresh' as const,
    };
    expect(authSessionTestables.chooseAuthoritativeMessage(oldRefresh, newLogin)).toBe(newLogin);
    expect(authSessionTestables.chooseAuthoritativeMessage(newLogin, oldRefresh)).toBe(newLogin);
  });

  it('applies the newer session identity even when the old family has a later message revision', () => {
    const old = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as ReturnType<typeof sessionMessage>;
    const newUser = { ...user, id: 'u-new', username: 'new' };
    const newLogin = {
      ...sessionMessage('new-R1'),
      principalId: newUser.id,
      user: newUser,
      sessionRevision: { clock: old.revision.clock + 1, source: 'new-tab' },
      revision: { clock: old.revision.clock + 1, source: 'new-tab' },
    };
    const lateOldRefresh = {
      ...old,
      id: 'late-old-refresh',
      source: 'old-tab',
      transition: 'refresh' as const,
      accessToken: 'old-A2',
      refreshToken: 'old-R2',
      revision: { clock: old.revision.clock + 2, source: 'old-tab' },
    };
    authSessionTestables.receiveMessage(lateOldRefresh);
    expect(useAuthStore.getState().refreshToken).toBe('old-R2');
    authSessionTestables.receiveMessage(newLogin);
    expect(useAuthStore.getState().user?.id).toBe('u-new');
    expect(useAuthStore.getState().refreshToken).toBe('new-R1');
  });

  it('keeps a qualified logout terminal even if an old refresh writes later', () => {
    const currentSession = sessionMessage('family-r1');
    const logout = {
      id: 'qualified-logout',
      source: 'logout-tab',
      type: 'logout' as const,
      sessionId: currentSession.sessionId,
      principalId: currentSession.principalId,
      sessionRevision: currentSession.sessionRevision,
      revision: { clock: currentSession.revision.clock + 1, source: 'logout-tab' },
    };
    const lateRefresh = {
      ...currentSession,
      id: 'late-refresh',
      transition: 'refresh' as const,
      revision: { clock: logout.revision.clock + 1, source: 'refresh-tab' },
    };
    expect(authSessionTestables.chooseAuthoritativeMessage(lateRefresh, logout)).toBe(logout);
  });

  it('preserves the recovery pair when a successful refresh has no usable token payload', async () => {
    const requestId = useAuthStore.getState().refreshRequestId;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })));
    await expect(authApiTestables.tryRefresh()).rejects.toMatchObject({
      code: 'INVALID_REFRESH_RESPONSE',
    });
    expect(useAuthStore.getState()).toMatchObject({
      refreshToken: 'R1', refreshRequestId: requestId, status: 'error',
    });
  });

  it('retries a lost refresh response with the identical token and request id', async () => {
    const originalRequestId = useAuthStore.getState().refreshRequestId;
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'A2', refreshToken: 'R2',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.tryRefresh()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(useAuthStore.getState()).toMatchObject({
      refreshToken: 'R1', refreshRequestId: originalRequestId, status: 'error',
    });
    await expect(authApiTestables.tryRefresh()).resolves.toBe('A2');

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody).toEqual({ refreshToken: 'R1', requestId: originalRequestId });
    expect(secondBody).toEqual(firstBody);
    expect(useAuthStore.getState().refreshRequestId).toMatch(/^[0-9a-f]{64}$/);
    expect(useAuthStore.getState().refreshRequestId).not.toBe(originalRequestId);
  });

  it('migrates the legacy token format to a durable request id before the first refresh', async () => {
    const legacy = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as Record<string, unknown>;
    delete legacy.refreshRequestId;
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(legacy));
    useAuthStore.setState({ refreshRequestId: null });
    let migratedRequestId: string | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      const durable = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as {
        refreshRequestId?: string;
      };
      migratedRequestId = body.requestId;
      expect(durable.refreshRequestId).toBe(body.requestId);
      return new Response(JSON.stringify({
        accessToken: 'A2', refreshToken: 'R2', user,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.tryRefresh()).resolves.toBe('A2');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      refreshToken: string; requestId: string;
    };
    expect(body.refreshToken).toBe('R1');
    expect(body.requestId).toMatch(/^[0-9a-f]{64}$/);
    expect(migratedRequestId).toBe(body.requestId);
    expect(JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!).refreshRequestId)
      .toBe(useAuthStore.getState().refreshRequestId);
  });

  it('fails a legacy refresh closed when WebCrypto cannot create its request id', async () => {
    const legacy = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as Record<string, unknown>;
    delete legacy.refreshRequestId;
    storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(legacy));
    useAuthStore.setState({ refreshRequestId: null });
    vi.stubGlobal('crypto', { randomUUID: () => 'no-random-values' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.tryRefresh()).rejects.toMatchObject({
      code: 'AUTH_COORDINATION_UNAVAILABLE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ refreshToken: 'R1', status: 'error' });
  });

  it('keeps rotated tokens hidden behind an error state when the fresh user response is invalid', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'R2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.tryRefresh()).rejects.toMatchObject({
      code: 'INVALID_CURRENT_USER_RESPONSE',
    });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'A2',
      refreshToken: 'R2',
      status: 'error',
    });
  });

  it('revokes an issued refresh successor when its access token cannot load the current user', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'R2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 401, statusText: 'Unauthorized' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.tryRefresh()).resolves.toBeNull();
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/auth/logout');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ refreshToken: 'R2' });
  });

  it('never replays an old-principal request after a new login changes the auth epoch', async () => {
    const nextUser = { ...user, id: 'u2', username: 'two', displayName: 'Two' };
    const fetchMock = vi.fn(async () => {
      installLoginSession('new-A', 'new-R', nextUser);
      return new Response(null, { status: 401, statusText: 'Unauthorized' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.post('/dangerous-write', { value: true })).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user?.id).toBe('u2');
  });

  it('does not reuse an in-flight refresh attempt after the session is replaced', async () => {
    let resolveOldRefresh!: (response: Response) => void;
    const nextUser = { ...user, id: 'u2', username: 'two', displayName: 'Two' };
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOldRefresh = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'A3',
        refreshToken: 'R3',
        user: nextUser,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const oldAttempt = authApiTestables.tryRefresh();
    installLoginSession('new-A', 'new-R', nextUser);
    const newAttempt = authApiTestables.tryRefresh();
    resolveOldRefresh(new Response(null, { status: 401, statusText: 'Unauthorized' }));

    await expect(oldAttempt).resolves.toBe('new-A');
    await expect(newAttempt).resolves.toBe('A3');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      refreshToken: 'new-R',
      requestId: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(useAuthStore.getState().refreshToken).toBe('R3');
  });

  it('adopts a persisted new login that arrives between refresh POST and commit', async () => {
    const nextUser = { ...user, id: 'u2', username: 'two', displayName: 'Two' };
    const nextSession = { ...sessionMessage('R-new'), principalId: nextUser.id, user: nextUser };
    vi.stubGlobal('fetch', vi.fn(async () => {
      storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify(nextSession));
      return new Response(JSON.stringify({ accessToken: 'stale-A2', refreshToken: 'stale-R2', user }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    await expect(authApiTestables.tryRefresh()).resolves.toBe('A-R-new');
    expect(useAuthStore.getState().user?.id).toBe('u2');
    expect(useAuthStore.getState().refreshToken).toBe('R-new');
  });

  it('honors a qualified persisted logout that arrives between refresh POST and commit', async () => {
    const current = JSON.parse(storage.getItem(authSessionTestables.syncStorageKey)!) as {
      sessionId: string; sessionRevision: { clock: number; source: string }; revision: { clock: number };
    };
    vi.stubGlobal('fetch', vi.fn(async () => {
      storage.setItem(authSessionTestables.syncStorageKey, JSON.stringify({
        id: 'logout-current-session',
        source: 'another-tab',
        type: 'logout',
        sessionId: current.sessionId,
        principalId: user.id,
        sessionRevision: current.sessionRevision,
        revision: { clock: current.revision.clock + 10, source: 'another-tab' },
      }));
      return new Response(JSON.stringify({ accessToken: 'stale-A2', refreshToken: 'stale-R2', user }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    await expect(authApiTestables.tryRefresh()).resolves.toBeNull();
    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });

  it('fails both contenders closed when storage cannot coordinate rotating refresh tokens', async () => {
    stubBrowser(false);
    authSessionTestables.resetForTests();
    useAuthStore.setState({ accessToken: 'A1', refreshToken: 'R1', refreshRequestId: '1'.repeat(64), user, epoch: 1, status: 'authenticated', authError: null });
    const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new DOMException('blocked'); });
    const callbacks = [vi.fn(async () => 'unsafe-1'), vi.fn(async () => 'unsafe-2')];

    const results = await Promise.allSettled(callbacks.map((callback) => withCrossTabRefreshLock(callback)));
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === 'rejected'
      && result.reason instanceof Error
      && result.reason.name === 'AuthSessionCoordinationError')).toBe(true);
    callbacks.forEach((callback) => expect(callback).not.toHaveBeenCalled());
    setItem.mockRestore();
  });

  it('proves storage round-trip before issuing a login request', async () => {
    clearLocalSession(false);
    const setItem = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.login({ username: 'one', password: 'password' }))
      .rejects.toMatchObject({ name: 'AuthSessionCoordinationError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ user: null, refreshToken: null, status: 'anonymous' });
    setItem.mockRestore();
  });

  it('clears a login that cannot be broadcast and best-effort revokes the issued server session', async () => {
    clearLocalSession(false);
    const originalSetItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === authSessionTestables.syncStorageKey) throw new DOMException('blocked');
      originalSetItem(key, value);
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'login-A', refreshToken: 'login-R', user,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.login({ username: 'one', password: 'password' }))
      .rejects.toMatchObject({ name: 'AuthSessionCoordinationError' });

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/logout');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ refreshToken: 'login-R' });
  });

  it('keeps a unique successful R2 when the fallback lease expires in flight', async () => {
    stubBrowser(false);
    authSessionTestables.resetForTests();
    useAuthStore.setState({ accessToken: null, refreshToken: null, refreshRequestId: null, user: null, epoch: 0, status: 'anonymous', authError: null });
    installLoginSession('A1', 'R1', user);
    vi.stubGlobal('fetch', vi.fn(async () => {
      storage.setItem(authSessionTestables.refreshLockKey, JSON.stringify({
        owner: 'successor-tab',
        expiresAt: Date.now() + authSessionTestables.refreshLeaseDurationMs,
      }));
      return new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'R2', user }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    await expect(authApiTestables.tryRefresh()).resolves.toBe('A2');
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: 'A2', refreshToken: 'R2', status: 'authenticated',
    });
  });

  it('clears and revokes rotated tokens when sync storage breaks after refresh', async () => {
    const originalSetItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === authSessionTestables.syncStorageKey) {
        const message = JSON.parse(value) as { transition?: string };
        if (message.transition === 'refresh') throw new DOMException('blocked');
      }
      originalSetItem(key, value);
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'A2', refreshToken: 'R2', user,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.tryRefresh()).rejects.toMatchObject({
      code: 'AUTH_COORDINATION_UNAVAILABLE',
    });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/logout');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ refreshToken: 'R2' });
  });

  it('clears the spent predecessor and revokes R2 when storage fails before refresh commit', async () => {
    const originalGetItem = storage.getItem.bind(storage);
    let failSessionReads = false;
    vi.spyOn(storage, 'getItem').mockImplementation((key) => {
      if (failSessionReads && key === authSessionTestables.syncStorageKey) {
        throw new DOMException('blocked');
      }
      return originalGetItem(key);
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        failSessionReads = true;
        return new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'R2', user }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.tryRefresh()).rejects.toMatchObject({
      code: 'AUTH_COORDINATION_UNAVAILABLE',
    });
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null, refreshToken: null, user: null, status: 'anonymous',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ refreshToken: 'R2' });
  });

  it('reports ownership lost when a throttled lease expires before work continues', async () => {
    vi.useFakeTimers();
    stubBrowser(false);
    let ownsAfterExpiry = true;
    const work = withCrossTabRefreshLock(async (ownsLock) => {
      const lease = JSON.parse(storage.getItem(authSessionTestables.refreshLockKey)!) as { owner: string };
      storage.setItem(authSessionTestables.refreshLockKey, JSON.stringify({ owner: lease.owner, expiresAt: Date.now() - 1 }));
      ownsAfterExpiry = ownsLock();
      return 'done';
    });
    await expect(work).resolves.toBe('done');
    expect(ownsAfterExpiry).toBe(false);
  });

  it('renews the storage fallback lease beyond the original 15-second race window', async () => {
    vi.useFakeTimers();
    stubBrowser(false);
    const work = withCrossTabRefreshLock(async (ownsLock) => {
      expect(ownsLock()).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
      expect(ownsLock()).toBe(true);
      return 'done';
    });
    await vi.advanceTimersByTimeAsync(16_000);
    const lease = JSON.parse(storage.getItem(authSessionTestables.refreshLockKey)!) as { expiresAt: number };
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(work).resolves.toBe('done');
  });
});
