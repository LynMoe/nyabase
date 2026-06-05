# Live Test Runbook

## Rules

1. Use one shared backend instance only.
2. Use the fixed ports and DB in `test/config/local.env`.
3. Start local backend and frontend with `nohup`.
4. Use exactly the CPU and GPU agents in `test/config/agents.json`.
5. Do not put test docs, generated config, or live-test scripts outside `test/`.
6. Do not write generated artifacts under `packages/common/src/**`.

## Reset And Start

`reset-local.sh` stops local services, deletes the fixed SQLite DB, starts
VictoriaMetrics, builds the required packages, and starts backend/frontend with
`nohup`.

```bash
bash test/scripts/reset-local.sh
```

Expected:

- `http://localhost:3001/api/auth/me` returns `401`.
- `http://localhost:5173/` returns HTML.
- `http://127.0.0.1:8428/health` returns `OK`.
- `admin / admin123` logs in.

## Register Server Rows

```bash
node test/scripts/register-agents.mjs
```

This creates two fresh server rows:

- `nyabase-test-cpu`
- `nyabase-test-gpu`

Outputs:

- `test/runtime/agents/servers.json`: non-secret server metadata.
- `test/runtime/agents/agent-secrets.json`: server IDs and raw tokens, mode `0600`.
- `test/runtime/agents/configs/*.yaml`: generated agent configs.

## Deploy Agents

```bash
bash test/scripts/deploy-agents.sh
```

The script builds `dist/nyabase-agent`, copies it to both hosts, writes
`/etc/nyabase/agent.yaml`, reloads systemd, and restarts `nyabase-agent`.

Expected remote services:

- `nyabase-agent`: `active`.
- `nyabase-docker.service`: `active`.

Expected product state:

- `GET /api/servers` shows `nyabase-test-cpu` online.
- `GET /api/servers` shows `nyabase-test-gpu` online.

## Run Live Tests

Run a quick readiness check:

```bash
bash test/scripts/run-live-suite.sh smoke
```

Run the full real API suite:

```bash
bash test/scripts/run-live-suite.sh api
```

The suite uses only the shared backend API. Admin first ensures persistent
servers, disks, images, users, groups, quotas, image grants, server grants, and
mount-source grants. It then starts separate persona Node processes that log in
as ordinary users and exercise profile, SSH key, API token, access summary,
mount source, data directory, container lifecycle, operation polling, metrics,
and isolation endpoints.

Persistent fixture resources are reused across runs:

- `test/runtime/live-api/fixture.json`
- `test/runtime/live-api/*.env`

Runtime containers and per-run data directories are cleaned by default. Set
`NYABASE_LIVE_API_KEEP_CONTAINERS=1` only when debugging a failed container.

Legacy red-team specs remain available for targeted debugging:

```bash
bash test/scripts/run-live-suite.sh legacy-admin-setup
bash test/scripts/run-live-suite.sh legacy-redteam
```

The frontend Playwright e2e specs under `packages/frontend/e2e/` are mocked UI
or visual checks. They must not be treated as product API functional coverage.

## Logs And Runtime Files

| Purpose | Path |
| --- | --- |
| Backend PID | `test/runtime/logs/backend.pid` |
| Frontend PID | `test/runtime/logs/frontend.pid` |
| Backend log | `test/runtime/logs/backend.log` |
| Frontend log | `test/runtime/logs/frontend.log` |
| Fixed DB | `test/runtime/db/nyabase-test.db` |
| Server metadata | `test/runtime/agents/servers.json` |
| Raw agent tokens | `test/runtime/agents/agent-secrets.json` |
| Live API fixture | `test/runtime/live-api/fixture.json` |
| Latest live API report env | `test/runtime/live-api/current.env` |
| Multi-user state | `test/runtime/murt/current.env` |
| Mount fixture state | `test/runtime/mount/current.env` |

## Cleanup

Stop local backend/frontend:

```bash
bash test/scripts/stop-local.sh
```

Reset DB and local services:

```bash
bash test/scripts/reset-local.sh
```

Remove only generated runtime metadata:

```bash
rm -rf test/runtime
```
