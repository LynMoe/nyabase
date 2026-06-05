# Requirements

## Original Request

User requested rebuilding all test flow documentation and removing old ones:

- Put test docs under `docs/test/`.
- Hard-code that all tests use one shared instance.
- Hard-code two server agents defined by the old test deploy flow: one CPU, one GPU.
- Fix local ports and database.
- Start everything with `nohup`.
- Remove the current `test_deploy` and all databases.
- Redeploy the latest backend and update all agent configuration.

## Scope Changes

- User changed the destination from `docs/test/` to `test/`.
- User later clarified that DB files also belong under `test/`, and that `test/` must be organized carefully.

## Final Scope

Included:

- Make `test/` the single test-flow root for documentation, fixed env, scripts, live specs, runtime metadata, and the shared SQLite DB.
- Use this layout:
  - `test/docs/`
  - `test/config/`
  - `test/scripts/`
  - `test/specs/live/`
  - `test/runtime/db/`
  - `test/runtime/agents/`
  - `test/runtime/logs/`
  - `test/runtime/{murt,murtc,mount,dropbear}/`
- Remove obsolete root-level test docs (`TEST_DEPLOY.md`, `TEST_OUTLINE.md`) and the old standalone functional test flow.
- Define exactly one shared local backend instance:
  - Backend API: `http://localhost:3001/api`
  - Backend WebSocket: `ws://10.8.96.92:3001/ws/agent`
  - Frontend: `http://localhost:5173`
  - VictoriaMetrics: `http://127.0.0.1:8428`
  - SQLite DB: `test/runtime/db/nyabase-test.db`
- Define exactly two test agents:
  - CPU: `root@10.8.96.91`, `isGpuServer=false`, Docker root `/data/nyabase-docker`.
  - GPU: `lyn@10.8.1.12` with sudo, `isGpuServer=true`, Docker root `/data0/nbTest/nyabase-docker-pquota`.
- Add scripts to stop/start/reset/register/deploy the shared instance using `nohup` for local services.
- Register fresh CPU/GPU server rows in the new DB and update both remote agent configs.

Excluded:

- Rewriting product business logic unless deployment exposes a blocking bug.
- Deleting Docker/containerd metadata DBs that are unrelated to the nyabase backend SQLite database.

## Acceptance Criteria

1. `test/` contains all authoritative docs/config/scripts/specs/runtime DB locations required for testing.
2. Root-level old docs `TEST_DEPLOY.md` and `TEST_OUTLINE.md` are removed.
3. Local test backend uses the fixed SQLite path `test/runtime/db/nyabase-test.db`.
4. Local backend/frontend are started with `nohup` on fixed ports `3001` and `5173`.
5. VictoriaMetrics uses the fixed local port `8428`.
6. A fresh backend DB is created under `test/runtime/db/` and responds to admin login.
7. Exactly two fresh server rows are registered for the test agents and captured under `test/runtime/agents/`.
8. Remote CPU/GPU `/etc/nyabase/agent.yaml` files are updated to the fresh server IDs/tokens.
9. Agent services are restarted and report online to the shared backend, unless blocked by external host infra.
10. `packages/common/src/**` contains no generated `.js`, `.js.map`, `.d.ts`, or `.d.ts.map`.

## Harness Note

The available subagent tool is restricted to cases where the user explicitly asks for subagents; this conflicts with the repository harness role-dispatch rule. Work is therefore performed in the main thread, and this limitation is recorded here.
