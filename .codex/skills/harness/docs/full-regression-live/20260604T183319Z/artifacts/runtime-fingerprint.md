# Runtime Fingerprint — full-regression-live 20260604T183319Z

Captured at: 2026-06-04T18:35:13Z

Backend:
- PID/cwd/argv: PID 2996829, `/root/nyabase/packages/backend`, `node -r tsconfig-paths/register dist/main.js`.
- env/config: `NODE_ENV=development`, `PORT=3001`, `DB_DRIVER=sqlite`, `DB_PATH=/root/nyabase/test/runtime/db/nyabase-test.db`, `DB_SYNC=true`, `CORS_ORIGIN=http://localhost:5173`, JWT/admin secrets redacted.
- base URL: `http://localhost:3001/api`; `/api/auth/me` returned HTTP 401, proving correct API reachable.
- DB identity: `/root/nyabase/test/runtime/db/nyabase-test.db`, inode 1054972, backend FD `/proc/2996829/fd/20 -> /root/nyabase/test/runtime/db/nyabase-test.db`.
- schema/migrations: SQLite sync mode; quick DB table probe via backend dependency succeeded for outbox/quota tables, but table naming differs from expected simple names in the first probe.
- backend dist freshness: current enough for current source (dist built 2026-06-05T01:37 local; newest backend src <= 2026-06-05T01:36).
- common dist freshness: rebuilt by `bash scripts/check.sh` at 2026-06-05T02:35; common source artifact guard empty.

Frontend:
- port owner: PID 2996864 vite on `0.0.0.0:5173`.
- served mode: Vite dev.
- base URL: `http://localhost:5173`; GET `/` returned HTTP 200 HTML.

Services:
- VictoriaMetrics: `http://127.0.0.1:8428/health` returned `OK`; docker-proxy on 127.0.0.1:8428.

Agents:
- expected server rows from `test/runtime/agents/servers.json`: CPU `d7c6b76e-359f-47bd-81af-ea9f7e2223f2`, GPU `a8694107-56c4-4a78-93f4-4ea90eddc580`.
- API `/servers`: both `nyabase-test-cpu` and `nyabase-test-gpu` online.
- remote service state: CPU and GPU `nyabase-agent` active; `/usr/local/bin/nyabase-agent` hash `d244ed766d862a593bc792cd528585b89ef58da3e9c52bc43233ad063d2c0484` on both hosts, matching local `dist/nyabase-agent`.
- remote logs: CPU latest connected; GPU latest retained an older networking error line, so live GPU creates need fresh validation before treating this as active failure.

Result:
- preflight: pass for local backend/frontend/VM and agent online identity.
- blocker classification: none for baseline live testing; possible stale/runtime risk only if GPU create reproduces the old networking error.

Evidence logs:
- `logs/00-runtime-preflight.log`
- `logs/02-api-preflight.log`
- `logs/03-dist-staleness.log`
- `logs/10-remote-agent-preflight.log`
