import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { eventually } from '../../support/poll.js';
import { waitForGone } from '../../support/wait-for-gone.js';

type JsonRecord = Record<string, any>;

test(
  'seeds extra Incus workers, lists them online, and places a container on a worker',
  { ...coverageCase('multi-server-management', 'multi-server-management-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['multi-server'].state).toBe('available');
    expect(topologyProvider.nodeCount).toBeGreaterThanOrEqual(2);
    const labServers = seedState.labServers ?? [];
    expect(labServers.length, 'seeded extra Incus workers').toBeGreaterThanOrEqual(1);

    const listed = await expectJson<JsonRecord[]>(await adminApi.get('/api/admin/servers'));
    expect(listed.some((server) => server.id === seedState.server.id)).toBe(true);
    for (const worker of labServers) {
      const row = listed.find((server) => server.id === worker.id);
      expect(row, worker.endpoint).toBeTruthy();
      expect(row?.status).toBe('online');
      expect(row?.apiEndpoint).toBe(worker.endpoint);
      const detail = await expectJson<JsonRecord>(
        await adminApi.get(`/api/admin/servers/${worker.id}`),
      );
      expect(detail.status).toBe('online');
      expect(detail.parentInterface).toBe(worker.parentInterface);
    }

    const worker = labServers[0];
    const accepted = await expectJson<JsonRecord>(
      await adminApi.post('/api/admin/containers', {
        data: {
          ownerId: seedState.adminUserId,
          serverId: worker.id,
          imageId: seedState.image.id,
          name: `e2e-lab-${Date.now().toString(36)}`,
          rootSizeBytes: 2 * 1024 * 1024 * 1024,
          cpuMillis: 500,
          memBytes: 512 * 1024 * 1024,
          gpuPciAddresses: [],
          powerIntent: 'running',
        },
      }),
      202,
    );
    const containerId = accepted.resourceId as string;
    try {
      await eventually(
        async () => expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/intents/${accepted.intentId}`),
        ),
        (intent) => intent.status === 'succeeded',
        180_000,
        500,
        'lab worker container.create',
      );
      const container = await eventually(
        async () => expectJson<JsonRecord>(
          await adminApi.get(`/api/admin/containers/${containerId}`),
        ),
        (value) => value.lifecyclePhase === 'active' && value.actual?.status === 'running',
        180_000,
        500,
        `lab worker container ${containerId}`,
      );
      expect(container.serverId).toBe(worker.id);
    } finally {
      const deletion = await adminApi.post(
        `/api/admin/containers/${containerId}/actions/delete`,
      ).catch(() => undefined);
      if (deletion?.status() === 202) {
        await waitForGone(adminApi, `/api/admin/containers/${containerId}`);
      }
    }
  },
);
