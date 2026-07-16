#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${NYABASE_TEST_ENV_FILE:-test/config/local.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

mkdir -p test/runtime/logs

suite="${1:-api}"

run_optional_node_script() {
  local label="$1"
  local script="$2"
  shift 2

  if [[ ! -f "$script" ]]; then
    echo "SKIP: optional live suite '$label' is unavailable; missing $script" >&2
    return 0
  fi

  node "$script" "$@"
}

run_optional_specs() {
  local label="$1"
  shift
  local specs=()
  local spec

  for spec in "$@"; do
    if [[ -f "$spec" ]]; then
      specs+=("$spec")
    else
      echo "SKIP: optional live spec for '$label' is unavailable; missing $spec" >&2
    fi
  done

  if [[ "${#specs[@]}" -eq 0 ]]; then
    echo "SKIP: optional live suite '$label' has no runnable specs" >&2
    return 0
  fi

  pnpm exec vitest run "${specs[@]}"
}

case "$suite" in
  api|all|full)
    node test/scripts/run-live-api-suite.mjs
    ;;
  admin-setup)
    run_optional_specs "$suite" test/specs/live/multi-user-redteam-admin-setup.spec.ts
    ;;
  personas)
    run_optional_specs "$suite" \
      test/specs/live/multi-user-redteam-alpha.spec.ts \
      test/specs/live/multi-user-redteam-beta.spec.ts \
      test/specs/live/multi-user-redteam-gamma.spec.ts \
      test/specs/live/multi-user-redteam-delta.spec.ts \
      test/specs/live/multi-user-redteam-epsilon.spec.ts \
      test/specs/live/multi-user-redteam-gamma-delta-attack.spec.ts
    ;;
  mounts)
    run_optional_specs "$suite" test/specs/live/multi-user-redteam-mount-sources.spec.ts
    ;;
  continuation)
    run_optional_specs "$suite" test/specs/live/multi-user-redteam-continuation.spec.ts
    ;;
  smoke)
    node test/scripts/run-live-api-suite.mjs --smoke
    ;;
  *)
    echo "Unknown suite: $suite" >&2
    echo "Suites: api, all, full, smoke, admin-setup, personas, mounts, continuation" >&2
    exit 2
    ;;
esac
