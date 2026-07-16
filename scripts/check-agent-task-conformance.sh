#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "[agent-task] FAIL: $1" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "required file is missing: $1"
}

forbidden_path() {
  [[ ! -e "$1" ]] || fail "obsolete path still exists: $1"
}

no_match() {
  local label="$1"
  local pattern="$2"
  shift 2
  if rg -n --hidden --glob '!dist/**' --glob '!node_modules/**' "$pattern" "$@"; then
    fail "$label"
  fi
}

require_file docs/agent-task-execution.md
require_file packages/backend/src/entities/agent-task.entity.ts
require_file packages/backend/src/agent-tasks/agent-tasks.service.ts
require_file packages/backend/src/agent-tasks/agent-task-result.service.ts
require_file packages/backend/src/agent-tasks/agent-task-dispatcher.service.ts
require_file packages/agent/src/tasks/task-runner.ts
require_file packages/agent/src/tasks/task-handler.ts
require_file packages/frontend/src/hooks/use-agent-task-tracker.ts

forbidden_path packages/backend/src/entities/operation.entity.ts
forbidden_path packages/backend/src/entities/container-mount-runtime.entity.ts
forbidden_path packages/backend/src/operations
forbidden_path packages/backend/src/command-hooks
forbidden_path packages/agent/src/commands
forbidden_path packages/frontend/src/hooks/use-operation-tracker.ts
forbidden_path packages/frontend/e2e/operation-states.spec.ts
forbidden_path packages/frontend/e2e/__screenshots__/chromium/operation-states.spec.ts
forbidden_path packages/common/src/protocol/schema.ts
forbidden_path packages/agent/src/tasks/task-store.ts
forbidden_path packages/backend/dist/operations
forbidden_path packages/backend/dist/command-hooks
forbidden_path packages/backend/dist/entities/operation.entity.js
forbidden_path packages/agent/dist/commands

SOURCE_PATHS=(
  packages/common/src
  packages/backend/src
  packages/agent/src
  packages/frontend/src
)

no_match "obsolete execution model symbols remain" \
  'OperationAttempt|OperationStep|OperationCommand|WorkItem|WorkflowRun|AgentCommandKind|CommandHookName' \
  "${SOURCE_PATHS[@]}"
no_match "obsolete V6 protocol remains" \
  'command\.(dispatch|received|progress|result|cancel|cancelled).*v6|protocolVersion:[[:space:]]*6' \
  "${SOURCE_PATHS[@]}"
no_match "obsolete task commit protocol remains" \
  'task\.commit\.v1|TaskCommitPayload|zTaskCommitPayload' \
  "${SOURCE_PATHS[@]}"
no_match "obsolete coordination fields remain" \
  'fencingToken|leaseFencingToken|leaseOwner|leaseExpiresAt|effectKey|idempotencyKey|WaitingRetry|WaitingObservation|InterventionRequired|progressJson|resourceKeysJson|agentOutcome' \
  "${SOURCE_PATHS[@]}"
no_match "Agent durable recovery state remains" \
  'AgentTaskStore|stateDir|remote-fs-registry|recoverPersistedMounts|replayTerminal|saveCheckpoint|task\.commit\.v1|TaskCommitPayload|zTaskCommitPayload' \
  --glob '!**/*.test.ts' \
  packages/agent/src packages/agent/agent.yaml deploy/agent.example.yaml deploy/agent.systemd.service

# The one allowed durable Agent inode is a lock, never task/checkpoint state.
# Its stable pathname is required so an exec'd OS helper can fence a replacement
# Agent after the old Agent process itself has been SIGKILLed.
mapfile -t durable_agent_path_sources < <(
  rg -l '/var/lib/nyabase-agent' packages/agent/src --glob '!**/*.test.ts' | sort
)
[[ ${#durable_agent_path_sources[@]} -eq 1 \
  && "${durable_agent_path_sources[0]}" == 'packages/agent/src/physical-mutation-fence.ts' ]] \
  || fail "only physical-mutation-fence.ts may reference the durable Agent state directory"
rg -q "PHYSICAL_MUTATION_LOCK_PATH = '/var/lib/nyabase-agent/physical-mutation.lock'" \
  packages/agent/src/physical-mutation-fence.ts \
  || fail "stable physical mutation flock path is missing or changed"
no_match "physical mutation flock must not become replaceable durable state" \
  'fs\.(writeFile|appendFile|rename|unlink|rm)(Sync)?\(' \
  packages/agent/src/physical-mutation-fence.ts
no_match "Agent handler checkpoint contract remains" \
  'checkpoint[[:space:]]*\(' \
  --glob '!**/*.test.ts' \
  packages/agent/src/tasks
no_match "Backend finalizer failure can fabricate a terminal task" \
  'recordFinalizerFailure' \
  packages/backend/src/agent-tasks
no_match "obsolete public names remain" \
  'operationId|operationIds|activeOperation|lastOperation|/operations|admin/operations' \
  "${SOURCE_PATHS[@]}"

no_match "obsolete public names remain in live tests" \
  'operationId|operationIds|activeOperation|lastOperation|/operations|admin/operations' \
  test

mapfile -t migrations < <(find packages/backend/src/database/migrations -maxdepth 1 -type f -name '*.ts' | sort)
[[ ${#migrations[@]} -eq 1 ]] || fail "expected exactly one fresh baseline migration, found ${#migrations[@]}"
no_match "baseline contains obsolete coordination tables" \
  'operations|operation_steps|operation_attempts|operation_commands|operation_work_items|container_mount_runtime|progress_json|resource_keys_json|agent_outcome' \
  "${migrations[0]}"
rg -q 'CREATE TABLE "agent_tasks"' "${migrations[0]}" \
  || fail "baseline does not create agent_tasks"

if rg -n 'better-sqlite3' packages/agent/package.json; then
  fail "Agent still depends on better-sqlite3"
fi

if find packages/common/src -type f \
  \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) \
  -print -quit | grep -q .; then
  fail "packages/common/src contains generated artifacts"
fi

echo "[agent-task] conformance passed"
