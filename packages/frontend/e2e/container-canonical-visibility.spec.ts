import { expect, test, type Page, type Route } from '@playwright/test';

const visualNow = '2026-06-04T02:30:00.000Z';

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

const normalUser = {
  id: 'user-lin',
  username: 'lin',
  displayName: 'Lin Lab',
  status: 'active',
  createdAt: '2026-06-01T02:00:00.000Z',
  capabilities: [],
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
  lastSeenAt: '2026-06-04T01:58:00.000Z',
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

const adminPendingContainer = containerFixture({
  id: 'ctr-admin-pending',
  runtimeId: 'docker-admin-observed-aaaa',
  name: 'admin-train-pending',
  ownerId: 'user-admin',
  ownerName: 'Ada Admin',
  ip: '10.8.110.41',
  status: 'running',
  operation: operation({
    id: 'opadminpending1',
    kind: 'container.stop',
    status: 'waiting_agent',
    resourceId: 'ctr-admin-pending',
  }),
});

const userPendingContainer = containerFixture({
  id: 'ctr-lin-pending',
  runtimeId: 'docker-lin-observed-bbbb',
  name: 'lin-queued-workspace',
  ownerId: 'user-lin',
  ownerName: 'Lin Lab',
  ip: '10.8.110.42',
  status: 'exited',
  operation: operation({
    id: 'oplinpending12',
    kind: 'container.start',
    status: 'retrying',
    resourceId: 'ctr-lin-pending',
    attempts: 2,
    lastError: 'agent disconnected during start',
    startedAt: '2026-06-04T01:59:00.000Z',
  }),
});

const userStartableContainer = containerFixture({
  id: 'ctr-lin-start',
  runtimeId: 'docker-lin-start-cccc',
  name: 'lin-canonical-start',
  ownerId: 'user-lin',
  ownerName: 'Lin Lab',
  ip: '10.8.110.43',
  status: 'exited',
});

const userRunningContainer = containerFixture({
  id: 'ctr-lin-run',
  runtimeId: 'docker-lin-run-dddd',
  name: 'lin-canonical-run',
  ownerId: 'user-lin',
  ownerName: 'Lin Lab',
  ip: '10.8.110.44',
  status: 'running',
});

const allContainers = [
  adminPendingContainer,
  userPendingContainer,
  userStartableContainer,
  userRunningContainer,
];

const normalContainers = [userPendingContainer, userStartableContainer, userRunningContainer];

test.describe('canonical container operation visibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(visualNow);
  });

  test('admin manage containers shows all owners and durable pending controls', async ({ page }) => {
    await seedAuth(page, adminUser);
    const containerRequests = recordContainerRequests(page);
    await mockApi(page);

    await page.goto('/manage/containers');

    await expect(page.getByRole('heading', { name: '容器管理' })).toBeVisible();
    await expect(page.getByText('全局共 4 个容器，2 位用户')).toBeVisible();
    await expect(page.getByRole('main').getByText('Ada Admin')).toBeVisible();
    await expect(page.getByRole('main').getByText('Lin Lab')).toBeVisible();
    await expect(page.getByText('admin-train-pending')).toBeVisible();
    await expect(page.getByText('lin-queued-workspace')).toBeVisible();
    await expect(page.getByText('train-pending')).toBeVisible();

    const pendingRow = containerRow(page, 'admin-train-pending');
    await expect(pendingRow.locator('button:disabled')).toHaveCount(4);
    await expect.soft(page).toHaveScreenshot('manage-containers-operation-canonical.png', { fullPage: true });

    const detailRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'GET'
        && url.pathname === '/api/v2/containers/ctr-lin-run';
    });
    await expect(page.getByText('lin-canonical-run')).toBeVisible();
    await page.goto('/containers/ctr-lin-run?tab=overview');
    const request = await detailRequest;
    const detailUrl = new URL(request.url());
    expect(detailUrl.pathname).toBe('/api/v2/containers/ctr-lin-run');
    expect(detailUrl.pathname).not.toContain(userRunningContainer.runtime.runtimeId!);
    await expect(page).toHaveURL(/\/containers\/ctr-lin-run\?tab=overview$/);
    expect(containerRequests.some((entry) => entry.includes(userRunningContainer.runtime.runtimeId!))).toBe(false);
  });

  test('normal user containers show own operations without admin management context', async ({ page }) => {
    await seedAuth(page, normalUser);
    const containerRequests = recordContainerRequests(page);
    await mockApi(page);

    await page.goto('/containers');

    await expect(page.getByRole('heading', { name: '容器' })).toBeVisible();
    await expect(page.locator('p', { hasText: '3 个容器' })).toBeVisible();
    await expect(page.getByText('lin-queued-workspace')).toBeVisible();
    await expect(page.getByText('lin-canonical-start')).toBeVisible();
    await expect(page.getByText('lin-canonical-run')).toBeVisible();
    await expect(page.getByText('admin-train-pending')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '容器管理' })).toHaveCount(0);
    await expect(page.getByText('lin-queued-workspace')).toBeVisible();

    const pendingRow = containerRow(page, 'lin-queued-workspace');
    await expect(pendingRow.locator('button:disabled')).toHaveCount(4);
    await expect.soft(page).toHaveScreenshot('containers-normal-user-canonical-operations.png', { fullPage: true });

    const startRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'POST'
        && url.pathname === '/api/v2/containers/ctr-lin-start/actions/start';
    });
    await containerRow(page, 'lin-canonical-start').locator('button').first().click();
    const request = await startRequest;
    const startUrl = new URL(request.url());
    expect(startUrl.pathname).toBe('/api/v2/containers/ctr-lin-start/actions/start');
    expect(startUrl.pathname).not.toContain(userStartableContainer.runtime.runtimeId!);
    await expect(page.getByText('容器启动已排队', { exact: true })).toBeVisible();
    expect(containerRequests.some((entry) => entry.includes(userStartableContainer.runtime.runtimeId!))).toBe(false);
    expect(containerRequests).toContain('GET /api/v2/containers');
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
  }, user);
}

function recordContainerRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v2/containers')) {
      requests.push(`${request.method()} ${url.pathname}${url.search}`);
    }
  });
  return requests;
}

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = route.request().method();

    if (path === '/servers') return json(route, [server]);

    if (path === '/admin/v2/containers' && method === 'GET') {
      return json(route, allContainers);
    }

    if (path === '/v2/containers' && method === 'GET') {
      return json(route, normalContainers);
    }

    if (path === '/v2/containers/ctr-lin-start/actions/start' && method === 'POST') {
      await delay();
      return json(route, { ok: true, operationId: 'opstartcanonical', status: 'queued' });
    }

    if (path === '/operations/opstartcanonical') {
      return json(route, operation({
        id: 'opstartcanonical',
        kind: 'container.start',
        status: 'succeeded',
        resourceId: 'ctr-lin-start',
      }));
    }

    const container = allContainers.find((c) => path === `/v2/containers/${c.id}`);
    if (container) return json(route, container);

    if (path === '/mount-sources') return json(route, []);

    return json(route, {}, 404);
  });
}

function containerRow(page: Page, name: string) {
  return page.locator('div.flex.items-center.gap-4').filter({ hasText: name });
}

function containerFixture(input: {
  id: string;
  runtimeId: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ip: string;
  status: string;
  operation?: ReturnType<typeof operation>;
}) {
  const running = input.status === 'running';
  const activeOperation = input.operation ?? null;
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
    ownerId: input.ownerId,
    ownerName: input.ownerName,
    name: input.name,
    imageId: 'img-cuda',
    phase: activeOperation ? 'updating' : 'active',
    powerIntent: running ? 'running' : 'stopped',
    runtime: {
      bound: true,
      runtimeId: input.runtimeId,
      status: input.status,
      ip: input.ip,
      observedAt: '2026-06-04T01:58:00.000Z',
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
    ssh: { enabled: false, status: 'disabled', user: 'root', port: 22 },
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
    createdAt: '2026-06-04T01:58:00.000Z',
    startedAt: null,
    completedAt: null,
    ...input,
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
