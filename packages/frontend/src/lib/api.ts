import type { LoginResponse, UserDto } from '@nyabase/common';
import { useAuthStore } from '../store/auth.js';
import { ApiError } from './api-error.js';
import {
  clearLocalSession,
  adoptPersistedSessionIfChanged,
  AuthSessionCoordinationError,
  commitFreshCurrentUser,
  commitRefreshedSession,
  commitRefreshPendingUser,
  createRefreshRequestId,
  installLoginSession,
  prepareLoginSession,
  type CapturedSession,
  ensureAuthoritativeSessionRecord,
  withCrossTabRefreshLock,
} from './auth-session.js';

const BASE_URL = '/api';

type RefreshResponse = {
  accessToken: string;
  refreshToken: string;
  user?: UserDto;
};

let refreshAttempt: {
  epoch: number;
  refreshToken: string;
  promise: Promise<string | null>;
} | null = null;
let bootstrapPromise: Promise<void> | null = null;
let bootstrapQueued = false;

function isCapturedSessionCurrent(epoch: number, refreshToken: string, refreshRequestId: string): boolean {
  const current = useAuthStore.getState();
  return current.epoch === epoch && current.refreshToken === refreshToken
    && current.refreshRequestId === refreshRequestId;
}

function isUserDto(value: unknown): value is UserDto {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UserDto>;
  return typeof candidate.id === 'string'
    && typeof candidate.username === 'string'
    && typeof candidate.displayName === 'string'
    && typeof candidate.status === 'string'
    && typeof candidate.createdAt === 'string'
    && Array.isArray(candidate.capabilities)
    && candidate.capabilities.every((capability) => typeof capability === 'string')
    && Array.isArray(candidate.groups);
}

function isRefreshResponse(value: unknown): value is RefreshResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RefreshResponse>;
  return typeof candidate.accessToken === 'string'
    && candidate.accessToken.length > 0
    && typeof candidate.refreshToken === 'string'
    && candidate.refreshToken.length > 0;
}

async function installIssuedRefreshSession(
  issuedSession: CapturedSession,
  previousRefreshToken: string,
  install: () => boolean,
): Promise<boolean> {
  const abandonIfNotAdopted = async () => {
    const current = useAuthStore.getState();
    if (current.refreshToken === issuedSession.refreshToken) return;
    if (current.refreshToken === previousRefreshToken) clearLocalSession();
    await logout(issuedSession);
  };
  try {
    const installed = install();
    if (!installed) await abandonIfNotAdopted();
    return installed;
  } catch (error) {
    await abandonIfNotAdopted();
    throw error;
  }
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

async function fetchCurrentUser(accessToken: string): Promise<Response> {
  return fetch(`${BASE_URL}/auth/me`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

async function tryRefresh(): Promise<string | null> {
  const captured = useAuthStore.getState();
  const expectedEpoch = captured.epoch;
  const expectedRefreshToken = captured.refreshToken;
  if (!expectedRefreshToken) {
    if (captured.status !== 'anonymous') clearLocalSession();
    return null;
  }

  if (refreshAttempt) {
    if (refreshAttempt.epoch === expectedEpoch && refreshAttempt.refreshToken === expectedRefreshToken) {
      return refreshAttempt.promise;
    }
    // An attempt from an older principal/session must never be reused for the
    // current one. Let it settle, then capture and refresh the latest state.
    try {
      await refreshAttempt.promise;
    } catch {
      // The old session's failure does not decide the new session's outcome.
    }
    return tryRefresh();
  }

  const work = withCrossTabRefreshLock(async (ownsLock) => {
    ensureAuthoritativeSessionRecord();
    adoptPersistedSessionIfChanged(expectedRefreshToken);
    const currentAfterLock = useAuthStore.getState();
    if (currentAfterLock.epoch !== expectedEpoch || currentAfterLock.refreshToken !== expectedRefreshToken) {
      return currentAfterLock.accessToken;
    }
    const expectedRefreshRequestId = currentAfterLock.refreshRequestId;
    if (!expectedRefreshRequestId) throw new AuthSessionCoordinationError();
    if (!ownsLock()) throw new ApiError(0, 'REFRESH_LOCK_LOST', '会话刷新协调已变化，请重试');

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: expectedRefreshToken,
          requestId: expectedRefreshRequestId,
        }),
      });
    } catch {
      adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
      const latest = useAuthStore.getState();
      if (latest.epoch !== expectedEpoch || latest.refreshToken !== expectedRefreshToken) {
        return latest.accessToken;
      }
      if (isCapturedSessionCurrent(expectedEpoch, expectedRefreshToken, expectedRefreshRequestId)) {
        useAuthStore.getState().markCheckFailed('无法连接服务器验证会话，请检查网络后重试');
      }
      throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务器验证会话，请检查网络后重试');
    }

    const ownsRefreshLeaseAfterResponse = ownsLock();
    if (!ownsRefreshLeaseAfterResponse && !res.ok) {
      adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
      const latest = useAuthStore.getState();
      if (latest.epoch !== expectedEpoch || latest.refreshToken !== expectedRefreshToken) return latest.accessToken;
      throw new ApiError(0, 'REFRESH_LOCK_LOST', '会话刷新协调已变化，请重试');
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
        const latest = useAuthStore.getState();
        if (latest.epoch !== expectedEpoch || latest.refreshToken !== expectedRefreshToken) {
          return latest.accessToken;
        }
        if (isCapturedSessionCurrent(expectedEpoch, expectedRefreshToken, expectedRefreshRequestId)) clearLocalSession();
        return null;
      }
      const error = await apiErrorFromResponse(res);
      adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
      const latest = useAuthStore.getState();
      if (latest.epoch !== expectedEpoch || latest.refreshToken !== expectedRefreshToken) return latest.accessToken;
      if (isCapturedSessionCurrent(expectedEpoch, expectedRefreshToken, expectedRefreshRequestId)) {
        useAuthStore.getState().markCheckFailed(error.message);
      }
      throw error;
    }

    let refreshPayload: unknown;
    try {
      refreshPayload = await res.json();
    } catch {
      refreshPayload = null;
    }
    if (!isRefreshResponse(refreshPayload)) {
      adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
      const latest = useAuthStore.getState();
      if (latest.epoch !== expectedEpoch || latest.refreshToken !== expectedRefreshToken) return latest.accessToken;
      if (!ownsRefreshLeaseAfterResponse) {
        throw new ApiError(0, 'REFRESH_LOCK_LOST', '会话刷新协调已变化，请重试');
      }
      if (isCapturedSessionCurrent(expectedEpoch, expectedRefreshToken, expectedRefreshRequestId)) {
        useAuthStore.getState().markCheckFailed('会话刷新响应无效；将使用同一恢复请求重试');
      }
      throw new ApiError(502, 'INVALID_REFRESH_RESPONSE', '会话刷新响应无效，请重试');
    }
    const data = refreshPayload;
    // Generate the idempotency identity for the successor only after the
    // backend has returned that successor. If WebCrypto fails, the old
    // token/requestId pair remains intact and can recover the same response.
    const nextRefreshRequestId = createRefreshRequestId();

    let freshUser = isUserDto(data.user) ? data.user : undefined;
    if (!freshUser) {
      let meResponse: Response;
      try {
        meResponse = await fetchCurrentUser(data.accessToken);
      } catch {
        adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
        const latest = useAuthStore.getState();
        if (latest.epoch !== expectedEpoch || latest.refreshToken !== expectedRefreshToken) return latest.accessToken;
        await installIssuedRefreshSession(
          { accessToken: data.accessToken, refreshToken: data.refreshToken },
          expectedRefreshToken,
          () => commitRefreshPendingUser(
            expectedEpoch,
            expectedRefreshToken,
            expectedRefreshRequestId,
            data.accessToken,
            data.refreshToken,
            nextRefreshRequestId,
            '会话已刷新，但无法获取最新账号权限，请重试',
          ),
        );
        throw new ApiError(0, 'NETWORK_ERROR', '会话已刷新，但无法获取最新账号权限，请重试');
      }
      if (!meResponse.ok) {
        if (meResponse.status === 401 || meResponse.status === 403) {
          adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
          const latest = useAuthStore.getState();
          if (latest.epoch !== expectedEpoch || latest.refreshToken !== expectedRefreshToken) return latest.accessToken;
          if (isCapturedSessionCurrent(expectedEpoch, expectedRefreshToken, expectedRefreshRequestId)) {
            clearLocalSession();
            await logout({ accessToken: data.accessToken, refreshToken: data.refreshToken });
          }
          return null;
        }
        const error = await apiErrorFromResponse(meResponse);
        adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
        const latest = useAuthStore.getState();
        if (latest.epoch !== expectedEpoch || latest.refreshToken !== expectedRefreshToken) return latest.accessToken;
        await installIssuedRefreshSession(
          { accessToken: data.accessToken, refreshToken: data.refreshToken },
          expectedRefreshToken,
          () => commitRefreshPendingUser(
            expectedEpoch,
            expectedRefreshToken,
            expectedRefreshRequestId,
            data.accessToken,
            data.refreshToken,
            nextRefreshRequestId,
            error.message,
          ),
        );
        throw error;
      }
      let currentUserPayload: unknown;
      try {
        currentUserPayload = await meResponse.json();
      } catch {
        currentUserPayload = null;
      }
      if (!isUserDto(currentUserPayload)) {
        adoptPersistedSessionIfChanged(expectedRefreshToken, expectedRefreshRequestId);
        const latest = useAuthStore.getState();
        if (latest.epoch !== expectedEpoch || latest.refreshToken !== expectedRefreshToken) return latest.accessToken;
        await installIssuedRefreshSession(
          { accessToken: data.accessToken, refreshToken: data.refreshToken },
          expectedRefreshToken,
          () => commitRefreshPendingUser(
            expectedEpoch,
            expectedRefreshToken,
            expectedRefreshRequestId,
            data.accessToken,
            data.refreshToken,
            nextRefreshRequestId,
            '会话已刷新，但账号权限响应无效，请重试',
          ),
        );
        throw new ApiError(502, 'INVALID_CURRENT_USER_RESPONSE', '会话已刷新，但账号权限响应无效，请重试');
      }
      freshUser = currentUserPayload;
    }

    // A successful rotation is itself a fencing result: the backend permits
    // only one winner for R1. Even if a throttled fallback lease expired while
    // the request was in flight, persist that unique R2; every competing R1
    // request will fail and synchronously adopt this successor. The commit
    // still re-reads the authoritative login/logout record immediately before
    // writing, so an explicit newer session transition wins.
    const committed = await installIssuedRefreshSession(
      { accessToken: data.accessToken, refreshToken: data.refreshToken },
      expectedRefreshToken,
      () => commitRefreshedSession(
        expectedEpoch,
        expectedRefreshToken,
        expectedRefreshRequestId,
        data.accessToken,
        data.refreshToken,
        nextRefreshRequestId,
        freshUser,
      ),
    );
    return committed ? data.accessToken : useAuthStore.getState().accessToken;
  });
  const guardedWork = work.catch((error: unknown) => {
    if (error instanceof AuthSessionCoordinationError) {
      const current = useAuthStore.getState();
      if (current.epoch === expectedEpoch && current.status !== 'anonymous') current.markCheckFailed(error.message);
      throw new ApiError(0, 'AUTH_COORDINATION_UNAVAILABLE', error.message);
    }
    throw error;
  });
  const promise = guardedWork.finally(() => {
    if (refreshAttempt?.promise === promise) refreshAttempt = null;
  });
  refreshAttempt = { epoch: expectedEpoch, refreshToken: expectedRefreshToken, promise };

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
    const newToken = await tryRefresh();
    if (newToken) {
      if (useAuthStore.getState().epoch !== requestEpoch) {
        throw new ApiError(401, 'SESSION_CHANGED', '会话已切换，本次请求未自动重试，请重新执行操作');
      }
      return request<T>(path, options, false);
    }
    throw new ApiError(401, 'UNAUTHORIZED', '会话已过期，请重新登录');
  }

  if (!res.ok) throw await apiErrorFromResponse(res);
  if (res.status === 204) return undefined as T;
  try {
    return await res.json() as T;
  } catch {
    throw new ApiError(502, 'INVALID_RESPONSE', '服务器响应格式无效，请稍后重试');
  }
}

async function login(body: unknown): Promise<void> {
  // This round-trip proof happens before the request can mint a server-side
  // refresh session.  Generating a random id alone does not prove storage is
  // usable.
  const refreshRequestId = prepareLoginSession();
  const response = await request<LoginResponse>(
    '/auth/login',
    { method: 'POST', body: JSON.stringify(body) },
  );
  const issuedSession: CapturedSession = {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
  };
  try {
    installLoginSession(
      response.accessToken,
      response.refreshToken,
      response.user,
      refreshRequestId,
    );
  } catch (error) {
    // The server session exists at this point.  Never leave it orphaned merely
    // because the browser failed to install/broadcast it.
    await logout(issuedSession);
    throw error;
  }
}

async function runBootstrap(): Promise<void> {
  let initial = useAuthStore.getState();
  if (initial.accessToken || initial.refreshToken) {
    try {
      ensureAuthoritativeSessionRecord();
    } catch (error) {
      if (error instanceof AuthSessionCoordinationError) initial.markCheckFailed(error.message);
      else throw error;
      return;
    }
    initial = useAuthStore.getState();
  }
  if (!initial.accessToken) {
    if (initial.refreshToken) {
      await tryRefresh();
    } else if (initial.status !== 'anonymous') {
      clearLocalSession(false);
    }
    return;
  }

  const expectedEpoch = initial.epoch;
  const expectedAccessToken = initial.accessToken;
  if (initial.status !== 'authenticated') initial.markChecking();

  let res: Response;
  try {
    res = await fetchCurrentUser(expectedAccessToken);
  } catch {
    const current = useAuthStore.getState();
    if (current.epoch === expectedEpoch && current.accessToken === expectedAccessToken) {
      current.markCheckFailed('无法连接服务器验证会话，请检查网络后重试');
    }
    return;
  }

  if (res.ok) {
    let currentUserPayload: unknown;
    try {
      currentUserPayload = await res.json();
    } catch {
      currentUserPayload = null;
    }
    if (!isUserDto(currentUserPayload)) {
      const current = useAuthStore.getState();
      if (current.epoch === expectedEpoch && current.accessToken === expectedAccessToken) {
        current.markCheckFailed('账号权限响应无效，请稍后重试');
      }
      return;
    }
    const user = currentUserPayload;
    const committed = commitFreshCurrentUser(expectedEpoch, expectedAccessToken, user);
    if (!committed) {
      const current = useAuthStore.getState();
      if (current.epoch === expectedEpoch && current.accessToken === expectedAccessToken) {
        current.markCheckFailed('会话协调状态已变化，请重试');
      }
    }
    return;
  }
  if (res.status === 401) {
    const current = useAuthStore.getState();
    if (current.epoch !== expectedEpoch || current.accessToken !== expectedAccessToken) return;
    await tryRefresh();
    return;
  }
  if (res.status === 403) {
    const current = useAuthStore.getState();
    if (current.epoch === expectedEpoch && current.accessToken === expectedAccessToken) clearLocalSession();
    return;
  }
  const error = await apiErrorFromResponse(res);
  const current = useAuthStore.getState();
  if (current.epoch === expectedEpoch && current.accessToken === expectedAccessToken) {
    current.markCheckFailed(error.message);
  }
}

/** Bootstrap persisted auth and refresh the current user's capability snapshot. */
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

async function logout(session: CapturedSession): Promise<void> {
  if (!session.refreshToken) return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  try {
    await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
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
export const authApiTestables = { tryRefresh, login };
