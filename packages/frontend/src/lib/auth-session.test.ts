import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Role, UserStatus, type UserDto } from '@nyabase/common';

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
  createdAt: '2026-01-01T00:00:00.000Z', role: Role.User,
};
const bob: UserDto = { ...alice, id: 'u2', username: 'bob', displayName: 'Bob' };

let storage: MemoryStorage;
let lockRequests: string[];

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
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

type App = Awaited<ReturnType<typeof loadApp>>;
let app: App;

/** A fresh module graph is a fresh browser tab: module state never leaks between tests. */
async function loadApp() {
  vi.resetModules();
  const [{ useAuthStore }, { api, bootstrapAuthSession }, session, { terminateBrowserSession }, { queryClient }, { takePendingLoginReason }] =
    await Promise.all([
      import('../store/auth.js'),
      import('./api.js'),
      import('./auth-session.js'),
      import('./auth-session.js'),
      import('./query-client.js'),
      import('./auth-session.js'),
    ]);
  useAuthStore.setState({ accessToken: null, user: null, epoch: 0, status: 'checking', authError: null });
  return {
    useAuthStore,
    api,
    bootstrapAuthSession,
    clearLocalSession: session.clearLocalSession,
    initializeAuthSync: session.initializeAuthSync,
    terminateBrowserSession,
    queryClient,
    takePendingLoginReason,
  };
}

function signIn(user = alice, accessToken = 'A1') {
  app.useAuthStore.getState().setAuth(accessToken, user);
}

type RefreshResult = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/**
 * A fake backend: /auth/refresh answers from a queue and any other path is 401
 * until the caller presents the access token the last refresh handed out.
 */
function authServer(refreshResults: RefreshResult[]) {
  let validToken: string | null = null;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/refresh') {
      const next = refreshResults.shift();
      if (!next) throw new Error('unexpected refresh');
      if (next instanceof Error) throw next;
      const accessToken = (next.body as { accessToken?: string } | undefined)?.accessToken;
      if ((next.status ?? 200) === 200 && accessToken) validToken = accessToken;
      return json(next.body ?? {}, next.status ?? 200, next.headers);
    }
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    return authorization === `Bearer ${validToken}`
      ? json({ ok: true })
      : json({ message: 'expired' }, 401);
  });
  return {
    fetchMock,
    refreshCalls: () => fetchMock.mock.calls.filter(([url]) => url === '/api/auth/refresh'),
  };
}

/** The only value the auth layer persists is the pending refresh request id. */
function pendingRefreshRequestId(): string | null {
  for (let index = 0; index < storage.length; index += 1) {
    const value = storage.getItem(storage.key(index)!);
    if (value && /^[0-9a-f]{64}$/.test(value)) return value;
  }
  return null;
}

function body(call: unknown[] | undefined) {
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
}

function headers(call: unknown[] | undefined) {
  return (call?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
}

describe('cookie-backed auth session', () => {
  beforeEach(async () => {
    stubBrowser();
    app = await loadApp();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    app.queryClient.clear();
  });

  it('logs in with the intent header and keeps no credential in storage', async () => {
    app.initializeAuthSync({ onPeerLogin: vi.fn() });
    const fetchMock = vi.fn().mockResolvedValue(json({ accessToken: 'A1', user: alice }));
    vi.stubGlobal('fetch', fetchMock);

    await app.api.login({ username: 'alice', password: 'pw' });

    expect(headers(fetchMock.mock.calls[0])['X-Nyabase-Auth']).toBe('1');
    expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A1', user: alice, status: 'authenticated' });
    for (let index = 0; index < storage.length; index += 1) {
      expect(storage.getItem(storage.key(index)!)).not.toContain('A1');
    }
    expect(FakeChannel.instances[0].posted).toContainEqual(expect.objectContaining({ type: 'login' }));
  });

  it('clears cached principal data before installing a login', async () => {
    app.queryClient.setQueryData(['containers'], ['old-principal-row']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ accessToken: 'A1', user: alice })));
    await app.api.login({ username: 'alice', password: 'pw' });
    expect(app.queryClient.getQueryData(['containers'])).toBeUndefined();
  });

  it('rotates through the cookie under the cross-tab lock, sending only a request id', async () => {
    signIn();
    const server = authServer([{ body: { accessToken: 'A2', user: alice } }]);
    vi.stubGlobal('fetch', server.fetchMock);

    await expect(app.api.get('/ping')).resolves.toEqual({ ok: true });

    const [url, init] = server.refreshCalls()[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/refresh');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-Nyabase-Auth']).toBe('1');
    expect(Object.keys(body(server.refreshCalls()[0]))).toEqual(['requestId']);
    expect(lockRequests).toEqual(['nyabase-auth-refresh']);
    expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A2', status: 'authenticated' });
  });

  it('retries a lost refresh response with the identical request id, then starts a new one', async () => {
    signIn();
    const server = authServer([
      new TypeError('response lost'),
      { body: { accessToken: 'A2', user: alice } },
      { body: { accessToken: 'A3', user: alice } },
    ]);
    vi.stubGlobal('fetch', server.fetchMock);

    await expect(app.api.get('/ping')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(app.useAuthStore.getState().status).toBe('error');
    await expect(app.api.get('/ping')).resolves.toEqual({ ok: true });
    expect(app.useAuthStore.getState().accessToken).toBe('A2');
    // A2 is now the valid token; presenting a stale one forces the next rotation.
    signIn(alice, 'stale');
    await expect(app.api.get('/ping')).resolves.toEqual({ ok: true });
    expect(app.useAuthStore.getState().accessToken).toBe('A3');

    const [first, retry, next] = server.refreshCalls().map((call) => body(call).requestId);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(retry).toBe(first);
    expect(next).not.toBe(first);
  });

  it('shares the pending request id with other tabs through storage', async () => {
    signIn();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/refresh') throw new TypeError('offline');
      return json({ message: 'expired' }, 401);
    }));
    await expect(app.api.get('/ping')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const pending = pendingRefreshRequestId();
    expect(pending).toMatch(/^[0-9a-f]{64}$/);

    // Another tab (same storage, fresh modules) recovers with the same id.
    app = await loadApp();
    signIn();
    const server = authServer([{ body: { accessToken: 'A2', user: alice } }]);
    vi.stubGlobal('fetch', server.fetchMock);
    await app.api.get('/ping');
    expect(body(server.refreshCalls()[0]).requestId).toBe(pending);
  });

  it('keeps the request id when a successful refresh has no usable payload', async () => {
    signIn();
    const server = authServer([{ body: { accessToken: 'A2' } }]);
    vi.stubGlobal('fetch', server.fetchMock);
    await expect(app.api.get('/ping')).rejects.toMatchObject({ code: 'INVALID_REFRESH_RESPONSE' });
    expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A1', status: 'error' });
  });

  it('signs out with a session-expired reason when the cookie is rejected', async () => {
    signIn();
    const server = authServer([{ status: 401, body: { message: 'Invalid refresh token' } }]);
    vi.stubGlobal('fetch', server.fetchMock);

    await expect(app.api.get('/ping')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(app.useAuthStore.getState()).toMatchObject({ accessToken: null, user: null, status: 'anonymous' });
    expect(app.takePendingLoginReason()).toBe('session-expired');
    expect(pendingRefreshRequestId()).toBeNull();
  });

  it('rotates again with a new request id after losing a concurrent rotation', async () => {
    signIn();
    const server = authServer([
      { status: 401, body: { code: 'REFRESH_SUPERSEDED', message: 'Refresh token was already rotated' } },
      { body: { accessToken: 'A2', user: alice } },
    ]);
    vi.stubGlobal('fetch', server.fetchMock);

    await expect(app.api.get('/ping')).resolves.toEqual({ ok: true });

    const [lost, retried] = server.refreshCalls().map((call) => body(call).requestId);
    expect(retried).not.toBe(lost);
    expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A2', status: 'authenticated' });
    expect(app.takePendingLoginReason()).toBeUndefined();
    expect(pendingRefreshRequestId()).toBeNull();
  });

  it('retries a superseded refresh only once and keeps the session', async () => {
    signIn();
    const superseded = { status: 401, body: { code: 'REFRESH_SUPERSEDED', message: 'Refresh token was already rotated' } };
    const server = authServer([superseded, superseded]);
    vi.stubGlobal('fetch', server.fetchMock);

    await expect(app.api.get('/ping')).rejects.toMatchObject({ code: 'REFRESH_SUPERSEDED' });

    expect(server.refreshCalls()).toHaveLength(2);
    expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A1', user: alice, status: 'error' });
    expect(app.takePendingLoginReason()).toBeUndefined();
  });

  describe('throttled refresh (429)', () => {
    const throttled = (headers?: Record<string, string>) => ({
      status: 429, body: { code: 'AUTH_RATE_LIMITED', message: 'Too many session refreshes' }, headers,
    });

    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    it('waits for Retry-After outside the lock and retries with the same request id', async () => {
      app.initializeAuthSync({ onPeerLogin: vi.fn() });
      signIn();
      const server = authServer([throttled({ 'Retry-After': '2' }), { body: { accessToken: 'A2', user: alice } }]);
      vi.stubGlobal('fetch', server.fetchMock);

      const ping = app.api.get('/ping');
      await vi.advanceTimersByTimeAsync(1_999);
      expect(server.refreshCalls()).toHaveLength(1);
      expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A1', status: 'authenticated' });
      await vi.advanceTimersByTimeAsync(1);
      await expect(ping).resolves.toEqual({ ok: true });

      const [first, retry] = server.refreshCalls().map((call) => body(call).requestId);
      expect(retry).toBe(first);
      // One lock per request: nothing was held while waiting.
      expect(lockRequests).toEqual(['nyabase-auth-refresh', 'nyabase-auth-refresh']);
      expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A2', status: 'authenticated' });
      expect(FakeChannel.instances[0].posted).toEqual([]);
    });

    it('gives up after a bounded number of requests without leaving the page or signing out', async () => {
      signIn();
      const server = authServer([
        throttled(), throttled(), throttled(), { body: { accessToken: 'A2', user: alice } },
      ]);
      vi.stubGlobal('fetch', server.fetchMock);

      const ping = app.api.get('/ping');
      const outcome = expect(ping).rejects.toMatchObject({ status: 429, code: 'AUTH_RATE_LIMITED' });
      // Exponential backoff without Retry-After: 1 s, then 2 s.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(server.refreshCalls()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2_000);
      await outcome;
      expect(server.refreshCalls()).toHaveLength(3);
      expect(app.useAuthStore.getState()).toMatchObject({
        accessToken: 'A1', user: alice, status: 'authenticated', authError: null,
      });
      expect(app.takePendingLoginReason()).toBeUndefined();

      // Cooling down: further 401s fail fast without another refresh request.
      await expect(app.api.get('/ping')).rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED' });
      expect(server.refreshCalls()).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(app.api.get('/ping')).resolves.toEqual({ ok: true });
      expect(server.refreshCalls()).toHaveLength(4);
    });

    it('shows a wait screen on a cold load instead of the session-check error', async () => {
      const server = authServer([throttled({ 'Retry-After': '600' }), { body: { accessToken: 'A2', user: alice } }]);
      vi.stubGlobal('fetch', server.fetchMock);

      // A long Retry-After is not waited out in place.
      await app.bootstrapAuthSession();
      expect(server.refreshCalls()).toHaveLength(1);
      expect(app.useAuthStore.getState()).toMatchObject({ status: 'throttled', user: null });
      expect(app.useAuthStore.getState().authError).toContain('600 秒');

      // Retrying (button or focus) inside the wait sends nothing.
      await vi.advanceTimersByTimeAsync(60_000);
      await app.bootstrapAuthSession();
      expect(server.refreshCalls()).toHaveLength(1);
      expect(app.useAuthStore.getState()).toMatchObject({ status: 'throttled' });
      expect(app.useAuthStore.getState().authError).toContain('540 秒');

      await vi.advanceTimersByTimeAsync(540_000);
      await app.bootstrapAuthSession();
      expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A2', status: 'authenticated' });
    });

    it('parses Retry-After as seconds or an HTTP date', async () => {
      const { parseRetryAfterMs } = await import('./api.js');
      const now = Date.parse('2026-01-01T00:00:00Z');
      expect(parseRetryAfterMs('42', now)).toBe(42_000);
      expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
      expect(parseRetryAfterMs('Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(0);
      expect(parseRetryAfterMs(null, now)).toBeNull();
      expect(parseRetryAfterMs('soon', now)).toBeNull();
    });
  });

  it('treats a cold load without a cookie as anonymous, not expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Invalid refresh token' }, 401)));
    await app.bootstrapAuthSession();
    expect(app.useAuthStore.getState().status).toBe('anonymous');
    expect(app.takePendingLoginReason()).toBeUndefined();
  });

  it('does not report an expired session for an anonymous request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Unauthorized' }, 401)));
    await expect(app.api.get('/public/thing')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(app.takePendingLoginReason()).toBeUndefined();
  });

  it('recovers the session from the cookie on a cold load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ accessToken: 'A9', user: alice })));
    await app.bootstrapAuthSession();
    expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A9', user: alice, status: 'authenticated' });
  });

  it('revalidates an in-memory session with /me instead of rotating the cookie', async () => {
    signIn();
    const promoted: UserDto = { ...alice, role: Role.UserAdmin };
    const fetchMock = vi.fn().mockResolvedValue(json(promoted));
    vi.stubGlobal('fetch', fetchMock);
    await app.bootstrapAuthSession();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/auth/me']);
    expect(app.useAuthStore.getState().user?.role).toBe(Role.UserAdmin);
  });

  it('never replays an old-principal request after a new login changes the auth epoch', async () => {
    signIn(alice, 'A-alice');
    const fetchMock = vi.fn(async () => {
      signIn(bob, 'A-bob');
      return json({ message: 'expired' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(app.api.get('/containers')).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(app.useAuthStore.getState().user?.id).toBe('u2');
  });

  it('does not reuse an in-flight refresh after the session is replaced', async () => {
    signIn(alice, 'A-alice');
    let releaseFirst!: (response: Response) => void;
    const refreshResponses = [
      new Promise<Response>((resolve) => { releaseFirst = resolve; }),
      Promise.resolve(json({ accessToken: 'A-bob-2', user: bob })),
    ];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/refresh') return refreshResponses.shift()!;
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return authorization === 'Bearer A-bob-2' ? json({ ok: true }) : json({ message: 'expired' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = app.api.get('/ping');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/refresh')).toBe(true));
    signIn(bob, 'A-bob');
    const second = app.api.get('/ping');
    releaseFirst(json({ accessToken: 'A-alice-2', user: alice }));

    // The old principal's request is never replayed under the new session.
    await expect(first).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await expect(second).resolves.toEqual({ ok: true });
    expect(app.useAuthStore.getState()).toMatchObject({ accessToken: 'A-bob-2', user: bob });
  });

  it('drops this tab when another tab logs out, and re-derives on a peer login', () => {
    const onPeerLogin = vi.fn();
    app.initializeAuthSync({ onPeerLogin });
    signIn();
    const channel = FakeChannel.instances[0];

    channel.deliver({ type: 'login', source: 'other-tab' });
    expect(onPeerLogin).toHaveBeenCalledOnce();

    channel.deliver({ type: 'logout', source: 'other-tab' });
    expect(app.useAuthStore.getState()).toMatchObject({ accessToken: null, status: 'anonymous' });
    expect(channel.posted).toEqual([]);
  });

  it('broadcasts logout and revokes through the cookie endpoint', async () => {
    app.initializeAuthSync({ onPeerLogin: vi.fn() });
    signIn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await app.terminateBrowserSession();

    expect(app.useAuthStore.getState().status).toBe('anonymous');
    expect(FakeChannel.instances[0].posted).toContainEqual(expect.objectContaining({ type: 'logout' }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/logout');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-Nyabase-Auth']).toBe('1');
  });

  it('returns the captured access token when clearing locally', () => {
    signIn(alice, 'A-captured');
    expect(app.clearLocalSession(false)).toEqual({ accessToken: 'A-captured' });
  });
});
