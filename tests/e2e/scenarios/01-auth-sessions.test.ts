// Login, refresh rotation, logout, API tokens and account lifecycle.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { UserStatus, type UserDto } from '@nyabase/common';
import { Api, ApiError, login, refresh } from '../client/api.js';
import { Harness, type TestUser } from '../client/harness.js';

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the request to fail' });
}

describe('auth and sessions', () => {
  let h: Harness;
  let user: TestUser;
  before(async () => {
    h = await Harness.start();
    user = await h.newUser('auth');
  });
  after(async () => h?.cleanup());

  it('rejects bad credentials and requests without the auth-intent header', async () => {
    const { baseUrl, admin } = h.state;
    assert.equal((await failure(login(baseUrl, admin.username, 'definitely-wrong'))).status, 401);
    assert.equal((await failure(login(baseUrl, 'no-such-user', 'whatever-pass'))).status, 401);
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(admin),
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: string }).code, 'AUTH_INTENT_REQUIRED');
  });

  it('serves /auth/me only to a bearer token', async () => {
    const anonymous = new Api(h.state.baseUrl);
    assert.equal((await failure(anonymous.get('/auth/me'))).status, 401);
    const me = await h.api.get<UserDto>('/auth/me');
    assert.equal(me.username, h.state.admin.username);
    assert.equal(me.status, UserStatus.Active);
    assert.ok(me.capabilities.length > 0, 'admin holds capabilities');
  });

  it('rotates the refresh cookie and invalidates it on logout', async () => {
    const session = await login(h.state.baseUrl, user.username, user.password);
    assert.ok(session.refreshCookie, 'login sets the refresh cookie');
    const rotated = await refresh(h.state.baseUrl, session.refreshCookie);
    assert.equal(rotated.user.id, user.id);
    assert.ok(rotated.refreshCookie && rotated.refreshCookie !== session.refreshCookie);
    const me = await new Api(h.state.baseUrl, rotated.accessToken).get<UserDto>('/auth/me');
    assert.equal(me.id, user.id);

    const loggedOut = await new Api(h.state.baseUrl).raw('POST', '/auth/logout', {
      headers: { cookie: rotated.refreshCookie },
    });
    assert.equal(loggedOut.status, 204);
    assert.equal((await failure(refresh(h.state.baseUrl, rotated.refreshCookie))).status, 401);
  });

  it('issues, uses and revokes an API token', async () => {
    const api = user.session.api;
    const created = await api.post<{ token: { id: string }; secret: string }>('/auth/tokens', { name: 'e2e' });
    const viaToken = new Api(h.state.baseUrl, created.secret);
    assert.equal((await viaToken.get<UserDto>('/auth/me')).id, user.id);
    const listed = await api.get<{ id: string }[]>('/auth/tokens');
    assert.ok(listed.some((token) => token.id === created.token.id));
    await api.delete(`/auth/tokens/${created.token.id}`);
    assert.equal((await failure(viaToken.get('/auth/me'))).status, 401);
  });

  it('keeps ordinary users away from administration', async () => {
    const api = user.session.api;
    assert.equal(await api.status('GET', '/users'), 403);
    assert.equal(await api.status('POST', '/users', {
      username: 'nope-nope', password: 'password-123', displayName: 'x',
    }), 403);
    assert.equal(await api.status('GET', '/admin/groups'), 403);
    assert.equal(await api.status('GET', '/servers?scope=all'), 403);
  });

  it('changes a password with the current one and locks out a disabled user', async () => {
    const next = `${user.password}-next`;
    const api = user.session.api;
    assert.equal(await api.status('PATCH', `/users/${user.id}`, { password: next }), 400,
      'a password change without currentPassword is refused');
    await api.patch(`/users/${user.id}`, { password: next, currentPassword: user.password });
    assert.equal((await failure(login(h.state.baseUrl, user.username, user.password))).status, 401);
    const session = await login(h.state.baseUrl, user.username, next);

    await h.api.patch(`/users/${user.id}`, { status: UserStatus.Disabled });
    const denied = await failure(login(h.state.baseUrl, user.username, next));
    assert.ok([401, 403].includes(denied.status), `disabled login gave ${denied.status}`);
    assert.ok([401, 403].includes(await session.api.status('GET', '/auth/me')),
      'an old access token stops working once the user is disabled');

    await h.api.patch(`/users/${user.id}`, { status: UserStatus.Active });
    await login(h.state.baseUrl, user.username, next);
  });
});
