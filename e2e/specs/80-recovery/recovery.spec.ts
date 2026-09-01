import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { fetchAuthenticatedMetrics, assertMetricFamily } from '../../support/metrics-control.js';
import { runCommand } from '../../support/incus-control.js';
import { eventually } from '../../support/poll.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';
import {
  attachVolume,
  createRunningContainer,
  createSharedVolume,
  deleteContainer,
  deleteVolume,
  execInContainer,
} from '../../support/volume-ops.js';

test(
  'reconciles the connected server and durable intents after a restart boundary',
  { ...coverageCase('recovery-reconcile-cleanup', 'recovery-reconcile-live') },
  async ({ adminApi, seedState }) => {
    await expectJson<Record<string, unknown>>(
      await adminApi.get('/api/health/ready'),
    );
    const server = await expectJson<Record<string, any>>(
      await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
    );
    expect(['online', 'ready']).toContain(server.status);

    const imageIntentPage = await expectJson<{
      items: Record<string, unknown>[];
      nextCursor?: string | null;
    }>(
      await adminApi.get(`/api/admin/images/${seedState.image.id}/intents`),
    );
    expect(Array.isArray(imageIntentPage.items)).toBe(true);

    const containers = await expectJson<Record<string, any>[]>(
      await adminApi.get('/api/admin/containers'),
    );
    if (containers.length > 0) {
      const intentPage = await expectJson<{
        items: Record<string, unknown>[];
        nextCursor?: string | null;
      }>(
        await adminApi.get(`/api/admin/containers/${containers[0].id}/intents`),
      );
      expect(Array.isArray(intentPage.items)).toBe(true);
    }

    const metrics = await fetchAuthenticatedMetrics(
      requireRuntimeEnv('E2E_NODE_EXPORTER_URL'),
      requireRuntimeEnv('E2E_NODE_EXPORTER_TOKEN'),
      {
        caFile: process.env.E2E_NODE_EXPORTER_CA_FILE,
        expectedServerCertFingerprint: requireRuntimeEnv(
          'E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT',
        ),
      },
    );
    expect(metrics.status).toBe(200);
    assertMetricFamily(metrics.body, 'nyabase_node_cpu_usage_ratio');
  },
);

test(
  'shared volume attachment and data survive a control-plane restart',
  { ...coverageCase('recovery-shared-volume-restart', 'recovery-shared-volume-restart-live') },
  async ({ adminApi, seedState, topologyProvider }) => {
    expect(topologyProvider.capabilities['cephfs-cluster'].state).toBe('available');
    let volumeId: string | undefined;
    let containerId: string | undefined;
    const runId = requireRuntimeEnv('E2E_RUN_ID');
    try {
      volumeId = await createSharedVolume(
        adminApi,
        seedState,
        `e2e-restart-${Date.now().toString(36)}`,
      );
      containerId = await createRunningContainer(adminApi, seedState, 'e2e-restart');
      await attachVolume(adminApi, containerId, volumeId, '/mnt/shared', 'shared');
      const marker = `restart-${seedState.runId}`;
      await execInContainer(
        adminApi,
        containerId,
        `printf '%s\\n' '${marker}' > /mnt/shared/marker && cat /mnt/shared/marker`,
      );

      const stopped = await runCommand('bash', [
        '/root/nyabase/e2e/orchestrator/e2e.sh',
        'stop-control-plane',
        runId,
      ]);
      expect(stopped.code, stopped.stderr).toBe(0);
      const started = await runCommand('bash', [
        '/root/nyabase/e2e/orchestrator/e2e.sh',
        'start-control-plane',
        runId,
        'full',
      ]);
      expect(started.code, started.stderr).toBe(0);
      await eventually(
        async () => adminApi.get('/api/health/ready'),
        (response) => response.ok(),
        90_000,
        500,
        'control plane ready after restart',
      );

      const volume = await expectJson<Record<string, any>>(
        await adminApi.get(`/api/admin/shared-volumes/${volumeId}`),
      );
      expect(volume.id).toBe(volumeId);
      expect(volume.attachments?.length).toBeGreaterThan(0);
      expect(await execInContainer(adminApi, containerId, 'cat /mnt/shared/marker'))
        .toContain(marker);
    } finally {
      await deleteContainer(adminApi, containerId);
      await deleteVolume(adminApi, volumeId);
    }
  },
);
