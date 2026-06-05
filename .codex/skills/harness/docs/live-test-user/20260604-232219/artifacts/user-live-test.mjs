import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const backend = process.env.NYABASE_BACKEND_URL || 'http://localhost:3001';
const apiBase = backend.endsWith('/api') ? backend : `${backend}/api`;
const outDir = process.env.OUT_DIR || '.codex/skills/harness/docs/live-test-user/20260604-232219/artifacts';
await mkdir(outDir, { recursive: true });
const runId = `ult-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${randomUUID().slice(0,6)}`;
const report = { runId, apiBase, startedAt: new Date().toISOString(), commands: [], endpoints: [], resources: {}, steps: [], failures: [], cleanup: [] };
const MI_B = 1024 * 1024;
function rec(step) { report.steps.push({ ts: new Date().toISOString(), ...step }); console.log(JSON.stringify(step)); }
function fail(step, error, rootCause='unknown') { const f={ ts:new Date().toISOString(), step, error: String(error?.stack || error), rootCause }; report.failures.push(f); console.error(JSON.stringify(f)); }
async function req(method, path, token, body) {
  const url = `${apiBase}${path}`;
  const res = await fetch(url, { method, headers: { 'Content-Type':'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  report.endpoints.push({ method, path, status: res.status, ok: res.ok });
  return { status: res.status, ok: res.ok, body: parsed, text };
}
async function ok(method, path, token, body, statuses=[200]) {
  const r = await req(method, path, token, body);
  if (!statuses.includes(r.status)) throw new Error(`${method} ${path} expected ${statuses.join('/')} got ${r.status}: ${r.text.slice(0,500)}`);
  return r;
}
async function waitFor(predicate, timeoutMs=90000, intervalMs=3000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeoutMs) {
    try { last = await predicate(); if (last) return last; } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms; last=${typeof last === 'object' ? JSON.stringify(last).slice(0,500) : String(last)}`);
}
function canonical(c) { return c?.containerId || c?.id || c?.spec?.dockerId; }
function statusOf(c) { return String(c?.status || c?.state || '').toLowerCase(); }

try {
  rec({ name:'preflight root', apiBase });
  const adminLogin = await ok('POST','/auth/login',undefined,{ username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin123' });
  const adminToken = adminLogin.body.accessToken || adminLogin.body.token;
  report.resources.adminUserId = adminLogin.body.user?.id;
  rec({ name:'admin login for fixture', status: adminLogin.status, userId: report.resources.adminUserId });

  const meAdmin = await ok('GET','/auth/me',adminToken);
  rec({ name:'admin me', username: meAdmin.body.username, caps: meAdmin.body.capabilities });

  const servers = (await ok('GET','/servers',adminToken)).body;
  const onlineServers = servers.filter(s => String(s.status || s.state || '').toLowerCase() === 'online' || s.online === true || s.isOnline === true);
  const targetServer = onlineServers[0] || servers[0];
  if (!targetServer) throw new Error('no server rows returned');
  report.resources.serverId = targetServer.id;
  rec({ name:'server selected', serverId: targetServer.id, serverName: targetServer.name, status: targetServer.status, online: targetServer.online ?? targetServer.isOnline, isGpu: targetServer.isGpuServer });

  const images = (await ok('GET','/images',adminToken)).body;
  let image = images.find(i => (i.serverId === targetServer.id || i.server?.id === targetServer.id) && (i.active !== false && i.enabled !== false));
  if (!image) image = images.find(i => i.active !== false && i.enabled !== false) || images[0];
  if (!image) {
    const createdImage = await ok('POST','/images',adminToken,{ name:`${runId}-alpine`, imageRef:'alpine:latest', serverId: targetServer.id, description:'user live-test disposable image' }, [201,200]);
    image = createdImage.body; report.resources.createdImageId = image.id;
  }
  report.resources.imageId = image.id;
  rec({ name:'image selected', imageId: image.id, imageName: image.name, imageRef: image.imageRef || image.ref || image.dockerImage, serverId: image.serverId });

  const username = `${runId}-user`;
  const password = `Pwd-${runId}-123!`;
  const userCreate = await ok('POST','/users',adminToken,{ username, password, displayName:`User Live ${runId}`, isAdmin:false }, [201,200]);
  const user = userCreate.body; report.resources.userId = user.id; report.resources.username = username; report.resources.password = password;
  rec({ name:'ordinary user created', userId: user.id, username });

  // Grant server/image access if endpoints exist; ignore already-granted or endpoint mismatch only after recording.
  const grantBody = { cpuMillis: 500, memBytes: 256*MI_B, diskBytes: 512*MI_B, gpuCount: 0, gpuIndices: [] };
  const sg = await req('POST', `/users/${user.id}/server-grants/${targetServer.id}`, adminToken, grantBody);
  rec({ name:'server grant attempt', status: sg.status, body: sg.body });
  const ig = await req('POST', `/users/${user.id}/image-grants`, adminToken, { imageId: image.id, serverId: targetServer.id });
  rec({ name:'image grant attempt', status: ig.status, body: ig.body });

  const login = await ok('POST','/auth/login',undefined,{ username, password });
  const userToken = login.body.accessToken || login.body.token;
  rec({ name:'ordinary user login', status: login.status, userId: login.body.user?.id, username: login.body.user?.username, caps: login.body.user?.capabilities });
  await ok('GET','/auth/me',userToken);
  const access = await req('GET','/me/access',userToken); rec({ name:'ordinary user access', status: access.status, body: access.body });
  const uServers = await req('GET','/servers',userToken); rec({ name:'ordinary user servers', status:uServers.status, count:Array.isArray(uServers.body)?uServers.body.length:undefined });
  const uImages = await req('GET','/images',userToken); rec({ name:'ordinary user images', status:uImages.status, count:Array.isArray(uImages.body)?uImages.body.length:undefined });

  const cname = `${runId}-ctr`;
  const createBody = { serverId: targetServer.id, imageId: image.id, name: cname, cpuMillis: 100, memBytes: 64*MI_B, gpuIndices: [] };
  const create = await ok('POST','/containers',userToken,createBody,[201,200,202]);
  rec({ name:'container create requested', status:create.status, body:create.body });
  const operationId = create.body.operationId || create.body.operation?.id || create.body.id;
  report.resources.createOperationId = operationId;

  const found = await waitFor(async () => {
    const list = await req('GET', `/containers?serverId=${encodeURIComponent(targetServer.id)}&ownOnly=true`, userToken);
    const arr = Array.isArray(list.body) ? list.body : (list.body?.containers || []);
    const c = arr.find(x => x?.spec?.name === cname || x?.name === cname);
    return c || false;
  }, 120000, 3000);
  const cid = canonical(found); report.resources.containerId = cid; report.resources.dockerId = found?.spec?.dockerId;
  rec({ name:'container visible to owner', containerId: cid, dockerId: found?.spec?.dockerId, status: found.status, ownerId: found?.spec?.ownerId });

  const detailPath = `/containers/${targetServer.id}/${cid}`;
  let detail = await ok('GET', detailPath, userToken); rec({ name:'container detail', status: detail.status, containerStatus: detail.body.status });
  for (const op of ['stop','start','restart']) {
    const opRes = await req('POST', `${detailPath}/${op}`, userToken);
    rec({ name:`container ${op} requested`, status:opRes.status, body:opRes.body });
    report.resources[`${op}OperationId`] = opRes.body?.operationId || opRes.body?.operation?.id || opRes.body?.id;
    await new Promise(r => setTimeout(r, 8000));
    const after = await req('GET', detailPath, userToken);
    rec({ name:`container ${op} observed`, status:after.status, containerStatus:after.body?.status, dockerId:after.body?.spec?.dockerId });
  }

  const del = await req('DELETE', detailPath, userToken);
  rec({ name:'container delete requested', status:del.status, body:del.body });
  report.resources.deleteOperationId = del.body?.operationId || del.body?.operation?.id || del.body?.id;
  await waitFor(async () => {
    const gone = await req('GET', detailPath, userToken);
    if ([404,410].includes(gone.status)) return { goneStatus: gone.status };
    return false;
  }, 120000, 5000).catch(e => { fail('wait delete gone', e, 'product-or-infra'); });
  const listAfter = await req('GET', `/containers?serverId=${encodeURIComponent(targetServer.id)}&ownOnly=true`, userToken);
  const residual = (Array.isArray(listAfter.body) ? listAfter.body : (listAfter.body?.containers || [])).filter(x => x?.spec?.name === cname);
  rec({ name:'container residual check', status:listAfter.status, residualCount:residual.length });

  // user cleanup via admin
  if (report.resources.containerId) {
    const cleanupDel = await req('DELETE', `/containers/${targetServer.id}/${report.resources.containerId}`, adminToken);
    report.cleanup.push({ type:'container', id: report.resources.containerId, status: cleanupDel.status });
  }
  const userDel = await req('DELETE', `/users/${user.id}`, adminToken);
  report.cleanup.push({ type:'user', id:user.id, status:userDel.status });
  if (report.resources.createdImageId) {
    const imgDel = await req('DELETE', `/images/${report.resources.createdImageId}`, adminToken);
    report.cleanup.push({ type:'image', id:report.resources.createdImageId, status:imgDel.status });
  }
} catch (e) {
  fail('main', e, 'infra-or-product');
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(`${outDir}/user-live-test-report.json`, JSON.stringify(report,null,2));
  console.log(`REPORT ${outDir}/user-live-test-report.json`);
  if (report.failures.length) process.exitCode = 1;
}
