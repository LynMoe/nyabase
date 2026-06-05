import { expect, test, type Page, type Route } from '@playwright/test';

const visualNow = '2026-06-04T03:20:00.000Z';

const usersGroup = { id: 'group-users', name: 'Users', priority: 10, isSystem: true };

const adminUser = {
  id: 'user-admin',
  username: 'admin',
  displayName: 'Ada Admin',
  status: 'active',
  createdAt: '2026-06-01T00:00:00.000Z',
  capabilities: [
    'manage_users',
    'manage_groups',
    'manage_servers',
    'manage_images',
    'manage_grants',
    'manage_containers_any',
    'view_metrics_all',
    'view_audit',
  ],
  groups: [{ id: 'group-admins', name: 'Admins', priority: 100, isSystem: true }],
};

const normalUser = {
  id: 'user-lin',
  username: 'lin',
  displayName: 'Lin Lab',
  status: 'active',
  createdAt: '2026-06-01T02:00:00.000Z',
  capabilities: [],
  groups: [usersGroup],
};

const server = {
  id: 'srv-gpu',
  name: 'gpu-lab-01',
  parentIface: 'bond0',
  ipCidr: '10.8.110.0/24',
  gateway: '10.8.110.1',
  isGpuServer: true,
  status: 'online',
  lastSeenAt: '2026-06-04T03:18:00.000Z',
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

const dataDisk = {
  diskId: 'disk-lin',
  mountPoint: '/data-lin',
  label: 'Lin Data SSD',
  totalBytes: 2 * 1024 ** 4,
  usedBytes: 500 * 1024 ** 3,
  pquotaEnabled: true,
};

const images = [
  {
    id: 'img-cuda',
    name: 'cuda-pytorch',
    dockerImage: 'nvcr.io/nvidia/pytorch:24.05-py3',
    defaultUid: 1001,
    description: 'GPU notebook image',
    isActive: true,
    entrypoint: null,
    cmd: 'sleep infinity',
  },
  {
    id: 'img-ubuntu',
    name: 'ubuntu-base',
    dockerImage: 'ubuntu:24.04',
    defaultUid: 1000,
    description: 'CPU base image',
    isActive: true,
    entrypoint: null,
    cmd: null,
  },
];

const groups = [
  {
    id: 'group-admins',
    name: 'Platform Admins',
    description: 'Operate servers, users, grants, audit, and lifecycle queues',
    priority: 100,
    isSystem: true,
    capabilities: adminUser.capabilities,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    members: [{ userId: 'user-admin', username: 'admin', displayName: 'Ada Admin' }],
    memberCount: 1,
    serverGrants: [{
      id: 'grant-admin-gpu',
      scope: 'group',
      scopeId: 'group-admins',
      serverId: 'srv-gpu',
      cpuMillis: 8000,
      memBytes: 32 * 1024 ** 3,
      diskBytes: 200 * 1024 ** 3,
      gpuMode: 'indices',
      gpuIndices: [0, 1],
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }],
    imageIds: ['img-cuda', 'img-ubuntu'],
  },
  {
    id: 'group-research',
    name: 'Research Users',
    description: 'Default non-admin research workspace access',
    priority: 10,
    isSystem: true,
    capabilities: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    members: [{ userId: 'user-lin', username: 'lin', displayName: 'Lin Lab' }],
    memberCount: 1,
    serverGrants: [{
      id: 'grant-research-gpu',
      scope: 'group',
      scopeId: 'group-research',
      serverId: 'srv-gpu',
      cpuMillis: 4000,
      memBytes: 16 * 1024 ** 3,
      diskBytes: 100 * 1024 ** 3,
      gpuMode: 'indices',
      gpuIndices: [0],
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }],
    imageIds: ['img-cuda'],
  },
];

const auditLogs = [
  {
    id: 'audit-create',
    actorId: 'user-admin',
    action: 'container.create',
    targetType: 'operation',
    targetId: 'opcreate00000001',
    payload: { operationId: 'opcreate00000001', containerId: 'ctr-lin-workspace' },
    ts: '2026-06-04T03:12:00.000Z',
  },
  {
    id: 'audit-start',
    actorId: 'user-lin',
    action: 'container.start',
    targetType: 'operation',
    targetId: 'opstart00000002',
    payload: { operationId: 'opstart00000002', containerId: 'ctr-lin-workspace' },
    ts: '2026-06-04T03:13:00.000Z',
  },
  {
    id: 'audit-delete',
    actorId: null,
    action: 'container.delete',
    targetType: 'operation',
    targetId: 'opdelete0000003',
    payload: { operationId: 'opdelete0000003', containerId: 'ctr-old-workspace' },
    ts: '2026-06-04T03:14:00.000Z',
  },
];

const normalContainer = {
  id: 'ctr-lin-workspace',
  serverId: 'srv-gpu',
  serverName: 'gpu-lab-01',
  ownerId: normalUser.id,
  ownerName: 'Lin Lab',
  name: 'lin-notebook',
  imageId: 'img-cuda',
  phase: 'active',
  powerIntent: 'running',
  runtime: {
    bound: true,
    runtimeId: 'docker-lin-workspace-0001',
    status: 'running',
    ip: '10.8.110.51',
    observedAt: '2026-06-04T03:20:00.000Z',
    stale: false,
    drift: [],
  },
  activeOperation: null,
  resources: {
    cpuMillis: 2000,
    memBytes: 8 * 1024 ** 3,
    diskBytes: 80 * 1024 ** 3,
    gpuIndices: [0],
  },
  ssh: {
    enabled: true,
    status: 'running',
    user: 'root',
    port: 22,
  },
  mounts: [
    { id: 'mount-lin-scratch', sourceKind: 'local', sourceId: 'disk-lin', dirName: 'lin-scratch', containerPath: '/workspace/scratch' },
    { id: 'mount-lin-datasets', sourceKind: 'remote', sourceId: 'remote-research', dirName: 'lin-datasets', containerPath: '/workspace/data' },
  ],
  actions: {
    start: { enabled: false, reason: 'runtime_missing', message: '容器已经在运行' },
    stop: { enabled: true },
    restart: { enabled: true },
    delete: { enabled: true },
    stats: { enabled: true },
    console: { enabled: true },
    updateMounts: { enabled: true },
    enableSsh: { enabled: false, message: 'SSH 已启用' },
    reconcileSsh: { enabled: true },
  },
};

const normalDataDirs = [
  {
    id: 'dd-lin-local',
    sourceKind: 'local',
    sourceId: 'disk-lin',
    name: 'lin-scratch',
    hostPath: '/data-lin/lin-scratch',
    userId: normalUser.id,
    serverId: 'srv-gpu',
    serverName: 'gpu-lab-01',
  },
  {
    id: 'dd-lin-remote',
    sourceKind: 'remote',
    sourceId: 'remote-research',
    name: 'lin-datasets',
    hostPath: '/mnt/research/lin-datasets',
    userId: normalUser.id,
    serverId: 'srv-gpu',
    serverName: 'gpu-lab-01',
  },
];

const mountSources = [
  { kind: 'local', id: 'disk-lin', serverId: 'srv-gpu', label: '本地 · Lin Data SSD', hostRoot: '/data-lin' },
  {
    kind: 'remote',
    id: 'remote-research',
    serverId: 'srv-gpu',
    label: 'Research NFS',
    description: 'Own research dataset export',
    hostRoot: '/mnt/research',
  },
];

const normalSshKeys = [
  {
    id: 'ssh-lin-laptop',
    name: 'lin-laptop',
    keyText: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILinLaptopPublicKeyForNormalUserVisual lin@laptop',
    createdAt: '2026-06-03T09:00:00.000Z',
  },
];

test.describe('admin persona route coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(visualNow);
    await seedAuth(page, adminUser);
    await mockApi(page);
  });

  test('groups route shows management inventory and capabilities', async ({ page }) => {
    await page.goto('/groups');

    await expect(page.getByRole('heading', { name: '用户组管理' })).toBeVisible();
    await expect(page.getByRole('link', { name: '用户组' })).toBeVisible();
    await expect(page.getByText('Platform Admins')).toBeVisible();
    await expect(page.getByText('Research Users')).toBeVisible();
    await expect(page.getByText('管理用户组')).toBeVisible();
    await expect(page.getByText('管理所有容器')).toBeVisible();
    await expect(page.getByText('查看审计')).toBeVisible();
    await expect(page.getByText('gpu-lab-01')).toHaveCount(2);
    await expect(page.getByText('cuda-pytorch')).toHaveCount(2);
    await expect(page.getByText('ubuntu-base')).toBeVisible();
    await expect(page.getByRole('main').getByText('admin', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('lin', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建用户组' })).toBeVisible();
    await expect(page).toHaveScreenshot('admin-groups-management.png', { fullPage: true });
  });

  test('users route still renders management UI for admins', async ({ page }) => {
    await page.goto('/users');

    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加用户' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'admin', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'lin', exact: true })).toBeVisible();
  });

  test('audit route shows lifecycle operation records with operation ids', async ({ page }) => {
    await page.goto('/audit');

    await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible();
    await expect(page.getByText('3 条记录')).toBeVisible();
    await expect(page.getByText('container.create')).toBeVisible();
    await expect(page.getByText('container.start')).toBeVisible();
    await expect(page.getByText('container.delete')).toBeVisible();
    await expect(page.getByText('operation:opcreate00000001')).toBeVisible();
    await expect(page.getByText('operation:opstart00000002')).toBeVisible();
    await expect(page.getByText('operation:opdelete0000003')).toBeVisible();
    await expect(page).toHaveScreenshot('admin-audit-lifecycle-operations.png', { fullPage: true });
  });
});

test.describe('normal user persona route coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(visualNow);
    await seedAuth(page, normalUser);
    await mockApi(page);
  });

  test('dashboard shows own metrics without admin navigation', async ({ page }) => {
    await page.goto('/');

    await assertNormalUserNavigation(page);
    await expect(page.getByRole('button', { name: '用户维度' })).toBeVisible();
    await expect(page.locator('select')).toHaveValue('srv-gpu');
    await expect(page.getByText('主机资源')).toHaveCount(0);
    await expect(page.getByText('磁盘 IO（读 + 写）')).toBeVisible();
    await expect(page.getByText('网络 IO（收 + 发）')).toBeVisible();
    await expect(page.getByText('磁盘占用空间')).toBeVisible();
    await expect(page.getByText('GPU 显存')).toBeVisible();
    await expect(page.getByText('Lin Lab').first()).toBeVisible();
    await expect(page.getByText('Ada Admin')).toHaveCount(0);
    await expect(page).toHaveScreenshot('normal-dashboard-core.png', { fullPage: true });
  });

  test('data directories shows own directories without admin navigation', async ({ page }) => {
    const requests = recordApiRequests(page);
    await page.goto('/data-dirs');

    await assertNormalUserNavigation(page);
    await expect(page.getByRole('heading', { name: '数据目录' })).toBeVisible();
    await expect(page.getByText('2 个目录')).toBeVisible();
    await expect(page.getByText('Research NFS')).toBeVisible();
    await expect(page.getByText('lin-datasets')).toBeVisible();
    await expect(page.getByText('gpu-lab-01')).toBeVisible();
    await expect(page.getByText('lin-notebook')).toHaveCount(2);
    await expect(requests).toContain('GET /api/v2/containers');
    await expect(page).toHaveScreenshot('normal-data-dirs-own-resources.png', { fullPage: true });
  });

  test('profile shows own account center without admin navigation', async ({ page }) => {
    await page.goto('/profile');

    await assertNormalUserNavigation(page);
    await expect(page.getByRole('heading', { name: '用户中心' })).toBeVisible();
    await expect(page.getByText('Lin Lab').first()).toBeVisible();
    await expect(page.getByText('@lin')).toBeVisible();
    await expect(page.getByRole('heading', { name: '修改密码' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'SSH 公钥' })).toBeVisible();
    await expect(page.getByText('lin-laptop')).toBeVisible();
    await expect(page.getByText('admin')).toHaveCount(0);
    await expect(page).toHaveScreenshot('normal-profile-own-account.png', { fullPage: true });
  });

  test('direct users route shows denied state without loading user management for ordinary users', async ({ page }) => {
    const requests = recordApiRequests(page);
    await page.goto('/users');

    await assertNormalUserNavigation(page);
    await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
    await expect(page.getByText('当前账号没有访问该页面的权限。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '用户管理' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '添加用户' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: '用户名' })).toHaveCount(0);
    expect(requests).not.toContain('GET /api/users');
    await expect(page).toHaveScreenshot('normal-users-access-denied.png', { fullPage: true });
  });

  test('direct admin routes show denied state without loading admin shells for ordinary users', async ({ page }) => {
    const requests = recordApiRequests(page);
    const restrictedRoutes = [
      { path: '/images', heading: '容器镜像', blockedRequest: 'GET /api/admin/images' },
      { path: '/groups', heading: '用户组管理', blockedRequest: 'GET /api/groups' },
      { path: '/audit', heading: '审计日志', blockedRequest: 'GET /api/audit' },
      { path: '/manage/containers', heading: '容器管理', blockedRequest: 'GET /api/admin/v2/containers' },
      { path: '/manage/remote-fs', heading: '远程文件系统', blockedRequest: 'GET /api/admin/remote-fs-mounts' },
      { path: '/servers', heading: '服务器', blockedRequest: 'GET /api/admin/servers' },
    ];

    for (const routeInfo of restrictedRoutes) {
      requests.length = 0;
      await page.goto(routeInfo.path);

      await assertNormalUserNavigation(page);
      await expect(page.getByRole('heading', { name: '无权访问' })).toBeVisible();
      await expect(page.getByText('当前账号没有访问该页面的权限。')).toBeVisible();
      await expect(page.getByRole('heading', { name: routeInfo.heading })).toHaveCount(0);
      expect(requests.some((entry) => entry.startsWith(routeInfo.blockedRequest))).toBe(false);
    }
  });

  test('container actions use kebab-case backend paths', async ({ page }) => {
    const requests = recordApiRequests(page);

    await page.goto('/containers/ctr-lin-workspace');
    await expect(page.getByRole('heading', { name: 'lin-notebook' })).toBeVisible();
    await page.getByRole('button', { name: '修复' }).click();

    await expect.poll(() => requests).toContain('POST /api/v2/containers/ctr-lin-workspace/actions/reconcile-ssh');
    expect(requests).not.toContain('POST /api/v2/containers/ctr-lin-workspace/actions/reconcileSsh');
  });
});

async function seedAuth(page: Page, user: unknown): Promise<void> {
  await page.addInitScript((seededUser) => {
    window.localStorage.setItem('nyabase-auth', JSON.stringify({
      state: {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        user: seededUser,
      },
      version: 0,
    }));
    window.localStorage.setItem('nyabase-dashboard-server', 'srv-gpu');
  }, user);
}

function recordApiRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      requests.push(`${request.method()} ${url.pathname}${url.search}`);
    }
  });
  return requests;
}

async function assertNormalUserNavigation(page: Page): Promise<void> {
  await expect(page.getByText('Lin Lab').first()).toBeVisible();
  await expect(page.getByRole('link', { name: '监控大屏' })).toBeVisible();
  await expect(page.getByRole('link', { name: '容器', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '数据目录' })).toBeVisible();
  await expect(page.getByRole('link', { name: '用户中心' })).toBeVisible();

  for (const label of ['服务器', '镜像', '容器管理', '远程文件系统', '用户', '用户组', '审计']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0);
  }
}

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');

    if (path === '/admin/servers') return json(route, [server]);
    if (path === '/servers') return json(route, [server]);
    if (path === '/admin/servers/srv-gpu/disks' || path === '/servers/srv-gpu/disks') return json(route, [dataDisk]);
    if (path === '/admin/images') return json(route, images);
    if (path === '/admin/users') return json(route, [adminUser, normalUser]);
    if (path === '/admin/groups') return json(route, groups);
    if (path === '/admin/v2/containers') return json(route, [normalContainer]);
    if (path === '/admin/remote-fs-mounts') return json(route, []);
    if (path === '/admin/audit') return json(route, auditLogs);
    if (path === '/audit') return json(route, auditLogs);
    if (path === '/audit') return json(route, auditLogs);
    if (path === '/v2/containers') return json(route, [normalContainer]);
    if (path === '/v2/containers/ctr-lin-workspace') return json(route, normalContainer);
    if (path === '/v2/containers/ctr-lin-workspace/actions/reconcile-ssh') {
      return json(route, {
        ok: true,
        operationId: 'opreconcile0001',
        status: 'queued',
      });
    }
    if (path === '/operations/opreconcile0001') {
      return json(route, {
        id: 'opreconcile0001',
        kind: 'container.reconcile_ssh',
        status: 'succeeded',
        resourceType: 'container',
        resourceId: 'ctr-lin-workspace',
        serverId: 'srv-gpu',
      });
    }
    if (path === '/data-dirs') return json(route, url.searchParams.get('serverId') === 'srv-gpu' ? normalDataDirs : []);
    if (path === '/mount-sources') return json(route, url.searchParams.get('serverId') === 'srv-gpu' ? mountSources : []);
    if (path === '/users/user-lin/ssh-keys') return json(route, normalSshKeys);
    if (path === '/metrics/servers/srv-gpu/host') return json(route, hostMetrics());
    if (path === '/metrics/servers/srv-gpu/gpus') return json(route, gpuMetrics());
    if (path === '/metrics/servers/srv-gpu/users') {
      return json(route, {
        users: [{
          userId: normalUser.id,
          username: normalUser.username,
          displayName: normalUser.displayName,
          cpu: metricSeries([0.2, 0.25, 0.22]),
          memUsed: metricSeries([2 * 1024 ** 3, 2.3 * 1024 ** 3, 2.5 * 1024 ** 3]),
          gpuMemUsed: metricSeries([1 * 1024 ** 3, 1.5 * 1024 ** 3, 2 * 1024 ** 3]),
          diskBps: metricSeries([40 * 1024 ** 2, 45 * 1024 ** 2, 38 * 1024 ** 2]),
          netBps: metricSeries([8 * 1024 ** 2, 10 * 1024 ** 2, 12 * 1024 ** 2]),
          diskUsed: metricSeries([14 * 1024 ** 3, 14.5 * 1024 ** 3, 15 * 1024 ** 3]),
        }],
      });
    }
    if (path === '/metrics/servers/srv-gpu/containers') {
      return json(route, {
        containers: [{
          containerId: normalContainer.id,
          name: normalContainer.name,
          ownerId: normalUser.id,
          cpu: metricSeries([0.28, 0.35, 0.31]),
          memUsed: metricSeries([2 * 1024 ** 3, 2.3 * 1024 ** 3, 2.5 * 1024 ** 3]),
          gpuMemUsed: metricSeries([1 * 1024 ** 3, 1.4 * 1024 ** 3, 2 * 1024 ** 3]),
          diskBps: metricSeries([16 * 1024 ** 2, 18 * 1024 ** 2, 15 * 1024 ** 2]),
          netBps: metricSeries([5 * 1024 ** 2, 7 * 1024 ** 2, 6 * 1024 ** 2]),
        }],
      });
    }

    return json(route, {}, 404);
  });
}

function metricSeries(values: number[]) {
  return {
    step: 60,
    points: values.map((v, i) => ({ t: 1780315200 + i * 60, v })),
  };
}

function hostMetrics() {
  return {
    cpu: metricSeries([0.16, 0.2, 0.18]),
    memUsed: metricSeries([12 * 1024 ** 3, 13 * 1024 ** 3, 13.5 * 1024 ** 3]),
    memTotal: metricSeries([64 * 1024 ** 3, 64 * 1024 ** 3, 64 * 1024 ** 3]),
    load1: metricSeries([0.8, 0.9, 0.7]),
    disks: [{
      diskId: 'disk-lin',
      mountPoint: '/data-lin',
      used: metricSeries([500 * 1024 ** 3, 501 * 1024 ** 3, 502 * 1024 ** 3]),
      total: metricSeries([2 * 1024 ** 4, 2 * 1024 ** 4, 2 * 1024 ** 4]),
    }],
    diskIo: [{ dev: 'nvme0n1', bps: metricSeries([50 * 1024 ** 2, 55 * 1024 ** 2, 48 * 1024 ** 2]) }],
    netIo: [{ iface: 'bond0', bps: metricSeries([10 * 1024 ** 2, 11 * 1024 ** 2, 9 * 1024 ** 2]) }],
  };
}

function gpuMetrics() {
  return {
    gpus: [{
      index: 0,
      model: 'NVIDIA L40',
      memTotalMiB: 46068,
      util: metricSeries([0.2, 0.25, 0.22]),
      memUsed: metricSeries([2 * 1024 ** 3, 2.5 * 1024 ** 3, 3 * 1024 ** 3]),
      temp: metricSeries([36, 37, 38]),
      power: metricSeries([60, 65, 62]),
      graphicsClockMHz: metricSeries([1100, 1200, 1150]),
    }],
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
