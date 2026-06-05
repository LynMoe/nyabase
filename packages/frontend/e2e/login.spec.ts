import { expect, test } from '@playwright/test';

test.describe('public access', () => {
  test('login page matches the visual baseline', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: 'nyabase' })).toBeVisible();
    await expect(page.getByLabel('用户名')).toBeVisible();
    await expect(page.getByLabel('密码')).toBeVisible();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
    await expect(page).toHaveScreenshot('login-page.png', { fullPage: true });
  });

  test('home redirects unauthenticated users to login', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'nyabase' })).toBeVisible();
  });
});
