import { useAuthStore } from '../store/auth.js';

const BASE_URL = '/api';

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Prevent multiple simultaneous refresh attempts
let refreshPromise: Promise<string | null> | null = null;

async function tryRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { refreshToken, setAuth, clearAuth } = useAuthStore.getState();
    if (!refreshToken) {
      clearAuth();
      return null;
    }
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        clearAuth();
        window.location.href = '/login';
        return null;
      }
      const data = await res.json() as { accessToken: string; refreshToken: string };
      // Preserve current user object, just update tokens
      const currentUser = useAuthStore.getState().user;
      if (currentUser) {
        setAuth(data.accessToken, data.refreshToken, currentUser);
      }
      return data.accessToken;
    } catch {
      clearAuth();
      window.location.href = '/login';
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  // Token expired — try to refresh once then retry
  if (res.status === 401 && retry && path !== '/auth/refresh' && path !== '/auth/login') {
    const newToken = await tryRefresh();
    if (newToken) {
      return request<T>(path, options, false);
    }
    // refresh failed, clearAuth already called in tryRefresh
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired, please log in again');
  }

  if (!res.ok) {
    let errBody: { code?: string; message?: string } = {};
    try {
      errBody = await res.json();
    } catch {}
    // 5xx errors expose implementation details; show a generic friendly message instead
    const message = res.status >= 500
      ? '服务器内部错误，请稍后重试'
      : (errBody.message ?? res.statusText);
    throw new ApiError(res.status, errBody.code ?? 'UNKNOWN', message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
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
};

export { ApiError };
