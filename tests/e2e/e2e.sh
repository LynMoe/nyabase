#!/usr/bin/env bash
# Live lab e2e: `up` builds and starts an isolated control plane and registers
# the lab hosts, `run` executes the scenarios, `down` removes everything the run
# created. See tests/e2e/README.md.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
# shellcheck source=lib/common.sh
source "$E2E_DIR/lib/common.sh"
# shellcheck source=lib/up.sh
source "$E2E_DIR/lib/up.sh"
# shellcheck source=lib/down.sh
source "$E2E_DIR/lib/down.sh"

cmd_run() {
  load_lab
  select_run "" || die "no run found: \`bash tests/e2e/e2e.sh up\` first"
  [[ -f "$RUN_DIR/state.json" ]] || die "run $RUN_ID has no state.json: its \`up\` did not finish"
  run_owns_pid "$RUN_DIR/backend.pid" || die "the backend of run $RUN_ID is not running"
  # Optional filters: `run 04 lapse` runs the scenario files whose name contains any word.
  local files=() file word
  for file in "$E2E_DIR"/scenarios/*.test.ts; do
    if [[ $# -eq 0 ]]; then
      files+=("$file")
      continue
    fi
    for word in "$@"; do
      [[ "$(basename "$file")" == *"$word"* ]] && { files+=("$file"); break; }
    done
  done
  [[ ${#files[@]} -gt 0 ]] || die "no scenario matches: $*"
  cd "$E2E_DIR"
  E2E_RUN_DIR="$RUN_DIR" exec node --import tsx --test --test-concurrency=1 "${files[@]}"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  run) shift; cmd_run "$@" ;;
  down) shift; cmd_down "$@" ;;
  *)
    echo "usage: bash tests/e2e/e2e.sh up | run [scenario-word...] | down [run-id]" >&2
    exit 2
    ;;
esac
