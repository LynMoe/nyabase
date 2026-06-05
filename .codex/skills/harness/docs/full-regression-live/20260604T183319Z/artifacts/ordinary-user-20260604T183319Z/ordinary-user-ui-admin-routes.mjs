import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('@playwright/test');
const outDir=process.argv[2]; await mkdir(outDir,{recursive:true});
const envText=await readFile(path.resolve('../../test/runtime/murt/current.env'),'utf8');
const statePath=/^NYABASE_MURT_STATE=(.*)$/m.exec(envText)?.[1]?.trim();
const state=JSON.parse(await readFile(statePath,'utf8'));
const credText=await readFile(state.users.alpha.credentialFile,'utf8');
const username=/^(?:USERNAME|NYABASE_USERNAME)=(.*)$/m.exec(credText)?.[1]?.trim()??state.users.alpha.username;
const password=/^(?:PASSWORD|NYABASE_PASSWORD)=(.*)$/m.exec(credText)?.[1]?.trim();
const frontend=process.env.NYABASE_FRONTEND_URL??'http://localhost:5173';
const routes=['/users','/servers','/images','/groups','/audit','/manage/containers','/manage/remote-fs'];
const result={frontend,statePath,username,startedAt:new Date().toISOString(),routes:[],apiResponses:[]};
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1366,height:900}}); const page=await context.newPage();
page.on('response', res=>{ const url=res.url(); if(url.includes('/api/')) result.apiResponses.push({ts:new Date().toISOString(),url:url.replace(/([?&]token=)[^&]+/g,'$1<redacted>'),status:res.status()}); });
try{
 await page.goto(`${frontend}/login`,{waitUntil:'networkidle'});
 await page.getByLabel('用户名').fill(username); await page.getByLabel('密码').fill(password);
 await Promise.all([page.waitForURL(u=>!u.pathname.startsWith('/login'),{timeout:15000}), page.getByRole('button',{name:'登录'}).click()]);
 await page.waitForLoadState('networkidle').catch(()=>{});
 for(const route of routes){
   await page.goto(`${frontend}${route}`,{waitUntil:'networkidle'}).catch(()=>{});
   await page.waitForTimeout(800);
   const text=(await page.locator('main').innerText().catch(()=>''));
   const aside=(await page.locator('aside').innerText().catch(()=>''));
   const denied=text.includes('无权访问')||text.includes('没有访问该页面的权限');
   const shot=path.join(outDir,`admin-route-${route.replaceAll('/','_').replace(/^_/, '') || 'root'}.png`);
   await page.screenshot({path:shot,fullPage:true});
   result.routes.push({route,finalUrl:page.url(),denied,redirected:!new URL(page.url()).pathname.startsWith(route),hasAdminAction:/添加|新建|删除|权限|容器管理|审计日志|服务器|容器镜像|用户组管理|远程文件系统/.test(text),mainText:text.slice(0,1000),adminNavVisible:{servers:aside.split('\n').some(t=>t.trim()==='服务器'),images:aside.split('\n').some(t=>t.trim()==='镜像'),manageContainers:aside.includes('容器管理'),users:aside.split('\n').some(t=>t.trim()==='用户'),groups:aside.includes('用户组'),audit:aside.includes('审计')},screenshot:shot});
 }
}finally{ await context.close().catch(()=>{}); await browser.close().catch(()=>{}); result.finishedAt=new Date().toISOString(); await writeFile(path.join(outDir,'admin-routes-summary.json'),JSON.stringify(result,null,2)); }
