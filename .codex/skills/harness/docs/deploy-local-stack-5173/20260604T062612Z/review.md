# Review

## Scope

Run-only local deployment task. No product source, test source, package manifest, or lockfile changes were made.

## Checks

- Requirements recorded: pass.
- Frontend bound to requested port `5173`: pass.
- Backend reachable on `3001`: pass.
- VictoriaMetrics reachable on `8428`: pass.
- `packages/common/src/**` generated artifact guard: pass.

## Disposition

PASS. Local frontend and backend are running from the current workspace contents.

## Follow-up Disposition

PASS after correction. The original run used the empty dev database
`/tmp/nyabase-dev.db`, which explained the missing server list. Backend was
restarted against the test/deploy database from `test/.env`:

```text
/mnt/nyabase-data/docker/volumes/deploy_backend-data/_data/nyabase.db
```

The existing populated DB is now used with `DB_SYNC=false`. Admin API
verification returned four servers, including the CPU/GPU batch servers that are
currently online.

## Follow-up Review: API 500 and container operations

Findings:

- No blocking issues found in the backend progress/ack change.
- The previous `/api/mount-sources` and related `500` responses were caused by
  test/deploy DB schema drift and are repaired.
- The later container-create failure had two layers:
  1. Backend `operationProgress` handling treated a `succeeded` progress frame
     without `dockerId` as authoritative success and threw.
  2. Remote CPU/GPU agents were still running an old standalone binary, so final
     create ack also lacked the required `dockerId`.
- Both layers are now addressed:
  - Backend defers container-create success progress without `dockerId` until
    `commandAck`.
  - Remote CPU/GPU agents were rebuilt, redeployed, and restarted from the
    current workspace binary.

DoD:

- Requirements/design/implementation/test records: pass.
- Targeted backend regression test: pass.
- `pnpm build`: pass.
- `bash scripts/build-agent-binary.sh`: pass.
- `bash scripts/check.sh`: pass.
- Frontend visual test: skipped, backend/agent only; no rendered frontend output changed.
- `packages/common/src/**` generated artifact guard: pass.
- Runtime verification:
  - `/api/mount-sources` and related endpoints return `200`.
  - Container start operation succeeds.
  - Container create operation succeeds with non-empty `dockerId`.
  - Smoke container delete operation succeeds.
  - Smoke DB and Docker cleanup verified.

Disposition:

PASS. Local frontend/backend remain running on `5173`/`3001`, the populated
test/deploy DB is in use, remote test agents are updated, and the reported
container/mount-source failure path is repaired.

Residual risk:

- Backend logs still contain repeated state-report warnings for unknown
  historical numeric user IDs and duplicate data-disk runtime observations.
  These did not block the requested APIs or container operations and were not in
  scope for this repair.
