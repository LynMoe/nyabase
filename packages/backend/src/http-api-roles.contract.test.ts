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
const USER_ADMIN_ROUTES = [
  'DELETE admin/grant-bundles/:param',
  'DELETE shared-volumes/:param',
  'DELETE users/:param',
  'DELETE users/:param/data-disk-grants/:param',
  'DELETE users/:param/server-grants/:param',
  'DELETE users/:param/shared-backend-grants/:param',
  'DELETE volumes/:param',
  'GET admin/catalog/grant-servers',
  'GET admin/catalog/metric-servers',
  'GET admin/catalog/users',
  'GET admin/grant-bundles',
  'GET admin/grant-bundles/:param',
  'GET admin/grant-bundles/server-profiles/:param',
  'GET audit',
  'GET audit/:param',
  'GET server-grants',
  'GET users',
  'GET users/:param/data-disk-grants',
  'GET users/:param/effective-access',
  'GET users/:param/server-grants',
  'GET users/:param/shared-backend-grants',
  'PATCH admin/grant-bundles/:param',
  'PATCH users/:param/data-disk-grants/:param',
  'PATCH users/:param/server-grants/:param',
  'POST admin/grant-bundles',
  'POST admin/grant-bundles/:param/preview',
  'POST users',
  'POST users/:param/data-disk-grants',
  'POST users/:param/servers/:param/purge-resources',
  'PUT users/:param/server-grants/:param',
  'PUT users/:param/shared-backend-grants/:param',
];

const ADMIN_ROUTES = [
  'DELETE admin/firewall-rules/:param',
  'DELETE admin/ip-pools/:param',
  'DELETE admin/ssh-proxy/lines/:param',
  'DELETE http-proxy/domain-pools/:param',
  'DELETE images/:param',
  'DELETE images/:param/assignments/:param',
  'DELETE images/:param/versions/:param',
  'DELETE servers/:param',
  'DELETE shared-backends/:param',
  'GET admin/agent-rejections',
  'GET admin/container-scripts',
  'GET admin/container-scripts/:param',
  'GET admin/container-scripts/:param/runs',
  'GET admin/container-scripts/:param/runs/:param',
  'GET admin/container-scripts/:param/targets',
  'GET admin/container-scripts/:param/versions',
  'GET admin/container-scripts/:param/versions/:param',
  'GET admin/container-scripts/blobs/:param',
  'GET admin/firewall-rules',
  'GET admin/firewall-rules/:param',
  'GET admin/firewall-rules/status',
  'GET admin/ip-pools',
  'GET admin/ip-pools/:param',
  'GET admin/metrics/runtime',
  'GET admin/ssh-proxy/host-key',
  'GET admin/ssh-proxy/lines',
  'GET admin/ssh-proxy/refusals',
  'GET admin/ssh-proxy/status',
  'GET admin/system-settings',
  'GET http-proxy/status',
  'GET images/:param/assignments',
  'GET images/:param/assignments/status',
  'GET images/:param/status',
  'GET images/:param/versions',
  'GET images/catalog',
  'GET servers/:param/gpu',
  'GET servers/:param/preflight',
  'GET shared-backends/:param/catalog-inspect',
  'GET shared-backends/:param/executors',
  'GET shared-volumes/:param/catalogs',
  'PATCH admin/container-scripts/:param',
  'PATCH admin/firewall-rules/:param',
  'PATCH admin/ip-pools/:param',
  'PATCH admin/ssh-proxy/lines/:param',
  'PATCH admin/system-settings',
  'PATCH http-proxy/domain-pools/:param',
  'PATCH images/:param',
  'PATCH servers/:param',
  'PATCH servers/:param/gpu',
  'PATCH servers/:param/storage-pools/:param',
  'PATCH shared-backends/:param',
  'PATCH shared-backends/:param/executors/:param',
  'POST admin/container-scripts',
  'POST admin/container-scripts/:param/archive',
  'POST admin/container-scripts/:param/pause',
  'POST admin/container-scripts/:param/resume',
  'POST admin/container-scripts/:param/retry',
  'POST admin/container-scripts/:param/versions',
  'POST admin/container-scripts/blobs',
  'POST admin/container-scripts/preview',
  'POST admin/firewall-rules',
  'POST admin/ip-pools',
  'POST admin/ssh-proxy/disconnect-all',
  'POST admin/ssh-proxy/host-authorities/reset',
  'POST admin/ssh-proxy/host-key/rotate',
  'POST admin/ssh-proxy/lines',
  'POST http-proxy/domain-pools',
  'POST images',
  'POST images/:param/repull',
  'POST servers',
  'POST servers/:param/agent-enrollment',
  'POST servers/:param/preflight',
  'POST servers/:param/storage-pools/:param/mount-preview',
  'POST servers/:param/storage-pools/discover',
  'POST shared-backends',
  'POST shared-backends/:param/executors/discover',
  'POST shared-backends/:param/mount-preview',
  'PUT admin/ssh-proxy/lines/order',
  'PUT images/:param/assignments/:param',
];

describe('HTTP API role contract', () => {
  it('pins the minimum role of every route that declares one', async () => {
    const routes = await declaredRoutes();
    const declared = (role: Role) => routes
      .filter((route) => route.minRole === role)
      .map((route) => route.key)
      .sort();
    expect(declared(Role.UserAdmin)).toEqual([...USER_ADMIN_ROUTES].sort());
    expect(declared(Role.Admin)).toEqual([...ADMIN_ROUTES].sort());
  });

  it('declares only user_admin or admin: user is the default and is never written', async () => {
    const roles = new Set((await declaredRoutes()).map((route) => route.minRole));
    roles.delete(null);
    expect([...roles].sort()).toEqual([Role.Admin, Role.UserAdmin]);
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
      'GET volumes', 'GET volumes/:param',
      'GET shared-volumes', 'GET shared-volumes/:param',
      'GET servers', 'GET servers/:param', 'GET images', 'GET images/:param',
      'GET shared-backends', 'GET shared-backends/:param', 'GET performance/usage',
      'GET intents', 'GET intents/:param', 'POST intents/:param/retry',
      'GET ssh-sessions', 'GET ssh-sessions/stats', 'GET ssh-sessions/:param',
      'GET users/:param', 'PATCH users/:param',
      'GET containers/:param/maintenance',
    ]) {
      const route = routes.find((candidate) => candidate.key === key);
      expect(route, `${key} is mounted`).toBeDefined();
      expect(route!.minRole, key).toBeNull();
    }
  });
});
