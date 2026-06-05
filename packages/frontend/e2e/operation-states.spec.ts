import { expect, test, type Page, type Route } from '@playwright/test';

const visualNow = '2026-06-03T13:00:00.000Z';

const adminUser = {
  id: 'user-admin',
  username: 'admin',
  displayName: 'Ada Admin',
  status: 'active',
  createdAt: '2026-06-01T00:00:00.000Z',
  capabilities: [
    'manage_servers',
    'manage_images',
    'manage_containers_any',
    'view_metrics_all',
    'view_audit',
  ],
  groups: [],
};

const server = {
  id: 'srv-gpu',
  name: 'gpu-lab-01',
  parentIface: 'bond0',
  ipCidr: '10.8.110.0/24',
  gateway: '10.8.110.1',
  isGpuServer: true,
  status: 'online',
  lastSeenAt: '2026-06-03T01:30:00.000Z',
  defaultCpuMillis: 8000,
  defaultMemBytes: 64 * 1024 ** 3,
  defaultDiskBytes: 100 * 1024 ** 3,
  defaultGpuMode: 'indices',
  defaultGpuIndices: [0],
  disks: [],
  gpus: [{ index: 0, uuid: 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0000', model: 'NVIDIA L40', totalMemMiB: 46068 }],
  agentVersion: '0.1.0',
  dockerRoot: '/data/nyabase-docker',
  dockerSocket: '/run/nyabase-agent/docker.sock',
  dockerDaemon: {
    serverId: 'srv-gpu',
    state: 'active',
    unitFileInSync: true,
    enabled: true,
    active: true,
    pid: 4242,
    dockerRoot: '/data/nyabase-docker',
    socketPath: '/run/nyabase-agent/docker.sock',
    serverVersion: '29.0.2',
    storageDriver: 'overlay2',
    lastError: null,
    checkedAt: 1780315200000,
  },
};

const disk = {
  diskId: 'disk-data',
  mountPoint: '/data',
  label: 'Data SSD',
  totalBytes: 2 * 1024 ** 4,
  usedBytes: 640 * 1024 ** 3,
  pquotaEnabled: true,
};

const image = {
  id: 'img-cuda',
  name: 'cuda-pytorch',
  dockerImage: 'nvcr.io/nvidia/pytorch:24.05-py3',
  defaultUid: 1001,
  description: 'GPU notebook image',
  isActive: true,
  entrypoint: null,
  cmd: 'sleep infinity',
};

const pendingContainer = containerView({
  id: 'op-pending-container',
  runtimeId: 'docker-op-pending-container',
  name: 'train-pending',
  ip: '10.8.110.31',
  status: 'exited',
  activeOperation: operation({
    id: 'opstart123456789',
    kind: 'container.start',
    status: 'waiting_agent',
    resourceId: 'op-pending-container',
  }),
});

const failedContainer = containerView({
  id: 'op-failed-container',
  runtimeId: 'docker-op-failed-container',
  name: 'train-failed',
  ip: '10.8.110.32',
  status: 'exited',
  ssh: {
    enabled: true,
    status: 'error',
    user: 'root',
    port: 22,
    lastError: 'authorized_keys sync failed',
  },
  activeOperation: operation({
    id: 'opdelete12345678',
    kind: 'container.delete',
    status: 'failed',
    resourceId: 'op-failed-container',
    attempts: 3,
    lastError: 'agent reported: container still has active exec sessions',
    startedAt: '2026-06-03T01:35:00.000Z',
    completedAt: '2026-06-03T01:36:00.000Z',
  }),
});

const remoteMount = {
  id: 'remote-shared',
  name: 'shared-nfs',
  displayName: 'Shared NFS',
  description: 'Team dataset export',
  type: 'nfs',
  options: 'rw,vers=4.2',
  hostMountPoint: '/mnt/shared-nfs',
  params: { type: 'nfs', nfsServer: '10.8.96.92', exportPath: '/srv/shared', version: '4.2' },
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
  serverIds: ['srv-gpu'],
  serverStatuses: {
    'srv-gpu': {
      id: 'remote-shared',
      hostMountPoint: '/mnt/shared-nfs',
      status: 'mounted',
      lastCheckedAt: 1780315200000,
      totalBytes: 10 * 1024 ** 4,
      usedBytes: 2 * 1024 ** 4,
    },
  },
};

const dataDirs = [
  {
    id: 'dd-local',
    sourceKind: 'local',
    sourceId: 'disk-data',
    name: 'scratch-a',
    hostPath: '/data/scratch-a',
    userId: 'user-admin',
    serverId: 'srv-gpu',
    serverName: 'gpu-lab-01',
  },
];

test.describe('operation state visual coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(visualNow);
    await seedAuth(page);
    await mockApi(page);
  });

  test('containers list renders refreshed pending and failed operations', async ({ page }) => {
    await page.goto('/containers');

    await expect(page.getByRole('heading', { name: '容器' })).toBeVisible();
    await expect(page.getByText('train-pending')).toBeVisible();
    await expect(page.getByText('train-failed')).toBeVisible();

    const pendingRow = page.locator('div.flex.items-center.gap-4').filter({ hasText: 'train-pending' });
    await expect(pendingRow.locator('button:disabled')).toHaveCount(4);
    await expect.soft(page).toHaveScreenshot('containers-operation-states.png', { fullPage: true });
  });

  test('container detail renders terminal operation failure after refresh', async ({ page }) => {
    await page.goto('/containers/op-failed-container');

    await expect(page.getByRole('heading', { name: 'train-failed' })).toBeVisible();
    await expect(page.getByText('train-failed')).toBeVisible();
    await expect.soft(page).toHaveScreenshot('container-detail-operation-failure.png', { fullPage: true });
  });

  test('create container flow keeps queued operation feedback visible', async ({ page }) => {
    await page.goto('/containers');

    await page.getByRole('button', { name: '新建容器', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建容器' });
    await expect(dialog).toBeVisible();

    await dialog.locator('select').nth(0).selectOption('srv-gpu');
    await dialog.locator('select').nth(1).selectOption('img-cuda');
    await dialog.getByPlaceholder('my-dev-env').fill('queued-container');
    await dialog.getByRole('button', { name: '创建' }).click();
    await expect(dialog.getByRole('button', { name: '创建中...' })).toBeDisabled();

    await expect(page.getByText('容器创建已排队', { exact: true })).toBeVisible();
    await expect(page.getByText('操作 opcreate', { exact: true })).toBeVisible();
    await expect.soft(page).toHaveScreenshot('create-container-queued-toast.png', { fullPage: true });
  });

  test('data directory delete flow shows queued operation reference', async ({ page }) => {
    await page.goto('/data-dirs');

    await expect(page.getByText('scratch-a')).toBeVisible();
    const dirRow = page.locator('div.flex.items-center.justify-between').filter({ hasText: 'scratch-a' }).first();
    await dirRow.getByRole('button').click();
    const dialog = page.getByRole('alertdialog', { name: '删除目录' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '删除' }).click();

    await expect(page.getByText('目录删除已排队', { exact: true })).toBeVisible();
    await expect(page.getByText('操作 opdatade', { exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot('data-dirs-delete-queued-toast.png', { fullPage: true });
  });

  test('remote filesystem assignment disables controls while queuing and shows operation reference', async ({ page }) => {
    await page.goto('/manage/remote-fs');

    await page.getByTitle('管理服务器分配').click();
    const dialog = page.getByRole('dialog', { name: /shared-nfs/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('选择此挂载应在哪些服务器上生效')).toBeVisible();
    await expect(page).toHaveScreenshot('remote-fs-assignment-queued-toast.png', { fullPage: true });
  });

  test('server data disk apply disables submit while queuing and shows operation reference', async ({ page }) => {
    await page.goto('/servers/srv-gpu');

    await page.getByRole('button', { name: '添加' }).click();
    const dialog = page.getByRole('dialog', { name: '添加数据盘' });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('/data').fill('/fast');
    await dialog.getByPlaceholder('例如：主存储').fill('Fast SSD');
    await dialog.getByRole('button', { name: '添加' }).click();
    await expect(dialog.getByRole('button', { name: '添加中...' })).toBeDisabled();

    await expect(page.getByText('数据盘添加已排队', { exact: true })).toBeVisible();
    await expect(page.getByText('操作 opdiskad', { exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot('server-disk-add-queued-toast.png', { fullPage: true });
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
    const method = route.request().method();

    if (path === '/admin/servers') return json(route, [server]);
    if (path === '/servers') return json(route, [server]);
    if (path === '/admin/servers/srv-gpu' || path === '/servers/srv-gpu') return json(route, server);
    if (path === '/admin/servers/srv-gpu/disks' || path === '/servers/srv-gpu/disks') {
      if (method === 'POST') {
        await delay();
        return json(route, { ...disk, diskId: 'disk-fast', mountPoint: '/fast', label: 'Fast SSD', operationId: 'opdiskad123456' });
      }
      return json(route, [disk]);
    }
    if (path === '/servers/srv-gpu/disks/disk-data' && method === 'DELETE') {
      return json(route, { ok: true, operationId: 'opdiskde123456', status: 'queued' });
    }
    if (path.startsWith('/metrics/servers/srv-gpu/host')) return json(route, hostMetrics());
    if (path.startsWith('/metrics/servers/srv-gpu/gpus')) return json(route, gpuMetrics());
    if (path === '/admin/data-dirs/issues') return json(route, []);

    if (path === '/me/access') {
      return json(route, {
        servers: [{
          serverId: 'srv-gpu',
          cpuMillis: 4000,
          memBytes: 16 * 1024 ** 3,
          diskBytes: 80 * 1024 ** 3,
          gpuMode: 'indices',
          gpuIndices: [0],
          allowedImageIds: ['img-cuda'],
        }],
      });
    }
    if (path === '/images') return json(route, [image]);

    if (path === '/v2/containers') {
      if (method === 'POST') {
        await delay();
        return json(route, { ok: true, operationId: 'opcreate123456', status: 'queued' });
      }
      return json(route, [pendingContainer, failedContainer]);
    }
    if (path === '/v2/containers/op-pending-container') return json(route, pendingContainer);
    if (path === '/v2/containers/op-failed-container') return json(route, failedContainer);
    if (path.startsWith('/operations/')) {
      return json(route, {
        id: path.split('/').pop(),
        kind: 'container.create',
        status: 'succeeded',
        resourceType: 'container',
        resourceId: 'op-pending-container',
        serverId: 'srv-gpu',
        attempts: 1,
        lastError: null,
        createdAt: '2026-06-03T01:30:00.000Z',
        startedAt: '2026-06-03T01:30:01.000Z',
        completedAt: '2026-06-03T01:30:02.000Z',
      });
    }

    if (path === '/data-dirs') {
      if (method === 'POST') {
        await delay();
        return json(route, { ...dataDirs[0], name: 'new-dataset', operationId: 'opdatacr123456' });
      }
      return json(route, url.searchParams.get('serverId') === 'srv-gpu' || url.searchParams.size === 0 ? dataDirs : []);
    }
    if (path === '/data-dirs/srv-gpu/disk-data/scratch-a' && method === 'DELETE') {
      return json(route, { ok: true, operationId: 'opdatade123456', status: 'queued' });
    }
    if (path === '/mount-sources') {
      return json(route, [
        { kind: 'local', id: 'disk-data', serverId: 'srv-gpu', label: '本地 · Data SSD', hostRoot: '/data' },
        { kind: 'remote', id: 'remote-shared', serverId: 'srv-gpu', label: 'Shared NFS', description: 'Team dataset export', hostRoot: '/mnt/shared-nfs' },
      ]);
    }

    if (path === '/admin/remote-fs-mounts') return json(route, [remoteMount]);
    if (path === '/admin/remote-fs-mounts/remote-shared/servers/srv-gpu' && method === 'DELETE') {
      await delay();
      return json(route, { operationIds: ['opremote123456'] });
    }

    return json(route, {}, 404);
  });
}

function operation(input: {
  id: string;
  kind: string;
  status: string;
  resourceId: string;
  attempts?: number;
  lastError?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}) {
  return {
    resourceType: 'container',
    serverId: 'srv-gpu',
    attempts: 1,
    lastError: null,
    createdAt: '2026-06-03T01:30:00.000Z',
    startedAt: null,
    completedAt: null,
    ...input,
  };
}

function containerView(input: {
  id: string;
  runtimeId: string;
  name: string;
  ip: string;
  status: string;
  activeOperation: ReturnType<typeof operation> | null;
  ssh?: {
    enabled: boolean;
    status: string;
    user: 'root';
    port: 22;
    lastError?: string;
  };
}) {
  const running = input.status === 'running';
  const activeOperation = input.activeOperation;
  const allDisabled = {
    start: { enabled: false, reason: 'operation_in_progress', message: 'Operation is still running' },
    stop: { enabled: false, reason: 'operation_in_progress', message: 'Operation is still running' },
    restart: { enabled: false, reason: 'operation_in_progress', message: 'Operation is still running' },
    delete: { enabled: false, reason: 'operation_in_progress', message: 'Operation is still running' },
    stats: { enabled: false, reason: 'operation_in_progress', message: 'Operation is still running' },
    console: { enabled: false, reason: 'operation_in_progress', message: 'Operation is still running' },
    updateMounts: { enabled: false, reason: 'operation_in_progress', message: 'Operation is still running' },
    enableSsh: { enabled: false, reason: 'operation_in_progress', message: 'Operation is still running' },
    reconcileSsh: { enabled: false, reason: 'operation_in_progress', message: 'Operation is still running' },
  };

  return {
    id: input.id,
    serverId: 'srv-gpu',
    serverName: 'gpu-lab-01',
    ownerId: 'user-admin',
    ownerName: 'Ada Admin',
    name: input.name,
    imageId: 'img-cuda',
    phase: activeOperation ? 'updating' : 'active',
    powerIntent: running ? 'running' : 'stopped',
    runtime: {
      bound: true,
      runtimeId: input.runtimeId,
      status: input.status,
      ip: input.ip,
      observedAt: '2026-06-03T01:30:00.000Z',
      stale: false,
      drift: [],
    },
    activeOperation,
    resources: {
      cpuMillis: 2000,
      memBytes: 8 * 1024 ** 3,
      diskBytes: 80 * 1024 ** 3,
      gpuIndices: [0],
    },
    ssh: input.ssh ?? { enabled: false, status: 'disabled', user: 'root', port: 22 },
    mounts: [],
    actions: activeOperation ? allDisabled : {
      start: running ? { enabled: false, reason: 'phase_not_active', message: 'Container is not stopped' } : { enabled: true },
      stop: running ? { enabled: true } : { enabled: false, reason: 'phase_not_active', message: 'Container is not running' },
      restart: running ? { enabled: true } : { enabled: false, reason: 'phase_not_active', message: 'Container is not running' },
      delete: { enabled: true },
      stats: running ? { enabled: true } : { enabled: false, reason: 'phase_not_active', message: 'Container is not running' },
      console: running ? { enabled: true } : { enabled: false, reason: 'phase_not_active', message: 'Container is not running' },
      updateMounts: { enabled: true },
      enableSsh: { enabled: true },
      reconcileSsh: running ? { enabled: true } : { enabled: false, reason: 'phase_not_active', message: 'Container is not running' },
    },
  };
}

function hostMetrics() {
  return {
    cpu: metricSeries([0.18, 0.22, 0.2]),
    memUsed: metricSeries([10 * 1024 ** 3, 11 * 1024 ** 3, 10.5 * 1024 ** 3]),
    memTotal: metricSeries([64 * 1024 ** 3, 64 * 1024 ** 3, 64 * 1024 ** 3]),
    load1: metricSeries([1.2, 1.4, 1.1]),
    disks: [],
    diskIo: [],
    netIo: [],
  };
}

function gpuMetrics() {
  return {
    gpus: [{
      index: 0,
      model: 'NVIDIA L40',
      memTotalMiB: 46068,
      util: metricSeries([0.2, 0.24, 0.18]),
      memUsed: metricSeries([2 * 1024 ** 3, 2.2 * 1024 ** 3, 2.1 * 1024 ** 3]),
      temp: metricSeries([42, 43, 42]),
      power: metricSeries([95, 105, 98]),
      graphicsClockMHz: metricSeries([900, 930, 910]),
    }],
  };
}

function metricSeries(values: number[]) {
  return {
    step: 60,
    points: values.map((v, i) => ({ t: 1780315200 + i * 60, v })),
  };
}

async function delay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
