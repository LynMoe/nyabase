# Live Test Report

## Runtime
- Frontend: http://localhost:5173
- Backend: http://localhost:3001/api
- VictoriaMetrics: http://127.0.0.1:8428
- Admin: admin / admin123
- CPU server: 1b9c08fa-32e1-4943-8dc5-d83772cd52f9
- GPU server: 343488f6-2689-488a-8bf8-8c02caf25989

## Subagent Reports
- Admin lane: `.codex/skills/harness/docs/live-test-admin/20260604-232209-admin/tests.md`
- User lane: `.codex/skills/harness/docs/live-test-user/20260604-232219/tests.md`
- Architect analysis: subagent notification in transcript.
- Developer lane: subagent notification in transcript.

## Commands / Results
- `bash test/scripts/reset-local.sh`: passed; reset DB and started local backend/frontend.
- `bash test/scripts/run-live-suite.sh smoke`: passed before and after fixes.
- `node test/scripts/register-agents.mjs`: passed; created fixed CPU/GPU rows.
- `bash test/scripts/deploy-agents.sh`: passed; CPU/GPU agents online.
- `bash test/scripts/run-live-suite.sh admin-setup`: passed; created users/images/grants fixture.
- `pnpm test:functional`: passed 25/25.
- `bash test/scripts/run-live-suite.sh personas`: before fixes failed 6 specs; after fixes failed 5 specs, epsilon passed.
- Focused checks after code fixes:
  - `pnpm --filter @nyabase/backend typecheck`: passed.
  - `pnpm --filter @nyabase/backend test -- operations.service.test.ts container-operations-dispatch.test.ts`: passed 14 tests.
  - `pnpm --filter @nyabase/frontend typecheck`: passed.
  - `pnpm --filter @nyabase/common test`: passed 47 tests.

## Fixed During This Session
1. Live SSH-key fixtures: invalid fake ed25519 keys caused 400. Added/shared valid fixture for beta/gamma/delta/epsilon; alpha was also changed locally by lead.
2. Operation terminal drift repair: if an outbox command is terminal but linked operation remains non-terminal, repair now also restores container domain state for start/stop/restart/delete.
3. Frontend lifecycle gating: container list/detail now avoids enabling runtime actions while unbound, creating/updating/deleting, or active operation exists.
4. GPU inventory API: `/servers/:id/gpus` now returns agent stateCache GPU inventory instead of `[]`.

## Remaining Failures / Classification
- `test-bug/live-wait`: alpha and beta specs call `/stats` immediately after visible create row. Backend correctly returns 409 while desired row has no dockerId yet. Tests should wait for create operation terminal and `lifecycle.phase=active && lifecycle.dockerId` before stats/exec/stop.
- `test-bug/expected-status`: gamma and delta over-count GPU denial returns 409 (`Not enough permitted GPUs available`), while specs expect only 400/403. 409 is semantically acceptable conflict.
- `test-bug/live-status`: gamma-delta attack treats only runtime status as usable. It should wait for lifecycle active + bound, not only list visibility.
- `env-drift/runtime-residue`: backend logs show repeated `Unknown numericUserId` from old host containers. Cleanup/reset of remote Docker roots is needed for a clean live suite.
- `env-drift/mount-fixture`: admin lane found missing local/remote mount-source fixture.

## Artifacts
- Runtime logs: `test/runtime/logs/backend.log`, `test/runtime/logs/frontend.log`
- MURT state: `test/runtime/murt/current.env`
- Admin UI screenshots: `.codex/skills/harness/docs/live-test-admin/20260604-232209-admin/artifacts/ui/`
- User screenshots/API logs: `.codex/skills/harness/docs/live-test-user/20260604-232219/`
