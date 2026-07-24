#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"
load_run "$run_id"
export_compose_state

diagnostics="$NYABASE_E2E_RUNTIME_DIR/diagnostics"
install -d -m 0700 "$diagnostics"
capture_diagnostic() {
  node "$E2E_ROOT/e2e/orchestrator/capture-diagnostic.mjs" \
    "$NYABASE_E2E_RUNTIME_DIR" "$1"
}

if [[ -s "$NYABASE_E2E_RUNTIME_DIR/compose.env" ]]; then
  validate_compose_state
  NYABASE_E2E_COMMAND_TIMEOUT_SECONDS=30 \
    docker_compose_for_run ps --all --format json 2>&1 \
    | capture_diagnostic compose-ps.json || true
  # Every service belongs to this exact run-scoped Compose project, so its
  # log stream preserves both the first transport failure and final state in a
  # bounded head/tail artifact; the producer itself also has a hard deadline.
  NYABASE_E2E_COMMAND_TIMEOUT_SECONDS=30 \
    docker_compose_for_run logs --no-color 2>&1 \
    | capture_diagnostic control-plane.log || true
fi

for node_key in node1 node2; do
  name="$NYABASE_E2E_PREFIX-$node_key"
  timeout --signal=TERM --kill-after=5s 30s docker inspect "$name" 2>&1 \
    | capture_diagnostic "${node_key}-inspect.json" || true
  # The node container is created for this run and destroyed by exact-run
  # cleanup. Journal head/tail retains the initiating Agent error and reconnect
  # state without allowing a storm to grow the artifact without bound.
  timeout --signal=TERM --kill-after=5s 30s \
    docker exec "$name" journalctl --no-pager \
      -u nyabase-agent.service -u nyabase-docker.service 2>&1 \
    | capture_diagnostic "${node_key}-journal.log" || true
  timeout --signal=TERM --kill-after=5s 30s docker exec "$name" findmnt -J 2>&1 \
    | capture_diagnostic "${node_key}-mounts.json" || true
  timeout --signal=TERM --kill-after=5s 30s \
    docker exec "$name" docker -H unix:///run/nyabase-agent/docker.sock info 2>&1 \
    | capture_diagnostic "${node_key}-docker-info.txt" || true
done

chmod -R go-rwx "$diagnostics"
log "redacted diagnostics captured under $diagnostics"
