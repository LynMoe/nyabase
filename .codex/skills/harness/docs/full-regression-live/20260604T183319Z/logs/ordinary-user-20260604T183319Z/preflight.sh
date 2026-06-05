#!/usr/bin/env bash
set -euo pipefail
printf 'timestamp=%s\n' "$(date -Is)"
printf 'cwd=%s\n' "$(pwd)"
printf 'node=%s\n' "$(node -v 2>/dev/null || true)"
printf 'pnpm=%s\n' "$(pnpm -v 2>/dev/null || true)"
printf '\n[ports]\n'
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true) | grep -E ':(3001|5173)\b' || true
printf '\n[pids files]\n'
find test/runtime/logs -maxdepth 2 -type f \( -name '*.pid' -o -name '*.log' \) -printf '%p %s bytes\n' 2>/dev/null | sort || true
printf '\n[backend/frontend http]\n'
node <<'NODE'
const urls=['http://localhost:3001/api/auth/me','http://localhost:5173/login'];
for (const url of urls) {
  const t0=Date.now();
  try {
    const r=await fetch(url, {headers:{accept:'application/json,text/html'}});
    const text=await r.text().catch(()=>'');
    console.log(`${url} status=${r.status} contentType=${r.headers.get('content-type')||''} ms=${Date.now()-t0} bodyPrefix=${JSON.stringify(text.slice(0,80))}`);
  } catch (e) { console.log(`${url} ERROR ${e.message}`); }
}
NODE
printf '\n[process detail]\n'
node <<'NODE'
const fs=require('fs');
const ports=[3001,5173];
const tcp=fs.readFileSync('/proc/net/tcp','utf8').trim().split('\n').slice(1).concat(fs.existsSync('/proc/net/tcp6')?fs.readFileSync('/proc/net/tcp6','utf8').trim().split('\n').slice(1):[]);
const inodes=new Map();
for (const line of tcp) {
  const cols=line.trim().split(/\s+/);
  const local=cols[1]; const st=cols[3]; const inode=cols[9];
  const port=parseInt(local.split(':').pop(),16);
  if (ports.includes(port) && st==='0A') inodes.set(inode, port);
}
for (const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))) {
  let matches=[];
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      const target=fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      const m=/socket:\[(\d+)\]/.exec(target);
      if (m && inodes.has(m[1])) matches.push(inodes.get(m[1]));
    }
  } catch {}
  if (!matches.length) continue;
  const cmd=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').replace(/\0/g,' ').trim();
  const cwd=(()=>{try{return fs.readlinkSync(`/proc/${pid}/cwd`)}catch{return ''}})();
  const env=(()=>{try{return fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(Boolean)}catch{return []}})();
  const redEnv=env.filter(x=>/^(NODE_ENV|PORT|DB_DRIVER|DB_PATH|DB_SYNC|DB_MIGRATIONS_RUN|CORS_ORIGIN|NYABASE_|VITE_)/.test(x)).map(x=>x.replace(/(PASSWORD|TOKEN|SECRET|KEY)=.*/,'$1=<redacted>'));
  console.log(JSON.stringify({pid,ports:[...new Set(matches)].sort(),cwd,cmd,env:redEnv},null,2));
}
NODE
printf '\n[db identity/schema]\n'
node <<'NODE'
const fs=require('fs');
const path=require('path');
const dbPath=path.resolve('test/runtime/db/nyabase-test.db');
console.log('dbPath='+dbPath);
try {
 const st=fs.statSync(dbPath); console.log(`dbStat size=${st.size} mtime=${st.mtime.toISOString()} inode=${st.dev}:${st.ino}`);
} catch(e) { console.log('dbStat ERROR '+e.message); process.exitCode=1; }
try {
 let Database; try { Database=require('./packages/backend/node_modules/better-sqlite3'); } catch(e) { Database=require('better-sqlite3'); } const db=new Database(dbPath,{readonly:true});
 const tables=db.prepare("select name from sqlite_master where type='table' order by name").all().map(r=>r.name);
 console.log('tables='+tables.slice(0,30).join(',')+(tables.length>30?`,...(${tables.length})`:''));
 for (const t of ['users','servers','images','containers','operations','migrations']) {
   try { const n=db.prepare(`select count(*) n from ${t}`).get().n; console.log(`${t}.count=${n}`); } catch(e) { console.log(`${t}.count=ERR:${e.message}`); }
 }
 try { console.log('servers='+JSON.stringify(db.prepare('select id,name,status,isGpuServer from servers order by name').all())); } catch(e) {}
 try { console.log('agents='+JSON.stringify(JSON.parse(fs.readFileSync('test/config/agents.json','utf8')).map(a=>({key:a.key,host:a.host,type:a.type})))); } catch(e) {}
 db.close();
} catch(e) { console.log('sqlite ERROR '+e.message); process.exitCode=1; }
NODE
printf '\n[build freshness]\n'
python3 - <<'PY2'
from pathlib import Path
from datetime import datetime, timezone
for label, root, pats in [
  ('backend_src','packages/backend/src',['*.ts']),
  ('backend_dist','packages/backend/dist',['*.js']),
  ('common_src','packages/common/src',['*.ts']),
  ('common_dist','packages/common/dist',['*.js']),
  ('frontend_src','packages/frontend/src',['*.ts','*.tsx']),
]:
    r=Path(root)
    files=[]
    for pat in pats: files += list(r.rglob(pat)) if r.exists() else []
    if not files:
        print(f'{label}=missing_or_empty')
        continue
    newest=max(files, key=lambda p:p.stat().st_mtime)
    print(f'{label}.newest={newest} {datetime.fromtimestamp(newest.stat().st_mtime, timezone.utc).isoformat()}')
PY2
printf '\n[common src compiled artifacts]\n'
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
