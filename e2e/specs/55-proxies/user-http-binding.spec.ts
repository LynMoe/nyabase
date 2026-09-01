import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import {
  createPersonaUser,
  createUserContainer,
  deletePersonaUser,
  deleteUserContainer,
  loginPersona,
  provisionGrantedUser,
} from '../../support/persona.js';

type JsonRecord = Record<string, any>;

test(
  'a user can bind HTTP proxy to their container and cannot bind someone else',
  { ...coverageCase('user-http-proxy-own-container', 'user-http-proxy-own-container-live') },
  async ({ adminApi, authedApiFactory, seedState }) => {
    test.setTimeout(360_000);
    const owner = await provisionGrantedUser(adminApi, seedState, 'htpo');
    const stranger = await createPersonaUser(adminApi, 'htps');
    let ownerApi: Awaited<ReturnType<typeof authedApiFactory>> | undefined;
    let containerId: string | undefined;
    let poolId: string | undefined;
    let bindingId: string | undefined;
    const suffix = Date.now().toString(36);
    const wildcard = `*.e2e-u-${suffix}.example.test`;
    const hostname = `app.e2e-u-${suffix}.example.test`;
    try {
      const session = await loginPersona(adminApi, owner);
      ownerApi = await authedApiFactory(session.accessToken);
      const created = await createUserContainer(ownerApi, seedState, {
        namePrefix: 'e2e-htp',
        powerIntent: 'stopped',
      });
      containerId = created.containerId;

      const pool = await expectJson<JsonRecord>(
        await adminApi.post('/api/admin/http-proxy/domain-pools', {
          data: { wildcardDomain: wildcard, enabled: true, httpsEnabled: false },
        }),
        [200, 201],
      );
      poolId = pool.id as string;

      const binding = await expectJson<JsonRecord>(
        await ownerApi.post('/api/http-proxy/bindings', {
          data: {
            hostname,
            containerId,
            targetPort: 80,
          },
        }),
        [200, 201],
      );
      expect(binding.id).toBeTruthy();
      bindingId = binding.id as string;

      const strangerSession = await loginPersona(adminApi, stranger);
      const strangerApi = await authedApiFactory(strangerSession.accessToken);
      const stolen = await strangerApi.post('/api/http-proxy/bindings', {
        data: {
          hostname: `x.e2e-u-${suffix}.example.test`,
          containerId,
          targetPort: 8080,
        },
      });
      expect(stolen.status()).toBeGreaterThanOrEqual(400);

      const patched = await expectJson<JsonRecord>(
        await ownerApi.patch(`/api/http-proxy/bindings/${bindingId}`, {
          data: { targetPort: 8080 },
        }),
      );
      expect(patched.id).toBe(bindingId);
    } finally {
      if (bindingId && ownerApi) {
        await ownerApi.delete(`/api/http-proxy/bindings/${bindingId}`).catch(() => undefined);
      }
      if (poolId) {
        await adminApi.delete(`/api/admin/http-proxy/domain-pools/${poolId}`).catch(() => undefined);
      }
      await deleteUserContainer(ownerApi ?? adminApi, adminApi, containerId);
      await deletePersonaUser(adminApi, stranger.userId);
      await deletePersonaUser(adminApi, owner.userId);
    }
  },
);
