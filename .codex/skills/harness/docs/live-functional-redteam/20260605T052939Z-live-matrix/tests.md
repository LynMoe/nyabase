# Red-Team Live Test Report

## Runtime Fingerprint

- Backend PID from `test/runtime/logs/backend.pid` was alive; `/api/auth/me` returned `401`.
- Frontend PID from `test/runtime/logs/frontend.pid` was alive; `/` returned `200`.
- VictoriaMetrics `http://127.0.0.1:8428/health` returned `OK`.
- Shared DB present: `test/runtime/db/nyabase-test.db`.
- Agent metadata present: `test/runtime/agents/servers.json`.
- No alternate backend/frontend instance was started.

## Commands

```bash
bash test/scripts/run-live-suite.sh smoke
bash test/scripts/run-live-suite.sh admin-setup
bash test/scripts/run-live-suite.sh personas
bash test/scripts/run-live-suite.sh continuation
node test/scripts/create-mount-fixture.mjs
bash test/scripts/run-live-suite.sh mounts
bash test/scripts/run-live-suite.sh dropbear
```

## Results

| Area | Existing coverage used | Result |
| --- | --- | --- |
| Readiness | `smoke` | Passed: auth readiness, frontend, VM health, admin login. |
| Admin fixture | `multi-user-redteam-admin-setup.spec.ts` | Passed: created 5 personas, CPU/GPU grants, image grants, mount-source grants, and quotas. |
| Lifecycle continuation | `multi-user-redteam-continuation.spec.ts` | Passed: alpha create/restart/delete through operation/action path. |
| Persona lifecycle | `alpha`, `beta`, `gamma`, `delta` specs | Passed: create, stats, stop/start/restart/delete; CPU/GPU grant boundaries exercised. |
| Cross-user lifecycle attack | `multi-user-redteam-gamma-delta-attack.spec.ts` inside `personas` | Passed: delta could not read stats, stop, or delete gamma container by guessed container ID; denial was `403/404`. |
| No-access persona | `multi-user-redteam-epsilon.spec.ts` | Mixed: unauthorized container create denied (`403/404` allowed by spec); `/users` returned `404` while spec expected exactly `403`. No privilege escalation observed. |
| Mount red-team matrix | `multi-user-redteam-mount-sources.spec.ts` | Passed: 82 report entries, unauthorized local/remote source use denied, cross-user data-dir delete denied, dynamic mount add/remove worked, final residuals zero. |
| SSH / Dropbear | `dropbear-live-runtime.spec.ts` | Passed: non-admin SSH enablement, isolation, repair, key sync, lifecycle, cleanup. |

## Fixture Summary

Multi-user fixture:

- State: `test/runtime/murt/20260605t053259z-9c42ff/state.json`
- Run prefix: `murt-20260605t053259z-9c42ff`
- Status: `pass`
- Servers: CPU and GPU available.
- Users:
  - `alpha`: CPU, `cpuA`, local mount.
  - `beta`: CPU, `cpuB`, remote mount.
  - `gamma`: GPU index 0, `gpuA`.
  - `delta`: CPU plus GPU index 1, `cpuA` plus `gpuA`, local plus remote mount.
  - `epsilon`: no server grants, inactive image only.
- Setup gaps: none.

Mount fixture:

- State: `test/runtime/mount/20260605t053331z-1d1805/state.json`
- Report MD: `test/runtime/mount/20260605t053331z-1d1805/mount-runtime-report.md`
- Report JSON: `test/runtime/mount/20260605t053331z-1d1805/mount-runtime-report.json`
- Status: `pass`
- Created/deleted: 6 containers and 5 data dirs.
- Final residuals: zero containers and zero data dirs for alpha-local, beta-remote, and delta-both.

Dropbear:

- Redacted report MD: `test/runtime/dropbear/20260605t053305z-33e6e4/dropbear-live-report.redacted.md`
- Redacted report JSON: `test/runtime/dropbear/20260605t053305z-33e6e4/dropbear-live-report.redacted.json`
- Status: `pass`
- Failures: none.

## Expected Denial Behavior Observed

- Unauthorized GPU create by alpha was denied with an accepted `403/404`.
- Epsilon no-access container create was denied with an accepted `403/404`.
- Delta cross-user access/mutation against gamma container returned accepted `403/404` on detail, stats, stop, and delete.
- Alpha/beta unauthorized mount source visibility excluded ungranted sources, and unauthorized data-dir/container mount creation returned deny statuses.
- Delta cross-user delete guesses against alpha/beta data dirs were denied/not found.
- Ordinary persona logins had no management capabilities in mount matrix checks.

## Cleanup Status

- Mount matrix reported zero final residual containers/data dirs for all mount personas.
- Dropbear report recorded cleanup of grants, image rows, users, temp SSH key files, and prior-prefix scans with zero residuals.
- Persona lifecycle specs delete containers they create through operation/action paths.

## Residual Risk

- `/users` returned `404` rather than the epsilon spec's exact expected `403`. This is not an observed access bypass, but the test expectation and API surface behavior should be reconciled: either use the actual admin route in the test, or accept `404` as intentional non-disclosure denial.
- Token/auth tampering was not found as a dedicated existing live negative spec beyond missing/ordinary auth boundaries in helpers; no custom token tampering probes were added because the instruction prioritized existing helpers/specs.
