import { randomBytes } from 'node:crypto';
import type { LoginResponse } from '@nyabase/common';

/** A non-2xx API answer. `code` is the backend failure code when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`${method} ${path} -> ${status} ${JSON.stringify(body)}`);
  }

  get code(): string | undefined {
    const code = (this.body as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  }
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra headers (e.g. the cookie of the refresh flow). */
  headers?: Record<string, string>;
}

/**
 * Thin typed client over fetch. Every method takes the response type as a type
 * argument, taken from `@nyabase/common`, so drift against the backend DTOs
 * fails the typecheck instead of the live run.
 */
export class Api {
  constructor(
    readonly baseUrl: string,
    private token: string | null = null,
  ) {}

  withToken(token: string | null): Api {
    return new Api(this.baseUrl, token);
  }

  async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(`${this.baseUrl}/api${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      // Required by the cookie-setting auth endpoints, ignored elsewhere.
      'x-nyabase-auth': '1',
      ...options.headers,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(60_000),
    });
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(method, path, options);
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) throw new ApiError(response.status, method, path, parsed);
    return parsed as T;
  }

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  delete<T = void>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('DELETE', path, { query });
  }

  /** Resolves with the HTTP status of the call; never throws on 4xx/5xx. */
  async status(method: string, path: string, body?: unknown): Promise<number> {
    const response = await this.raw(method, path, { body });
    await response.arrayBuffer();
    return response.status;
  }
}

/** `__Host-` with Secure cookies; the lab runs with `AUTH_COOKIE_SECURE=false`. */
const REFRESH_COOKIE = /^(__Host-)?nyabase_refresh=/;

export interface Session {
  api: Api;
  user: LoginResponse['user'];
  accessToken: string;
  /** `[__Host-]nyabase_refresh=<secret>`, the only cookie the refresh flow needs. */
  refreshCookie: string | null;
}

export async function login(baseUrl: string, username: string, password: string): Promise<Session> {
  const anonymous = new Api(baseUrl);
  const response = await anonymous.raw('POST', '/auth/login', { body: { username, password } });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, 'POST', '/auth/login', text ? JSON.parse(text) : undefined);
  }
  const body = JSON.parse(text) as LoginResponse;
  const cookie = response.headers.getSetCookie()
    .map((entry) => entry.split(';')[0]!)
    .find((entry) => REFRESH_COOKIE.test(entry)) ?? null;
  return {
    api: anonymous.withToken(body.accessToken),
    user: body.user,
    accessToken: body.accessToken,
    refreshCookie: cookie,
  };
}

/** Rotates the refresh cookie; `requestId` is the 64-hex idempotency key. */
export async function refresh(baseUrl: string, cookie: string): Promise<{
  accessToken: string;
  user: LoginResponse['user'];
  refreshCookie: string | null;
}> {
  const anonymous = new Api(baseUrl);
  const response = await anonymous.raw('POST', '/auth/refresh', {
    body: { requestId: randomBytes(32).toString('hex') },
    headers: { cookie },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, 'POST', '/auth/refresh', text ? JSON.parse(text) : undefined);
  }
  const body = JSON.parse(text) as LoginResponse;
  const next = response.headers.getSetCookie()
    .map((entry) => entry.split(';')[0]!)
    .find((entry) => REFRESH_COOKIE.test(entry)) ?? null;
  return { accessToken: body.accessToken, user: body.user, refreshCookie: next };
}
