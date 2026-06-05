import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('@playwright/test');
const outDir = process.argv[2];
await mkdir(outDir, { recursive: true });
const envText = await readFile(path.resolve('../../test/runtime/murt/current.env'), 'utf8');
const statePath = /^NYABASE_MURT_STATE=(.*)$/m.exec(envText)?.[1]?.trim();
const state = JSON.parse(await readFile(statePath, 'utf8'));
const credText = await readFile(state.users.alpha.credentialFile, 'utf8');
const username = /^(?:USERNAME|NYABASE_USERNAME)=(.*)$/m.exec(credText)?.[1]?.trim() ?? state.users.alpha.username;
const password = /^(?:PASSWORD|NYABASE_PASSWORD)=(.*)$/m.exec(credText)?.[1]?.trim();
const frontend = process.env.NYABASE_FRONTEND_URL ?? 'http://localhost:5173';
const events = [];
const shots = [];
function add(name, data={}) { events.push({ ts: new Date().toISOString(), name, ...data }); }
async function shot(page, name) {
  const p = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  shots.push(p);
  return p;
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', msg => { if (['error','warning'].includes(msg.type())) add('browser-console', { type: msg.type(), text: msg.text().slice(0,500) }); });
page.on('pageerror', err => add('page-error', { message: err.message }));
page.on('response', async res => {
  const url = res.url();
  if (url.includes('/api/')) add('api-response', { url: url.replace(/([?&]token=)[^&]+/g,'$1<redacted>'), status: res.status() });
});
try {
  await page.goto(`${frontend}/login`, { waitUntil: 'networkidle' });
  add('login-page-loaded', { url: page.url(), title: await page.title().catch(()=>'') });
  await shot(page, '01-login-page');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 }),
    page.getByRole('button', { name: '登录' }).click(),
  ]).catch(async e => { add('login-wait-error', { message: e.message, url: page.url() }); throw e; });
  await page.waitForLoadState('networkidle').catch(()=>{});
  add('logged-in', { url: page.url(), username });
  const navText = await page.locator('aside').innerText().catch(()=>'');
  add('nav-after-login', { hasAdminUsers: navText.includes('用户'), hasGroups: navText.includes('用户组'), hasAudit: navText.includes('审计'), text: navText.replace(username,'<username>').slice(0,1000) });
  await shot(page, '02-after-login-dashboard');

  await page.goto(`${frontend}/profile`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '用户中心' }).waitFor({ timeout: 10000 });
  const profileText = await page.locator('main').innerText();
  add('profile-loaded', { url: page.url(), hasUsername: profileText.includes(username), hasPasswordPanel: profileText.includes('修改密码'), hasSshPanel: profileText.includes('SSH 公钥') });
  await shot(page, '03-profile');

  await page.goto(`${frontend}/users`, { waitUntil: 'networkidle' });
  await page.getByText('无权访问').waitFor({ timeout: 10000 });
  const deniedText = await page.locator('main').innerText();
  add('admin-users-denied', { url: page.url(), deniedText: deniedText.slice(0,500), navUsersVisible: (await page.locator('aside').innerText().catch(()=>'')).split('\n').some(t=>t.trim()==='用户') });
  await shot(page, '04-admin-users-denied');

  await page.goto(`${frontend}/containers`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '容器' }).waitFor({ timeout: 10000 });
  const containersText = await page.locator('main').innerText();
  add('containers-page-loaded', { url: page.url(), hasCpuServer: containersText.includes('nyabase-test-cpu'), hasGpuServer: containersText.includes('nyabase-test-gpu'), hasNewButton: containersText.includes('新建容器') });
  await shot(page, '05-containers-page');
  await page.getByRole('button', { name: /新建容器/ }).first().click();
  await page.getByRole('heading', { name: '新建容器' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(1000);
  const dialogText = await page.locator('[role="dialog"]').innerText();
  const serverOptions = await page.locator('[role="dialog"] select').first().locator('option').evaluateAll(opts => opts.map(o => ({ text: o.textContent, disabled: o.disabled, value: o.value })));
  add('create-dialog-open', { hasCpuGrant: dialogText.includes('nyabase-test-cpu'), hasGpuGrant: dialogText.includes('nyabase-test-gpu'), hasGrantedImage: dialogText.includes(state.images.cpuA?.name ?? 'missing-image'), serverOptions });
  await shot(page, '06-create-dialog');
  await page.keyboard.press('Escape').catch(()=>{});
  add('ui-probe-status', { status: 'pass' });
} catch (e) {
  add('ui-probe-status', { status: 'fail', message: e.message });
  await shot(page, '99-failure').catch(()=>{});
} finally {
  await context.close().catch(()=>{});
  await browser.close().catch(()=>{});
  await writeFile(path.join(outDir, 'ui-summary.json'), JSON.stringify({ frontend, statePath, username, events, screenshots: shots }, null, 2));
}
