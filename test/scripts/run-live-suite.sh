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
SPEC_DIR="test/specs/live"

suite="${1:-smoke}"

run_vitest() {
  pnpm exec vitest run "$@"
}

load_murt_env() {
  if [[ ! -f test/runtime/murt/current.env ]]; then
    echo "Missing test/runtime/murt/current.env. Run: bash test/scripts/run-live-suite.sh admin-setup" >&2
    exit 1
  fi
  set -a
  source test/runtime/murt/current.env
  set +a
}

case "$suite" in
  smoke)
    status="$(curl -sS -o test/runtime/logs/smoke-auth.out -w '%{http_code}' "${NYABASE_BACKEND_URL}/api/auth/me")"
    if [[ "$status" != "401" && "$status" != "200" ]]; then
      echo "Unexpected /api/auth/me status: $status" >&2
      exit 1
    fi
    curl -sS "${NYABASE_FRONTEND_URL}/" > test/runtime/logs/smoke-frontend.html
    curl -sS http://127.0.0.1:8428/health
    node - <<'NODE'
const fs = require('node:fs');
const env = Object.fromEntries(fs.readFileSync(process.env.NYABASE_TEST_ENV_FILE || 'test/config/local.env', 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1)];
}));
fetch(`${env.NYABASE_BACKEND_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_INIT_PASSWORD }),
}).then(async (res) => {
  if (!res.ok) throw new Error(`admin login failed: ${res.status}`);
  const data = await res.json();
  if (!data.accessToken) throw new Error('admin login returned no token');
  console.log('admin login OK');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
    ;;
  admin-setup)
    export NYABASE_MURT_RUN_ID="${NYABASE_MURT_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')-$(openssl rand -hex 3)}"
    export NYABASE_MURT_COORD_DIR="$ROOT/test/runtime/murt/${NYABASE_MURT_RUN_ID#runtime-}"
    run_vitest "$SPEC_DIR/multi-user-redteam-admin-setup.spec.ts" --reporter=verbose
    state="$NYABASE_MURT_COORD_DIR/state.json"
    if [[ -z "$state" || ! -f "$state" ]]; then
      echo "Cannot find generated murt state.json" >&2
      exit 1
    fi
    coord="$(dirname "$state")"
    mkdir -p test/runtime/murt
    cat > test/runtime/murt/current.env <<EOF
NYABASE_MURT_COORD_DIR=$coord
NYABASE_MURT_STATE=$state
NYABASE_MURT_STATE_PATH=$state
NYABASE_ALPHA_ENV=$coord/alpha.env
NYABASE_BETA_ENV=$coord/beta.env
NYABASE_MURT_GAMMA_ENV=$coord/gamma.env
NYABASE_MURT_DELTA_ENV=$coord/delta.env
NYABASE_MURT_EPSILON_ENV=$coord/epsilon.env
NYABASE_MURT_ALPHA_ENV=$coord/alpha.env
NYABASE_MURT_BETA_ENV=$coord/beta.env
NYABASE_MURT_EPSILON_REPORT_MD=$coord/epsilon-report.md
NYABASE_MURT_EPSILON_REPORT_JSON=$coord/epsilon-report.json
EOF
    echo "Wrote test/runtime/murt/current.env"
    ;;
  continuation)
    export NYABASE_MURTC_RUN_ID="${NYABASE_MURTC_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')-$(openssl rand -hex 3)}"
    export NYABASE_MURTC_COORD_DIR="$ROOT/test/runtime/murtc/${NYABASE_MURTC_RUN_ID#runtime-}"
    run_vitest "$SPEC_DIR/multi-user-redteam-continuation.spec.ts" --reporter=verbose
    ;;
  personas)
    load_murt_env
    run_vitest \
      "$SPEC_DIR/multi-user-redteam-alpha.spec.ts" \
      "$SPEC_DIR/multi-user-redteam-beta.spec.ts" \
      "$SPEC_DIR/multi-user-redteam-gamma.spec.ts" \
      "$SPEC_DIR/multi-user-redteam-delta.spec.ts" \
      "$SPEC_DIR/multi-user-redteam-epsilon.spec.ts" \
      "$SPEC_DIR/multi-user-redteam-gamma-delta-attack.spec.ts" \
      --reporter=verbose
    ;;
  mounts)
    if [[ ! -f test/runtime/mount/current.env ]]; then
      echo "Missing test/runtime/mount/current.env. Run: node test/scripts/create-mount-fixture.mjs" >&2
      exit 1
    fi
    set -a
    source test/runtime/mount/current.env
    set +a
    run_vitest "$SPEC_DIR/multi-user-redteam-mount-sources.spec.ts" --reporter=verbose
    ;;
  dropbear)
    export NYABASE_DROPBEAR_LIVE_RUN_ID="${NYABASE_DROPBEAR_LIVE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')-$(openssl rand -hex 3)}"
    export NYABASE_DROPBEAR_LIVE_TMP="$ROOT/test/runtime/dropbear/${NYABASE_DROPBEAR_LIVE_RUN_ID#runtime-}"
    run_vitest "$SPEC_DIR/dropbear-live-runtime.spec.ts" --reporter=verbose
    ;;
  *)
    echo "Unknown suite: $suite" >&2
    echo "Suites: smoke, admin-setup, continuation, personas, mounts, dropbear" >&2
    exit 2
    ;;
esac
