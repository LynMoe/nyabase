import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/live-stack.js';
import { coverageCase } from '../../support/coverage-marker.js';
import {
  cleanupContainerThroughProductApi,
  waitForAgentTask,
  waitForContainer,
  type AgentTaskRef,
  type ContainerView,
} from '../../support/durable-api.js';
import { runCleanupStepsPreservingPrimary } from '../../support/error-diagnostics.mjs';
import { expectJson, expectSuccess } from '../../support/http.js';
import { currentRunId, requireRuntimeEnv } from '../../support/runtime-env.js';

interface UserView { id: string; username: string }
interface GroupView { id: string; name: string; isSystem: boolean }
interface ImageView { id: string; name: string }
interface ServerView { id: string; name: string; slug: string }
interface SettingsView {
  revision: number;
  snapshotToken: string;
  fields: Array<{ key: string; effectiveValue: unknown; editable: boolean; source: string }>;
}
interface PublicSettingsView { branding: { description: string } }

test.describe('70 real browser', () => {
  test('browser.routes.every-authorized-route-renders-semantic-content', coverageCase(
    'browser.cpu-product.all-routes-by-authorized-persona',
    'browser.routes.every-authorized-route-renders-semantic-content',
  ), async ({ page, adminApi, seedState }) => {
    test.setTimeout(300_000);
    const errors = captureBrowserErrors(page);
    const containerName = `${currentRunId().slice(0, 38)}-${Date.now().toString(36)}-route`;
    let containerId: string | null = null;
    try {
      await loginAs(page, requireRuntimeEnv('E2E_ADMIN_USERNAME'), requireRuntimeEnv('E2E_ADMIN_PASSWORD'));
      await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();

      const groups = await expectJson<GroupView[]>(await adminApi.get('/api/admin/groups'));
      expect(groups.length).toBeGreaterThan(0);
      const servers = await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers'));
      const server = servers.find((entry) => entry.id === seedState.servers[0].serverId);
      expect(server).toBeDefined();

      const create = await expectJson<AgentTaskRef>(await adminApi.post('/api/v2/containers', {
        data: {
          serverId: seedState.servers[0].serverId,
          imageId: seedState.image.id,
          name: containerName,
        },
      }), 201);
      const createTask = await waitForAgentTask(adminApi, create.taskId, { kind: 'container.create' });
      containerId = createTask.resourceId;
      await waitForContainer(
        adminApi,
        containerId,
        'browser route fixture running',
        (view) => view.runtime.status === 'running' && view.activeTask === null,
      );

      await visitDashboard(page);
      await visitHeading(page, '/audit', '审计日志');
      await visitHeading(page, `/containers/${containerId}`, containerName);
      await visitHeading(page, '/containers', '容器');
      await visitHeading(page, '/data-dirs', '数据目录');
      await visitHeading(page, `/groups/${groups[0].id}`, groups[0].name);
      await visitHeading(page, '/groups', '用户组管理');
      await visitHeading(page, '/http-proxy', 'HTTP 反代');
      await visitHeading(page, '/images', '容器镜像');
      await visitHeading(page, `/manage/containers/${containerId}`, containerName);
      await visitHeading(page, '/manage/containers', '容器管理');
      await visitHeading(page, '/manage/remote-fs', '远程文件系统');
      await visitHeading(page, '/profile', '用户中心');
      await visitHeading(page, `/servers/${server!.id}`, server!.name);
      await visitHeading(page, '/servers', '服务器');
      await visitHeading(page, '/ssh-proxy', 'SSH 代理');
      await visitHeading(page, '/system-settings', '系统设置');
      await visitHeading(page, '/users', '用户管理');

      // login.tsx is also exercised by loginAs; an authenticated revisit must
      // follow the route's real redirect contract rather than rendering a
      // second login shell.
      await page.goto('/login');
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('button', { name: '用户维度' })).toBeVisible();
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      if (containerId) await cleanupContainerThroughProductApi(adminApi, containerId);
    }
  });

  test('browser.rbac.no-access-persona-denied-on-every-capability-route', coverageCase(
    'browser.cpu-product.all-routes-denied-for-no-access-persona',
    'browser.rbac.no-access-persona-denied-on-every-capability-route',
  ), async ({ page, adminApi, seedState }) => {
    const suffix = `${currentRunId().replaceAll('-', '').slice(-12)}${Date.now().toString(36)}`.slice(-24);
    const username = `browser_${suffix}`;
    const password = `E2e-${suffix}-Browser!`;
    let userId: string | null = null;
    try {
      const user = await expectJson<UserView>(await adminApi.post('/api/admin/users', {
        data: { username, password, displayName: `Browser ${suffix}` },
      }), 201);
      userId = user.id;
      const groups = await expectJson<GroupView[]>(await adminApi.get('/api/admin/groups'));
      const protectedRoutes = [
        '/audit',
        '/groups',
        `/groups/${groups[0].id}`,
        '/images',
        '/manage/containers',
        '/manage/containers/not-owned',
        '/manage/remote-fs',
        '/servers',
        `/servers/${seedState.servers[0].serverId}`,
        '/ssh-proxy',
        '/system-settings',
        '/users',
      ];

      await loginAs(page, username, password);
      for (const path of protectedRoutes) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: '无权访问' })).toBeVisible();
        await expect(page.getByText('当前账号没有访问该页面的权限。')).toBeVisible();
      }
      for (const adminNav of ['服务器', '镜像', '容器管理', '远程文件系统', 'SSH 代理', '用户', '用户组', '审计', '系统设置']) {
        await expect(page.getByRole('link', { name: adminNav, exact: true })).toHaveCount(0);
      }
    } finally {
      if (userId) await expectSuccess(await adminApi.delete(`/api/admin/users/${userId}`));
    }
  });

  test('browser.auth.real-login-and-logout-session-lifecycle', coverageCase(
    'browser.cpu-product.login-and-logout',
    'browser.auth.real-login-and-logout-session-lifecycle',
  ), async ({ page }) => {
    await loginAs(page, requireRuntimeEnv('E2E_ADMIN_USERNAME'), requireRuntimeEnv('E2E_ADMIN_PASSWORD'));
    await expect(page.getByText(requireRuntimeEnv('E2E_ADMIN_USERNAME'), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出登录' }).click();
    await expectLoginRedirect(page, '/');
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
    await page.goto('/users');
    await expectLoginRedirect(page, '/users');
    await submitLoginForm(
      page,
      requireRuntimeEnv('E2E_ADMIN_USERNAME'),
      requireRuntimeEnv('E2E_ADMIN_PASSWORD'),
    );
    await expect(page).toHaveURL((url) => url.pathname === '/users');
    await expect(page.getByRole('heading', { level: 1, name: '用户管理' })).toBeVisible();
  });

  test('browser.mutations.real-ui-capability-families', coverageCase(
    'browser.cpu-product.one-real-mutation-per-ui-capability-family',
    'browser.mutations.real-ui-capability-families',
  ), async ({ page, adminApi, seedState }) => {
    test.setTimeout(360_000);
    const runKey = `${currentRunId().replaceAll('-', '').slice(-10)}${Date.now().toString(36)}`.slice(-20);
    const username = `ui_${runKey}`;
    const groupName = `${currentRunId()} UI group ${runKey}`;
    const imageName = `${currentRunId()} UI image ${runKey}`;
    const containerName = `${currentRunId().slice(0, 36)}-${runKey}-ui`.slice(0, 64);
    const settingValue = 181;
    let userId: string | null = null;
    let groupId: string | null = null;
    let imageId: string | null = null;
    let containerId: string | null = null;

    const beforeSettings = await expectJson<SettingsView>(await adminApi.get('/api/admin/system-settings'));
    const retentionDays = setting(beforeSettings, 'audit.retentionDays');
    expect(retentionDays.editable).toBe(true);
    expect(retentionDays.source).not.toBe('env');
    const originalRetentionDays = Number(retentionDays.effectiveValue);
    expect(Number.isInteger(originalRetentionDays)).toBe(true);
    const servers = await expectJson<ServerView[]>(await adminApi.get('/api/admin/servers'));
    const server = servers.find((entry) => entry.id === seedState.servers[0].serverId);
    expect(server).toBeDefined();
    const originalServerName = server!.name;
    const changedServerName = `${originalServerName} UI`;

    try {
      await loginAs(page, requireRuntimeEnv('E2E_ADMIN_USERNAME'), requireRuntimeEnv('E2E_ADMIN_PASSWORD'));

      // ManageUsers: create a real account through the production UI.
      await page.goto('/users');
      await page.getByRole('button', { name: '添加用户' }).click();
      let dialog = page.getByRole('dialog');
      await dialog.locator('input').nth(0).fill(username);
      await dialog.locator('input').nth(1).fill(`E2e-${runKey}-User!`);
      await dialog.locator('input').nth(2).fill(`UI ${runKey}`);
      await dialog.getByRole('button', { name: '创建', exact: true }).click();
      await expect(page.getByText('用户已创建（已加入 Users 组）', { exact: true })).toBeVisible();
      userId = (await waitForNamed<UserView>(adminApi, '/api/admin/users', (entry) => entry.username === username)).id;
      await expect(page.getByText(username, { exact: true })).toBeVisible();

      // ManageGroups/ManageGrants family: create a mutable group through UI.
      await page.goto('/groups');
      await page.getByRole('button', { name: '新建用户组' }).click();
      dialog = page.getByRole('dialog');
      await dialog.locator('input').nth(0).fill(groupName);
      await dialog.locator('input').nth(2).fill('real browser capability mutation');
      await dialog.getByRole('button', { name: '创建', exact: true }).click();
      await expect(page.getByText('用户组已创建', { exact: true })).toBeVisible();
      groupId = (await waitForNamed<GroupView>(adminApi, '/api/admin/groups', (entry) => entry.name === groupName)).id;
      await expect(page.getByText(groupName, { exact: true })).toBeVisible();

      // ManageImages: add a real CPU-only image definition through UI.
      await page.goto('/images');
      await page.getByRole('button', { name: '添加镜像' }).first().click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('名称').fill(imageName);
      await dialog.getByLabel('Docker 镜像').fill(seedState.uiImage.dockerImage);
      await dialog.getByRole('checkbox').last().check();
      const [imageCreateResponse] = await Promise.all([
        page.waitForResponse((response) => (
          response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/api/admin/images'
        )),
        dialog.getByRole('button', { name: '添加', exact: true }).click(),
      ]);
      expect(imageCreateResponse.status()).toBe(201);
      await expect(page.getByText('镜像已添加', { exact: true })).toBeVisible();
      imageId = (await waitForNamed<ImageView>(adminApi, '/api/admin/images', (entry) => entry.name === imageName)).id;
      await expect(page.getByRole('heading', { name: imageName })).toBeVisible();

      // ManageServers: mutate only the display name of the live server, then
      // restore it through the product API in finally.
      await page.goto(`/servers/${server!.id}`);
      await page.getByText('配置信息', { exact: true }).locator('..').getByRole('button').click();
      dialog = page.getByRole('dialog');
      await dialog.locator('input').nth(0).fill(changedServerName);
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('服务器配置已更新', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: changedServerName })).toBeVisible();

      // ManageSystemSettings: change a non-public, online-editable field.
      await page.goto('/system-settings');
      await page.locator('[id="setting-audit.retentionDays"]').fill(String(settingValue));
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('系统设置已保存', { exact: true })).toBeVisible();
      expect(setting(await expectJson<SettingsView>(await adminApi.get('/api/admin/system-settings')), 'audit.retentionDays').effectiveValue).toBe(settingValue);

      // Owner runtime family: create through the user-facing dialog and prove
      // the durable Agent task converges on a real CPU node.
      await page.goto('/containers');
      await page.getByRole('button', { name: '新建容器' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel(/服务器/).selectOption(seedState.servers[0].serverId);
      await expect(dialog.getByLabel(/镜像/).locator(`option[value="${seedState.image.id}"]`)).toHaveCount(1);
      await dialog.getByLabel(/镜像/).selectOption(seedState.image.id);
      await dialog.getByLabel(/容器名称/).fill(containerName);
      await dialog.getByRole('button', { name: '创建容器' }).click();
      await expect(page.getByText('容器创建已排队')).toBeVisible();
      const container = await waitForNamed<ContainerView>(
        adminApi,
        '/api/v2/containers',
        (entry) => entry.name === containerName,
        120_000,
      );
      containerId = container.id;
      const running = await waitForContainer(
        adminApi,
        container.id,
        'real UI-created container running',
        (view) => view.runtime.status === 'running' && view.activeTask === null,
        120_000,
      );
      expect(running.serverId).toBe(seedState.servers[0].serverId);
      expect(running.resources.gpuIndices).toEqual([]);
      await expect(page.getByText(containerName, { exact: true })).toBeVisible();
    } finally {
      if (containerId) await cleanupContainerThroughProductApi(adminApi, containerId);
      imageId ??= await findId<ImageView>(adminApi, '/api/admin/images', (entry) => entry.name === imageName);
      groupId ??= await findId<GroupView>(adminApi, '/api/admin/groups', (entry) => entry.name === groupName);
      userId ??= await findId<UserView>(adminApi, '/api/admin/users', (entry) => entry.username === username);
      if (imageId) await expectSuccess(await adminApi.delete(`/api/admin/images/${imageId}`));
      if (groupId) await expectSuccess(await adminApi.delete(`/api/admin/groups/${groupId}`));
      if (userId) await expectSuccess(await adminApi.delete(`/api/admin/users/${userId}`));
      await expectSuccess(await adminApi.patch(`/api/admin/servers/${server!.id}`, {
        data: { name: originalServerName, slug: server!.slug },
      }));
      const currentSettings = await expectJson<SettingsView>(
        await adminApi.get('/api/admin/system-settings'),
      );
      await expectSuccess(
        await adminApi.patch('/api/admin/system-settings', {
          data: {
            expectedRevision: currentSettings.revision,
            expectedSnapshotToken: currentSettings.snapshotToken,
            values: { 'audit.retentionDays': originalRetentionDays },
          },
        }),
      );
    }
  });

  test('browser.states.real-empty-error-and-durable-convergence', coverageCase(
    'browser.cpu-product.loading-empty-error-and-convergence-states',
    'browser.states.real-empty-error-and-durable-convergence',
  ), async ({ page, adminApi, anonymousApi, seedState }) => {
    test.setTimeout(300_000);
    const name = `${currentRunId().slice(0, 38)}-${Date.now().toString(36)}-state`;
    const userSuffix = `${currentRunId().replaceAll('-', '').slice(-10)}${Date.now().toString(36)}`.slice(-20);
    const username = `empty_${userSuffix}`;
    const password = `E2e-${userSuffix}-Empty!`;
    let containerId: string | null = null;
    let userId: string | null = null;
    let originalBrandDescription: string | null = null;
    let primaryFailure: { error: unknown } | null = null;
    try {
      await loginAs(page, requireRuntimeEnv('E2E_ADMIN_USERNAME'), requireRuntimeEnv('E2E_ADMIN_PASSWORD'));

      // Real backend CAS error, with no route mocking. Both values pass the
      // shared schema, so the browser sends its stale revision to Backend.
      await page.goto('/system-settings');
      const descriptionInput = page.locator('[id="setting-branding.description"]');
      await expect(descriptionInput).toBeVisible();
      const beforeSettings = await expectJson<SettingsView>(
        await adminApi.get('/api/admin/system-settings'),
      );
      const description = setting(beforeSettings, 'branding.description');
      expect(description.editable).toBe(true);
      expect(description.source).not.toBe('env');
      originalBrandDescription = String(description.effectiveValue);
      const conflictSuffix = `${currentRunId().slice(-12)}-${Date.now().toString(36)}`;
      const localDescription = `Browser local ${conflictSuffix}`;
      const remoteDescription = `Backend remote ${conflictSuffix}`;
      expect(new Set([originalBrandDescription, localDescription, remoteDescription]).size).toBe(3);

      await descriptionInput.fill(localDescription);
      const remotelyUpdated = await expectJson<SettingsView>(
        await adminApi.patch('/api/admin/system-settings', {
          data: {
            expectedRevision: beforeSettings.revision,
            expectedSnapshotToken: beforeSettings.snapshotToken,
            values: { 'branding.description': remoteDescription },
          },
        }),
      );
      expect(setting(remotelyUpdated, 'branding.description').effectiveValue).toBe(remoteDescription);

      const [staleSaveResponse] = await Promise.all([
        page.waitForResponse((response) => (
          response.request().method() === 'PATCH'
          && new URL(response.url()).pathname === '/api/admin/system-settings'
        )),
        page.getByRole('button', { name: '保存', exact: true }).click(),
      ]);
      expect(staleSaveResponse.status()).toBe(409);
      await expect(page.getByText('服务器设置已变化', { exact: true })).toBeVisible();
      await expect(page.getByText('服务器冲突', { exact: true })).toBeVisible();
      await expect(descriptionInput).toHaveValue(localDescription);
      expect(setting(
        await expectJson<SettingsView>(await adminApi.get('/api/admin/system-settings')),
        'branding.description',
      ).effectiveValue).toBe(remoteDescription);
      await page.getByRole('button', { name: '使用服务器值', exact: true }).click();
      await expect(descriptionInput).toHaveValue(remoteDescription);

      // Real pending -> terminal convergence from browser mutation.
      const created = await expectJson<AgentTaskRef>(await adminApi.post('/api/v2/containers', {
        data: {
          serverId: seedState.servers[0].serverId,
          imageId: seedState.image.id,
          name,
        },
      }), 201);
      const pending = await expectJson<{ resourceId: string; status: string }>(
        await adminApi.get(`/api/admin/agent-tasks/${created.taskId}`),
      );
      containerId = pending.resourceId;
      expect(['pending', 'succeeded']).toContain(pending.status);
      await page.goto(`/containers/${containerId}`);
      await expect(page.getByText(/任务处理中|creating|运行中|running/).first()).toBeVisible();
      await waitForAgentTask(adminApi, created.taskId, { kind: 'container.create', resourceId: containerId });
      await waitForContainer(
        adminApi,
        containerId,
        'browser-observed terminal convergence',
        (view) => view.runtime.status === 'running' && view.activeTask === null,
      );
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      await expect(page.getByText('running', { exact: true }).first()).toBeVisible();

      // Natural empty state from an authenticated account with no server or
      // image grants. This is the production empty-state branch, not a mock.
      const user = await expectJson<UserView>(await adminApi.post('/api/admin/users', {
        data: { username, password, displayName: `Empty ${userSuffix}` },
      }), 201);
      userId = user.id;
      await page.getByRole('button', { name: '退出登录' }).click();
      await expectLoginRedirect(page, `/containers/${containerId}?tab=overview`);
      await loginAs(page, username, password);
      await page.goto('/containers');
      await expect(page.getByText('暂无可访问的服务器。请联系管理员为你分配服务器和镜像权限。')).toBeVisible();
    } catch (error) {
      primaryFailure = { error };
    } finally {
      await runCleanupStepsPreservingPrimary('Browser states cleanup failed', [
        async () => {
          if (originalBrandDescription !== null) {
            await restoreSystemSetting(
              adminApi,
              'branding.description',
              originalBrandDescription,
            );
            const restoredPublicSettings = await expectJson<PublicSettingsView>(
              await anonymousApi.get('/api/public/settings'),
            );
            expect(restoredPublicSettings.branding.description).toBe(originalBrandDescription);
          }
        },
        async () => {
          if (containerId) await cleanupContainerThroughProductApi(adminApi, containerId);
        },
        async () => {
          if (userId) await expectSuccess(await adminApi.delete(`/api/admin/users/${userId}`));
        },
      ], primaryFailure);
    }
  });

  test('browser.console.all-core-routes-have-no-errors', coverageCase(
    'browser.cpu-product.no-browser-console-errors',
    'browser.console.all-core-routes-have-no-errors',
  ), async ({ page }) => {
    const errors = captureBrowserErrors(page);
    await loginAs(page, requireRuntimeEnv('E2E_ADMIN_USERNAME'), requireRuntimeEnv('E2E_ADMIN_PASSWORD'));
    for (const path of ['/', '/containers', '/data-dirs', '/http-proxy', '/servers', '/images', '/users', '/groups', '/audit', '/system-settings']) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('browser.auth.login-and-dashboard-real-journey', coverageCase(
    'browser.cpu-product.login-dashboard-journey',
    'browser.auth.login-and-dashboard-real-journey',
  ), async ({ page }) => {
    const errors = captureBrowserErrors(page);
    await loginAs(page, requireRuntimeEnv('E2E_ADMIN_USERNAME'), requireRuntimeEnv('E2E_ADMIN_PASSWORD'));
    await expect(page.getByRole('button', { name: '用户维度' })).toBeVisible();
    await expect(page.getByRole('button', { name: '容器维度' })).toBeVisible();
    await expect(page.locator('select').first()).not.toHaveValue('');
    await expect(page.getByText('online', { exact: true })).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('browser.auth.anonymous-protected-route-redirects-to-login', coverageCase(
    'browser.cpu-product.anonymous-route-redirect',
    'browser.auth.anonymous-protected-route-redirects-to-login',
  ), async ({ page }) => {
    await page.goto('/users');
    await expectLoginRedirect(page, '/users');
    await expect(page.getByLabel('用户名')).toBeVisible();
    await expect(page.getByLabel('密码')).toBeVisible();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  });
});

async function loginAs(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await submitLoginForm(page, username, password);
  await expect(page).toHaveURL((url) => url.pathname !== '/login');
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
}

async function submitLoginForm(page: Page, username: string, password: string): Promise<void> {
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
}

async function expectLoginRedirect(page: Page, redirect: string): Promise<void> {
  await expect(page).toHaveURL((url) =>
    url.pathname === '/login' &&
    url.searchParams.get('redirect') === redirect &&
    [...url.searchParams.keys()].length === 1 &&
    url.hash === '',
  );
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function visitDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '用户维度' })).toBeVisible();
  await expect(page.getByRole('button', { name: '容器维度' })).toBeVisible();
}

async function visitHeading(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
}

function setting(settings: SettingsView, key: string): SettingsView['fields'][number] {
  const found = settings.fields.find((entry) => entry.key === key);
  if (!found) throw new Error(`system setting ${key} is absent`);
  return found;
}

async function restoreSystemSetting(
  api: APIRequestContext,
  key: string,
  value: unknown,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await expectJson<SettingsView>(await api.get('/api/admin/system-settings'));
    if (setting(current, key).effectiveValue === value) return;
    const response = await api.patch('/api/admin/system-settings', {
      data: {
        expectedRevision: current.revision,
        expectedSnapshotToken: current.snapshotToken,
        values: { [key]: value },
      },
    });
    if (response.status() === 409) continue;
    const restored = await expectJson<SettingsView>(response);
    expect(setting(restored, key).effectiveValue).toBe(value);
    return;
  }
  throw new Error(`system setting ${key} restore did not converge after revision conflicts`);
}

async function waitForNamed<T>(
  api: APIRequestContext,
  path: string,
  match: (entry: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await expectJson<T[]>(await api.get(path));
    const found = entries.find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`browser mutation did not converge in API list ${path}`);
}

async function findId<T extends { id: string }>(
  api: APIRequestContext,
  path: string,
  match: (entry: T) => boolean,
): Promise<string | null> {
  const entries = await expectJson<T[]>(await api.get(path));
  return entries.find(match)?.id ?? null;
}
