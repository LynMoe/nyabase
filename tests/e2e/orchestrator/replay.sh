#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

profile="${1:-${E2E_PROFILE:-smoke}}"
run_id="$(require_run_id "${2:-}")"
grep_arg="${3:-}"
validate_profile "$profile"
load_context "$run_id"
maybe_source_trust_token "$run_id"
maybe_source_cephfs_fixture "$E2E_RUNTIME_ROOT"
[[ "$E2E_PROFILE" == "$profile" ]] || die "context profile is $E2E_PROFILE, requested $profile"
require_control_plane_inputs "$profile"
[[ -f "$E2E_RUNTIME_ROOT/seed-state.json" && ! -L "$E2E_RUNTIME_ROOT/seed-state.json" ]] \
  || die "seed-state.json is missing; replay requires an existing up"
[[ -s "$E2E_RUNTIME_ROOT/control-plane.pid" ]] \
  || die "control-plane.pid is missing; replay requires a live control plane"
pid="$(tr -d '\n' < "$E2E_RUNTIME_ROOT/control-plane.pid")"
[[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null \
  || die "control plane pid $pid is not running; start-control-plane before replay"

if [[ -n "$grep_arg" ]]; then
  if [[ "$grep_arg" =~ ^[a-z0-9]+(-[a-z0-9]+)+$ ]]; then
    export E2E_GREP="@case-${grep_arg}"
  else
    export E2E_GREP="$grep_arg"
  fi
fi

export E2E_COVERAGE_RUN_NONCE="$(date -u +%s%N)-$BASHPID"

(
  cd "$E2E_ROOT"
  install -d -m 0700 "$E2E_RUNTIME_ROOT/reports" "$E2E_RUNTIME_ROOT/test-results"
  rm -f \
    "$E2E_RUNTIME_ROOT/coverage-case-events.jsonl" \
    "$E2E_RUNTIME_ROOT/coverage-http-events.jsonl" \
    "$E2E_RUNTIME_ROOT/reports/api-tests.json"
  printf '%s\n' "$E2E_RUN_ID:$E2E_COVERAGE_RUN_NONCE" \
    > "$E2E_RUNTIME_ROOT/coverage-run.marker"
  chmod 0600 "$E2E_RUNTIME_ROOT/coverage-run.marker"
  pnpm --dir e2e exec node coverage/validate.mjs "--require-profile=$profile"
  E2E_PROFILE="$profile" NODE_EXTRA_CA_CERTS="$E2E_EDGE_CA_FILE" \
    pnpm --dir e2e exec tsx run.mjs
)
node "$SCRIPT_DIR/evidence.mjs" "$E2E_RUNTIME_ROOT" "$profile" --allow-subset
record_phase "$run_id" replay passed "subset API replay passed for $profile"
log "replay $profile passed for $run_id${E2E_GREP:+ grep=$E2E_GREP}"
