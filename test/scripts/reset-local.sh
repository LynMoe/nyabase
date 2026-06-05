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

mkdir -p "$(dirname "$DB_PATH")" test/runtime
rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm" "$DB_PATH-journal"
rm -f /tmp/nyabase-test-env/nyabase-test.db /tmp/nyabase-test-env/nyabase-test.db-wal /tmp/nyabase-test-env/nyabase-test.db-shm /tmp/nyabase-test-env/nyabase-test.db-journal
rm -rf test/runtime/agents test/runtime/murt test/runtime/murtc test/runtime/mount test/runtime/dropbear
mkdir -p test/runtime/agents test/runtime/murt test/runtime/mount test/runtime/db test/runtime/logs

bash test/scripts/start-local.sh
