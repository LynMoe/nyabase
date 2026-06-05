# Run / Verification

## Commands

- `bash scripts/dev.sh`
  - Built `@nyabase/common` and `@nyabase/backend`.
  - Started VictoriaMetrics, backend, and attempted frontend startup.
  - Backend passed the script's startup probe.
- `tmux new-session -d -s nyabase-frontend-5173 'cd /root/nyabase/packages/frontend && pnpm exec vite --host 0.0.0.0 --port 5173 --strictPort 2>&1 | tee -a /tmp/nyabase-frontend.log'`
  - Used because the script's `nohup` frontend process did not remain running in this environment.

## Servers

- Frontend
  - URL: `http://localhost:5173/`
  - tmux session: `nyabase-frontend-5173`
  - Process: `node ./node_modules/.bin/../vite/bin/vite.js --host 0.0.0.0 --port 5173 --strictPort`
  - PID observed: `2840103`
  - Log: `/tmp/nyabase-frontend.log`
- Backend
  - URL: `http://localhost:3001/api`
  - Process: `node -r tsconfig-paths/register dist/main.js`
  - PID observed: `2839631`
  - Log: `/tmp/nyabase-backend.log`
- VictoriaMetrics
  - URL: `http://localhost:8428`
  - Container: `nyabase-vm`
  - Container ID observed: `2d041019f2ed`

## Verification

- `curl -sS -D - -o /tmp/nyabase-frontend-current.html http://localhost:5173/`
  - Result: `HTTP/1.1 200 OK`
- `curl -sS -o /tmp/nyabase-auth-me-current.out -w '%{http_code}\n' http://localhost:3001/api/auth/me`
  - Result: `401` (expected unauthenticated response; proves backend is reachable)
- `curl -sS -o /tmp/nyabase-vm-current.out -w '%{http_code}\n' http://localhost:8428/health`
  - Result: `200`
- `ss -ltnp`
  - `0.0.0.0:5173` listening
  - `*:3001` listening
  - `127.0.0.1:8428` listening
- `find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) | sort`
  - Result: no output; source artifact guard passed.

## Status

GREEN

## Follow-up: switch backend to the test/deploy database

User reported the UI had no servers. Root cause: the backend initially ran with
`DB_PATH=/tmp/nyabase-dev.db`, which contained `servers=0`.

`test/.env` identifies the test/deploy database as:

```text
DB_PATH=/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db
```

Read-only inspection of that database showed:

- `users=4`
- `servers=4`
- `images=2`
- `containers=4`
- server rows include `nyabase-cpu-batch-20260601T163636Z` and `nyabase-gpu-batch-20260601T163636Z`

Attempting to start this existing DB with `DB_SYNC=true` failed during TypeORM
schema synchronization:

```text
NOT NULL constraint failed: temporary_container_mounts.containerId
```

The backend was therefore restarted with the same DB and `DB_SYNC=false`, which
matches an existing populated database and avoids startup-time schema mutation.

Backup created before the successful restart:

```text
/tmp/nyabase-productdb-before-testdb-restart-20260604T064231Z.db
```

Final backend process:

- tmux session: `nyabase-backend-testdb-3001`
- PID: `2842678`
- DB env: `DB_PATH=/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`
- DB sync env: `DB_SYNC=false`
- log: `/tmp/nyabase-backend-testdb.log`

Verification after restart:

- `http://localhost:5173/`: `HTTP/1.1 200 OK`
- `http://localhost:3001/api/auth/login` with `admin/admin123`: `200`
- `GET /api/servers` as admin: `200`, returned `4` servers:
  - `nyabase-test-1` (`offline`)
  - `nyabase-gpu-1` (`offline`)
  - `nyabase-cpu-batch-20260601T163636Z` (`online`)
  - `nyabase-gpu-batch-20260601T163636Z` (`online`)
- Backend open file check confirmed the process is using `/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db`.
- SQLite `PRAGMA integrity_check`: `ok`
- `packages/common/src/**` generated artifact guard: no output.

## Follow-up: fix 500s from schema drift

User reported that container start/create and `/api/mount-sources`-related flows
were returning `500`.

Root cause from backend log:

```text
no such column: DataDiskEntity.desiredState
no such column: ContainerMountEntity.containerId
no such column: RemoteFsServerAssignmentEntity.updatedAt
```

The current backend code expected newer columns, while the populated test/deploy
SQLite database had not run the latest migrations. The database had no
`migrations` table before repair.

Backups:

```text
/tmp/nyabase-productdb-before-migration-20260604T070000Z.db
/tmp/nyabase-productdb-migration-dryrun-20260604T070000Z.db
/tmp/nyabase-productdb-before-updatedAt-hotfix-20260604T070100Z.db
```

Procedure:

1. Created consistent SQLite backups with `better-sqlite3` backup API.
2. Ran the compiled TypeORM migrations against the dry-run copy only:
   - `InitialSchema1700000000000`
   - `ContainerSshEnablements1780388302000`
   - `ContainerLifecycleControlPlane1780458695007`
   - `ContainerDesiredSpecBackfill1780458696000`
3. Confirmed dry-run schema and `PRAGMA integrity_check`.
4. Stopped backend, ran the same migrations against the live DB.
5. Added and backfilled the missing historical column
   `remote_fs_server_assignments.updatedAt`, which was not covered by the
   existing migration.
6. Restarted backend in tmux session `nyabase-backend-testdb-3001`.

Post-fix checks:

- Current entity/schema diff: `[]`.
- SQLite `PRAGMA integrity_check`: `ok`.
- `GET /api/servers`: `200`, count `4`.
- `GET /api/containers`: `200`, count `4`.
- `GET /api/servers/all-disks`: `200`, count `1`.
- `GET /api/mount-sources?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70`: `200`, count `1`.
- `GET /api/data-dirs?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70`: `200`, count `1`.
- `GET /api/servers/05cea385-d6ca-490a-a126-e00d0ae23b70/disks`: `200`, count `1`.
- `GET /api/mount-sources?serverId=db1112fe-1c55-4314-9511-6d8510c523c2`: `200`, count `0`.
- `GET /api/data-dirs?serverId=db1112fe-1c55-4314-9511-6d8510c523c2`: `200`, count `0`.
- `GET /api/servers/db1112fe-1c55-4314-9511-6d8510c523c2/disks`: `200`, count `0`.
- `POST /api/containers` smoke request: `201`, proving the prior DB-schema
  `500` is gone on the create path.

Smoke cleanup:

- The smoke create returned `201` but the resulting operation failed later with
  `createContainer result did not include dockerId`; this is an agent response
  compatibility/runtime issue, not the original DB-schema `500`.
- The smoke container never bound to a Docker ID and had no runtime observation.
- Exact smoke DB rows for `codexfix-mpz5efnn` /
  `ec0431e3-333d-4e36-9484-54ac4ad44b47` and its operation/outbox rows were
  removed. Post-clean counts were zero and `PRAGMA integrity_check` returned
  `ok`.

## Follow-up: container operation repair

Code-level verification:

- `pnpm --filter @nyabase/backend exec vitest run src/operations/__tests__/operations.service.test.ts`
  - Result: `1 passed`, `6 passed`.
- `pnpm build`
  - Result: passed; rebuilt common, backend, and agent package outputs.
- `bash scripts/build-agent-binary.sh`
  - Result: passed; rebuilt `dist/nyabase-agent`.
- `bash scripts/check.sh`
  - Result: passed.
  - Typecheck: passed for common, backend, agent, frontend.
  - Lint: `0` errors, `12` existing warnings.
  - Unit tests:
    - common: `3` files, `45` tests passed.
    - backend: `28` files, `139` tests passed.
    - agent: `5` files, `71` tests passed.

Remote agent deployment:

- CPU agent `root@10.8.96.91`
  - Replaced `/usr/local/bin/nyabase-agent` with rebuilt `dist/nyabase-agent`.
  - Restarted `nyabase-agent`.
  - `systemctl is-active nyabase-agent nyabase-docker.service`: both `active`.
  - Journal showed `[WS] Connected`.
- GPU agent `lyn@10.8.1.12`
  - Replaced `/usr/local/bin/nyabase-agent` with rebuilt `dist/nyabase-agent`.
  - Restarted `nyabase-agent`.
  - `systemctl is-active nyabase-agent nyabase-docker.service`: both `active`.
  - Journal showed `[WS] Connected`.

API smoke after repair:

- `POST /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/legacy-6a635418b01db5707d775f486126d8a9/start`
  - Result: `201`.
  - Operation `e7897699-1b28-468c-b1f9-d7ca1c310df8`: `succeeded`.
- `POST /api/containers` smoke before remote-agent redeploy:
  - Name: `codexfix-mpz5w76a`.
  - Result: `201`, operation then `failed`.
  - Last error: `createContainer result did not include dockerId`.
  - CPU Docker residue check: no `codexfix-*` containers.
  - Exact DB cleanup completed; `PRAGMA integrity_check`: `ok`.
- `POST /api/containers` smoke after remote-agent redeploy:
  - Name: `codexfix-mpz60vnf`.
  - Result: `201`.
  - Create operation `5f847205-ba86-45be-a23c-53388d867da3`: `succeeded`.
  - Container ID: `01e36184-ab63-4879-957f-4a0c6d8bf23c`.
  - Docker ID: `222f293e4797de84ffdb09c3bd4c5645b67a7bc114753648cbd7cef227834a98`.
  - `DELETE /api/containers/05cea385-d6ca-490a-a126-e00d0ae23b70/01e36184-ab63-4879-957f-4a0c6d8bf23c`
    returned `200`.
  - Delete operation `16609fb7-a583-4611-83c1-28cb5e247c05`: `succeeded`.

Final smoke cleanup:

- Remote CPU Docker:
  - `docker ps -a --filter name=codexfix`: no output.
- Test DB:
  - `containers` rows matching `codexfix-*`: `0`.
  - `operations` rows matching smoke requests/resources: `0`.
  - `agent_command_outbox` rows matching smoke payloads: `0`.
  - `audit_logs` rows matching smoke names: `0`.
  - `quota_desired` smoke row with lastOperationId
    `5f847205-ba86-45be-a23c-53388d867da3`: `0`.
  - `PRAGMA integrity_check`: `ok`.

Current runtime status:

- Frontend: `0.0.0.0:5173`, PID `2840103`.
- Backend: `*:3001`, PID `2852948`, tmux `nyabase-backend-testdb-3001`.
- VictoriaMetrics: `127.0.0.1:8428`.
- CPU/GPU batch agents are online and connected.
- Final API sanity:
  - `GET /api/servers`: `200`, count `4`.
  - `GET /api/containers`: `200`, count `5`.
  - `GET /api/mount-sources?serverId=05cea385-d6ca-490a-a126-e00d0ae23b70`: `200`, count `1`.
- The extra non-smoke container row is `testt`
  (`829d7f7b-439e-4ecf-a500-088fa738e6bc`), created at
  `2026-06-04 07:16:21` before remote-agent redeploy and failed with the same
  old-agent `dockerId` error. It was not created by the `codexfix-*` smoke
  scripts and was left untouched.
