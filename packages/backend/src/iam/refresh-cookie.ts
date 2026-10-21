import { ForbiddenException } from '@nestjs/common';

export const REFRESH_COOKIE_NAME = 'nyabase_refresh';
/** Scope the refresh secret to the endpoints that consume it. */
export const REFRESH_COOKIE_PATH = '/api/auth';
/**
 * Browsers cannot attach a custom header to a cross-site request without a
 * CORS preflight, which the Backend denies for foreign origins. Requiring it
 * on every cookie-reading or cookie-setting endpoint (including login, which
 * would otherwise accept a cross-site urlencoded form) closes CSRF without
 * relying on SameSite alone.
 */
export const AUTH_INTENT_HEADER = 'x-nyabase-auth';

export interface CookieRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): unknown;
  clearCookie(name: string, options: Record<string, unknown>): unknown;
}

export function requireAuthIntent(request: CookieRequest): void {
  if (request.headers[AUTH_INTENT_HEADER] !== '1') {
    throw new ForbiddenException({
      code: 'AUTH_INTENT_REQUIRED',
      message: `${AUTH_INTENT_HEADER}: 1 header is required`,
    });
  }
}

export function readRefreshCookie(request: CookieRequest): string | null {
  const header = request.headers.cookie;
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== REFRESH_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    // Issued tokens are URL-safe; anything else was not set by this Backend.
    return /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : null;
  }
  return null;
}

function cookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: 'strict', path: REFRESH_COOKIE_PATH } as const;
}

export function setRefreshCookie(
  response: CookieResponse,
  token: string,
  options: { secure: boolean; maxAgeMs: number },
): void {
  response.cookie(REFRESH_COOKIE_NAME, token, { ...cookieOptions(options.secure), maxAge: options.maxAgeMs });
}

export function clearRefreshCookie(response: CookieResponse, secure: boolean): void {
  response.clearCookie(REFRESH_COOKIE_NAME, cookieOptions(secure));
}
