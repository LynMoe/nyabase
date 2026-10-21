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

let refreshAttempt: { epoch: number; promise: Promise<string | null> } | null = null;
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

  const isCurrent = () => useAuthStore.getState().epoch === expectedEpoch;
  const fail = (message: string) => {
    if (isCurrent()) useAuthStore.getState().markCheckFailed(message);
  };

  const work = withCrossTabRefreshLock(async () => {
    if (!isCurrent()) return useAuthStore.getState().accessToken;
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
      // Keep the request id: a retry recovers the same successor if the
      // server rotated but the response was lost.
      fail('无法连接服务器验证会话，请检查网络后重试');
      throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务器验证会话，请检查网络后重试');
    }

    if (res.status === 401 || res.status === 403) {
      settleRefreshRequestId(requestId);
      if (isCurrent()) {
        if (hadSession) setPendingLoginReason(res.status === 403 ? 'account-changed' : 'session-expired');
        // The cookie is shared, so every tab will reach the same answer.
        clearLocalSession(false);
      }
      return null;
    }
    if (!res.ok) {
      const error = await apiErrorFromResponse(res);
      fail(error.message);
      throw error;
    }

    settleRefreshRequestId(requestId);
    const payload = await readJson(res);
    if (!isAuthResponse(payload)) {
      fail('会话刷新响应无效，请重试');
      throw new ApiError(502, 'INVALID_REFRESH_RESPONSE', '会话刷新响应无效，请重试');
    }
    if (!isCurrent()) return useAuthStore.getState().accessToken;
    if (shouldClearPrincipalState(useAuthStore.getState().user, payload.user)) clearPrincipalQueryState();
    useAuthStore.getState().commitRefresh(expectedEpoch, payload.accessToken, payload.user);
    return payload.accessToken;
  });
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
  clearPrincipalQueryState();
  useAuthStore.getState().setAuth(response.accessToken, response.user);
  announceLogin();
}

/**
 * Another tab logged in, possibly as someone else. This tab's access token
 * still names the old principal, so drop it and re-derive from the cookie.
 */
export function adoptPeerSession(): Promise<void> {
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
    if (initial.status !== 'checking' && initial.status !== 'error') return;
    initial.markChecking();
    try {
      await tryRefresh(initial.user !== null);
    } catch {
      // tryRefresh already moved the store to its error state.
    }
    return;
  }

  // Revalidate the in-memory principal (capabilities may have changed).
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

/** Recover the session from the refresh cookie and refresh the current user's capability snapshot. */
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
