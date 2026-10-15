import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';

test(
  'health endpoints are served through the verified HTTPS edge',
  { ...coverageCase('foundation-health-tls', 'foundation-health-live') },
  async ({ anonymousApi }) => {
    const live = await expectJson<Record<string, unknown>>(
      await anonymousApi.get('/api/health/live'),
    );
    const ready = await expectJson<Record<string, unknown>>(
      await anonymousApi.get('/api/health/ready'),
    );
    const settings = await expectJson<Record<string, unknown>>(
      await anonymousApi.get('/api/public/settings'),
    );
    expect(live).toBeDefined();
    expect(ready).toBeDefined();
    expect(settings).toBeDefined();
  },
);

test(
  'the runtime seed proves the Incus boundary and explicit blocked gaps',
  { ...coverageCase('contract-http-inventory', 'foundation-incus-boundary') },
  async ({ seedState, topologyProvider }) => {
    expect(topologyProvider.id).toBe('incus-standalone');
    expect(seedState.server.endpoint).toMatch(/^https:\/\//);
    expect(seedState.image.fingerprint).toMatch(/^[a-f0-9]{32,64}$/i);
    expect(seedState.image.sshdWithoutDhcp).toBe(true);
    expect(seedState.storagePools.dirQuotaOnline.quotaOnline).toBe(true);
    expect(seedState.storagePools.lvmBlockBacked.blockBacked).toBe(true);
    expect(
      seedState.blocked.gpu.startsWith('BLOCKED:')
        || seedState.blocked.gpu.startsWith('PROVEN:'),
    ).toBe(true);
    expect(
      seedState.blocked.cephfs.startsWith('BLOCKED:')
        || seedState.blocked.cephfs.startsWith('ENABLED:'),
    ).toBe(true);
    if (seedState.blocked.cephfs.startsWith('ENABLED:')) {
      expect(seedState.sharedBackendId).toBeTruthy();
      expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    }
  },
);
