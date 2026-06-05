const { chromium } = require('/root/nyabase/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright');
const { mkdir } = require('node:fs/promises');
(async()=>{
const outDir = '.codex/skills/harness/docs/live-test-admin/20260604-232209-admin/artifacts/ui';
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, baseURL: 'http://localhost:5173' });
const logs = [];
page.on('console', msg => logs.push(`console:${msg.type()}:${msg.text()}`));
page.on('requestfailed', req => logs.push(`requestfailed:${req.method()} ${req.url()} ${req.failure()?.errorText}`));
try {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('admin123');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 15000 });
  await page.screenshot({ path: `${outDir}/admin-dashboard.png`, fullPage: true });
  for (const [path, file, heading] of [['/users','admin-users.png','用户管理'],['/images','admin-images.png','容器镜像']]) {
    await page.goto(path);
    await page.getByRole('heading', { name: heading }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${outDir}/${file}`, fullPage: true });
  }
  console.log(JSON.stringify({ status: 'pass', url: page.url(), screenshots: [`${outDir}/admin-dashboard.png`, `${outDir}/admin-users.png`, `${outDir}/admin-images.png`], logs }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${outDir}/admin-ui-failure.png`, fullPage: true }).catch(()=>{});
  console.error(JSON.stringify({ status: 'fail', error: String(error), url: page.url(), logs, screenshot: `${outDir}/admin-ui-failure.png` }, null, 2));
  process.exitCode = 1;
} finally { await browser.close(); }
})()
