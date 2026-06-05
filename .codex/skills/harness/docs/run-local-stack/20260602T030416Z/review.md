# Review / PM Final Record

Session: `run-local-stack/20260602T030416Z`
Role: PM
Status: `DONE`

## Result

Devops started the existing local nyabase stack and verified it is reachable for manual testing.

## Evidence

- Startup and health checks: `.codex/skills/harness/docs/run-local-stack/20260602T030416Z/tests.md`
- Frontend: `http://localhost:5173`, HTTP 200 with HTML/app content.
- Backend API: `http://localhost:3001/api`; `/api/auth/me` returns HTTP 401 when unauthenticated, as expected.
- Login: `admin / admin123`, verified with HTTP 200 and access token returned.
- VictoriaMetrics: `http://localhost:8428`, HTTP 200; container `nyabase-vm` running.
- Persistent session: `tmux` session `nyabase-local`.
- Backend PID: `1859317`, log `/tmp/nyabase-backend.log`.
- Frontend tmux PID: `1859324`, Vite listener PID `1859354`, log `/tmp/nyabase-frontend.log`.
- Common source artifact guard: clean.

## Caveats

- A stale local backend process was occupying port `3001`; devops killed that stale process before starting the persistent session.
- No database reset was needed.
- Remote CPU/GPU agent state was not rechecked in this run-only dispatch.

## Server Connection Diagnosis

User reported that no servers were connected in the UI. Devops performed a readonly diagnosis and recorded evidence in `tests.md`.

Root cause: the currently running backend was started with `scripts/dev.sh`, which uses `DB_PATH=/tmp/nyabase-dev.db`. That fresh/different SQLite DB has zero server rows, so the UI has no servers to show and the remote agents have no matching token hashes in this backend.

Evidence:

- Live backend env: `DB_DRIVER=sqlite`, `DB_PATH=/tmp/nyabase-dev.db`.
- Current API `GET /api/servers`: `servers_count=0`.
- SQLite `servers` count in `/tmp/nyabase-dev.db`: `0`.
- Previous deploy DB `/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db` has 4 server rows, including CPU `05cea385-d6ca-490a-a126-e00d0ae23b70` and GPU `db1112fe-1c55-4314-9511-6d8510c523c2`.
- Remote CPU/GPU agent services are active and configured with old server IDs, but logs show `4003 Invalid token` against the current backend.

Recommended next action: either restart the local backend with `test/.env` / the previous deploy DB to reuse existing registered servers, or register new servers in `/tmp/nyabase-dev.db` and update remote agent configs with the newly generated server IDs and tokens.

## Original DB Runtime Switch

User requested: `重新使用原来的db`.

Devops switched the running backend from `/tmp/nyabase-dev.db` back to the original deploy DB:

`/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`

Result:

- Frontend remains reachable at `http://localhost:5173`.
- Backend API remains reachable at `http://localhost:3001/api`.
- VictoriaMetrics remains reachable at `http://localhost:8428`.
- Login `admin / admin123` verified.
- Backend PID: `1868130`, log `/tmp/nyabase-backend.log`.
- Frontend PID: `1859324`, log `/tmp/nyabase-frontend.log`.
- Server rows: `4`.
- CPU server `05cea385-d6ca-490a-a126-e00d0ae23b70`: online.
- GPU server `db1112fe-1c55-4314-9511-6d8510c523c2`: online.
- Backend logs show both agents connected and sent hello/state reports.
- Remote checks found CPU/GPU `nyabase-agent` and `nyabase-docker` services active.
- No remote services were restarted.
- Common source artifact guard remains clean.

Caveat: two older deploy DB server rows remain offline. The requested current CPU/GPU batch IDs are online.

## Stop Command

```bash
tmux kill-session -t nyabase-local; docker stop nyabase-vm
```
