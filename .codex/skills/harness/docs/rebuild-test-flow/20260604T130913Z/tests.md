# Tests

## Commands

- `bash -n test/scripts/start-local.sh test/scripts/stop-local.sh test/scripts/reset-local.sh test/scripts/deploy-agents.sh test/scripts/run-live-suite.sh test/scripts/run-functional.sh scripts/dev.sh`
  - PASS.
- `node --check test/scripts/register-agents.mjs && node --check test/scripts/create-mount-fixture.mjs`
  - PASS.
- `find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print`
  - PASS, no generated artifacts.
- `bash test/scripts/reset-local.sh`
  - PASS. Backend/frontend started with `nohup setsid`.
  - DB: `/root/nyabase/test/runtime/db/nyabase-test.db`.
- `node test/scripts/register-agents.mjs`
  - PASS. Created two server rows:
    - CPU: `39b26296-b306-4097-8d81-a97ac578cd88`
    - GPU: `981f647d-5960-4e6e-9e5c-61df1a01ac53`
- `bash test/scripts/deploy-agents.sh`
  - PASS. Both remote services restarted and reported online.
- `bash test/scripts/run-live-suite.sh smoke`
  - PASS. Backend, frontend, VictoriaMetrics, and admin login OK.
- `pnpm test:functional`
  - PASS. 25 passed, 0 failed, 0 skipped.
- `bash scripts/check.sh`
  - PASS. Typecheck, lint, unit tests, and common-src artifact guard passed. Lint emitted existing warnings only.
- Remote checks:
  - CPU `/etc/nyabase/agent.yaml` serverId matched generated CPU row; `systemctl is-active nyabase-agent` returned `active`.
  - GPU `/etc/nyabase/agent.yaml` serverId matched generated GPU row; `systemctl is-active nyabase-agent` returned `active`.

## Runtime State

- Backend: `http://localhost:3001/api`.
- Frontend: `http://localhost:5173`.
- VictoriaMetrics: `http://127.0.0.1:8428`.
- DB: `test/runtime/db/nyabase-test.db`.
- Logs/PIDs: `test/runtime/logs/`.
- Agent metadata/secrets/configs: `test/runtime/agents/`.

## Not Run

- Full multi-user persona, mount-source, continuation, and Dropbear live suites were not run in this pass because the request was to rebuild/deploy the test flow. They are wired under `test/scripts/run-live-suite.sh`.
