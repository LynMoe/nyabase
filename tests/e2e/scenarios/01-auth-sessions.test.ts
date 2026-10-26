// Login, refresh rotation, logout and account lifecycle; there are no API tokens.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Role, UserStatus, type UserDto } from '@nyabase/common';
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
    assert.equal(me.role, Role.Admin);
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

  it('has no API tokens: the browser session is the only credential', async () => {
    const api = user.session.api;
    assert.equal(await api.status('GET', '/auth/tokens'), 404);
    assert.equal(await api.status('POST', '/auth/tokens', { name: 'e2e', currentPassword: user.password }), 404);
    assert.equal(await new Api(h.state.baseUrl, 'a'.repeat(64)).status('GET', '/auth/me'), 401,
      'a 64-hex bearer is just an invalid JWT');
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

  it('keeps role changes and the last active admin guarded', async () => {
    const me = await h.api.get<UserDto>('/auth/me');
    const userAdmin = await h.newUser('useradmin', Role.UserAdmin);
    assert.equal((await h.api.get<UserDto>(`/users/${userAdmin.id}`)).role, Role.UserAdmin);
    const api = userAdmin.session.api;
    assert.equal(await api.status('GET', '/users'), 200, 'user admins may list users');
    assert.equal(await api.status('GET', '/admin/groups'), 200, 'user admins may view groups');
    assert.equal(await api.status('GET', '/admin/system-settings'), 403, 'system settings are admin-only');
    assert.equal(await api.status('POST', '/users', {
      username: 'nope-nope', password: 'password-123', displayName: 'x', role: Role.UserAdmin,
    }), 403, 'only admins hand out roles');
    assert.equal(await api.status('PATCH', `/users/${user.id}`, { role: Role.Admin }), 403);
    assert.equal(await api.status('PATCH', `/users/${me.id}`, { displayName: 'renamed' }), 403,
      'admins are out of a user admin\'s reach');
    assert.equal(await user.session.api.status('PATCH', `/users/${user.id}`, { role: Role.Admin }), 403,
      'nobody promotes themselves');

    await h.api.patch(`/users/${userAdmin.id}`, { role: Role.User });
    assert.equal(await api.status('GET', '/users'), 403, 'a demotion applies to the next request');

    const admins = (await h.api.get<UserDto[]>('/users'))
      .filter((entry) => entry.role === Role.Admin && entry.status === UserStatus.Active);
    if (admins.length === 1) {
      assert.equal(await h.api.status('PATCH', `/users/${me.id}`, { role: Role.User }), 403,
        'the last active admin cannot be demoted');
      assert.equal(await h.api.status('DELETE', `/users/${me.id}`), 403, 'nor deleted');
    }
  });

  it('changes a password with the current one and locks out a disabled user', async () => {
    const next = `${user.password}-next`;
    const api = user.session.api;
    assert.equal(await api.status('PATCH', `/users/${user.id}`, { password: next }), 400,
      'a password change without currentPassword is refused');
    await api.patch(`/users/${user.id}`, { password: next, currentPassword: user.password });
    assert.equal(await api.status('GET', '/auth/me'), 401, 'a password change ends the old session');
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
