import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/root/nyabase/node_modules/.pnpm/@playwright+test@1.60.0/node_modules/@playwright/test');
import fs from 'node:fs/promises';
const OUT = '.codex/skills/harness/docs/full-regression-live/20260604T183319Z/artifacts/admin-20260604T183319Z';
const BASE = 'http://localhost:5173';
const API = 'http://localhost:3001/api';
const password = process.env.NYABASE_ADMIN_PASSWORD || process.env.ADMIN_INIT_PASSWORD || '';
if (!password) throw new Error('Admin password not supplied via environment');
async function api(path, token) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
const loginRes = await fetch(API + '/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password }),
});
if (!loginRes.ok) throw new Error(`API login failed ${loginRes.status}`);
const login = await loginRes.json();
const groups = await api('/groups', login.accessToken);
const quotaGroup = groups.find(g => g.name === 'Users') || groups[0];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const shots = [];
try {
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(BASE + '/', { timeout: 20000 });
  await page.waitForLoadState('networkidle');

  await page.goto(BASE + '/users', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '用户管理' }).waitFor({ timeout: 15000 });
  const usersPath = `${OUT}/ui-users-admin.png`;
  await page.screenshot({ path: usersPath, fullPage: true });
  shots.push({ path: usersPath, route: '/users', state: 'admin user table and permission controls' });

  await page.goto(BASE + '/manage/containers', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '容器管理' }).waitFor({ timeout: 15000 });
  const containersPath = `${OUT}/ui-manage-containers-admin.png`;
  await page.screenshot({ path: containersPath, fullPage: true });
  shots.push({ path: containersPath, route: '/manage/containers', state: 'admin global container management' });

  await page.goto(BASE + `/groups/${quotaGroup.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '服务器授权' }).click();
  await page.waitForTimeout(500);
  const editOrGrant = page.getByRole('button', { name: /^(授权|编辑)$/ }).first();
  if (await editOrGrant.count()) {
    await editOrGrant.click();
    await page.getByText('CPU (核)').waitFor({ timeout: 10000 });
  }
  const quotaPath = `${OUT}/ui-group-quota-grants-admin.png`;
  await page.screenshot({ path: quotaPath, fullPage: true });
  shots.push({ path: quotaPath, route: `/groups/${quotaGroup.id}`, state: `server quota/grant form for group ${quotaGroup.name}` });

  await fs.writeFile(`${OUT}/admin-ui-screenshots.json`, JSON.stringify({
    capturedAt: new Date().toISOString(), frontend: BASE, shots,
    tokenHandling: 'login was performed via UI; secrets not persisted in artifact',
  }, null, 2) + '\n');
  console.log(JSON.stringify({ shots }, null, 2));
} finally {
  await browser.close();
}
