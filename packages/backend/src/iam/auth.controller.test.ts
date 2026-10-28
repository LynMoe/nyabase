import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthController,
  readRefreshCookie,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  SECURE_REFRESH_COOKIE_NAME,
} from './auth.controller.js';
import { RefreshSupersededException, RefreshThrottledException } from './auth.service.js';

const REQUEST_ID = 'a'.repeat(64);
const user = {
  id: 'user-1',
  username: 'alice',
  displayName: 'Alice',
  status: 'active',
  role: 'user_admin',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function harness(options: { cookieSecure?: boolean } = {}) {
  const auth = {
    authenticateAndLogin: vi.fn(async () => ({ user, accessToken: 'access-1', refreshToken: 'r1' })),
    refreshTokens: vi.fn(async () => ({
      accessToken: 'access-2', refreshToken: 'r2', user, cookieMaxAgeMs: 2 * 86_400_000,
    })),
    logout: vi.fn(async () => 'user-1'),
    refreshCookieMaxAgeMs: vi.fn(() => 7 * 86_400_000),
  };
  const config = { get: vi.fn(() => options.cookieSecure ?? true) };
  const controller = new AuthController(auth as never, config as never);
  const response = { cookie: vi.fn(), clearCookie: vi.fn(), setHeader: vi.fn() };
  return { auth, controller, response };
}

function request(headers: Record<string, string> = {}) {
  return { headers: { 'x-nyabase-auth': '1', ...headers }, ip: '10.0.0.1' };
}

describe('AuthController refresh cookie transport', () => {
  it('sets the refresh secret only as a __Host- HttpOnly cookie on login', async () => {
    const { controller, response } = harness();
    const body = await controller.login({ username: 'alice', password: 'pw' }, request(), response);

    expect(body).not.toHaveProperty('refreshToken');
    expect(body.accessToken).toBe('access-1');
    expect(body.user).toMatchObject({ role: 'user_admin' });
    expect(body.user).not.toHaveProperty('capabilities');
    expect(response.cookie).toHaveBeenCalledWith(SECURE_REFRESH_COOKIE_NAME, 'r1', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 86_400_000,
    });
  });

  it('honors auth.cookieSecure=false for plain-HTTP development', async () => {
    const { controller, response } = harness({ cookieSecure: false });
    await controller.login({ username: 'alice', password: 'pw' }, request(), response);
    expect(response.cookie.mock.calls[0][0]).toBe(REFRESH_COOKIE_NAME);
    expect(response.cookie.mock.calls[0][2]).toMatchObject({ secure: false, httpOnly: true, path: REFRESH_COOKIE_PATH });
  });

  it('rotates from the cookie and returns the user without the successor secret', async () => {
    const { auth, controller, response } = harness();
    const body = await controller.refresh(
      { requestId: REQUEST_ID },
      request({ cookie: `other=x; ${SECURE_REFRESH_COOKIE_NAME}=r1` }),
      response,
    );

    expect(auth.refreshTokens).toHaveBeenCalledWith('r1', REQUEST_ID);
    expect(body).toEqual({ accessToken: 'access-2', user: expect.objectContaining({ id: 'user-1' }) });
    // The cookie lives exactly as long as what is left of the session.
    expect(response.cookie).toHaveBeenCalledWith(SECURE_REFRESH_COOKIE_NAME, 'r2', expect.objectContaining({
      httpOnly: true,
      maxAge: 2 * 86_400_000,
    }));
  });

  it('rejects refresh without a cookie and clears a rejected cookie', async () => {
    const { auth, controller, response } = harness();
    await expect(controller.refresh({ requestId: REQUEST_ID }, request(), response))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.refreshTokens).not.toHaveBeenCalled();

    auth.refreshTokens.mockRejectedValueOnce(new UnauthorizedException('Invalid refresh token'));
    await expect(controller.refresh(
      { requestId: REQUEST_ID },
      request({ cookie: `${SECURE_REFRESH_COOKIE_NAME}=stale` }),
      response,
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(response.clearCookie).toHaveBeenCalledWith(SECURE_REFRESH_COOKIE_NAME, expect.objectContaining({ path: '/' }));
  });

  it('keeps the cookie and sends Retry-After when refresh is throttled', async () => {
    const { auth, controller, response } = harness();
    auth.refreshTokens.mockRejectedValueOnce(new RefreshThrottledException(41_200));
    await expect(controller.refresh(
      { requestId: REQUEST_ID },
      request({ cookie: `${SECURE_REFRESH_COOKIE_NAME}=r1` }),
      response,
    )).rejects.toMatchObject({ status: 429, response: { code: 'AUTH_RATE_LIMITED' } });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(response.clearCookie).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('keeps the cookie when a concurrent rotation already replaced it', async () => {
    const { auth, controller, response } = harness();
    auth.refreshTokens.mockRejectedValueOnce(new RefreshSupersededException());
    await expect(controller.refresh(
      { requestId: REQUEST_ID },
      request({ cookie: `${SECURE_REFRESH_COOKIE_NAME}=r1` }),
      response,
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(response.clearCookie).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it('rejects the legacy body-borne refresh token', async () => {
    const { controller, response } = harness();
    await expect(controller.refresh(
      { refreshToken: 'r1', requestId: REQUEST_ID },
      request({ cookie: `${SECURE_REFRESH_COOKIE_NAME}=r1` }),
      response,
    )).rejects.toThrow();
  });

  it('revokes the cookie session and clears the cookie on logout', async () => {
    const { auth, controller, response } = harness();
    await controller.logout(request({ cookie: `${SECURE_REFRESH_COOKIE_NAME}=r1` }), response);
    expect(auth.logout).toHaveBeenCalledWith('r1');
    expect(response.clearCookie).toHaveBeenCalled();

    auth.logout.mockClear();
    await controller.logout(request(), response);
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('requires the auth intent header on every cookie endpoint', async () => {
    const { auth, controller, response } = harness();
    const crossSite = { headers: { cookie: `${SECURE_REFRESH_COOKIE_NAME}=r1` }, ip: '10.0.0.1' };
    await expect(controller.login({ username: 'a', password: 'b' }, crossSite, response))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.refresh({ requestId: REQUEST_ID }, crossSite, response))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.logout(crossSite, response)).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.authenticateAndLogin).not.toHaveBeenCalled();
    expect(auth.refreshTokens).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });
});

describe('readRefreshCookie', () => {
  it('ignores missing, foreign, and malformed cookies', () => {
    expect(readRefreshCookie({ headers: {} }, true)).toBeNull();
    expect(readRefreshCookie({ headers: { cookie: 'nyabase_refreshX=a' } }, true)).toBeNull();
    expect(readRefreshCookie({ headers: { cookie: `${SECURE_REFRESH_COOKIE_NAME}=a%20b` } }, true)).toBeNull();
    expect(readRefreshCookie({ headers: { cookie: `${SECURE_REFRESH_COOKIE_NAME}=${'f'.repeat(96)}` } }, true))
      .toBe('f'.repeat(96));
  });

  it('does not let a sibling-domain cookie shadow the panel session', () => {
    // A tenant site can plant `nyabase_refresh` for the parent domain, never `__Host-…`.
    const planted = `${REFRESH_COOKIE_NAME}=attacker; ${SECURE_REFRESH_COOKIE_NAME}=!; ${SECURE_REFRESH_COOKIE_NAME}=${'e'.repeat(64)}`;
    expect(readRefreshCookie({ headers: { cookie: planted } }, true)).toBe('e'.repeat(64));
    expect(readRefreshCookie({ headers: { cookie: `${REFRESH_COOKIE_NAME}=attacker` } }, true)).toBeNull();
    expect(readRefreshCookie({ headers: { cookie: `${REFRESH_COOKIE_NAME}=dev` } }, false)).toBe('dev');
  });
});
