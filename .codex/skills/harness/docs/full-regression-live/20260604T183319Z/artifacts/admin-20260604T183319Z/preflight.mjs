import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const OUT = '.codex/skills/harness/docs/full-regression-live/20260604T183319Z/artifacts/admin-20260604T183319Z';
const API = 'http://localhost:3001/api';
const FRONTEND = 'http://localhost:5173';
const DB = 'test/runtime/db/nyabase-test.db';
function sha256(path) { try { return crypto.createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } }
function sh(cmd, args, opts={}) { try { return execFileSync(cmd,args,{encoding:'utf8',...opts}); } catch(e){ return (e.stdout||'')+(e.stderr||''); } }
function redactEnvLine(line){ return line.replace(/(JWT_SECRET|ADMIN_INIT_PASSWORD|TOKEN|SECRET|PASSWORD)=.*/i, '$1=<redacted>'); }
function procInfo(pid){
  if(!pid || !existsSync(`/proc/${pid}`)) return null;
  const env = readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(Boolean)
    .filter(x => /^(PORT|NODE_ENV|DB_DRIVER|DB_PATH|DB_SYNC|DB_MIGRATIONS_RUN|VICTORIA_METRICS_URL|CORS_ORIGIN|ADMIN_USERNAME|JWT_SECRET|ADMIN_INIT_PASSWORD)=/.test(x))
    .map(x => x.startsWith('DB_PATH=') ? 'DB_PATH=<redacted>' : redactEnvLine(x));
  return {
    pid,
    cwd: existsSync(`/proc/${pid}/cwd`) ? sh('readlink',[`/proc/${pid}/cwd`]).trim() : null,
    cmdline: readFileSync(`/proc/${pid}/cmdline`,'utf8').replace(/\0/g,' ').trim().replace(/(JWT_SECRET|ADMIN_INIT_PASSWORD|TOKEN|SECRET|PASSWORD)=\S+/gi,'$1=<redacted>'),
    env,
  };
}
async function request(path, opts={}){
  const res = await fetch(API+path, opts);
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return {status: res.status, body};
}
const started = new Date().toISOString();
const localServices = existsSync('test/runtime/local-services.json') ? JSON.parse(readFileSync('test/runtime/local-services.json','utf8')) : null;
const backendPid = existsSync('test/runtime/logs/backend.pid') ? readFileSync('test/runtime/logs/backend.pid','utf8').trim() : null;
const frontendPid = existsSync('test/runtime/logs/frontend.pid') ? readFileSync('test/runtime/logs/frontend.pid','utf8').trim() : null;
const ports = sh('bash',['-lc',"(ss -ltnp || true) 2>/dev/null | grep -E '(:3001|:5173|:8428)' || true"]);
const dbAbs = sh('realpath',[DB]).trim();
const dbStat = existsSync(DB) ? {
  absPath: dbAbs,
  sizeBytes: Number(sh('stat',['-c','%s',DB]).trim()),
  mtime: sh('stat',['-c','%y',DB]).trim(),
  sha256: sha256(DB),
  tables: sh('sqlite3',[DB,'.tables']).trim().split(/\s+/).filter(Boolean).sort(),
  rowCounts: Object.fromEntries(sh('sqlite3',[DB,"select 'users', count(*) from users union all select 'groups', count(*) from groups union all select 'servers', count(*) from servers union all select 'images', count(*) from images union all select 'containers', count(*) from containers union all select 'operations', count(*) from operations union all select 'outbox', count(*) from agent_command_outbox union all select 'quota_desired', count(*) from quota_desired union all select 'server_grants', count(*) from server_grants union all select 'image_grants', count(*) from image_grants;"]).trim().split('\n').filter(Boolean).map(l=>{const [k,v]=l.split('|'); return [k, Number(v)];})),
} : null;
const http = {};
for (const [name,url] of Object.entries({backendMe: API+'/auth/me', frontend: FRONTEND+'/' })) {
  try { const r=await fetch(url); http[name]={status:r.status, bytes:(await r.text()).length}; } catch(e){ http[name]={error:e.message}; }
}
let auth = null; let token = null;
try {
  const login = await request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.NYABASE_ADMIN_PASSWORD ?? ''})});
  token = login.body?.accessToken;
  auth = {loginStatus: login.status, user: login.body?.user ? {id:login.body.user.id, username:login.body.user.username, status:login.body.user.status, capabilities:login.body.user.capabilities, groups:login.body.user.groups?.map(g=>g.name)} : null, accessTokenRedacted: token ? '<redacted>' : null};
} catch(e) { auth = {error:e.message}; }
const h = token ? {'Authorization':'Bearer '+token,'Content-Type':'application/json'} : {'Content-Type':'application/json'};
let api = {};
if (token) {
  const [servers, images, containers, groups, users, audit] = await Promise.all(['/servers','/images','/v2/containers','/groups','/users','/audit?limit=3'].map(p=>request(p,{headers:h})));
  api = {
    servers: {status:servers.status, items:(servers.body||[]).map(s=>({id:s.id,name:s.name,status:s.status,isGpuServer:s.isGpuServer,lastSeenAt:s.lastSeenAt,dockerRoot:s.dockerRoot,dockerSocket:s.dockerSocket,defaultCpuMillis:s.defaultCpuMillis,defaultMemBytes:s.defaultMemBytes,defaultDiskBytes:s.defaultDiskBytes,defaultGpuMode:s.defaultGpuMode,defaultGpuIndices:s.defaultGpuIndices}))},
    images: {status:images.status, count:Array.isArray(images.body)?images.body.length:null, active:(images.body||[]).filter(i=>i.isActive).map(i=>({id:i.id,name:i.name,dockerImage:i.dockerImage,defaultUid:i.defaultUid,cmd:i.cmd,entrypoint:i.entrypoint})).slice(0,20)},
    containers: {status:containers.status, count:Array.isArray(containers.body)?containers.body.length:null, byPhase:(containers.body||[]).reduce((m,c)=>{m[c.phase]=(m[c.phase]||0)+1;return m;},{}), sample:(containers.body||[]).slice(0,8).map(c=>({id:c.id,name:c.name,serverId:c.serverId,ownerId:c.ownerId,phase:c.phase,powerIntent:c.powerIntent,runtime:{bound:c.runtime?.bound,status:c.runtime?.status,stale:c.runtime?.stale,ip:c.runtime?.ip},activeOperation:c.activeOperation?{id:c.activeOperation.id,kind:c.activeOperation.kind,status:c.activeOperation.status,lastError:c.activeOperation.lastError}:null,enabledActions:Object.fromEntries(Object.entries(c.actions||{}).filter(([,v])=>v.enabled).map(([k])=>[k,true]))}))},
    groups: {status:groups.status, items:(groups.body||[]).map(g=>({id:g.id,name:g.name,isSystem:g.isSystem,capabilities:g.capabilities,serverIds:g.serverIds,memberCount:g.memberCount}))},
    users: {status:users.status, count:Array.isArray(users.body)?users.body.length:null, sample:(users.body||[]).slice(0,12).map(u=>({id:u.id,username:u.username,status:u.status,groups:u.groups?.map(g=>g.name),capabilities:u.capabilities}))},
    audit: {status:audit.status, count:Array.isArray(audit.body)?audit.body.length:null},
  };
}
const agentsConfig = existsSync('test/config/agents.json') ? JSON.parse(readFileSync('test/config/agents.json','utf8')) : null;
const runtimeServers = existsSync('test/runtime/agents/servers.json') ? JSON.parse(readFileSync('test/runtime/agents/servers.json','utf8')) : null;
const agentIdentity = {
  configBackendWsUrl: agentsConfig?.backendWsUrl,
  configAgents: agentsConfig?.agents?.map(a=>({key:a.key,name:a.name,ssh:a.ssh,isGpuServer:a.isGpuServer,dockerRoot:a.dockerRoot,serverIpCidr:a.serverIpCidr,gateway:a.gateway})),
  runtimeAgents: runtimeServers?.agents?.map(a=>({key:a.key,name:a.name,serverId:a.serverId,ssh:a.ssh,isGpuServer:a.isGpuServer,dockerRoot:a.dockerRoot,configPath:a.configPath})),
  apiServers: api.servers?.items?.map(s=>({id:s.id,name:s.name,status:s.status,dockerRoot:s.dockerRoot,isGpuServer:s.isGpuServer,lastSeenAt:s.lastSeenAt})),
};
const hashes = {
  backendDistMainSha256: sha256('packages/backend/dist/main.js'),
  frontendIndexTsxSha256: sha256('packages/frontend/src/main.tsx'),
  commonIndexTsSha256: sha256('packages/common/src/index.ts'),
};
const commonArtifacts = sh('bash',['-lc',"find packages/common/src \\( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \\) -print | sort"]);
const report = {started, riskTier:'live-test + release', fixedInstance:{frontend:FRONTEND,backendApi:API,dbPath:dbAbs,admin:'admin/<redacted>'}, localServices:{...localServices, dbPath: localServices?.dbPath ? '<redacted>' : localServices?.dbPath}, ports, processes:{backend:procInfo(backendPid), frontend:procInfo(frontendPid)}, db:dbStat, http, auth, api, agentIdentity, hashes, commonSourceArtifacts: commonArtifacts.trim().split('\n').filter(Boolean)};
await fs.writeFile(`${OUT}/runtime-fingerprint.json`, JSON.stringify(report,null,2)+'\n');
await fs.writeFile(`${OUT}/runtime-fingerprint-summary.txt`, [
  `started=${started}`,
  `backend_login=${auth?.loginStatus}`,
  `servers=${api.servers?.items?.length ?? 'n/a'} online=${api.servers?.items?.filter(s=>s.status==='online').length ?? 'n/a'}`,
  `images_active=${api.images?.active?.length ?? 'n/a'}`,
  `containers=${api.containers?.count ?? 'n/a'} phases=${JSON.stringify(api.containers?.byPhase ?? {})}`,
  `common_source_artifacts=${report.commonSourceArtifacts.length}`,
].join('\n')+'\n');
console.log(JSON.stringify({wrote:`${OUT}/runtime-fingerprint.json`, summary:`${OUT}/runtime-fingerprint-summary.txt`, onlineServers:api.servers?.items?.filter(s=>s.status==='online').length, activeImages:api.images?.active?.length, commonSourceArtifacts:report.commonSourceArtifacts.length},null,2));
