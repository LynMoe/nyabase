import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import { expectJson } from '../../support/http.js';
import { fetchAuthenticatedMetrics, assertMetricFamily } from '../../support/metrics-control.js';
import { runCommand } from '../../support/incus-control.js';
import { eventually } from '../../support/poll.js';
import { requireRuntimeEnv } from '../../support/runtime-env.js';

test(
  'pulls authenticated node metrics and records a real exporter outage',
  { ...coverageCase('metrics-authenticated-outage', 'metrics-outage-live') },
  async ({ adminApi, seedState }) => {
    const metricsOptions = {
      caFile: process.env.E2E_NODE_EXPORTER_CA_FILE,
      expectedServerCertFingerprint: requireRuntimeEnv(
        'E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT',
      ),
    };
    const metrics = await fetchAuthenticatedMetrics(
      requireRuntimeEnv('E2E_NODE_EXPORTER_URL'),
      requireRuntimeEnv('E2E_NODE_EXPORTER_TOKEN'),
      metricsOptions,
    );
    expect(metrics.status).toBe(200);
    assertMetricFamily(metrics.body, 'nyabase_node_cpu_usage_ratio');

    const healthyServer = await eventually(
      async () => expectJson<Record<string, any>>(
        await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
      ),
      (server) => server.nodeMetrics?.health?.status === 'online',
      60_000,
      1_000,
      'backend node metrics health',
    );
    expect(healthyServer.nodeMetrics.endpoint).toBe(seedState.server.nodeMetrics.endpoint);
    expect(healthyServer.nodeMetrics.tokenFingerprint)
      .toBe(seedState.server.nodeMetrics.tokenFingerprint);
    expect(healthyServer.nodeMetrics.serverCertFingerprint)
      .toBe(seedState.server.nodeMetrics.serverCertFingerprint);

    const runtime = await expectJson<Record<string, unknown>>(
      await adminApi.get('/api/admin/metrics/runtime'),
    );
    expect(runtime.postgres).toBeDefined();
    expect(runtime.telemetry).toBeDefined();

    if (process.env.E2E_ENABLE_OUTAGE_MUTATION !== '1') {
      throw new Error(
        'BLOCKED: set E2E_ENABLE_OUTAGE_MUTATION=1 after preflight to stop and restore the exporter unit',
      );
    }
    const unit = requireRuntimeEnv('E2E_NODE_EXPORTER_UNIT');
    if (!/^[A-Za-z0-9_.@-]+$/.test(unit)) {
      throw new Error('BLOCKED: E2E_NODE_EXPORTER_UNIT is not an allowlisted unit name');
    }

    try {
      const stopped = await runCommand('systemctl', ['stop', unit]);
      expect(stopped.code, stopped.stderr).toBe(0);
      const outage = await fetchAuthenticatedMetrics(
        requireRuntimeEnv('E2E_NODE_EXPORTER_URL'),
        requireRuntimeEnv('E2E_NODE_EXPORTER_TOKEN'),
        metricsOptions,
      ).catch(() => ({ status: 0, body: '' }));
      expect([0, 502, 503, 504]).toContain(outage.status);
      const unreachable = await eventually(
        async () => expectJson<Record<string, any>>(
          await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
        ),
        (server) => server.nodeMetrics?.health?.status === 'unreachable',
        120_000,
        1_000,
        'backend node metrics outage state',
      );
      expect(unreachable.nodeMetrics.health.outageSince).toBeTruthy();
    } finally {
      const restored = await runCommand('systemctl', ['start', unit]);
      expect(restored.code, restored.stderr).toBe(0);
    }
    const recovered = await eventually(
      async () => expectJson<Record<string, any>>(
        await adminApi.get(`/api/admin/servers/${seedState.server.id}`),
      ),
      (server) => server.nodeMetrics?.health?.status === 'online',
      120_000,
      1_000,
      'backend node metrics recovery state',
    );
    expect(recovered.nodeMetrics.health.outageSince).toBeNull();
  },
);
