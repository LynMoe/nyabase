import type { LoginResponse, UserDto } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';
import { ApiError } from './api-error.js';
import {
  announceLogin,
  AuthSessionCoordinationError,
  type CapturedSession,
  clearLocalSession,
  discardPendingRefreshRequestId,
  isRuntimeUserDto,
  pendingRefreshRequestId,
  setPendingLoginReason,
  settleRefreshRequestId,
  shouldClearPrincipalState,
  withCrossTabRefreshLock,
} from './auth-session.js';
import { clearPrincipalQueryState } from './query-client.js';

const BASE_URL = '/api';
/** Required by the Backend on cookie endpoints; forces a CORS preflight cross-site. */
const AUTH_INTENT_HEADERS = { 'Content-Type': 'application/json', 'X-Nyabase-Auth': '1' };
/** 401 from /auth/refresh: this tab lost a concurrent rotation; the cookie is kept. */
const REFRESH_SUPERSEDED = 'REFRESH_SUPERSEDED';

/**
 * 429 from /auth/refresh: the session rotated too often recently (many tabs,
 * a short access-token lifetime). The session and cookie are intact, so this
 * is transient: wait (Retry-After) and try again a bounded number of times.
 */
const REFRESH_RATE_LIMITED = 'AUTH_RATE_LIMITED';
const MAX_THROTTLED_REFRESH_REQUESTS = 3;
/** Without Retry-After: 1 s, then 2 s. */
const THROTTLED_REFRESH_BACKOFF_MS = 1_000;
/** A longer Retry-After is not waited out in place; the request fails instead. */
const MAX_THROTTLED_REFRESH_WAIT_MS = 15_000;

let refreshAttempt: { epoch: number; promise: Promise<string | null> } | null = null;
/** No refresh request leaves this tab before this time (Date.now() ms). */
let refreshThrottledUntil = 0;
let bootstrapPromise: Promise<void> | null = null;
let bootstrapQueued = false;

function isAuthResponse(value: unknown): value is { accessToken: string; user: UserDto } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { accessToken?: unknown; user?: unknown };
  return typeof candidate.accessToken === 'string'
    && candidate.accessToken.length > 0
    && isRuntimeUserDto(candidate.user);
}

async function apiErrorFromResponse(res: Response): Promise<ApiError> {
  let parsedBody: unknown = null;
  try {
    parsedBody = await res.json();
  } catch {
    // Responses such as proxy failures may not contain JSON.
  }
  const errBody = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown>
    : {};
  const responseMessage = typeof errBody.message === 'string' ? errBody.message : undefined;
  const responseCode = typeof errBody.code === 'string' ? errBody.code : undefined;
  const message = res.status >= 500
    ? '服务器内部错误，请稍后重试'
    : (responseMessage ?? (res.statusText || '请求失败'));
  return new ApiError(res.status, responseCode ?? 'UNKNOWN', message, parsedBody);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * One POST /auth/refresh with the pending request id. The id is settled once
 * the server has answered 2xx/401/403; on a network error it is kept so a
 * retry recovers the same successor if the server rotated but the response
 * was lost.
 */
async function postRefresh(fail: (message: string) => void): Promise<Response> {
  const requestId = pendingRefreshRequestId();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: AUTH_INTENT_HEADERS,
      credentials: 'same-origin',
      body: JSON.stringify({ requestId }),
    });
  } catch {
    fail('无法连接服务器验证会话，请检查网络后重试');
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务器验证会话，请检查网络后重试');
  }
  if (res.ok || res.status === 401 || res.status === 403) settleRefreshRequestId(requestId);
  return res;
}

/** Reads the body of a 401 (the caller does not need it afterwards). */
async function isSupersededRefresh(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = await readJson(res);
  return Boolean(body && typeof body === 'object'
    && (body as { code?: unknown }).code === REFRESH_SUPERSEDED);
}

/** Retry-After as delta-seconds or an HTTP date; null when absent or malformed. */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

type RotationOutcome = { token: string | null } | { retryAfterMs: number | null };

/**
 * One rotation under the cross-tab lock. A 429 is returned, not thrown, so
 * the caller waits for the retry outside the lock: other tabs are never
 * queued behind a sleeping one.
 */
async function rotateOnce(
  expectedEpoch: number,
  hadSession: boolean,
  fail: (message: string) => void,
): Promise<RotationOutcome> {
  const isCurrent = () => useAuthStore.getState().epoch === expectedEpoch;
  if (!isCurrent()) return { token: useAuthStore.getState().accessToken };
  let res = await postRefresh(fail);
  if (await isSupersededRefresh(res)) {
    // Another tab won a concurrent rotation (only possible without Web
    // Locks) and the shared cookie now holds its successor: rotate once
    // more from it with a fresh request id. Losing again is a transient
    // failure, never a logout, since the session itself is intact.
    res = await postRefresh(fail);
    if (await isSupersededRefresh(res)) {
      fail('会话正在其他标签页刷新，请重试');
      throw new ApiError(401, REFRESH_SUPERSEDED, '会话正在其他标签页刷新，请重试');
    }
  }
  if (res.status === 429) return { retryAfterMs: parseRetryAfterMs(res.headers.get('Retry-After')) };

  if (res.status === 401 || res.status === 403) {
    if (isCurrent()) {
      if (hadSession) setPendingLoginReason(res.status === 403 ? 'account-changed' : 'session-expired');
      // The cookie is shared, so every tab will reach the same answer.
      clearLocalSession(false);
    }
    return { token: null };
  }
  if (!res.ok) {
    const error = await apiErrorFromResponse(res);
    fail(error.message);
    throw error;
  }

  const payload = await readJson(res);
  if (!isAuthResponse(payload)) {
    fail('会话刷新响应无效，请重试');
    throw new ApiError(502, 'INVALID_REFRESH_RESPONSE', '会话刷新响应无效，请重试');
  }
  if (!isCurrent()) return { token: useAuthStore.getState().accessToken };
  if (shouldClearPrincipalState(useAuthStore.getState().user, payload.user)) clearPrincipalQueryState();
  useAuthStore.getState().commitRefresh(expectedEpoch, payload.accessToken, payload.user);
  return { token: payload.accessToken };
}

/**
 * Stop retrying a throttled refresh. Nothing is signed out: a tab that has a
 * user keeps its page and the request fails like any other; a tab still
 * loading shows a wait-and-retry screen instead of the session-check error.
 */
function refreshThrottled(waitMs: number, isCurrent: () => boolean): ApiError {
  refreshThrottledUntil = Math.max(refreshThrottledUntil, Date.now() + waitMs);
  const message = `会话刷新过于频繁，请 ${Math.max(1, Math.ceil(waitMs / 1_000))} 秒后重试`;
  const state = useAuthStore.getState();
  if (isCurrent() && state.status !== 'authenticated') state.markCheckThrottled(message);
  return new ApiError(429, REFRESH_RATE_LIMITED, message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function rotateWithBackoff(
  expectedEpoch: number,
  hadSession: boolean,
  fail: (message: string) => void,
): Promise<string | null> {
  const isCurrent = () => useAuthStore.getState().epoch === expectedEpoch;
  const cooldownMs = refreshThrottledUntil - Date.now();
  if (cooldownMs > 0) throw refreshThrottled(cooldownMs, isCurrent);
  for (let request = 1; ; request += 1) {
    const outcome = await withCrossTabRefreshLock(() => rotateOnce(expectedEpoch, hadSession, fail));
    if ('token' in outcome) return outcome.token;
    const waitMs = outcome.retryAfterMs ?? THROTTLED_REFRESH_BACKOFF_MS * 2 ** (request - 1);
    if (request >= MAX_THROTTLED_REFRESH_REQUESTS || waitMs > MAX_THROTTLED_REFRESH_WAIT_MS) {
      throw refreshThrottled(waitMs, isCurrent);
    }
    // Jitter so tabs throttled together do not come back in lockstep.
    await sleep(waitMs + Math.floor(Math.random() * 250));
    if (!isCurrent()) return useAuthStore.getState().accessToken;
  }
}

/**
 * Rotate the shared HttpOnly refresh cookie into a fresh access token.
 * `hadSession` distinguishes an expired session (tell the user) from a cold
 * page load with no cookie at all (just show the login page).
 */
async function tryRefresh(hadSession = true): Promise<string | null> {
  const expectedEpoch = useAuthStore.getState().epoch;
  if (refreshAttempt) {
    if (refreshAttempt.epoch === expectedEpoch) return refreshAttempt.promise;
    // An attempt from an older principal/session must never be reused for the
    // current one. Let it settle, then refresh for the latest state.
    try {
      await refreshAttempt.promise;
    } catch {
      // The old session's failure does not decide the new session's outcome.
    }
    return tryRefresh(hadSession);
  }

  const fail = (message: string) => {
    if (useAuthStore.getState().epoch === expectedEpoch) useAuthStore.getState().markCheckFailed(message);
  };
  const work = rotateWithBackoff(expectedEpoch, hadSession, fail);
  const guarded = work.catch((error: unknown) => {
    if (error instanceof AuthSessionCoordinationError) {
      fail(error.message);
      throw new ApiError(0, 'AUTH_COORDINATION_UNAVAILABLE', error.message);
    }
    throw error;
  });
  const promise = guarded.finally(() => {
    if (refreshAttempt?.promise === promise) refreshAttempt = null;
  });
  refreshAttempt = { epoch: expectedEpoch, promise };
  return promise;
}

/**
 * An access token newer than `previous`, for a connection that must present a
 * fresh one before `previous` expires (the container console): the store's if
 * another request already refreshed it, otherwise a forced rotation. Null when
 * the session cannot be refreshed; the caller lets its connection lapse.
 */
export async function freshAccessToken(previous: string | null): Promise<string | null> {
  const current = useAuthStore.getState().accessToken;
  if (current && current !== previous) return current;
  try {
    return await tryRefresh();
  } catch {
    return null;
  }
}

/** Waits between attempts at a token for a console re-authentication prompt. */
const FRESH_TOKEN_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/**
 * The console bridge prompts at most this long before the console's deadline
 * and closes it there; past it a token can no longer help.
 */
const FRESH_TOKEN_DEADLINE_MS = 60_000;

/**
 * `freshAccessToken` for a re-authentication prompt, tried again with bounded
 * backoff while `wanted()` holds (the console is still open): a refresh that
 * failed for a network blip, or a rate limit past its own backoff, must not
 * let the console lapse while its deadline leaves time. Null once the socket
 * closed or the deadline has certainly passed.
 */
export async function freshAccessTokenWithRetry(
  previous: string | null,
  wanted: () => boolean,
  options: {
    fetchToken?: (previous: string | null) => Promise<string | null>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<string | null> {
  const fetchToken = options.fetchToken ?? freshAccessToken;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const now = options.now ?? Date.now;
  const giveUpAt = now() + FRESH_TOKEN_DEADLINE_MS;
  for (let attempt = 0; ; attempt += 1) {
    if (!wanted()) return null;
    const token = await fetchToken(previous);
    if (token) return token;
    const delayMs = FRESH_TOKEN_RETRY_DELAYS_MS[Math.min(attempt, FRESH_TOKEN_RETRY_DELAYS_MS.length - 1)]!;
    if (now() + delayMs >= giveUpAt) return null;
    await sleep(delayMs);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const requestSession = useAuthStore.getState();
  const requestEpoch = requestSession.epoch;
  const token = requestSession.accessToken;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务器，请检查网络后重试');
  }

  const neverRefresh = path === '/auth/refresh' || path === '/auth/login' || path === '/auth/logout';
  if (res.status === 401 && retry && !neverRefresh) {
    if (useAuthStore.getState().epoch !== requestEpoch) {
      throw new ApiError(401, 'SESSION_CHANGED', '会话已切换，本次请求未自动重试，请重新执行操作');
    }
    // A request sent without a token never had a session to expire.
    const newToken = await tryRefresh(token !== null);
    if (newToken) {
      if (useAuthStore.getState().epoch !== requestEpoch) {
        throw new ApiError(401, 'SESSION_CHANGED', '会话已切换，本次请求未自动重试，请重新执行操作');
      }
      return request<T>(path, options, false);
    }
    throw new ApiError(401, 'UNAUTHORIZED', '会话已过期，请重新登录');
  }

  if (!res.ok) throw await apiErrorFromResponse(res);
  const text = res.status === 204 || res.status === 205 ? '' : await res.text();
  return parseSuccessfulResponseBody<T>(res.status, text);
}

/** Empty 200/204 is a valid void result; only malformed JSON is INVALID_RESPONSE. */
export function parseSuccessfulResponseBody<T>(status: number, text: string): T {
  if (status === 204 || status === 205) return undefined as T;
  const trimmed = text.trim();
  if (trimmed === '') return undefined as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new ApiError(502, 'INVALID_RESPONSE', '服务器响应格式无效，请稍后重试');
  }
}

async function login(body: unknown): Promise<void> {
  const response = await request<LoginResponse>(
    '/auth/login',
    { method: 'POST', headers: AUTH_INTENT_HEADERS, body: JSON.stringify(body) },
  );
  if (!isAuthResponse(response)) {
    throw new ApiError(502, 'INVALID_RESPONSE', '服务器响应格式无效，请稍后重试');
  }
  discardPendingRefreshRequestId();
  // A new login is a new session with no rotation history.
  refreshThrottledUntil = 0;
  clearPrincipalQueryState();
  useAuthStore.getState().setAuth(response.accessToken, response.user);
  announceLogin();
}

/**
 * Another tab logged in, possibly as someone else. This tab's access token
 * still names the old principal, so drop it and re-derive from the cookie.
 */
export function adoptPeerSession(): Promise<void> {
  refreshThrottledUntil = 0;
  clearPrincipalQueryState();
  useAuthStore.setState((state) => ({
    accessToken: null,
    user: null,
    epoch: state.epoch + 1,
    status: 'checking',
    authError: null,
  }));
  return bootstrapAuthSession();
}

async function runBootstrap(): Promise<void> {
  const initial = useAuthStore.getState();
  if (!initial.accessToken) {
    // Cold load or after a peer login: only the HttpOnly cookie can tell.
    if (initial.status !== 'checking' && initial.status !== 'error' && initial.status !== 'throttled') return;
    // A throttled tab keeps its wait screen while it retries.
    if (initial.status !== 'throttled') initial.markChecking();
    try {
      await tryRefresh(initial.user !== null);
    } catch {
      // tryRefresh already moved the store to its error state.
    }
    return;
  }

  // Revalidate the in-memory principal (the role may have changed).
  const expectedEpoch = initial.epoch;
  const expectedAccessToken = initial.accessToken;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/auth/me`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${expectedAccessToken}` },
    });
  } catch {
    const current = useAuthStore.getState();
    if (current.epoch === expectedEpoch && current.accessToken === expectedAccessToken) {
      current.markCheckFailed('无法连接服务器验证会话，请检查网络后重试');
    }
    return;
  }
  const isCurrent = () => {
    const current = useAuthStore.getState();
    return current.epoch === expectedEpoch && current.accessToken === expectedAccessToken;
  };

  if (res.ok) {
    const user = await readJson(res);
    if (!isRuntimeUserDto(user)) {
      if (isCurrent()) useAuthStore.getState().markCheckFailed('账号权限响应无效，请稍后重试');
      return;
    }
    if (!isCurrent()) return;
    if (shouldClearPrincipalState(useAuthStore.getState().user, user)) clearPrincipalQueryState();
    useAuthStore.getState().commitCurrentUser(expectedEpoch, expectedAccessToken, user);
    return;
  }
  if (res.status === 401) {
    if (!isCurrent()) return;
    try {
      await tryRefresh();
    } catch {
      // tryRefresh already moved the store to its error state.
    }
    return;
  }
  if (res.status === 403) {
    if (isCurrent()) {
      setPendingLoginReason('account-changed');
      clearLocalSession();
    }
    return;
  }
  const error = await apiErrorFromResponse(res);
  if (isCurrent()) useAuthStore.getState().markCheckFailed(error.message);
}

/** Recover the session from the refresh cookie and refresh the current user's role snapshot. */
export function bootstrapAuthSession(): Promise<void> {
  if (bootstrapPromise) {
    bootstrapQueued = true;
    return bootstrapPromise;
  }
  bootstrapPromise = (async () => {
    do {
      bootstrapQueued = false;
      await runBootstrap();
    } while (bootstrapQueued);
  })().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

/** Revoke the cookie's server session; the browser drops the cookie from the response. */
async function logout(session: CapturedSession): Promise<void> {
  const headers: Record<string, string> = { ...AUTH_INTENT_HEADERS };
  if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  try {
    await fetch(`${BASE_URL}/auth/logout`, { method: 'POST', headers, credentials: 'same-origin' });
  } catch {
    // Local logout is authoritative for the browser; server cleanup is best effort.
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  login,
  logout,
};

export { ApiError, apiErrorCurrent } from './api-error.js';
