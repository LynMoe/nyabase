import { readFile, writeFile } from 'node:fs/promises';
const timestamp = new Date().toISOString();
const envText = await readFile('test/runtime/murt/current.env', 'utf8');
const statePath = /^NYABASE_MURT_STATE=(.*)$/m.exec(envText)?.[1]?.trim();
const state = JSON.parse(await readFile(statePath, 'utf8'));
const apiBase = `${(process.env.NYABASE_BACKEND_URL ?? state.backendUrl ?? 'http://localhost:3001').replace(/\/$/, '')}/api`;
const personas = ['alpha','beta','gamma','delta','epsilon'];
const results = { timestamp, apiBase, statePath, runPrefix: state.runPrefix, personas: {}, adminDenialsChecked: [], notes: [] };
async function raw(method, path, token, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = res.status === 204 ? null : ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, body: data };
}
async function loadCred(persona) {
  const file = state.users[persona].credentialFile;
  const txt = await readFile(file, 'utf8');
  return { username: /^(?:USERNAME|NYABASE_USERNAME)=(.*)$/m.exec(txt)?.[1]?.trim() ?? state.users[persona].username, password: /^(?:PASSWORD|NYABASE_PASSWORD)=(.*)$/m.exec(txt)?.[1]?.trim() };
}
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
function summarizeContainers(containers) {
  const sum = { count: containers.length, byPhase: {}, resourceTotals: { cpuMillis:0, memBytes:0, diskBytes:0, gpuCount:0 }, items: [] };
  for (const c of containers) {
    sum.byPhase[c.phase] = (sum.byPhase[c.phase] || 0) + 1;
    sum.resourceTotals.cpuMillis += c.resources?.cpuMillis ?? 0;
    sum.resourceTotals.memBytes += c.resources?.memBytes ?? 0;
    sum.resourceTotals.diskBytes += c.resources?.diskBytes ?? 0;
    sum.resourceTotals.gpuCount += c.resources?.gpuIndices?.length ?? 0;
    sum.items.push({ id:c.id, name:c.name, serverId:c.serverId, imageId:c.imageId, phase:c.phase, ownerId:c.ownerId, resources:c.resources, actions:c.actions, runtime:{bound:c.runtime?.bound,status:c.runtime?.status,stale:c.runtime?.stale,ip: c.runtime?.ip ? '<present>' : null}, activeOperation:c.activeOperation ? {id:c.activeOperation.id,kind:c.activeOperation.kind,status:c.activeOperation.status,lastError:c.activeOperation.lastError} : null });
  }
  return sum;
}
const adminEndpoints = [
  ['GET','/users'], ['GET','/groups'], ['GET','/audit'], ['GET','/servers/all-disks'], ['GET','/system/remote-fs-mounts'], ['POST','/images'], ['POST','/servers'], ['GET',`/users/${state.users.beta.id}/effective-access`],
];
for (const p of personas) {
  const cred = await loadCred(p);
  const login = await raw('POST','/auth/login', undefined, cred);
  const rec = { username: cred.username, login: {status: login.status, ok: login.ok, user: login.body?.user ? { id: login.body.user.id, username: login.body.user.username, displayName: login.body.user.displayName, status: login.body.user.status, capabilities: login.body.user.capabilities, groups: login.body.user.groups } : sanitizeBody(login.body) } };
  if (!login.ok) { results.personas[p]=rec; continue; }
  const token = login.body.accessToken;
  for (const [label,path] of [['me','/auth/me'], ['access','/me/access'], ['servers','/servers'], ['imagesActive','/images?activeOnly=true'], ['containersOwn','/v2/containers?ownOnly=true']]) {
    const r = await raw('GET', path, token);
    rec[label] = { status:r.status, ok:r.ok, body: label === 'containersOwn' && Array.isArray(r.body) ? summarizeContainers(r.body) : sanitizeBody(r.body) };
  }
  rec.adminDenials = [];
  for (const [method,path] of adminEndpoints) {
    const body = method === 'POST' && path === '/images' ? { name:'frlive-user-20260604T183319Z-denied-image', dockerImage:'ubuntu:24.04', defaultUser:'root', defaultShell:'/bin/bash', defaultUid:0 } : method === 'POST' && path === '/servers' ? { name:'frlive-user-20260604T183319Z-denied-server', parentIface:'eth0', ipCidr:'10.254.0.0/24', gateway:'10.254.0.1' } : undefined;
    const r = await raw(method, path, token, body);
    rec.adminDenials.push({ method, path, status:r.status, ok:r.ok, body:sanitizeBody(r.body) });
  }
  // Cross-user/self-protection checks: own profile patch should be allowed shape only if displayName same? skip mutation; read other user should deny.
  const ownKeys = await raw('GET', `/users/${state.users[p].id}/ssh-keys`, token);
  const otherKeys = await raw('GET', `/users/${state.users.beta.id === state.users[p].id ? state.users.alpha.id : state.users.beta.id}/ssh-keys`, token);
  rec.sshKeyAccess = { own: {status: ownKeys.status, ok: ownKeys.ok, body: sanitizeBody(ownKeys.body)}, other: {status: otherKeys.status, ok: otherKeys.ok, body: sanitizeBody(otherKeys.body)} };
  results.personas[p]=rec;
}
await writeFile(process.argv[2], JSON.stringify(results,null,2));
console.log(JSON.stringify({ wrote: process.argv[2], personas, timestamp }, null, 2));
