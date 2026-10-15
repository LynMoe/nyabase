import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller.js';
import { readRefreshCookie, REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from './refresh-cookie.js';

const REQUEST_ID = 'a'.repeat(64);
const user = {
  id: 'user-1',
  username: 'alice',
  displayName: 'Alice',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function harness(options: { cookieSecure?: boolean } = {}) {
  const auth = {
    authenticateAndLogin: vi.fn(async () => ({ user, accessToken: 'access-1', refreshToken: 'r1' })),
    refreshTokens: vi.fn(async () => ({ accessToken: 'access-2', refreshToken: 'r2', user })),
    logout: vi.fn(async () => 'user-1'),
    refreshCookieMaxAgeMs: vi.fn(() => 7 * 86_400_000),
  };
  const access = {
    userCapabilities: vi.fn(async () => new Set(['view_own'])),
    getUserGroupSummaries: vi.fn(async () => []),
  };
  const config = { get: vi.fn(() => options.cookieSecure ?? true) };
  const controller = new AuthController(auth as never, access as never, config as never);
  const response = { cookie: vi.fn(), clearCookie: vi.fn() };
  return { auth, controller, response };
}

function request(headers: Record<string, string> = {}) {
  return { headers: { 'x-nyabase-auth': '1', ...headers }, ip: '10.0.0.1' };
}

describe('AuthController refresh cookie transport', () => {
  it('sets the refresh secret only as a scoped HttpOnly cookie on login', async () => {
    const { controller, response } = harness();
    const body = await controller.login({ username: 'alice', password: 'pw' }, request(), response);

    expect(body).not.toHaveProperty('refreshToken');
    expect(body.accessToken).toBe('access-1');
    expect(response.cookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, 'r1', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: 7 * 86_400_000,
    });
  });

  it('honors auth.cookieSecure=false for plain-HTTP development', async () => {
    const { controller, response } = harness({ cookieSecure: false });
    await controller.login({ username: 'alice', password: 'pw' }, request(), response);
    expect(response.cookie.mock.calls[0][2]).toMatchObject({ secure: false, httpOnly: true });
  });

  it('rotates from the cookie and returns the user without the successor secret', async () => {
    const { auth, controller, response } = harness();
    const body = await controller.refresh(
      { requestId: REQUEST_ID },
      request({ cookie: `other=x; ${REFRESH_COOKIE_NAME}=r1` }),
      response,
    );

    expect(auth.refreshTokens).toHaveBeenCalledWith('r1', REQUEST_ID);
    expect(body).toEqual({ accessToken: 'access-2', user: expect.objectContaining({ id: 'user-1' }) });
    expect(response.cookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, 'r2', expect.objectContaining({ httpOnly: true }));
  });

  it('rejects refresh without a cookie and clears a rejected cookie', async () => {
    const { auth, controller, response } = harness();
    await expect(controller.refresh({ requestId: REQUEST_ID }, request(), response))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.refreshTokens).not.toHaveBeenCalled();

    auth.refreshTokens.mockRejectedValueOnce(new UnauthorizedException('Invalid refresh token'));
    await expect(controller.refresh(
      { requestId: REQUEST_ID },
      request({ cookie: `${REFRESH_COOKIE_NAME}=stale` }),
      response,
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(response.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, expect.objectContaining({ path: REFRESH_COOKIE_PATH }));
  });

  it('rejects the legacy body-borne refresh token', async () => {
    const { controller, response } = harness();
    await expect(controller.refresh(
      { refreshToken: 'r1', requestId: REQUEST_ID },
      request({ cookie: `${REFRESH_COOKIE_NAME}=r1` }),
      response,
    )).rejects.toThrow();
  });

  it('revokes the cookie session and clears the cookie on logout', async () => {
    const { auth, controller, response } = harness();
    await controller.logout(request({ cookie: `${REFRESH_COOKIE_NAME}=r1` }), response);
    expect(auth.logout).toHaveBeenCalledWith('r1');
    expect(response.clearCookie).toHaveBeenCalled();

    auth.logout.mockClear();
    await controller.logout(request(), response);
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('requires the auth intent header on every cookie endpoint', async () => {
    const { auth, controller, response } = harness();
    const crossSite = { headers: { cookie: `${REFRESH_COOKIE_NAME}=r1` }, ip: '10.0.0.1' };
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
    expect(readRefreshCookie({ headers: {} })).toBeNull();
    expect(readRefreshCookie({ headers: { cookie: 'nyabase_refreshX=a' } })).toBeNull();
    expect(readRefreshCookie({ headers: { cookie: `${REFRESH_COOKIE_NAME}=a%20b` } })).toBeNull();
    expect(readRefreshCookie({ headers: { cookie: `${REFRESH_COOKIE_NAME}=${'f'.repeat(96)}` } }))
      .toBe('f'.repeat(96));
  });
});
