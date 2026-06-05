# Implementation

## Completed File Changes

- Reorganized `test/`:
  - `test/config/local.env`
  - `test/config/agents.json`
  - `test/docs/RUNBOOK.md`
  - `test/specs/live/*.spec.ts`
  - `test/runtime/db/`
  - `test/runtime/agents/`
  - `test/runtime/logs/`
- Updated docs to make `test/` the authoritative test root.
- Updated startup/reset scripts so local backend/frontend use `nohup` and write DB/logs/PIDs under `test/runtime/`.
- Updated agent registration/deployment to read config from `test/config/` and generate metadata/secrets/config YAML under `test/runtime/agents/`.
- Added `test/scripts/create-mount-fixture.mjs` and `test/scripts/run-functional.sh`.
- Replaced `pnpm test:functional` with the shared-instance functional script.
- Removed old root docs and the old standalone functional script.
- Updated live specs so runtime coordinates default to `test/runtime/` and the moved spec paths are reflected in command strings.

## Runtime Changes Completed

- Restarted shared backend/frontend from `test/runtime/db/nyabase-test.db`.
- Removed the old `/tmp/nyabase-test-env/nyabase-test.db*` files.
- Registered fresh CPU/GPU server rows.
- Deployed generated agent configs to CPU/GPU hosts.
- Verified both remote `nyabase-agent` services are active and report online to the shared backend.
