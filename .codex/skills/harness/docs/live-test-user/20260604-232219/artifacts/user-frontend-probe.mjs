import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const outDir = process.env.OUT_DIR || '.codex/skills/harness/docs/live-test-user/20260604-232219/artifacts';
await mkdir(outDir,{recursive:true});
const api='http://localhost:3001/api'; const frontend='http://localhost:5173';
const runId=`ultui-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${randomUUID().slice(0,6)}`;
const steps=[]; const resources={}; const failures=[];
async function req(method,path,token,body){const r=await fetch(api+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});const t=await r.text();let b;try{b=t?JSON.parse(t):null}catch{b=t}steps.push({kind:'api',method,path,status:r.status});return{status:r.status,ok:r.ok,body:b,text:t}}
try{
 const admin=(await req('POST','/auth/login',null,{username:'admin',password:'admin123'})).body; const at=admin.accessToken||admin.token;
 const servers=(await req('GET','/servers',at)).body; const server=servers.find(s=>s.status==='online')||servers[0]; resources.serverId=server.id;
 const images=(await req('GET','/images',at)).body; const image=images.find(i=>i.serverId===server.id)||images[0]; resources.imageId=image.id;
 const username=`${runId}-user`; const password=`Pwd-${runId}-123!`; resources.username=username; resources.password=password;
 const user=(await req('POST','/users',at,{username,password,displayName:runId,isAdmin:false})).body; resources.userId=user.id;
 await req('POST',`/users/${user.id}/server-grants/${server.id}`,at,{cpuMillis:500,memBytes:268435456,diskBytes:536870912,gpuMode:'none',gpuIndices:[]});
 await req('POST',`/users/${user.id}/image-grants`,at,{imageId:image.id,serverId:server.id});
 const browser=await chromium.launch({headless:true}); const page=await browser.newPage({viewport:{width:1366,height:900}});
 page.on('console',msg=>steps.push({kind:'console',type:msg.type(),text:msg.text().slice(0,300)}));
 page.on('requestfailed',req=>steps.push({kind:'requestfailed',url:req.url(),failure:req.failure()?.errorText}));
 await page.goto(`${frontend}/login`,{waitUntil:'networkidle'});
 await page.screenshot({path:`${outDir}/frontend-login.png`,fullPage:true});
 await page.getByLabel(/用户名|username/i).fill(username).catch(async()=>{await page.locator('input').first().fill(username)});
 await page.getByLabel(/密码|password/i).fill(password).catch(async()=>{await page.locator('input[type="password"]').fill(password)});
 await page.getByRole('button',{name:/登录|login/i}).click();
 await page.waitForURL(/\/$|containers|profile|login/,{timeout:15000}).catch(()=>{});
 await page.goto(`${frontend}/containers`,{waitUntil:'networkidle'});
 await page.screenshot({path:`${outDir}/frontend-containers.png`,fullPage:true});
 steps.push({kind:'ui',url:page.url(),title:await page.title(),bodyText:(await page.locator('body').innerText()).slice(0,1000)});
 await browser.close();
 await req('DELETE',`/users/${user.id}`,at);
}catch(e){failures.push({error:String(e.stack||e)});}
await writeFile(`${outDir}/user-frontend-probe.json`,JSON.stringify({runId,resources,steps,failures},null,2));
if(failures.length) process.exitCode=1;
