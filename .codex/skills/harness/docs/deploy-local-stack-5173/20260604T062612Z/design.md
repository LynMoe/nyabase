# Design

## Problem

The populated test/deploy SQLite database was behind the current backend entity
model, causing `500` responses for mount-source and container flows. After the
schema repair, container create still failed because the online agent reported a
terminal success without the `dockerId` required by backend domain completion.

## Decisions

1. Use migrations and a narrow DB hotfix for schema drift.
   - This keeps the populated test DB and avoids resetting user/test data.
   - `DB_SYNC=false` remains required for the existing DB.
2. Treat `commandAck` as the authoritative success result for container create
   when a terminal `operationProgress` frame lacks `dockerId`.
   - A success progress frame without `dockerId` is recorded as non-terminal
     running progress.
   - A later ack with `{ dockerId }` completes the operation normally.
   - Failed progress remains terminal failure.
3. Rebuild and redeploy the remote test agent binary.
   - The backend fix prevents the progress frame from prematurely failing the
     operation, but an old agent binary can still send a final ack without
     `dockerId`.
   - The remote CPU/GPU systemd agents must run the new `dist/nyabase-agent`.

## File-Level Plan

- `packages/backend/src/operations/operation-orchestrator.service.ts`
  - Factor non-terminal progress updates.
  - Defer container-create success progress without `dockerId`.
- `packages/backend/src/operations/__tests__/operations.service.test.ts`
  - Add regression coverage for success progress without `dockerId` followed by
    an ack that supplies `dockerId`.
- Generated runtime outputs after build/deploy:
  - `packages/backend/dist/**`
  - `packages/agent/dist/**`
  - `dist/nyabase-agent`

## Risks

- If a remote agent is not redeployed, create can still fail at final ack with
  `createContainer result did not include dockerId`.
- Smoke creates can leave Docker or DB residue if cleanup is interrupted; smoke
  names must use a unique `codexfix-*` prefix and be checked afterward.
