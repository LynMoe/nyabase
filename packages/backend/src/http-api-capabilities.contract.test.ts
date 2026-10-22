import { Capability } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { declaredRoutes } from './http-api-routes.test-helper.js';

/**
 * Operations that only administrators may perform keep exactly the
 * capabilities the old /admin/... routes required. Routes that both owners
 * and administrators use declare nothing here: their owner-or-capability rule
 * lives in the service (see the *.service tests and the PG authorization tests).
 */
const ADMIN_ONLY_OPERATIONS: Record<string, { all: Capability[]; any: Capability[] }> = {
  'DELETE /http-proxy/domain-pools/:id': { all: [Capability.ManageSystemSettings], any: [] },
  'DELETE /images/:id': { all: [Capability.ManageImages], any: [] },
  'DELETE /images/:id/assignments/:serverId': { all: [Capability.ManageImages], any: [] },
  'DELETE /servers/:id': { all: [Capability.ManageServers], any: [] },
  'DELETE /shared-backends/:id': { all: [Capability.ManageSharedBackends], any: [] },
  'DELETE /users/:id': { all: [Capability.ManageUsers], any: [] },
  'DELETE /users/:userId/server-grants/:serverId': { all: [Capability.ManageGrants], any: [] },
  'DELETE /users/:userId/shared-backend-grants/:backendId': { all: [Capability.ManageGrants], any: [] },
  'DELETE /users/:userId/storage-pool-grants/:poolId': { all: [Capability.ManageGrants], any: [] },
  'GET /http-proxy/status': { all: [], any: [Capability.ViewMetricsAll, Capability.ViewAudit, Capability.ManageSystemSettings] },
  'GET /images/:id/assignments': { all: [Capability.ManageImages], any: [] },
  'GET /images/:id/assignments/status': { all: [Capability.ManageImages], any: [] },
  'GET /images/:id/status': { all: [Capability.ManageImages], any: [] },
  'GET /images/catalog': { all: [Capability.ManageImages], any: [] },
  'GET /servers/:id/preflight': { all: [Capability.ManageServers], any: [] },
  'GET /servers/:serverId/gpu': { all: [Capability.ManageServers], any: [] },
  'GET /shared-backends/:id/catalog-inspect': { all: [Capability.ManageSharedVolumes], any: [] },
  'GET /shared-backends/:id/executors': { all: [Capability.ManageSharedBackends], any: [] },
  'GET /shared-volumes/:id/catalogs': { all: [Capability.ManageSharedVolumes], any: [] },
  'GET /users': { all: [], any: [Capability.ManageUsers, Capability.ManageGrants] },
  'GET /users/:userId/effective-access': { all: [Capability.ManageGrants], any: [] },
  'GET /users/:userId/server-grants': { all: [Capability.ManageGrants], any: [] },
  'GET /users/:userId/shared-backend-grants': { all: [Capability.ManageGrants], any: [] },
  'GET /users/:userId/storage-pool-grants': { all: [Capability.ManageGrants], any: [] },
  'PATCH /http-proxy/domain-pools/:id': { all: [Capability.ManageSystemSettings], any: [] },
  'PATCH /images/:id': { all: [Capability.ManageImages], any: [] },
  'PATCH /servers/:id': { all: [Capability.ManageServers], any: [] },
  'PATCH /servers/:serverId/gpu': { all: [Capability.ManageServers], any: [] },
  'PATCH /servers/:serverId/storage-pools/:id': { all: [Capability.ManageStoragePools], any: [] },
  'PATCH /shared-backends/:id': { all: [Capability.ManageSharedBackends], any: [] },
  'PATCH /shared-backends/:id/executors/:executorId': { all: [Capability.ManageSharedBackends], any: [] },
  'POST /http-proxy/domain-pools': { all: [Capability.ManageSystemSettings], any: [] },
  'POST /images': { all: [Capability.ManageImages], any: [] },
  'POST /images/:id/repull': { all: [Capability.ManageImages], any: [] },
  'POST /servers': { all: [Capability.ManageServers], any: [] },
  'POST /servers/:id/agent-enrollment': { all: [Capability.ManageServers], any: [] },
  'POST /servers/:id/preflight': { all: [Capability.ManageServers], any: [] },
  'POST /servers/:serverId/storage-pools/discover': { all: [Capability.ManageServers], any: [] },
  'POST /shared-backends': { all: [Capability.ManageSharedBackends], any: [] },
  'POST /shared-backends/:id/executors/discover': { all: [Capability.ManageSharedBackends], any: [] },
  'POST /users': { all: [Capability.ManageUsers], any: [] },
  'POST /users/:userId/servers/:serverId/purge-resources': { all: [Capability.ManageGrants, Capability.ManageContainersAny], any: [] },
  'PUT /images/:id/assignments/:serverId': { all: [Capability.ManageImages], any: [] },
  'PUT /users/:userId/server-grants/:serverId': { all: [Capability.ManageGrants], any: [] },
  'PUT /users/:userId/shared-backend-grants/:backendId': { all: [Capability.ManageGrants], any: [] },
  'PUT /users/:userId/storage-pool-grants/:poolId': { all: [Capability.ManageGrants], any: [] },
};

/** Shared routes whose capability is checked by the service, never by metadata. */
const SERVICE_AUTHORIZED = [
  'GET containers', 'GET containers/:param', 'POST containers/:param/actions/start',
  'GET volumes', 'GET volumes/:param', 'PATCH volumes/:param', 'DELETE volumes/:param',
  'GET shared-volumes', 'GET shared-volumes/:param', 'PATCH shared-volumes/:param',
  'DELETE shared-volumes/:param', 'POST containers/:param/volumes',
  'POST containers/:param/shared-volumes', 'GET servers', 'GET servers/:param',
  'GET servers/:param/storage-pools', 'GET servers/:param/storage-capacity',
  'GET servers/:param/gpus', 'GET images', 'GET images/:param', 'GET shared-backends',
  'GET shared-backends/:param', 'GET performance/usage', 'GET performance/series',
  'GET http-proxy/bindings', 'GET http-proxy/domain-pools', 'GET intents', 'GET intents/:param',
  'POST intents/:param/retry', 'GET users/:param', 'PATCH users/:param',
];

describe('HTTP API capability contract', () => {
  it('keeps the old admin capabilities on admin-only operations', async () => {
    const routes = await declaredRoutes();
    for (const [key, expected] of Object.entries(ADMIN_ONLY_OPERATIONS)) {
      const [method, path] = key.split(' ');
      const route = routes.find((candidate) =>
        candidate.key === `${method} ${path!.replace(/^\//, '').replace(/:\w+/g, ':param')}`);
      expect(route, `${key} is mounted`).toBeDefined();
      expect({ all: [...route!.allOf].sort(), any: [...route!.anyOf].sort() }, key).toEqual({
        all: [...expected.all].sort(),
        any: [...expected.any].sort(),
      });
    }
  });

  it('declares no capability on the shared owner-or-administrator routes', async () => {
    const routes = await declaredRoutes();
    for (const key of SERVICE_AUTHORIZED) {
      const route = routes.find((candidate) => candidate.key === key);
      expect(route, `${key} is mounted`).toBeDefined();
      expect(route!.allOf, key).toEqual([]);
      expect(route!.anyOf, key).toEqual([]);
    }
  });

  it('requires a capability on every route under the /admin namespace', async () => {
    const unguarded = (await declaredRoutes())
      .filter((route) => route.pattern.startsWith('admin/'))
      .filter((route) => route.allOf.length === 0 && route.anyOf.length === 0)
      .map((route) => route.key);
    expect(unguarded).toEqual([]);
  });
});
