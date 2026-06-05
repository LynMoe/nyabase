# Local stack run evidence

Session: `20260602T030416Z`
Recorded: `2026-06-02T03:12:13Z`
Role: `devops`

## Startup

Command:

```bash
bash scripts/dev.sh
```

Exit code: `0`

Relevant output:

```text
Starting VictoriaMetrics...
nyabase-vm
Building packages...
> @nyabase/common@0.1.0 build /root/nyabase/packages/common
> tsc -p tsconfig.json && tsc -p tsconfig.esm.json
> @nyabase/backend@0.1.0 build /root/nyabase/packages/backend
> tsc -p tsconfig.json
Starting backend on port 3001...
Backend PID: 1858760
Backend is up!
Starting frontend on port 5173...
Frontend PID: 1858791
Frontend:        http://localhost:5173
Backend API:     http://localhost:3001/api
VictoriaMetrics: http://localhost:8428
Default admin: admin / admin123
Logs:
  Backend:  tail -f /tmp/nyabase-backend.log
  Frontend: tail -f /tmp/nyabase-frontend.log
To stop: pkill -f 'node dist/main'; pkill -f 'vite.*5173'; docker stop nyabase-vm
```

Notes:
- First `scripts/dev.sh` attempt found an older tmux backend (`node -r tsconfig-paths/register dist/main.js`, PID `1732656`) listening on `*:3001`; the script's cleanup pattern did not match it, and the new backend logged `EADDRINUSE`.
- Stale backend cleanup command: `kill 1732656 2>/dev/null || true; sleep 1; ss -ltnp | awk 'NR==1 || /:(3001|5173|8428)\b/'`
- Cleanup exit code: `0`
- After the rerun, this command environment reaped `nohup` children when the launching shell exited. To keep the stack available for manual testing, backend and frontend were started with the same runtime command/env in a persistent tmux session named `nyabase-local`.

Persistent startup command:

```bash
tmux kill-session -t nyabase-local 2>/dev/null || true
tmux new-session -d -s nyabase-local -n dev
tmux send-keys -t nyabase-local:dev.0 'cd /root/nyabase/packages/backend && export PORT=3001 DB_DRIVER=sqlite DB_PATH=/tmp/nyabase-dev.db JWT_SECRET=<redacted> VICTORIA_METRICS_URL=http://localhost:8428 CORS_ORIGIN=http://localhost:5173 && echo $$ > /tmp/nyabase-backend.pid && exec node dist/main.js >> /tmp/nyabase-backend.log 2>&1' Enter
tmux split-window -h -t nyabase-local:dev
tmux send-keys -t nyabase-local:dev.1 'cd /root/nyabase/packages/frontend && echo $$ > /tmp/nyabase-frontend.pid && exec pnpm exec vite --port 5173 --host 0.0.0.0 >> /tmp/nyabase-frontend.log 2>&1' Enter
sleep 3
tmux list-panes -t nyabase-local -F '#{session_name}:#{window_index}.#{pane_index} pid=#{pane_pid} command=#{pane_current_command}'
cat /tmp/nyabase-backend.pid
cat /tmp/nyabase-frontend.pid
ss -ltnp | awk 'NR==1 || /:(3001|5173|8428)\b/'
```

Exit code: `0`

Process evidence:

```text
tmux
nyabase-local:0.0 pane_pid=1859317 command=node
nyabase-local:0.1 pane_pid=1859324 command=node

pid files
backend=1859317
frontend=1859324

ps:
1859317 1941508 Ssl+ node dist/main.js
1859324 1941508 Ssl+ node /usr/bin/pnpm exec vite --port 5173 --host 0.0.0.0
frontend child listener:
1859354 node ./node_modules/.bin/../vite/bin/vite.js --port 5173 --host 0.0.0.0

listeners:
0.0.0.0:5173 users:(("node",pid=1859354,fd=23))
127.0.0.1:8428 users:(("docker-proxy",pid=1858641,fd=8))
*:3001 users:(("node",pid=1859317,fd=22))
```

Logs:
- Backend: `/tmp/nyabase-backend.log`
- Frontend: `/tmp/nyabase-frontend.log`

## Health checks

Command:

```bash
curl -sS -o <tmp> -w '%{http_code}' http://localhost:3001/api
```

Exit code: `0`
HTTP code: `404`
Body:

```json
{"message":"Cannot GET /api","error":"Not Found","statusCode":404}
```

Command:

```bash
curl -sS -o <tmp> -w '%{http_code}' http://localhost:3001/api/auth/me
```

Exit code: `0`
HTTP code: `401`
Body:

```json
{"message":"Unauthorized","statusCode":401}
```

Command:

```bash
curl -sS -o <tmp> -w '%{http_code}' -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' http://localhost:3001/api/auth/login
```

Exit code: `0`
HTTP code: `200`
Parsed response:

```text
has_accessToken=true
has_refreshToken=true
user_username=admin
user_id_present=true
parse_exit_code=0
```

Command:

```bash
curl -sS -o <tmp> -w '%{http_code}' http://localhost:5173/
```

Exit code: `0`
HTTP code: `200`
Result:

```text
contains_html=yes
body_head=<!doctype html> <html lang="en">   <head>     <script type="module">import { injectIntoGlobalHook } from "/@react-refresh"; ...
```

Command:

```bash
curl -sS -o <tmp> -w '%{http_code}' http://localhost:8428/
docker ps --filter name=nyabase-vm --format 'container={{.Names}} status={{.Status}} ports={{.Ports}}'
```

Exit code: `0`
HTTP code: `200`
Result:

```text
body_head=<h2>Single-node VictoriaMetrics</h2></br>See docs at <a href='https://docs.victoriametrics.com/'>...
container=nyabase-vm status=Up 3 minutes ports=127.0.0.1:8428->8428/tcp
```

## Common-src artifact guard

Command:

```bash
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```

Exit code: `0`
Output: empty

Status: clean

## URLs and credentials

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3001/api`
- VictoriaMetrics: `http://localhost:8428`
- Login: `admin / admin123`

## Stop and restart

Stop command:

```bash
tmux kill-session -t nyabase-local; docker stop nyabase-vm
```

Restart command:

```bash
docker start nyabase-vm
tmux kill-session -t nyabase-local 2>/dev/null || true
tmux new-session -d -s nyabase-local -n dev
tmux send-keys -t nyabase-local:dev.0 'cd /root/nyabase/packages/backend && export PORT=3001 DB_DRIVER=sqlite DB_PATH=/tmp/nyabase-dev.db JWT_SECRET=<redacted> VICTORIA_METRICS_URL=http://localhost:8428 CORS_ORIGIN=http://localhost:5173 && echo $$ > /tmp/nyabase-backend.pid && exec node dist/main.js >> /tmp/nyabase-backend.log 2>&1' Enter
tmux split-window -h -t nyabase-local:dev
tmux send-keys -t nyabase-local:dev.1 'cd /root/nyabase/packages/frontend && echo $$ > /tmp/nyabase-frontend.pid && exec pnpm exec vite --port 5173 --host 0.0.0.0 >> /tmp/nyabase-frontend.log 2>&1' Enter
```

## No connected servers diagnosis

Recorded: `2026-06-02T03:32:34Z`
Role: `devops`

Scope: read-only diagnosis of why the currently running UI shows no connected servers. No product source, config, runtime process, DB row, token, or remote service was modified.

### Current backend process and DB

Command:

```bash
pid=$(cat /tmp/nyabase-backend.pid 2>/dev/null || true)
echo "backend_pid=${pid:-missing}"
if [ -n "$pid" ] && [ -r "/proc/$pid/environ" ]; then
  tr '\0' '\n' < "/proc/$pid/environ" |
    grep -E '^(PORT|DB_DRIVER|DB_PATH|JWT_SECRET|VICTORIA_METRICS_URL|CORS_ORIGIN)=' |
    sed -E 's/^(JWT_SECRET=).*/\1<redacted>/'
fi
```

Exit code: `0`

Output:

```text
backend_pid=1859317
PORT=3001
DB_DRIVER=sqlite
JWT_SECRET=<redacted>
CORS_ORIGIN=http://localhost:5173
DB_PATH=/tmp/nyabase-dev.db
VICTORIA_METRICS_URL=http://localhost:8428
```

Command:

```bash
ls -l /tmp/nyabase-dev.db /mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db 2>/dev/null || true
stat -c '%n size=%s mtime=%y' /tmp/nyabase-dev.db /mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db 2>/dev/null || true
```

Exit code: `0`

Output:

```text
-rw-r--r-- 1 root root 520192 Jun  2 11:08 /mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db
-rw-r--r-- 1 root root 335872 Jun  2 11:28 /tmp/nyabase-dev.db
/tmp/nyabase-dev.db size=335872 mtime=2026-06-02 11:28:31.537944041 +0800
/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db size=520192 mtime=2026-06-02 11:08:24.779866451 +0800
```

Command:

```bash
grep -nE 'DB_(DRIVER|PATH)|ADMIN_INIT_PASSWORD|JWT_SECRET|backendUrl|agentToken|serverId|10\.8\.96\.91|10\.8\.1\.12' TEST_DEPLOY.md test/.env 2>/dev/null |
  sed -E 's/(agentToken: ").*(")/\1<redacted>\2/g; s/(JWT_SECRET=).*/\1<redacted>/g; s/(ADMIN_INIT_PASSWORD=).*/\1<redacted>/g'
```

Exit code: `0`

Relevant output:

```text
test/.env:5:DB_DRIVER=sqlite
test/.env:6:DB_PATH=/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db
TEST_DEPLOY.md:3:... remote `root@10.8.96.91` runs CPU-only agent, remote `lyn@10.8.1.12` runs GPU agent ...
TEST_DEPLOY.md:73:Resetting the backend requires re-registering Agent servers and writing the new `agentToken` and `serverId` to remote `/etc/nyabase/agent.yaml`.
TEST_DEPLOY.md:120:backendUrl: "ws://10.8.96.92:3001/ws/agent"
TEST_DEPLOY.md:121:agentToken: "<redacted>"
TEST_DEPLOY.md:122:serverId: "REPLACE_WITH_NEW_SERVER_ID"
TEST_DEPLOY.md:222:backendUrl: "ws://10.8.96.92:3001/ws/agent"
TEST_DEPLOY.md:223:agentToken: "<redacted>"
TEST_DEPLOY.md:224:serverId: "REPLACE_WITH_NEW_SERVER_ID"
```

Result: the current backend is using `/tmp/nyabase-dev.db`; the previous deployment/test environment used `/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`.

### Current backend server rows

Command:

```bash
sqlite3 -readonly /tmp/nyabase-dev.db "SELECT COUNT(*) AS server_count FROM servers; SELECT id, name, status, lastSeenAt, dockerRoot FROM servers ORDER BY id;"
```

Exit code: `0`

Output:

```text
0
```

Command:

```bash
node --input-type=module <<'NODE'
const base='http://localhost:3001/api';
const login=await fetch(`${base}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})});
console.log('login_http='+login.status);
const body=await login.json();
console.log('has_accessToken=' + Boolean(body.accessToken) + ' (redacted)');
const res=await fetch(`${base}/servers`,{headers:{Authorization:`Bearer ${body.accessToken}`}});
console.log('servers_http='+res.status);
const servers=await res.json();
const arr=Array.isArray(servers) ? servers : (Array.isArray(servers.items) ? servers.items : []);
console.log('servers_count='+arr.length);
for (const s of arr) console.log(`${s.id}|${s.name}|${s.status}|lastSeenAt=${s.lastSeenAt ?? ''}|dockerRoot=${s.dockerRoot ?? ''}`);
NODE
```

Exit code: `0`

Output:

```text
login_http=200
has_accessToken=true (redacted)
servers_http=200
servers_count=0
```

Result: the currently running UI/API has no server rows to show, so this is not a case of existing rows being offline in the current DB.

### Previous deployment DB comparison

Command:

```bash
sqlite3 -readonly /mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db "SELECT COUNT(*) AS server_count FROM servers; SELECT id, name, status, lastSeenAt, dockerRoot FROM servers ORDER BY id;"
```

Exit code: `0`

Output:

```text
4
05cea385-d6ca-490a-a126-e00d0ae23b70|nyabase-cpu-batch-20260601T163636Z|online|2026-06-02 03:08:24.780|/data/nyabase-docker
291118dd-673f-4b26-8d15-b27a0ed374ad|nyabase-gpu-1|offline|2026-06-01 16:38:15.826|/data0/nbTest/nyabase-docker
5336594b-4f9a-4cef-b389-3ef9aa1eca78|nyabase-test-1|offline|2026-06-01 16:37:07.247|/data/nyabase-docker
db1112fe-1c55-4314-9511-6d8510c523c2|nyabase-gpu-batch-20260601T163636Z|online|2026-06-02 03:08:24.046|/data0/nbTest/nyabase-docker
```

Result: the prior deployment DB contains the expected CPU/GPU server rows. The current `/tmp/nyabase-dev.db` does not.

### Remote agent status and config

Command:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 root@10.8.96.91 'bash -s' <<'REMOTE'
set -eu
printf 'host=%s\n' "$(hostname)"
printf 'nyabase-agent=%s\n' "$(systemctl is-active nyabase-agent 2>/dev/null || true)"
printf 'nyabase-docker=%s\n' "$(systemctl is-active nyabase-docker.service 2>/dev/null || true)"
if [ -r /etc/nyabase/agent.yaml ]; then
  grep -E '^(backendUrl|serverId|dockerRoot|isGpuServer|agentToken):' /etc/nyabase/agent.yaml |
    sed -E 's/^(agentToken:).*/\1 <redacted-present>/'
else
  echo 'config=unreadable'
fi
journalctl -u nyabase-agent -n 12 --no-pager 2>/dev/null |
  sed -E 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1<redacted>/g; s/(agentToken[=: ]+)[A-Za-z0-9._~+\/-]+/\1<redacted>/g; s/(token[=: ]+)[A-Za-z0-9._~+\/-]+/\1<redacted>/Ig'
REMOTE
```

Exit code: `0`

Relevant output:

```text
host=nyabase-test-1
nyabase-agent=active
nyabase-docker=active
backendUrl: "ws://10.8.96.92:3001/ws/agent"
agentToken: <redacted-present>
serverId: "05cea385-d6ca-490a-a126-e00d0ae23b70"
dockerRoot: "/data/nyabase-docker"
[WS] Connecting to ws://10.8.96.92:3001/ws/agent...
[WS] Connected
[WS] Disconnected: 4003 Invalid token
[Agent] Disconnected from backend
```

Command:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 lyn@10.8.1.12 'bash -s' <<'REMOTE'
set -eu
printf 'host=%s\n' "$(hostname)"
printf 'nyabase-agent=%s\n' "$(sudo -n systemctl is-active nyabase-agent 2>/dev/null || true)"
printf 'nyabase-docker=%s\n' "$(sudo -n systemctl is-active nyabase-docker.service 2>/dev/null || true)"
if sudo -n test -r /etc/nyabase/agent.yaml; then
  sudo -n grep -E '^(backendUrl|serverId|dockerRoot|isGpuServer|agentToken):' /etc/nyabase/agent.yaml |
    sed -E 's/^(agentToken:).*/\1 <redacted-present>/'
else
  echo 'config=unreadable'
fi
sudo -n journalctl -u nyabase-agent -n 12 --no-pager 2>/dev/null |
  sed -E 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1<redacted>/g; s/(agentToken[=: ]+)[A-Za-z0-9._~+\/-]+/\1<redacted>/g; s/(token[=: ]+)[A-Za-z0-9._~+\/-]+/\1<redacted>/Ig'
REMOTE
```

Exit code: `0`

Relevant output:

```text
host=aya-1
nyabase-agent=active
nyabase-docker=active
backendUrl: "ws://10.8.96.92:3001/ws/agent"
agentToken: <redacted-present>
serverId: "db1112fe-1c55-4314-9511-6d8510c523c2"
dockerRoot: "/data0/nbTest/nyabase-docker-pquota"
isGpuServer: true
[WS] Connecting to ws://10.8.96.92:3001/ws/agent...
[WS] Connected
[WS] Disconnected: 4003 Invalid token
[Agent] Disconnected from backend
```

Result: remote agents are running and still configured with the prior CPU/GPU server IDs and tokens. They can reach the currently running backend URL, but the backend rejects them with `4003 Invalid token` because the current DB has no matching server rows/token hashes.

### Diagnosis

Root cause: the local UI/backend stack is currently running against fresh/different SQLite DB `/tmp/nyabase-dev.db`, while the previously deployed CPU/GPU agents and server records belong to `/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`; therefore `/api/servers` returns zero rows and remote agents attempting to connect with old server IDs/tokens are rejected.

Recommended next action: either restart the local backend with the previous deployment environment/DB (`test/.env`, especially `DB_PATH=/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`) to see the existing registered servers, or intentionally register new server rows in the current `/tmp/nyabase-dev.db` and update the remote agent configs with the newly issued tokens/server IDs.

## Switched backend to original deploy DB/env

Recorded: `2026-06-02T03:43:20Z` (`2026-06-02T11:43:20+0800`)
Role: `devops`

Scope: runtime process switch only. No product source, test, script, config, database row, server token, or remote agent deployment was modified.

### Backend restart with `test/.env`

Command summary:

```bash
# Stopped previous local backend PID 1859317, left frontend pane running.
tmux split-window -h -t nyabase-local:0 \
  'cd /root/nyabase/packages/backend && set -a && source ../../test/.env && set +a && echo $$ > /tmp/nyabase-backend.pid && exec node -r tsconfig-paths/register dist/main.js >> /tmp/nyabase-backend.log 2>&1'

# Corrected /tmp/nyabase-backend.pid to the actual tmux backend pane PID after exec.
```

Exit code: `0`

Runtime environment evidence for backend PID `1868130`:

```text
ADMIN_INIT_PASSWORD=<redacted>
CORS_ORIGIN=http://localhost:5173
DB_DRIVER=sqlite
DB_PATH=/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db
DB_SYNC=true
JWT_SECRET=<redacted>
NODE_ENV=development
PORT=3001
VICTORIA_METRICS_URL=http://localhost:8428
```

Listener/process evidence:

```text
backend_pid=1868130
frontend_pid=1859324
1868130 node -r tsconfig-paths/register dist/main.js
1859324 node /usr/bin/pnpm exec vite --port 5173 --host 0.0.0.0

LISTEN 0 511 0.0.0.0:5173 users:(("node",pid=1859354,fd=23))
LISTEN 0 4096 127.0.0.1:8428 users:(("docker-proxy",pid=1858641,fd=8))
LISTEN 0 511 *:3001 users:(("node",pid=1868130,fd=22))

tmux panes:
pane=0 pid=1859324 cmd=node path=/root/nyabase/packages/frontend
pane=1 pid=1868130 cmd=node path=/root/nyabase/packages/backend
```

### Health checks

Commands:

```bash
curl -sS -o /tmp/nyabase-final-backend-me.txt -w '%{http_code}' http://localhost:3001/api/auth/me
curl -sS -o /tmp/nyabase-final-backend-api.txt -w '%{http_code}' http://localhost:3001/api
curl -sS -o /tmp/nyabase-final-frontend.txt -w '%{http_code}' http://localhost:5173/
curl -sS -o /tmp/nyabase-final-vm.txt -w '%{http_code}' http://localhost:8428/
docker ps --filter name=nyabase-vm --format 'container={{.Names}} status={{.Status}} ports={{.Ports}}'
```

Exit code: `0`

Results:

```text
backend /api/auth/me HTTP 401
backend /api HTTP 404
frontend HTTP 200, contains_html=yes
VictoriaMetrics HTTP 200, contains_title=yes
container=nyabase-vm status=Up 34 minutes ports=127.0.0.1:8428->8428/tcp
```

### Login and servers API

Command summary:

```bash
curl -sS -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' \
  http://localhost:3001/api/auth/login

curl -sS -H "Authorization: Bearer <redacted>" \
  http://localhost:3001/api/servers
```

Exit code: `0`

Sanitized result:

```text
login_http=200
login_parse=ok
has_accessToken=true
has_refreshToken=true
user_username=admin
user_id_present=true

servers_http=200
servers_parse=ok
servers_count=4
5336594b-4f9a-4cef-b389-3ef9aa1eca78 nyabase-test-1 status=offline isGpuServer=true lastSeenAt=2026-06-01T16:37:07.247Z
291118dd-673f-4b26-8d15-b27a0ed374ad nyabase-gpu-1 status=offline isGpuServer=true lastSeenAt=2026-06-01T16:38:15.826Z
05cea385-d6ca-490a-a126-e00d0ae23b70 nyabase-cpu-batch-20260601T163636Z status=online isGpuServer=false lastSeenAt=2026-06-02T03:43:59.997Z
db1112fe-1c55-4314-9511-6d8510c523c2 nyabase-gpu-batch-20260601T163636Z status=online isGpuServer=true lastSeenAt=2026-06-02T03:43:58.832Z
```

### Agent connection state

Backend log evidence after restart:

```text
[Bootstrap] Backend listening on port 3001
[AgentGateway] Agent connected: server=nyabase-gpu-batch-20260601T163636Z (db1112fe-1c55-4314-9511-6d8510c523c2)
[AgentGateway] Agent connected: server=nyabase-cpu-batch-20260601T163636Z (05cea385-d6ca-490a-a126-e00d0ae23b70)
[AgentGateway] Hello from nyabase-cpu-batch-20260601T163636Z: nyabase-test-1, 0 GPUs
[AgentGateway] Hello from nyabase-gpu-batch-20260601T163636Z: aya-1, 4 GPUs
[AgentGateway] dockerRoot mismatch for nyabase-gpu-batch-20260601T163636Z: DB has "/data0/nbTest/nyabase-docker", agent reports "/data0/nbTest/nyabase-docker-pquota". Ignoring agent value.
[AgentGateway] [StateReport] Unknown numericUserId 5 from server 05cea385-d6ca-490a-a126-e00d0ae23b70 — skipping
[AgentGateway] [StateReport] Unknown numericUserId 5 from server db1112fe-1c55-4314-9511-6d8510c523c2 — skipping
```

Passive remote status/log checks:

```text
CPU host=nyabase-test-1
agent_active=active
docker_active=active
recent log: [WS] Connected at Jun 02 11:40:44 after local backend restart

GPU host=aya-1
agent_active=active
docker_active=active
recent tail contained no entries after the reconnect window; backend API/logs report GPU server online and receiving state reports
```

No remote agent service was restarted because the original CPU/GPU agents reconnected after the local backend DB/env switch.

### Common-src artifact guard

Command:

```bash
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```

Exit code: `0`
Output: empty

Status: clean

### Current access

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3001/api`
- VictoriaMetrics: `http://localhost:8428`
- Login: `admin / admin123`
- Backend log: `/tmp/nyabase-backend.log`
- Frontend log: `/tmp/nyabase-frontend.log`

Stop command:

```bash
tmux kill-session -t nyabase-local; docker stop nyabase-vm
```
