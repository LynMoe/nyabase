import { describe, expect, it } from 'vitest';
import { declaredRoutes } from './http-api-routes.test-helper.js';

/**
 * Routes an administrator acting as someone (`X-Nyabase-Act-As`) may not call:
 * they work on the person's own credentials or browser session. A password or
 * SSH key changed here would outlive the request; a console session is claimed
 * by the browser session's token, which belongs to the administrator.
 */
const REFUSED_ROUTES = [
  'DELETE users/:param/ssh-keys/:param',
  'PATCH users/:param',
  'POST containers/:param/exec-sessions',
  'POST users/:param/ssh-keys',
];

describe('HTTP API impersonation contract', () => {
  it('pins the routes that refuse impersonation', async () => {
    const refused = (await declaredRoutes())
      .filter((route) => route.refusesImpersonation)
      .map((route) => route.key)
      .sort();
    expect(refused).toEqual(REFUSED_ROUTES);
  });
});
