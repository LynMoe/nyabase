#!/usr/bin/env bash
set -euo pipefail
umask 077

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

(( $# <= 4 )) || die "run accepts profile, runId, and one optional expected-predecessor pair"
profile="${1:-smoke}"
validate_profile "$profile"
export NYABASE_E2E_PROFILE="$profile"
run_id="$(resolve_run_id "${2:-}")"
expected_predecessor_run_id="${3:-}"
expected_predecessor_receipt_sha256="${4:-}"
if [[ -n "$expected_predecessor_run_id" || -n "$expected_predecessor_receipt_sha256" ]]; then
  [[ "$profile" == full ]] \
    || die "an expected Full predecessor is valid only for the full profile"
  [[ -n "$expected_predecessor_run_id" && -n "$expected_predecessor_receipt_sha256" ]] \
    || die "expected Full predecessor runId and receipt SHA-256 must be supplied together"
  validate_run_id "$expected_predecessor_run_id"
  [[ "$expected_predecessor_receipt_sha256" =~ ^[0-9a-f]{64}$ ]] \
    || die "expected Full predecessor receipt must be a SHA-256 digest"
fi

# Fail unsupported profiles before doctor/build/up can mutate Docker or create
# run-scoped state. The same profile contract is loaded again by Playwright.
"$E2E_ROOT/e2e/orchestrator/preflight.sh" "$profile"

cleanup_complete=false
playwright_started=false
finished=false
finish() {
  local incoming=$?
  if [[ "$finished" == true ]]; then
    return
  fi
  finished=true
  trap - EXIT INT TERM HUP
  local fallback_cleanup_status=0
  local artifacts_safe=true
  local runtime_dir
  runtime_dir="$(runtime_dir_for "$run_id")"
  if [[ "$cleanup_complete" != true && -s "$(runtime_dir_for "$run_id")/state.env" ]]; then
    if ((incoming != 0)); then
      # Failure evidence is handled in this exact order. Every fallible step is
      # status-captured so normalization or audit failure cannot skip the
      # independent audit or exact-run teardown. Unsafe evidence is purged only
      # after teardown has had its chance to use the run manifest.
      "$E2E_ROOT/e2e/orchestrator/diagnose.sh" "$run_id" >/dev/null 2>&1 || true
      if [[ "$playwright_started" == true ]]; then
        local normalization_status=0
        node "$E2E_ROOT/e2e/orchestrator/sanitize-playwright-artifacts.mjs" \
          "$runtime_dir" || normalization_status=$?
        if ((normalization_status != 0)); then
          artifacts_safe=false
          log "failure artifact normalization FAILED: runId=$run_id status=$normalization_status"
        fi
      fi
      local audit_status=0
      if [[ "$playwright_started" == true ]]; then
        node "$E2E_ROOT/e2e/orchestrator/audit-artifacts.mjs" \
          "$runtime_dir" || audit_status=$?
      else
        node "$E2E_ROOT/e2e/orchestrator/audit-artifacts.mjs" \
          "$runtime_dir" --startup-failure || audit_status=$?
      fi
      if ((audit_status != 0)); then
        artifacts_safe=false
      fi
    fi
    "$E2E_ROOT/e2e/orchestrator/down.sh" "$run_id" --keep-runtime \
      || fallback_cleanup_status=$?
  fi
  if [[ "$artifacts_safe" != true ]]; then
    rm -rf "$runtime_dir"
    log "unsafe failure artifacts were purged after scoped teardown"
  fi
  if ((fallback_cleanup_status != 0)); then
    exit "$fallback_cleanup_status"
  fi
  exit "$incoming"
}
trap finish EXIT
trap 'exit 130' INT TERM HUP

"$E2E_ROOT/e2e/orchestrator/doctor.sh" "$run_id"
if [[ "$profile" == full ]]; then
  # Reserve this run's isolated slot before recording the Full attempt. A
  # failed build/up/test then leaves an active chain marker, so the next Full
  # run cannot skip over it and claim to be consecutive.
  initialize_run "$run_id"
  run_full_chain begin "$NYABASE_E2E_RUNTIME_DIR" "$run_id" \
    "$expected_predecessor_run_id" "$expected_predecessor_receipt_sha256"
fi
"$E2E_ROOT/e2e/orchestrator/build.sh" "$run_id"
NYABASE_E2E_PARENT_OWNS_CLEANUP=true \
  "$E2E_ROOT/e2e/orchestrator/up.sh" "$run_id"
load_run "$run_id"

# shellcheck disable=SC1090
source "$NYABASE_E2E_RUNTIME_DIR/secrets.env"
export E2E_PROFILE="$profile"
export E2E_BASE_URL="$NYABASE_E2E_PUBLIC_URL"
export E2E_RATE_LIMIT_BASE_URL="$NYABASE_E2E_RATE_LIMIT_PUBLIC_URL"
export E2E_RUN_ID="$run_id"
export E2E_ADMIN_USERNAME=admin
export E2E_ADMIN_PASSWORD="$ADMIN_INIT_PASSWORD"
export E2E_RESOURCE_MANIFEST="$NYABASE_E2E_RUNTIME_DIR/manifest.json"
export E2E_SEED_STATE="$NYABASE_E2E_RUNTIME_DIR/seed.json"
export E2E_RUNTIME_ROOT="$NYABASE_E2E_RUNTIME_DIR"
export E2E_EDGE_SPKI="$(tr -d '\n' < "$NYABASE_E2E_RUNTIME_DIR/certs/edge.spki")"
export NODE_EXTRA_CA_CERTS="$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt"
if [[ "$profile" == full ]]; then
  export E2E_NFS_FIXTURE="$NYABASE_E2E_RUNTIME_DIR/storage/nfs-fixture.json"
  export E2E_CEPHFS_FIXTURE="$NYABASE_E2E_RUNTIME_DIR/storage/cephfs-fixture.json"
elif [[ "$profile" == recovery ]]; then
  export E2E_RECOVERY_PROOF="$NYABASE_E2E_RUNTIME_DIR/recovery-proof.json"
fi
install -d -m 0700 "$NYABASE_E2E_RUNTIME_DIR/reports"
rm -f \
  "$NYABASE_E2E_RUNTIME_DIR/coverage-case-events.jsonl" \
  "$NYABASE_E2E_RUNTIME_DIR/coverage-http-events.jsonl" \
  "$NYABASE_E2E_RUNTIME_DIR/coverage-event-seal.json" \
  "$NYABASE_E2E_RUNTIME_DIR/coverage-evidence.json" \
  "$NYABASE_E2E_RUNTIME_DIR/probe-evidence.json" \
  "$NYABASE_E2E_RUNTIME_DIR/artifact-audit.json"
node "$E2E_ROOT/e2e/orchestrator/fixture-evidence.mjs" emit \
  "$NYABASE_E2E_RUNTIME_DIR" "$profile"

playwright_started=true
set +e
bash "$E2E_ROOT/e2e/orchestrator/run-playwright-safe.sh" \
  pnpm --dir "$E2E_ROOT" --filter @nyabase/e2e run "test:$profile"
test_status=$?
set -e

if ((test_status != 0)); then
  manifest_phase tests_failed "profile=$profile status=$test_status" || true
  exit "$test_status"
fi

# A successful test run is normalized before any live success probe. Failure
# runs are normalized in the EXIT lifecycle after diagnostics are captured, so
# their exact sequence is diagnose -> sanitize -> audit -> scoped down.
node "$E2E_ROOT/e2e/orchestrator/sanitize-playwright-artifacts.mjs" \
  "$NYABASE_E2E_RUNTIME_DIR"
manifest_phase tests_passed "profile=$profile"

# These probes require the live stack and its per-run credentials. They run
# only after an all-tests Playwright PASS and before teardown. Failure paths
# independently audit reports plus diagnostics in the EXIT trap and purge the
# complete retained runtime directory if any credential is detected.
"$E2E_ROOT/e2e/orchestrator/health.sh" "$run_id"
node "$E2E_ROOT/e2e/orchestrator/capture-probe-evidence.mjs" \
  "$NYABASE_E2E_RUNTIME_DIR"
node "$E2E_ROOT/e2e/orchestrator/audit-artifacts.mjs" \
  "$NYABASE_E2E_RUNTIME_DIR"
node "$E2E_ROOT/e2e/orchestrator/coverage-evidence.mjs" prepare \
  "$NYABASE_E2E_RUNTIME_DIR" "$profile" "$run_id"

# Post-down cleanup is part of acceptance. Keep only redacted runtime evidence
# so the generator can bind the clean manifest to the same build and report.
set +e
"$E2E_ROOT/e2e/orchestrator/down.sh" "$run_id" --keep-runtime
cleanup_status=$?
set -e
if ((cleanup_status != 0)); then
  exit "$cleanup_status"
fi
cleanup_complete=true

# Do not retain per-run credentials in the runner process after teardown.
unset \
  ADMIN_INIT_PASSWORD JWT_SECRET HTTP_PROXY_TOKEN SSH_PROXY_TOKEN SSH_KEY_SECRET \
  CEPH_CLIENT_SECRET E2E_ADMIN_PASSWORD E2E_EDGE_SPKI E2E_NFS_FIXTURE \
  E2E_CEPHFS_FIXTURE E2E_RECOVERY_PROOF E2E_RATE_LIMIT_BASE_URL NODE_EXTRA_CA_CERTS

export E2E_COVERAGE_EVIDENCE="$NYABASE_E2E_RUNTIME_DIR/coverage-evidence.json"
node "$E2E_ROOT/e2e/orchestrator/coverage-evidence.mjs" finalize \
  "$NYABASE_E2E_RUNTIME_DIR" "$profile" "$run_id"
if [[ "$profile" == full ]]; then
  set +e
  run_full_chain complete "$NYABASE_E2E_RUNTIME_DIR" "$run_id"
  chain_status=$?
  set -e
  if ((chain_status == 75)); then
    log "run CANDIDATE ONLY: profile=full runId=$run_id; one more consecutive cold Full run is required"
    exit 75
  fi
  if ((chain_status != 0)); then
    exit "$chain_status"
  fi
else
  pnpm --dir "$E2E_ROOT" --filter @nyabase/e2e run "verify:$profile"
fi

trap - EXIT INT TERM HUP
log "run PASS: profile=$profile runId=$run_id, Playwright/evidence/cleanup coverage verified"
