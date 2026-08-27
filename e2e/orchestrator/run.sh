#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

profile="${1:-${E2E_PROFILE:-smoke}}"
run_id="$(require_run_id "${2:-}")"
validate_profile "$profile"
load_context "$run_id"
maybe_source_trust_token "$run_id"
maybe_source_cephfs_fixture "$E2E_RUNTIME_ROOT"
[[ "$E2E_PROFILE" == "$profile" ]] || die "context profile is $E2E_PROFILE, requested $profile"
require_control_plane_inputs "$profile"
[[ -f "$E2E_RUNTIME_ROOT/build.evidence" && ! -L "$E2E_RUNTIME_ROOT/build.evidence" ]] \
  || die "build evidence is missing for runId $run_id"
[[ -f "$E2E_RUNTIME_ROOT/control-plane-wiring.evidence" \
  && ! -L "$E2E_RUNTIME_ROOT/control-plane-wiring.evidence" ]] \
  || die "control-plane wiring evidence is missing for runId $run_id"
export E2E_COVERAGE_RUN_NONCE="$(date -u +%s%N)-$BASHPID"

(
  cd "$E2E_ROOT"
  install -d -m 0700 "$E2E_RUNTIME_ROOT/reports" "$E2E_RUNTIME_ROOT/test-results"
  rm -f \
    "$E2E_RUNTIME_ROOT/coverage-case-events.jsonl" \
    "$E2E_RUNTIME_ROOT/coverage-http-events.jsonl" \
    "$E2E_RUNTIME_ROOT/reports/playwright.json" \
    "$E2E_RUNTIME_ROOT/reports/junit.xml"
  printf '%s\n' "$E2E_RUN_ID:$E2E_COVERAGE_RUN_NONCE" \
    > "$E2E_RUNTIME_ROOT/coverage-run.marker"
  chmod 0600 "$E2E_RUNTIME_ROOT/coverage-run.marker"
  pnpm --dir e2e exec node coverage/validate.mjs "--require-profile=$profile"
  E2E_PROFILE="$profile" NODE_EXTRA_CA_CERTS="$E2E_EDGE_CA_FILE" \
    pnpm --dir e2e exec playwright test
)
node "$SCRIPT_DIR/evidence.mjs" "$E2E_RUNTIME_ROOT" "$profile"
record_phase "$run_id" run passed "Playwright runtime and post-run evidence passed for $profile"
log "profile $profile passed for $run_id"
