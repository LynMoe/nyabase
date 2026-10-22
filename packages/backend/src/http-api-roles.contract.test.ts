import { Role } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { declaredRoutes } from './http-api-routes.test-helper.js';

/**
 * The minimum role every route declares with `@RequireRole`. Routes that both
 * owners and staff use declare nothing: their owner-or-role rule lives in the
 * service (see the *.service tests and the PG authorization tests), as do the
 * self-service routes. Keys use the normalised pattern (`:param` for every
 * path parameter).
 */
const OPERATOR_ROUTES = [
  'DELETE admin/groups/:param/server-grants/:param',
  'DELETE admin/groups/:param/shared-backend-grants/:param',
  'DELETE admin/groups/:param/storage-pool-grants/:param',
  'DELETE http-proxy/domain-pools/:param',
  'DELETE images/:param',
  'DELETE images/:param/assignments/:param',
  'DELETE servers/:param',
  'DELETE users/:param/server-grants/:param',
  'DELETE users/:param/shared-backend-grants/:param',
  'DELETE users/:param/storage-pool-grants/:param',
  'GET admin/catalog/grant-servers',
  'GET admin/catalog/groups',
  'GET admin/catalog/metric-servers',
  'GET admin/catalog/users',
  'GET admin/groups',
  'GET admin/groups/:param',
  'GET admin/groups/:param/server-grants',
  'GET admin/groups/:param/shared-backend-grants',
  'GET admin/groups/:param/storage-pool-grants',
  'GET admin/metrics/runtime',
  'GET admin/ssh-proxy/host-key',
  'GET admin/ssh-proxy/status',
  'GET admin/system-settings',
  'GET audit',
  'GET audit/:param',
  'GET http-proxy/status',
  'GET images/:param/assignments',
  'GET images/:param/assignments/status',
  'GET images/:param/status',
  'GET images/catalog',
  'GET servers/:param/gpu',
  'GET servers/:param/preflight',
  'GET users',
  'GET users/:param/effective-access',
  'GET users/:param/server-grants',
  'GET users/:param/shared-backend-grants',
  'GET users/:param/storage-pool-grants',
  'PATCH admin/system-settings',
  'PATCH http-proxy/domain-pools/:param',
  'PATCH images/:param',
  'PATCH servers/:param',
  'PATCH servers/:param/gpu',
  'POST admin/ssh-proxy/disconnect-all',
  'POST admin/ssh-proxy/host-key/rotate',
  'POST http-proxy/domain-pools',
  'POST images',
  'POST images/:param/repull',
  'POST servers',
  'POST servers/:param/agent-enrollment',
  'POST servers/:param/preflight',
  'POST servers/:param/storage-pools/discover',
  'PUT admin/groups/:param/server-grants/:param',
  'PUT admin/groups/:param/shared-backend-grants/:param',
  'PUT admin/groups/:param/storage-pool-grants/:param',
  'PUT images/:param/assignments/:param',
  'PUT users/:param/server-grants/:param',
  'PUT users/:param/shared-backend-grants/:param',
  'PUT users/:param/storage-pool-grants/:param',
];

const ADMIN_ROUTES = [
  'DELETE admin/groups/:param',
  'DELETE admin/groups/:param/members/:param',
  'DELETE admin/ip-pools/:param',
  'DELETE shared-backends/:param',
  'DELETE users/:param',
  'GET admin/groups/:param/members',
  'GET admin/ip-pools',
  'GET admin/ip-pools/:param',
  'GET shared-backends/:param/catalog-inspect',
  'GET shared-backends/:param/executors',
  'GET shared-volumes/:param/catalogs',
  'PATCH admin/groups/:param',
  'PATCH admin/ip-pools/:param',
  'PATCH servers/:param/storage-pools/:param',
  'PATCH shared-backends/:param',
  'PATCH shared-backends/:param/executors/:param',
  'POST admin/groups',
  'POST admin/groups/:param/members',
  'POST admin/ip-pools',
  'POST shared-backends',
  'POST shared-backends/:param/executors/discover',
  'POST users',
  // It deletes volumes, whose administrator override needs admin.
  'POST users/:param/servers/:param/purge-resources',
];

describe('HTTP API role contract', () => {
  it('pins the minimum role of every route that declares one', async () => {
    const routes = await declaredRoutes();
    const declared = (role: Role) => routes
      .filter((route) => route.minRole === role)
      .map((route) => route.key)
      .sort();
    expect(declared(Role.Operator)).toEqual([...OPERATOR_ROUTES].sort());
    expect(declared(Role.Admin)).toEqual([...ADMIN_ROUTES].sort());
  });

  it('declares only operator or admin: user is the default and is never written', async () => {
    const roles = new Set((await declaredRoutes()).map((route) => route.minRole));
    roles.delete(null);
    expect([...roles].sort()).toEqual([Role.Admin, Role.Operator]);
  });

  it('requires a role on every route under the /admin namespace', async () => {
    const unguarded = (await declaredRoutes())
      .filter((route) => route.pattern.startsWith('admin/'))
      .filter((route) => route.minRole === null)
      .map((route) => route.key);
    expect(unguarded).toEqual([]);
  });

  it('leaves the owner-or-staff routes to the service layer', async () => {
    const routes = await declaredRoutes();
    for (const key of [
      'GET containers', 'GET containers/:param', 'POST containers/:param/actions/start',
      'GET volumes', 'PATCH volumes/:param', 'DELETE volumes/:param',
      'GET shared-volumes', 'PATCH shared-volumes/:param', 'DELETE shared-volumes/:param',
      'GET servers', 'GET servers/:param', 'GET images', 'GET images/:param',
      'GET shared-backends', 'GET shared-backends/:param', 'GET performance/usage',
      'GET intents', 'GET intents/:param', 'POST intents/:param/retry',
      'GET users/:param', 'PATCH users/:param',
    ]) {
      const route = routes.find((candidate) => candidate.key === key);
      expect(route, `${key} is mounted`).toBeDefined();
      expect(route!.minRole, key).toBeNull();
    }
  });
});
