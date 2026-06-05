# Design

## Decisions

1. Make `test/` the only user-facing test-flow root.
   - Root `test/README.md` is a short index.
   - Detailed docs live in `test/docs/`.
   - Fixed config lives in `test/config/local.env` and `test/config/agents.json`.
   - Automation lives under `test/scripts/`.
   - Live specs live under `test/specs/live/`.
   - Generated runtime outputs live under `test/runtime/` and are gitignored.

2. Use a single shared local instance for every live/functional test.
   - Backend: `PORT=3001`.
   - Frontend: `PORT=5173`.
   - VictoriaMetrics: `127.0.0.1:8428`.
   - Backend DB: `test/runtime/db/nyabase-test.db`.
   - Startup is done with `nohup`; scripts record PID files and logs under `test/runtime/logs/`.

3. Reset DB by deleting only backend SQLite runtime artifacts.
   - Remove `test/runtime/db/nyabase-test.db` plus `-wal`, `-shm`, and `-journal` companions.
   - Also remove old `/tmp/nyabase-test-env/nyabase-test.db*` once as migration cleanup.
   - Do not delete Docker/containerd metadata DBs.

4. Use `DB_SYNC=true` for the fixed local test instance.
   - The current baseline migration is intentionally empty; a fresh SQLite DB requires TypeORM synchronize to create the full entity schema.
   - `DB_MIGRATIONS_RUN=false` avoids running delta migrations against already-synchronized schema.

5. Register CPU/GPU server rows through the product API.
   - Raw one-time tokens are persisted only in `test/runtime/agents/agent-secrets.json` with `0600`.
   - Public metadata is persisted in `test/runtime/agents/servers.json`.
   - Agent configs are generated in `test/runtime/agents/configs/` and deployed to the remote hosts.

6. Convert old live spec path handling to environment-driven runtime coordinates.
   - `test/scripts/run-live-suite.sh` passes state/credential env vars to specs.
   - Multi-user, mount-source, continuation, and Dropbear runtime output defaults now stay under `test/runtime/`.

7. Replace the old standalone `scripts/test-functional.sh`.
   - `pnpm test:functional` now calls `test/scripts/run-functional.sh`.
   - The new script verifies the shared instance and does not start its own backend/agent or DB.

## File-Level Changes

- Removed:
  - `TEST_DEPLOY.md`
  - `TEST_OUTLINE.md`
  - `scripts/test-functional.sh`
- Added/updated:
  - `test/README.md`
  - `test/docs/RUNBOOK.md`
  - `test/config/local.env`
  - `test/config/agents.json`
  - `test/.gitignore`
  - `test/scripts/stop-local.sh`
  - `test/scripts/start-local.sh`
  - `test/scripts/reset-local.sh`
  - `test/scripts/register-agents.mjs`
  - `test/scripts/deploy-agents.sh`
  - `test/scripts/run-live-suite.sh`
  - `test/scripts/run-functional.sh`
  - `test/scripts/create-mount-fixture.mjs`
  - `test/specs/live/*.spec.ts`
  - `scripts/dev.sh`
  - `package.json`

## Risks

- Remote host deployment can fail if SSH, sudo, systemd, Docker, NVIDIA runtime, or network prerequisites are unavailable.
- The CPU/GPU agents may have existing runtime containers from older runs. The new backend DB will not know them; cleanup remains prefix-scoped through live test scripts.
- Mount-source tests require a CPU local XFS data disk and an NFS export fixture. The script can create product rows, but live host filesystem prerequisites can still block.
