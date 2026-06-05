Runtime fingerprint: live preflight startup
Captured at: 2026-06-05T05:31:51Z

Backend:
- PID/cwd/argv: `3221986` / `/root/nyabase/packages/backend` / `node -r tsconfig-paths/register dist/main.js`
- Base URL: `http://localhost:3001/api`
- Auth readiness: `GET /api/auth/me` returned `401 Unauthorized`
- DB path: `/root/nyabase/test/runtime/db/nyabase-test.db`
- DB identity: inode `1048623`, size `1069056`, mtime `2026-06-05 13:31:16.758284425 +0800`
- Schema state: expected live tables present, including `servers`, `users`, `containers`, `operations`, `quota_desired`, `runtime_containers`, `runtime_gpu_inventory`
- Build path: `packages/backend/dist/main.js` started after `pnpm --filter @nyabase/backend build`

Frontend:
- PID/cwd/argv: `3222054` / `/root/nyabase/packages/frontend` / `node /usr/bin/pnpm exec vite --port 5173 --host 0.0.0.0 --strictPort`
- URL: `http://localhost:5173/`
- HTML readiness: returned `200 OK`, Vite dev HTML with `<title>nyabase</title>`
- Vite log: `VITE v6.4.2 ready`, local URL `http://localhost:5173/`

Services:
- VictoriaMetrics: `GET http://127.0.0.1:8428/health` returned `200 OK`, body `OK`
- Local service record: `test/runtime/local-services.json`
- Common source artifact guard: no `.js`, `.js.map`, `.d.ts`, or `.d.ts.map` files found under `packages/common/src/**`

Agents:
- Expected config source: `test/config/agents.json`
- Registered metadata: `test/runtime/agents/servers.json`
- Raw token file: `test/runtime/agents/agent-secrets.json`, mode `0600`
- Generated configs: `test/runtime/agents/configs/cpu.yaml`, `test/runtime/agents/configs/gpu.yaml`, mode `0600`
- Local agent binary hash: `7a2d1f57fc6c17283c3ff2bb8a055784e71bd8cb231eb9c883726cfce1423904`
- CPU server: `9a6401c2-a79b-4cb8-a91b-2f1a61679c34`, `nyabase-test-cpu`, API status `online`, lastSeenAt `2026-06-05T05:31:50.125Z`
- GPU server: `a6de7f5d-f4b4-47da-8799-1d25ff03cf94`, `nyabase-test-gpu`, API status `online`, lastSeenAt `2026-06-05T05:31:49.673Z`
- CPU remote service health: `nyabase-agent` active, `nyabase-docker.service` active, `/usr/local/bin/nyabase-agent` hash matched local
- GPU remote service health: `nyabase-agent` active, `nyabase-docker.service` active, `/usr/local/bin/nyabase-agent` hash matched local

Runtime observations:
- Backend log contains repeated `Unknown numericUserId` warnings from previous remote host runtime state after DB reset. These did not block agent online status or smoke readiness.

Result:
- Preflight startup: pass for fixed backend/frontend/VictoriaMetrics readiness, exact agent registration/deployment, remote service health, and smoke readiness.
- Blocker classification: none for this lane.
