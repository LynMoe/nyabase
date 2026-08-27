import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { fetchAuthenticatedMetrics, assertMetricFamily } from '../../support/metrics-control.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';

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
