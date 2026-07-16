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

if [[ "$DB_PATH" != /* ]]; then
  DB_PATH="$ROOT/$DB_PATH"
fi

bash test/scripts/stop-local.sh

cleanup_args=()
if [[ "${NYABASE_TEST_CLEAN_REMOTE_APPLY:-}" == "1" ]]; then
  cleanup_args+=(--apply)
  if [[ "${NYABASE_TEST_CLEAN_INCLUDE_CURRENT_LIVE_API:-}" == "1" ]]; then
    cleanup_args+=(--include-current-live-api)
  fi
else
  echo "Remote test data cleanup is running in dry-run mode." >&2
  echo "Set NYABASE_TEST_CLEAN_REMOTE_APPLY=1 to delete matched remote test resources." >&2
fi
node test/scripts/cleanup-test-data-dirs.mjs "${cleanup_args[@]}" || true

mkdir -p "$(dirname "$DB_PATH")" test/runtime
rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm" "$DB_PATH-journal"
rm -f test/runtime/config.yaml test/runtime/config.yaml.tmp-*
rm -rf test/runtime/agents test/runtime/murt test/runtime/mount test/runtime/ssh-proxy-live
mkdir -p test/runtime/agents test/runtime/murt test/runtime/mount test/runtime/db test/runtime/logs

bash test/scripts/start-local.sh
