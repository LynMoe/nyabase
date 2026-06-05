# Test Record

## Scope

Backend-only tester dispatch for systemic control-plane fixes. Product source was not edited.

Test files updated:

- `packages/backend/src/containers/__tests__/container-read-model.service.test.ts`
- `packages/backend/src/containers/__tests__/containers.service.read-path.test.ts`
- `packages/backend/src/containers/__tests__/container-create-durable.test.ts`
- `packages/backend/src/gateway/__tests__/state-cache.test.ts`
- `packages/backend/src/operations/__tests__/operations.service.test.ts`

Visual artifacts: n/a (backend-only change; no rendered frontend output or Playwright baselines changed).

## Commands

### Repository hard gate

Command:

```bash
bash scripts/check.sh
```

Outcome:

```text
Exit code: 0
Common-src artifact guard: pass (no generated .js/.js.map/.d.ts/.d.ts.map files under packages/common/src)
Common build: pass
Backend typecheck: pass
Backend lint: pass (0 errors; 12 warnings across workspace lint)
Backend tests: 276 passed / 0 failed / 0 skipped
Frontend typecheck: pass
Frontend lint: pass (0 errors; 12 warnings across workspace lint)
Frontend tests: 0 passed / 0 failed / 0 skipped (not run by scripts/check.sh; no frontend unit script is included in root test:unit)
Frontend visual: skipped (scripts/check.sh was run without --with-visual)
Visual report path: packages/frontend/e2e/.html-report/index.html
Visual diff artifacts: none
```

Unit test package counts from the hard gate:

```text
@nyabase/common: 47 passed / 0 failed / 0 skipped
@nyabase/backend: 158 passed / 0 failed / 0 skipped
@nyabase/agent: 71 passed / 0 failed / 0 skipped
```

Failing output: none.

### Focused edited suites

Command:

```bash
pnpm --filter @nyabase/backend exec vitest run src/containers/__tests__/container-read-model.service.test.ts src/containers/__tests__/containers.service.read-path.test.ts src/containers/__tests__/container-create-durable.test.ts src/gateway/__tests__/state-cache.test.ts src/operations/__tests__/operations.service.test.ts
```

Outcome:

```text
Test Files  5 passed (5)
Tests       40 passed (40)
Duration    774ms
```

### Relevant backend unit suites

Command:

```bash
pnpm --filter @nyabase/backend exec vitest run src/containers/__tests__/container-read-model.service.test.ts src/containers/__tests__/container-create-durable.test.ts src/containers/__tests__/containers.service.read-path.test.ts src/containers/__tests__/resource-quota.policy.test.ts src/gateway/__tests__/state-cache.test.ts src/operations/__tests__/operations.service.test.ts src/operations/__tests__/reconcile-task-worker.service.test.ts
```

Outcome:

```text
Test Files  7 passed (7)
Tests       70 passed (70)
Duration    788ms
```

Observed warnings were expected worker log lines from the new repair tests:

```text
[AgentCommandOutboxWorkerService] repaired 1 terminal outbox/operation status drift row(s)
```

## Acceptance Criteria Coverage

- AC #1: Container list/detail DTOs omit `operation` when only terminal/historical operation rows exist.
  Covered by `packages/backend/src/containers/__tests__/container-read-model.service.test.ts::keeps terminal operation history out of activeOperation` and `packages/backend/src/containers/__tests__/containers.service.read-path.test.ts::omits list and detail operation DTOs when only terminal history exists`.

- AC #2: If a real non-terminal operation exists, the read model exposes the newest relevant active operation.
  Covered by `packages/backend/src/containers/__tests__/container-read-model.service.test.ts::exposes a non-terminal active operation separately from newer terminal history` and `::prefers container-id active operations and falls back to docker-id only when none exist`.

- AC #3: Clear outbox/operation status drift is boundedly repaired where terminal outbox commands link to non-terminal operations.
  Covered by `packages/backend/src/operations/__tests__/operations.service.test.ts::repairs terminal outbox command status drift on linked non-terminal operations`, `::repairs failed terminal outbox drift without mutating unrelated terminal operations`, and `::serializes resource execution with DB locks, retries transient delivery, and recovers stale command leases`.

- AC #4: GPU auto-pick never returns an index outside actual server inventory from agent hello/`StateCache`.
  Covered by `packages/backend/src/gateway/__tests__/state-cache.test.ts::bounds GPU load maps and picks to actual inventory` and `packages/backend/src/containers/__tests__/container-create-durable.test.ts::auto-picks only real inventory GPUs on a 4-GPU host and allows sharing`.

- AC #5: On inventory `[0,1,2,3]`, create/restart-like paths cannot produce `gpuIndices: [4,5]`.
  Covered by `packages/backend/src/containers/__tests__/container-create-durable.test.ts::auto-picks only real inventory GPUs on a 4-GPU host and allows sharing`; restart/power operations do not allocate GPU indices and existing dispatch coverage remains in `container-operations-dispatch.test.ts`.

- AC #6: Auto GPU allocation allows sharing/reuse of real GPU indices and load-balances by current container count rather than desired-state exclusivity.
  Covered by `packages/backend/src/containers/__tests__/container-create-durable.test.ts::auto-picks only real inventory GPUs on a 4-GPU host and allows sharing`, `::load-balances auto-pick within granted indices intersected with inventory`, and `packages/backend/src/gateway/__tests__/state-cache.test.ts::bounds GPU load maps and picks to actual inventory`.

- AC #7: Explicit GPU indices are rejected when duplicated, outside grant, or outside actual inventory.
  Covered by `packages/backend/src/containers/__tests__/container-create-durable.test.ts::rejects explicit GPU indices when duplicated, outside grant, or outside inventory`.

- AC #8: GPU request with missing/empty inventory fails clearly instead of falling back to hard-coded indices.
  Covered by `packages/backend/src/containers/__tests__/container-create-durable.test.ts::fails GPU requests clearly when inventory is missing or empty`.

## Failures

None.

## Counts

Final relevant run: 70 passed / 0 failed / 0 skipped.

## Verdict

PASS.
