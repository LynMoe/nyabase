# Group Functional Coverage Tester Report

Timestamp: 2026-06-05T05:38:08Z
Role: group/functional coverage tester subagent
Scope: run existing group-related functional coverage without reset/deploy and without product edits.

## Command Decision

Inspected `test/scripts/run-functional.sh` before execution.

- It does not call `reset-local.sh`.
- It does not call `deploy-agents.sh` or `register-agents.mjs`.
- It uses existing `test/config/local.env` endpoints:
  - backend: `http://localhost:3001/api`
  - frontend: `http://localhost:5173`
  - VictoriaMetrics: `http://127.0.0.1:8428`
- It creates temporary resources under a `functional-<run-id>` prefix and has an `EXIT` cleanup trap for grants, group, user, and image.

Executed:

```bash
pnpm test:functional | tee .codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/group-functional.log
```

## Result

Overall command exit: failed with exit code 1.

Summary from script:

- Passed: 24
- Failed: 1
- Skipped: 0

Failure:

- `ordinary user cannot create user`
- Expected: `HTTP 403`
- Actual: `HTTP 404`
- Body: `{"message":"Cannot POST /api/users","error":"Not Found","statusCode":404}`

Assessment: this did not show privilege escalation or user creation. It is an assertion/status-code mismatch for a non-admin request to `/api/users`, consistent with the persona lane's `/users` `404` vs expected `403` behavior.

## Covered Paths

Shared instance readiness:

- Backend reachable through `/api/auth/me`
- Frontend reachable at `/`
- VictoriaMetrics health reachable

Auth:

- Wrong admin password rejected with `401`
- Admin login succeeds
- Admin `/auth/me` succeeds
- Temporary functional user login succeeds

Fixed agent/server visibility:

- Admin lists servers
- CPU test server row exists and is online
- GPU test server row exists and is online

Users and groups:

- Admin creates functional user
- Admin creates functional group with priority `5`
- Group capabilities include `manage_images`
- Admin adds functional user to group
- Admin reads functional user

Images and grants:

- Admin creates functional image using `alpine:3.20`
- Admin grants CPU server access to functional user with:
  - `cpuMillis`: `500`
  - `memBytes`: `268435456`
  - `diskBytes`: `67108864`
  - `gpuMode`: `none`
  - `gpuIndices`: `[]`
- Admin grants image access to functional user on CPU server
- Functional user can list accessible servers
- Functional user sees at least one server
- Functional user can read `/me/access`

Isolation:

- Ordinary functional user cannot read `/audit`: `403`
- Ordinary functional user cannot create via `/api/users`: denied by actual `404`, but test expected exact `403`

## Not Covered By This Functional Script

- Group-derived server/image grants; the script grants server/image directly to the user.
- Group quota inheritance/effective quota calculation.
- Multiple groups, priority conflict resolution, or capability merging beyond group creation payload.
- Quota exhaustion, quota race, or over-quota create attempts.
- Container lifecycle actions such as create/start/restart/delete.
- SSH/Dropbear and mount workflows.
- Cross-user container attack paths.

Those areas are covered or partially covered by other live lanes (`personas`, `mounts`, `dropbear`, `continuation`) as separately reported, but not by `pnpm test:functional`.

## Cleanup Evidence

The script's cleanup trap ran after failure. SQLite prefix checks after the run:

```text
users|0
groups|0
images|0
server_grants_functional_scope|0
image_grants_functional_scope|0
```

Common source artifact guard:

```bash
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```

Output was empty.

## Artifacts

- Raw command log: `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/group-functional.log`
- This report: `.codex/skills/harness/docs/live-functional-redteam/20260605T052939Z-live-matrix/group-functional-report.md`
- Shared live server status reference: `test/runtime/agents/live-server-status.json`

## Blockers And Residual Risk

- Blocker for green functional suite: `/api/users` returns `404` for ordinary-user POST, while the script expects exact `403`.
- No product files were edited.
- No reset or deploy command was run.
