import { expect, test, type Page, type Route } from '@playwright/test';

const enabledContainerId = 'ctr-ssh-enabled';
const disabledContainerId = 'ctr-ssh-disabled';

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
  groups: [],
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
  disks: [],
  gpus: [{ index: 0, uuid: 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0000', model: 'NVIDIA L40', totalMemMiB: 46068 }],
  agentVersion: '0.1.0',
  dockerRoot: '/data/nyabase-docker',
  dockerSocket: '/run/nyabase-agent/docker.sock',
  dockerDaemon: null,
};

const images = [
  {
    id: 'img-cuda',
    name: 'cuda-pytorch',
    dockerImage: 'nvcr.io/nvidia/pytorch:24.05-py3',
    description: 'GPU notebook image',
    isActive: true,
    entrypoint: null,
    cmd: 'sleep infinity',
    disableSsh: false,
  },
  {
    id: 'img-no-ssh',
    name: 'cuda-no-ssh',
    dockerImage: 'nvcr.io/nvidia/pytorch:24.05-py3',
    description: 'GPU notebook image without SSH',
    isActive: true,
    entrypoint: null,
    cmd: 'sleep infinity',
    disableSsh: true,
  },
];

const sshEnabledContainer = containerView({
  id: enabledContainerId,
  runtimeId: 'aaaaaaaaaaaa',
  name: 'cuda-ssh-enabled',
  ip: '10.8.110.21',
  sshEnabled: true,
});

const sshDisabledContainer = containerView({
  id: disabledContainerId,
  runtimeId: 'bbbbbbbbbbbb',
  name: 'cuda-ssh-disabled',
  ip: '10.8.110.22',
  sshEnabled: false,
  imageId: 'img-no-ssh',
});

test.describe('Dropbear SSH visual UX', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
    await mockConsoleWebSocket(page);
    await mockApi(page);
  });

  test('create container dialog does not expose legacy SSH controls', async ({ page }) => {
    await page.goto('/containers');

    await page.getByRole('button', { name: '新建容器', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '新建容器' })).toBeVisible();

    await page.getByRole('button', { name: '高级选项' }).click();

    await expect(page.getByText(/启用 Dropbear SSH|注入|SSH 用户|SSH UID/)).toHaveCount(0);
    await expect(page).toHaveScreenshot('create-container-dialog-ssh-option.png', { fullPage: true });
  });

  test('container detail shows enabled SSH access and repair action', async ({ page }) => {
    await page.goto(`/containers/${enabledContainerId}`);

    await expect(page.getByRole('heading', { name: 'cuda-ssh-enabled' })).toBeVisible();
    await expect(page.getByText('SSH', { exact: true })).toBeVisible();
    await expect(page.getByText('代理可用')).toBeVisible();
    await expect(page.getByRole('button', { name: '修复 SSH' })).toBeVisible();
    await expect(page.getByText(/SSH 用户|SSH UID|lab@|ssh lab@/)).toHaveCount(0);
    await expect(page).toHaveScreenshot('container-detail-ssh-enabled.png', { fullPage: true });
  });

  test('repair action posts the reconcile SSH endpoint', async ({ page }) => {
    await page.goto(`/containers/${enabledContainerId}`);

    const repair = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST'
        && url.pathname === `/api/v2/containers/${enabledContainerId}/actions/reconcile-ssh`;
    });
    await page.getByRole('button', { name: '修复 SSH' }).click();
    await repair;
  });

  test('container detail hides repair action when image disables SSH', async ({ page }) => {
    await page.goto(`/containers/${disabledContainerId}`);

    await expect(page.getByRole('heading', { name: 'cuda-ssh-disabled' })).toBeVisible();
    await expect(page.getByText('SSH', { exact: true })).toBeVisible();
    await expect(page.getByText('镜像禁用')).toBeVisible();
    await expect(page.getByRole('button', { name: '修复 SSH' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /禁用 SSH|关闭 SSH|停用 SSH|Disable SSH/i })).toHaveCount(0);
    await expect(page.getByText(/ssh root@10\.8\.110\.22|SSH 用户|SSH UID/)).toHaveCount(0);
    await expect(page).toHaveScreenshot('container-detail-ssh-disabled.png', { fullPage: true });
  });

  test('container console opens a real shell session and shows container IP', async ({ page }) => {
    await page.goto(`/containers/${enabledContainerId}?tab=console`);

    await expect(page.getByRole('heading', { name: 'cuda-ssh-enabled' })).toBeVisible();
    await expect(page.getByLabel('Shell')).toBeVisible();
    await expect(page.getByText('10.8.110.21', { exact: true })).toBeVisible();
    await expect(page.getByText('已连接', { exact: true })).toBeVisible();
    await expect(page.getByText(/lab@|ssh lab@|SSH 用户|SSH UID/)).toHaveCount(0);
    await expect(page).toHaveScreenshot('container-console-toolbar-ip.png', { fullPage: true });
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

async function mockConsoleWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    class MockConsoleWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      binaryType: BinaryType = 'blob';
      bufferedAmount = 0;
      extensions = '';
      protocol = '';
      readyState = MockConsoleWebSocket.CONNECTING;
      onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
      onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
      onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
      onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
      constructor(readonly url: string | URL) {
        super();
        if (!String(url).includes('/ws/console')) return new NativeWebSocket(url) as unknown as MockConsoleWebSocket;
        window.setTimeout(() => {
          this.readyState = MockConsoleWebSocket.OPEN;
          const event = new Event('open');
          this.onopen?.call(this as unknown as WebSocket, event);
          this.dispatchEvent(event);
          const data = window.btoa('\r\nmock-shell$ ');
          const msg = new MessageEvent('message', { data: JSON.stringify({ type: 'data', data }) });
          this.onmessage?.call(this as unknown as WebSocket, msg);
          this.dispatchEvent(msg);
        }, 20);
      }
      close() {
        this.readyState = MockConsoleWebSocket.CLOSED;
        const event = new CloseEvent('close', { code: 1000, reason: 'mock closed' });
        this.onclose?.call(this as unknown as WebSocket, event);
        this.dispatchEvent(event);
      }
      send() {}
    }
    window.WebSocket = MockConsoleWebSocket as unknown as typeof WebSocket;
  });
}

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = route.request().method();

    if (path === '/servers') return json(route, [gpuServer]);
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
    if (path === '/images') return json(route, images);
    if (path === '/v2/containers') return json(route, [sshEnabledContainer, sshDisabledContainer]);
    if (path === `/v2/containers/${enabledContainerId}`) return json(route, sshEnabledContainer);
    if (path === `/v2/containers/${disabledContainerId}`) return json(route, sshDisabledContainer);
    if (path === `/v2/containers/${enabledContainerId}/stats`) return json(route, containerStats(enabledContainerId));
    if (path === `/v2/containers/${disabledContainerId}/stats`) return json(route, containerStats(disabledContainerId));
    if (path === `/v2/containers/${enabledContainerId}/actions/reconcile-ssh` && method === 'POST') {
      return json(route, { ok: true, taskId: 'task-repair-ssh', status: 'pending' });
    }
    if (path === `/v2/containers/${enabledContainerId}/exec-sessions` && method === 'POST') return json(route, { sessionId: 'mock-console-session' });
    if (path === '/data-dirs') return json(route, []);
    if (path === '/mount-sources') return json(route, []);

    return json(route, {}, 404);
  });
}

function containerView(input: { id: string; runtimeId: string; name: string; ip: string; sshEnabled: boolean; imageId?: string }) {
  return {
    id: input.id,
    serverId: 'srv-gpu',
    serverName: 'gpu-lab-01',
    ownerId: 'user-admin',
    ownerName: 'Ada Admin',
    name: input.name,
    imageId: input.imageId ?? 'img-cuda',
    phase: 'active',
    powerIntent: 'running',
    runtime: {
      bound: true,
      runtimeId: input.runtimeId,
      status: 'running',
      ip: input.ip,
      observedAt: '2026-06-01T11:30:00.000Z',
      stale: false,
      drift: [],
    },
    activeTask: null,
    resources: {
      cpuMillis: 2000,
      memBytes: 8 * 1024 ** 3,
      diskBytes: 80 * 1024 ** 3,
      gpuIndices: [0],
    },
    ssh: {
      enabled: input.sshEnabled,
      status: input.sshEnabled ? 'running' : 'disabled',
      ready: input.sshEnabled,
      disabledReason: input.sshEnabled ? undefined : 'image_ssh_disabled',
      login: input.sshEnabled ? {
        omittedServer: 'admin.cuda-ssh-enabled',
        explicitServer: 'admin.gpu-lab-01.cuda-ssh-enabled',
      } : undefined,
      proxyHost: input.sshEnabled ? 'ssh.example.test' : null,
      proxyPort: input.sshEnabled ? 2222 : null,
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
      reconcileSsh: input.sshEnabled
        ? { enabled: true }
        : { enabled: false, reason: 'image_not_available', message: 'Image has SSH disabled' },
    },
  };
}

function containerStats(containerId: string) {
  return {
    containerId,
    ts: 1780315200000,
    stats: {
      cpuUsageRatio: 0.24,
      memUsedBytes: 3 * 1024 ** 3,
      memLimitBytes: 8 * 1024 ** 3,
      netRxBytes: 123456,
      netTxBytes: 654321,
      blockReadBytes: 4096,
      blockWriteBytes: 8192,
      gpuMemUsedMiB: {},
    },
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
