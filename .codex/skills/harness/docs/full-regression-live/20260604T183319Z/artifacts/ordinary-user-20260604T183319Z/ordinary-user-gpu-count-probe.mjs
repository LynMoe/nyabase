import { readFile, writeFile } from 'node:fs/promises';
const outPath = process.argv[2];
const envText = await readFile('test/runtime/murt/current.env','utf8');
const statePath = /^NYABASE_MURT_STATE=(.*)$/m.exec(envText)?.[1]?.trim();
const state = JSON.parse(await readFile(statePath,'utf8'));
const apiBase = `${(process.env.NYABASE_BACKEND_URL ?? state.backendUrl ?? 'http://localhost:3001').replace(/\/$/,'')}/api`;
const prefix='frlive-user-20260604T183319Z-';
const result={startedAt:new Date().toISOString(), apiBase, statePath, persona:'gamma', prefix, steps:[], cleanup:{attempted:false,deleted:false,residuals:[]}, status:'unknown'};
function sanitize(body){ if(Array.isArray(body)) return body.map(sanitize); if(!body||typeof body!=='object') return body; const o={}; for(const[k,v]of Object.entries(body)) o[k]=/token|password|secret|key/i.test(k)?'<redacted>':sanitize(v); return o; }
async function raw(method,path,token,body){ const t0=Date.now(); const r=await fetch(`${apiBase}${path}`,{method,headers:{accept:'application/json',...(token?{authorization:`Bearer ${token}`}:{ } ),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}); const ct=r.headers.get('content-type')||''; const data=r.status===204?null:ct.includes('json')?await r.json().catch(()=>null):await r.text().catch(()=>''); return {method,path,status:r.status,ok:r.ok,ms:Date.now()-t0,body:data}; }
function step(name,res,extra={}){ result.steps.push({name,...extra,response:{...res,body:sanitize(res.body)}}); }
async function sleep(ms){ await new Promise(r=>setTimeout(r,ms)); }
async function waitOp(token,id,name,timeout=150000){ const samples=[]; let last; const end=Date.now()+timeout; while(Date.now()<end){ const r=await raw('GET',`/operations/${id}`,token); last=r; samples.push({ts:new Date().toISOString(),status:r.status,body:sanitize(r.body)}); if(['succeeded','failed','cancelled'].includes(r.body?.status)){ step(name,r,{samples}); return r;} await sleep(1500);} step(name,last??{method:'GET',path:`/operations/${id}`,status:0,ok:false,body:null,ms:0},{samples,timeout}); return last; }
async function waitReadable(token,id,name,timeout=90000){ const samples=[]; let last; const end=Date.now()+timeout; while(Date.now()<end){ const r=await raw('GET',`/v2/containers/${id}`,token); last=r; samples.push({ts:new Date().toISOString(),status:r.status,body:r.ok?{id:r.body.id,name:r.body.name,phase:r.body.phase,resources:r.body.resources,runtime:{bound:r.body.runtime?.bound,status:r.body.runtime?.status,stale:r.body.runtime?.stale,ip:r.body.runtime?.ip?'<present>':null},actions:r.body.actions,activeOperation:r.body.activeOperation?{id:r.body.activeOperation.id,status:r.body.activeOperation.status,lastError:r.body.activeOperation.lastError}:null}:sanitize(r.body)}); if(r.ok && ['active','failed'].includes(r.body.phase)){ step(name,r,{samples}); return r;} await sleep(1500);} step(name,last??{method:'GET',path:`/v2/containers/${id}`,status:0,ok:false,body:null,ms:0},{samples,timeout}); return last; }
try {
 const credTxt=await readFile(state.users.gamma.credentialFile,'utf8');
 const username=/^(?:USERNAME|NYABASE_USERNAME)=(.*)$/m.exec(credTxt)?.[1]?.trim() ?? state.users.gamma.username;
 const password=/^(?:PASSWORD|NYABASE_PASSWORD)=(.*)$/m.exec(credTxt)?.[1]?.trim();
 const login=await raw('POST','/auth/login',undefined,{username,password}); step('login-gamma',login,{username}); if(!login.ok) throw new Error('login failed'); const token=login.body.accessToken;
 const access=await raw('GET','/me/access',token); step('get-access',access);
 const grant=access.body?.servers?.find(s=>s.gpuMode==='indices' && s.gpuIndices?.length>0);
 const imageId=grant?.allowedImageIds?.[0];
 if(!grant||!imageId){ result.status='blocked-no-gpu-grant'; throw new Error('No GPU grant/image'); }
 const name=`${prefix}gamma-gpucount-${Date.now().toString(36)}`.toLowerCase(); result.createName=name; result.request={serverId:grant.serverId,imageId,name,cpuMillis:100,memBytes:64*1024*1024,gpuCount:1};
 const create=await raw('POST','/v2/containers',token,result.request); step('create-with-gpu-count',create,{expected:'gpuCount:1 should allocate one permitted GPU index'}); if(!create.ok){result.status='create-request-failed'; throw new Error('create failed');}
 const op=await waitOp(token,create.body.operationId,'wait-create-operation'); const id=op?.body?.resourceId; result.containerId=id;
 const view=await waitReadable(token,id,'read-created-container-terminal');
 result.observedResources=view?.body?.resources;
 result.observedPhase=view?.body?.phase;
 result.gpuCountHonored=Array.isArray(view?.body?.resources?.gpuIndices) && view.body.resources.gpuIndices.length===1;
 result.cleanup.attempted=true;
 const del=await raw('POST',`/v2/containers/${id}/actions/delete`,token); step('delete-container',del);
 if(del.ok){ const delOp=await waitOp(token,del.body.operationId,'wait-delete-operation'); result.cleanup.deleted=delOp?.body?.status==='succeeded'; }
 const list=await raw('GET','/v2/containers?ownOnly=true',token); step('list-own-after-cleanup',list);
 if(list.ok) result.cleanup.residuals=list.body.filter(c=>String(c.name||'').startsWith(prefix)).map(c=>({id:c.id,name:c.name,phase:c.phase,resources:c.resources,activeOperation:c.activeOperation?{id:c.activeOperation.id,status:c.activeOperation.status,lastError:c.activeOperation.lastError}:null}));
 result.status = result.gpuCountHonored ? 'pass-gpucount-honored' : 'fail-gpucount-ignored';
} catch(e){ result.error=e.message; if(result.status==='unknown') result.status='error'; }
result.finishedAt=new Date().toISOString();
await writeFile(outPath, JSON.stringify(result,null,2));
console.log(JSON.stringify({wrote:outPath,status:result.status,resources:result.observedResources,phase:result.observedPhase,cleanup:result.cleanup,error:result.error},null,2));
