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

case "$suite" in
  api|all|full|admin-setup|personas|mounts|dropbear|continuation)
    node test/scripts/run-live-api-suite.mjs
    ;;
  smoke)
    node test/scripts/run-live-api-suite.mjs --smoke
    ;;
  *)
    echo "Unknown suite: $suite" >&2
    echo "Suites: api, all, full, smoke, admin-setup, personas, mounts, dropbear, continuation" >&2
    exit 2
    ;;
esac
