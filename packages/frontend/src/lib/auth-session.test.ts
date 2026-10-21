import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserStatus, type UserDto } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';
import { api, authApiTestables } from './api.js';
import {
  authSessionTestables,
  clearLocalSession,
  initializeAuthSync,
} from './auth-session.js';
import { terminateBrowserSession } from './session-termination.js';
import { queryClient } from './query-client.js';
import { takePendingLoginReason } from './pending-login-reason.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class FakeChannel {
  static instances: FakeChannel[] = [];
  readonly posted: unknown[] = [];
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { FakeChannel.instances.push(this); }
  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) { this.listener = listener; }
  postMessage(message: unknown) { this.posted.push(message); }
  close() { this.listener = null; }
  deliver(message: unknown) { this.listener?.({ data: message } as MessageEvent<unknown>); }
}

const alice: UserDto = {
  id: 'u1', username: 'alice', displayName: 'Alice', status: UserStatus.Active,
  createdAt: '2026-01-01T00:00:00.000Z', capabilities: [], groups: [],
};
const bob: UserDto = { ...alice, id: 'u2', username: 'bob', displayName: 'Bob' };

let storage: MemoryStorage;
let lockRequests: string[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubBrowser() {
  storage = new MemoryStorage();
  lockRequests = [];
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('navigator', {
    locks: {
      request: async (name: string, callback: () => Promise<unknown>) => {
        lockRequests.push(name);
        return callback();
      },
    },
  });
  FakeChannel.instances = [];
  vi.stubGlobal('BroadcastChannel', FakeChannel);
}

function signIn(user = alice, accessToken = 'A1') {
  useAuthStore.getState().setAuth(accessToken, user);
}

function body(call: unknown[] | undefined) {
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
}

function headers(call: unknown[] | undefined) {
  return (call?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
}

describe('cookie-backed auth session', () => {
  beforeEach(() => {
    stubBrowser();
    authSessionTestables.resetForTests();
    useAuthStore.setState({ accessToken: null, user: null, epoch: 0, status: 'checking', authError: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('logs in with the intent header and keeps no credential in storage', async () => {
    initializeAuthSync({ onPeerLogin: vi.fn() });
    const fetchMock = vi.fn().mockResolvedValue(json({ accessToken: 'A1', user: alice }));
    vi.stubGlobal('fetch', fetchMock);

    await api.login({ username: 'alice', password: 'pw' });

    expect(headers(fetchMock.mock.calls[0])['X-Nyabase-Auth']).toBe('1');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'A1', user: alice, status: 'authenticated' });
    for (let index = 0; index < storage.length; index += 1) {
      expect(storage.getItem(storage.key(index)!)).not.toContain('A1');
    }
    expect(FakeChannel.instances[0].posted).toContainEqual(expect.objectContaining({ type: 'login' }));
  });

  it('clears cached principal data before installing a login', async () => {
    queryClient.setQueryData(['containers'], ['old-principal-row']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ accessToken: 'A1', user: alice })));
    await api.login({ username: 'alice', password: 'pw' });
    expect(queryClient.getQueryData(['containers'])).toBeUndefined();
  });

  it('rotates through the cookie under the cross-tab lock, sending only a request id', async () => {
    signIn();
    const fetchMock = vi.fn().mockResolvedValue(json({ accessToken: 'A2', user: alice }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.tryRefresh()).resolves.toBe('A2');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/refresh');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-Nyabase-Auth']).toBe('1');
    expect(Object.keys(body(fetchMock.mock.calls[0]))).toEqual(['requestId']);
    expect(lockRequests).toEqual(['nyabase-auth-refresh']);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'A2', status: 'authenticated' });
  });

  it('retries a lost refresh response with the identical request id, then starts a new one', async () => {
    signIn();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(json({ accessToken: 'A2', user: alice }))
      .mockResolvedValueOnce(json({ accessToken: 'A3', user: alice }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authApiTestables.tryRefresh()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(useAuthStore.getState().status).toBe('error');
    await expect(authApiTestables.tryRefresh()).resolves.toBe('A2');
    await expect(authApiTestables.tryRefresh()).resolves.toBe('A3');

    const [first, retry, next] = fetchMock.mock.calls.map((call) => body(call).requestId);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
  });

  it('shares the pending request id with other tabs through storage', async () => {
    signIn();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(authApiTestables.tryRefresh()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const pending = storage.getItem(authSessionTestables.pendingRefreshRequestKey);
    expect(pending).toMatch(/^[0-9a-f]{64}$/);

    // Another tab (same storage, fresh memory) recovers with the same id.
    authSessionTestables.resetForTests();
    const fetchMock = vi.fn().mockResolvedValue(json({ accessToken: 'A2', user: alice }));
    vi.stubGlobal('fetch', fetchMock);
    useAuthStore.setState({ status: 'authenticated', authError: null });
    await authApiTestables.tryRefresh();
    expect(body(fetchMock.mock.calls[0]).requestId).toBe(pending);
  });

  it('keeps the request id when a successful refresh has no usable payload', async () => {
    signIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ accessToken: 'A2' })));
    await expect(authApiTestables.tryRefresh()).rejects.toMatchObject({ code: 'INVALID_REFRESH_RESPONSE' });
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'A1', status: 'error' });
  });

  it('signs out with a session-expired reason when the cookie is rejected', async () => {
    signIn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Invalid refresh token' }, 401)));

    await expect(authApiTestables.tryRefresh()).resolves.toBeNull();

    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, user: null, status: 'anonymous' });
    expect(takePendingLoginReason()).toBe('session-expired');
    expect(storage.getItem(authSessionTestables.pendingRefreshRequestKey)).toBeNull();
  });

  it('treats a cold load without a cookie as anonymous, not expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Invalid refresh token' }, 401)));
    await authApiTestables.runBootstrap();
    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(takePendingLoginReason()).toBeUndefined();
  });

  it('does not report an expired session for an anonymous request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Unauthorized' }, 401)));
    await expect(api.get('/public/thing')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(takePendingLoginReason()).toBeUndefined();
  });

  it('recovers the session from the cookie on a cold load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ accessToken: 'A9', user: alice })));
    await authApiTestables.runBootstrap();
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'A9', user: alice, status: 'authenticated' });
  });

  it('revalidates an in-memory session with /me instead of rotating the cookie', async () => {
    signIn();
    const promoted = { ...alice, capabilities: ['manage_users'] } as UserDto;
    const fetchMock = vi.fn().mockResolvedValue(json(promoted));
    vi.stubGlobal('fetch', fetchMock);
    await authApiTestables.runBootstrap();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/auth/me']);
    expect(useAuthStore.getState().user?.capabilities).toEqual(['manage_users']);
  });

  it('never replays an old-principal request after a new login changes the auth epoch', async () => {
    signIn(alice, 'A-alice');
    const fetchMock = vi.fn(async () => {
      signIn(bob, 'A-bob');
      return json({ message: 'expired' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.get('/containers')).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user?.id).toBe('u2');
  });

  it('does not reuse an in-flight refresh after the session is replaced', async () => {
    signIn(alice, 'A-alice');
    let releaseFirst!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(json({ accessToken: 'A-bob-2', user: bob }));
    vi.stubGlobal('fetch', fetchMock);

    const first = authApiTestables.tryRefresh();
    await Promise.resolve();
    signIn(bob, 'A-bob');
    const second = authApiTestables.tryRefresh();
    releaseFirst(json({ accessToken: 'A-alice-2', user: alice }));

    await expect(first).resolves.toBe('A-bob');
    await expect(second).resolves.toBe('A-bob-2');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'A-bob-2', user: bob });
  });

  it('drops this tab when another tab logs out, and re-derives on a peer login', () => {
    const onPeerLogin = vi.fn();
    initializeAuthSync({ onPeerLogin });
    signIn();
    const channel = FakeChannel.instances[0];

    channel.deliver({ type: 'login', source: 'other-tab' });
    expect(onPeerLogin).toHaveBeenCalledOnce();

    channel.deliver({ type: 'logout', source: 'other-tab' });
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, status: 'anonymous' });
    expect(channel.posted).toEqual([]);
  });

  it('broadcasts logout and revokes through the cookie endpoint', async () => {
    initializeAuthSync({ onPeerLogin: vi.fn() });
    signIn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await terminateBrowserSession();

    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(FakeChannel.instances[0].posted).toContainEqual(expect.objectContaining({ type: 'logout' }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/logout');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-Nyabase-Auth']).toBe('1');
  });

  it('returns the captured access token when clearing locally', () => {
    signIn(alice, 'A-captured');
    expect(clearLocalSession(false)).toEqual({ accessToken: 'A-captured' });
  });
});
