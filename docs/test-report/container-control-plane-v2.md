# Container Control Plane V2 Test Report

Date: 2026-06-05
Scope: hard incompatible V2 cutover against `docs/container-control-plane-redesign.md`.

## Design / Implementation Contract

Authoritative design document:

- `docs/container-control-plane-redesign.md`

Key acceptance requirements verified:

- Old `{serverId, containerId}` public route identity removed.
- Public/container test identity no longer uses Docker ID or `spec.dockerId`.
- Old agent command names removed.
- Container mutations use V2 operation/action flow.
- Frontend/tests use `ContainerView`/backend actions rather than old route or Docker identity assumptions.
- Runtime orphan persistence is idempotent under repeated observations.
- No generated artifacts under `packages/common/src/**`.

## Static / Unit / Functional Verification

Commands run from `/root/nyabase`:

```bash
pnpm typecheck
```

Result: passed for common/backend/agent/frontend.

```bash
pnpm test:unit
```

Result:

- common: 3 files, 47 tests passed
- backend: 20 files, 102 tests passed
- agent: 5 files, 69 tests passed

```bash
pnpm test:functional
```

Result: Passed 25, Failed 0, Skipped 0.

```bash
bash scripts/check.sh
```

Result: passed; lint reported warnings only, 0 errors.

```bash
pnpm run check:control-plane-redesign
```

Result: conformance passed, including checks for old routes, old command names, legacy labels, `spec.dockerId`, old direct route suffixes, and common artifact guard.

```bash
find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort
```

Result: no output.

## Live Verification

Live environment was reset/restarted by the developer lane, then the lead re-ran final live acceptance on the current worktree.

Final live fixture manifest:

- `test/runtime/murt/current.env`
- latest coord dir: `test/runtime/murt/20260604t174938z-e260e0`

Commands and results:

```bash
bash test/scripts/run-live-suite.sh smoke
```

Result: `OK`; `admin login OK`.

```bash
bash test/scripts/run-live-suite.sh admin-setup
```

Result: 1 file passed, 1 test passed; wrote `test/runtime/murt/current.env`.

```bash
bash test/scripts/run-live-suite.sh personas
```

Result: 6 files passed, 6 tests passed.

Covered persona flows:

- epsilon no-access denial surface
- gamma/delta isolation by containerId-only route
- gamma GPU persona create/metrics non-leak path
- delta CPU/optional-GPU create/delete via operation actions
- beta serialized mutations through operation polling
- alpha active CPU lifecycle, backend actions, stats/power/delete operations, GPU denial

```bash
bash test/scripts/run-live-suite.sh continuation
```

Result: 1 file passed, 1 test passed.

## Runtime / Residue Checks

No hung `run-live-suite` or `vitest` processes were present after final live runs.

Backend critical-log scan after final live runs:

```bash
grep -E 'UNIQUE constraint|savepoint|ERROR|dockerId|sshEnabled|ContainerEntity' test/runtime/logs/backend.log
```

Result: no matching critical entries.

Additional source scans for old route identity, old command names, `spec.dockerId`, old `ContainerEntity` docker/ssh queries, frontend metrics Docker ID, and direct old live endpoint suffixes returned no product/test matches outside the conformance script assertions.

## Conclusion

The V2 control-plane redesign is implemented and verified against the current worktree. The old public route/command/Docker-ID identity chain is removed by conformance checks and source scans, and live admin/persona/continuation flows pass using V2 operation/action semantics.
