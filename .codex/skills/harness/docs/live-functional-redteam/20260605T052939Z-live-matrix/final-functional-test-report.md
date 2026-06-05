# Nyabase Live Functional / Red-Team Test Report

Verdict: FAIL
Verdict scope: requested live functional, persona, mount, SSH, and bounded red-team flow
Risk tier: live-test + security verification

## Summary

The shared test environment started successfully, both fixed agents were online, and the main live runtime paths passed: admin fixture setup, continuation lifecycle, mount matrix, Dropbear SSH runtime, and bounded cross-user attack checks.

The overall flow is not green because two existing tests expect exact `403` management-route denials for ordinary users, while the API returned `404`:

- `multi-user-redteam-epsilon.spec.ts`: `GET /users` returned `404`, expected `403`.
- `pnpm test:functional`: ordinary user `POST /api/users` returned `404`, expected `403`.

No tested path showed privilege escalation or successful unauthorized mutation.

## Runtime Fingerprint

- Backend: PID `3221986`, `http://localhost:3001/api`, `/api/auth/me` returned `401`.
- Frontend: PID `3222054`, `http://localhost:5173`, `/` returned `200`.
- VictoriaMetrics: `http://127.0.0.1:8428/health` returned `OK`.
- Agents:
  - CPU: `nyabase-test-cpu`, `9a6401c2-a79b-4cb8-a91b-2f1a61679c34`, online.
  - GPU: `nyabase-test-gpu`, `a6de7f5d-f4b4-47da-8799-1d25ff03cf94`, online.
- Agent binary hash matched local/remote: `7a2d1f57fc6c17283c3ff2bb8a055784e71bd8cb231eb9c883726cfce1423904`.
- Detailed fingerprint: `runtime-fingerprint.md`.

## Suites And Probes Run

| Command / suite | Result | Notes |
| --- | --- | --- |
| `bash test/scripts/reset-local.sh` | pass | Fixed DB/services reset by devops lane. |
| `node test/scripts/register-agents.mjs` | pass | Registered exact CPU/GPU test agents. |
| `bash test/scripts/deploy-agents.sh` | pass | Remote agent and nyabase docker services active. |
| `bash test/scripts/run-live-suite.sh smoke` | pass | Auth readiness, frontend, VM health, admin login. |
| `bash test/scripts/run-live-suite.sh admin-setup` | pass | Created 5 personas, CPU/GPU grants, image grants, mount grants, quotas. |
| `bash test/scripts/run-live-suite.sh continuation` | pass | Create/restart/delete operation flow. |
| `bash test/scripts/run-live-suite.sh personas` | fail | 5 specs passed, epsilon management-route denial expected `403`, got `404`. |
| `node test/scripts/create-mount-fixture.mjs` | pass | Mount fixture created. |
| `bash test/scripts/run-live-suite.sh mounts` | pass | Unauthorized mount/source use denied; residuals zero. |
| `bash test/scripts/run-live-suite.sh dropbear` | pass | SSH enablement, key sync, isolation, repair, cleanup. |
| `pnpm test:functional` | fail | 24 passed, 1 failed: ordinary user `POST /api/users` expected `403`, got `404`. |
| `find packages/common/src ...` artifact guard | pass | Empty output. |

## Coverage

| Requested area | Status | Evidence |
| --- | --- | --- |
| Admin-created accounts | covered | `admin-setup`, `group-functional-report.md`. |
| Different groups | partial | Functional script creates one group and member; live personas use direct grants, not group-derived grants. |
| Quotas/grants | partial | Admin fixture assigns CPU/mem/disk/GPU grants; abusive over-quota/exhaustion/race not covered by existing live specs. |
| Images | covered | Admin fixture and functional script create/grant images; inactive/ungranted image denial matrix remains partial. |
| Create/delete/start/restart | covered | `continuation`, `personas`, `dropbear`. |
| SSH | covered | `dropbear-live-runtime.spec.ts`. |
| Mounts | covered | `multi-user-redteam-mount-sources.spec.ts`. |
| Cross-user attack | covered | gamma/delta attack, mount cross-user deletes, Dropbear user-B isolation. |
| Quota abuse/red-team | partial | No existing dedicated over-quota, aggregate quota exhaustion, or concurrent quota race live spec found. |
| Token/auth tampering | partial | Ordinary auth boundaries covered; no dedicated tampered-token live spec found. |

## Failures

1. `personas::epsilon no-access flow`
   Cause: API returned `404` for `GET /users`; test expected exact `403`.
   Classification: unclear-spec
   Evidence: `personas-report.md`, `personas.log`.

2. `pnpm test:functional::ordinary user cannot create user`
   Cause: API returned `404` for `POST /api/users`; script expected exact `403`.
   Classification: unclear-spec
   Evidence: `group-functional-report.md`, `group-functional.log`.

## Security Results

Observed denials:

- Alpha unauthorized GPU create denied with accepted `403/404`.
- Epsilon no-access container create denied with accepted `403/404`.
- Delta could not read stats, stop, or delete gamma's container by guessed ID.
- Alpha/beta unauthorized mount source use denied.
- Delta cross-user data-dir delete guesses denied/not found.
- Dropbear user B could not read, mutate, SSH-enable, reconcile, or delete user A resources.
- Ordinary functional user could not read audit.

No tested attack path caused unauthorized access, mutation, or cross-user deletion.

## Cleanup

- Persona lifecycle: 6 matching `murt-20260605t053259z-9c42ff` containers had `deleted_at`; active residual count `0`; 17 operations and 17 outbox commands succeeded.
- Mount: run `mount-20260605t053331z-1d1805`; 6 containers and 5 data dirs created and deleted; final residuals `0`.
- Dropbear: run `dropbear-live-20260605t053423z-6f61d4`; product containers residual none; grants/images/users/temp SSH files cleaned.
- Functional: `functional-%` users/groups/images/server_grants/image_grants residual count `0`.
- Common source artifact guard: empty output.

Residual cleanup gap: the second Dropbear lane did not perform CPU managed Docker exact-prefix host-level residual scan; product-level residual checks were clean.

## Artifact Index

- Runtime fingerprint: `runtime-fingerprint.md`
- Coverage matrix: `coverage-matrix.md`
- Red-team rollup: `tests.md`
- Persona report: `personas-report.md`
- Mount/SSH report: `mount-ssh-subagent-report.md`
- Group functional report: `group-functional-report.md`
- MURT state: `test/runtime/murt/20260605t053259z-9c42ff/state.json`
- Mount report: `test/runtime/mount/20260605t053331z-1d1805/mount-runtime-report.md`
- Dropbear report: `test/runtime/dropbear/20260605t053423z-6f61d4/dropbear-live-report.redacted.md`
- Session worklog: `worklog.md`

## Open Concerns

- Decide whether ordinary-user management routes should intentionally return non-disclosure `404` or explicit `403`, then update tests or route behavior consistently.
- Add live group-derived grant/quota/image/mount tests before claiming group authorization is fully covered.
- Add red-team quota abuse specs for over CPU/memory/disk/GPU index, aggregate quota exhaustion, and concurrent create races.
- Add dedicated token/auth tampering live probes if that is part of the security acceptance bar.
