#!/usr/bin/env bash
set -euo pipefail
umask 077

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

(( $# <= 1 )) || die "release accepts at most one baseRunId"
base="${1:-full-release-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 2)}"
first="${base}-a"
second="${base}-b"
recovery="${base}-recovery"
validate_run_id "$first"
validate_run_id "$second"
validate_run_id "$recovery"

install -d -m 0700 "$E2E_RUNTIME_BASE"
run_full_chain invalidate

set +e
"$E2E_ROOT/e2e/orchestrator/run.sh" full "$first"
first_status=$?
set -e
if ((first_status != 75)); then
  die "first cold Full run must finish as candidate exit 75, got $first_status"
fi
first_candidate_sha256="$(
  run_full_chain verify-candidate "$(runtime_dir_for "$first")" "$first"
)"
[[ "$first_candidate_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || die "verified Full A candidate did not return an exact receipt SHA-256"

set +e
"$E2E_ROOT/e2e/orchestrator/run.sh" full "$second" \
  "$first" "$first_candidate_sha256"
second_status=$?
set -e
if ((second_status != 0)); then
  die "second cold Full run must finish as release closure exit 0, got $second_status"
fi

set +e
"$E2E_ROOT/e2e/orchestrator/run.sh" recovery "$recovery"
recovery_status=$?
set -e
if ((recovery_status != 0)); then
  die "Recovery run must finish as release closure exit 0, got $recovery_status"
fi

node "$E2E_ROOT/e2e/orchestrator/release-proof.mjs" create \
  "$base" "$first" "$second" "$recovery" \
  "$first_status" "$second_status" "$recovery_status"
log "Full A + Full B + Recovery release PASS: first=$first second=$second recovery=$recovery"
