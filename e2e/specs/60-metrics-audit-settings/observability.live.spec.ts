import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import {
  cleanupContainerThroughProductApi,
  waitForAgentTask,
  type AgentTaskRef,
} from '../../support/durable-api.js';
import { expectJson, expectSuccess } from '../../support/http.js';
import { currentRunId } from '../../support/runtime-env.js';

interface MetricSeries {
  step: number;
  points: Array<{ t: number; v: number | null }>;
}

interface HostMetrics {
  cpu: MetricSeries;
  memUsed: MetricSeries;
  memTotal: MetricSeries;
  load1: MetricSeries;
  disks: Array<{ diskId: string; mountPoint: string; used: MetricSeries; total: MetricSeries }>;
  diskIo: Array<{ dev: string; bps: MetricSeries }>;
  netIo: Array<{ iface: string; bps: MetricSeries }>;
}

interface GpuMetrics { gpus: unknown[] }

interface UserMetrics {
  users: Array<{
    userId: string;
    username: string;
    cpu: MetricSeries;
    memUsed: MetricSeries;
    gpuMemUsed: MetricSeries;
    diskBps: MetricSeries;
    netBps: MetricSeries;
    diskUsed: MetricSeries;
  }>;
}

interface ContainerMetrics {
  containers: Array<{
    containerId: string;
    name: string;
    ownerId: string;
    cpu: MetricSeries;
    memUsed: MetricSeries;
    gpuMemUsed: MetricSeries;
    diskBps: MetricSeries;
    netBps: MetricSeries;
  }>;
}

interface AuditLog {
  id: string;
  actorId: string | null;
  actorUsername: string | null;
  actorSnapshot: ResourceSnapshot | null;
  action: string;
  targetId: string | null;
  targetType: string | null;
  targetName: string | null;
  targetSnapshot: ResourceSnapshot | null;
  related: ResourceSnapshot[];
  payload: unknown;
  ts: string;
}

interface ResourceSnapshot {
  id: string | null;
  type: string | null;
  name: string | null;
  labels?: Record<string, string | number | boolean | null>;
}

interface AuditPage {
  items: AuditLog[];
  total: number;
  limit: number;
  offset: number;
}

interface SystemSettingField {
  key: string;
  effectiveValue: unknown;
  source: 'default' | 'yaml' | 'env';
  secret: boolean;
  editable: boolean;
  restartRequired: boolean;
  public: boolean;
}

interface SystemSettings {
  revision: number;
  snapshotToken: string;
  configFile: string;
  fields: SystemSettingField[];
  editable: SystemSettingField[];
  readOnly: SystemSettingField[];
  publicSettings: PublicSettings;
}

interface PublicSettings {
  branding: { title: string; description: string };
}

interface CatalogMetricServerView {
  id: string;
  name: string;
  slug: string;
  status: string;
  runtimeReady: boolean;
  hasGpu: boolean;
}

test.describe('60 metrics, audit, and settings', () => {
  test('api.observability.host-cpu-memory-disk-and-network-metrics', coverageCase(
    'observability.audit-settings.host-cpu-memory-disk-and-network-metrics',
    'api.observability.host-cpu-memory-disk-and-network-metrics',
  ), async ({ adminApi, seedState }) => {
    test.setTimeout(150_000);
    const metrics = await Promise.all(
      seedState.servers.map((server) => waitForHostMetrics(adminApi, server.serverId)),
    );
    for (const host of metrics) {
      assertSeries(host.cpu, true);
      assertSeries(host.memUsed, true);
      assertSeries(host.memTotal, true);
      assertSeries(host.load1, true);
      expect(host.disks.length).toBeGreaterThan(0);
      for (const disk of host.disks) {
        expect(disk.diskId).not.toBe('');
        expect(disk.mountPoint).toMatch(/^\//);
        assertSeries(disk.used, true);
        assertSeries(disk.total, true);
      }
      expect(host.diskIo.length).toBeGreaterThan(0);
      expect(host.netIo.length).toBeGreaterThan(0);
      host.diskIo.forEach((entry) => assertSeries(entry.bps, true));
      host.netIo.forEach((entry) => assertSeries(entry.bps, true));
    }
  });

  test('api.observability.user-and-container-metrics', coverageCase(
    'observability.audit-settings.user-and-container-metrics',
    'api.observability.user-and-container-metrics',
  ), async ({ adminApi, adminSession, seedState }) => {
    test.setTimeout(240_000);
    const serverId = seedState.servers[0].serverId;
    const name = `${currentRunId().slice(0, 38)}-${Date.now().toString(36)}-metrics`;
    let containerId: string | null = null;
    try {
      const created = await expectJson<AgentTaskRef>(await adminApi.post('/api/v2/containers', {
        data: { serverId, imageId: seedState.image.id, name },
      }), 201);
      const task = await waitForAgentTask(adminApi, created.taskId, { kind: 'container.create' });
      containerId = task.resourceId;

      const observed = await waitForWorkloadMetrics(
        adminApi,
        serverId,
        containerId,
        adminSession.user.id,
      );
      expect(observed.container.name).toBe(name);
      expect(observed.container.ownerId).toBe(adminSession.user.id);
      assertSeries(observed.container.cpu, true);
      assertSeries(observed.container.memUsed, true);
      assertSeries(observed.container.gpuMemUsed);
      assertSeries(observed.container.diskBps, true);
      assertSeries(observed.container.netBps, true);
      expect(observed.user.username).toBe(adminSession.user.username);
      assertSeries(observed.user.cpu, true);
      assertSeries(observed.user.memUsed, true);
      assertSeries(observed.user.diskUsed, true);
    } finally {
      if (containerId) await cleanupContainerThroughProductApi(adminApi, containerId);
    }
  });

  test('api.observability.cpu-only-gpu-series-empty', coverageCase(
    'observability.audit-settings.cpu-only-gpu-series-empty',
    'api.observability.cpu-only-gpu-series-empty',
  ), async ({ adminApi, seedState }) => {
    for (const server of seedState.servers) {
      const [admin, owner] = await Promise.all([
        expectJson<GpuMetrics>(await adminApi.get(`/api/admin/metrics/servers/${server.serverId}/gpus?range=1h`)),
        expectJson<GpuMetrics>(await adminApi.get(`/api/metrics/servers/${server.serverId}/gpus?range=1h`)),
      ]);
      expect(admin.gpus).toEqual([]);
      expect(owner.gpus).toEqual([]);
    }
  });

  test('api.observability.admin-and-owner-authorization', coverageCase(
    'observability.audit-settings.admin-and-owner-authorization',
    'api.observability.admin-and-owner-authorization',
  ), async ({ adminApi, trackedApiFactory, seedState }) => {
    const suffix = `${currentRunId().replaceAll('-', '').slice(-12)}${Date.now().toString(36)}`.slice(-24);
    const username = `metrics_${suffix}`;
    const password = `E2e-${suffix}-Access!`;
    let userId: string | null = null;
    try {
      const user = await expectJson<{ id: string }>(await adminApi.post('/api/admin/users', {
        data: { username, password, displayName: `Metrics ${suffix}` },
      }), 201);
      userId = user.id;
      const login = await expectJson<{ accessToken: string }>(await adminApi.post('/api/auth/login', {
        data: { username, password },
      }));
      const userApi = await trackedApiFactory({
        extraHTTPHeaders: { authorization: `Bearer ${login.accessToken}` },
      });
      const serverId = seedState.servers[0].serverId;
      expect((await userApi.get(`/api/admin/metrics/servers/${serverId}/host?range=1h`)).status()).toBe(403);
      expect((await userApi.get(`/api/metrics/servers/${serverId}/host?range=1h`)).status()).toBe(404);
      const admin = await expectJson<HostMetrics>(
        await adminApi.get(`/api/admin/metrics/servers/${serverId}/host?range=1h`),
      );
      assertSeries(admin.cpu, true);
    } finally {
      if (userId) await expectSuccess(await adminApi.delete(`/api/admin/users/${userId}`));
    }
  });

  test('api.observability.audit-pagination-and-detail', coverageCase(
    'observability.audit-settings.audit-pagination-and-detail',
    'api.observability.audit-pagination-and-detail',
  ), async ({ adminApi }) => {
    const first = await expectJson<AuditPage>(await adminApi.get('/api/audit?limit=2&offset=0'));
    expect(first).toEqual(expect.objectContaining({ limit: 2, offset: 0 }));
    expect(first.total).toBeGreaterThan(0);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThanOrEqual(2);
    const second = await expectJson<AuditPage>(await adminApi.get('/api/audit?limit=2&offset=1'));
    expect(second.offset).toBe(1);
    // Other core workers intentionally create real resources (and therefore
    // audit rows) in parallel. Pagination must remain valid while the total is
    // monotonically non-decreasing.
    expect(second.total).toBeGreaterThanOrEqual(first.total);
    const detail = await expectJson<AuditLog>(await adminApi.get(`/api/audit/${first.items[0].id}`));
    expect(detail.id).toBe(first.items[0].id);
    expect(Number.isNaN(Date.parse(detail.ts))).toBe(false);
  });

  test('api.observability.audit-resource-snapshots', coverageCase(
    'observability.audit-settings.audit-resource-snapshots',
    'api.observability.audit-resource-snapshots',
  ), async ({ adminApi, adminSession }) => {
    const name = `${currentRunId()} audit snapshot ${Date.now().toString(36)}`;
    let groupId: string | null = null;
    try {
      const group = await expectJson<{ id: string }>(await adminApi.post('/api/admin/groups', {
        data: { name, description: 'real E2E audit snapshot', capabilities: [] },
      }), 201);
      groupId = group.id;
      const log = await waitForAuditTarget(adminApi, group.id);
      expect(log.actorId).toBe(adminSession.user.id);
      expect(log.actorSnapshot).toEqual(expect.objectContaining({
        id: adminSession.user.id,
        type: 'user',
      }));
      expect(log.actorSnapshot?.labels?.username).toBe(adminSession.user.username);
      expect(log.targetSnapshot).toEqual(expect.objectContaining({
        id: group.id,
        type: 'group',
        name,
      }));
      expect(log.related).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: group.id, type: 'group', name }),
      ]));
    } finally {
      if (groupId) await expectSuccess(await adminApi.delete(`/api/admin/groups/${groupId}`));
    }
  });

  test('api.observability.editable-and-immutable-settings', coverageCase(
    'observability.audit-settings.editable-and-immutable-settings',
    'api.observability.editable-and-immutable-settings',
  ), async ({ adminApi }) => {
    const before = await getSettings(adminApi);
    const editable = requireEditable(before, 'branding.description');
    const original = String(editable.effectiveValue);
    const changed = `CPU E2E ${currentRunId()} ${Date.now().toString(36)}`;
    try {
      const updated = await patchSettings(adminApi, { 'branding.description': changed });
      expect(field(updated, 'branding.description').effectiveValue).toBe(changed);
      const immutable = field(updated, 'auth.jwtSecret');
      expect(immutable.secret).toBe(true);
      expect(immutable.editable).toBe(false);
      expect(updated.readOnly.map((entry) => entry.key)).toContain('auth.jwtSecret');
      const rejected = await adminApi.patch('/api/admin/system-settings', {
        data: {
          expectedRevision: updated.revision,
          expectedSnapshotToken: updated.snapshotToken,
          values: { 'auth.jwtSecret': 'must-not-change' },
        },
      });
      expect(rejected.status()).toBe(400);
      expect(field(await getSettings(adminApi), 'auth.jwtSecret').effectiveValue).toBe('********');
    } finally {
      await patchSettings(adminApi, { 'branding.description': original });
    }
  });

  test('api.observability.public-setting-propagation', coverageCase(
    'observability.audit-settings.public-setting-propagation',
    'api.observability.public-setting-propagation',
  ), async ({ adminApi, anonymousApi }) => {
    const before = await getSettings(adminApi);
    const editable = requireEditable(before, 'branding.title');
    const original = String(editable.effectiveValue);
    const changed = `nyabase-${currentRunId().slice(-12)}-${Date.now().toString(36)}`.slice(0, 80);
    try {
      await patchSettings(adminApi, { 'branding.title': changed });
      const propagated = await waitForPublicTitle(anonymousApi, changed);
      expect(propagated.branding.description).toBe(before.publicSettings.branding.description);
    } finally {
      await patchSettings(adminApi, { 'branding.title': original });
      await waitForPublicTitle(anonymousApi, original);
    }
  });

  test('api.observability.real-metrics-query-and-cpu-only-gpu-series', coverageCase(
    'observability.audit-settings.metrics-host-gpu-empty',
    'api.observability.real-metrics-query-and-cpu-only-gpu-series',
  ), async ({ adminApi, seedState }) => {
    const serverId = seedState.servers[0].serverId;
    const host = await waitForHostMetrics(adminApi, serverId);
    assertSeries(host.cpu, true);
    expect(host.disks.length).toBeGreaterThan(0);
    const gpu = await expectJson<GpuMetrics>(
      await adminApi.get(`/api/admin/metrics/servers/${serverId}/gpus?range=1h`),
    );
    expect(gpu.gpus).toEqual([]);
  });

  test('api.audit-and-settings.live-control-plane-readable', coverageCase(
    'observability.audit-settings.audit-settings-readable',
    'api.audit-and-settings.live-control-plane-readable',
  ), async ({ adminApi }) => {
    const audit = await expectJson<AuditPage>(await adminApi.get('/api/audit?limit=20&offset=0'));
    expect(audit.items).toEqual(expect.any(Array));
    expect(audit.total).toBeGreaterThanOrEqual(audit.items.length);
    const settings = await getSettings(adminApi);
    expect(settings.configFile).toMatch(/^\//);
    expect(settings.fields.length).toBe(settings.editable.length + settings.readOnly.length);
    expect(settings.publicSettings.branding.title).not.toBe('');
  });

  test('api.audit.list-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-audit',
    'api.audit.list-exact-contract',
  ), async ({ adminApi }) => {
    const audit = await expectJson<AuditPage>(await adminApi.get('/api/audit?limit=3&offset=0'));
    expect(audit.limit).toBe(3);
    expect(audit.offset).toBe(0);
    expect(audit.total).toBeGreaterThanOrEqual(audit.items.length);
    audit.items.forEach(assertAuditLog);
  });

  test('api.audit.detail-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-audit-by-id',
    'api.audit.detail-exact-contract',
  ), async ({ adminApi }) => {
    const page = await expectJson<AuditPage>(await adminApi.get('/api/audit?limit=1&offset=0'));
    expect(page.items).toHaveLength(1);
    const detail = await expectJson<AuditLog>(await adminApi.get(`/api/audit/${page.items[0].id}`));
    assertAuditLog(detail);
    expect(detail).toEqual(page.items[0]);
  });

  test('api.catalog.metric-servers-purpose-safe-projection', coverageCase(
    'observability.audit-settings.catalog-metric-servers-projection',
    'api.catalog.metric-servers-purpose-safe-projection',
  ), async ({ adminApi, anonymousApi, seedState }) => {
    expect((await anonymousApi.get('/api/admin/catalog/metric-servers')).status()).toBe(401);
    const servers = await expectJson<CatalogMetricServerView[]>(
      await adminApi.get('/api/admin/catalog/metric-servers'),
    );
    for (const seeded of seedState.servers) {
      expect(servers.map((server) => server.id)).toContain(seeded.serverId);
    }
    servers.forEach((server) => {
      expect(Object.keys(server).sort()).toEqual(
        ['id', 'name', 'slug', 'status', 'runtimeReady', 'hasGpu'].sort(),
      );
      expect(typeof server.runtimeReady).toBe('boolean');
      expect(server.hasGpu).toBe(false);
    });
  });

  test('api.metrics.admin-containers-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-admin-metrics-servers-by-id-containers',
    'api.metrics.admin-containers-exact-contract',
  ), async ({ adminApi, seedState }) => {
    assertContainerMetrics(await expectJson<ContainerMetrics>(
      await adminApi.get(`/api/admin/metrics/servers/${seedState.servers[0].serverId}/containers?range=1h`),
    ));
  });

  test('api.metrics.admin-gpus-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-admin-metrics-servers-by-id-gpus',
    'api.metrics.admin-gpus-exact-contract',
  ), async ({ adminApi, seedState }) => {
    const data = await expectJson<GpuMetrics>(
      await adminApi.get(`/api/admin/metrics/servers/${seedState.servers[0].serverId}/gpus?range=1h`),
    );
    expect(data.gpus).toEqual([]);
  });

  test('api.metrics.admin-host-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-admin-metrics-servers-by-id-host',
    'api.metrics.admin-host-exact-contract',
  ), async ({ adminApi, seedState }) => {
    assertHostMetrics(await expectJson<HostMetrics>(
      await adminApi.get(`/api/admin/metrics/servers/${seedState.servers[0].serverId}/host?range=1h`),
    ));
  });

  test('api.metrics.admin-users-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-admin-metrics-servers-by-id-users',
    'api.metrics.admin-users-exact-contract',
  ), async ({ adminApi, seedState }) => {
    assertUserMetrics(await expectJson<UserMetrics>(
      await adminApi.get(`/api/admin/metrics/servers/${seedState.servers[0].serverId}/users?range=1h`),
    ));
  });

  test('api.metrics.owner-containers-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-metrics-servers-by-id-containers',
    'api.metrics.owner-containers-exact-contract',
  ), async ({ adminApi, seedState }) => {
    assertContainerMetrics(await expectJson<ContainerMetrics>(
      await adminApi.get(`/api/metrics/servers/${seedState.servers[0].serverId}/containers?range=1h`),
    ));
  });

  test('api.metrics.owner-gpus-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-metrics-servers-by-id-gpus',
    'api.metrics.owner-gpus-exact-contract',
  ), async ({ adminApi, seedState }) => {
    const data = await expectJson<GpuMetrics>(
      await adminApi.get(`/api/metrics/servers/${seedState.servers[0].serverId}/gpus?range=1h`),
    );
    expect(data.gpus).toEqual([]);
  });

  test('api.metrics.owner-host-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-metrics-servers-by-id-host',
    'api.metrics.owner-host-exact-contract',
  ), async ({ adminApi, seedState }) => {
    assertHostMetrics(await expectJson<HostMetrics>(
      await adminApi.get(`/api/metrics/servers/${seedState.servers[0].serverId}/host?range=1h`),
    ));
  });

  test('api.metrics.owner-users-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-metrics-servers-by-id-users',
    'api.metrics.owner-users-exact-contract',
  ), async ({ adminApi, seedState }) => {
    assertUserMetrics(await expectJson<UserMetrics>(
      await adminApi.get(`/api/metrics/servers/${seedState.servers[0].serverId}/users?range=1h`),
    ));
  });

  test('api.settings.admin-get-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-admin-system-settings',
    'api.settings.admin-get-exact-contract',
  ), async ({ adminApi }) => {
    const settings = await getSettings(adminApi);
    expect(settings.fields.length).toBeGreaterThan(0);
    expect(settings.editable.every((entry) => entry.editable)).toBe(true);
    expect(settings.readOnly.every((entry) => !entry.editable)).toBe(true);
  });

  test('api.settings.public-get-exact-contract', coverageCase(
    'observability.audit-settings.http.get.api-public-settings',
    'api.settings.public-get-exact-contract',
  ), async ({ anonymousApi }) => {
    const settings = await expectJson<PublicSettings>(await anonymousApi.get('/api/public/settings'));
    expect(settings.branding.title).not.toBe('');
    expect(settings.branding.description).not.toBe('');
  });

  test('api.settings.admin-patch-exact-contract', coverageCase(
    'observability.audit-settings.http.patch.api-admin-system-settings',
    'api.settings.admin-patch-exact-contract',
  ), async ({ adminApi }) => {
    const before = await getSettings(adminApi);
    const editable = requireEditable(before, 'ssh.proxyPublicHost');
    const original = String(editable.effectiveValue);
    const changed = `${currentRunId()}.e2e.invalid`;
    try {
      const updated = await patchSettings(adminApi, { 'ssh.proxyPublicHost': changed });
      expect(field(updated, 'ssh.proxyPublicHost').effectiveValue).toBe(changed);
      expect(updated.revision).toBe(before.revision + 1);
      expect(
        (
          await adminApi.patch('/api/admin/system-settings', {
            data: {
              expectedRevision: before.revision,
              expectedSnapshotToken: before.snapshotToken,
              values: { 'ssh.proxyPublicHost': original },
            },
          })
        ).status(),
      ).toBe(409);
      expect(field(await getSettings(adminApi), 'ssh.proxyPublicHost').effectiveValue).toBe(changed);
    } finally {
      await patchSettings(adminApi, { 'ssh.proxyPublicHost': original });
    }
  });
});

function assertSeries(series: MetricSeries, requireValue = false): void {
  expect(series.step).toBeGreaterThan(0);
  expect(Array.isArray(series.points)).toBe(true);
  let previous = -Infinity;
  for (const point of series.points) {
    expect(Number.isFinite(point.t)).toBe(true);
    expect(point.t).toBeGreaterThanOrEqual(previous);
    expect(point.v === null || Number.isFinite(point.v)).toBe(true);
    previous = point.t;
  }
  if (requireValue) {
    expect(series.points.some((point) => point.v !== null)).toBe(true);
  }
}

function assertHostMetrics(host: HostMetrics): void {
  assertSeries(host.cpu);
  assertSeries(host.memUsed);
  assertSeries(host.memTotal);
  assertSeries(host.load1);
  expect(host.disks).toEqual(expect.any(Array));
  expect(host.diskIo).toEqual(expect.any(Array));
  expect(host.netIo).toEqual(expect.any(Array));
}

function assertUserMetrics(metrics: UserMetrics): void {
  expect(metrics.users).toEqual(expect.any(Array));
  for (const user of metrics.users) {
    expect(user.userId).not.toBe('');
    expect(user.username).not.toBe('');
    for (const value of [user.cpu, user.memUsed, user.gpuMemUsed, user.diskBps, user.netBps, user.diskUsed]) {
      assertSeries(value);
    }
  }
}

function assertContainerMetrics(metrics: ContainerMetrics): void {
  expect(metrics.containers).toEqual(expect.any(Array));
  for (const container of metrics.containers) {
    expect(container.containerId).not.toBe('');
    expect(container.name).not.toBe('');
    for (const value of [container.cpu, container.memUsed, container.gpuMemUsed, container.diskBps, container.netBps]) {
      assertSeries(value);
    }
  }
}

function assertAuditLog(log: AuditLog): void {
  expect(log.id).not.toBe('');
  expect(log.action).not.toBe('');
  expect(Number.isNaN(Date.parse(log.ts))).toBe(false);
  expect(log.related).toEqual(expect.any(Array));
}

async function waitForHostMetrics(api: APIRequestContext, serverId: string): Promise<HostMetrics> {
  const deadline = Date.now() + 120_000;
  let last: HostMetrics | null = null;
  while (Date.now() < deadline) {
    last = await expectJson<HostMetrics>(
      await api.get(`/api/admin/metrics/servers/${serverId}/host?range=1h`),
    );
    const series = [
      last.cpu,
      last.memUsed,
      last.memTotal,
      last.load1,
      ...last.disks.flatMap((entry) => [entry.used, entry.total]),
      ...last.diskIo.map((entry) => entry.bps),
      ...last.netIo.map((entry) => entry.bps),
    ];
    if (
      last.disks.length > 0
      && last.diskIo.length > 0
      && last.netIo.length > 0
      && series.every((entry) => entry.points.some((point) => point.v !== null))
    ) return last;
    await delay(1_000);
  }
  throw new Error(`host metrics did not converge for server ${serverId}; last response shape=${JSON.stringify({
    cpu: last?.cpu.points.length ?? 0,
    disks: last?.disks.length ?? 0,
    diskIo: last?.diskIo.length ?? 0,
    netIo: last?.netIo.length ?? 0,
  })}`);
}

async function waitForWorkloadMetrics(
  api: APIRequestContext,
  serverId: string,
  containerId: string,
  ownerId: string,
): Promise<{ container: ContainerMetrics['containers'][number]; user: UserMetrics['users'][number] }> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const [containers, users] = await Promise.all([
      expectJson<ContainerMetrics>(await api.get(`/api/admin/metrics/servers/${serverId}/containers?range=1h`)),
      expectJson<UserMetrics>(await api.get(`/api/admin/metrics/servers/${serverId}/users?range=1h`)),
    ]);
    const container = containers.containers.find((entry) => entry.containerId === containerId);
    const user = users.users.find((entry) => entry.userId === ownerId);
    if (
      container
      && user
      && [container.cpu, container.memUsed, container.diskBps, container.netBps, user.cpu, user.memUsed, user.diskUsed]
        .every((entry) => entry.points.some((point) => point.v !== null))
    ) return { container, user };
    await delay(1_000);
  }
  throw new Error(`real workload metrics did not converge for container ${containerId}`);
}

async function waitForAuditTarget(api: APIRequestContext, targetId: string): Promise<AuditLog> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = await expectJson<AuditPage>(await api.get('/api/audit?limit=100&offset=0'));
    const found = page.items.find((entry) => entry.targetId === targetId);
    if (found) return expectJson<AuditLog>(await api.get(`/api/audit/${found.id}`));
    await delay(250);
  }
  throw new Error(`audit entry did not converge for target ${targetId}`);
}

async function getSettings(api: APIRequestContext): Promise<SystemSettings> {
  return expectJson<SystemSettings>(await api.get('/api/admin/system-settings'));
}

async function patchSettings(api: APIRequestContext, values: Record<string, unknown>): Promise<SystemSettings> {
  const current = await getSettings(api);
  return expectJson<SystemSettings>(
    await api.patch('/api/admin/system-settings', {
      data: {
        expectedRevision: current.revision,
        expectedSnapshotToken: current.snapshotToken,
        values,
      },
    }),
  );
}

function field(settings: SystemSettings, key: string): SystemSettingField {
  const found = settings.fields.find((entry) => entry.key === key);
  if (!found) throw new Error(`system setting ${key} is absent`);
  return found;
}

function requireEditable(settings: SystemSettings, key: string): SystemSettingField {
  const found = field(settings, key);
  expect(found.editable).toBe(true);
  expect(found.restartRequired).toBe(false);
  expect(found.source).not.toBe('env');
  return found;
}

async function waitForPublicTitle(api: APIRequestContext, title: string): Promise<PublicSettings> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const settings = await expectJson<PublicSettings>(await api.get('/api/public/settings'));
    if (settings.branding.title === title) return settings;
    await delay(250);
  }
  throw new Error(`public branding did not converge to the expected title (${title.length} chars)`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
