import { expect, test, type Page, type Route } from '@playwright/test';

const adminGroup = { id: 'group-admins', name: 'Admins', priority: 100, isSystem: true };
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
    'manage_containers_any',
    'view_metrics_all',
    'view_audit',
  ],
  groups: [adminGroup],
};

const gpuServer = {
  id: 'srv-gpu',
  name: 'gpu-lab-01',
  parentIface: 'bond0',
  ipCidr: '10.8.110.0/24',
  gateway: '10.8.110.1',
  isGpuServer: true,
  status: 'online',
  lastSeenAt: null,
  defaultCpuMillis: 8000,
  defaultMemBytes: 64 * 1024 ** 3,
  defaultDiskBytes: 100 * 1024 ** 3,
  defaultGpuMode: 'indices',
  defaultGpuIndices: [0],
  disks: [{ diskId: 'disk-data', mountPoint: '/data', label: 'Data SSD', totalBytes: 2 * 1024 ** 4, usedBytes: 640 * 1024 ** 3, pquotaEnabled: true }],
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

const cpuServer = {
  id: 'srv-cpu',
  name: 'cpu-lab-01',
  parentIface: 'eno1',
  ipCidr: '10.8.120.0/24',
  gateway: '10.8.120.1',
  isGpuServer: false,
  status: 'offline',
  lastSeenAt: null,
  defaultCpuMillis: 4000,
  defaultMemBytes: 16 * 1024 ** 3,
  defaultDiskBytes: 50 * 1024 ** 3,
  defaultGpuMode: 'none',
  defaultGpuIndices: [],
  disks: [],
  gpus: [],
  agentVersion: '0.1.0',
  dockerRoot: '/data/nyabase-docker',
  dockerSocket: '/run/nyabase-agent/docker.sock',
  dockerDaemon: null,
};

const servers = [gpuServer, cpuServer];

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
    isActive: false,
    entrypoint: null,
    cmd: null,
  },
];

const users = [
  adminUser,
  {
    id: 'user-researcher',
    username: 'researcher',
    displayName: 'Research User',
    status: 'disabled',
    createdAt: '2026-05-31T12:00:00.000Z',
    capabilities: [],
    groups: [usersGroup],
  },
];

const sshKeys = [
  {
    id: 'ssh-key-laptop',
    name: 'work-laptop',
    keyText: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockLaptopPublicKeyForProfileVisual admin@laptop',
    createdAt: '2026-06-01T08:30:00.000Z',
  },
  {
    id: 'ssh-key-cluster',
    name: 'cluster-jumpbox',
    keyText: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQMockJumpboxPublicKeyForProfileVisual admin@jumpbox',
    createdAt: '2026-06-02T09:45:00.000Z',
  },
];

const container = {
  id: 'ctr-cuda-notebook',
  serverId: 'srv-gpu',
  serverName: 'gpu-lab-01',
  ownerId: 'user-admin',
  ownerName: 'Ada Admin',
  name: 'cuda-notebook',
  imageId: 'img-cuda',
  phase: 'active',
  powerIntent: 'running',
  runtime: {
    bound: true,
    runtimeId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    status: 'running',
    ip: '10.8.110.20',
    observedAt: '2026-06-01T11:30:00.000Z',
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
    { id: 'mount-local-scratch', sourceKind: 'local', sourceId: 'disk-data', dirName: 'scratch-a', containerPath: '/workspace/scratch' },
    { id: 'mount-remote-team', sourceKind: 'remote', sourceId: 'remote-shared', dirName: 'team-dataset', containerPath: '/workspace/data' },
  ],
  actions: {
    start: { enabled: false, reason: 'phase_not_active', message: 'Container is not stopped' },
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
  {
    id: 'dd-remote',
    sourceKind: 'remote',
    sourceId: 'remote-shared',
    name: 'team-dataset',
    hostPath: '/mnt/shared-nfs/team-dataset',
    userId: 'user-admin',
    serverId: 'srv-gpu',
    serverName: 'gpu-lab-01',
  },
];

test.describe('authenticated visual route coverage', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
    await mockApi(page);
  });

  test('dashboard user dimension shows GPU memory chart', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: '用户维度' })).toBeVisible();
    await expect(page.locator('select')).toHaveValue('srv-gpu');
    await expect(page.getByText('主机资源')).toHaveCount(0);
    await expect(page.getByText('磁盘 IO（读 + 写）')).toBeVisible();
    await expect(page.getByText('网络 IO（收 + 发）')).toBeVisible();
    await expect(page.getByText('磁盘占用空间')).toBeVisible();
    await expect(page.getByText('GPU 显存')).toBeVisible();
    await expect(page.getByText('Ada Admin').first()).toBeVisible();
    await expect(page).toHaveScreenshot('dashboard-user-gpu-memory.png', { fullPage: true });
  });

  test('dashboard container dimension shows GPU memory chart', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: '容器维度' }).click();
    await expect(page.getByRole('button', { name: '容器维度' })).toHaveClass(/border-primary/);
    await expect(page.getByText('主机资源')).toHaveCount(0);
    await expect(page.getByText('磁盘占用空间')).toHaveCount(0);
    await expect(page.getByText('CPU 用量（核心数）')).toBeVisible();
    await expect(page.getByText('内存用量')).toBeVisible();
    await expect(page.getByText('磁盘 IO（读 + 写）')).toBeVisible();
    await expect(page.getByText('网络 IO（收 + 发）')).toBeVisible();
    await expect(page.getByText('GPU 显存')).toBeVisible();
    await expect(page.getByText('cuda-notebook').first()).toBeVisible();
    await expect(page).toHaveScreenshot('dashboard-container-gpu-memory.png', { fullPage: true });
  });

  test('servers route shows registered server status and resources', async ({ page }) => {
    await page.goto('/servers');

    await expect(page.getByRole('heading', { name: '服务器' })).toBeVisible();
    await expect(page.getByText('2 台已注册')).toBeVisible();
    await expect(page.getByText('gpu-lab-01')).toBeVisible();
    await expect(page.getByText('GPU 0: L40')).toBeVisible();
    await expect(page.getByText('cpu-lab-01')).toBeVisible();
    await expect(page.getByText('offline')).toBeVisible();
    await expect(page).toHaveScreenshot('servers-management.png', { fullPage: true });
  });

  test('images route shows preset image inventory', async ({ page }) => {
    await page.goto('/images');

    await expect(page.getByRole('heading', { name: '容器镜像' })).toBeVisible();
    await expect(page.getByText('2 个预置镜像')).toBeVisible();
    await expect(page.getByText('cuda-pytorch')).toBeVisible();
    await expect(page.getByText('nvcr.io/nvidia/pytorch:24.05-py3')).toBeVisible();
    await expect(page.getByText('ubuntu-base')).toBeVisible();
    await expect(page.getByText('停用')).toBeVisible();
    await expect(page).toHaveScreenshot('images-management.png', { fullPage: true });
  });

  test('users route shows account status table', async ({ page }) => {
    await page.goto('/users');

    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible();
    await expect(page.getByText('2 个账号')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'admin', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'researcher', exact: true })).toBeVisible();
    await expect(page.getByText('正常')).toBeVisible();
    await expect(page.getByText('禁用')).toBeVisible();
    await expect(page).toHaveScreenshot('users-management.png', { fullPage: true });
  });

  test('profile route shows password and SSH key management', async ({ page }) => {
    await page.goto('/profile');

    await expect(page.getByRole('link', { name: /用户中心/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '用户中心' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '修改密码' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'SSH 公钥' })).toBeVisible();
    await expect(page.getByText('用于容器 SSH 登录')).toBeVisible();
    await expect(page.getByText('work-laptop')).toBeVisible();
    await expect(page.getByText('cluster-jumpbox')).toBeVisible();
    const keyTextInput = page.getByLabel('公钥内容');
    const keyNameInput = page.getByLabel('名称');
    await keyTextInput.fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3 alice@workstation');
    await expect(keyNameInput).toHaveValue('alice@workstation');
    await keyTextInput.evaluate((el) => (el as HTMLTextAreaElement).blur());
    await expect(page.getByRole('button', { name: '添加公钥' })).toBeVisible();
    await expect(page.getByText('修改密码')).toHaveCount(1);
    await expect(page).toHaveScreenshot('profile-user-center.png', { fullPage: true });
  });

  test('profile route generates an SSH key name when no comment is present', async ({ page }) => {
    await page.goto('/profile');

    await page.getByLabel('公钥内容').fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3');

    const requestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'POST' && url.pathname === '/api/users/user-admin/ssh-keys';
    });
    await page.getByRole('button', { name: '添加公钥' }).click();

    const request = await requestPromise;
    const body = request.postDataJSON() as { name: string; keyText: string };
    expect(body.keyText).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3');
    expect(body.name).toMatch(/^ssh-key-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  });

  test('containers route shows own container resource summary', async ({ page }) => {
    await page.goto('/containers');

    await expect(page.getByRole('heading', { name: '容器' })).toBeVisible();
    await expect(page.locator('p', { hasText: '1 个容器' })).toBeVisible();
    await expect(page.getByText('gpu-lab-01')).toBeVisible();
    await expect(page.getByText('cuda-notebook')).toBeVisible();
    await expect(page.getByText('running')).toBeVisible();
    await expect(page.getByText('GPU 0')).toBeVisible();
    await expect(page).toHaveScreenshot('containers-own.png', { fullPage: true });
  });

  test('data directories route shows local and remote data sources', async ({ page }) => {
    await page.goto('/data-dirs');

    await expect(page.getByRole('heading', { name: '数据目录' })).toBeVisible();
    await expect(page.getByText('2 个目录')).toBeVisible();
    await expect(page.getByText('远程共享存储')).toBeVisible();
    await expect(page.getByText('Shared NFS')).toBeVisible();
    await expect(page.getByText('team-dataset')).toBeVisible();
    await expect(page.getByText('Data SSD')).toBeVisible();
    await expect(page.getByText('scratch-a')).toBeVisible();
    await expect(page).toHaveScreenshot('data-dirs-overview.png', { fullPage: true });
  });

  test('remote filesystem route shows NFS assignment status', async ({ page }) => {
    await page.goto('/manage/remote-fs');

    await expect(page.getByRole('heading', { name: '远程文件系统' })).toBeVisible();
    await expect(page.getByText('1 个挂载')).toBeVisible();
    await expect(page.getByText('Shared NFS')).toBeVisible();
    await expect(page.getByText('已挂载')).toBeVisible();
    await expect(page.getByText('gpu-lab-01')).toBeVisible();
    await expect(page.getByText('10.8.96.92:/srv/shared (v4.2)')).toBeVisible();
    await expect(page).toHaveScreenshot('remote-fs-management.png', { fullPage: true });
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
    window.localStorage.setItem('nyabase-dashboard-server', 'srv-gpu');
  }, adminUser);
}

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');

    if (path === '/admin/servers' || path === '/servers') return json(route, servers);
    if (path === '/admin/servers/srv-gpu/disks' || path === '/servers/srv-gpu/disks') return json(route, gpuServer.disks);
    if (path === '/admin/servers/srv-cpu/disks' || path === '/servers/srv-cpu/disks') return json(route, []);
    if (path === '/admin/images') return json(route, images);
    if (path === '/admin/users') return json(route, users);
    if (path === '/users/user-admin/ssh-keys') {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { name: string; keyText: string };
        return json(route, {
          id: 'ssh-key-added',
          name: body.name,
          keyText: body.keyText,
          createdAt: '2026-06-03T02:00:00.000Z',
        });
      }
      return json(route, sshKeys);
    }
    if (path === '/groups') {
      return json(route, [
        { ...adminGroup, description: 'Administrators', capabilities: adminUser.capabilities, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', memberCount: 1 },
        { ...usersGroup, description: 'Default users', capabilities: [], createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', memberCount: 1 },
      ]);
    }
    if (path === '/v2/containers') return json(route, [container]);
    if (path === '/data-dirs') {
      const serverId = url.searchParams.get('serverId');
      return json(route, serverId === 'srv-gpu' ? dataDirs : []);
    }
    if (path === '/mount-sources') {
      const serverId = url.searchParams.get('serverId');
      return json(route, serverId === 'srv-gpu' ? [
        { kind: 'local', id: 'disk-data', serverId: 'srv-gpu', label: '本地 · Data SSD', hostRoot: '/data' },
        { kind: 'remote', id: 'remote-shared', serverId: 'srv-gpu', label: 'Shared NFS', description: 'Team dataset export', hostRoot: '/mnt/shared-nfs' },
      ] : []);
    }
    if (path === '/admin/remote-fs-mounts') return json(route, [remoteMount]);
    if (path === '/admin/data-dirs/issues') return json(route, []);
    if (path === '/admin/metrics/servers/srv-gpu/host' || path === '/metrics/servers/srv-gpu/host') {
      return json(route, hostMetrics());
    }
    if (path === '/admin/metrics/servers/srv-gpu/gpus' || path === '/metrics/servers/srv-gpu/gpus') {
      return json(route, gpuMetrics());
    }
    if (path === '/admin/metrics/servers/srv-gpu/users' || path === '/metrics/servers/srv-gpu/users') {
      return json(route, {
        users: [{
          userId: 'user-admin',
          username: 'admin',
          displayName: 'Ada Admin',
          cpu: metricSeries([0.4, 0.55, 0.5]),
          memUsed: metricSeries([3 * 1024 ** 3, 3.5 * 1024 ** 3, 4 * 1024 ** 3]),
          gpuMemUsed: metricSeries([1 * 1024 ** 3, 1.5 * 1024 ** 3, 2 * 1024 ** 3]),
          diskBps: metricSeries([80 * 1024 ** 2, 90 * 1024 ** 2, 72 * 1024 ** 2]),
          netBps: metricSeries([15 * 1024 ** 2, 18 * 1024 ** 2, 22 * 1024 ** 2]),
          diskUsed: metricSeries([18 * 1024 ** 3, 18.5 * 1024 ** 3, 19 * 1024 ** 3]),
        }],
      });
    }
    if (path === '/admin/metrics/servers/srv-gpu/containers' || path === '/metrics/servers/srv-gpu/containers') {
      return json(route, {
        containers: [{
          containerId: container.id,
          name: container.name,
          ownerId: 'user-admin',
          cpu: metricSeries([0.32, 0.48, 0.44]),
          memUsed: metricSeries([2.5 * 1024 ** 3, 3 * 1024 ** 3, 3.2 * 1024 ** 3]),
          gpuMemUsed: metricSeries([768 * 1024 ** 2, 1 * 1024 ** 3, 1.5 * 1024 ** 3]),
          diskBps: metricSeries([24 * 1024 ** 2, 26 * 1024 ** 2, 21 * 1024 ** 2]),
          netBps: metricSeries([7 * 1024 ** 2, 11 * 1024 ** 2, 9 * 1024 ** 2]),
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
    cpu: metricSeries([0.18, 0.24, 0.2]),
    memUsed: metricSeries([24 * 1024 ** 3, 25 * 1024 ** 3, 26 * 1024 ** 3]),
    memTotal: metricSeries([128 * 1024 ** 3, 128 * 1024 ** 3, 128 * 1024 ** 3]),
    load1: metricSeries([1.2, 1.4, 1.1]),
    disks: [{
      diskId: 'disk-data',
      mountPoint: '/data',
      used: metricSeries([640 * 1024 ** 3, 641 * 1024 ** 3, 642 * 1024 ** 3]),
      total: metricSeries([2 * 1024 ** 4, 2 * 1024 ** 4, 2 * 1024 ** 4]),
    }],
    diskIo: [{ dev: 'nvme0n1', bps: metricSeries([120 * 1024 ** 2, 130 * 1024 ** 2, 118 * 1024 ** 2]) }],
    netIo: [{ iface: 'bond0', bps: metricSeries([22 * 1024 ** 2, 25 * 1024 ** 2, 21 * 1024 ** 2]) }],
  };
}

function gpuMetrics() {
  return {
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
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
