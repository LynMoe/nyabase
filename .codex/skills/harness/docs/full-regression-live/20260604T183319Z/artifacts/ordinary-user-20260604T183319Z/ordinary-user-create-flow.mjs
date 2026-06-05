import { readFile, writeFile } from 'node:fs/promises';
const outPath = process.argv[2];
const startedAt = new Date().toISOString();
const envText = await readFile('test/runtime/murt/current.env', 'utf8');
const statePath = /^NYABASE_MURT_STATE=(.*)$/m.exec(envText)?.[1]?.trim();
const state = JSON.parse(await readFile(statePath, 'utf8'));
const apiBase = `${(process.env.NYABASE_BACKEND_URL ?? state.backendUrl ?? 'http://localhost:3001').replace(/\/$/, '')}/api`;
const prefix = 'frlive-user-20260604T183319Z-';
const result = { startedAt, apiBase, statePath, prefix, persona:'alpha', steps: [], cleanup: { attempted:false, deleted:false, residuals:[] }, status: 'unknown' };
function sanitizeBody(body) {
  if (Array.isArray(body)) return body.map(sanitizeBody);
  if (!body || typeof body !== 'object') return body;
  const out = {};
  for (const [k,v] of Object.entries(body)) {
    if (/token|password|secret|key/i.test(k)) { out[k] = '<redacted>'; continue; }
    out[k] = sanitizeBody(v);
  }
  return out;
}
async function raw(method, path, token, body) {
  const t0=Date.now();
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = res.status === 204 ? null : ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { method, path, status: res.status, ok: res.ok, ms: Date.now()-t0, body: data };
}
function step(name, res, extra={}) { result.steps.push({ name, ...extra, response:{...res, body:sanitizeBody(res.body)} }); }
async function sleep(ms){ await new Promise(r=>setTimeout(r,ms)); }
async function waitOp(token, operationId, label, timeoutMs=150000) {
  const samples=[]; const deadline=Date.now()+timeoutMs; let last;
  while(Date.now()<deadline) {
    const r=await raw('GET', `/operations/${operationId}`, token);
    last=r; samples.push({ts:new Date().toISOString(), status:r.status, ok:r.ok, body:sanitizeBody(r.body)});
    const st=r.body?.status;
    if (['succeeded','failed','cancelled'].includes(st)) { step(label, r, {samples}); return r; }
    await sleep(1500);
  }
  step(label, last ?? {method:'GET',path:`/operations/${operationId}`,status:0,ok:false,ms:0,body:null}, {timeoutMs, samples});
  return last;
}
async function waitContainerPhase(token, containerId, phase, label, timeoutMs=90000) {
  const samples=[]; const deadline=Date.now()+timeoutMs; let last;
  while(Date.now()<deadline) {
    const r=await raw('GET', `/v2/containers/${containerId}`, token);
    last=r; samples.push({ts:new Date().toISOString(), status:r.status, ok:r.ok, body:r.ok ? {id:r.body.id,name:r.body.name,phase:r.body.phase,actions:r.body.actions,runtime:{bound:r.body.runtime?.bound,status:r.body.runtime?.status,stale:r.body.runtime?.stale,ip:r.body.runtime?.ip?'<present>':null},activeOperation:r.body.activeOperation?{id:r.body.activeOperation.id,status:r.body.activeOperation.status,lastError:r.body.activeOperation.lastError}:null,resources:r.body.resources} : sanitizeBody(r.body)});
    if (r.status===404 && phase==='deleted') { step(label, r, {samples}); return r; }
    if (r.ok && r.body?.phase===phase) { step(label, r, {samples}); return r; }
    await sleep(1500);
  }
  step(label, last ?? {method:'GET',path:`/v2/containers/${containerId}`,status:0,ok:false,ms:0,body:null}, {timeoutMs, samples});
  return last;
}
try {
  const credTxt=await readFile(state.users.alpha.credentialFile,'utf8');
  const username=/^(?:USERNAME|NYABASE_USERNAME)=(.*)$/m.exec(credTxt)?.[1]?.trim() ?? state.users.alpha.username;
  const password=/^(?:PASSWORD|NYABASE_PASSWORD)=(.*)$/m.exec(credTxt)?.[1]?.trim();
  const login=await raw('POST','/auth/login', undefined, {username,password}); step('login-alpha', login, {username});
  if (!login.ok) throw new Error('login failed');
  const token=login.body.accessToken;
  const [access, servers, images] = await Promise.all([
    raw('GET','/me/access',token), raw('GET','/servers',token), raw('GET','/images?activeOnly=true',token)
  ]);
  step('get-effective-access', access); step('list-granted-servers', servers); step('list-granted-active-images', images);
  if (!access.ok || !servers.ok || !images.ok) throw new Error('pre-create discovery failed');
  const online = servers.body.filter(s=>s.status==='online');
  let chosen;
  for (const s of online) {
    const grant=access.body.servers.find(g=>g.serverId===s.id);
    if (!grant) continue;
    const img=images.body.find(i=>grant.allowedImageIds.includes(i.id));
    if (img) { chosen={server:s, grant, image:img}; break; }
  }
  result.chosen = chosen ? { server:{id:chosen.server.id,name:chosen.server.name,status:chosen.server.status,isGpuServer:chosen.server.isGpuServer}, grant:chosen.grant, image:{id:chosen.image.id,name:chosen.image.name,dockerImage:chosen.image.dockerImage,isActive:chosen.image.isActive} } : null;
  if (!chosen) { result.status='blocked-no-online-granted-server-image'; throw new Error('no online granted server+image'); }
  const name = `${prefix}alpha-cpu-${Date.now().toString(36)}`.toLowerCase();
  result.createName = name;
  const create=await raw('POST','/v2/containers', token, {serverId:chosen.server.id, imageId:chosen.image.id, name, cpuMillis:100, memBytes:64*1024*1024, gpuIndices:[]});
  step('create-container', create, {request:{serverId:chosen.server.id,imageId:chosen.image.id,name,cpuMillis:100,memBytes:64*1024*1024,gpuIndices:[]}});
  if (!create.ok) { result.status='create-request-failed'; throw new Error('create request failed'); }
  const opId=create.body.operationId;
  const createOp=await waitOp(token, opId, 'wait-create-operation');
  const containerId=createOp?.body?.resourceId ?? create.body.resourceId;
  result.containerId = containerId;
  if (!createOp?.ok || createOp.body.status !== 'succeeded') { result.status='create-operation-not-succeeded'; throw new Error('create operation did not succeed'); }
  const active=await waitContainerPhase(token, containerId, 'active', 'wait-container-active');
  if (!active.ok || active.body?.phase !== 'active') { result.status='container-not-active'; throw new Error('container not active'); }
  // Lightweight ownership/readback and quota state after create
  const ownList=await raw('GET','/v2/containers?ownOnly=true', token); step('list-own-after-create', ownList, {createdContainerId:containerId});
  const overQuota=await raw('POST','/v2/containers', token, {serverId:chosen.server.id, imageId:chosen.image.id, name:`${prefix}alpha-overquota-${Date.now().toString(36)}`.toLowerCase(), cpuMillis:chosen.grant.cpuMillis + 1, memBytes:64*1024*1024, gpuIndices:[]});
  step('quota-over-cpu-denial', overQuota, {requestSummary:{cpuMillis:chosen.grant.cpuMillis + 1, memBytes:64*1024*1024}});
  // Cleanup via delete operation
  result.cleanup.attempted=true;
  const del=await raw('POST', `/v2/containers/${containerId}/actions/delete`, token); step('delete-container', del);
  if (del.ok) {
    const delOp=await waitOp(token, del.body.operationId, 'wait-delete-operation');
    const deleted=await waitContainerPhase(token, containerId, 'deleted', 'wait-container-deleted');
    result.cleanup.deleted = delOp?.body?.status === 'succeeded' && deleted.status === 404;
  }
  const verifyList=await raw('GET','/v2/containers?ownOnly=true', token); step('list-own-after-cleanup', verifyList);
  if (verifyList.ok) {
    result.cleanup.residuals = verifyList.body.filter(c=>String(c.name||'').startsWith(prefix)).map(c=>({id:c.id,name:c.name,phase:c.phase,serverId:c.serverId,activeOperation:c.activeOperation?{id:c.activeOperation.id,status:c.activeOperation.status,lastError:c.activeOperation.lastError}:null}));
  }
  result.status = result.cleanup.deleted && result.cleanup.residuals.length===0 ? 'pass-created-active-cleaned' : 'cleanup-residual';
} catch(e) {
  result.error = e.message;
  if (!result.status || result.status==='unknown') result.status='error';
}
result.finishedAt = new Date().toISOString();
await writeFile(outPath, JSON.stringify(result,null,2));
console.log(JSON.stringify({wrote:outPath,status:result.status,containerId:result.containerId,cleanup:result.cleanup,error:result.error},null,2));
