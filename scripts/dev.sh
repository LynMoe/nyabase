#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

case "${1:-start}" in
  start)
    echo "Starting nyabase frontend/backend via the shared test environment."
    echo "Config: test/config/local.env"
    echo "DB:     test/runtime/db/nyabase-test.db"
    bash test/scripts/start-local.sh
    ;;

  reset)
    echo "Resetting and starting the shared test environment."
    bash test/scripts/reset-local.sh
    ;;

  stop)
    bash test/scripts/stop-local.sh
    ;;

  agents)
    echo "Registering and deploying the fixed test agents from test/config/agents.json."
    node test/scripts/register-agents.mjs
    bash test/scripts/deploy-agents.sh
    ;;

  all)
    echo "Resetting frontend/backend, then registering and deploying fixed test agents."
    bash test/scripts/reset-local.sh
    node test/scripts/register-agents.mjs
    bash test/scripts/deploy-agents.sh
    ;;

  *)
    cat >&2 <<'EOF'
Usage: bash scripts/dev.sh [start|reset|stop|agents|all]

Commands:
  start   Start frontend/backend using test/config/local.env without deleting DB.
  reset   Reset test DB/runtime state, then start frontend/backend.
  stop    Stop local frontend/backend processes.
  agents  Register and deploy the fixed agents from test/config/agents.json.
  all     Reset/start frontend/backend, then register/deploy agents.
EOF
    exit 2
    ;;
esac
