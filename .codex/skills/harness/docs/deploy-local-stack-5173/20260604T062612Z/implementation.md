# Implementation

## Product Changes

- `packages/backend/src/operations/operation-orchestrator.service.ts`
  - Added `recordNonTerminalProgress()` to share running/accepted progress
    updates.
  - Added `shouldWaitForCommandAck()` for operation-specific terminal progress
    validation.
  - Container create now waits for `commandAck` when a `succeeded`
    `operationProgress` frame does not include `dockerId`.

- `packages/backend/src/operations/__tests__/operations.service.test.ts`
  - Added a regression test where container create receives success progress
    without `dockerId`, remains non-terminal, then completes successfully when
    ack supplies `{ dockerId, ip }`.

## Build / Deploy Outputs

- Ran `pnpm build`, updating backend and agent `dist` outputs from current
  source.
- Ran `bash scripts/build-agent-binary.sh`, updating:
  - `dist/nyabase-agent`
- Redeployed the new binary to:
  - CPU agent: `root@10.8.96.91:/usr/local/bin/nyabase-agent`
  - GPU agent: `lyn@10.8.1.12:/usr/local/bin/nyabase-agent`
- Restarted both remote `nyabase-agent` services and their managed
  `nyabase-docker.service` instances.
- Restarted local backend tmux session `nyabase-backend-testdb-3001` on port
  `3001` against the populated test/deploy DB with `DB_SYNC=false`.

## Notes

- A transient manual `nyabase-agent --version` check started a foreground CPU
  agent because the binary has no version flag. The SSH process was killed and
  the CPU systemd agent was restarted to restore a single active agent instance.
- No files were generated under `packages/common/src/**`.
