#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/check.sh" >&2
  exit 2
fi

assert_no_common_src_artifacts() {
  local artifact
  artifact="$(find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print -quit)"
  if [[ -n "$artifact" ]]; then
    echo "Generated artifact found under packages/common/src: $artifact" >&2
    exit 1
  fi
}

assert_no_backend_legacy_persistence() {
  if rg -n \
    "(@nestjs/typeorm|from ['\"]typeorm['\"]|[\"']typeorm[\"'][[:space:]]*:|better-sqlite3)" \
    packages/backend/src packages/backend/package.json; then
    echo "Backend still contains a TypeORM or better-sqlite3 dependency/path" >&2
    exit 1
  fi
}

assert_clean_cutover_architecture() {
  local required_path
  for required_path in \
    packages/backend/src/incus \
    packages/backend/src/reconcile/intent.repository.ts \
    packages/backend/src/reconcile/reconcile-worker.service.ts \
    packages/agent/package.json \
    packages/agent/src/policy.ts; do
    [[ -e "$required_path" ]] || {
      echo "clean-cutover architecture path is missing: $required_path" >&2
      exit 1
    }
  done

  has_source_entries() {
    [[ -e "$1" ]] || return 1
    [[ ! -d "$1" ]] && return 0
    rg --files "$1" | rg -q .
  }

  local retired_path
  for retired_path in \
    packages/node-exporter \
    deploy/nyabase-node-exporter.service \
    packages/backend/src/incus/incus-client-identity.service.ts \
    packages/backend/src/agent-tasks \
    packages/backend/src/gateway \
    packages/backend/src/datadirs \
    packages/backend/src/mount-sources \
    packages/backend/src/remote-fs \
    packages/backend/src/quota \
    packages/backend/src/runtime \
    packages/backend/src/server-card-extensions \
    packages/frontend/src/extensions \
    extensions \
    packages/backend/src/database \
    packages/backend/src/storage \
    packages/backend/src/domain; do
    if has_source_entries "$retired_path"; then
      echo "retired control path still exists: $retired_path" >&2
      exit 1
    fi
  done

  rg -q 'Incus|incus' packages/backend/src/incus \
    || {
      echo "backend Incus client sources are missing" >&2
      exit 1
    }
  rg -q 'intent|reconcile' \
    packages/backend/src/reconcile/intent.repository.ts \
    packages/backend/src/reconcile/reconcile-worker.service.ts \
    || {
      echo "backend intent/reconciliation sources are missing" >&2
      exit 1
    }
  if rg -n "from '\.\./(containers|volumes|servers|images|gpu|access|users|groups|storage-pools|shared-backends|ssh|http-proxy)/" \
    packages/backend/src/reconcile; then
    echo "the reconcile engine must not import domain modules" >&2
    exit 1
  fi
  rg -q 'checkIncusHttp' packages/agent/src \
    || {
      echo "agent policy sources are missing" >&2
      exit 1
    }
  # The Backend reaches Incus only through host agents: no outbound HTTPS, mTLS or trust API.
  if rg -n "from 'node:https'|require\('https'\)|/1\.0/certificates" packages/backend/src/incus \
    -g '!*.test.ts' -g '!api-types.ts'; then
    echo "the Backend must not connect to Incus directly" >&2
    exit 1
  fi
}

assert_no_common_src_artifacts
assert_no_backend_legacy_persistence
assert_clean_cutover_architecture
node scripts/check-source-size.mjs
bash scripts/postgres-ops.test.sh
bash scripts/deploy-contract.test.sh
bash scripts/check-rust-proxies.sh
pnpm build
node scripts/check-backend-bootstrap.mjs
assert_no_common_src_artifacts
assert_no_backend_legacy_persistence
pnpm typecheck
pnpm lint
pnpm test:unit
