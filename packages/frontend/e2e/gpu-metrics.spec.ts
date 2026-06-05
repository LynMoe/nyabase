import { expect, test, type Page } from '@playwright/test';

const adminUser = {
  id: 'user-admin',
  username: 'admin',
  displayName: 'Admin User',
  status: 'active',
  createdAt: '2026-06-01T00:00:00.000Z',
  capabilities: [
    'manage_users',
    'manage_groups',
    'manage_servers',
    'manage_images',
    'manage_containers_any',
    'view_metrics_all',
    'view_audit',
  ],
  groups: [],
};

const gpuServer = {
  id: 'srv-gpu',
  name: 'gpu-lab-01',
  parentIface: 'bond0',
  ipCidr: '10.8.110.0/24',
  gateway: '10.8.0.1',
  isGpuServer: true,
  status: 'online',
  lastSeenAt: '2026-06-01T12:00:00.000Z',
  defaultCpuMillis: 8000,
  defaultMemBytes: 68719476736,
  defaultDiskBytes: 107374182400,
  defaultGpuMode: 'all',
  defaultGpuIndices: [0],
  disks: [],
  gpus: [{ index: 0, uuid: 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0000', model: 'NVIDIA L40', totalMemMiB: 46068 }],
  agentVersion: '0.1.0',
  dockerRoot: '/data0/nbTest/nyabase-docker',
  dockerSocket: '/run/nyabase-agent/docker.sock',
  dockerDaemon: {
    serverId: 'srv-gpu',
    state: 'active',
    unitFileInSync: true,
    enabled: true,
    active: true,
    pid: 4242,
    dockerRoot: '/data0/nbTest/nyabase-docker',
    socketPath: '/run/nyabase-agent/docker.sock',
    serverVersion: '29.0.2',
    storageDriver: 'overlay2',
    lastError: null,
    checkedAt: 1780315200000,
  },
};

const container = containerView({
  id: 'ctr-cuda-notebook',
  runtimeId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  name: 'cuda-notebook',
  ip: '10.8.110.20',
  sshEnabled: true,
});

test.describe('authenticated GPU rendering', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
    await mockApi(page);
  });

  test('server GPU metrics show the graphics clock chart', async ({ page }) => {
    await page.goto('/servers/srv-gpu');

    await expect(page.getByRole('heading', { name: 'gpu-lab-01' })).toBeVisible();
    await expect(page.getByText('NVIDIA L40')).toBeVisible();
    await expect(page.getByText('46068 MiB')).toBeVisible();
    await expect(page.getByText('GPU', { exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot('server-gpu-clock.png');
  });

  test('container detail shows positive GPU memory rows', async ({ page }) => {
    await page.goto('/containers/ctr-cuda-notebook');

    await expect(page.getByRole('heading', { name: 'cuda-notebook' })).toBeVisible();
    await expect(page.getByText('GPU 显存')).toBeVisible();
    await expect(page.getByText('GPU 显存')).toBeVisible();
    await expect(page).toHaveScreenshot('container-gpu-memory.png', { fullPage: true });
  });
});

async function seedAuth(page: Page): Promise<void> {
  await page.addInitScript((user) => {
    window.localStorage.setItem('nyabase-auth', JSON.stringify({
      state: {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        user,
      },
      version: 0,
    }));
  }, adminUser);
}

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');

    if (path === '/admin/servers/srv-gpu' || path === '/servers/srv-gpu') return json(route, gpuServer);
    if (path === '/admin/servers/srv-gpu/disks' || path === '/servers/srv-gpu/disks') return json(route, []);
    if (path === '/metrics/servers/srv-gpu/host') {
      return json(route, {
        cpu: metricSeries([0.18, 0.24, 0.2]),
        memUsed: metricSeries([24 * 1024 ** 3, 25 * 1024 ** 3, 26 * 1024 ** 3]),
        memTotal: metricSeries([128 * 1024 ** 3, 128 * 1024 ** 3, 128 * 1024 ** 3]),
        load1: metricSeries([1.2, 1.4, 1.1]),
        disks: [],
        diskIo: [],
        netIo: [],
      });
    }
    if (path === '/metrics/servers/srv-gpu/gpus') {
      return json(route, {
        gpus: [{
          index: 0,
          model: 'NVIDIA L40',
          memTotalMiB: 46068,
          util: metricSeries([0.31, 0.44, 0.52]),
          memUsed: metricSeries([3 * 1024 ** 3, 4 * 1024 ** 3, 5 * 1024 ** 3]),
          temp: metricSeries([38, 40, 41]),
          power: metricSeries([72, 78, 81]),
          graphicsClockMHz: metricSeries([1200, 1320, 1410]),
        }],
      });
    }
    if (path === '/v2/containers/ctr-cuda-notebook') return json(route, container);
    if (path === '/v2/containers/ctr-cuda-notebook/stats') {
      return json(route, {
        containerId: 'ctr-cuda-notebook',
        ts: 1780315200000,
        stats: {
          cpuUsageRatio: 0.42,
          memUsedBytes: 3 * 1024 ** 3,
          memLimitBytes: 8 * 1024 ** 3,
          netRxBytes: 123456,
          netTxBytes: 654321,
          blockReadBytes: 4096,
          blockWriteBytes: 8192,
          gpuMemUsedMiB: {
            'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0000': 768,
            'GPU-zero': 0,
            'GPU-invalid': Number.NaN,
          },
        },
      });
    }
    if (path === '/metrics/servers/srv-gpu/containers') {
      return json(route, {
        containers: [{
          containerId: 'ctr-cuda-notebook',
          name: 'cuda-notebook',
          ownerId: 'user-admin',
          cpu: metricSeries([0.25, 0.42, 0.36]),
          memUsed: metricSeries([2 * 1024 ** 3, 3 * 1024 ** 3, 2.7 * 1024 ** 3]),
          gpuMemUsed: metricSeries([512 * 1024 ** 2, 768 * 1024 ** 2, 640 * 1024 ** 2]),
          diskBps: metricSeries([4096, 8192, 4096]),
          netBps: metricSeries([123456, 654321, 234567]),
        }],
      });
    }
    if (path === '/data-dirs') return json(route, []);
    if (path === '/mount-sources') return json(route, []);

    return json(route, {}, 404);
  });
}

function containerView(input: { id: string; runtimeId: string; name: string; ip: string; sshEnabled: boolean }) {
  return {
    id: input.id,
    serverId: 'srv-gpu',
    serverName: 'gpu-lab-01',
    ownerId: 'user-admin',
    ownerName: 'Admin User',
    name: input.name,
    imageId: 'img-cuda',
    phase: 'active',
    powerIntent: 'running',
    runtime: {
      bound: true,
      runtimeId: input.runtimeId,
      status: 'running',
      ip: input.ip,
      observedAt: '2026-06-01T12:00:00.000Z',
      stale: false,
      drift: [],
    },
    activeOperation: null,
    resources: {
      cpuMillis: 2000,
      memBytes: 8589934592,
      diskBytes: 107374182400,
      gpuIndices: [0],
    },
    ssh: {
      enabled: input.sshEnabled,
      status: input.sshEnabled ? 'running' : 'disabled',
      user: 'root',
      port: 22,
    },
    mounts: [],
    actions: {
      start: { enabled: false, reason: 'phase_not_active', message: 'Container is not stopped' },
      stop: { enabled: true },
      restart: { enabled: true },
      delete: { enabled: true },
      stats: { enabled: true },
      console: { enabled: true },
      updateMounts: { enabled: true },
      enableSsh: input.sshEnabled ? { enabled: false, message: 'SSH 已启用' } : { enabled: true },
      reconcileSsh: { enabled: true },
    },
  };
}

function metricSeries(values: number[]) {
  return {
    step: 60,
    points: values.map((v, i) => ({ t: 1780315200 + i * 60, v })),
  };
}

function json(route: Parameters<Parameters<Page['route']>[1]>[0], body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
